/**
 * tools/assist-check.ts — 辅助层纯函数无头回归检查（t3 独立验证用，t5 增补 B1/B2/B5/F6/F8）。
 *
 * 运行（Node 23+ 默认类型剥离，本机 Node 24）：
 *   node tools/assist-check.ts
 *
 * 只读 src/game/ 的导出，不修改任何业务代码。
 * 输出每条断言 PASS/FAIL；任何一条失败时进程退出码为 1。
 *
 * 断言覆盖：
 *   C1 captureRadiusDeg(score) 随得分单调不增；
 *   C2 视线速度为零时 magnetPull 返回零位移（不看不吸）；
 *   C3 视线朝目标时拉拽量随距离单调不减、距离为 0 时为 0；
 *   C4 任意输入（NaN / ±Infinity / 零距离 / 零 gap）下控制输出位移有限；
 *   C5 robustZero 质量门控（含 t4-F6 的真实噪声σ=1.5° 场景与降级兜底）；
 *   C6 lockLevel；C7 assist.ts 静态检查（无 DOM / 无时钟 / 无随机）；
 *   C8 B5：assistCaptureRadiusDeg 对 NaN/±Infinity 仍返回有限半径且捕获不失效；
 *   C9 B2：撒点离火箭（与瞄准点）≥ 捕获半径(最大) + 1°；
 *   C10 B1：视线固定在任意位置、连续 ≥10 个星星生命周期，自动捕获次数为 0；
 *   C11 静态结构检查（B3 捕获要求有效视线 / B4 结算用加油站播种 / 撒点走纯函数）；
 *   C12 t6-R1：判定基于瞄准点（aim）而非火箭——含 R1 反例、saccade 路径、边缘抖动、终点命中；
 *   C13 C3 语义：快速扫过（<60 ms）不判定、慢速停留（≥60 ms）判定，两个方向都有断言。
 */

import { existsSync, readFileSync } from "node:fs";
import {
  ANCHOR_MAD_MAX_DEG,
  ANCHOR_RELAX_FACTOR,
  CAPTURE_ABS_MAX_DEG,
  CAPTURE_DWELL_MS,
  CAPTURE_FLOOR_DEG,
  CAPTURE_START_DEG,
  MAGNET_MAX_OFFSET_DEG,
  MAGNET_RELEASE_DEG,
  MAGNET_STEP_HARD_CAP_DEG,
  aimedDistanceDeg,
  assistCaptureRadiusDeg,
  captureRadiusDeg,
  degToMm,
  dwellSatisfied,
  lockLevel,
  magnetPull,
  maxCaptureRadiusDeg,
  mmToDeg,
  robustZero,
  stepCaptureDwell,
  towardSpeedMmS,
} from "../src/game/assist.ts";
import { STAR_SPAWN_MARGIN_DEG, pickStarSpawn } from "../src/game/starSpawn.ts";

const D = 500; // 观看距离 mm，与量纲基准一致
const EPS = 1e-9;
const ZERO = { x: 0, y: 0 };

let passed = 0;
const failures: string[] = [];
const notes: string[] = [];

function check(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    const line = `${name}${detail ? ` :: ${detail}` : ""}`;
    failures.push(line);
    console.log(`[FAIL] ${line}`);
  }
}

function note(text: string): void {
  notes.push(text);
  console.log(`[NOTE] ${text}`);
}

function fmtDeg(mm: number): string {
  return `${mmToDeg(mm, D).toFixed(6)}°`;
}

/** 连续多帧调用 magnetPull，偏移按绝对位置回灌（与 gazeGame 的每帧重算语义一致）。 */
function runPull(rocket, star, vel, distanceMm, frames, opts = {}) {
  let cur = { x: 0, y: 0 };
  let maxOffMm = 0;
  let maxStepMm = 0;
  let allFinite = true;
  const rows = [];
  for (let i = 0; i < frames; i++) {
    const dtMs = opts.dtMs === undefined ? 16.7 : opts.dtMs;
    const r = magnetPull(rocket, star, vel, distanceMm, {
      ...opts,
      currentOffsetMm: cur,
      dtMs,
    });
    for (const v of [r.offsetMm.x, r.offsetMm.y, r.strength, r.gapDeg, r.towardDegPerS]) {
      if (!Number.isFinite(v)) allFinite = false;
    }
    const off = Math.hypot(r.offsetMm.x, r.offsetMm.y);
    const step = Math.hypot(r.offsetMm.x - cur.x, r.offsetMm.y - cur.y);
    maxOffMm = Math.max(maxOffMm, off);
    maxStepMm = Math.max(maxStepMm, step);
    rows.push(r);
    cur = r.offsetMm;
  }
  return { rows, maxOffMm, maxStepMm, allFinite, finalOffsetMm: cur };
}

/** 持续朝星星移动时，磁吸偏移的稳态值（度）。 */
function convergedPullDeg(gapDeg: number): number {
  const star = { x: degToMm(gapDeg, D), y: 0 };
  let cur = { x: 0, y: 0 };
  for (let i = 0; i < 400; i++) {
    const r = magnetPull(ZERO, star, { x: 1e6, y: 0 }, D, {
      currentOffsetMm: cur,
      dtMs: 16.7,
    });
    cur = r.offsetMm;
  }
  return mmToDeg(Math.hypot(cur.x, cur.y), D);
}

// ─────────────────────────────────────────────────────────────────────────
console.log("== assist-check: src/game/assist.ts 纯函数无头回归 ==");
console.log(`Node ${process.version} · distance=${D}mm · 1°=${degToMm(1, D).toFixed(4)}mm`);
console.log("");

// ── C1 捕获半径随得分单调不增 ──────────────────────────────────────────
console.log("## C1 captureRadiusDeg 随得分单调不增（A4）");
const scoreSteps = [];
for (let s = -10; s <= 100 + 1e-9; s += 0.25) scoreSteps.push(Math.round(s * 100) / 100);

let c1Finite = true;
let c1Range = true;
let c1Mono = true;
let c1Worst = "";
let prev = Infinity;
for (const s of scoreSteps) {
  const r = captureRadiusDeg(s);
  if (!Number.isFinite(r)) c1Finite = false;
  if (r < CAPTURE_FLOOR_DEG - EPS || r > CAPTURE_ABS_MAX_DEG + EPS) c1Range = false;
  if (!(r <= prev + EPS)) {
    c1Mono = false;
    if (!c1Worst) c1Worst = `score=${s}: ${prev} -> ${r}`;
  }
  prev = r;
}
check(c1Finite, "C1a score∈[-10,100] 输出均为有限数");
check(c1Range, `C1b 输出始终在 [${CAPTURE_FLOOR_DEG}, ${CAPTURE_ABS_MAX_DEG}] 度内`);
check(c1Mono, "C1c captureRadiusDeg 随 score 单调不增", c1Worst);
check(
  captureRadiusDeg(0) === CAPTURE_START_DEG &&
    captureRadiusDeg(20) === CAPTURE_FLOOR_DEG &&
    captureRadiusDeg(1e9) === CAPTURE_FLOOR_DEG,
  "C1d 端点：0 分=5.5°，≥20 分=4.0° 且不越地板",
  `0→${captureRadiusDeg(0)}, 20→${captureRadiusDeg(20)}, 1e9→${captureRadiusDeg(1e9)}`,
);
check(
  captureRadiusDeg(NaN) === CAPTURE_START_DEG &&
    captureRadiusDeg(Infinity) === CAPTURE_START_DEG &&
    captureRadiusDeg(-5) === CAPTURE_START_DEG,
  "C1e 非有限/负分数退回开局 5.5°（实现把非有限分数当 0 分）",
  `NaN→${captureRadiusDeg(NaN)}, ∞→${captureRadiusDeg(Infinity)}, -5→${captureRadiusDeg(-5)}`,
);

