/**
 * 指标汇总与导出。
 * 所有汇总都从帧记录重算，不依赖运行时状态——这样离线验证台
 * 可以用同一套公式复现，避免“在线一套、报告一套”。
 */
import type { CalibrationResult, EyeKey, FrameRecord, Pt, ScreenGeom } from "./types";
import * as M from "./gaze/metrics";

export const SCHEMA = "stargazer.session/1";

export interface DeviationSummary {
  eye: EyeKey;
  meanSignedPd: number;
  /** 本段读数中位数。它既可能是真实偏斜，也可能是本次校准的模型偏置——
   *  没有棱镜锚定时两者分不开，所以单独报出来，不混进事件统计。 */
  baselinePd: number;
  medianAbsPd: number;
  p95AbsPd: number;
  maxAbsPd: number;
  episodeCount: number;
  episodeDuty: number;
  meanEpisodeMs: number;
  maxEpisodeMs: number;
  frames: number;
}

export interface FixationSummary {
  eye: EyeKey;
  bcea68: number;
  /** 剔除最远 5% 散点后重算的 BCEA。面积指标对离群点极敏感，
   *  原始值容易被几个大偏移主导，两个一起看才不会被误导。 */
  bcea68Trim: number;
  bcea63: number;
  pctWithin1: number;
  pctWithin2: number;
  fixationCount: number;
  meanFixationMs: number;
  rmsDeg: number;
  frames: number;
}

export interface PursuitSummary {
  eye: EyeKey;
  gain: number;
  rmseDeg: number;
  lagMs: number;
  frames: number;
}

export interface RepeatabilityEyeSummary {
  eye: EyeKey;
  /** 总轮数 */
  blocks: number;
  /** 剔除走神轮后保留下来的轮数 */
  keptBlocks: number;
  /** 每轮的中位读数（PD），按轮次顺序，含被剔除的 */
  blockValues: number[];
  /** 每轮的轮内标准差（PD），用于判断那一轮是否稳住了 */
  blockSdPd: number[];
  /** 被剔除的轮次及原因 */
  excluded: Array<{ index: number; value: number; reason: string }>;
  /** 以下统计均基于保留轮 */
  meanPd: number;
  medianPd: number;
  sdPd: number;
  /** 最小可检测变化：1.96·√2·SD */
  mdc95Pd: number;
  /** 取 3 轮平均后的最小可检测变化 = MDC95 / √3 */
  mdc95Avg3Pd: number;
  /** 不剔除时的 SD，用来对照"剔除有没有过度" */
  rawSdPd: number;
  /** 读数随轮次的线性趋势（PD/轮）。|值| 大说明是漂移而非随机噪声 */
  trendPdPerRound: number;
}

export type TestResult =
  | {
      kind: "deviation";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      eyes: DeviationSummary[];
    }
  | {
      kind: "fixation";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      eyes: FixationSummary[];
    }
  | {
      kind: "pursuit";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      eyes: PursuitSummary[];
    }
  | {
      kind: "repeatability";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      eyes: RepeatabilityEyeSummary[];
    }
  | {
      kind: "game";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      score: number;
      trials: number;
      hits: number;
      expired: number;
      /** 从星星出现到被火箭收集的平均耗时 */
      meanCaptureMs: number;
      medianErrorDeg: number;
      p90ErrorDeg: number;
      meanHitErrorDeg: number;
      /** 开局中心锚定修正掉的偏置（度）。大 = 本次校准有系统偏移。 */
      anchorLeftDeg: number;
      anchorRightDeg: number;
      /** 加油次数（每次加油同时完成一次注视锚定） */
      refuels: number;
      /** 视线几乎没动就命中的次数。这是"自动捕获"的在线护栏指标，
       *  占命中数超过 10% 就说明辅助/几何太宽松了。 */
      stillHits: number;
      /** 磁吸实际生效过的命中次数 */
      assistHits: number;
      /** 锚定零位是否因连续不达标而降级（降级后偏置可能不准） */
      anchorRelaxed: boolean;
      /** 撒点降级次数：只避开了瞄准点、没避开火箭的极端几何 */
      spawnRelaxed: number;
      dominantEye: EyeKey;
      contrastRatio: number;
      presenter: string;
    }
  | {
      kind: "stereo";
      startedAt: string;
      durationMs: number;
      validRatio: number;
      /** 阈值（弧秒）。null = 在最容易的视差下也没通过 */
      thresholdArcsec: number | null;
      trials: number;
      correct: number;
      reversals: number;
      /** 屏幕像素能提供的最小视差 */
      floorArcsec: number;
      arcsecPerPx: number;
    };

