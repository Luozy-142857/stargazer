/**
 * 产品侧辅助层：鲁棒零位 + 磁吸（magnet）+ 有界宽容（bounded tolerance）+ 锁定反馈（lock）。
 *
 * 定位：这一层只做纯数值计算——不参与测量、不持有跨帧状态、不碰渲染。
 *
 *   1. `robustZero()`：加油锚定的零位估计（中位数 + 截尾 + MAD 门控）；
 *   2. `captureRadiusDeg()`：把捕获半径从"随分数一路收进噪声带"改成"有硬地板"的单调曲线；
 *   3. `magnetPull()`：当火箭**已经贴近**星星、且视线**确实在朝星星方向移动**时，
 *      给瞄准点加一个**极小**的朝向偏移，把"差一点点"补成"命中"；
 *   4. `lockLevel()`：给绘制层一个 0..1 的"快抓到了"强度，让玩家有反馈。
 *
 * 为什么单列一个文件：这里全是纯函数——不碰浏览器对象、不碰渲染、不读时钟、不用随机数，
 * 只做算术，所以可以直接在 Node 里回放帧序列做回归，也方便 reviewer 逐条核对阈值。
 *
 * 单位约定：所有"度 ↔ 毫米"都用观看距离 distanceMm 换算，口径与 gazeGame 里的
 * degMm() 完全一致（mm = d·tanθ）。输入坐标都是"屏幕中心起算的毫米"，x 右为正、y 下为正。
 *
 * 量纲基准（docs/GAME-CONTROL-AUDIT.md）：1° ≈ 37.4 px ≈ 8.7 mm（@500 mm）；
 * 校准交叉验证噪声地板 2.2–4.5°/帧，旧版游戏命中误差 2.89°；
 * 星星可视半径 1.2°，火箭可视半径 0.67°。
 *
 * ── 为什么这套磁吸不会变成"自动播放"（关键，四条独立理由）─────────────
 *   a. **距离闸门**：只有火箭已经在星星 6.5° 以内才可能生效。捕获半径本身是 4.0–5.5°，
 *      也就是说生效时玩家已经"基本看对"了，磁吸只处理最后一小段。
 *   b. **运动闸门**：视线速度在"指向星星"方向上的投影必须 ≥ 2°/s。
 *      静止注视时投影≈0 → 偏移恒为 0。这一条直接排除"完全不看星星也能自动抓到"：
 *      自动播放需要的是"不动也能被拖过去"，而这里不动 = 完全无作用。
 *   c. **幅度硬上限**：偏移绝对量 ≤ min(0.6°, 25% × 剩余距离)。0.6° 只有星星可视半径
 *      （1.2°）的一半、噪声地板（2–4.5°）的 1/3 ~ 1/7 —— 它买不来"没看对"，
 *      最多把"差一点点"补上。等效容差增量 ≈ +0.6°，远小于任何一次校准误差。
 *   d. **偏移是"位置"不是"积分量"**：每帧按当前剩余距离重算，不在上一帧偏移上累加，
 *      所以不存在"抖动棘轮"：抖得再久，瞄准点也最多朝星星挪 0.6°，不会一步步蹭进去。
 * ────────────────────────────────────────────────────────────────
 */
import type { Pt } from "../types";

const DEG_TO_RAD = Math.PI / 180;

/** 把值夹回 [0,1]。 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 角度 → 毫米（屏幕中心起算）。与 gazeGame 的 degMm() 同口径（d·tanθ）。 */
export function degToMm(deg: number, distanceMm: number): number {
  return distanceMm * Math.tan(deg * DEG_TO_RAD);
}

/**
 * 毫米 → 角度。用 atan2 而不是 atan(mm/d)，这样负值也能保留符号。
 * 小角度下它同时是"速度"的换算：mm/s ÷ 距离 → °/s（θ≈mm/d，线性区误差 <0.5%）。
 */
export function mmToDeg(mm: number, distanceMm: number): number {
  if (!(distanceMm > 0)) return 0;
  return (Math.atan2(mm, distanceMm) * 180) / Math.PI;
}

// ───────────────────────────── 有界宽容 ─────────────────────────────