// 实际判定用的 assistCaptureRadiusDeg 也必须对 score 单调不增。
const errorSets = [
  [],
  [2],
  [2.2, 2.4, 2.1, 2.6, 2.3, 2.5, 2.0, 2.2, 2.4, 2.3],
  [10],
  [0.5],
  [NaN, NaN],
];
let c1AssistOk = true;
let c1AssistWorst = "";
let c1AssistCombos = 0;
for (const toward of [0, 2, 4, 8, 20, -1, Infinity]) {
  for (const errs of errorSets) {
    let p = Infinity;
    for (const s of scoreSteps) {
      const r = assistCaptureRadiusDeg(s, toward, errs);
      c1AssistCombos++;
      if (
        !Number.isFinite(r) ||
        r < CAPTURE_FLOOR_DEG - EPS ||
        r > CAPTURE_ABS_MAX_DEG + EPS ||
        !(r <= p + EPS)
      ) {
        c1AssistOk = false;
        if (!c1AssistWorst) {
          c1AssistWorst = `toward=${toward} errs=${JSON.stringify(errs)} score=${s}: ${p} -> ${r}`;
        }
      }
      p = r;
    }
  }
}
check(
  c1AssistOk,
  "C1f assistCaptureRadiusDeg 对 score 单调不增、有界（含趋势门控与实测误差上限）",
  c1AssistWorst || `${c1AssistCombos} 组组合`,
);

// ── C2 视线速度为 0 → 零位移（A2 条件②） ─────────────────────────────
console.log("\n## C2 视线速度为零时 magnetPull 位移恒为 0（A2 条件②：不看不吸）");
const star3 = { x: degToMm(3, D), y: 0 };
const still = runPull(ZERO, star3, ZERO, D, 600);
check(
  still.rows.every(
    (r) => !r.active && r.strength === 0 && r.offsetMm.x === 0 && r.offsetMm.y === 0,
  ),
  "C2a 静止注视 600 帧：offset 恒为 (0,0)，active=false，strength=0",
  `final=${still.finalOffsetMm.x},${still.finalOffsetMm.y}`,
);
check(
  still.rows.every((r) => r.reason === "no-toward-motion"),
  "C2b 静止时原因恒为 no-toward-motion",
);

const away = runPull(ZERO, star3, { x: -1000, y: 0 }, D, 600);
check(
  away.rows.every(
    (r) => !r.active && r.strength === 0 && r.offsetMm.x === 0 && r.offsetMm.y === 0,
  ),
  "C2c 视线朝反方向移动 600 帧：位移恒为 0（不会被反向拖动）",
);

const perp = runPull(ZERO, star3, { x: 0, y: 1000 }, D, 600);
check(
  perp.rows.every(
    (r) => !r.active && r.strength === 0 && r.offsetMm.x === 0 && r.offsetMm.y === 0,
  ),
  "C2d 视线垂直于目标方向移动 600 帧：朝向投影=0，位移恒为 0",
);

const star7 = { x: degToMm(7, D), y: 0 };
const far = runPull(ZERO, star7, { x: 1e4, y: 0 }, D, 600);
check(
  far.rows.every(
    (r) =>
      !r.active && r.strength === 0 && r.offsetMm.x === 0 && r.offsetMm.y === 0,
  ) && far.rows.every((r) => r.reason === "out-of-range"),
  "C2e 距离 7°（>6.5° 作用半径）时即使高速朝星星移动也不生效",
);

const weak = runPull(ZERO, star3, { x: degToMm(1.5, D), y: 0 }, D, 600);
check(
  weak.rows.every((r) => !r.active && r.offsetMm.x === 0 && r.offsetMm.y === 0) &&
    weak.rows.every((r) => r.reason === "no-toward-motion"),
  "C2f 朝星星速度 1.5°/s（<2°/s 门槛）不生效",
);

const active = runPull(ZERO, star3, { x: degToMm(10, D), y: 0 }, D, 600);
const activeFinalDeg = mmToDeg(Math.hypot(active.finalOffsetMm.x, active.finalOffsetMm.y), D);
check(
  active.rows.every((r) => r.active && r.reason === "active"),
  "C2g 距离 3° 且朝星星 10°/s：双条件同时满足才生效",
);
check(
  active.rows.every((r) => r.strength > 0 && r.strength <= 1) &&
    activeFinalDeg > 0 &&
    Math.abs(activeFinalDeg - MAGNET_MAX_OFFSET_DEG) < 1e-6,
  "C2h 生效后拉拽量≈0.6° 硬上限，强度∈(0,1]",
  `final=${activeFinalDeg.toFixed(9)}°`,
);
check(
  active.finalOffsetMm.x > 0 && Math.abs(active.finalOffsetMm.y) < 1e-12,
  "C2i 偏移方向沿火箭→星星（此例为 +x）",
);

// ── C3 拉拽量随距离单调不减，零距离为 0 ───────────────────────────────
console.log("\n## C3 朝目标时拉拽量随距离单调不减（0→2.4° 严格递增，之后饱和）");
// 扫描到 6.45° 而不是名义 6.5°：degToMm(6.5)→mmToDeg 的浮点往返是 6.500000000000001°，
// 会被 magnetPull 里 `gapDeg > 6.5` 的严格门限判成 out-of-range。这是 1e-15 量级的边界舍入，
// 不影响实际手感；这里避免让扫描终点撞上这个舍入，单独在 NOTE 里说明。
const gaps = [0];
for (let g = 0.05; g <= 6.45 + 1e-9; g += 0.05) gaps.push(Math.round(g * 100) / 100);
const pulls = gaps.map((g) => convergedPullDeg(g));

check(pulls[0] === 0, "C3a 距离为 0（火箭与星星重合）时拉拽量严格为 0", `0°→${pulls[0]}`);

let c3Mono = true;
let c3Worst = "";
for (let i = 1; i < gaps.length; i++) {
  if (!(pulls[i] >= pulls[i - 1] - EPS)) {
    c3Mono = false;
    if (!c3Worst) c3Worst = `gap ${gaps[i - 1]}°→${gaps[i]}°: ${pulls[i - 1]}→${pulls[i]}`;
  }
}
check(c3Mono, "C3b 拉拽量随距离单调不减（覆盖 0–6.45°，即 6.5° 作用半径内）", c3Worst);

let c3Strict = true;
let c3StrictWorst = "";
for (let i = 1; i < gaps.length && gaps[i] <= 2.35 + 1e-9; i++) {
  if (!(pulls[i] > pulls[i - 1] + 1e-9)) {
    c3Strict = false;
    if (!c3StrictWorst) c3StrictWorst = `gap ${gaps[i - 1]}°→${gaps[i]}°: ${pulls[i - 1]}→${pulls[i]}`;
  }
}
check(
  c3Strict,
  "C3c 未饱和区（0 < 距离 ≤2.35°）严格递增",
  c3StrictWorst,
);

