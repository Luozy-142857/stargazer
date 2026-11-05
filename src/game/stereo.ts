/**
 * 立体视锐度测试（随机点立体图 + 阶梯法）。
 *
 * 为什么这个指标特别有价值：它**完全不依赖注视精度**。
 * 只要两只眼能把同一个随机点阵融合出深度，就说明双眼在协同工作——
 * 这是斜视治疗最硬的疗效终点，也正好绕开我们绝对偏斜量还没验证的短板。
 *
 * 原理：背景点在两眼完全重合（零视差），目标区的点在右眼水平位移 δ。
 * 大脑融合后会看到目标浮起或凹陷。δ 越小 → 立体视越精细。
 *
 * 分辨率上限：屏幕 1 像素 ≈ 96 弧秒（50cm / 0.233mm 每像素），
 * 所以能测到约 100 弧秒。正常人 40–60 弧秒，临床关注的
 * "正常 / 减退 / 缺失"分界（100 / 200 / 400）都覆盖得到。
 */
import type { ScreenGeom } from "../types";
import { AnaglyphPresenter, type GlassesKind, type Presenter } from "./presenter";

export interface StereoOptions {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  promptEl: HTMLElement;
  progressEl: HTMLElement;
  geom: ScreenGeom;
  glasses: GlassesKind;
}

export interface StereoResult {
  /** 阈值（弧秒）。null 表示在最大视差下也没通过 */
  thresholdArcsec: number | null;
  trials: number;
  correct: number;
  reversals: number;
  /** 本次能提供的最小视差（受屏幕像素限制） */
  floorArcsec: number;
  arcsecPerPx: number;
}

const QUADRANTS: Array<{ key: string; dx: number; dy: number; label: string }> = [
  { key: "ArrowLeft", dx: -0.19, dy: 0, label: "左" },
  { key: "ArrowUp", dx: 0, dy: -0.17, label: "上" },
  { key: "ArrowRight", dx: 0.19, dy: 0, label: "右" },
  { key: "ArrowDown", dx: 0, dy: 0.17, label: "下" },
];

export class StereoTest {
  private presenter: Presenter = new AnaglyphPresenter();

  constructor(private o: StereoOptions) {}

