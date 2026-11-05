/**
 * 面部关键点采集层。
 * 只负责“从一帧视频里抽出生理几何”，不做任何注视估计。
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { EyeGeometry, EyeKey, HeadPose, Pt } from "../types";

type LM = { x: number; y: number; z: number };

/** MediaPipe FaceMesh 478 点。虹膜为 468-477。 */
const IRIS_A = [468, 469, 470, 471, 472];
const IRIS_B = [473, 474, 475, 476, 477];
const EYE_A = { outer: 33, inner: 133, upper: 159, lower: 145 };
const EYE_B = { outer: 263, inner: 362, upper: 386, lower: 374 };

/** 眨眼判定：EAR 相对个体基线的比例阈值 */
const BLINK_RATIO = 0.55;
const EAR_WINDOW = 240;

export interface FaceFrame {
  t: number;
  eyes: Record<EyeKey, EyeGeometry>;
  head: HeadPose;
  /** 两眼中心像素距离，用于距离校验 */
  eyesDistPx: number;
  landmarks: LM[];
  videoW: number;
  videoH: number;
}

function assetUrl(p: string): string {
  return new URL(p, document.baseURI).href;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centroid(points: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** 从 4x4 列主序变换矩阵提取 Tait-Bryan 角（ZYX 顺序）。 */
function headPoseFromMatrix(d: number[]): HeadPose {
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  // 列主序：R[row][col] = d[col * 4 + row]
  const r20 = d[2];
  const r21 = d[6];
  const r22 = d[10];
  const r10 = d[1];
  const r00 = d[0];
  const yaw = Math.asin(clamp(-r20));
  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);
  return { yaw, pitch, roll };
}

export class FaceTracker {
  private lm: FaceLandmarker | null = null;
  private lastVideoTime = -1;
  private lastFrame: FaceFrame | null = null;
  private earHistory: number[] = [];
  private earBaseline = 0.32;

  async init(onNote?: (s: string) => void): Promise<void> {
    onNote?.("加载 WASM 运行时…");
    const fileset = await FilesetResolver.forVisionTasks(assetUrl("wasm"));
    onNote?.("加载人脸模型…");
    this.lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: assetUrl("models/face_landmarker.task"),
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    onNote?.("模型就绪");
  }

  get ready(): boolean {
    return this.lm !== null;
  }

  close(): void {
    this.lm?.close();
    this.lm = null;
  }

  /** 返回 null 表示本帧没有新数据（视频时间戳未推进）。 */
  detect(video: HTMLVideoElement, tsMs: number): FaceFrame | null {
    if (!this.lm) return null;
    // 视频没推进就直接返回 null，避免把同一帧重复计入统计
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    const res = this.lm.detectForVideo(video, tsMs);
    const lms = res.faceLandmarks?.[0];
    if (!lms || lms.length < 478) {
      this.lastFrame = null;
      return null;
    }

    const w = video.videoWidth;
    const h = video.videoHeight;
    const px = (i: number): Pt => ({ x: lms[i].x * w, y: lms[i].y * h });

    const makeEye = (irisIdx: number[], cfg: typeof EYE_A): EyeGeometry => {
      const iris = centroid([px(irisIdx[1]), px(irisIdx[2]), px(irisIdx[3]), px(irisIdx[4])]);
      // 虹膜中心点（irisIdx[0]）在侧视时抖动更大，用 4 点环心更稳
      const outer = px(cfg.outer);
      const inner = px(cfg.inner);
      const upper = px(cfg.upper);
      const lower = px(cfg.lower);
      const center = mid(outer, inner);
      const width = dist(outer, inner);
      const height = dist(upper, lower);
      return {
        side: "imageLeft",
        iris,
        center,
        width,
        height,
        ear: height / Math.max(width, 1e-6),
        closed: false,
      };
    };

    const eyeA = makeEye(IRIS_A, EYE_A);
    const eyeB = makeEye(IRIS_B, EYE_B);

    // 用图像 x 排序，保证 side 标签名副其实（与 MediaPipe 的左右命名无关）
    const [leftE, rightE] = eyeA.iris.x <= eyeB.iris.x ? [eyeA, eyeB] : [eyeB, eyeA];
    leftE.side = "imageLeft";
    rightE.side = "imageRight";

    // 眨眼：跟踪个体 EAR 基线（取窗口 80 分位，避免被眨眼拉低）
    const ear = (leftE.ear + rightE.ear) / 2;
    this.earHistory.push(ear);
    if (this.earHistory.length > EAR_WINDOW) this.earHistory.shift();
    if (this.earHistory.length > 30) {
      const sorted = [...this.earHistory].sort((a, b) => a - b);
      this.earBaseline = sorted[Math.floor(sorted.length * 0.8)];
    }
    const blink = ear < this.earBaseline * BLINK_RATIO;
    leftE.closed = blink || leftE.ear < this.earBaseline * BLINK_RATIO;
    rightE.closed = blink || rightE.ear < this.earBaseline * BLINK_RATIO;

    const matrix = res.facialTransformationMatrixes?.[0]?.data;
    const head: HeadPose = matrix
      ? headPoseFromMatrix(Array.from(matrix))
      : { yaw: 0, pitch: 0, roll: 0 };

    const frame: FaceFrame = {
      t: tsMs,
      eyes: { imageLeft: leftE, imageRight: rightE },
      head,
      eyesDistPx: dist(leftE.center, rightE.center),
      landmarks: lms as LM[],
      videoW: w,
      videoH: h,
    };
    this.lastFrame = frame;
    return frame;
  }
}