let c3Sat = true;
for (let i = 0; i < gaps.length; i++) {
  if (gaps[i] >= 2.45 - 1e-9 && Math.abs(pulls[i] - MAGNET_MAX_OFFSET_DEG) > 1e-6) {
    c3Sat = false;
  }
}
check(
  c3Sat,
  `C3d 距离 ≥2.45° 后饱和在 ${MAGNET_MAX_OFFSET_DEG}°（有界，不是越大越吸）`,
  `pull(6.45°)=${pulls[pulls.length - 1].toFixed(9)}°`,
);
note(
  "C3 扫描上限取 6.45°：名义 6.5° 经 degToMm→mmToDeg 往返为 6.500000000000001°，" +
    "会被 `gapDeg > 6.5` 的严格门限判为 out-of-range。1e-15 量级的边界舍入，不影响手感，但边界测试不能写 6.5。",
);

let c3NoOvershoot = true;
for (let i = 0; i < gaps.length; i++) {
  if (gaps[i] > 0 && pulls[i] > gaps[i] + EPS) c3NoOvershoot = false;
}
check(c3NoOvershoot, "C3e 拉拽量从不超过剩余距离（不会越过星星）");

// ── C4 任意输入下控制输出有限 ─────────────────────────────────────────
console.log("\n## C4 任意输入（NaN / ±Infinity / 零距离 / 零 gap）下输出有限");
const finiteCoords = [
  0,
  1e-12,
  -1e-12,
  1,
  -1,
  100,
  -100,
  degToMm(3, D),
  -degToMm(3, D),
  degToMm(6.4, D),
  -degToMm(6.4, D),
  1e6,
  -1e6,
  1e9,
  -1e9,
];
const specialCoords = [NaN, Infinity, -Infinity];
const finiteVels = [0, 1e-12, -1e-12, 1, -1, 1e3, -1e3, 1e6, -1e6];
const specialVels = [NaN, Infinity, -Infinity];
const finiteDists = [D, 0, -D, 1e-9, -1e-9, 1e9];
const specialDists = [NaN, Infinity, -Infinity];
const dts = [16.7, 0, -5, 33, NaN, Infinity];

let seed = 20261105;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

let c4FiniteAll = true;
let c4FiniteWorst = "";
let c4SpecialOffset = true;
let c4SpecialWorst = "";
let c4SpecialGapNaN = 0;
let c4Cases = 0;

for (let i = 0; i < 25000; i++) {
  const finite = i < 20000;
  const rocket = {
    x: finite ? pick(finiteCoords) : pick(specialCoords),
    y: finite ? pick(finiteCoords) : pick(specialCoords),
  };
  const star = {
    x: finite ? pick(finiteCoords) : pick(specialCoords),
    y: finite ? pick(finiteCoords) : pick(specialCoords),
  };
  const vel = {
    x: finite ? pick(finiteVels) : pick(specialVels),
    y: finite ? pick(finiteVels) : pick(specialVels),
  };
  const dist = finite ? pick(finiteDists) : pick(specialDists);
  const dt = pick(dts);
  c4Cases++;
  let r;
  try {
    r = magnetPull(rocket, star, vel, dist, { currentOffsetMm: { x: 0, y: 0 }, dtMs: dt });
  } catch (e) {
    c4FiniteAll = false;
    c4SpecialOffset = false;
    if (!c4FiniteWorst) c4FiniteWorst = `抛异常: ${String(e)}`;
    continue;
  }
  const offFinite =
    Number.isFinite(r.offsetMm.x) && Number.isFinite(r.offsetMm.y) && Number.isFinite(r.strength);
  if (!offFinite) {
    if (finite) {
      c4FiniteAll = false;
      if (!c4FiniteWorst) {
        c4FiniteWorst = `rocket=${JSON.stringify(rocket)} star=${JSON.stringify(star)} vel=${JSON.stringify(vel)} dist=${dist} dt=${dt} -> ${JSON.stringify(r)}`;
      }
    } else {
      c4SpecialOffset = false;
      if (!c4SpecialWorst) {
        c4SpecialWorst = `rocket=${JSON.stringify(rocket)} star=${JSON.stringify(star)} vel=${JSON.stringify(vel)} dist=${dist} dt=${dt} -> ${JSON.stringify(r)}`;
      }
    }
  }
  if (finite && (!Number.isFinite(r.gapDeg) || !Number.isFinite(r.towardDegPerS))) {
    c4FiniteAll = false;
    if (!c4FiniteWorst) {
      c4FiniteWorst = `有限输入出现非有限诊断量: gap=${r.gapDeg} toward=${r.towardDegPerS}`;
    }
  }
  if (!Number.isFinite(r.gapDeg)) c4SpecialGapNaN++;
}

check(c4FiniteAll, `C4a 有限输入（${20000} 组，含 ±1e9mm / 1e6mm/s / 距离 0）所有输出字段有限`, c4FiniteWorst);
check(
  c4SpecialOffset,
  "C4b NaN/±Infinity 坐标、速度、距离下 offsetMm 与 strength 仍有限",
  c4SpecialWorst,
);
if (c4SpecialGapNaN > 0) {
  note(
    `C4 随机样本中有 ${c4SpecialGapNaN} 例 gapDeg=NaN（输入坐标本身是 NaN，角距离数学上无定义）。` +
      "该字段只用于诊断，不进入控制链；offsetMm 仍有限。有限输入下 gapDeg 恒有限。",
  );
}

const zeroGapCases = [
  { name: "火箭=星星=(0,0)", rocket: { x: 0, y: 0 }, star: { x: 0, y: 0 }, dist: D },
  { name: "火箭=星星=(5,5)mm", rocket: { x: 5, y: 5 }, star: { x: 5, y: 5 }, dist: D },
  {
    name: "distanceMm=0（零距离平方）",
    rocket: { x: 0, y: 0 },
    star: { x: degToMm(3, D), y: 0 },
    dist: 0,
  },
  {
    name: "distanceMm=NaN",
    rocket: { x: 0, y: 0 },
    star: { x: degToMm(3, D), y: 0 },
    dist: NaN,
  },
];
let c4Zero = true;
let c4ZeroWorst = "";
for (const c of zeroGapCases) {
  const r = magnetPull(c.rocket, c.star, { x: degToMm(10, D), y: 0 }, c.dist, {
    currentOffsetMm: { x: 0, y: 0 },
    dtMs: 16.7,
  });
  const ok =
    Number.isFinite(r.offsetMm.x) &&
    Number.isFinite(r.offsetMm.y) &&
    Number.isFinite(r.strength) &&
    r.offsetMm.x === 0 &&
    r.offsetMm.y === 0;
  if (!ok) {
    c4Zero = false;
    if (!c4ZeroWorst) c4ZeroWorst = `${c.name} -> ${JSON.stringify(r)}`;
  }
}
check(c4Zero, "C4c 零 gap / 零距离 / 非数值距离：位移严格为 0 且有限", c4ZeroWorst);