/** 开局捕获半径（度）。沿用旧曲线的起点，手感不变。 */
export const CAPTURE_START_DEG = 5.5;
/**
 * 捕获半径的**硬地板**（度）。这是"有界宽容"的下界，任何分数都不能突破。
 * 旧曲线 5.5 − 2.3p 在 score=20 时是 3.2°，正落在实测噪声 2–4.5°/帧的正中间，
 * 于是"越到后面越该中不中"，玩家只会得出"这东西不准"的结论。
 *
 * 诚实说明（t4-F8）：4.0° 仍在噪声带（2.2–4.5°）内部、只是接近其上沿，并不是"贴着上界"。
 * 之所以不再往上抬，是因为继续放宽容差会变成"随便看看就中"；真正的补偿来自
 * t7 的 aim 判定 + 60 ms 停留门控（只认"视线到了且停了一下"），而不是把圈画得更大。
 */
export const CAPTURE_FLOOR_DEG = 4.0;
/** 难度饱和分数：与旧曲线的 score/20 一致，20 分后不再收紧。 */
export const CAPTURE_SATURATION_SCORE = 20;
/**
 * 绝对上限（度）。任何情况下捕获半径都不超过 6.0°。
 * 审计 §5.2 明确：再放大就变成"随便看看就中"（星星可视半径才 1.2°）。
 */
export const CAPTURE_ABS_MAX_DEG = 6.0;
/** 趋势门控最多把容差放大 25%（审计 P3 第 4 步给的是 1.4×，这里收得更保守）。 */
export const TREND_WIDEN_MAX = 1.25;
/** 门槛：视线朝星星的速度低于 2°/s 不放大（审计 §5.1 护栏 1）。 */
export const TREND_MIN_DEG_PER_S = 2.0;
/** 放大拉满所需的速度（°/s）。 */
export const TREND_FULL_DEG_PER_S = 8.0;
/** 按实测误差定容差：容差 = 1.6 × 最近若干次命中的中位误差（审计 P3 第 1 步）。 */
export const ERROR_RADIUS_GAIN = 1.6;
/** 参与中位数的最近命中次数。 */
export const ERROR_SPAN = 10;

/**
 * 捕获半径（度），**随得分单调不增**，且永远 ≥ CAPTURE_FLOOR_DEG。
 *   5.5° (score=0) → 4.0° (score≥20) → 一直保持 4.0°
 * 它是容差的**上限**：分数只能把容差往下压，不能压穿噪声地板。
 */
export function captureRadiusDeg(score: number): number {
  const s = Number.isFinite(score) ? Math.max(0, score) : 0;
  const p = Math.min(1, s / CAPTURE_SATURATION_SCORE);
  const deg = CAPTURE_START_DEG - (CAPTURE_START_DEG - CAPTURE_FLOOR_DEG) * p;
  // max() 只是冗余保险：公式本身已经不会低于地板，但 review 时一眼能看到"有地板"。
  return Math.max(CAPTURE_FLOOR_DEG, Math.min(CAPTURE_ABS_MAX_DEG, deg));
}

/**
 * 按实测命中误差定容差：1.6 × 最近 10 次命中的中位误差，再夹到 [4.0°, 6.0°]。
 * 冷启动（还没有命中）返回 NaN，调用方退回分数曲线。
 *
 * 为什么用"命中误差"而不是"校准 LOOCV 误差"：命中误差是**这个玩家、这台机器、
 * 此刻这个坐姿**下真正发生的事，天然包含零位残余与漂移；而 LOOCV 是校准那一刻的。
 */
export function errorBasedCaptureDeg(recentHitErrorsDeg: readonly number[]): number {
  const recent = recentHitErrorsDeg.filter((v) => Number.isFinite(v)).slice(-ERROR_SPAN);
  if (!recent.length) return Number.NaN;
  const med = median(recent);
  if (!Number.isFinite(med) || med <= 0) return Number.NaN;
  return Math.min(CAPTURE_ABS_MAX_DEG, Math.max(CAPTURE_FLOOR_DEG, ERROR_RADIUS_GAIN * med));
}

