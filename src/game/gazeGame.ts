/**
 * 「火箭追星星」训练游戏。
 *
 * 玩法：视线带着火箭飞。追上星星得分，但**燃料会持续消耗**，
 * 燃料不足时必须飞回屏幕正中的加油站补给——补给的那一两秒就是一次注视锚定。
 *
 * 为什么把锚定做成加油站：
 *   模型没有头位项，60 秒里坐姿缓慢变化会让注视估计漂 1–2°，
 *   表现为"越到后面越偏"。定期强行插入"请看中心"会打断游戏，
 *   而"燃料不够了要加油"是玩家自己愿意做的动作，锚定顺手就完成了。
 *   开局燃料也很少，所以第一次加油就是开局校准。
 *
 * 分视：星星一半只给左眼看、一半只给右眼看，优势眼那层压暗。
 * 火箭和加油站是白色（两眼都可见）——否则孩子不知道自己在哪、该往哪飞。
 *
 * 操控手感的三处改造（对应 docs/GAME-CONTROL-AUDIT.md 的建议实施项）：
 *   P1 鲁棒零位   → 本文件 refuel 段 + assist.robustZero（中位数/截尾/MAD 门控，不达标不更新）
 *   P2 滤波时序   → gazeFilter.ts（只在新样本上修正，one-euro + 死区迟滞 + 6° 扫视吸附）
 *   P3 难度与磁吸 → assist.captureRadiusDeg / magnetPull（4° 地板、实测误差、趋势门控弱磁吸）
 */
import type { EyeKey, Pt, ScreenGeom } from "../types";
import { quantile } from "../gaze/metrics";
import { AnaglyphPresenter, type GlassesKind, type Presenter, type SceneItem } from "./presenter";
import {
  ANCHOR_MAD_MAX_DEG,
  ANCHOR_RELAX_AFTER_MISSES,
  ANCHOR_RELAX_FACTOR,
  MAGNET_RELEASE_DEG,
  MAGNET_STEP_HARD_CAP_DEG,
  aimedDistanceDeg,
  assistCaptureRadiusDeg,
  captureRadiusDeg,
  dwellSatisfied,
  lockLevel,
  magnetPull,
  maxCaptureRadiusDeg,
  mmToDeg,
  robustZero,
  slewToward,
  stepCaptureDwell,
  towardSpeedMmS,
} from "./assist";
import { STAR_SPAWN_MARGIN_DEG, pickStarSpawn } from "./starSpawn";
import {
  D_CUTOFF_HZ,
  DEAD_ENTER_DEG,
  DEAD_EXIT_DEG,
  EO_BETA_PER_DEG_S,
  GazeFilter,
  MIN_CUTOFF_HZ,
  SNAP_DEG,
} from "./gazeFilter";

export interface GameOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  promptEl: HTMLElement;
  progressEl: HTMLElement;
  geom: ScreenGeom;
  durationMs: number;
  dominantEye: EyeKey;
  contrastRatio: number;
  glasses: GlassesKind;
  /** 当前注视点。双眼分别给出，游戏内部做平均与滤波 */
  getGaze: () => { left: Pt | null; right: Pt | null; valid: boolean } | null;
}

export interface GameResult {
  score: number;
  trials: number;
  hits: number;
  expired: number;
  meanCaptureMs: number;
  medianErrorDeg: number;
  p90ErrorDeg: number;
  meanHitErrorDeg: number;
  /** 最近一次加油时测到的注视偏置（度）。大 = 校准或坐姿有问题。 */
  anchorLeftDeg: number;
  anchorRightDeg: number;
  /** 加油次数 */
  refuels: number;
  /**
   * 护栏指标：命中那一帧磁吸是否在生效。这个值越高，说明命中越依赖磁吸——
   * 正常应该只占少数（磁吸只在"已经贴得很近且在朝星星动"时生效）。
   */
  assistHits: number;
  /**
   * 护栏指标：命中前 300 ms 内视线位移 <1° 的命中数（审计 §5.1 第 2 条）。
   * 真正的训练里这个比例应该 <5%；高得离谱说明判定被"不动也能中"钻了空子。
   */
  stillHits: number;
  /** 本次是否用过"连续不达标后的降级门控"来提交零位（t4-F6 的兜底标记）。 */
  anchorRelaxed: boolean;
  /**
   * 撒点降级次数：几何上无法同时避开火箭与瞄准点时，退化为"只避开瞄准点"的次数。
   * 正常应为 0；非 0 说明出现过 |火箭−瞄准| ≥6° 的极端跟随误差（t6-R6）。
   */
  spawnRelaxed: number;
  dominantEye: EyeKey;
  contrastRatio: number;
  durationMs: number;
  validRatio: number;
  presenter: string;
}

interface Star {
  nm: Pt;
  bornAt: number;
  eye: "left" | "right";
  collected: boolean;
  collectedAt: number;
  /** 视觉参数（纯观感，不参与任何判定） */
  size: number;
  rot: number;
  rotSpd: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  rgb: string;
}

/** 捕获时的冲击波圆环 */
interface Shockwave {
  x: number;
  y: number;
  life: number;
  max: number;
  rgb: string;
}

/** 捕获时的 "+1 / 连击" 飘字 */
interface Popup {
  x: number;
  y: number;
  life: number;
  max: number;
  text: string;
}

/** 背景星空（白色、两眼可见，不参与分视） */
interface BgStar {
  x: number;
  y: number;
  r: number;
  ph: number;
  sp: number;
  drift: number;
}

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));

const DRAIN_MS = 18000; // 满箱能飞约 18 秒
const REFUEL_MS = 3200; // 每次加满需要的时间（= 校准采样窗口）
const REFUEL_MS_FIRST = 3600; // 首次再长一点
const REFUEL_MAX_MS = 9000; // 样本不够时最多延长到这里，避免卡死
const MIN_SAMPLES = 30; // 每只眼至少要这么多有效样本才结算锚定
const NEED_REFUEL = 0.22; // 低于这个燃料值进入"待加油"状态
const TRIGGER_DEG = 12; // 视线进入这个范围才切到"校准中"（宽一点，容得下模型偏置）
const SAMPLE_DEG = 8; // 之后各次只有在这个范围内的样本才计入锚定

/**
 * 首次锚定的"要不要开始采"窗口（度）。
 * 注意它**只**决定"这次要不要采"，不再决定"哪些样本算中心"——
 * 后者交给 assist.ts 的 robustZero（中位数 + 1.2° 截尾 + MAD 门控），
 * 所以窗口宽一点不会把顶部提示语/HUD 的样本带进零位（P1：几何窗口与零位估计解耦）。
 * 保留 15° 是为了不让模型几度的绝对偏置在首次加油时"采不到样本 → 永远修不掉"。
 */
const FIRST_SAMPLE_DEG = 15;

/** 星星寿命固定 6 s。P3：取消 6000−1500p 的递减——容差变小 + 时间变短是双重收紧。 */
const STAR_LIFE_MS = 6000;
/** 火箭跟随瞄准点的单级平滑（每 16.7 ms）。旧版在 α-β 之后又串了一级 0.92，两级叠加 250–400 ms。 */
const ROCKET_SMOOTH = 0.72;
/** 加油停靠时的收敛（更快），让"飞回加油站"这个动作干脆。 */
const ROCKET_SMOOTH_REFUEL = 0.55;