let c4Dt = true;
let c4DtWorst = "";
for (const dt of dts) {
  const r = magnetPull(ZERO, star3, { x: degToMm(10, D), y: 0 }, D, {
    currentOffsetMm: { x: 0, y: 0 },
    dtMs: dt,
  });
  const mag = mmToDeg(Math.hypot(r.offsetMm.x, r.offsetMm.y), D);
  if (
    !Number.isFinite(r.offsetMm.x) ||
    !Number.isFinite(r.offsetMm.y) ||
    !Number.isFinite(mag) ||
    mag > MAGNET_MAX_OFFSET_DEG + EPS
  ) {
    c4Dt = false;
    if (!c4DtWorst) c4DtWorst = `dtMs=${dt} -> ${JSON.stringify(r)}`;
  }
}
check(c4Dt, "C4d dtMs 为 0/负/NaN/Infinity 时位移仍有限且不超 0.6°", c4DtWorst);

let cur = { x: 0, y: 0 };
let c4LoopFinite = true;
let c4LoopMaxOff = 0;
let c4LoopMaxPullStep = 0;
let c4LoopMaxReleaseStep = 0;
let c4LoopWorst = "";
for (let i = 0; i < 10000; i++) {
  const rocket = { x: (rnd() - 0.5) * 120, y: (rnd() - 0.5) * 120 };
  const star = { x: (rnd() - 0.5) * 120, y: (rnd() - 0.5) * 120 };
  const vel = { x: (rnd() - 0.5) * 4000, y: (rnd() - 0.5) * 4000 };
  const r = magnetPull(rocket, star, vel, D, {
    currentOffsetMm: cur,
    dtMs: 8 + rnd() * 32,
  });
  if (
    !Number.isFinite(r.offsetMm.x) ||
    !Number.isFinite(r.offsetMm.y) ||
    !Number.isFinite(r.strength) ||
    !Number.isFinite(r.gapDeg) ||
    !Number.isFinite(r.towardDegPerS)
  ) {
    c4LoopFinite = false;
    if (!c4LoopWorst) c4LoopWorst = `iter=${i} -> ${JSON.stringify(r)}`;
    break;
  }
  const offDeg = mmToDeg(Math.hypot(r.offsetMm.x, r.offsetMm.y), D);
  const stepDeg = mmToDeg(Math.hypot(r.offsetMm.x - cur.x, r.offsetMm.y - cur.y), D);
  c4LoopMaxOff = Math.max(c4LoopMaxOff, offDeg);
  if (r.active) {
    c4LoopMaxPullStep = Math.max(c4LoopMaxPullStep, stepDeg);
  } else {
    c4LoopMaxReleaseStep = Math.max(c4LoopMaxReleaseStep, stepDeg);
  }
  cur = r.offsetMm;
}
check(c4LoopFinite, "C4e 10000 帧有限输入 + 偏移回灌：输出全程有限", c4LoopWorst);
check(
  c4LoopMaxOff <= MAGNET_MAX_OFFSET_DEG + EPS,
  "C4f 10000 帧抖动/换向后总偏移始终 ≤0.6°（位置量，无棘轮累积）",
  `max=${c4LoopMaxOff.toFixed(9)}°`,
);
check(
  c4LoopMaxPullStep <= MAGNET_STEP_HARD_CAP_DEG + EPS,
  "C4g 生效中的单帧拉拽量始终 ≤0.2° 硬顶（A3）",
  `maxPullStep=${c4LoopMaxPullStep.toFixed(9)}°`,
);
check(
  c4LoopMaxReleaseStep <= MAGNET_STEP_HARD_CAP_DEG + EPS,
  "C4h 条件失效后的回退单帧也 ≤0.2° 硬顶（t4-F8：拉入与释放同一上限）",
  `maxReleaseStep=${c4LoopMaxReleaseStep.toFixed(9)}°`,
);

// ── 补充：robustZero / lockLevel / 静态检查 ───────────────────────────
console.log("\n## C5 补充：robustZero（P1 鲁棒零位）");
function noise(ampDeg: number): number {
  return (rnd() * 2 - 1) * ampDeg;
}
function makePt(dxDeg: number, dyDeg: number) {
  return { x: degToMm(dxDeg, D), y: degToMm(dyDeg, D) };
}
const mix = [];
for (let i = 0; i < 70; i++) mix.push(makePt(0.1 + noise(0.25), -0.2 + noise(0.25)));
for (let i = 0; i < 30; i++) mix.push(makePt(5.1 + noise(0.1), -0.2 + noise(0.1)));
const rz = robustZero(mix, D);
check(
  rz.ok && rz.n === 100 && rz.kept >= 70 && rz.madDeg <= ANCHOR_MAD_MAX_DEG,
  `C5a 30% 离群样本下仍提交，且剔除离群（n=100, kept≥70, MAD≤${ANCHOR_MAD_MAX_DEG}°）`,
  `ok=${rz.ok} kept=${rz.kept} mad=${rz.madDeg.toFixed(4)}°`,
);
check(
  Math.abs(mmToDeg(rz.x, D) - 0.1) < 0.2 && Math.abs(mmToDeg(rz.y, D) + 0.2) < 0.2,
  "C5b 30% 离群下零位偏差 <0.2°（旧均值会被拽偏）",
  `est=(${mmToDeg(rz.x, D).toFixed(4)}, ${mmToDeg(rz.y, D).toFixed(4)})° 真值=(0.1, -0.2)°`,
);
const clean30 = [];
for (let i = 0; i < 30; i++) clean30.push(makePt(noise(0.4), noise(0.4)));
check(robustZero(clean30, D).ok, `C5c 30 个安静样本（n≥30, MAD≤${ANCHOR_MAD_MAX_DEG}°）应提交`);
const few = [];
for (let i = 0; i < 29; i++) few.push(makePt(noise(0.2), noise(0.2)));
check(!robustZero(few, D).ok, "C5d 29 个样本（<30）不提交，保留旧零位");
// t4-F6 之后 MAD 门限按实测噪声从 1.2° 抬到 2.5°：±3° 的均匀抖动（σ≈1.7°/轴）
// 属于"真实但可接受"的量级，应该提交；真正"在打晃"的是 ±8° 这一档。
const jitter = [];
for (let i = 0; i < 30; i++) jitter.push(makePt(noise(8), noise(8)));
check(!robustZero(jitter, D).ok, "C5e ±8° 乱看（MAD 远超门限）不提交");
check(!robustZero([], D).ok, "C5f 空样本返回 ok=false");

