/**
 * 眼动指标计算。全部只依赖“预测注视点(毫米) + 目标点(毫米) + 观看距离”，
 * 因此可以离线重算——这是后面接验证台的前提。
 */
import type { Pt } from "../types";

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

/** 棱镜度 ↔ 角度：1 PD = 100cm 处偏移 1cm = atan(0.01) ≈ 0.5729° */
export function degToPd(deg: number): number {
  return 100 * Math.tan(deg * DEG2RAD);
}

export function pdToDeg(pd: number): number {
  return Math.atan(pd / 100) * RAD2DEG;
}

/** 屏幕平面上一点相对眼原点的单位方向向量（屏幕在 z = d 处） */
function unitVec(p: Pt, dMm: number): [number, number, number] {
  const x = p.x;
  const y = p.y;
  const z = Math.max(dMm, 1);
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

/** 两点的视角差（度）。用向量夹角，大角度下比差值近似更准。 */
export function angularErrorDeg(pred: Pt, target: Pt, dMm: number): number {
  const a = unitVec(pred, dMm);
  const b = unitVec(target, dMm);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * RAD2DEG;
}

/**
 * 分解为水平/垂直分量（度，带符号）。
 * 符号约定：正值 = 该眼估计视轴落在目标点的图像右侧 / 下方。
 * 该约定必须用棱镜在验证阶段确认后才能对临床下结论。
 */
export function signedDeviationDeg(pred: Pt, target: Pt, dMm: number): Pt {
  const d = Math.max(dMm, 1);
  const h = (Math.atan2(pred.x, d) - Math.atan2(target.x, d)) * RAD2DEG;
  const v = (Math.atan2(pred.y, d) - Math.atan2(target.y, d)) * RAD2DEG;
  return { x: h, y: v };
}

export function toPd(dev: Pt): Pt {
  return { x: degToPd(dev.x), y: degToPd(dev.y) };
}

export interface TimePoint {
  t: number;
  h: number;
  v: number;
}

/**
 * BCEA：双变量椭圆置信面积，单位 deg²。
 * A(p) = -2π·σ1·σ2·ln(1-p)，其中 σ1,σ2 为协方差矩阵特征值的平方根。
 * p=0.632 时退化为经典 BCEA（2πσ1σ2）。
 */
export function bcea(points: Pt[], p = 0.6827): number {
  const n = points.length;
  if (n < 5) return NaN;
  let mx = 0;
  let my = 0;
  for (const q of points) {
    mx += q.x;
    my += q.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of points) {
    const dx = q.x - mx;
    const dy = q.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= n - 1;
  syy /= n - 1;
  sxy /= n - 1;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  const l2 = Math.max(1e-12, tr / 2 - Math.sqrt(disc));
  const s1 = Math.sqrt(Math.max(l1, 1e-12));
  const s2 = Math.sqrt(l2);
  return -2 * Math.PI * s1 * s2 * Math.log(1 - p);
}

/** 落在以质心为圆心、半径 r 度内的样本占比 */
export function proportionWithin(points: Pt[], rDeg: number): number {
  if (points.length === 0) return NaN;
  let mx = 0;
  let my = 0;
  for (const q of points) {
    mx += q.x;
    my += q.y;
  }
  mx /= points.length;
  my /= points.length;
  let k = 0;
  for (const q of points) if (Math.hypot(q.x - mx, q.y - my) <= rDeg) k++;
  return k / points.length;
}

export interface Fixation {
  startMs: number;
  endMs: number;
  centroid: Pt;
  bcea: number;
  n: number;
}

/**
 * I-DT 注视检测：窗口内离散度低于阈值即判为注视。
 * 阈值用角度，和临床口径一致（1° 常用）。
 */
export function detectFixations(
  series: TimePoint[],
  dispersionDeg = 1.0,
  windowMs = 100,
  minDurationMs = 120,
): Fixation[] {
  const out: Fixation[] = [];
  let i = 0;
  while (i < series.length) {
    let j = i;
    let minH = Infinity;
    let maxH = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    while (j < series.length) {
      const s = series[j];
      if (s.t - series[i].t > windowMs) break;
      minH = Math.min(minH, s.h);
      maxH = Math.max(maxH, s.h);
      minV = Math.min(minV, s.v);
      maxV = Math.max(maxV, s.v);
      if (Math.max(maxH - minH, maxV - minV) > dispersionDeg) break;
      j++;
    }
    const span = series[Math.min(j, series.length - 1)].t - series[i].t;
    if (j - i >= 3 && span >= minDurationMs) {
      const slice = series.slice(i, j).map((s) => ({ x: s.h, y: s.v }));
      const n = slice.length;
      const centroid = {
        x: slice.reduce((a, b) => a + b.x, 0) / n,
        y: slice.reduce((a, b) => a + b.y, 0) / n,
      };
      out.push({
        startMs: series[i].t,
        endMs: series[Math.min(j, series.length - 1)].t,
        centroid,
        bcea: bcea(slice),
        n,
      });
      i = Math.max(j, i + 1);
    } else {
      i++;
    }
  }
  return out;
}

export interface DeviationEpisode {
  startMs: number;
  endMs: number;
  meanPd: number;
  maxPd: number;
}

/**
 * 偏斜事件检测：连续超过阈值的时段。
 *
 * 两个必须的约束，否则正常人在噪声上也会被报出"偏斜"：
 *   ① 阈值要高于噪声尾部。单次测量 SD ≈ 1.4 PD，原来用 3 PD（≈2σ），
 *      正常受试者 45 秒里被报出 6 次事件、占比 12%。改成 8 PD（≈5.7σ）。
 *   ② 方向必须一致。真实斜视是单向偏，噪声是来回跳——
 *      正负混杂的时段一律不算事件。
 */
export function detectDeviationEpisodes(
  series: TimePoint[],
  thresholdPd = 8,
  minDurationMs = 200,
  minGapMs = 120,
): DeviationEpisode[] {
  const eps: DeviationEpisode[] = [];
  let cur: { start: number; end: number; signed: number[] } | null = null;
  const flush = () => {
    if (cur && cur.end - cur.start >= minDurationMs) {
      const signed = cur.signed;
      const pos = signed.filter((v) => v > 0).length;
      const consistency = Math.max(pos, signed.length - pos) / signed.length;
      if (consistency >= 0.8) {
        eps.push({
          startMs: cur.start,
          endMs: cur.end,
          meanPd: signed.reduce((a, b) => a + b, 0) / signed.length,
          maxPd: Math.max(...signed.map(Math.abs)),
        });
      }
    }
    cur = null;
  };
  for (const s of series) {
    const pd = degToPd(s.h);
    if (Math.abs(pd) >= thresholdPd) {
      if (!cur) {
        cur = { start: s.t, end: s.t, signed: [pd] };
      } else if (s.t - cur.end > minGapMs) {
        flush();
        cur = { start: s.t, end: s.t, signed: [pd] };
      } else {
        cur.end = s.t;
        cur.signed.push(pd);
      }
    }
  }
  flush();
  return eps;
}

export interface PursuitResult {
  gain: number;
  rmseDeg: number;
  lagMs: number;
  n: number;
}

/**
 * 追随质量：以目标为自变量的回归斜率即增益（理想 ≈1），
 * 残差反映平滑度，互相关峰给出滞后。
 * 30fps 只能给出粗增益；扫视细节需要 60fps。
 */
export function pursuitQuality(
  eye: TimePoint[],
  target: TimePoint[],
  maxLagMs = 300,
): PursuitResult {
  const n = Math.min(eye.length, target.length);
  if (n < 10) return { gain: NaN, rmseDeg: NaN, lagMs: NaN, n };
  const tgtMap = new Map<number, number>();
  for (const s of target) tgtMap.set(Math.round(s.t), s.h);
  const pairs: Array<[number, number, number]> = [];
  for (const s of eye) {
    const tv = tgtMap.get(Math.round(s.t));
    if (tv === undefined) continue;
    pairs.push([s.t, tv, s.h]);
  }
  if (pairs.length < 10) return { gain: NaN, rmseDeg: NaN, lagMs: NaN, n: pairs.length };

  let sx = 0;
  let sy = 0;
  for (const p of pairs) {
    sx += p[1];
    sy += p[2];
  }
  sx /= pairs.length;
  sy /= pairs.length;
  let sxy = 0;
  let sxx = 0;
  for (const p of pairs) {
    sxy += (p[1] - sx) * (p[2] - sy);
    sxx += (p[1] - sx) ** 2;
  }
  const gain = sxx > 1e-9 ? sxy / sxx : NaN;

  // 以最优增益对齐后算残差，避免“增益低”被误读成“不平滑”
  const resid = pairs.map((p) => p[2] - (sy + gain * (p[1] - sx)));
  const rmseDeg = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / resid.length);

  // 互相关找滞后：眼动 vs 平移后的目标。
  // 之前这里写成 [p[1], 目标@lag]，p[1] 是目标本身，等于算目标的
  // 自相关，峰值永远在 lag=0——所以滞后恒显示 0 ms。
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let lag = -maxLagMs; lag <= maxLagMs; lag += 10) {
    const eyeVals: number[] = [];
    const tgtVals: number[] = [];
    for (const p of pairs) {
      const tv = tgtMap.get(Math.round(p[0] + lag));
      if (tv === undefined) continue;
      eyeVals.push(p[2]);
      tgtVals.push(tv);
    }
    if (eyeVals.length < 10) continue;
    let ax = 0;
    let ay = 0;
    for (let i = 0; i < eyeVals.length; i++) {
      ax += eyeVals[i];
      ay += tgtVals[i];
    }
    ax /= eyeVals.length;
    ay /= tgtVals.length;
    let cxy = 0;
    let cxx = 0;
    let cyy = 0;
    for (let i = 0; i < eyeVals.length; i++) {
      const dx = eyeVals[i] - ax;
      const dy = tgtVals[i] - ay;
      cxy += dx * dy;
      cxx += dx * dx;
      cyy += dy * dy;
    }
    const corr = cxx > 1e-9 && cyy > 1e-9 ? cxy / Math.sqrt(cxx * cyy) : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return { gain, rmseDeg, lagMs: bestLag, n: pairs.length };
}

/** 分位数，用于稳健统计 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