/**
 * 趋势门控的容差放大系数 ∈ [1, TREND_WIDEN_MAX]。
 * 只有"视线在朝星星飞"时才 >1；停住不动时恒为 1（审计 §5.1 护栏 1）。
 * 与 score 无关，所以乘上去不破坏 captureRadiusDeg 的单调性。
 *
 * 非有限输入（NaN / ±Infinity）一律退回 1（不放大）：
 * 上游的视线速度是滤波器估计值，任何 NaN 都不该把捕获半径污染成 NaN——
 * 那会让 `dist <= NaN` 恒假、星星永远抓不到（t4-F7）。
 */
export function trendWidenFactor(towardDegPerS: number): number {
  if (!Number.isFinite(towardDegPerS)) return 1;
  const t = threshold01(towardDegPerS, TREND_MIN_DEG_PER_S, TREND_FULL_DEG_PER_S);
  return 1 + (TREND_WIDEN_MAX - 1) * t;
}

/**
 * 实际用于判定的捕获半径（度）。
 *   = min(分数上限, 实测误差上限) × 趋势放大，再封顶 6.0°
 *
 * 三层都是"有界宽容"：分数只能收紧、实测误差只能收紧、趋势只能小幅放宽，
 * 且任何一层都碰不到 4.0° 以下（噪声地板）和 6.0° 以上（"随便看看就中"）。
 * 对 score 仍单调不增（min 的两项里只有一项随 score 变化，且非增）。
 */
export function assistCaptureRadiusDeg(
  score: number,
  towardDegPerS: number,
  recentHitErrorsDeg: readonly number[] = [],
): number {
  const base = captureRadiusDeg(score);
  const byError = errorBasedCaptureDeg(recentHitErrorsDeg);
  const cap = Number.isFinite(byError) ? Math.min(base, byError) : base;
  // trendWidenFactor 对 NaN/±Infinity 返回 1，所以这里永远拿得到有限值（t4-F7）。
  return Math.min(CAPTURE_ABS_MAX_DEG, cap * trendWidenFactor(towardDegPerS));
}

/**
 * 捕获半径的**可能最大值**（度）：把趋势放大拉满后的值。
 * 用途：撒点必须离火箭 ≥ 这个值 + 1°，这样星星出现的瞬间一定在捕获圈外，
 * 而且接下来无论视线朝它移动把容差放大到多少，都不会"一出现就自动命中"（t4-F1/F2/B2）。
 */
export function maxCaptureRadiusDeg(
  score: number,
  recentHitErrorsDeg: readonly number[] = [],
): number {
  const base = captureRadiusDeg(score);
  const byError = errorBasedCaptureDeg(recentHitErrorsDeg);
  const cap = Number.isFinite(byError) ? Math.min(base, byError) : base;
  return Math.min(CAPTURE_ABS_MAX_DEG, cap * TREND_WIDEN_MAX);
}

// ───────────────────────────── 趋势判定 ─────────────────────────────

/**
 * 视线速度在"指向目标"方向上的投影（mm/s，带符号）。
 * >0 = 正在接近目标；≤0 = 静止或远离。这是磁吸的第二个必要条件。
 */
export function towardSpeedMmS(velocityMm: Pt, deltaMm: Pt): number {
  const d = Math.hypot(deltaMm.x, deltaMm.y);
  if (!(d > 1e-9)) return 0;
  return (velocityMm.x * deltaMm.x + velocityMm.y * deltaMm.y) / d;
}

// ───────────────────────────── 磁吸 ─────────────────────────────

/**
 * 磁吸的作用半径（度）。6.5° 只比最大捕获半径（5.5°，趋势放大后 6.0°）外扩 0.5–1.5°，
 * 所以它永远只处理"已经瞄得差不多、但被噪声顶出去一点点"的情况，够不着远处的星星。
 */
export const MAGNET_RANGE_DEG = 6.5;
/**
 * 磁吸偏移的绝对上限（度）。0.6° = 星星可视半径（1.2°）的一半，
 * 也远小于噪声地板（2–4.5°）—— 这是"不能替代视线"的定量保证。
 */