/**
 * 滤波参数（P2）全部在 gazeFilter.ts 里定义与实现——那里不碰 DOM，
 * 可以用 Node 按 30 Hz/60 Hz 的节拍回放帧序列，直接量抖动与滞后。
 * 旧实现每帧都修正，但相机只有 ~30 Hz 而 rAF 是 60–120 Hz，
 * 同一样本被重复积分 2–4 次 → 等效增益 0.86、滞后 250–400 ms。
 * 现在只在新样本上修正，dt 用真实样本间隔（≈33 ms）。
 */

/** 护栏：命中前 300 ms 内视线位移 <1° 记为 suspicious（审计 §5.1 第 2 条）。 */
const STILL_HIT_WINDOW_MS = 300;
const STILL_HIT_DEG = 1;

/**
 * 护栏：判定"未移动命中"——命中前 300 ms 内视线位移是否 <1°。
 * 需要游戏维护一小段视线历史（gazeHist）。
 */
function isStillHit(
  hist: Array<{ t: number; x: number; y: number }>,
  now: number,
  cur: Pt,
  distanceMm: number,
): boolean {
  let ref: { x: number; y: number } | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (now - hist[i].t >= STILL_HIT_WINDOW_MS) {
      ref = hist[i];
      break;
    }
  }
  if (!ref) return false;
  return mmToDeg(Math.hypot(cur.x - ref.x, cur.y - ref.y), distanceMm) < STILL_HIT_DEG;
}