  async run(): Promise<StereoResult | null> {
    const { canvas, hud, geom } = this.o;
    this.presenter.configure("both", 1, this.o.glasses);

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.classList.add("on");
    hud.classList.add("on");
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));

    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.exit();
      return null;
    }

    // 1 像素对应多少弧秒：pixel_mm / distance_mm 是弧度，再 ×206265 转弧秒
    const arcsecPerPx = ((geom.mmPerPx / geom.distanceMm) * 206265) || 96;
    const floorArcsec = arcsecPerPx; // 最小可实现的视差就是 1 像素

    const result = await this.doTrials(ctx, w, h, dpr, arcsecPerPx, floorArcsec);
    this.exit();
    return result;
  }

  private drawRds(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dpr: number,
    target: { cx: number; cy: number; half: number },
    disparityPx: number,
    mask: "both" | "left" | "right" = "both",
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    this.presenter.clear(ctx, w, h);

    // 必须用叠加混合：背景点在两眼重合，红+青叠加成白色。
    // 用默认的 source-over 会让后画的青色直接盖掉红色，左眼就什么都看不见。
    ctx.globalCompositeOperation = "lighter";

    const dotR = Math.max(1.6, Math.min(w, h) * 0.004);
    const spacing = dotR * 3.0;
    const leftColor = this.presenter.channelColor("left");
    const rightColor = this.presenter.channelColor("right");
    const showLeft = mask !== "right";
    const showRight = mask !== "left";

    // 逐格抖动的点阵：位置随机偏移，保证单眼看不出目标区
    for (let y = -spacing; y < h + spacing; y += spacing) {
      for (let x = -spacing; x < w + spacing; x += spacing) {
        const px = x + (Math.random() - 0.5) * spacing * 0.7;
        const py = y + (Math.random() - 0.5) * spacing * 0.7;
        const inTarget =
          Math.abs(px - target.cx) < target.half && Math.abs(py - target.cy) < target.half;
        const shift = inTarget ? disparityPx : 0;

        // 左眼：原点位置；右眼：目标区整体水平位移
        if (showLeft) {
          ctx.fillStyle = `rgb(${leftColor})`;
          ctx.beginPath();
          ctx.arc(px, py, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
        if (showRight) {
          ctx.fillStyle = `rgb(${rightColor})`;
          ctx.beginPath();
          ctx.arc(px + shift, py, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * 自检模式：固定大视差，可以单独看某一通道。
   *
   * 用途是排除"看起来没效果"的几种原因：
   *   1 = 只看红通道：应该是一片均匀噪点，看不出任何形状
   *   2 = 只看青通道：同上，且噪点图案与 1 不同（因为目标区被移位了）
   *   0 = 双眼：应能看到一块明确的凸起或凹陷
   * 若 0 看起来是"两个错开的方块"而不是浮起 → 融合失败（抑制或眼镜串扰）
   */
  async preview(): Promise<void> {
    const { canvas, hud } = this.o;
    this.presenter.configure("both", 1, this.o.glasses);
    canvas.classList.add("on");
    hud.classList.add("on");
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));

    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.exit();
      return;
    }

    let mask: "both" | "left" | "right" = "both";
    let dispPx = 10;
    const target = { cx: w / 2, cy: h / 2, half: Math.min(w, h) * 0.1 };

    const redraw = () => {
      this.drawRds(ctx, w, h, dpr, target, dispPx, mask);
      // 说明条（白色 = 两眼都可见）
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, w, Math.min(96, h * 0.12));
      const label =
        mask === "both" ? "双眼" : mask === "left" ? "只看红（左眼）" : "只看青（右眼）";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(Math.min(w, h) * 0.028)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.fillText(`自检 · ${label} · 视差 ${dispPx.toFixed(0)} px`, w / 2, h * 0.045);
      ctx.font = `400 ${Math.round(Math.min(w, h) * 0.019)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(
        "0 双眼   1 只看红   2 只看青   + / - 调视差   Esc 退出",
        w / 2,
        h * 0.085,
      );
    };

    redraw();

    await new Promise<void>((resolve) => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          window.removeEventListener("keydown", onKey);
          resolve();
          return;
        }
        if (e.key === "0") mask = "both";
        else if (e.key === "1") mask = "left";
        else if (e.key === "2") mask = "right";
        else if (e.key === "+" || e.key === "=") dispPx = Math.min(48, dispPx + 2);
        else if (e.key === "-" || e.key === "_") dispPx = Math.max(1, dispPx - 2);
        else return;
        e.preventDefault();
        redraw();
      };
      window.addEventListener("keydown", onKey);
    });

    this.exit();
  }

  private async doTrials(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dpr: number,
    arcsecPerPx: number,
    floorArcsec: number,
  ): Promise<StereoResult> {
    // 2 对 1 错的阶梯法，收敛到约 70.7% 正确率
    let level = 700;
    let streak = 0;
    let direction = 0;
    let reversals = 0;
    const reversalLevels: number[] = [];
    let trials = 0;
    let correct = 0;
    const maxTrials = 40;

    while (trials < maxTrials && reversals < 6) {
      const disparityPx = Math.max(0.4, level / arcsecPerPx);
      const targetIdx = Math.floor(Math.random() * QUADRANTS.length);
      const q = QUADRANTS[targetIdx];
      const pos = {
        cx: w / 2 + q.dx * w,
        cy: h / 2 + q.dy * h,
        half: Math.min(w, h) * 0.075,
      };

      this.drawRds(ctx, w, h, dpr, pos, disparityPx);
      this.o.promptEl.textContent = "点点里藏着一块凸起，在哪边？按方向键";
      this.o.progressEl.style.width = `${(trials / maxTrials) * 100}%`;

      const picked = await this.waitInput(w, h);
      if (picked === null) {
        return this.finish(trials, correct, reversals, reversalLevels, floorArcsec, arcsecPerPx);
      }

      trials++;
      const ok = picked === targetIdx;
      if (ok) {
        correct++;
        streak++;
      } else {
        streak = 0;
      }

      // 2 连对 → 变难；1 错 → 变简单
      if (ok && streak >= 2) {
        streak = 0;
        if (direction === 1) {
          reversals++;
          reversalLevels.push(level);
        }
        direction = 1;
        level = Math.max(floorArcsec, level / 1.6);
      } else if (!ok) {
        if (direction === -1) {
          reversals++;
          reversalLevels.push(level);
        }
        direction = -1;
        level = Math.min(1400, level * 1.6);
      }

      // 极短反馈：对错各闪一下
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = ok ? "rgba(80,220,140,0.85)" : "rgba(255,120,120,0.85)";
      ctx.font = `700 ${Math.round(Math.min(w, h) * 0.09)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ok ? "✓" : "✕", w / 2, h * 0.14);
      await new Promise((r) => setTimeout(r, 420));
    }

    return this.finish(trials, correct, reversals, reversalLevels, floorArcsec, arcsecPerPx);
  }

  private finish(
    trials: number,
    correct: number,
    reversals: number,
    levels: number[],
    floorArcsec: number,
    arcsecPerPx: number,
  ): StereoResult {
    let threshold: number | null = null;
    if (levels.length >= 2) {
      // 用最后几次反转的几何平均，抗单次波动
      const tail = levels.slice(-4);
      const logMean = tail.reduce((a, b) => a + Math.log(b), 0) / tail.length;
      threshold = Math.round(Math.exp(logMean));
    }
    return {
      thresholdArcsec: threshold,
      trials,
      correct,
      reversals,
      floorArcsec,
      arcsecPerPx,
    };
  }

  private waitInput(w: number, h: number): Promise<number | null> {
    return new Promise((resolve) => {
      const cleanup = () => {
        window.removeEventListener("keydown", onKey);
        this.o.canvas.removeEventListener("pointerdown", onPointer);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          cleanup();
          resolve(null);
          return;
        }
        const idx = QUADRANTS.findIndex((q) => q.key === e.key);
        if (idx >= 0) {
          cleanup();
          resolve(idx);
        }
      };
      const onPointer = (e: PointerEvent) => {
        // 按角度判方位：水平位移占优 → 左/右；否则 上/下
        const dx = e.clientX - w / 2;
        const dy = e.clientY - h / 2;
        let idx: number;
        if (Math.abs(dx) >= Math.abs(dy)) idx = dx < 0 ? 0 : 2;
        else idx = dy < 0 ? 1 : 3;
        cleanup();
        resolve(idx);
      };
      window.addEventListener("keydown", onKey);
      this.o.canvas.addEventListener("pointerdown", onPointer);
    });
  }

  private exit(): void {
    this.o.canvas.classList.remove("on");
    this.o.hud.classList.remove("on");
    this.o.promptEl.textContent = "";
    this.o.progressEl.style.width = "0%";
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  }
}
