/**
 * 注视点滤波（P2 的核心）：一级 one-euro + 死区迟滞 + 扫视吸附。
 *
 * 单独成一个文件是为了**能无头测试**：它不碰 DOM、不读时钟，`nowMs` 由调用方传入，
 * 所以可以在 Node 里按 30 Hz/60 Hz 的节拍回放一段帧序列，直接量出抖动与滞后。
 *
 * 旧实现（已删除）是 α-β（α=0.62/β=0.16）**每帧**修正，之后火箭再叠一级 0.92 的指数收敛：
 *   - 相机样本 ~30 Hz，rAF 60–120 Hz → 同一个样本被重复积分 2–4 次，
 *     等效位置增益从 0.62 涨到 0.86、速度增益翻倍（FM-2）；
 *   - dt 用的是 rAF 间隔（16 ms），而样本间隔是 33 ms，速度增益又错一倍；
 *   - 两级串联让端到端滞后 250–400 ms，表现为"火箭不跟"。
 *
 * 现在只在新样本上修正（由游戏层用 predMm 的对象引用是否变化来判断，不需要改 app.ts）：
 *   - one-euro：静止时截止频率低（钉住），视线快时截止频率自动抬高（不拖）；
 *   - 死区迟滞：安静时**位置严格不动**（旧语义只是"不修正"，还会被预测推着走）；
 *   - 扫视吸附 6°：3° 落在 2–4.5° 的噪声带里，会被噪声误触发成随机瞬移（FM-3）。
 */
import type { Pt } from "../types";

/**
 * 扫视吸附 6°。为什么是 6 而不是 3：校准交叉验证噪声 2.2–4.5°，3° 正好在带内，
 * 每次噪声尖峰都可能被当成扫视 → "瞬移 + 速度清零"，表现为卡顿和来回跳。
 * 6° ≈ 噪声上界的 1.3 倍，只对真正的扫视（>6°）生效。
 */
export const SNAP_DEG = 6;
/**
 * 死区迟滞（度）：残差 <0.6° 进入"站住"，>1.5° 才恢复跟随，中间保持原状态。
 * 0.6/1.5 两个边沿都在噪声地板之下，所以它只吃掉"传感器在抖"的部分。
 * 旧的 0.2° 只有噪声的 5–10%，从来不触发；而且旧语义是"不修正"（还会被速度预测推着走），
 * 不是"站住"。
 */
export const DEAD_ENTER_DEG = 0.6;
export const DEAD_EXIT_DEG = 1.5;
/**
 * one-euro：静止截止 0.8 Hz（≈0.2 s 时间常数，钉得住），
 * beta 0.03 /(°/s)（视线越快，截止频率抬得越高，扫视不拖）。
 */
export const MIN_CUTOFF_HZ = 0.8;
export const EO_BETA_PER_DEG_S = 0.03;
/** 导数低通截止频率（Hz）：压掉"帧间噪声 → 假速度"，否则 β 会被噪声持续抬高。 */
export const D_CUTOFF_HZ = 1.0;
/** 同一相机帧内的重复渲染帧：只沿速度外推，最多补 40 ms，系数 0.5，避免放大噪声。 */
export const PREDICT_GAIN = 0.5;
export const PREDICT_MAX_MS = 40;

export interface FilterOpts {
  snapMm: number;
  deadEnterMm: number;
  deadExitMm: number;
  minCutoffHz: number;
  /** 单位 1/(mm/s)，由 β(1/(°/s)) ÷ 每度毫米数换算而来 */
  betaPerMm: number;
  dCutoffHz: number;
}

export class GazeFilter {
  private x = 0;
  private y = 0;
  /** 低通后的导数（mm/s）：样本间外推与自适应截止频率都用它 */
  private vx = 0;
  private vy = 0;
  private zxPrev = 0;
  private zyPrev = 0;
  /** 上一个新样本的时刻（ms） */
  private tSample = 0;
  private ready = false;
  /** 是否处于"死区站住"状态（迟滞用） */
  private quiet = false;
  /** 参数显式赋值，不用 TypeScript 的构造函数参数属性——
   *  这样 Node 的 strip-only 类型擦除也能直接加载本文件（无头测试用）。 */
  private o: FilterOpts;

