/**
 * 调试模式与使用模式共用的核心逻辑：几何换算、运行时质量门控、校准拟合。
 *
 * 这些是从 App 里原样抽出来的——两个模式必须用**同一套**门控与拟合，
 * 否则「使用模式更宽松」会悄悄改变测量语义。这里不碰 DOM，
 *  UI 层各自负责把结果渲染给人看。
 */
import type {
  CalibrationResult,
  EyeKey,
  FrameQuality,
  FrameRecord,
  Pt,
  QualityFlag,
  ScreenGeom,
} from "../types";
import type { FaceFrame } from "../vision/face";
import { buildFeatures, Calibration, RidgeGazeModel } from "../gaze/model";
import * as M from "../gaze/metrics";

export const EYES: EyeKey[] = ["imageLeft", "imageRight"];

export interface Config {
  diagonalIn: number;
  distanceCm: number;
  fovDeg: number;
  ipdMm: number;
}

/** 一组预测点的质心；全部失败时返回 null */
export function meanPrediction(preds: Array<Pt | null>): Pt | null {
  const ok = preds.filter((p): p is Pt => p !== null);
  if (!ok.length) return null;
  return {
    x: ok.reduce((a, p) => a + p.x, 0) / ok.length,
    y: ok.reduce((a, p) => a + p.y, 0) / ok.length,
  };
}

export function computeGeom(cfg: Config): ScreenGeom {
  const w = window.screen.width;
  const h = window.screen.height;
  const diagPx = Math.hypot(w, h);
  const mmPerPx = (cfg.diagonalIn * 25.4) / diagPx;
  const distanceMm = cfg.distanceCm * 10;
  const pxPerDeg = (distanceMm * Math.tan(M.DEG2RAD)) / mmPerPx;
  return {
    widthMm: w * mmPerPx,
    heightMm: h * mmPerPx,
    mmPerPx,
    distanceMm,
    pxPerDeg,
  };
}

/**
 * 运行时质量门控。判定规则与测量层完全一致（头姿 5°、距离 2%、眨眼硬失败），
 * 校准与测试都靠它保证样本干净。
 */
export function assessFrame(
  frame: FaceFrame,
  cfg: Config,
  calib: Calibration | null,
  geom: ScreenGeom,
): FrameQuality {
  const flags: QualityFlag[] = [];
  const fPx = frame.videoW / 2 / Math.tan((cfg.fovDeg / 2) * M.DEG2RAD);
  const estDistanceMm = (cfg.ipdMm * fPx) / Math.max(frame.eyesDistPx, 1e-6);

  if (frame.eyes.imageLeft.closed || frame.eyes.imageRight.closed) flags.push("blink");
  if (frame.eyesDistPx < 45) flags.push("small");
  if (Math.abs(frame.head.yaw) > 18 * M.DEG2RAD) flags.push("yaw");
  if (Math.abs(frame.head.pitch) > 18 * M.DEG2RAD) flags.push("pitch");

  // 模型不含头位项，所以头位偏离校准姿态就是硬伤：直接挡掉这些帧
  const base = calib?.headMean;
  if (base) {
    if (Math.abs(frame.head.yaw - base.yaw) > 5 * M.DEG2RAD) flags.push("yaw");
    if (Math.abs(frame.head.pitch - base.pitch) > 5 * M.DEG2RAD) flags.push("pitch");
  }

  // 距离同理。瞳距像素与距离成反比，偏离校准值 2% 就挡掉。
  // 模型里有一个瞳距项（换来 2.3° 的精度），但它对距离敏感：
  // 距离变 2% 会产生约 3.7 PD 的伪偏移。所以门控必须紧——
  // 完全没有门控时，人挪 3–4% 曾产生过 −15 PD 的假偏斜。
  const ipdBase = calib?.ipdMean ?? 0;
  if (ipdBase > 1) {
    const ratio = frame.eyesDistPx / ipdBase;
    if (ratio > 1.02) flags.push("tooClose");
    else if (ratio < 0.98) flags.push("tooFar");
  }
  if (estDistanceMm > geom.distanceMm * 1.35) flags.push("tooFar");
  if (estDistanceMm < geom.distanceMm * 0.7) flags.push("tooClose");

  // 眨眼必须是硬失败。眼睑闭合时虹膜被遮挡，那一帧的预测基本是垃圾。
  const ok = flags.length === 0;
  const score = ok ? 1 : Math.max(0, 1 - flags.length * 0.25);
  return { ok, flags, score, estDistanceMm };
}