export class GazeGame {
  private presenter: Presenter = new AnaglyphPresenter();
  private cancelled = false;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.cancelled = true;
  };

  constructor(private o: GameOptions) {}

  async run(): Promise<GameResult | null> {
    const { canvas, hud, geom } = this.o;
    this.presenter.configure(
      this.o.dominantEye === "imageRight" ? "right" : "left",
      this.o.contrastRatio,
      this.o.glasses,
    );

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    let w = window.innerWidth;
    let h = window.innerHeight;
    const sizeCanvas = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };

    canvas.classList.add("on");
    hud.classList.add("on");
    window.addEventListener("keydown", this.onKey);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 280));
    sizeCanvas();

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.exit();
      return null;
    }

    for (let n = 3; n > 0 && !this.cancelled; n--) {
      this.o.promptEl.textContent = `准备 ${n}`;
      const t0 = performance.now();
      while (performance.now() - t0 < 540 && !this.cancelled) {
        this.drawCountdown(ctx, w, h, dpr, String(n), performance.now() - t0);
        await raf();
      }
    }
    this.o.promptEl.textContent = "燃料不够了，先飞到中间的加油站";
    sizeCanvas();

    const degMm = (deg: number) => geom.distanceMm * Math.tan((deg * Math.PI) / 180);
    const mmPerDeg = degMm(1); // 每度的毫米数：把 one-euro 的 β 从 1/(°/s) 换成 1/(mm/s)
    const filter = new GazeFilter({
      snapMm: degMm(SNAP_DEG),
      deadEnterMm: degMm(DEAD_ENTER_DEG),
      deadExitMm: degMm(DEAD_EXIT_DEG),
      minCutoffHz: MIN_CUTOFF_HZ,
      betaPerMm: EO_BETA_PER_DEG_S / mmPerDeg,
      dCutoffHz: D_CUTOFF_HZ,
    });
    // ---- 状态
    let fuel = 0.12; // 开局燃料很少：第一次加油就是开局校准
    let launched = false;
    let refuels = 0;
    let offL: Pt = { x: 0, y: 0 };
    let offR: Pt = { x: 0, y: 0 };
    let anchorLeftDeg = 0;
    let anchorRightDeg = 0;
    // 加油期间的锚定样本：存**原始** predMm（mm），结算时交给 assist.robustZero。
    // 存全量而不是累加和，才能做中位数/截尾/MAD——这是 P1 的核心。
    let sampleL: Pt[] = [];
    let sampleR: Pt[] = [];
    // 新样本判定：app.ts 的 currentGaze() 在两次相机帧之间返回**同一个** predMm 对象引用，
    // 引用没变 = 不是新样本。这样不需要改 app.ts 就能拿到真实的 ~30 Hz 样本节拍（P2）。
    let prevGaze: { left: Pt | null; right: Pt | null; valid: boolean } | null = null;
    // ---- 产品侧辅助层状态（数值逻辑全在 assist.ts）
    let magOffset: Pt = { x: 0, y: 0 }; // 当前施加在瞄准点上的磁吸偏移（mm），不是增量
    let magnetStrength = 0; // 磁吸强度 0..1，只用于锁定反馈的绘制
    // t6-R1：捕获判定基于瞄准点（视线），并且要求"在圈内连续停留 ≥60 ms"才命中。
    // captureDwellSince = 视线进入捕获圈的时刻；出圈/换星/无效帧清零。
    let captureDwellSince: number | null = null;
    // t6-R6：撒点降级（几何无解时只避开瞄准点）的次数，写进结果便于实机排查。
    let spawnRelaxed = 0;
    // 本帧实际用于判定的捕获半径（度）：锁定反馈与判定同源，避免"环亮了却判不中"（t4-F12）。
    let captureDegNow = captureRadiusDeg(0);
    // 护栏：最近约 600 ms 的视线历史 + 两个"磁吸是否越界"的计数
    const gazeHist: Array<{ t: number; x: number; y: number }> = [];
    let assistHits = 0;
    let stillHits = 0;
    // B3/F4：本次会话是否出现过**整帧 valid** 的视线样本。没出现过就不允许捕获，
    // 避免"没有眼睛、只有残留位置"也能得分。
    let hasEverValid = false;
    // F6 兜底：连续几次加油都没达到 MAD 门控 → 降级到宽松阈值并打标记。
    let anchorMisses = 0;
    let anchorRelaxed = false;
    let lastPrompt = "";
    // 三态：idle 巡航 / prompt 待加油 / refuel 校准中。进入 refuel 后锁存到加满。
    let phase: "idle" | "prompt" | "refuel" = "prompt";
    let promptSince = 0;
    let refuelSince = 0;

    const rocket: Pt = { x: 0, y: 0 };
    const trail: Pt[] = [];
    const particles: Particle[] = [];
    const shockwaves: Shockwave[] = [];
    const popups: Popup[] = [];
    // 背景星空：一次生成，缓慢下落 + 闪烁。白色 = 两眼都看得见，不破坏分视。
    const starfield: BgStar[] = Array.from({ length: 110 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + Math.random() * 1.5,
      ph: Math.random() * Math.PI * 2,
      sp: 0.5 + Math.random() * 1.5,
      drift: 1.5 + Math.random() * 5,
    }));
    // 连击（连续命中、没有被星星过期打断）。纯展示，不影响判定与计分。
    let combo = 0;
    let scorePop = 0; // 得分瞬间 HUD 的放大动画 1→0
    let prevRocket: Pt = { x: 0, y: 0 };
    let rocketSpeed = 0; // mm/s，驱动尾焰长度
    let smoothAngle = -Math.PI / 2; // 机头朝向（平滑后的），避免视线抖动时火箭抽搐

    const start = performance.now();
    promptSince = start;
    let last = start;
    // 开局这颗只是占位：第一次加油结算后会重新撒点（并受距离约束）。
    const firstSpawn = this.spawn(
      w,
      h,
      null,
      [{ x: 0, y: 0 }],
      degMm(maxCaptureRadiusDeg(0, []) + STAR_SPAWN_MARGIN_DEG),
    );
    let star = firstSpawn.star;
    if (firstSpawn.relaxed) spawnRelaxed++;
    const stars: Star[] = [star];
    let score = 0;
    let hits = 0;
    let expired = 0;
    let trials = 0;
    let validFrames = 0;
    let totalFrames = 0;
    const captureMs: number[] = [];
    const errors: number[] = [];
    const hitErrors: number[] = [];
    let rocketAngle = -Math.PI / 2;

    try {
      while (!this.cancelled) {
        const now = performance.now();
        const dt = Math.min(64, now - last);
        last = now;
        const elapsed = now - start;
        if (elapsed >= this.o.durationMs) break;

        // ---- 注视（先算，因为要不要加油是由"视线在哪"决定的，不是由火箭在哪）
        const gaze = this.o.getGaze();
        totalFrames++;
        // 新样本 = predMm 的对象引用变了（= 相机帧到了）。P2 的关键：
        // 旧版每帧都调 filter.update，同一个样本被重复积分 2–4 次。
        const isNewSample =
          !!gaze && (!prevGaze || gaze.left !== prevGaze.left || gaze.right !== prevGaze.right);
        if (gaze) prevGaze = gaze;
        let mx = 0;
        let my = 0;
        let hasGaze = false;
        if (gaze) {
          if (gaze.valid) validFrames++;
          const cands: Pt[] = [];
          if (gaze.left) cands.push({ x: gaze.left.x - offL.x, y: gaze.left.y - offL.y });
          if (gaze.right) cands.push({ x: gaze.right.x - offR.x, y: gaze.right.y - offR.y });
          if (cands.length) {
            // 两眼平均。逐帧挑"更近的那只"会让目标在两只眼的预测间来回跳。
            mx = cands.reduce((a, c) => a + c.x, 0) / cands.length;
            my = cands.reduce((a, c) => a + c.y, 0) / cands.length;
            hasGaze = true;
            if (gaze.valid) {
              hasEverValid = true;
              // 护栏用历史：只留 600 ms，够覆盖"命中前 300 ms"这个窗口。
              // 只记 valid 帧——眨眼/偏头的假位置不该被当成"视线没动"的证据。
              gazeHist.push({ t: now, x: mx, y: my });
              while (gazeHist.length && now - gazeHist[0].t > 600) gazeHist.shift();
            }
          }
        }
        // F4：整帧 quality.ok 才允许驱动滤波、磁吸与捕获。app.ts 里眨眼已经是硬失败
        // （quality.ok=false），所以这一条同时挡住"眨眼瞬间火箭被假位置弹开"。
        const gazeOk = hasGaze && !!gaze && gaze.valid;

        // ---- 燃料与加油：显式三态状态机
        //
        // 之前用 "视线距中心 < 7°" 每帧现算 refuelling，初始偏置正好在阈值附近，
        // 噪声一抖就翻——红绿交替闪、火箭在"加油站"和"视线"之间来回跳、
        // 星星一闪一闪、燃料永远涨不满所以校准从没生效。
        // 现在：进入 refuel 后锁存，只有加满才回 idle。
        const stationMm = { x: this.mmX(0.5, w), y: this.mmY(0.5, h) };
        const gazeToStation = hasGaze ? Math.hypot(mx - stationMm.x, my - stationMm.y) : Infinity;
        const nearStation = gazeToStation <= degMm(TRIGGER_DEG);
        // 这一对窗口只决定"要不要采"，不决定"哪些样本算中心"——后者由鲁棒估计器负责。
        // 首次放宽到 15° 容得下模型几度的绝对偏置；之后收紧到 8° 防止偏头时采到别的方向。
        const sampleDeg = launched ? SAMPLE_DEG : FIRST_SAMPLE_DEG;
        const goodSample = gazeToStation <= degMm(sampleDeg);
        const refuelMs = launched ? REFUEL_MS : REFUEL_MS_FIRST;

        if (phase === "idle" && (!launched || fuel < NEED_REFUEL)) {
          phase = "prompt";
          promptSince = now;
        }
        // 8 秒还没对上就强行进入校准：
        // 如果模型偏置大到超出触发窗口，孩子盯着中心也切不过去，
        // 会永久卡在待加油（星星不出现）。宁可采一次可能不准的样本，也不能死锁。
        if (phase === "prompt" && (nearStation || now - promptSince > 8000)) {
          phase = "refuel";
          refuelSince = now;
        }

        if (phase === "refuel") {
          fuel = Math.min(1, fuel + dt / refuelMs);
          // 只收**新**样本（≈30 Hz）、整帧 valid、且落在采样窗内的点。
          // 旧版既不查 valid，又每个 rAF 帧都记一次（同一个样本被重复计入 2–4 次）。
          if (isNewSample && gaze && gaze.valid && goodSample) {
            if (gaze.left) sampleL.push({ x: gaze.left.x, y: gaze.left.y });
            if (gaze.right) sampleR.push({ x: gaze.right.x, y: gaze.right.y });
          }
          // "加满"不等于"校准完成"：样本不够就继续等，超时才放弃本次更新。
          const enough = sampleL.length >= MIN_SAMPLES && sampleR.length >= MIN_SAMPLES;
          const timedOut = now - refuelSince > REFUEL_MAX_MS;
          if (fuel >= 1 && (enough || timedOut)) {
            // 两遍法鲁棒零位：中位数 → 自适应截尾 → MAD 门控 → 截尾均值。
            // 只有样本数够、且 MAD 达标才提交；否则**保留旧零位**——宁可不更新。
            // F6 兜底：连续 ANCHOR_RELAX_AFTER_MISSES 次不达标后降级到宽松门控并打标记，
            // 否则在 σ≈1.5° 的真实抖动下零位会永远不更新（t4 复现的提交率 0%）。
            const relax = anchorMisses >= ANCHOR_RELAX_AFTER_MISSES;
            const fitOpts = relax
              ? { madMaxDeg: ANCHOR_MAD_MAX_DEG * ANCHOR_RELAX_FACTOR, relaxed: true }
              : {};
            const fitL = robustZero(sampleL, geom.distanceMm, fitOpts);
            const fitR = robustZero(sampleR, geom.distanceMm, fitOpts);
            if (fitL.ok) {
              offL = { x: fitL.x, y: fitL.y };
              anchorLeftDeg = this.magDeg(offL.x, offL.y);
            }
            if (fitR.ok) {
              offR = { x: fitR.x, y: fitR.y };
              anchorRightDeg = this.magDeg(offR.x, offR.y);
            }
            if (fitL.ok || fitR.ok) {
              anchorMisses = 0;
              if (relax) anchorRelaxed = true;
            } else {
              anchorMisses++;
            }
            sampleL = [];
            sampleR = [];
            refuels++;
            // B4/F5：结算后立刻用**加油站**给滤波器播种，而不是等下一帧拿旧零位的新样本。
            // 否则零位刚变、滤波状态还是旧的，火箭会朝旧位置跳一下再回落（t4 实测约 265 ms）。
            filter.reset();
            filter.updateNew(stationMm.x, stationMm.y, now);
            phase = "idle";
            if (!launched) {
              launched = true;
              // 首次撒点：避开火箭/加油站（t4-F1 的场景）。距离约束见 spawn() 注释。
              const firstPick = this.spawn(
                w,
                h,
                null,
                [rocket, stationMm],
                degMm(maxCaptureRadiusDeg(score, hitErrors) + STAR_SPAWN_MARGIN_DEG),
              );
              star = firstPick.star;
              if (firstPick.relaxed) spawnRelaxed++;
              stars.length = 0;
              stars.push(star);
            }
          }
        } else if (phase === "idle") {
          fuel = Math.max(0, fuel - dt / DRAIN_MS);
        }
        // phase === "prompt" 时燃料冻结：找加油站的时间不会把油耗光

        // 星星的"寿命"只在 idle 走：待加油/校准期间星星整个藏起来，
        // 计时也跟着暂停。否则回到 idle 的一瞬间它会因为超时直接过期，
        // 白白记一次 expired（旧版甚至在这段时间里就把它收掉了，FM-6）。
        if (phase !== "idle") star.bornAt += dt;

        const refuelling = phase === "refuel";
        const needRefuel = phase !== "idle";

        // 提示语：校准期间**不用**屏幕顶部那条 DOM 文字（它在中心上方约 11°，
        // 正好落在采样窗里，会被当成"在看中心"——FM-1 的元凶之一）。
        // 改成在绿圈下方约 2° 处用画布文字提示：看提示语就等于看中心。
        // 待加油阶段还没有开始采样，放顶部无妨（那时它是指令，必须显眼）。
        let prompt = "";
        if (needRefuel && !refuelling) {
          prompt = "燃料不足 · 看中间的红色加油站";
        }
        if (prompt !== lastPrompt) {
          this.o.promptEl.textContent = prompt;
          lastPrompt = prompt;
        }

        // ---- 目标点：校准中火箭停靠在加油站，其余时候跟随滤波后的视线
        let aim: Pt | null = null;
        if (refuelling) {
          aim = stationMm;
        } else if (gazeOk) {
          // 只在巡航阶段统计"注视误差"：待加油/校准期间星星是隐藏的，
          // 那段样本会把"看加油站/看提示语"的距离算成瞄准误差，污染结果卡（t4-F13）。
          if (launched && !needRefuel && now - star.bornAt > 200) {
            const d = Math.hypot(mx - this.mmX(star.nm.x, w), my - this.mmY(star.nm.y, h));
            errors.push((Math.atan2(d, geom.distanceMm) * 180) / Math.PI);
          }
          // P2：只有新样本才修正；同一相机帧内的重复渲染帧只做外推。
          // 无效帧（眨眼/偏头）既不修正也不外推：火箭原地不动（F4）。
          if (isNewSample || !filter.isReady()) filter.updateNew(mx, my, now);
          aim = filter.display(now);
        }

        // ---- 产品侧辅助层：磁吸（距离 + 朝星星运动双条件，幅度有界）
        // 偏移只加在**瞄准点**上：GazeFilter、火箭收敛、加油状态机一概不动。
        // t6-R1/R3：磁吸的门控点也是 aim（被判定点），不是可视火箭——
        // 否则火箭的飞行路径会偷偷把"判定"带进捕获圈。
        // 无效帧（gazeOk=false）不参与磁吸，也不推进偏移。
        // 磁吸前的瞄准点单独留一份：命中误差统计要用它（不让磁吸美化实测精度）。
        const aimBeforeMagnet: Pt | null = aim ? { x: aim.x, y: aim.y } : null;
        magnetStrength = 0;
        if (aim && launched && gazeOk && !needRefuel) {
          const starMm = { x: this.mmX(star.nm.x, w), y: this.mmY(star.nm.y, h) };
          const m = magnetPull(aim, starMm, filter.velocityMmS(), geom.distanceMm, {
            currentOffsetMm: magOffset,
            dtMs: dt,
          });
          magOffset = m.offsetMm;
          magnetStrength = m.active ? m.strength : 0;
          aim = { x: aim.x + magOffset.x, y: aim.y + magOffset.y };
        } else {
          // 离开巡航（加油/待加油/丢帧）时把偏移平滑收回 0，
          // 避免加完油回来时火箭带着上一段的偏移"跳一下"。
          // 回退同样受 0.2°/帧 的单帧硬顶约束（F8）；速率常量与 assist.ts 同源（t6-R7）。
          magOffset = slewToward(
            magOffset,
            { x: 0, y: 0 },
            Math.min(
              degMm(MAGNET_RELEASE_DEG) * Math.min(2, dt / 16.7),
              degMm(MAGNET_STEP_HARD_CAP_DEG),
            ),
          );
        }

        if (aim) {
          // 单级、极轻的跟随。旧版是 α-β 之后**再**串一级 0.92，两级叠加 250–400 ms。
          // 0.72/16.7 ms ≈ 51 ms 时间常数：只负责把 30 Hz 样本之间的台阶抹平。
          const k = 1 - Math.pow(refuelling ? ROCKET_SMOOTH_REFUEL : ROCKET_SMOOTH, dt / 16.7);
          // 没油了飞得慢——这是自然的后果，不是硬性失败
          const limp = fuel <= 0.001 ? 0.35 : 1;
          const dx = aim.x - rocket.x;
          const dy = aim.y - rocket.y;
          if (Math.hypot(dx, dy) > 0.4) {
            rocket.x += dx * k * limp;
            rocket.y += dy * k * limp;
            rocketAngle = Math.atan2(dy, dx);
          }
        }
        // 尾焰节流 + 机头朝向平滑（纯视觉，不碰任何判定）
        {
          const rdx = rocket.x - prevRocket.x;
          const rdy = rocket.y - prevRocket.y;
          rocketSpeed = Math.hypot(rdx, rdy) / Math.max(dt / 1000, 1e-3);
          prevRocket = { x: rocket.x, y: rocket.y };
          let da = rocketAngle - smoothAngle;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          smoothAngle += da * Math.min(1, dt / 90);
          scorePop = Math.max(0, scorePop - dt / 320);
        }
        trail.push({ x: rocket.x, y: rocket.y });
        if (trail.length > 26) trail.shift();

        // 加油/待加油期间不判定：停留计时清零，回来时重新计时，
        // 避免"加油前视线已经在圈里"导致加完油瞬间被判定命中。
        if (needRefuel) captureDwellSince = null;

        // ---- 星星：捕获 / 过期
        // 守卫从 !refuelling 改成 !needRefuel，与绘制条件对齐：
        // 旧版在"待加油"阶段星星不可见却仍可被收集/过期，分数会莫名上涨（FM-6）。
        if (launched && !needRefuel) {
          const sx = this.mmX(star.nm.x, w);
          const sy = this.mmY(star.nm.y, h);
          // 有界宽容：捕获半径 = min(分数上限, 1.6×最近命中中位误差) × 趋势放大。
          // 分数只能收紧、实测误差也只能收紧，4.0° 硬地板 + 6.0° 硬顶，
          // 趋势放大 ≤1.25× 且只在视线确实朝星星飞时才给（停住不动不放大）。
          // 旧曲线 5.5−2.3p 在终局是 3.2°，落在噪声带正中间 → "该中不中"。
          // 趋势门控的方向也以瞄准点为起点（与判定同源）：视线速度朝"瞄准点 → 星星"的
          // 投影 ≥2°/s 才把容差放大；停住不动时投影 ≈0，不放宽（审计 §5.1 护栏 1）。
          const towardDegPerS = aim
            ? mmToDeg(
                towardSpeedMmS(filter.velocityMmS(), { x: sx - aim.x, y: sy - aim.y }),
                geom.distanceMm,
              )
            : 0;
          const captureDeg = assistCaptureRadiusDeg(score, towardDegPerS, hitErrors);
          captureDegNow = captureDeg;
          // 寿命固定 6 s（P3：取消 6000−1500p，不再"容差变小 + 时间变短"双重收紧）。
          const lifeMs = STAR_LIFE_MS;

          // t6-R1/R3（blocker）：判定改用**瞄准点 aim**（滤波后的视线 + 有界磁吸），
          // 不再用火箭。火箭只是视觉载体：它从旧星位置飞向新瞄准点的路径会扫过别的星星，
          // 但"路过"不等于"看"——用火箭判定时，玩家视线全程在别处也能被判定命中。
          // 只有 aim 与星星的距离才算数；aim 为 null（无有效视线）时距离 = Infinity。
          // 另外要求视线在圈内**连续停留 ≥60 ms**（CAPTURE_DWELL_MS）：快速扫过不算命中。
          // 这两条都在 assist.ts 的纯函数里，离线回放用的是同一套实现。
          //
          // 关于 hasEverValid：aim 为 null 已经蕴含"本帧无有效视线"，而 gazeOk 又蕴含
          // hasEverValid（同一帧置位）。这里仍然把两个条件都写出来，是 B3 要求的显式表达，
          // 也是防止将来 gazeOk 语义被改动时悄悄放宽捕获的防御性检查。
          const aimedDeg = aimedDistanceDeg(aim, { x: sx, y: sy }, geom.distanceMm);
          const inRange = aim !== null && gazeOk && hasEverValid && aimedDeg <= captureDeg;
          captureDwellSince = stepCaptureDwell(captureDwellSince, inRange, now);

          if (!star.collected && inRange && dwellSatisfied(captureDwellSince, now)) {
            star.collected = true;
            star.collectedAt = now;
            score++;
            hits++;
            trials++;
            captureMs.push(now - star.bornAt);
            // 命中误差记的是**磁吸前**的视线误差：磁吸最多补 0.6°，
            // 把它算进"实测精度"会让容差曲线自我美化（t4-F7 的顾虑）。
            const errDeg = aimedDistanceDeg(aimBeforeMagnet, { x: sx, y: sy }, geom.distanceMm);
            hitErrors.push(Number.isFinite(errDeg) ? errDeg : aimedDeg);
            captureDwellSince = null;
            // 护栏：磁吸参与率 + 未移动命中率。两个都只统计、不干预，
            // 用来证明磁吸没有把"没看星星"变成"自动命中"。
            assistHits += magnetStrength > 0.01 ? 1 : 0;
            if (isStillHit(gazeHist, now, { x: mx, y: my }, geom.distanceMm)) stillHits++;
            combo++;
            scorePop = 1;
            {
              // 屏幕坐标（含屏幕中心偏移）：旧版漏了中心偏移，爆点会画到左上角
              const px = w / 2 + sx / geom.mmPerPx;
              const py = h / 2 + sy / geom.mmPerPx;
              const ch =
                star.eye === "left"
                  ? this.presenter.channelColor("left")
                  : this.presenter.channelColor("right");
              for (let i = 0; i < 22; i++) {
                const a = Math.random() * Math.PI * 2;
                const sp = 0.6 + Math.random() * 2.6;
                particles.push({
                  x: px,
                  y: py,
                  vx: Math.cos(a) * sp,
                  vy: Math.sin(a) * sp,
                  life: 1,
                  max: 520 + Math.random() * 380,
                  rgb: ch,
                });
              }
              // 几粒白色火花：无论分视颜色，都要有"亮"的观感
              for (let i = 0; i < 6; i++) {
                const a = Math.random() * Math.PI * 2;
                const sp = 1.2 + Math.random() * 2.2;
                particles.push({
                  x: px,
                  y: py,
                  vx: Math.cos(a) * sp,
                  vy: Math.sin(a) * sp,
                  life: 1,
                  max: 380 + Math.random() * 260,
                  rgb: "255,255,255",
                });
              }
              shockwaves.push({ x: px, y: py, life: 1, max: 460, rgb: ch });
              popups.push({
                x: px,
                y: py,
                life: 1,
                max: 720,
                text: combo >= 2 ? `+1 连击 ×${combo}` : "+1",
              });
            }
            // 新星必须避开火箭与当前瞄准点（t4-F1/F2）；距离约束的意义是观感/公平，
            // 防自动命中的保证已经换成"aim 判定 + 停留"（t6-R1）。
            const nextPick = this.spawn(
              w,
              h,
              star.nm,
              [rocket, aim ?? rocket],
              degMm(maxCaptureRadiusDeg(score, hitErrors) + STAR_SPAWN_MARGIN_DEG),
            );
            if (nextPick.relaxed) spawnRelaxed++;
            stars.push(nextPick.star);
            star = nextPick.star;
            captureDwellSince = null;
          } else if (!star.collected && now - star.bornAt > lifeMs) {
            expired++;
            trials++;
            // 连击中断。灰色的"错过"小簇：只提示，不惩罚。
            combo = 0;
            {
              const px = w / 2 + sx / geom.mmPerPx;
              const py = h / 2 + sy / geom.mmPerPx;
              for (let i = 0; i < 8; i++) {
                const a = Math.random() * Math.PI * 2;
                const sp = 0.3 + Math.random() * 1.1;
                particles.push({
                  x: px,
                  y: py,
                  vx: Math.cos(a) * sp,
                  vy: Math.sin(a) * sp,
                  life: 1,
                  max: 420 + Math.random() * 220,
                  rgb: "170,175,185",
                });
              }
            }
            // 过期重撒同样要避开火箭/瞄准点（F2：旧版只避让上一颗星，视线不动也会撞上）。
            const nextPick = this.spawn(
              w,
              h,
              star.nm,
              [rocket, aim ?? rocket],
              degMm(maxCaptureRadiusDeg(score, hitErrors) + STAR_SPAWN_MARGIN_DEG),
            );
            if (nextPick.relaxed) spawnRelaxed++;
            stars.push(nextPick.star);
            star = nextPick.star;
            captureDwellSince = null;
          }
        }
        while (stars.length > 4) stars.shift();

        // ---------- 绘制
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.presenter.clear(ctx, w, h);
        ctx.globalCompositeOperation = "source-over";
        this.drawStarfield(ctx, w, h, dt, starfield);

        // 中央参考点三态：
        //   巡航 → 一个很小的白点（提供空间参考，不抢注意力）
        //   待加油 → 红色停机坪（光环 + 圆环 + 十字 + 指向箭头）
        //   校准中 → 绿色停机坪 + 燃料进度弧 + 旋转虚线
        {
          const cxp = w / 2;
          const cyp = h / 2;
          const unit = Math.min(w, h);
          if (!needRefuel) {
            ctx.beginPath();
            ctx.arc(cxp, cyp, unit * 0.006, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.26)";
            ctx.fill();
          } else {
            const r = unit * 0.062;
            const pulse = 1 + 0.06 * Math.sin(now / 220);
            const col = refuelling ? "120,230,170" : "255,90,90";
            // 外层柔光：让"回这里"在余光里也看得见
            const halo = ctx.createRadialGradient(cxp, cyp, r * 0.6, cxp, cyp, r * 2.6);
            halo.addColorStop(0, `rgba(${col},${refuelling ? 0.16 : 0.2})`);
            halo.addColorStop(1, `rgba(${col},0)`);
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(cxp, cyp, r * 2.6, 0, Math.PI * 2);
            ctx.fill();

            // 停机坪内盘
            ctx.beginPath();
            ctx.arc(cxp, cyp, r * 0.82, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${col},${refuelling ? 0.1 : 0.13})`;
            ctx.fill();

            ctx.strokeStyle = `rgba(${col},0.92)`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cxp, cyp, r * pulse, 0, Math.PI * 2);
            ctx.stroke();

            // 旋转虚线弧：静止时也有"活着"的感觉
            ctx.save();
            ctx.translate(cxp, cyp);
            ctx.rotate(now / 1400);
            ctx.setLineDash([r * 0.16, r * 0.22]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgba(${col},0.5)`;
            ctx.beginPath();
            ctx.arc(0, 0, r * 1.1, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            // 十字
            ctx.lineWidth = Math.max(2, r * 0.18);
            const arm = r * 0.42;
            ctx.beginPath();
            ctx.moveTo(cxp - arm, cyp);
            ctx.lineTo(cxp + arm, cyp);
            ctx.moveTo(cxp, cyp - arm);
            ctx.lineTo(cxp, cyp + arm);
            ctx.stroke();

            // 待加油：四个指向中心的箭头（呼吸节拍）
            if (!refuelling) {
              const a0 = now / 500;
              for (let i = 0; i < 4; i++) {
                const a = a0 + (i * Math.PI) / 2;
                const rr = r * (1.5 + 0.1 * Math.sin(a0 * 2 + i));
                const ax = cxp + Math.cos(a) * rr;
                const ay = cyp + Math.sin(a) * rr;
                ctx.save();
                ctx.translate(ax, ay);
                ctx.rotate(a + Math.PI);
                ctx.beginPath();
                ctx.moveTo(0, -r * 0.1);
                ctx.lineTo(r * 0.12, r * 0.08);
                ctx.lineTo(-r * 0.12, r * 0.08);
                ctx.closePath();
                ctx.fillStyle = "rgba(255,120,120,0.75)";
                ctx.fill();
                ctx.restore();
              }
            }

            if (refuelling) {
              ctx.lineWidth = 4;
              ctx.beginPath();
              ctx.arc(cxp, cyp, r * 1.22, -Math.PI / 2, -Math.PI / 2 + fuel * Math.PI * 2);
              ctx.stroke();
              // 校准提示语放在绿圈下方约 2°（r*1.28 ≈ 0.079×屏高）：
              // 看提示语就等于看中心，不会像顶部那条 DOM 文字（中心上方 11°）那样
              // 把"读提示"的样本混进零位（FM-1）。
              ctx.font = `500 ${Math.round(unit * 0.024)}px -apple-system, "Segoe UI", sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = "rgba(255,255,255,0.66)";
              ctx.fillText(
                fuel >= 1 ? "快满了 · 再盯一会儿" : "正在校准 · 看住绿圈",
                cxp,
                cyp + r * 1.28,
              );
            }
          }
        }

        // 星星（分视）。待加油期间完全隐藏，两种活动不共存。
        if (launched && !needRefuel) {
          for (const s of stars) {
            const age = now - s.bornAt;
            const fade = s.collected ? Math.max(0, 1 - (now - s.collectedAt) / 360) : 1;
            if (fade <= 0.01) continue;
            const isActive = s === star;
            const baseR = Math.min(w, h) * 0.05;
            const pulse = isActive ? 1 + 0.09 * Math.sin(now / 190) : 1 + 0.7 * (1 - fade);
            s.rot += s.rotSpd * dt;
            const item: SceneItem = {
              x: s.nm.x * w,
              y: s.nm.y * h,
              r: baseR * s.size * pulse,
              eye: s.eye,
              alpha: fade,
              rim: 0.4,
              kind: "star",
              rot: s.rot,
            };
            this.presenter.drawItem(ctx, item);
            // 锁定反馈：贴着星星的一圈白光，越接近捕获越亮越粗。
            // 只影响观感，不改变任何判定；用白色而不是分视颜色——两眼都要看得见"快抓到了"。
            // t6-R1/F12：反馈距离用**瞄准点**（与判定同一来源），半径用本帧实际判定的
            // captureDegNow（含趋势放大与实测误差），否则"环亮了但判不中"会前后不一致。
            if (isActive && !s.collected && aim) {
              const gapDeg = aimedDistanceDeg(aim, { x: this.mmX(s.nm.x, w), y: this.mmY(s.nm.y, h) }, geom.distanceMm);
              const lock = lockLevel(gapDeg, captureDegNow, magnetStrength);
              if (lock > 0.02) {
                ctx.beginPath();
                ctx.arc(item.x, item.y, baseR * (1.3 + 0.3 * lock), 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(255,255,255,${(0.08 + 0.34 * lock).toFixed(3)})`;
                ctx.lineWidth = 1.5 + 2.5 * lock;
                ctx.stroke();
              }
            }
            if (isActive && !s.collected && age > 3000 && !refuelling) {
              const kk = Math.min(1, (age - 3000) / 1500);
              ctx.beginPath();
              ctx.arc(item.x, item.y, baseR * (2.0 + 0.5 * kk), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,255,255,${(0.07 + 0.24 * kk).toFixed(3)})`;
              ctx.lineWidth = 2;
              ctx.stroke();
            }
            // 活跃星的十字闪光：白色（两眼都看得见），让"目标星"更醒目
            if (isActive && !s.collected) {
              const tw = 0.55 + 0.45 * Math.sin(now / 130);
              const rr = baseR * s.size * (1.9 + 0.25 * tw);
              ctx.save();
              ctx.translate(item.x, item.y);
              ctx.rotate(s.rot * 0.5);
              ctx.strokeStyle = `rgba(255,255,255,${(0.32 * tw).toFixed(3)})`;
              ctx.lineWidth = 1.4;
              ctx.beginPath();
              ctx.moveTo(-rr, 0);
              ctx.lineTo(-rr * 0.34, 0);
              ctx.moveTo(rr * 0.34, 0);
              ctx.lineTo(rr, 0);
              ctx.moveTo(0, -rr);
              ctx.lineTo(0, -rr * 0.34);
              ctx.moveTo(0, rr * 0.34);
              ctx.lineTo(0, rr);
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        // 尾迹
        ctx.lineCap = "round";
        for (let i = 1; i < trail.length; i++) {
          const a = (i / trail.length) * 0.42;
          ctx.strokeStyle = `rgba(150,210,255,${a.toFixed(3)})`;
          ctx.lineWidth = 1 + 3.4 * (i / trail.length);
          ctx.beginPath();
          ctx.moveTo(w / 2 + trail[i - 1].x / geom.mmPerPx, h / 2 + trail[i - 1].y / geom.mmPerPx);
          ctx.lineTo(w / 2 + trail[i].x / geom.mmPerPx, h / 2 + trail[i].y / geom.mmPerPx);
          ctx.stroke();
        }

        // 粒子
        for (let i = particles.length - 1; i >= 0; i--) {
          const p2 = particles[i];
          p2.life -= dt / p2.max;
          if (p2.life <= 0) {
            particles.splice(i, 1);
            continue;
          }
          p2.x += p2.vx * (dt / 16.7);
          p2.y += p2.vy * (dt / 16.7);
          p2.vy += 0.05 * (dt / 16.7);
          ctx.fillStyle = `rgba(${p2.rgb},${p2.life.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p2.x, p2.y, 1.8 + 2.2 * p2.life, 0, Math.PI * 2);
          ctx.fill();
        }

        // 冲击波圆环：捕获瞬间从星星处荡开
        for (let i = shockwaves.length - 1; i >= 0; i--) {
          const s = shockwaves[i];
          s.life -= dt / s.max;
          if (s.life <= 0) {
            shockwaves.splice(i, 1);
            continue;
          }
          const k = 1 - s.life;
          const rr = Math.min(w, h) * (0.05 + 0.16 * k);
          ctx.beginPath();
          ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${s.rgb},${(s.life * 0.55).toFixed(3)})`;
          ctx.lineWidth = 1 + 3 * s.life;
          ctx.stroke();
        }

        // "+1 / 连击" 飘字：上浮 + 淡出
        for (let i = popups.length - 1; i >= 0; i--) {
          const p = popups[i];
          p.life -= dt / p.max;
          if (p.life <= 0) {
            popups.splice(i, 1);
            continue;
          }
          const k = 1 - p.life;
          const unit = Math.min(w, h);
          ctx.font = `700 ${Math.round(unit * (0.03 + 0.012 * p.life))}px -apple-system, "Segoe UI", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = `rgba(255,255,255,${(p.life * 0.9).toFixed(3)})`;
          ctx.fillText(p.text, p.x, p.y - unit * 0.05 * k);
        }

        // 火箭
        this.drawRocket(
          ctx,
          w / 2 + rocket.x / geom.mmPerPx,
          h / 2 + rocket.y / geom.mmPerPx,
          smoothAngle,
          Math.min(w, h) * 0.028,
          rocketSpeed,
          fuel <= 0.001,
        );

        // HUD 只在巡航时画：分数在中心上方 11.3°、燃料条 9°，校准期间留在屏幕上
        // 就是两个稳定的"假中心"样本源（FM-1）。校准期间屏幕只留绿圈和它下方 2° 的提示。
        if (!needRefuel) this.drawHud(ctx, w, h, score, elapsed, fuel, refuelling, combo, scorePop);

        // 开局教学提示：前 8 秒淡入淡出（使用模式的第一局尤其需要）
        if (launched && !needRefuel && elapsed > 1500 && elapsed < 8000) {
          const a =
            Math.min(1, (elapsed - 1500) / 800) * Math.min(1, (8000 - elapsed) / 1200);
          if (a > 0.01) {
            const unit = Math.min(w, h);
            ctx.font = `500 ${Math.round(unit * 0.024)}px -apple-system, "Segoe UI", sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = `rgba(255,255,255,${(0.72 * a).toFixed(3)})`;
            ctx.fillText("眼睛盯着星星，火箭就会自己飞过去", w / 2, h * 0.7);
          }
        }
        await raf();
      }
      // 时间到：白闪 + 结算文字，停留约 0.7 秒再退出（比画面突然消失友好得多）
      if (!this.cancelled) {
        const t0 = performance.now();
        while (performance.now() - t0 < 700 && !this.cancelled) {
          const k = (performance.now() - t0) / 700;
          const unit = Math.min(w, h);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.presenter.clear(ctx, w, h);
          if (k < 0.35) {
            ctx.fillStyle = `rgba(255,255,255,${(0.5 * (1 - k / 0.35)).toFixed(3)})`;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, k * 2.4).toFixed(3)})`;
          ctx.font = `700 ${Math.round(unit * 0.07)}px -apple-system, "Segoe UI", sans-serif`;
          ctx.fillText("时间到", w / 2, h / 2 - unit * 0.012);
          ctx.font = `500 ${Math.round(unit * 0.026)}px -apple-system, "Segoe UI", sans-serif`;
          ctx.fillStyle = `rgba(255,255,255,${(0.62 * Math.min(1, Math.max(0, k - 0.12) * 2)).toFixed(3)})`;
          ctx.fillText(`这一局收集了 ${score} 颗星星`, w / 2, h / 2 + unit * 0.07);
          await raf();
        }
      }
    } finally {
      this.exit();
    }

    return {
      score,
      trials,
      hits,
      expired,
      meanCaptureMs: captureMs.length
        ? captureMs.reduce((a, b) => a + b, 0) / captureMs.length
        : NaN,
      medianErrorDeg: errors.length ? quantile(errors, 0.5) : NaN,
      p90ErrorDeg: errors.length ? quantile(errors, 0.9) : NaN,
      meanHitErrorDeg: hitErrors.length
        ? hitErrors.reduce((a, b) => a + b, 0) / hitErrors.length
        : NaN,
      anchorLeftDeg,
      anchorRightDeg,
      refuels,
      assistHits,
      stillHits,
      anchorRelaxed,
      spawnRelaxed,
      dominantEye: this.o.dominantEye,
      contrastRatio: this.o.contrastRatio,
      durationMs: Math.min(this.o.durationMs, performance.now() - start),
      validRatio: totalFrames ? validFrames / totalFrames : 0,
      presenter: this.presenter.name,
    };
  }

  /**
   * 背景星空：白色微点、缓慢下落、各自闪烁。
   * 白色 = 两眼都看得见，与火箭/加油站同理，不参与分视、不影响判定。
   */
  private drawStarfield(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dt: number,
    stars: BgStar[],
  ): void {
    const now = performance.now();
    for (const s of stars) {
      s.y += (s.drift * dt) / 1000 / Math.max(h, 1);
      if (s.y > 1.02) {
        s.y = -0.02;
        s.x = Math.random();
      }
      const tw = 0.5 + 0.5 * Math.sin(now / (700 / s.sp) + s.ph);
      ctx.fillStyle = `rgba(255,255,255,${(0.1 + 0.22 * tw).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRocket(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    r: number,
    speed: number,
    outOfFuel: boolean,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // ---- 尾焰：长度与抖动随速度（没油只剩一点灰烟）
    const throttle = outOfFuel ? 0.1 : Math.min(1, speed / 260);
    if (throttle > 0.03) {
      const fl = r * (0.8 + 2.6 * throttle) * (0.9 + 0.18 * Math.sin(performance.now() / 45));
      const fg = ctx.createLinearGradient(0, 0, -fl, 0);
      fg.addColorStop(0, outOfFuel ? "rgba(190,195,205,0.5)" : "rgba(255,236,190,0.95)");
      fg.addColorStop(0.45, outOfFuel ? "rgba(150,155,170,0.28)" : "rgba(255,160,80,0.6)");
      fg.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.34);
      ctx.quadraticCurveTo(-fl * 0.6, -r * 0.2, -fl, 0);
      ctx.quadraticCurveTo(-fl * 0.6, r * 0.2, -r * 0.5, r * 0.34);
      ctx.closePath();
      ctx.fill();
      // 内焰芯（白 → 蓝）
      const fl2 = fl * 0.55;
      const fg2 = ctx.createLinearGradient(0, 0, -fl2, 0);
      fg2.addColorStop(0, "rgba(255,255,255,0.9)");
      fg2.addColorStop(1, "rgba(140,200,255,0)");
      ctx.fillStyle = fg2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.16);
      ctx.quadraticCurveTo(-fl2 * 0.6, 0, -fl2, 0);
      ctx.quadraticCurveTo(-fl2 * 0.6, 0, -r * 0.5, r * 0.16);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 尾翼
    ctx.fillStyle = outOfFuel ? "rgba(150,158,170,0.8)" : "rgba(120,190,255,0.85)";
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.3);
    ctx.lineTo(-r * 1.15, -r * 0.85);
    ctx.lineTo(-r * 0.62, -r * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, r * 0.3);
    ctx.lineTo(-r * 1.15, r * 0.85);
    ctx.lineTo(-r * 0.62, r * 0.1);
    ctx.closePath();
    ctx.fill();

    // ---- 机身外发光
    const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.9);
    glow.addColorStop(0, outOfFuel ? "rgba(200,205,215,0.22)" : "rgba(160,220,255,0.3)");
    glow.addColorStop(1, "rgba(160,220,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2);
    ctx.fill();

    // ---- 机身
    const body = ctx.createLinearGradient(-r, -r, r, r);
    body.addColorStop(0, outOfFuel ? "#c9ced8" : "#e8f4ff");
    body.addColorStop(1, outOfFuel ? "#8f96a2" : "#a9cbe8");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(r * 1.25, 0);
    ctx.quadraticCurveTo(r * 0.4, -r * 0.62, -r * 0.55, -r * 0.5);
    ctx.lineTo(-r * 0.55, r * 0.5);
    ctx.quadraticCurveTo(r * 0.4, r * 0.62, r * 1.25, 0);
    ctx.closePath();
    ctx.fill();

    // ---- 舷窗 + 高光
    ctx.beginPath();
    ctx.arc(r * 0.32, 0, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = outOfFuel ? "rgba(120,140,160,0.9)" : "rgba(80,160,230,0.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r * 0.27, -r * 0.06, r * 0.08, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

    ctx.restore();
  }

  private mmX(nm: number, w: number): number {
    return (nm - 0.5) * w * this.o.geom.mmPerPx;
  }

  private mmY(nm: number, h: number): number {
    return (nm - 0.5) * h * this.o.geom.mmPerPx;
  }

  private magDeg(dxMm: number, dyMm: number): number {
    return (Math.atan2(Math.hypot(dxMm, dyMm), this.o.geom.distanceMm) * 180) / Math.PI;
  }

  /**
   * 撒一颗新星。
   *
   * `avoidMm` 是必须避开的点（约定：第 1 个是火箭，第 2 个若有则是当前瞄准点），
   * `minAvoidMm` = 捕获半径(最大) + 1°。保留这条距离约束是为了**避免星星刷在视线正上方**
   * （观感/公平性），但它**不再是"不会自动捕获"的保证**——t6-R1 之后判定基于 aim，
   * 火箭的飞行路径根本不参与判定；真正的保证是"只用 aim 判定 + 60 ms 停留"。
   * 若"同时避开火箭与瞄准点"在盒子里无解（两者相距 ≥6° 的极端几何），
   * 会退到只避开瞄准点，并把这个降级计数上报（t6-R6）。
   * 具体挑选在 starSpawn.ts 里（纯几何 + 注入随机源），可离线断言。
   */
  private spawn(
    w: number,
    h: number,
    prev: Pt | null,
    avoidMm: Pt[],
    minAvoidMm: number,
  ): { star: Star; relaxed: boolean } {
    const geo = this.o.geom;
    // 星星必须留在校准良好的中心区（±7° × ±5°）。
    // 原来用固定 margin 0.13，而校准网格的边界正好也是 0.13（±13.9°）——
    // 星星被撒在校准网格的最外圈，那里模型误差最大（逐点 LOO 到 8–11°）。
    // 横向校准网格只到 ±14°、纵向只到 ±8.4°，±7/±5 才是"校准良好"的那块。
    const halfH = (Math.tan((7 * Math.PI) / 180) * geo.distanceMm) / (w * geo.mmPerPx);
    const halfV = (Math.tan((5 * Math.PI) / 180) * geo.distanceMm) / (h * geo.mmPerPx);
    const x0 = Math.max(0.05, 0.5 - halfH);
    const x1 = Math.min(0.95, 0.5 + halfH);
    const y0 = Math.max(0.05, 0.5 - halfV);
    const y1 = Math.min(0.95, 0.5 + halfV);

    const pick = pickStarSpawn({
      x0,
      x1,
      y0,
      y1,
      widthPx: w,
      heightPx: h,
      mmPerPx: geo.mmPerPx,
      distanceMm: geo.distanceMm,
      avoidMm,
      minAvoidMm,
      fallbackAvoidMm: avoidMm.length > 1 ? [avoidMm[avoidMm.length - 1]] : avoidMm,
      prevNm: prev,
      // 与上一颗星至少隔 6°：避免新星和刚消失的那颗叠在一起，让人分不清哪个是目标。
      prefPrevMm: (6 * Math.PI * geo.distanceMm) / 180,
      rand: Math.random,
    });

    return {
      star: {
        nm: pick.nm,
        bornAt: performance.now(),
        eye: Math.random() < 0.5 ? "left" : "right",
        collected: false,
        collectedAt: 0,
        size: 0.85 + Math.random() * 0.3,
        rot: Math.random() * Math.PI * 2,
        rotSpd: (Math.random() - 0.5) * 0.0011,
      },
      relaxed: pick.relaxed,
    };
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    score: number,
    elapsed: number,
    fuel: number,
    refuelling: boolean,
    combo: number,
    scorePop: number,
  ): void {
    const left = Math.max(0, Math.ceil((this.o.durationMs - elapsed) / 1000));
    const unit = Math.min(w, h);
    const cx = w / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // 分数：命中瞬间弹一下
    ctx.save();
    ctx.translate(cx, unit * 0.03);
    ctx.scale(1 + 0.35 * scorePop, 1 + 0.35 * scorePop);
    ctx.shadowColor = "rgba(120,190,255,0.85)";
    ctx.shadowBlur = unit * 0.02;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `700 ${Math.round(unit * 0.05)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(String(score), 0, 0);
    ctx.restore();

    // 第二行：连击（暖色）优先，否则显示剩余时间
    ctx.font = `700 ${Math.round(unit * 0.022)}px -apple-system, "Segoe UI", sans-serif`;
    if (combo >= 2) {
      ctx.fillStyle = "rgba(255,196,110,0.95)";
      ctx.fillText(`连击 ×${combo}`, cx, unit * 0.03 + unit * 0.058);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.font = `500 ${Math.round(unit * 0.021)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.fillText(`${left}s`, cx, unit * 0.03 + unit * 0.058);
    }

    // 燃料条：圆角 + 渐变，快没了会呼吸
    const bw = unit * 0.22;
    const bh = Math.max(7, unit * 0.013);
    const bx = cx - bw / 2;
    const by = unit * 0.03 + unit * 0.098;
    const low = fuel < 0.25;
    const pulse = low && !refuelling ? 0.75 + 0.25 * Math.sin(performance.now() / 160) : 1;
    ctx.fillStyle = `rgba(255,255,255,${(0.14 * pulse).toFixed(3)})`;
    this.roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fill();
    if (fuel > 0.001) {
      const fill = Math.max(bh, bw * Math.max(0, Math.min(1, fuel)));
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      if (refuelling) {
        g.addColorStop(0, "rgba(90,220,150,0.95)");
        g.addColorStop(1, "rgba(150,240,190,0.95)");
      } else if (low) {
        g.addColorStop(0, `rgba(255,120,90,${(0.95 * pulse).toFixed(3)})`);
        g.addColorStop(1, `rgba(255,170,120,${(0.95 * pulse).toFixed(3)})`);
      } else {
        g.addColorStop(0, "rgba(110,180,255,0.9)");
        g.addColorStop(1, "rgba(170,225,255,0.95)");
      }
      ctx.fillStyle = g;
      this.roundRect(ctx, bx, by, fill, bh, bh / 2);
      ctx.fill();
    }
    void h;
  }

  /** 圆角矩形路径（不填充；roundRect 不可用时退化为方角） */
  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  private drawCountdown(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dpr: number,
    text: string,
    tMs: number,
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.presenter.clear(ctx, w, h);
    const unit = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    // 每 540ms 荡开一圈的圆环
    const k = (tMs % 540) / 540;
    ctx.beginPath();
    ctx.arc(cx, cy, unit * (0.1 + 0.24 * k), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(120,190,255,${(0.5 * (1 - k)).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `700 ${Math.round(unit * 0.18)}px -apple-system, sans-serif`;
    ctx.fillText(text, cx, cy);
    ctx.font = `500 ${Math.round(unit * 0.026)}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("眼睛盯着星星，火箭就会自己飞过去", cx, cy + unit * 0.16);
  }

  private exit(): void {
    this.o.canvas.classList.remove("on");
    this.o.hud.classList.remove("on");
    this.o.promptEl.textContent = "";
    this.o.progressEl.style.width = "0%";
    window.removeEventListener("keydown", this.onKey);
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  }
}
