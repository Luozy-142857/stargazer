/**
 * 分视呈现层。
 *
 * 训练的核心机制是"双眼分视 + 对比度平衡"：给优势眼降低对比度，
 * 逼大脑同时使用两只眼，这是抗抑制的标准做法。
 * 呈现方式必须可替换（红青 / 快门眼镜 / VR），所以抽成接口。
 */
import type { Pt } from "../types";

export type EyeSide = "left" | "right" | "both";

/** 眼镜类型。红片一律在左眼，右眼通道取滤片能透过的那种颜色。
 *  "none" 表示不做分视：两层都画白色，两只眼看到同样的东西——
 *  用来在没有滤片时验证注视交互，不能用来做任何分视指标。 */
export type GlassesKind = "cyan" | "green" | "blue" | "none";

export interface SceneItem {
  x: number;
  y: number;
  r: number;
  eye: EyeSide;
  alpha: number;
  /** 圆环宽度占半径比例 */
  rim: number;
  /** 形状：orb = 光点圆球（旧行为），star = 五角星（默认） */
  kind?: "orb" | "star";
  /** 星形旋转（弧度） */
  rot?: number;
}

export interface Presenter {
  readonly name: string;
  readonly needsGlasses: boolean;
  configure(dominantEye: EyeSide, contrastRatio: number, glasses: GlassesKind): void;
  /** 单眼通道颜色（"r,g,b"），给立体图这类需要逐点着色的场景用 */
  channelColor(eye: "left" | "right"): string;
  clear(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  drawItem(ctx: CanvasRenderingContext2D, item: SceneItem): void;
}

/** 左眼恒为红通道（红片戴左眼）；右眼取绿/蓝/青，匹配手头的滤片。 */
const LEFT_CH = { core: "255, 70, 70", glow: "255, 40, 40" } as const;
const RIGHT_CH: Record<Exclude<GlassesKind, "none">, { core: string; glow: string }> = {
  cyan: { core: "70, 235, 255", glow: "30, 210, 255" },
  green: { core: "85, 255, 95", glow: "40, 220, 55" },
  blue: { core: "85, 125, 255", glow: "45, 95, 255" },
};
const WHITE_CH = { core: "255, 255, 255", glow: "220, 220, 220" } as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 红青分视。左眼内容画纯红、右眼内容画纯青，黑底。
 * 戴红青眼镜后，两只眼各自只看到属于自己的那一层。
 */
export class AnaglyphPresenter implements Presenter {
  /** 会随眼镜类型改写，所以不能是 readonly */
  name = "红青分视";
  readonly needsGlasses = true;
  private dominant: EyeSide = "right";
  /** 优势眼看到的对比度比例。越小，优势眼越"被压制" */
  private ratio = 0.45;
  private glasses: GlassesKind = "cyan";

  configure(dominantEye: EyeSide, contrastRatio: number, glasses: GlassesKind = "cyan"): void {
    this.dominant = dominantEye;
    this.ratio = Math.max(0.05, Math.min(1, contrastRatio));
    this.glasses = glasses;
    this.name =
      glasses === "none"
        ? "无分视"
        : glasses === "green"
          ? "红绿分视"
          : glasses === "blue"
            ? "红蓝分视"
            : "红青分视";
  }

  channelColor(eye: "left" | "right"): string {
    if (this.glasses === "none") return WHITE_CH.core;
    return eye === "left" ? LEFT_CH.core : RIGHT_CH[this.glasses].core;
  }

  clear(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
  }

  drawItem(ctx: CanvasRenderingContext2D, item: SceneItem): void {
    const isStar = item.kind !== "orb";
    if (item.eye === "both" || this.glasses === "none") {
      if (isStar) this.paintStar(ctx, item, WHITE_CH.core, clamp01(item.alpha));
      else this.paint(ctx, item, WHITE_CH.core, clamp01(item.alpha));
      return;
    }
    const side = item.eye;
    const ch = side === "left" ? LEFT_CH : RIGHT_CH[this.glasses];
    // 优势眼这一层被压暗，弱侧眼保持满对比度
    const gain = this.dominant === side ? this.ratio : 1;
    if (isStar) {
      // 外层光晕 + 星体：光晕半径比星体大，让"这是颗星"在弱对比度下也认得出
      this.paint(ctx, { ...item, r: item.r * 1.9 }, ch.glow, clamp01(item.alpha * gain * 0.4), true);
      this.paintStar(ctx, item, ch.core, clamp01(item.alpha * gain));
      return;
    }
    this.paint(ctx, item, ch.glow, clamp01(item.alpha * gain * 0.55), true);
    this.paint(ctx, item, ch.core, clamp01(item.alpha * gain));
  }

  /** 五角星：外半径 r，内半径 0.46r，带中心高光 */
  private paintStar(
    ctx: CanvasRenderingContext2D,
    item: SceneItem,
    rgb: string,
    alpha: number,
  ): void {
    if (alpha <= 0.01) return;
    const outer = item.r;
    const inner = outer * 0.46;
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rot ?? 0);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
    g.addColorStop(0, `rgba(${rgb}, ${Math.min(1, alpha * 1.15)})`);
    g.addColorStop(0.72, `rgba(${rgb}, ${alpha})`);
    g.addColorStop(1, `rgba(${rgb}, ${alpha * 0.85})`);
    ctx.fillStyle = g;
    ctx.fill();
    // 中心高光：小但是"亮"的，远远看去像星星在闪
    ctx.beginPath();
    ctx.arc(0, 0, outer * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.85})`;
    ctx.fill();
    ctx.restore();
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    item: SceneItem,
    rgb: string,
    alpha: number,
    glow = false,
  ): void {
    if (alpha <= 0.01) return;
    const outer = glow ? item.r * 2.1 : item.r;
    const g = ctx.createRadialGradient(item.x, item.y, 0, item.x, item.y, outer);
    if (glow) {
      g.addColorStop(0, `rgba(${rgb}, ${alpha * 0.5})`);
      g.addColorStop(0.55, `rgba(${rgb}, ${alpha * 0.18})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
    } else {
      g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      g.addColorStop(Math.max(0, 1 - item.rim), `rgba(${rgb}, ${alpha})`);
      g.addColorStop(1, `rgba(${rgb}, ${alpha * 0.15})`);
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(item.x, item.y, outer, 0, Math.PI * 2);
    ctx.fill();
  }
}