/**
 * 游戏用的**宽松**门控：只有「虹膜被遮挡」「脸太小」「没人脸」才丢帧。
 *
 * 测量层的 assessFrame 还会因为头位偏离校准姿态 >5°、距离偏离 >2% 丢帧——
 * 那是为了样本干净，对测量的确必要。但游戏是实时控制环：
 * 冻结比轻微失真糟得多。实测一局 60 秒里 24% 的帧被这些门控丢掉，
 * 滤波器每 4 帧停 1 帧，表现就是「火箭不跟手、一顿一顿」。
 *
 * 游戏自己还有中心锚定（每次加油重测偏置）和 one-euro 滤波兜底，
 * 完全承受得住头位和距离的小幅变化。
 */
export function gameGazeValid(quality: FrameQuality): boolean {
  const f = quality.flags;
  return !f.includes("blink") && !f.includes("small") && !f.includes("noFace");
}

export interface FitOutcome {
  calib: Calibration;
  result: CalibrationResult;
  /** 交叉验证偏差 >4° 的校准点（建议单独重测） */
  badSteps: string[];
  loocvMedian: number | null;
  heldOut: number | null;
  looPerPoint: Array<{ step: string; maxDeg: number }>;
}

/**
 * 用一批采集帧拟合校准（与眼别无关的分组只做一次）。
 * 返回 null 表示数据不足；badSteps 供自动重测使用。
 *
 * 纯计算、不碰 DOM——调试面板与使用模式的友好提示渲染的是同一份结果。
 */