  constructor(o: FilterOpts) {
    this.o = o;
  }

  reset(): void {
    this.ready = false;
    this.quiet = false;
    this.vx = 0;
    this.vy = 0;
  }

  /**
   * 只在新样本上调用。同一相机帧的重复调用**不会**再被积分一次。
   * @param nowMs 收到该样本的时刻（ms）
   */
  updateNew(zx: number, zy: number, nowMs: number): Pt {
    if (!this.ready) {
      this.x = zx;
      this.y = zy;
      this.zxPrev = zx;
      this.zyPrev = zy;
      this.tSample = nowMs;
      this.ready = true;
      return { x: zx, y: zy };
    }
    // dt 用真实样本间隔（≈33 ms @30 Hz），不用 rAF 间隔（16 ms）。
    const dt = Math.max(0.008, Math.min(0.12, (nowMs - this.tSample) / 1000));
    this.tSample = nowMs;

    const rx = zx - this.x;
    const ry = zy - this.y;
    const r = Math.hypot(rx, ry);

    if (r > this.o.snapMm) {
      // 真扫视：直接到位、速度清零，不留橡皮筋。
      this.x = zx;
      this.y = zy;
      this.vx = 0;
      this.vy = 0;
      this.quiet = false;
      this.zxPrev = zx;
      this.zyPrev = zy;
      return { x: this.x, y: this.y };
    }

    // 死区迟滞：残差 <0.6° 进入"站住"，>1.5° 才恢复跟随，中间带保持原状态。
    // 站住 = 位置完全不动（也不外推），这才是"死区"该有的语义。
    if (this.quiet) {
      if (r <= this.o.deadExitMm) {
        this.vx = 0;
        this.vy = 0;
        this.zxPrev = zx;
        this.zyPrev = zy;
        return { x: this.x, y: this.y };
      }
      this.quiet = false;
    } else if (r < this.o.deadEnterMm) {
      this.quiet = true;
      this.vx = 0;
      this.vy = 0;
      this.zxPrev = zx;
      this.zyPrev = zy;
      return { x: this.x, y: this.y };
    }

    // one-euro：先低通导数（压掉帧间噪声造成的假速度），再据此抬升截止频率。
    const rawVx = (zx - this.zxPrev) / dt;
    const rawVy = (zy - this.zyPrev) / dt;
    this.zxPrev = zx;
    this.zyPrev = zy;
    const ad = 1 - Math.exp(-2 * Math.PI * this.o.dCutoffHz * dt);
    this.vx += (rawVx - this.vx) * ad;
    this.vy += (rawVy - this.vy) * ad;
    const speed = Math.hypot(this.vx, this.vy);
    const cutoff = this.o.minCutoffHz + this.o.betaPerMm * speed;
    const alpha = 1 - Math.exp(-2 * Math.PI * cutoff * dt);
    this.x += alpha * (zx - this.x);
    this.y += alpha * (zy - this.y);
    return { x: this.x, y: this.y };
  }

  /** 同一相机帧内的重复渲染帧：只沿速度外推一小段，不做任何修正。 */
  display(nowMs: number): Pt {
    if (!this.ready || this.quiet) return { x: this.x, y: this.y };
    const stale = Math.min(PREDICT_MAX_MS, Math.max(0, nowMs - this.tSample));
    const g = (PREDICT_GAIN * stale) / 1000;
    return { x: this.x + this.vx * g, y: this.y + this.vy * g };
  }

  /** 当前速度估计（mm/s）。磁吸的"朝星星移动"判据用它：比逐帧差分稳。 */
  velocityMmS(): Pt {
    return { x: this.vx, y: this.vy };
  }

  /** 是否已有初值。加油结算会 reset()，下一帧即便不是新样本也要重新播种。 */
  isReady(): boolean {
    return this.ready;
  }
}