export const MAGNET_MAX_OFFSET_DEG = 0.6;
/** 偏移还受剩余距离约束：最多吃掉剩余距离的 25%，防止在很近时"一步到位"。 */
export const MAGNET_GAP_FRACTION = 0.25;
/** 视线朝星星的速度门槛（°/s）。低于它不生效——静止注视不产生任何偏移。 */
export const MAGNET_MIN_TOWARD_DEG_PER_S = 2.0;
/** 强度拉满所需速度（°/s）。 */
export const MAGNET_FULL_TOWARD_DEG_PER_S = 6.0;
/** 条件刚满足时的起步强度：避免门槛附近"算生效但完全无感"的断层。 */
export const MAGNET_MIN_STRENGTH = 0.35;
/** 单帧偏移变化上限（度/帧，按 dt 缩放）。60 Hz 下 6°/s，只是把偏移淡入，不是拖拽。 */
export const MAGNET_MAX_STEP_DEG = 0.1;
/**
 * 单帧偏移变化的绝对硬顶（度）。无论 dt 多大、无论拉入还是释放，都不许超过它——
 * 这是 A3 的"硬上限"。释放路径也用同一个硬顶（t4-F8：早先只有拉入受它约束，
 * 释放靠 RELEASE 0.2°×dtScale≤2.5 可以到 0.5°/帧，与注释不符）。
 */
export const MAGNET_STEP_HARD_CAP_DEG = 0.2;
/** 条件失效时偏移回退速度（度/帧）。比拉入快一倍，但同样受上面的硬顶约束。 */
export const MAGNET_RELEASE_DEG = 0.2;

export interface MagnetOptions {
  /** 上一帧的偏移（mm）。用于限速；不传视为 0。 */
  currentOffsetMm?: Pt;
  /** 帧间隔（ms），只影响淡入淡出的速度，不影响偏移上限。 */
  dtMs?: number;
  rangeDeg?: number;
  maxOffsetDeg?: number;
  gapFraction?: number;
  minTowardDegPerS?: number;
  fullTowardDegPerS?: number;
  maxStepDeg?: number;
}

export type MagnetReason = "active" | "zero-gap" | "out-of-range" | "no-toward-motion";

export interface MagnetResult {
  /** 本帧应使用的**绝对**偏移（mm），不是增量，直接加在瞄准点上。 */
  offsetMm: Pt;
  /** 两个条件是否同时满足。 */
  active: boolean;
  /** 磁吸强度 0..1（不生效时为 0），用于锁定反馈。 */
  strength: number;
  /** 火箭到星星的角距离（度）。 */
  gapDeg: number;
  /** 视线朝星星的速度分量（°/s，带符号）。 */
  towardDegPerS: number;
  /** 未生效原因，便于离线统计"磁吸到底帮了多少"。 */
  reason: MagnetReason;
}

/** 沿直线把 current 朝 target 移动最多 maxStep 毫米（不越过 target）。 */
export function slewToward(current: Pt, target: Pt, maxStepMm: number): Pt {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dist = Math.hypot(dx, dy);
  if (!(maxStepMm > 0) || dist <= maxStepMm || dist < 1e-9) return { x: target.x, y: target.y };
  const k = maxStepMm / dist;
  return { x: current.x + dx * k, y: current.y + dy * k };
}

/**
 * 磁吸：返回本帧要加在**瞄准点**上的偏移（mm）。
 *
 * 注意第一个参数是**被判定点**（aim：滤波后的视线），不是可视火箭。
 * t6-R1 之后，捕获判定与磁吸都基于 aim；火箭只是视觉载体，它飞过星星不算命中。
 *
 * 生效条件（两条缺一不可，代码里都是显式 return）：
 *   ① 被判定点到星星的距离 ≤ rangeDeg（默认 6.5°）；
 *   ② 视线速度朝星星方向的投影 ≥ minTowardDegPerS（默认 2°/s）。
 *
 * 满足后强度随速度在 [0.35, 1] 内增长，偏移量 = min(0.6°, 25%×剩余距离) × 强度，
 * 再按 ≤0.1°/帧 淡入（硬顶 0.2°/帧）。偏移方向永远是"瞄准点 → 星星"，
 * 因此它只会缩短距离，绝不会改变方向或把瞄准点甩到别处。
 */