export function fitCalibration(
  collected: FrameRecord[],
  geom: ScreenGeom,
): FitOutcome | null {
  const usable = collected.filter((f) => f.quality.ok && f.feat && f.targetMm);
  if (usable.length < 60) return null;

  const calib = new Calibration();
  let sumResid = 0;
  let nResid = 0;
  const perPoint: number[] = [];

  // 按校准点分组（与眼别无关，只分一次）
  const grouped = new Map<string, FrameRecord[]>();
  for (const f of usable) {
    if (f.step?.startsWith("calib-")) {
      const arr = grouped.get(f.step) ?? [];
      arr.push(f);
      grouped.set(f.step, arr);
    }
  }
  const calFrames = [...grouped.values()].flat();
  const pointIds = [...grouped.keys()];

  for (const side of EYES) {
    calib.models[side].fit(
      calFrames.map((f) => ({ f: f.feat![side]!, y: f.targetMm! })),
    );

    for (const [, fs] of grouped) {
      const mean = meanPrediction(fs.map((f) => calib.predict(side, f.feat![side]!)));
      if (!mean) continue;
      const err = M.angularErrorDeg(mean, fs[0].targetMm!, geom.distanceMm);
      perPoint.push(err);
      sumResid += err;
      nResid++;
    }
  }
  const fitResidualDeg = nResid ? sumResid / nResid : NaN;

  // 记录校准期的头位均值，测试时用它做门控（模型本身不含头位项）
  if (calFrames.length) {
    const avg = (pick: (h: FrameRecord["head"]) => number) =>
      calFrames.reduce((a, f) => a + pick(f.head), 0) / calFrames.length;
    calib.headMean = {
      yaw: avg((h) => h.yaw),
      pitch: avg((h) => h.pitch),
      roll: avg((h) => h.roll),
    };
    calib.ipdMean = calFrames.reduce((a, f) => a + f.eyesDistPx, 0) / calFrames.length;
  }

  // 留一点交叉验证：每次扣掉一个校准点重新拟合，再预测被扣掉的点。
  const looErrors: number[] = [];
  const looPerPoint: Array<{ step: string; maxDeg: number }> = [];
  for (const held of pointIds) {
    const train = calFrames.filter((f) => f.step !== held);
    const heldFrames = grouped.get(held)!;
    let pointMax = 0;
    for (const side of EYES) {
      const m = new RidgeGazeModel();
      try {
        m.fit(train.map((f) => ({ f: f.feat![side]!, y: f.targetMm! })));
      } catch {
        continue;
      }
      const mean = meanPrediction(heldFrames.map((f) => m.predict(f.feat![side]!)));
      if (!mean) continue;
      const err = M.angularErrorDeg(mean, heldFrames[0].targetMm!, geom.distanceMm);
      looErrors.push(err);
      if (Number.isFinite(err)) pointMax = Math.max(pointMax, err);
    }
    if (pointMax > 0) looPerPoint.push({ step: held, maxDeg: pointMax });
  }
  const loocvMedian = looErrors.length ? M.quantile(looErrors, 0.5) : null;
  const loocvMax = looErrors.length ? Math.max(...looErrors) : null;

  // 留出验证
  let heldOut: number | null = null;
  const valFrames = usable.filter((f) => f.step === "validate-0");
  if (valFrames.length > 5) {
    let acc = 0;
    let k = 0;
    for (const side of EYES) {
      const mean = meanPrediction(valFrames.map((f) => calib.predict(side, f.feat![side]!)));
      if (!mean) continue;
      acc += M.angularErrorDeg(mean, valFrames[0].targetMm!, geom.distanceMm);
      k++;
    }
    if (k) heldOut = acc / k;
  }

  calib.distanceMm = geom.distanceMm;
  calib.fitResidualMm =
    (calib.models.imageLeft.residualMm + calib.models.imageRight.residualMm) / 2;

  return {
    calib,
    result: {
      fitResidualDeg,
      heldOutDeg: heldOut,
      loocvMedianDeg: loocvMedian,
      loocvMaxDeg: loocvMax,
      looPerPoint,
      perPointDeg: perPoint,
      samples: usable.length,
      at: Date.now(),
    },
    badSteps: looPerPoint.filter((p) => p.maxDeg > 4).map((b) => b.step),
    loocvMedian,
    heldOut,
    looPerPoint,
  };
}

/** 逐帧采集记录（校准/测试/空闲都走它），与 App 里的字段完全一致 */
export function makeRecord(
  t: number,
  tAbs: number,
  step: string | null,
  frame: FaceFrame,
  quality: FrameQuality,
): FrameRecord {
  const rec: FrameRecord = {
    t,
    tAbs,
    step,
    feat: {},
    raw: {},
    eyesDistPx: frame.eyesDistPx,
    predMm: {},
    devDeg: {},
    devPd: {},
    head: frame.head,
    quality,
    targetMm: null,
    closed: {
      imageLeft: frame.eyes.imageLeft.closed,
      imageRight: frame.eyes.imageRight.closed,
    },
  };
  for (const side of EYES) {
    const eye = frame.eyes[side];
    rec.feat![side] = buildFeatures(eye, frame.eyesDistPx);
    rec.raw![side] = {
      ix: eye.iris.x,
      iy: eye.iris.y,
      cx: eye.center.x,
      cy: eye.center.y,
      w: eye.width,
      h: eye.height,
    };
  }
  return rec;
}

/**
 * 在已有记录上补预测与偏斜（需要靶点时才算偏斜）。
 * 训练游戏没有靶点，但仍需要当前注视方向——所以 predMm 任何时候都算。
 */
export function fillPredictions(
  rec: FrameRecord,
  calib: Calibration | null,
  geom: ScreenGeom,
  targetMm: Pt | null,
): void {
  rec.targetMm = targetMm;
  if (!calib?.ready) return;
  for (const side of EYES) {
    const pred = calib.predict(side, rec.feat![side]!);
    if (!pred) continue;
    rec.predMm[side] = pred;
    if (targetMm) {
      const dev = M.signedDeviationDeg(pred, targetMm, geom.distanceMm);
      rec.devDeg[side] = dev;
      rec.devPd[side] = M.toPd(dev);
    }
  }
}