// t4-F6：真实量级的帧间抖动是 σ≈1.5°（旧门限 1.2° 下提交率为 0）。
// 用 Box-Muller 生成二维高斯，验证"真实噪声下能提交、且零位不被拉偏"。
function gauss(sigmaDeg: number): number {
  const u = Math.max(1e-12, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigmaDeg;
}
const realNoise = [];
for (let i = 0; i < 90; i++) realNoise.push(makePt(0.4 + gauss(1.5), -0.6 + gauss(1.5)));
const rn = robustZero(realNoise, D);
check(
  rn.ok && rn.kept >= 45 && rn.madDeg <= ANCHOR_MAD_MAX_DEG,
  `C5g σ=1.5° 真实抖动（90 样本）→ 提交，且 kept≥45（t4-F6 的复现场景）`,
  `ok=${rn.ok} kept=${rn.kept} mad=${rn.madDeg.toFixed(3)}° trim=${rn.trimDeg.toFixed(3)}°`,
);
check(
  Math.abs(mmToDeg(rn.x, D) - 0.4) < 0.4 && Math.abs(mmToDeg(rn.y, D) + 0.6) < 0.4,
  "C5h σ=1.5° 下零位估计仍无偏（误差 <0.4°）",
  `est=(${mmToDeg(rn.x, D).toFixed(3)}, ${mmToDeg(rn.y, D).toFixed(3)})° 真值=(0.4, -0.6)°`,
);
// 更吵（σ=3°）时默认门控应先拒绝；连续不达标后由调用方降级（ANCHOR_RELAX_FACTOR）
const noisy = [];
for (let i = 0; i < 90; i++) noisy.push(makePt(0.4 + gauss(3), -0.6 + gauss(3)));
const noisyStrict = robustZero(noisy, D);
check(
  !noisyStrict.ok,
  "C5i σ=3°（在打晃）默认门控拒绝 → 保留旧零位",
  `ok=${noisyStrict.ok} mad=${noisyStrict.madDeg.toFixed(3)}°`,
);
const noisyRelaxed = robustZero(noisy, D, {
  madMaxDeg: ANCHOR_MAD_MAX_DEG * ANCHOR_RELAX_FACTOR,
  relaxed: true,
});
check(
  noisyRelaxed.ok && noisyRelaxed.relaxed && noisyRelaxed.madMaxDeg > ANCHOR_MAD_MAX_DEG,
  "C5j σ=3° 连续不达标后的降级门控可以提交，并带 relaxed 标记与所用门限",
  `ok=${noisyRelaxed.ok} madMax=${noisyRelaxed.madMaxDeg.toFixed(2)}°`,
);

console.log("\n## C6 补充：lockLevel（锁定反馈，只影响观感）");
check(
  lockLevel(0, 4) === 1 && lockLevel(100, 4) === 0,
  "C6a 捕获半径内=1，远处=0",
  `0°→${lockLevel(0, 4)}, 100°→${lockLevel(100, 4)}`,
);
check(
  lockLevel(NaN, 4) === 0 && lockLevel(3, 0) === 0,
  "C6b 非有限 gap / 非正 captureDeg 返回 0",
);
let c6Mono = true;
let c6Prev = 2;
for (let g = 0; g <= 12 + 1e-9; g += 0.1) {
  const v = lockLevel(g, 4);
  if (!Number.isFinite(v) || v < -EPS || v > 1 + EPS || !(v <= c6Prev + EPS)) c6Mono = false;
  c6Prev = v;
}
check(c6Mono, "C6c 随 gap 单调不增且恒在 [0,1]");
check(
  lockLevel(6, 4, 1) >= lockLevel(6, 4, 0) && lockLevel(6, 4, 1) <= 1,
  "C6d 磁吸生效时锁定反馈只增不减，且不越界",
);

console.log("\n## C7 补充：A1 静态检查（无 DOM / 无时钟 / 无随机）");
const assistPath = new URL("../src/game/assist.ts", import.meta.url);
check(existsSync(assistPath), "C7a src/game/assist.ts 存在");
let src = "";
try {
  src = readFileSync(assistPath, "utf8");
} catch (e) {
  src = "";
  note(`读取 assist.ts 失败: ${String(e)}`);
}
const domRe = /\b(window|document|canvas|HTMLElement|navigator|localStorage|sessionStorage|requestAnimationFrame)\b/;
check(src.length > 0 && !domRe.test(src), "C7b assist.ts 不含 DOM/浏览器全局引用");
const importLines = src
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => /^import\b/.test(l));
check(
  importLines.length === 1 && /^import\s+type\b/.test(importLines[0]),
  "C7c 唯一 import 是 type-only（运行时零依赖，可被 Node 直接加载）",
  importLines.join(" | "),
);
check(
  !/Math\.random|Date\.now|performance\.now/.test(src),
  "C7d 无随机数 / 时钟读取（纯函数，可回放）",
);

console.log("\n## C8 B5：assistCaptureRadiusDeg 对 NaN/±Infinity 仍返回有限半径");
{
  const specials = [NaN, Infinity, -Infinity];
  let c8Finite = true;
  let c8Same = true;
  let c8Worst = "";
  for (const toward of specials) {
    for (const s of [0, 5, 20, 60]) {
      const r = assistCaptureRadiusDeg(s, toward, [2.5, 2.6]);
      if (!Number.isFinite(r) || r < CAPTURE_FLOOR_DEG - EPS || r > CAPTURE_ABS_MAX_DEG + EPS) {
        c8Finite = false;
        if (!c8Worst) c8Worst = `toward=${toward} score=${s} -> ${r}`;
      }
      // 非有限速度 = 不知道趋势 → 必须等价于"趋势为 0"（不含放大），而不是 0 或 NaN
      const zeroTrend = assistCaptureRadiusDeg(s, 0, [2.5, 2.6]);
      if (Math.abs(r - zeroTrend) > 1e-9) {
        c8Same = false;
        if (!c8Worst) c8Worst = `toward=${toward} score=${s}: ${r} != 趋势0时的 ${zeroTrend}`;
      }
    }
  }
  check(c8Finite, "C8a toward∈{NaN,±Infinity} 时半径有限且仍在 [4,6] 度", c8Worst);
  check(c8Same, "C8b 非有限 toward 退化成不含趋势放大的基础半径（不是 0，也不是 NaN）");
  // "捕获不因此失效"：半径正常时，距离 3.5° 必须判中，距离 6.5° 必须判不中
  const captureDeg = assistCaptureRadiusDeg(3, NaN, []);
  check(
    Number.isFinite(captureDeg) && degToMm(3.5, D) <= degToMm(captureDeg, D) && !(degToMm(6.5, D) <= degToMm(captureDeg, D)),
    "C8c toward=NaN 时捕获判定仍正常（3.5° 判中、6.5° 判不中）",
    `captureDeg=${captureDeg}°`,
  );
}