export function magnetPull(
  aimedMm: Pt,
  starMm: Pt,
  gazeVelMm: Pt,
  distanceMm: number,
  opts: MagnetOptions = {},
): MagnetResult {
  const current = opts.currentOffsetMm ?? { x: 0, y: 0 };
  // dt 只用来缩放淡入淡出速度；夹在 [0.25, 2.5] 倍，慢帧也不会一步吸过去。
  const dtScale = Math.min(2.5, Math.max(0.25, (opts.dtMs ?? 16.7) / 16.7));
  const rangeDeg = opts.rangeDeg ?? MAGNET_RANGE_DEG;
  const maxOffsetDeg = opts.maxOffsetDeg ?? MAGNET_MAX_OFFSET_DEG;
  const gapFraction = opts.gapFraction ?? MAGNET_GAP_FRACTION;
  const minToward = opts.minTowardDegPerS ?? MAGNET_MIN_TOWARD_DEG_PER_S;
  const fullToward = opts.fullTowardDegPerS ?? MAGNET_FULL_TOWARD_DEG_PER_S;
  const maxStepDeg = opts.maxStepDeg ?? MAGNET_MAX_STEP_DEG;

  const dx = starMm.x - aimedMm.x;
  const dy = starMm.y - aimedMm.y;
  const gapMm = Math.hypot(dx, dy);
  const gapDeg = mmToDeg(gapMm, distanceMm);
  const towardDegPerS = mmToDeg(towardSpeedMmS(gazeVelMm, { x: dx, y: dy }), distanceMm);

  // 条件不满足时不是"啪一下清零"，而是平滑收回——否则条件在噪声上抖动时，
  // 偏移会一格一格地跳，看起来像火箭自己在抽动。
  // 回退与拉入共用同一个单帧硬顶（0.2°），所以"无论 dt 多大单帧变化都不超过 0.2°"
  // 对两条路径都成立（t4-F8）。
  const stepCapMm = degToMm(MAGNET_STEP_HARD_CAP_DEG, distanceMm);
  const idle = (reason: MagnetReason): MagnetResult => {
    const back = slewToward(
      current,
      { x: 0, y: 0 },
      Math.min(degToMm(MAGNET_RELEASE_DEG, distanceMm) * dtScale, stepCapMm),
    );
    return { offsetMm: back, active: false, strength: 0, gapDeg, towardDegPerS, reason };
  };

  if (!(gapMm > 1e-6)) return idle("zero-gap");
  // 条件①：距离闸门（显式）
  if (gapDeg > rangeDeg) return idle("out-of-range");
  // 条件②：视线确实在朝星星移动（显式）
  if (!(towardDegPerS >= minToward)) return idle("no-toward-motion");

  const ramp = threshold01(towardDegPerS, minToward, fullToward);
  const strength = MAGNET_MIN_STRENGTH + (1 - MAGNET_MIN_STRENGTH) * ramp;

  // 幅度上限：绝对 0.6° 与"剩余距离的 25%"取小，再乘强度。
  // 这两条一起保证"一次最多只补一小段"，不会把远处的星星拖过来。
  const wantedMm =
    Math.min(degToMm(maxOffsetDeg, distanceMm), gapMm * gapFraction) * strength;
  const ux = dx / gapMm;
  const uy = dy / gapMm;

  // 单帧变化硬上限：正常 0.1°/帧（按 dt 缩放），无论如何不超过 0.2°/帧。
  // 这条只影响"淡入多快"，真正的治疗边界是上面的 wantedMm。
  const stepMm = Math.min(
    degToMm(maxStepDeg, distanceMm) * dtScale,
    degToMm(MAGNET_STEP_HARD_CAP_DEG, distanceMm),
  );
  const offset = slewToward(current, { x: ux * wantedMm, y: uy * wantedMm }, stepMm);

  return {
    offsetMm: offset,
    active: true,
    strength,
    gapDeg,
    towardDegPerS,
    reason: "active",
  };
}

// ───────────────────────────── 锁定反馈 ─────────────────────────────

/** 锁定环从"捕获半径的 2.2 倍"开始点亮：再远就完全看不见，免得满屏白圈。 */
export const LOCK_OUTER_RATIO = 2.2;
/** 磁吸真在生效时，额外点亮的比例（让"吸住了"有手感）。 */
export const LOCK_MAGNET_BOOST = 0.25;