const EYES: EyeKey[] = ["imageLeft", "imageRight"];

function usable(f: FrameRecord): boolean {
  return f.quality.ok;
}

function devDegSeries(frames: FrameRecord[], side: EyeKey): M.TimePoint[] {
  const out: M.TimePoint[] = [];
  for (const f of frames) {
    // 眨眼/头位漂移帧的偏斜读数不可信，必须在这里挡掉，
    // 否则会污染中位数，还会伪造偏斜事件
    if (!f.quality.ok) continue;
    const d = f.devDeg[side];
    if (!d) continue;
    out.push({ t: f.t, h: d.x, v: d.y });
  }
  return out;
}

function devPdValues(frames: FrameRecord[], side: EyeKey): number[] {
  const out: number[] = [];
  for (const f of frames) {
    if (!f.quality.ok) continue;
    const p = f.devPd[side];
    if (p) out.push(p.x);
  }
  return out;
}

export function summarizeDeviation(frames: FrameRecord[], side: EyeKey): DeviationSummary {
  const vals = devPdValues(frames, side);
  const deg = devDegSeries(frames, side);
  const baselinePd = vals.length ? M.quantile(vals, 0.5) : NaN;

  // 事件检测在「减去本段基线」之后做。
  // 否则一个恒定的模型偏置会被判成"持续 39 秒的偏斜"——
  // 实测正常受试者就因此报出 98% 占比、2 次事件。
  // 间歇性斜视真正要抓的是"相对自身基线的偏移"，不是绝对量。
  const baselineDeg = Number.isFinite(baselinePd) ? M.pdToDeg(baselinePd) : 0;
  const centered = deg.map((p) => ({ t: p.t, h: p.h - baselineDeg, v: p.v }));
  const episodes = M.detectDeviationEpisodes(centered, 8, 200);

  const spanMs = deg.length > 1 ? deg[deg.length - 1].t - deg[0].t : 0;
  const episodeMs = episodes.reduce((a, e) => a + (e.endMs - e.startMs), 0);
  const absVals = vals.map(Math.abs);
  return {
    eye: side,
    meanSignedPd: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN,
    baselinePd,
    medianAbsPd: M.quantile(absVals, 0.5),
    p95AbsPd: M.quantile(absVals, 0.95),
    maxAbsPd: absVals.length ? Math.max(...absVals) : NaN,
    episodeCount: episodes.length,
    episodeDuty: spanMs > 0 ? episodeMs / spanMs : NaN,
    meanEpisodeMs: episodes.length
      ? episodes.reduce((a, e) => a + (e.endMs - e.startMs), 0) / episodes.length
      : 0,
    maxEpisodeMs: episodes.length
      ? Math.max(...episodes.map((e) => e.endMs - e.startMs))
      : 0,
    frames: vals.length,
  };
}

/** 去掉离质心最远的一小撮点 */
function trimFarthest(pts: Pt[], frac: number): Pt[] {
  if (pts.length < 40 || frac <= 0) return pts;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  const d = pts.map((p) => Math.hypot(p.x - mx, p.y - my));
  const cut = M.quantile(d, 1 - frac);
  return pts.filter((_, i) => d[i] <= cut);
}