console.log("\n## C9 B2：撒点离火箭/瞄准点 ≥ 捕获半径(最大) + 1°");
{
  // 复刻 gazeGame.spawn 的盒子与换算（1442×901 CSS、mmPerPx 由 1°=37.4px/8.727mm 推得）
  const W_PX = 1442;
  const H_PX = 901;
  const MM_PER_PX = degToMm(1, D) / 37.4; // ≈0.2333
  const boxOf = (score: number, errs: number[]) => {
    const halfH = degToMm(7, D) / (W_PX * MM_PER_PX);
    const halfV = degToMm(5, D) / (H_PX * MM_PER_PX);
    return { x0: Math.max(0.05, 0.5 - halfH), x1: Math.min(0.95, 0.5 + halfH), y0: Math.max(0.05, 0.5 - halfV), y1: Math.min(0.95, 0.5 + halfV) };
  };
  let seedC9 = 987654321;
  const rndC9 = () => {
    seedC9 = (seedC9 * 1664525 + 1013904223) >>> 0;
    return seedC9 / 4294967296;
  };
  const toMm = (nm) => ({ x: (nm.x - 0.5) * W_PX * MM_PER_PX, y: (nm.y - 0.5) * H_PX * MM_PER_PX });

  let c9Ok = true;
  let c9Worst = "";
  let c9AimOk = true;
  let c9AimWorst = "";
  let c9Relaxed = 0;
  let c9Cases = 0;
  for (const score of [0, 5, 12, 20, 40]) {
    for (const errs of [[], [2.5, 2.6, 2.4], [4.5, 4.6]]) {
      const box = boxOf(score, errs);
      const minMm = degToMm(maxCaptureRadiusDeg(score, errs) + STAR_SPAWN_MARGIN_DEG, D);
      for (let i = 0; i < 120; i++) {
        // 真实场景：火箭在盒内，瞄准点与火箭相距 ≤2°（正常跟随误差）
        const rocket = {
          x: (rndC9() - 0.5) * 2 * degToMm(6, D),
          y: (rndC9() - 0.5) * 2 * degToMm(4, D),
        };
        const aim = {
          x: rocket.x + (rndC9() - 0.5) * 2 * degToMm(2, D),
          y: rocket.y + (rndC9() - 0.5) * 2 * degToMm(2, D),
        };
        const prev = { x: 0.5 + (rndC9() - 0.5) * 0.2, y: 0.5 + (rndC9() - 0.5) * 0.2 };
        const pick = pickStarSpawn({
          ...box,
          widthPx: W_PX,
          heightPx: H_PX,
          mmPerPx: MM_PER_PX,
          distanceMm: D,
          avoidMm: [rocket, aim],
          minAvoidMm: minMm,
          fallbackAvoidMm: [aim],
          prevNm: prev,
          prefPrevMm: degToMm(6, D),
          rand: rndC9,
        });
        c9Cases++;
        if (pick.relaxed) c9Relaxed++;
        const starMm = toMm(pick.nm);
        const dRocket = Math.hypot(starMm.x - rocket.x, starMm.y - rocket.y);
        const dAim = Math.hypot(starMm.x - aim.x, starMm.y - aim.y);
        if (!(dRocket >= minMm - 1e-9)) {
          c9Ok = false;
          if (!c9Worst) c9Worst = `score=${score} errs=${JSON.stringify(errs)} d=${mmToDeg(dRocket, D).toFixed(3)}° < ${mmToDeg(minMm, D).toFixed(3)}°`;
        }
        if (!(dAim >= minMm - 1e-9)) {
          c9AimOk = false;
          if (!c9AimWorst) c9AimWorst = `score=${score} dAim=${mmToDeg(dAim, D).toFixed(3)}°`;
        }
      }
    }
  }
  check(c9Ok, `C9a ${c9Cases} 次撒点：星到**火箭**的距离恒 ≥ 捕获半径(最大)+1°`, c9Worst);
  check(c9AimOk, "C9b 星到**瞄准点**的距离恒 ≥ 捕获半径(最大)+1°（兜底约束，防「收敛后自动命中」）", c9AimWorst);
  // 极端几何（火箭与瞄准点相距 6°，盒子里不存在同时离两者 7° 的点）允许 relaxed，
  // 但必须仍然满足"离瞄准点足够远"——那才是"视线停住不会自动命中"的根本约束。
  check(
    c9Relaxed === 0,
    `C9c |火箭-瞄准| ≤2° 的正常跟随范围内不触发降级（relaxed=${c9Relaxed}/${c9Cases}）`,
    c9Relaxed ? `${c9Relaxed} 次 relaxed` : "",
  );
  // 极端情形单测：两约束无解时必须退到"只避开瞄准点"，且 ok=false 如实上报
  const rocketFar = { x: degToMm(3, D), y: 0 };
  const aimFar = { x: degToMm(-3, D), y: 0 };
  const extreme = pickStarSpawn({
    ...boxOf(20, []),
    widthPx: W_PX,
    heightPx: H_PX,
    mmPerPx: MM_PER_PX,
    distanceMm: D,
    avoidMm: [rocketFar, aimFar],
    minAvoidMm: degToMm(7, D),
    fallbackAvoidMm: [aimFar],
    rand: rndC9,
  });
  const exStar = toMm(extreme.nm);
  const exAim = Math.hypot(exStar.x - aimFar.x, exStar.y - aimFar.y);
  check(
    extreme.relaxed &&
      Math.hypot(exStar.x - aimFar.x, exStar.y - aimFar.y) >= degToMm(7, D) - 1e-9 &&
      !extreme.ok,
    "C9d 极端几何（火箭与瞄准点相距 6°）降级时仍满足瞄准点约束，并如实报 ok=false",
    `dAim=${mmToDeg(exAim, D).toFixed(3)}° relaxed=${extreme.relaxed} ok=${extreme.ok}`,
  );
}

