/**
 * 注视模型：特征构造 + 岭回归 + 分眼校准。
 *
 * 关键设计：**每只眼单独拟合一个 特征→屏幕毫米 的映射**。
 * 这样两眼各自的“零位”是独立学到的，随后把同一只眼在
 * “单眼注视目标”和“测试时”的预测点对比，就能得到该眼相对目标的偏斜。
 * 头位/镜头/瞳距等共模误差在校准时被吸收，不进入偏斜角。
 */
import type { EyeGeometry, EyeKey, HeadPose, Pt } from "../types";

export const FEATURE_DIM = 7;

export interface Sample {
  f: number[];
  y: Pt;
}

/**
 * 特征：虹膜相对眼中心的偏移（用眼宽/睑裂高归一化）＋ 一个瞳距项。
 *
 * 这个 7 维组合是反复实测后的折中，记录清楚免得再走回头路：
 *
 *   · 瞳距归一化（u,v 都除以 ipd_px）——不行。u/v 量级只有 ±0.02，
 *     uv 交叉项数值上接近零，模型只能靠巨大系数互相抵消，
 *     一旦特征漂出样本范围就炸（v 漂移 0.010 时横向伪偏移 10–50 PD）。
 *
 *   · 纯几何（去掉瞳距项）——条件数好、对距离免疫，但精度掉得厉害。
 *     同一份校准数据：带瞳距项 3.39°，纯几何 5.67°。
 *
 *   · 瞳距项重罚到 ×200 —— 等价于删掉它（5.62°）。
 *     也就是说那 2.3° 的精度**就是靠让模型用距离换来的**，压不住。
 *
 *   代价是距离敏感：距离变 2% 会产生约 3.7 PD 的横向伪偏移。
 *   所以距离改成运行时门控（2%），而不是让模型自由吸收——
 *   之前完全没有门控时，人挪了 3–4% 就出现过 −15 PD 的假偏斜。
 *
 * 头位不进特征：校准期漂移常 <1°，标准化会把这点噪声放大到满量程，
 * 同样改成运行时门控。
 */
export function buildFeatures(eye: EyeGeometry, eyesDistPx: number): number[] {
  const u = (eye.iris.x - eye.center.x) / Math.max(eye.width, 1e-6);
  const v = (eye.iris.y - eye.center.y) / Math.max(eye.height, 1e-6);
  return [1, u, v, u * u, v * v, u * v, eyesDistPx / 1000];
}

/** 高斯消元（部分选主元）解 A w = b，A 为 n×n。 */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** 一维最小二乘 y ≈ a + g·p，返回 (g, a)。用于还原岭回归造成的尺度收缩。 */
function affineGain(y: number[], p: number[]): { g: number; a: number } {
  const n = y.length;
  if (n < 2) return { g: 1, a: 0 };
  let my = 0;
  let mp = 0;
  for (let i = 0; i < n; i++) {
    my += y[i];
    mp += p[i];
  }
  my /= n;
  mp /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dp = p[i] - mp;
    sxx += dp * dp;
    sxy += (y[i] - my) * dp;
  }
  if (sxx < 1e-12) return { g: 1, a: 0 };
  const g = sxy / sxx;
  return { g, a: my - g * mp };
}

export class RidgeGazeModel {
  private mu: number[] = [];
  private sd: number[] = [];
  private wx: number[] = [];
  private wy: number[] = [];
  /** 去收缩校正：预测 = 偏置 + 增益 × 原始预测 */
  private gainX = 1;
  private gainY = 1;
  private offX = 0;
  private offY = 0;
  /** 被判为"没有信息量"的特征，拟合与预测都必须置零 */
  private dead: boolean[] = [];
  private fitted = false;
  private trainResidualMm = 0;

  get ready(): boolean {
    return this.fitted;
  }

  get residualMm(): number {
    return this.trainResidualMm;
  }

  /** 被丢弃的头位特征个数，用于在界面上说明模型退化到了几维 */
  get droppedFeatures(): number {
    return this.dead.filter(Boolean).length;
  }