/**
 * 锁定强度 0..1，只用于绘制，不参与任何判定。
 * gap ≥ 2.2×capture → 0；gap ≤ capture → 1；中间线性。
 * 磁吸生效时再额外点亮一点（最多 +25%），所以"被吸住"和"只是靠近"看起来不同。
 */
export function lockLevel(gapDeg: number, captureDeg: number, magnetStrength = 0): number {
  if (!(captureDeg > 0) || !Number.isFinite(gapDeg)) return 0;
  const outer = captureDeg * LOCK_OUTER_RATIO;
  const base =
    gapDeg >= outer ? 0 : gapDeg <= captureDeg ? 1 : (outer - gapDeg) / (outer - captureDeg);
  const boost = LOCK_MAGNET_BOOST * clamp01(magnetStrength) * (1 - base);
  return clamp01(base + boost);
}

/** 把 v 从 [lo, hi] 线性映射到 [0,1] 并夹紧（用于强度斜坡）。 */
function threshold01(v: number, lo: number, hi: number): number {
  if (!(hi > lo)) return v >= hi ? 1 : 0;
  return clamp01((v - lo) / (hi - lo));
}

// ─────────────────────── 捕获判定（t6-R1/R3：基于视线） ───────────────────────
//
// t6 的 blocker：旧判定是 `|火箭 - 星星| <= 捕获半径`，而火箭是一个会移动的滞后量。
// 撒点只保证"出现瞬间离火箭够远"，保证不了"火箭的飞行路径不经过星星"——
// 火箭从 -7° 收拢到 +7° 时会在第 2 帧扫过 (0°,+5°) 的星星，玩家视线全程在 +7°。
//
// 现在判定改用**瞄准点 aim**（滤波后的视线 + 有界磁吸偏移），火箭只是视觉载体。
// 判定的两个要素都在这里，游戏与离线回放共用同一套实现：
//   1. `aimedDistanceMm`：瞄准点到星星的距离（aim 为 null = 本帧没有有效视线）；
//   2. 短暂停留确认（dwell）：视线必须在捕获圈内连续停留 ≥ CAPTURE_DWELL_MS 才算命中，
//      快速扫过（pass-through）不算。见下方注释。

/**
 * 捕获所需的连续停留时间（ms）。60 ms 在 60 Hz 下约 4 帧、120 Hz 下约 7 帧，
 * 按**时间**而不是帧数计，所以判定与刷新率无关。
 *
 * 为什么要有它（C3 的语义在这里定死）：
 *   视线以 100°/s 扫过一颗"偏 5°"的星星时，落在 5.5° 捕获圈内的弦长约 4.6°、
 *   只持续约 46 ms —— 那是"扫过去"，不是"看住"。真正的注视（fixation）通常 ≥200 ms，
 *   所以 60 ms 的门槛不会误伤真实注视，却能挡掉路过。
 *   慢于约 77°/s 的扫过会停留 ≥60 ms，此时判定为命中（和"看住"没有区别）。
 */
export const CAPTURE_DWELL_MS = 60;

/**
 * 瞄准点到星星的角距离（度）。`aimedMm = null`（本帧无有效视线）时返回 Infinity，
 * 天然保证"没有有效视线就不可能捕获"。
 */
export function aimedDistanceDeg(aimedMm: Pt | null, starMm: Pt, distanceMm: number): number {
  if (!aimedMm || !Number.isFinite(aimedMm.x) || !Number.isFinite(aimedMm.y)) return Infinity;
  return mmToDeg(Math.hypot(aimedMm.x - starMm.x, aimedMm.y - starMm.y), distanceMm);
}

/**
 * 停留计时（纯函数）：在圈内时保持进入时刻，出圈/换星/无效帧则清零（返回 null）。
 * 游戏每帧把返回值存回状态，回放测试也用同一个函数，保证两边语义一致。
 */
export function stepCaptureDwell(
  enteredAt: number | null,
  inRange: boolean,
  nowMs: number,
): number | null {
  if (!inRange) return null;
  return enteredAt === null ? nowMs : enteredAt;
}