console.log("\n## C10 B1：视线固定不动 ≥10 个星星生命周期，自动捕获次数 = 0");
{
  const W_PX = 1442;
  const H_PX = 901;
  const MM_PER_PX = degToMm(1, D) / 37.4;
  const halfH = degToMm(7, D) / (W_PX * MM_PER_PX);
  const halfV = degToMm(5, D) / (H_PX * MM_PER_PX);
  const box = {
    x0: Math.max(0.05, 0.5 - halfH),
    x1: Math.min(0.95, 0.5 + halfH),
    y0: Math.max(0.05, 0.5 - halfV),
    y1: Math.min(0.95, 0.5 + halfV),
  };
  const toMm = (nm) => ({ x: (nm.x - 0.5) * W_PX * MM_PER_PX, y: (nm.y - 0.5) * H_PX * MM_PER_PX });

  // 复刻游戏循环的最小心智模型：
  //  - 视线固定 = 瞄准点固定；火箭以 0.72/帧（60 Hz）收敛过去；
  //  - 捕获半径用 assistCaptureRadiusDeg(score, toward=0)——视线不动，趋势不放宽；
  //  - 捕获还要求"本帧视线有效"，这里恒为真（模拟最坏情况：一切都 valid）。
  const runLifecycle = (gazeDeg, lifecycles, opts) => {
    const gaze = { x: degToMm(gazeDeg.x, D), y: degToMm(gazeDeg.y, D) };
    const rocket = { x: 0, y: 0 };
    let prevNm = null;
    let captures = 0;
    let score = 0;
    const hitErrors = [];
    let seedC10 = 424242;
    const rndC10 = () => {
      seedC10 = (seedC10 * 1664525 + 1013904223) >>> 0;
      return seedC10 / 4294967296;
    };
    const spawn = () => {
      if (opts.randomSpawn) {
        // 对照组：修复前的行为——盒子里随机撒，不避让火箭/视线
        return { nm: { x: box.x0 + rndC10() * (box.x1 - box.x0), y: box.y0 + rndC10() * (box.y1 - box.y0) } };
      }
      return pickStarSpawn({
        ...box,
        widthPx: W_PX,
        heightPx: H_PX,
        mmPerPx: MM_PER_PX,
        distanceMm: D,
        avoidMm: [rocket, gaze],
        minAvoidMm: degToMm(maxCaptureRadiusDeg(score, hitErrors) + STAR_SPAWN_MARGIN_DEG, D),
        fallbackAvoidMm: [gaze],
        prevNm,
        prefPrevMm: degToMm(6, D),
        rand: rndC10,
      });
    };
    for (let life = 0; life < lifecycles; life++) {
      const pick = spawn();
      const star = toMm(pick.nm);
      prevNm = pick.nm;
      let captured = false;
      let dwell: number | null = null;
      // 6 s 生命周期 = 360 帧 @60 Hz
      for (let f = 0; f < 360; f++) {
        const k = 1 - Math.pow(0.72, 1);
        rocket.x += (gaze.x - rocket.x) * k;
        rocket.y += (gaze.y - rocket.y) * k;
        // t6-R1：判定基于瞄准点（视线固定 → aim = gaze），不是火箭。
        // 视线固定 → 朝星星的速度 = 0 → 趋势门控不放大（正常情形）。
        // worstCase 模式：假设趋势**每帧都拉满**，并且磁吸吃满 0.6°——
        // 这是"固定视线 + 噪声导致趋势/磁吸偶发触发"的保守上界。
        const captureDeg = opts.worstCase
          ? maxCaptureRadiusDeg(score, hitErrors)
          : assistCaptureRadiusDeg(score, 0, hitErrors);
        const aimedDeg = aimedDistanceDeg(gaze, star, D);
        const dEff = opts.worstCase ? Math.max(0, aimedDeg - MAGNET_MAX_OFFSET_DEG) : aimedDeg;
        const tMs = f * 16.7;
        dwell = stepCaptureDwell(dwell, dEff <= captureDeg, tMs);
        if (dwellSatisfied(dwell, tMs)) {
          captures++;
          hitErrors.push(dEff);
          score++;
          captured = true;
          break;
        }
      }
      if (!captured) {
        // 过期重撒：继续下一个生命周期（和游戏里一样，用当前瞄准点作为约束点）
      }
    }
    return captures;
  };

  const gazes = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: -4, y: 2 },
    { x: 6, y: 0 },
    { x: 0, y: -4 },
    { x: 2.5, y: -3 },
  ];
  let c10Total = 0;
  let c10Worst = "";
  for (const g of gazes) {
    const n = runLifecycle(g, 12, {});
    c10Total += n;
    if (n > 0 && !c10Worst) c10Worst = `gaze=(${g.x},${g.y})° 自动命中 ${n} 次`;
  }
  check(
    c10Total === 0,
    `C10a 6 个固定视线位置 × 12 个生命周期（共 72 个）：自动捕获 ${c10Total} 次（必须 0）`,
    c10Worst,
  );
  // 对照组：同样的模拟，但撒点退回"盒子里随机"（修复前的行为），必须能复现自动命中，
  // 否则说明这个模拟根本没有牙齿、C10a 的 0 不能说明问题。
  const control = runLifecycle({ x: 0, y: 0 }, 12, { randomSpawn: true });
  check(control > 0, `C10b 对照组（随机撒点 = 修复前行为）在同一模型下命中 ${control} 次 > 0（证明模拟有效）`);

  // 最坏情况上界：趋势放大每帧都拉满（6.0°）+ 磁吸吃满 0.6°。
  // 撒点时留的是 maxCapture + 1° = 7.0°，所以 7.0 − 0.6 = 6.4 > 6.0，仍然打不中。
  let c10WorstTotal = 0;
  let c10WorstDetail = "";
  for (const g of gazes) {
    const n = runLifecycle(g, 12, { worstCase: true });
    c10WorstTotal += n;
    if (n > 0 && !c10WorstDetail) c10WorstDetail = `gaze=(${g.x},${g.y})° → ${n} 次`;
  }
  check(
    c10WorstTotal === 0,
    `C10c 最坏情况（趋势拉满 + 磁吸 0.6°）固定视线 72 个生命周期仍 0 次自动捕获`,
    c10WorstDetail,
  );
}

