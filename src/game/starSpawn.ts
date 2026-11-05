/**
 * 星星撒点（t5/B2）：纯几何 + 注入随机源，不碰 DOM、不读时钟。
 *
 * 为什么单独抽出来：t4 的 blocker 是"星星可能刚好撒在火箭/视线上，孩子眼睛都没动就得分"。
 * 要让"任何星星在 spawn 时刻离火箭 ≥ 捕获半径 + 1°"这件事可被离线断言，撒点逻辑就不能
 * 埋在 GazeGame 的私有方法里（那个类拿不到 DOM 跑不起来）。这里只做几何，随机源由调用方
 * 传入（生产用 Math.random，测试用确定性 PRNG），所以同一输入 + 同一随机序列永远得到同一结果。
 *
 * 坐标系：输入输出都是归一化屏幕坐标（0..1）；距离按 mm 计算，换算口径与
 * gazeGame 的 mmX/mmY 完全一致：(nm - 0.5) × 像素尺寸 × mmPerPx。
 */
import type { Pt } from "../types";

/** 离"必须避开的点"的额外余量（度）。B2 要求 ≥ 捕获半径 + 1°。 */
export const STAR_SPAWN_MARGIN_DEG = 1.0;

export interface StarSpawnOptions {
  /** 归一化撒点边界（0..1），由调用方按 ±7°/±5° 算好 */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 屏幕 CSS 像素尺寸与毫米/像素（只用于把归一化坐标换算成 mm） */
  widthPx: number;
  heightPx: number;
  mmPerPx: number;
  /** 观看距离（mm），只用于把结果距离同时报成角度 */
  distanceMm: number;
  /**
   * 必须避开的点（mm）：火箭当前位置、当前瞄准点（视线）。
   * 省略/空数组 = 不作距离约束（只用于离线对比）。
   */
  avoidMm?: Pt[];
  /** 与每个 avoid 点的最小距离（mm）。通常 = 捕获半径(最大) + 1°。 */
  minAvoidMm?: number;
  /** 上一颗星（归一化），尽量避免连着落在同一处 */
  prevNm?: Pt | null;
  /** 与上一颗星的期望最小距离（mm），默认 6° */
  prefPrevMm?: number;
  /**
   * 兜底约束：当 `avoidMm` 整组在几何上无解时（例如火箭与瞄准点相距 6°，
   * 盒子 ±7°×±5° 里不存在同时离两者 ≥7° 的点），至少要满足这一组。
   * 生产上应放"当前瞄准点（视线）"——因为火箭最终会收敛到它，
   * 只要星星离瞄准点足够远，视线停住时就不会自动命中（B1 的产品不变量）。
   */
  fallbackAvoidMm?: Pt[];
  /** 随机源（返回 0..1）。生产传 Math.random，测试传确定性 PRNG。 */
  rand: () => number;
  /** 随机候选数，默认 24（另有固定的 4 角 + 4 边中点） */
  samples?: number;
}

export interface StarSpawnResult {
  /** 选中的归一化位置 */
  nm: Pt;
  /** 到最近 avoid 点的实际距离（mm）；没有 avoid 点时为 Infinity */
  minAvoidMm: number;
  /** 同上，换算成角度（度） */
  minAvoidDeg: number;
  /** 到上一颗星的距离（mm）；没有上一颗时为 Infinity */
  toPrevMm: number;
  /** 是否满足 `avoidMm` 整组（false = 退到了 fallback 约束，几何上无解）。 */
  ok: boolean;
  /** 是否退到了 fallback 约束。 */
  relaxed: boolean;
}