/** 停留是否已经达标（≥ CAPTURE_DWELL_MS）。 */
export function dwellSatisfied(
  enteredAt: number | null,
  nowMs: number,
  requiredMs = CAPTURE_DWELL_MS,
): boolean {
  return enteredAt !== null && Number.isFinite(nowMs) && nowMs - enteredAt >= requiredMs;
}

// ───────────────────────── 鲁棒零位（P1：加油锚定） ─────────────────────────
//
// 旧的锚定是"窗口内算术平均"：首次窗口 15° 覆盖整个屏幕高度，而顶部提示语在中心上方
// 约 11°、分数 11.3°、燃料条 9°——这些样本会被当成"正在看中心"，把零位整体拽偏（FM-1）。
// 现在改成两遍法：中位数定位 → 剔除离群 → 截尾均值，并用 MAD 做质量门控。
// 全部是纯函数，可以离线喂一段帧序列验证"混进 30% 的离群样本也拉不偏零位"。

/** 一次锚定至少要这么多**新样本**（30 Hz 下约 1 s）。旧的 12 个样本门槛太低，噪声就能决定零位。 */
export const ANCHOR_MIN_SAMPLES = 30;
/**
 * 截尾的**下限**（度）。实际截尾半径 = max(这个值, ANCHOR_TRIM_MAD_MULT × MAD)——
 * 为什么不再固定 1.2°：t4 用真实量级的 σ=1.5°/帧 抖动复现发现，固定 1.2° 会把
 * 73% 的**正常**样本当离群剔掉，`kept ≥ n/2` 直接不成立，零位永远不更新（t4-F6）。
 * 让截尾跟着这次采样自身的离散度走，才是"剔的是离群、不是噪声"。
 */
export const ANCHOR_TRIM_MIN_DEG = 1.2;
/** 截尾半径 = 这个倍数 × MAD。2.0×MAD 对二维高斯约覆盖 95% 的正常样本。 */
export const ANCHOR_TRIM_MAD_MULT = 2.0;
/**
 * 中位绝对偏差上限（度）。超过说明这次采样本本身就不稳 → 不提交，保留旧零位。
 *
 * 2.5° 是按**实测噪声**定的：同一次加油窗口内单帧抖动 σ≈1.5°，二维高斯下
 * MAD ≈ 1.177σ ≈ 1.77°，2.5° 留了约 1.4× 余量；σ=2° 仍能通过，σ≥2.5°（在打晃）会被挡住。
 * 旧值 1.2° 在 σ=1.5° 下提交率为 0（t4-F6），等于零位永远不更新。
 */
export const ANCHOR_MAD_MAX_DEG = 2.5;
/**
 * 连续不达标多少次后降级到宽松门控。加油间隔不是 3.2 s（那是单次加油**时长**），
 * 而是"满箱 18 s 掉到 22% 触发 + 找站/校准 3–9 s" ≈ **14–18 s** 一次；
 * 2 次失败 ≈ 30–36 s 就会降级，不会像 3 次那样在 60 s 一局里等到快结束。
 */
export const ANCHOR_RELAX_AFTER_MISSES = 2;
/** 降级时 MAD 门控放宽的倍数（2.5° → 4.0°）。 */
export const ANCHOR_RELAX_FACTOR = 1.6;
/** 截尾均值：两端各去掉这个比例再平均，压掉残余的偏斜。 */
export const ANCHOR_TAIL_FRAC = 0.1;

export interface RobustZeroOptions {
  minSamples?: number;
  /** 固定截尾半径（度）。不传则用 max(ANCHOR_TRIM_MIN_DEG, 2×MAD) 自适应。 */
  trimDeg?: number;
  madMaxDeg?: number;
  tailFrac?: number;
  /** 本次是否走了"连续不达标后的降级门控"——只用于结果标记。 */
  relaxed?: boolean;
}

export interface RobustZeroResult {
  /** 截尾均值（mm，屏幕中心起算） */
  x: number;
  y: number;
  /** 输入样本数 */
  n: number;
  /** 剔除离群后剩下的样本数 */
  kept: number;
  /** 中位绝对偏差（度）。质量指标，越小说明这次盯得越稳。 */
  madDeg: number;
  /** 是否满足提交条件。false 时调用方必须保留旧零位。 */
  ok: boolean;
  /** 本次实际使用的 MAD 门限（度），写进结果是为了能追溯"这是不是降级提交"。 */
  madMaxDeg: number;
  /** 本次实际使用的截尾半径（度）。 */
  trimDeg: number;
  /** 是否走了降级门控。 */
  relaxed: boolean;
}

