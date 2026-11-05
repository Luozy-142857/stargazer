/**
 * 全屏测试执行器：按步骤在屏幕上画目标、推进时间、回传每一帧。
 * 只管“呈现”，不做任何测量计算。
 */
import type { Pt, ScreenGeom } from "../types";
import type { Step } from "../protocols";

export interface FrameInfo {
  step: Step;
  index: number;
  total: number;
  tInStep: number;
  targetNm: Pt;
}

export interface RunnerOptions {
  onFrame: (info: FrameInfo) => void;
  onStep?: (step: Step, index: number, total: number) => void;
  /** 外部叠加层：用来画实时注视点，坐标是 CSS 像素 */
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number, geom: ScreenGeom) => void;
}

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));

export class Runner {
  private canvas: HTMLCanvasElement;
  private hud: HTMLElement;
  private promptEl: HTMLElement;
  private progressEl: HTMLElement;
  private subEl: HTMLElement;
  private cancelled = false;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.cancelled = true;
  };

  /** 每次进入测试模式刷新 */
  width = 0;
  height = 0;

  constructor(private geom: ScreenGeom) {
    this.canvas = document.getElementById("testCanvas") as HTMLCanvasElement;
    this.hud = document.getElementById("testHud") as HTMLElement;
    this.promptEl = document.getElementById("testPrompt") as HTMLElement;
    this.progressEl = document.querySelector("#testProgress i") as HTMLElement;
    this.subEl = document.getElementById("testSub") as HTMLElement;
  }

  get isActive(): boolean {
    return this.canvas.classList.contains("on");
  }

  private enter(): void {
    this.cancelled = false;
    this.canvas.classList.add("on");
    this.hud.classList.add("on");
    this.syncSize();
    this.subEl.innerHTML = "按 <kbd>Esc</kbd> 可随时中止";
    window.addEventListener("keydown", this.onKey);
    void document.documentElement.requestFullscreen?.().catch(() => {
      /* 全屏被拒也能跑，只是画布小一点 */
    });
  }

  /**
   * 同步画布尺寸到当前视口。
   *
   * 这是个必须每步都调的修正：requestFullscreen 是异步的，
   * 而 enter() 里先取 innerWidth/innerHeight 再请求全屏——全屏一旦改变了视口，
   * width/height 就是旧值，靶点换算成毫米时会整体按错误的比例缩放，
   * 直接污染校准（竖直方向尤其明显，因为全屏通常会吃掉地址栏那几十像素）。
   */
  private syncSize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.width && h === this.height && this.canvas.width > 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private exit(): void {
    this.canvas.classList.remove("on");
    this.hud.classList.remove("on");
    this.progressEl.style.width = "0%";
    window.removeEventListener("keydown", this.onKey);
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  }

  /** 返回 true 表示正常跑完，false 表示被中止 */
  async run(steps: Step[], opts: RunnerOptions): Promise<boolean> {
    this.enter();
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      this.exit();
      throw new Error("无法创建 2D 上下文");
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pxPerDeg = this.geom.pxPerDeg;

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        opts.onStep?.(step, i, steps.length);
        this.promptEl.textContent = step.label;
        const t0 = performance.now();

        while (true) {
          if (this.cancelled) return false;
          // 每帧同步一次：全屏切换可能在第一步中途才生效
          this.syncSize();
          const now = performance.now();
          const tInStep = now - t0;
          if (tInStep >= step.ms) break;

          const t01 = Math.min(1, tInStep / step.ms);
          const targetNm = step.path
            ? step.path(t01)
            : (step.at ?? { x: 0.5, y: 0.5 });

          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, this.width, this.height);
          ctx.fillStyle = "#0a0c11";
          ctx.fillRect(0, 0, this.width, this.height);

          this.drawTarget(ctx, targetNm, tInStep, step);
          opts.overlay?.(ctx, this.width, this.height, this.geom);

          const overall = (i + t01) / steps.length;
          this.progressEl.style.width = `${(overall * 100).toFixed(1)}%`;

          opts.onFrame({ step, index: i, total: steps.length, tInStep, targetNm });
          void pxPerDeg;
          await raf();
        }
      }
      return !this.cancelled;
    } finally {
      this.exit();
    }
  }

  private drawTarget(
    ctx: CanvasRenderingContext2D,
    nm: Pt,
    tInStep: number,
    step: Step,
  ): void {
    const x = nm.x * this.width;
    const y = nm.y * this.height;
    const ringPx = Math.max(9, 0.55 * this.geom.pxPerDeg);
    const dotPx = Math.max(2.5, 0.14 * this.geom.pxPerDeg);

    // 未进入采集期时画呼吸圈，提示“等一下”
    const settling = !step.collect || tInStep < (step.settleMs ?? 0);
    const pulse = settling ? 1 + 0.25 * Math.sin(tInStep / 140) : 1;

    ctx.save();
    ctx.translate(x, y);

    ctx.beginPath();
    ctx.arc(0, 0, ringPx * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = settling ? "rgba(140,170,210,0.45)" : "rgba(220,235,255,0.85)";
    ctx.lineWidth = Math.max(1.5, ringPx * 0.09);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, dotPx, 0, Math.PI * 2);
    ctx.fillStyle = settling ? "rgba(140,170,210,0.5)" : "#ffffff";
    ctx.fill();

    // 极淡的准星，帮助受试者定位但不干扰
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    const arm = ringPx * 2.6;
    ctx.beginPath();
    ctx.moveTo(-arm, 0);
    ctx.lineTo(-ringPx * 1.25, 0);
    ctx.moveTo(arm, 0);
    ctx.lineTo(ringPx * 1.25, 0);
    ctx.moveTo(0, -arm);
    ctx.lineTo(0, -ringPx * 1.25);
    ctx.moveTo(0, arm);
    ctx.lineTo(0, ringPx * 1.25);
    ctx.stroke();
    ctx.restore();
  }
}