function distMm(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mmToDegLocal(mm: number, distanceMm: number): number {
  if (!Number.isFinite(mm)) return Number.NaN;
  if (!(distanceMm > 0)) return 0;
  return (Math.atan2(mm, distanceMm) * 180) / Math.PI;
}

/**
 * 从撒点盒子里挑一个位置。
 *
 * 候选集 = 4 个角 + 4 个边中点 + samples 个随机点。
 * 固定角点保证"离 avoid 点足够远"这条约束**一定有解**：盒子是 ±7°×±5°，
 * 从盒内任意一点看，最远的角至少 8.6° 远，而调用方要求的是 ≤ 捕获半径(≤6°) + 1° = 7°。
 * 在这些满足硬约束的候选里，再尽量挑离上一颗星最远的（避免连着重叠）。
 */
export function pickStarSpawn(o: StarSpawnOptions): StarSpawnResult {
  const x0 = Math.min(o.x0, o.x1);
  const x1 = Math.max(o.x0, o.x1);
  const y0 = Math.min(o.y0, o.y1);
  const y1 = Math.max(o.y0, o.y1);
  const samples = Math.max(0, Math.floor(o.samples ?? 24));
  const rand = o.rand;
  const avoid = (o.avoidMm ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const minAvoid = o.minAvoidMm ?? 0;
  const prefPrev = o.prefPrevMm ?? Infinity;

  // 归一化 → 毫米，口径与 gazeGame 的 mmX/mmY 一致
  const toMm = (nm: Pt): Pt => ({
    x: (nm.x - 0.5) * o.widthPx * o.mmPerPx,
    y: (nm.y - 0.5) * o.heightPx * o.mmPerPx,
  });

  const cands: Pt[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: (x0 + x1) / 2, y: y0 },
    { x: (x0 + x1) / 2, y: y1 },
    { x: x0, y: (y0 + y1) / 2 },
    { x: x1, y: (y0 + y1) / 2 },
  ];
  for (let i = 0; i < samples; i++) {
    cands.push({ x: x0 + rand() * (x1 - x0), y: y0 + rand() * (y1 - y0) });
  }
  // 用注入的随机源洗牌：没有"上一颗星"时（开局第一颗），否则 scan 会永远选中
  // 候选表里的第一个角点，导致每局第一颗星都在同一个角落。
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = cands[i];
    cands[i] = cands[j];
    cands[j] = tmp;
  }

  const prevMm = o.prevNm ? toMm(o.prevNm) : null;
  const fallbackAvoid = (o.fallbackAvoidMm ?? []).filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );

  /** 在一组 avoid 点下挑候选：先满足 minAvoid，再优先离上一颗星 ≥ prefPrev，最后取最远。 */
  const scan = (points: Pt[]): Pt | null => {
    let best: Pt | null = null;
    let bestPrevOk = false;
    let bestToPrev = -Infinity;
    for (const nm of cands) {
      const mm = toMm(nm);
      let dAvoid = Infinity;
      for (const a of points) dAvoid = Math.min(dAvoid, distMm(mm, a));
      if (!(dAvoid >= minAvoid)) continue;
      const dPrev = prevMm ? distMm(mm, prevMm) : Infinity;
      const prevOk = dPrev >= prefPrev;
      if (
        best === null ||
        (prevOk && !bestPrevOk) ||
        (prevOk === bestPrevOk && dPrev > bestToPrev)
      ) {
        best = nm;
        bestPrevOk = prevOk;
        bestToPrev = dPrev;
      }
    }
    return best;
  };

  const distTo = (nm: Pt, points: Pt[]): number => {
    const mm = toMm(nm);
    let d = Infinity;
    for (const a of points) d = Math.min(d, distMm(mm, a));
    return d;
  };

  let chosen = scan(avoid);
  let relaxed = false;
  // 整组硬约束无解时，退到 fallback（通常是"当前瞄准点"）：
  // 火箭最终会收敛到瞄准点，所以只要星星离它足够远，视线停住就不会自动命中。
  if (chosen === null && fallbackAvoid.length) {
    chosen = scan(fallbackAvoid);
    relaxed = chosen !== null;
  }
  if (chosen === null) {
    // 连 fallback 都无解：取"离硬约束最远"的候选，并如实报 ok=false。
    let far = -Infinity;
    for (const nm of cands) {
      const d = distTo(nm, avoid.length ? avoid : fallbackAvoid);
      if (d > far) {
        far = d;
        chosen = nm;
      }
    }
    relaxed = true;
  }
  const finalNm = chosen ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const chosenAvoid = distTo(finalNm, avoid);
  const chosenPrev = prevMm ? distMm(toMm(finalNm), prevMm) : Infinity;

  return {
    nm: finalNm,
    minAvoidMm: chosenAvoid,
    minAvoidDeg: mmToDegLocal(chosenAvoid, o.distanceMm),
    toPrevMm: chosenPrev,
    ok: chosenAvoid >= minAvoid,
    relaxed,
  };
}