  fit(samples: Sample[], alpha = 0.05): void {
    if (samples.length < FEATURE_DIM * 2) throw new Error("校准样本不足");
    const n = FEATURE_DIM;
    const count = samples.length;
    const DEG = Math.PI / 180;

    // ---- 1) 原始统计（不做标准化就先算一遍标准差，用物理单位判断有没有信息量）
    this.mu = new Array(n).fill(0);
    this.sd = new Array(n).fill(1);
    this.dead = new Array(n).fill(false);
    const sdRaw = new Array(n).fill(0);
    for (let j = 1; j < n; j++) {
      let s = 0;
      for (const smp of samples) s += smp.f[j];
      this.mu[j] = s / count;
      let ss = 0;
      for (const smp of samples) {
        const d = smp.f[j] - this.mu[j];
        ss += d * d;
      }
      sdRaw[j] = Math.sqrt(ss / Math.max(1, count - 1));
      this.sd[j] = sdRaw[j] > 1e-9 ? sdRaw[j] : 1;
    }

    // ---- 2) 特征里没有头位项，不需要"按物理阈值判死"那套逻辑了。
    // 保留 dead 数组是为了以后加回新特征时还有位置放。

    // ---- 3) 标准化设计矩阵：常数项保持 1，死特征置 0
    const Z = samples.map((smp) =>
      smp.f.map((v, j) => {
        if (j === 0) return 1;
        if (this.dead[j]) return 0;
        return (v - this.mu[j]) / this.sd[j];
      }),
    );

    // ---- 4) 正规方程
    const XtX: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const XtyX: number[] = new Array(n).fill(0);
    const XtyY: number[] = new Array(n).fill(0);
    for (let i = 0; i < count; i++) {
      const z = Z[i];
      for (let a = 0; a < n; a++) {
        const za = z[a];
        if (za === 0) continue;
        for (let b = a; b < n; b++) XtX[a][b] += za * z[b];
        XtyX[a] += za * samples[i].y.x;
        XtyY[a] += za * samples[i].y.y;
      }
    }
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
    }

    // ---- 5) 惩罚强度按 XtX 的迹缩放。
    // 直接加固定 λ 会被样本数 n 稀释：n=543 时 λ=0.03 等于没正则化。
    let tr = 0;
    let free = 0;
    for (let a = 1; a < n; a++) {
      if (this.dead[a]) continue;
      tr += XtX[a][a];
      free++;
    }
    const pen = free > 0 ? (alpha * tr) / free : 0;
    for (let a = 1; a < n; a++) {
      if (!this.dead[a]) XtX[a][a] += pen;
    }
    // 截距不惩罚（它承载的是屏幕中心偏置，不该被压向 0）
    XtX[0][0] += 1e-9;

    this.wx = solveLinear(XtX, XtyX);
    this.wy = solveLinear(XtX, XtyY);
    this.fitted = true;

    // 去收缩校正：岭回归会把系数整体缩小，预测被拉向均值，
    // 表现为"中心还行、越靠边越偏"。用一次一维最小二乘把尺度与偏置还原，
    // 曲面形状的稳定性仍由岭回归保证。
    const px: number[] = [];
    const py: number[] = [];
    for (const smp of samples) {
      const raw = this.rawPredict(smp.f);
      px.push(raw.x);
      py.push(raw.y);
    }
    const cx = affineGain(
      samples.map((s) => s.y.x),
      px,
    );
    const cy = affineGain(
      samples.map((s) => s.y.y),
      py,
    );
    this.gainX = cx.g;
    this.offX = cx.a;
    this.gainY = cy.g;
    this.offY = cy.a;

    let se = 0;
    for (const smp of samples) {
      const p = this.predict(smp.f);
      if (!p) continue;
      se += (p.x - smp.y.x) ** 2 + (p.y - smp.y.y) ** 2;
    }
    this.trainResidualMm = Math.sqrt(se / count);
  }

  private rawPredict(f: number[]): Pt {
    let x = 0;
    let y = 0;
    for (let j = 0; j < FEATURE_DIM; j++) {
      const z = j === 0 ? 1 : this.dead[j] ? 0 : (f[j] - this.mu[j]) / this.sd[j];
      x += z * this.wx[j];
      y += z * this.wy[j];
    }
    return { x, y };
  }

  predict(f: number[]): Pt | null {
    if (!this.fitted) return null;
    const r = this.rawPredict(f);
    const x = this.offX + this.gainX * r.x;
    const y = this.offY + this.gainY * r.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }
}

/** 双眼校准结果 */
export class Calibration {
  models: Record<EyeKey, RidgeGazeModel> = {
    imageLeft: new RidgeGazeModel(),
    imageRight: new RidgeGazeModel(),
  };
  /** 拟合时的观看距离（毫米），测试时必须一致 */
  distanceMm = 0;
  /** 校准期头位的均值。测试时偏离它超过 5° 的帧会被门控挡掉。 */
  headMean: HeadPose | null = null;
  /** 校准期瞳距像素均值。测试时偏离它超过 6% 的帧会被门控挡掉。 */
  ipdMean = 0;
  /** 拟合残差（毫米，双眼合计） */
  fitResidualMm = 0;

  get ready(): boolean {
    return this.models.imageLeft.ready && this.models.imageRight.ready;
  }

  predict(side: EyeKey, f: number[]): Pt | null {
    return this.models[side].predict(f);
  }
}