export function summarizeFixation(frames: FrameRecord[], side: EyeKey): FixationSummary {
  const deg = devDegSeries(frames, side);
  const pts: Pt[] = deg.map((p) => ({ x: p.h, y: p.v }));
  const fixes = M.detectFixations(deg, 1.0, 100, 120);
  let rms = NaN;
  if (pts.length > 1) {
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    rms = Math.sqrt(
      pts.reduce((a, p) => a + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / pts.length,
    );
  }
  return {
    eye: side,
    bcea68: M.bcea(pts, 0.6827),
    bcea68Trim: M.bcea(trimFarthest(pts, 0.05), 0.6827),
    bcea63: M.bcea(pts, 0.632),
    pctWithin1: M.proportionWithin(pts, 1),
    pctWithin2: M.proportionWithin(pts, 2),
    fixationCount: fixes.length,
    meanFixationMs: fixes.length
      ? fixes.reduce((a, f) => a + (f.endMs - f.startMs), 0) / fixes.length
      : 0,
    rmsDeg: rms,
    frames: pts.length,
  };
}

function angleSeries(
  frames: FrameRecord[],
  side: EyeKey,
  pick: "eye" | "target",
  dMm: number,
): M.TimePoint[] {
  const out: M.TimePoint[] = [];
  for (const f of frames) {
    if (!f.quality.ok) continue;
    if (!f.targetMm) continue;
    const src = pick === "eye" ? f.predMm[side] : f.targetMm;
    if (!src) continue;
    out.push({
      t: f.t,
      h: (Math.atan2(src.x, dMm) * M.RAD2DEG),
      v: (Math.atan2(src.y, dMm) * M.RAD2DEG),
    });
  }
  return out;
}

export function summarizePursuit(
  frames: FrameRecord[],
  side: EyeKey,
  dMm: number,
): PursuitSummary {
  const eye = angleSeries(frames, side, "eye", dMm);
  const tgt = angleSeries(frames, side, "target", dMm);
  const q = M.pursuitQuality(eye, tgt);
  return { eye: side, gain: q.gain, rmseDeg: q.rmseDeg, lagMs: q.lagMs, frames: q.n };
}

/** 样本标准差 */
function sdOf(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** 最小二乘斜率 */
function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  return sxx > 1e-12 ? sxy / sxx : NaN;
}

/**
 * 重复性：每轮先取中位数，跨轮算标准差。
 *
 * 会自动剔除走神轮——实测一轮走神能把 SD 从 0.7 PD 拉到 2.9 PD，
 * 把 MDC95 从 1.9 抬到 7.9。剔除规则两条，都记进结果里，不静默丢数据：
 *   ① 绝对质量：有效帧过少，或轮内抖动 > 4 PD
 *   ② 相对离群：偏离中位超过 3.5 × MAD（下限 0.5 PD）
 * 剔除后的 SD 反映"质控到位时的固有精度"，前提是操作者执行同样的质控。
 */
export function summarizeRepeatability(
  frames: FrameRecord[],
  side: EyeKey,
): RepeatabilityEyeSummary {
  const blocks = new Map<number, number[]>();
  for (const f of frames) {
    if (!f.quality.ok) continue;
    if (!f.step?.startsWith("rep-")) continue;
    const pd = f.devPd[side];
    if (!pd) continue;
    const idx = Number(f.step.split("-")[1]);
    const arr = blocks.get(idx) ?? [];
    arr.push(pd.x);
    blocks.set(idx, arr);
  }

  const order = [...blocks.keys()].sort((a, b) => a - b);
  const blockValues = order.map((k) => M.quantile(blocks.get(k)!, 0.5));
  const blockSdPd = order.map((k) => sdOf(blocks.get(k)!));
  const counts = order.map((k) => blocks.get(k)!.length);
  const n = order.length;

  const keep = new Array<boolean>(n).fill(true);
  const excluded: Array<{ index: number; value: number; reason: string }> = [];

  for (let i = 0; i < n; i++) {
    if (counts[i] < 15) {
      keep[i] = false;
      excluded.push({
        index: order[i],
        value: blockValues[i],
        reason: `有效帧仅 ${counts[i]}`,
      });
    } else if (blockSdPd[i] > 4) {
      keep[i] = false;
      excluded.push({
        index: order[i],
        value: blockValues[i],
        reason: `轮内抖动 ${blockSdPd[i].toFixed(1)} PD`,
      });
    }
  }

  const keptIdx = () => keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  if (keptIdx().length >= 4) {
    const center = M.quantile(
      keptIdx().map((i) => blockValues[i]),
      0.5,
    );
    const mad =
      M.quantile(
        keptIdx().map((i) => Math.abs(blockValues[i] - center)),
        0.5,
      ) * 1.4826;
    const limit = 3.5 * Math.max(mad, 0.5);
    for (const i of keptIdx()) {
      const d = Math.abs(blockValues[i] - center);
      if (d > limit) {
        keep[i] = false;
        excluded.push({
          index: order[i],
          value: blockValues[i],
          reason: `偏离中位 ${d.toFixed(1)} PD`,
        });
      }
    }
  }

  const kept = keptIdx().map((i) => blockValues[i]);
  const keptRounds = keptIdx().map((i) => order[i]);
  const sdPd = sdOf(kept);
  const meanPd = kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : NaN;
  const mdc95Pd = Number.isFinite(sdPd) ? 1.96 * Math.SQRT2 * sdPd : NaN;

  return {
    eye: side,
    blocks: n,
    keptBlocks: kept.length,
    blockValues,
    blockSdPd,
    excluded,
    meanPd,
    medianPd: kept.length ? M.quantile(kept, 0.5) : NaN,
    sdPd,
    mdc95Pd,
    mdc95Avg3Pd: Number.isFinite(mdc95Pd) ? mdc95Pd / Math.sqrt(3) : NaN,
    rawSdPd: sdOf(blockValues),
    trendPdPerRound: linearSlope(keptRounds, kept),
  };
}

export function validRatio(frames: FrameRecord[]): number {  if (frames.length === 0) return 0;
  return frames.filter(usable).length / frames.length;
}

function spanOf(frames: FrameRecord[]): number {
  if (frames.length < 2) return 0;
  // 用绝对时间：多步骤测试里 t 每换一步就归零，量不到总时长
  return frames[frames.length - 1].tAbs - frames[0].tAbs;
}

export function summarizeTest(
  kind: "deviation" | "fixation" | "pursuit" | "repeatability",
  frames: FrameRecord[],
  dMm: number,
): TestResult {
  const startedAt = new Date().toISOString();
  const durationMs = spanOf(frames);
  const ratio = validRatio(frames);
  if (kind === "repeatability") {
    return {
      kind,
      startedAt,
      durationMs,
      validRatio: ratio,
      eyes: EYES.map((e) => summarizeRepeatability(frames, e)),
    };
  }
  if (kind === "deviation") {
    return {
      kind,
      startedAt,
      durationMs,
      validRatio: ratio,
      eyes: EYES.map((e) => summarizeDeviation(frames, e)),
    };
  }
  if (kind === "fixation") {
    return {
      kind,
      startedAt,
      durationMs,
      validRatio: ratio,
      eyes: EYES.map((e) => summarizeFixation(frames, e)),
    };
  }
  return {
    kind,
    startedAt,
    durationMs,
    validRatio: ratio,
    eyes: EYES.map((e) => summarizePursuit(frames, e, dMm)),
  };
}

// ---------------------------------------------------------------- 导出

export interface SessionExport {
  schema: string;
  createdAt: string;
  caseId: string;
  app: { version: string; userAgent: string };
  config: {
    diagonalIn: number;
    distanceCm: number;
    fovDeg: number;
    ipdMm: number;
    screenWidthMm: number;
    screenHeightMm: number;
    mmPerPx: number;
    pxPerDeg: number;
  };
  calibration: CalibrationResult | null;
  tests: TestResult[];
  /** 导出时被裁剪成紧凑结构，因此不声明为 FrameRecord[] */
  frames?: Array<Record<string, unknown>>;
}

const r3 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

function slimFrame(f: FrameRecord, withFeatures: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    t: Math.round(f.t),
    step: f.step,
    quality: {
      ok: f.quality.ok,
      flags: f.quality.flags,
      score: r3(f.quality.score),
      estDistMm: r3(f.quality.estDistanceMm),
    },
    head: { yaw: r3(f.head.yaw), pitch: r3(f.head.pitch), roll: r3(f.head.roll) },
    targetMm: f.targetMm ? { x: r3(f.targetMm.x), y: r3(f.targetMm.y) } : null,
    predMm: {
      imageLeft: f.predMm.imageLeft
        ? { x: r3(f.predMm.imageLeft.x), y: r3(f.predMm.imageLeft.y) }
        : null,
      imageRight: f.predMm.imageRight
        ? { x: r3(f.predMm.imageRight.x), y: r3(f.predMm.imageRight.y) }
        : null,
    },
    devDeg: {
      imageLeft: f.devDeg.imageLeft ? { x: r3(f.devDeg.imageLeft.x), y: r3(f.devDeg.imageLeft.y) } : null,
      imageRight: f.devDeg.imageRight
        ? { x: r3(f.devDeg.imageRight.x), y: r3(f.devDeg.imageRight.y) }
        : null,
    },
    closed: f.closed,
    eyesDistPx: r3(f.eyesDistPx),
  };
  if (withFeatures) {
    out.feat = {
      imageLeft: f.feat?.imageLeft?.map(r3) ?? null,
      imageRight: f.feat?.imageRight?.map(r3) ?? null,
    };
    out.raw = {
      imageLeft: f.raw?.imageLeft
        ? {
            ix: r3(f.raw.imageLeft.ix),
            iy: r3(f.raw.imageLeft.iy),
            cx: r3(f.raw.imageLeft.cx),
            cy: r3(f.raw.imageLeft.cy),
            w: r3(f.raw.imageLeft.w),
            h: r3(f.raw.imageLeft.h),
          }
        : null,
      imageRight: f.raw?.imageRight
        ? {
            ix: r3(f.raw.imageRight.ix),
            iy: r3(f.raw.imageRight.iy),
            cx: r3(f.raw.imageRight.cx),
            cy: r3(f.raw.imageRight.cy),
            w: r3(f.raw.imageRight.w),
            h: r3(f.raw.imageRight.h),
          }
        : null,
    };
  }
  return out;
}

export function buildExport(args: {
  caseId: string;
  geom: ScreenGeom;
  diagonalIn: number;
  fovDeg: number;
  ipdMm: number;
  calibration: CalibrationResult | null;
  tests: TestResult[];
  frames?: FrameRecord[];
}): SessionExport {
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    caseId: args.caseId || "anonymous",
    app: { version: "0.1.0", userAgent: navigator.userAgent },
    config: {
      diagonalIn: args.diagonalIn,
      distanceCm: args.geom.distanceMm / 10,
      fovDeg: args.fovDeg,
      ipdMm: args.ipdMm,
      screenWidthMm: r3(args.geom.widthMm) ?? 0,
      screenHeightMm: r3(args.geom.heightMm) ?? 0,
      mmPerPx: r3(args.geom.mmPerPx) ?? 0,
      pxPerDeg: r3(args.geom.pxPerDeg) ?? 0,
    },
    calibration: args.calibration,
    tests: args.tests,
    // 带上逐帧日志时一并带上特征，否则日志无法用于离线重新拟合
    frames: args.frames?.map((f) => slimFrame(f, true)),
  };
}

export function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
