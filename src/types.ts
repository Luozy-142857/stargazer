/** 全项目共用的类型定义。 */

export interface Pt {
  x: number;
  y: number;
}

/** 按“图像左右”而不是解剖左右来命名，避免镜像带来的符号混乱。
 *  未镜像的自拍视角下：imageLeft = 受试者右眼。 */
export type EyeKey = "imageLeft" | "imageRight";

export interface EyeGeometry {
  side: EyeKey;
  /** 虹膜中心（视频像素坐标） */
  iris: Pt;
  /** 内外眦中点（视频像素坐标），相对头部固定 */
  center: Pt;
  /** 眼宽，内外眦距离（像素） */
  width: number;
  /** 上下眼睑中点距离（像素） */
  height: number;
  /** 眼睑纵横比 = height / width */
  ear: number;
  /** 本帧判定为闭合（眨眼或闭眼） */
  closed: boolean;
}

export interface HeadPose {
  /** 弧度。绕 Y 轴，正值方向依赖模型坐标约定，仅用于特征与门控 */
  yaw: number;
  pitch: number;
  roll: number;
}

/** 一台显示器 + 一个观看距离的几何参数，决定“像素 → 角度”的换算 */
export interface ScreenGeom {
  /** 屏幕物理宽高（毫米） */
  widthMm: number;
  heightMm: number;
  /** 每 CSS 像素的毫米数 */
  mmPerPx: number;
  /** 观看距离（毫米） */
  distanceMm: number;
  /** 1 度视角在屏幕上对应的像素数 */
  pxPerDeg: number;
}

export type QualityFlag =
  | "noFace"
  | "blink"
  | "tooFar"
  | "tooClose"
  | "yaw"
  | "pitch"
  | "small";

export interface FrameQuality {
  ok: boolean;
  flags: QualityFlag[];
  /** 0..1，综合可信度，用于统计有效帧占比 */
  score: number;
  /** 由瞳距像素推算的距离（毫米），仅用于与设定距离交叉校验 */
  estDistanceMm: number;
}

/**
 * 单眼原始几何（像素）。存下来是为了能离线尝试**任意**特征变换——
 * 光存经过归一化的 feat 的话，就只能在既定特征里调参，没法换建模思路。
 */
export interface EyeRaw {
  ix: number;
  iy: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 一帧的完整派生记录（不含任何图像） */
export interface FrameRecord {
  /** 当前步骤内的相对时间（ms），用于分析单步内的时序 */
  t: number;
  /** 整个测试开始起的绝对时间（ms）。多步骤测试必须用它算总时长 */
  tAbs: number;
  step: string | null;
  /** 每眼的模型输入特征，保留它是为了能离线重新拟合校准 */
  feat?: Partial<Record<EyeKey, number[]>>;
  /** 每眼原始几何，用于离线试验不同特征设计 */
  raw?: Partial<Record<EyeKey, EyeRaw>>;
  eyesDistPx: number;
  /** 每眼预测注视点，单位：屏幕中心起算的毫米 */
  predMm: Partial<Record<EyeKey, Pt>>;
  /** 每眼相对当前目标的偏斜角（度，带符号） */
  devDeg: Partial<Record<EyeKey, Pt>>;
  /** 每眼偏斜角折算棱镜度 */
  devPd: Partial<Record<EyeKey, Pt>>;
  head: HeadPose;
  quality: FrameQuality;
  targetMm: Pt | null;
  closed: Record<EyeKey, boolean>;
}

export interface CalibrationResult {
  /** 拟合残差 RMS（度），偏向乐观 */
  fitResidualDeg: number;
  /** 留出验证点的误差（度），单点，运气成分大 */
  heldOutDeg: number | null;
  /** 留一点交叉验证的中位误差（度）—— 比单个留出点可靠得多 */
  loocvMedianDeg: number | null;
  /** 交叉验证的最大误差（度），代表最坏方向 */
  loocvMaxDeg: number | null;
  /** 逐点交叉验证误差（每点取两眼较大值），用来定位哪些点漂移了 */
  looPerPoint: Array<{ step: string; maxDeg: number }>;
  /** 每个标定点每只眼的残差 */
  perPointDeg: number[];
  samples: number;
  at: number;
}