console.log("\n## C11 静态结构检查（B3/B4 落在有 DOM 的 gazeGame 里，这里做结构证据）");
{
  const gamePath = new URL("../src/game/gazeGame.ts", import.meta.url);
  let gameSrc = "";
  try {
    gameSrc = readFileSync(gamePath, "utf8");
  } catch (e) {
    note(`读取 gazeGame.ts 失败: ${String(e)}`);
  }
  check(
    /gazeOk\s*&&\s*hasEverValid/.test(gameSrc),
    "C11a 捕获判定显式要求有效视线（gazeOk && hasEverValid，B3）",
  );
  check(
    /filter\.reset\(\);\s*\n\s*\/\/[^\n]*\n\s*filter\.updateNew\(stationMm\.x, stationMm\.y, now\)/.test(gameSrc) ||
      /filter\.updateNew\(stationMm\.x, stationMm\.y, now\)/.test(gameSrc),
    "C11b 加油结算后用加油站播种滤波器（B4/F5）",
  );
  check(
    /pickStarSpawn\(/.test(gameSrc) && /maxCaptureRadiusDeg\(score, hitErrors\)\s*\+\s*STAR_SPAWN_MARGIN_DEG/.test(gameSrc),
    "C11c 撒点走 pickStarSpawn，且最小距离 = 捕获半径(最大) + 1°（B2）",
  );
}

console.log("\n## C12 t6-R1：判定基于瞄准点（aim），火箭只是视觉载体");
{
  /**
   * 游戏循环回放（只含与判定有关的部分，全部用产品代码里的同一批纯函数）：
   *   gaze(t)（度）→ 磁吸（门控与偏移都作用于 aim）→ 本帧捕获半径
   *   → aim 到星星的距离 → 60 ms 停留门控 → 命中。
   * 火箭照常以 0.72/帧 跟随 aim（视觉载体），但**不参与判定**。
   * 返回的 minRocketDeg 用来证明"火箭确实穿过了捕获圈"——旧判定会在这里误命中。
   */
  const replay = (o) => {
    const star = { x: degToMm(o.starDeg.x, D), y: degToMm(o.starDeg.y, D) };
    const rocket = { x: degToMm(o.rocketStartDeg.x, D), y: degToMm(o.rocketStartDeg.y, D) };
    const score = o.score ?? 0;
    const hitErrors = o.hitErrors ?? [];
    const frame = 16.7;
    let mag = { x: 0, y: 0 };
    let dwell = null;
    let captures = 0;
    let captureAt = -1;
    let minRocketDeg = Infinity;
    let minAimDeg = Infinity;
    for (let t = 0; t <= o.durationMs; t += frame) {
      const g = o.gazeAt(t);
      const gPrev = o.gazeAt(t - 33.3);
      const gMm = { x: degToMm(g.x, D), y: degToMm(g.y, D) };
      const vel = {
        x: degToMm(g.x - gPrev.x, D) / 0.0333,
        y: degToMm(g.y - gPrev.y, D) / 0.0333,
      };
      const m = magnetPull(gMm, star, vel, D, { currentOffsetMm: mag, dtMs: frame });
      mag = m.offsetMm;
      const aim = { x: gMm.x + mag.x, y: gMm.y + mag.y };
      const toward = mmToDeg(towardSpeedMmS(vel, { x: star.x - aim.x, y: star.y - aim.y }), D);
      const captureDeg = assistCaptureRadiusDeg(score, toward, hitErrors);
      const distDeg = aimedDistanceDeg(aim, star, D);
      dwell = stepCaptureDwell(dwell, distDeg <= captureDeg, t);
      const k = 1 - Math.pow(0.72, 1);
      rocket.x += (aim.x - rocket.x) * k;
      rocket.y += (aim.y - rocket.y) * k;
      minRocketDeg = Math.min(
        minRocketDeg,
        mmToDeg(Math.hypot(rocket.x - star.x, rocket.y - star.y), D),
      );
      minAimDeg = Math.min(minAimDeg, distDeg);
      if (dwellSatisfied(dwell, t)) {
        captures++;
        captureAt = t;
        break;
      }
    }
    return { captures, captureAt, minRocketDeg, minAimDeg };
  };

  // ── C12a：t6 的 R1 反例，原样复现 ──
  // 火箭 -7°、瞄准点 +7°、星星 (0°,5°)。旧判定（|火箭-星星| ≤ 5.5°）会在第 2 帧命中。
  const r1 = replay({
    starDeg: { x: 0, y: 5 },
    gazeAt: () => ({ x: 7, y: 0 }),
    rocketStartDeg: { x: -7, y: 0 },
    durationMs: 3000,
  });
  check(
    r1.minRocketDeg <= 5.5,
    "C12a-1 复现前提：火箭从 -7° 飞向 +7° 时确实进入过捕获圈（旧判定会误命中）",
    `火箭离星最近 ${r1.minRocketDeg.toFixed(2)}°`,
  );
  check(
    r1.captures === 0,
    `C12a-2 R1 反例（C1）：视线全程 +7°，捕获 ${r1.captures} 次（必须 0）`,
    `瞄准点离星最近 ${r1.minAimDeg.toFixed(2)}°`,
  );

  // ── C12b：saccade 路径从星星旁边扫过、但终点不在星星上 ──
  const saccade = (t) => {
    const t0 = 100;
    const dur = 100; // 14° / 100 ms = 140°/s
    if (t <= t0) return { x: -7, y: 0 };
    if (t >= t0 + dur) return { x: 7, y: 0 };
    return { x: -7 + (14 * (t - t0)) / dur, y: 0 };
  };
  const pass = replay({
    starDeg: { x: 0, y: 5 },
    gazeAt: saccade,
    rocketStartDeg: { x: -7, y: 0 },
    durationMs: 3000,
  });
  check(
    pass.minAimDeg <= 5.5,
    "C12b-1 复现前提：视线路径确实掠过了星星的捕获圈（最近距离 ≤5.5°）",
    `瞄准点离星最近 ${pass.minAimDeg.toFixed(2)}°`,
  );
  check(
    pass.captures === 0,
    `C12b-2 saccade 掠过星星但不停止：捕获 ${pass.captures} 次（必须 0，C3 的语义）`,
  );

  // ── C12c：视线上限——瞄准点停在撒点最小距离（7.0°）上不动 ──
  // 这是"不看不吸"的边界：撒点保证星星出现在 ≥maxCapture+1° = 7.0° 处，
  // 而趋势放大(≤6.0°)+磁吸(≤0.6°)=6.6° 的极限射程也够不到 7.0°。
  const boundary = replay({
    starDeg: { x: 0, y: 0 },
    gazeAt: () => ({ x: 7, y: 0 }),
    rocketStartDeg: { x: 7, y: 0 },
    durationMs: 4000,
  });
  check(
    boundary.captures === 0,
    "C12c 瞄准点停在 7.0°（撒点最小距离）不动：捕获 0 次（趋势+磁吸的极限射程 6.6° 够不到）",
    `瞄准点离星最近 ${boundary.minAimDeg.toFixed(2)}°`,
  );

  // ── C12d（C2）：视线终点就是星星 → 必须能正常捕获（证明测试没把捕获关死）──
  const arrive = (t) => {
    const t0 = 100;
    const dur = 100;
    if (t <= t0) return { x: -7, y: 0 };
    if (t >= t0 + dur) return { x: 0, y: 0 };
    return { x: -7 + (7 * (t - t0)) / dur, y: 0 };
  };
  const hit = replay({
    starDeg: { x: 0, y: 0 },
    gazeAt: arrive,
    rocketStartDeg: { x: -7, y: 0 },
    durationMs: 3000,
  });
  check(hit.captures === 1, `C12d（C2）视线停在星星上：命中 ${hit.captures} 次（必须 1）`, `在 ${hit.captureAt.toFixed(0)} ms`);
  check(
    hit.captureAt >= 100 + CAPTURE_DWELL_MS - 1e-9,
    `C12e 命中时刻 ≥ 到达时刻 + ${CAPTURE_DWELL_MS} ms 停留门槛`,
    `captureAt=${hit.captureAt.toFixed(0)}ms`,
  );

  // ── C12f：磁吸的极限射程核算 ──
  // 撒点最小距离 7.0° − 磁吸 0.6° = 6.4° > 趋势拉满的 6.0° → 不在圈内。
  check(
    7.0 - MAGNET_MAX_OFFSET_DEG > 6.0,
    "C12f 边界核算：撒点 7.0° − 磁吸 0.6° = 6.4° > 趋势拉满 6.0°（0.4° 余量）",
    `${(7.0 - MAGNET_MAX_OFFSET_DEG).toFixed(2)}° > 6.00°`,
  );
}

console.log("\n## C13 C3 语义：快速扫过不算命中，停留 ≥60 ms 才算");
{
  const replayPass = (crossMs) => {
    // 视线从 (0,-7°) 匀速穿过星星 (0,0) 到 (0,+7°)，再停住（终点不在星星上）。
    const star = { x: 0, y: 0 };
    let dwell = null;
    let captures = 0;
    const frame = 16.7;
    const t0 = 100;
    for (let t = 0; t <= 4000; t += frame) {
      let y;
      if (t <= t0) y = -7;
      else if (t >= t0 + crossMs) y = 7;
      else y = -7 + (14 * (t - t0)) / crossMs;
      const aim = { x: degToMm(0, D), y: degToMm(y, D) };
      const starMm = { x: degToMm(star.x, D), y: degToMm(star.y, D) };
      const distDeg = aimedDistanceDeg(aim, starMm, D);
      // 以 300°/s 穿过时的"朝星星"速度足够大，趋势放大最多到 6.0°（不额外放宽判定）
      const toward = (14 / crossMs) * 1000 * Math.sign(-y || 1);
      const captureDeg = assistCaptureRadiusDeg(0, toward, []);
      dwell = stepCaptureDwell(dwell, distDeg <= captureDeg, t);
      if (dwellSatisfied(dwell, t)) {
        captures++;
        break;
      }
    }
    return captures;
  };
  // 35 ms 穿过 14° ≈ 400°/s（真实 saccade 量级）：在 5.5° 圈内只待约 27 ms < 60 ms
  check(replayPass(35) === 0, "C13a 快速扫过（约 400°/s，圈内 ~27 ms）：不判定命中（C3）");
  // 300 ms 穿过 14° ≈ 47°/s：圈内约 236 ms ≥ 60 ms → 判定命中
  check(replayPass(300) === 1, "C13b 慢速扫过（约 47°/s，圈内约 236 ms）：判定命中（与\"看住\"等价）");
}

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log("\n== 汇总 ==");
console.log(`通过 ${passed} 条，失败 ${failures.length} 条。`);
if (notes.length) {
  console.log("观察（不影响判定）：");
  for (const n of notes) console.log(` - ${n}`);
}
if (failures.length) {
  console.log("失败列表：");
  for (const f of failures) console.log(` - ${f}`);
  console.log("RESULT: FAIL");
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
  process.exitCode = 0;
}