/** 中位数（不修改输入）。 */
export function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const a = [...values].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 截尾均值：两端各去掉 tailFrac 比例的样本后取平均。 */
function trimmedMean(values: number[], tailFrac: number): number {
  if (!values.length) return 0;
  const a = [...values].sort((p, q) => p - q);
  const cut = Math.floor(a.length * clamp01(tailFrac));
  let sum = 0;
  for (let i = cut; i < a.length - cut; i++) sum += a[i];
  const count = Math.max(1, a.length - cut * 2);
  return sum / count;
}

/**
 * 鲁棒零位：中位数 + 自适应截尾 + MAD 门控 + 截尾均值。
 *
 * 提交条件（全部满足才 ok）：
 *   - 样本数 ≥ minSamples（默认 30）；
 *   - 截尾后至少保留一半样本（且不少于 8 个）；
 *   - MAD ≤ madMaxDeg（默认 2.5°，按实测 σ≈1.5° 定的）。
 * 不满足时返回 ok=false 与一个**仅供参考**的估计——调用方必须保留旧零位，
 * 宁可不更新，也不能拿一份被污染的样本把已经正确的零位覆盖掉。
 * 连续多次不达标时，调用方可以传更宽松的 madMaxDeg 并置 relaxed=true 兜底（见 ANCHOR_RELAX_*）。
 */
export function robustZero(
  points: Pt[],
  distanceMm: number,
  opts: RobustZeroOptions = {},
): RobustZeroResult {
  const minSamples = opts.minSamples ?? ANCHOR_MIN_SAMPLES;
  const madMaxDeg = opts.madMaxDeg ?? ANCHOR_MAD_MAX_DEG;
  const tailFrac = opts.tailFrac ?? ANCHOR_TAIL_FRAC;
  const relaxed = opts.relaxed ?? false;
  const n = points.length;
  if (n === 0) {
    return {
      x: 0,
      y: 0,
      n: 0,
      kept: 0,
      madDeg: Number.NaN,
      ok: false,
      madMaxDeg,
      trimDeg: opts.trimDeg ?? ANCHOR_TRIM_MIN_DEG,
      relaxed,
    };
  }

  const mx = median(points.map((p) => p.x));
  const my = median(points.map((p) => p.y));
  if (!Number.isFinite(mx) || !Number.isFinite(my)) {
    return { x: 0, y: 0, n, kept: 0, madDeg: Number.NaN, ok: false, madMaxDeg, trimDeg: ANCHOR_TRIM_MIN_DEG, relaxed };
  }
  const devDeg = points.map((p) => mmToDeg(Math.hypot(p.x - mx, p.y - my), distanceMm));
  const madDeg = median(devDeg);
  // 截尾半径跟本次的离散度走：MAD 小（盯得稳）就回到 1.2° 下限，
  // MAD 大（真实噪声）就放宽到 2×MAD，保证剔掉的是离群而不是正常噪声。
  const trimDeg =
    opts.trimDeg ?? Math.max(ANCHOR_TRIM_MIN_DEG, ANCHOR_TRIM_MAD_MULT * (Number.isFinite(madDeg) ? madDeg : ANCHOR_TRIM_MIN_DEG));

  const kept = points.filter((_, i) => devDeg[i] <= trimDeg);
  if (!kept.length) {
    return { x: mx, y: my, n, kept: 0, madDeg, ok: false, madMaxDeg, trimDeg, relaxed };
  }

  const x = trimmedMean(kept.map((p) => p.x), tailFrac);
  const y = trimmedMean(kept.map((p) => p.y), tailFrac);
  const enough = n >= minSamples && kept.length >= Math.max(8, Math.ceil(n * 0.5));
  const ok = enough && Number.isFinite(madDeg) && madDeg <= madMaxDeg;
  return { x, y, n, kept: kept.length, madDeg, ok, madMaxDeg, trimDeg, relaxed };
}
