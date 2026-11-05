/** 应用装配：DOM 事件、主循环、校准流程、测试流程、导出。 */
import type {
  CalibrationResult,
  EyeKey,
  FrameQuality,
  FrameRecord,
  Pt,
  ScreenGeom,
} from "../types";
import { FaceTracker, type FaceFrame } from "../vision/face";
import { Calibration } from "../gaze/model";
import * as M from "../gaze/metrics";
import {
  EYES,
  assessFrame,
  computeGeom,
  fillPredictions,
  fitCalibration as fitCalibrationCore,
  gameGazeValid,
  makeRecord,
  type Config,
} from "./core";
import {
  buildCalibrationSteps,
  buildDeviationSteps,
  buildFixationSteps,
  buildPursuitSteps,
  buildRepeatabilitySteps,
  buildValidationStep,
  buildWarmupSteps,
  type Step,
} from "../protocols";
import { Runner, type FrameInfo } from "./runner";
import {
  buildExport,
  downloadJson,
  summarizeTest,
  type TestResult,
} from "../session";
import {
  loadDirHandle,
  pickDirectory,
  saveDirHandle,
  supportsDirectoryWrite,
  writeJsonTo,
  type DirHandleLike,
} from "../fs";
import { GazeGame } from "../game/gazeGame";
import { StereoTest } from "../game/stereo";
import type { GlassesKind } from "../game/presenter";
import { EYE_COLOR as COLOR, drawFaceOverlay } from "./overlay";

/** 立体视必须真分视；"none" 下两个通道都是白色，做出来的是伪立体图。 */
function requireDichoptic(glasses: GlassesKind): boolean {
  return glasses !== "none";
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(
      `页面缺少元素 #${id}。index.html 与脚本不同步，请强制刷新（Ctrl+F5）后重试`,
    );
  }
  return el as unknown as T;
};

interface RunState {
  active: boolean;
  step: Step | null;
  collect: boolean;
  tInStep: number;
  targetNm: Pt;
}

export class App {
  private video = $<HTMLVideoElement>("video");
  private overlay = $<HTMLCanvasElement>("overlay");
  private tracker = new FaceTracker();
  private calib: Calibration | null = null;
  private calibResult: CalibrationResult | null = null;
  private runner!: Runner;
  private geom: ScreenGeom;
  private cfg: Config;

  private fps = 0;
  private lastTick = 0;
  private latestFrame: FaceFrame | null = null;
  private latestQuality: FrameQuality | null = null;

  private frames: FrameRecord[] = [];
  /** 整个会话（含校准帧）的采集日志，勾选后随导出附上，便于离线重拟合 */
  private log: FrameRecord[] = [];
  /** 用户选定的输出目录；为空时退回浏览器下载 */
  private outDir: DirHandleLike | null = null;
  private runState: RunState = {
    active: false,
    step: null,
    collect: false,
    tInStep: 0,
    targetNm: { x: 0.5, y: 0.5 },
  };
  private results: TestResult[] = [];
  /** 棱镜对照档位（金标准配对用） */
  private prismTrials: Array<{
    caseId: string;
    eye: EyeKey;
    prismPd: number;
    dir: string;
    measuredPd: number;
  }> = [];
  private live: FrameRecord[] = [];
  private valid = 0;
  private total = 0;

  private busy = false;
  private diagTick = 0;
  /** 当前测试的起始时刻（performance.now），用于算绝对时长 */
  private testStart = 0;

  constructor() {
    this.cfg = this.readConfig();
    this.geom = computeGeom(this.cfg);
    this.runner = new Runner(this.geom);
    this.bindUi();
    this.renderDerived();
    void this.restoreOutDir();
    this.pushFrame = this.pushFrame.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** 刷新后把上次选的输出目录找回来，否则文件会悄悄掉进 Downloads */
  private async restoreOutDir(): Promise<void> {
    const dir = await loadDirHandle();
    if (!dir) return;
    this.outDir = dir;
    $("outDirLabel").textContent = `输出目录：${dir.name}（已恢复）`;
    $("outDirLabel").className = "hint tiny ok-text";
  }

  // ------------------------------------------------------------ 配置

  private readConfig(): Config {
    return {
      diagonalIn: Number($<HTMLInputElement>("inDiag").value) || 15.6,
      distanceCm: Number($<HTMLInputElement>("inDist").value) || 50,
      fovDeg: Number($<HTMLInputElement>("inFov").value) || 65,
      ipdMm: Number($<HTMLInputElement>("inIpd").value) || 58,
    };
  }

  private renderDerived(): void {
    const g = this.geom;
    const el = $("derived");
    el.innerHTML = [
      `屏幕 <b>${(g.widthMm / 10).toFixed(1)} × ${(g.heightMm / 10).toFixed(1)} cm</b>`,
      `每 CSS 像素 <b>${g.mmPerPx.toFixed(3)} mm</b>`,
      `1° 视角 <b>${g.pxPerDeg.toFixed(1)} px</b> = <b>${(g.distanceMm * Math.tan(M.DEG2RAD)).toFixed(2)} mm</b>`,
      `1.5° ≈ <b>${(1.5 * g.distanceMm * Math.tan(M.DEG2RAD)).toFixed(1)} mm</b> 屏幕位移`,
    ].join("<br>");
  }

  private bindUi(): void {
    for (const id of ["inDiag", "inDist", "inFov", "inIpd"]) {
      $<HTMLInputElement>(id).addEventListener("change", () => {
        this.cfg = this.readConfig();
        this.geom = computeGeom(this.cfg);
        this.runner = new Runner(this.geom);
        this.renderDerived();
        if (this.calib) this.toast("几何参数已变更，建议重新校准", "bad");
      });
    }

    $("btnCam").addEventListener("click", () => void this.startCamera());

    document.querySelectorAll<HTMLButtonElement>(".tabbtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tabbtn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document
          .querySelector(`.tabpane[data-pane="${btn.dataset.tab}"]`)
          ?.classList.add("active");
      });
    });

    $("btnCalib").addEventListener("click", () => void this.runCalibration());
    $("btnDeviation").addEventListener("click", () => void this.runTest("deviation"));
    $("btnFixation").addEventListener("click", () => void this.runTest("fixation"));
    $("btnPursuit").addEventListener("click", () => void this.runTest("pursuit"));
    $("btnRepeat").addEventListener("click", () => void this.runTest("repeatability"));
    $("btnGame").addEventListener("click", () => void this.runGame());
    $("btnStereo").addEventListener("click", () => void this.runStereo());
    $("btnStereoCheck").addEventListener("click", () => void this.runStereoCheck());
    $("btnExport").addEventListener("click", () => void this.doExport());
    $("btnPickDir").addEventListener("click", () => void this.pickOutDir());
    $("btnPrismCsv").addEventListener("click", () => this.exportPrismCsv());
  }

  // ------------------------------------------------------------ 棱镜对照

  /**
   * 棱镜档位记录：每档单独存一份会话文件，caseId 里编码档位，
   * 这样 validate_offline.py 能按 caseId 把金标准配对起来。
   */
  private async recordPrismTrial(result: TestResult): Promise<void> {
    if (result.kind !== "deviation") return;
    if (!$<HTMLInputElement>("prismOn").checked) return;

    const eye = $<HTMLSelectElement>("prismEye").value as EyeKey;
    const prismPd = Number($<HTMLInputElement>("prismPd").value) || 0;
    const dir = $<HTMLSelectElement>("prismDir").value;
    const summary = result.eyes.find((e) => e.eye === eye);
    if (!summary || !Number.isFinite(summary.medianAbsPd)) {
      this.toast("这一档没有有效的偏斜读数，未记录", "bad");
      return;
    }

    const tag = `${this.currentCaseId()}-P${prismPd}${dir}-${eye === "imageRight" ? "R" : "L"}`;
    this.prismTrials.push({
      caseId: tag,
      eye,
      prismPd,
      dir,
      measuredPd: summary.medianAbsPd,
    });
    $<HTMLInputElement>("prismOn").checked = false;
    $<HTMLButtonElement>("btnPrismCsv").disabled = false;
    this.renderResults();

    await this.persist(
      `stargazer-${tag}-deviation-${stamp()}.json`,
      buildExport({
        caseId: tag,
        geom: this.geom,
        diagonalIn: this.cfg.diagonalIn,
        fovDeg: this.cfg.fovDeg,
        ipdMm: this.cfg.ipdMm,
        calibration: this.calibResult,
        tests: [result],
      }),
    );
    this.toast(
      `已记录 ${prismPd} PD ${dir}（${eye === "imageRight" ? "右" : "左"}眼）→ 测得 ${summary.medianAbsPd.toFixed(1)} PD`,
    );
  }

  /** 导出与 validate_offline.py 兼容的金标准表 */
  private exportPrismCsv(): void {
    if (!this.prismTrials.length) return;
    const lines = ["case_id,ref_pd,prism_pd,eye,dir,measured_pd"];
    for (const t of this.prismTrials) {
      lines.push(
        [t.caseId, t.prismPd, t.prismPd, t.eye, t.dir, t.measuredPd.toFixed(2)].join(","),
      );
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ground_truth-${this.currentCaseId()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.toast(`已导出 ${this.prismTrials.length} 档金标准表`);
  }

  // ------------------------------------------------------------ 输出目录

  private async pickOutDir(): Promise<void> {
    if (!supportsDirectoryWrite()) {
      this.toast("此浏览器不支持直接写文件夹，请用「导出」下载", "bad");
      return;
    }
    const dir = await pickDirectory();
    if (!dir) {
      this.toast("已取消选择");
      return;
    }
    this.outDir = dir;
    await saveDirHandle(dir);
    $("outDirLabel").textContent = `输出目录：${dir.name}`;
    $("outDirLabel").className = "hint tiny ok-text";
    this.toast(`会话将自动写入「${dir.name}」`);
  }

  private currentCaseId(): string {
    return $<HTMLInputElement>("inCaseId").value.trim() || "anon";
  }

  private wantFrames(): boolean {
    return $<HTMLInputElement>("inRawLog").checked;
  }

  /** 有目录就直写，没有就下载。返回实际方式，用于提示。 */
  private async persist(name: string, payload: unknown): Promise<void> {
    const wrote = await writeJsonTo(this.outDir, name, payload);
    if (!wrote) downloadJson(payload, name);
  }

  // ------------------------------------------------------------ 摄像头

  private async startCamera(): Promise<void> {
    const btn = $<HTMLButtonElement>("btnCam");
    const hint = $("stageHint");
    const say = (s: string) => {
      hint.style.display = "grid";
      hint.textContent = s;
    };

    // 逐项前置检查，失败时给出确切原因，而不是静默
    if (!navigator.mediaDevices?.getUserMedia) {
      const host = location.hostname;
      const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      const why = window.isSecureContext
        ? "此浏览器不支持 getUserMedia"
        : `当前不是安全上下文（${location.origin}）`;
      $("pillCam").textContent = "摄像头 · 不可用";
      $("pillCam").className = "pill bad";
      hint.style.display = "grid";

      if (!window.isSecureContext && !loopback) {
        // 典型情况：点了 Vite 打印的 Network 地址（局域网 IP），
        // 浏览器把非 localhost 的 http 判为不安全，摄像头接口直接不存在。
        const alt = `http://localhost:${location.port || "5173"}/`;
        hint.innerHTML =
          `无法访问摄像头：${why}<br>` +
          `浏览器只允许 localhost 或 https 使用摄像头。<br><br>` +
          `本机请改用 <a href="${alt}" style="color:#4ea1ff">${alt}</a><br>` +
          `<span style="opacity:.7;font-size:12px">平板/手机要用局域网地址的话，需以 https 启动（npm run dev:https）</span>`;
      } else {
        hint.textContent = `无法访问摄像头：${why}`;
      }
      this.toast(`无法访问摄像头：${why}`, "bad");
      return;
    }

    btn.disabled = true;
    say("正在请求摄像头权限…请在上方地址栏点「允许」");
    this.toast("正在请求摄像头权限，请在上方地址栏点「允许」");

    try {
      // 先释放旧流。上一次会话残留的轨道会占住设备，
      // 症状是"再点一次就打不开"、而且不一定报错。
      const stale = this.video.srcObject as MediaStream | null;
      if (stale) {
        stale.getTracks().forEach((tr) => {
          try {
            tr.stop();
          } catch {
            /* 已经停了就算了 */
          }
        });
        this.video.srcObject = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, min: 30 },
        },
      });
      this.video.srcObject = stream;
      await this.video.play().catch(() => undefined);
      $("pillCam").textContent = "摄像头 · 开";
      $("pillCam").className = "pill ok";

      if (!this.tracker.ready) {
        say("模型加载中…（首次约 3–8 秒）");
        $("pillModel").textContent = "模型 · 加载中";
        $("pillModel").className = "pill warn";
        await this.tracker.init((s) => {
          $("pillModel").textContent = `模型 · ${s}`;
        });
        $("pillModel").textContent = "模型 · 就绪";
        $("pillModel").className = "pill ok";
        $<HTMLButtonElement>("btnCalib").disabled = false;
      }
      hint.style.display = "none";
      this.toast("就绪。先去「导出」页选输出文件夹，再开始校准");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      let msg = err instanceof Error ? err.message : String(err);
      if (name === "NotAllowedError") {
        msg = "权限被拒绝。点地址栏左侧的图标 → 允许摄像头，然后刷新页面";
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        msg = "没有找到可用摄像头，或被其他程序占用（微信/钉钉/会议软件常见）";
      } else if (name === "NotReadableError") {
        msg = "摄像头被其他程序占用，先关掉占用它的软件";
      } else if (/model|wasm|fetch|Failed to fetch/i.test(msg)) {
        msg = `模型/wasm 加载失败：${msg}。可在项目目录运行 npm run prepare-assets 重新准备`;
      }
      // 把 DOMException 的名字也显示出来：友好文案便于用户，错误名便于定位。
      const detail = name ? `（${name}）` : "";
      say(`启动失败：${msg}${detail}`);
      this.toast(`启动失败：${msg}${detail}`, "bad");
      $("pillCam").textContent = "摄像头 · 失败";
      $("pillCam").className = "pill bad";
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ 质量判定

  /** 判定规则与使用模式共用（core.assessFrame），保证两个模式语义一致 */
  private assess(frame: FaceFrame): FrameQuality {
    return assessFrame(frame, this.cfg, this.calib, this.geom);
  }

  // ------------------------------------------------------------ 主循环

  private loop = (ts: number): void => {
    requestAnimationFrame(this.loop);
    if (++this.diagTick % 20 === 0) this.updateDiag();
    if (!this.tracker.ready || this.video.readyState < 2) return;

    const frame = this.tracker.detect(this.video, ts);
    if (!frame) return;

    if (this.lastTick) {
      const dt = ts - this.lastTick;
      if (dt > 0) this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    }
    this.lastTick = ts;

    const q = this.assess(frame);
    this.latestFrame = frame;
    this.latestQuality = q;

    this.drawOverlay(frame, q);
    this.updatePills(frame, q);
    this.pushFrame(frame, q);
  };

  private pushFrame(frame: FaceFrame, q: FrameQuality): void {
    const rec = makeRecord(
      this.runState.tInStep,
      performance.now() - this.testStart,
      this.runState.step?.id ?? null,
      frame,
      q,
    );

    // 空闲时屏幕上没有靶点，不能拿上一次的靶点当参照，否则偏斜读数全是假的
    const active = this.runState.active && this.runState.step !== null;
    const targetMm = active ? this.targetMmFromNm(this.runState.targetNm) : null;
    // 预测点任何时候都算——训练游戏没有「靶点」，但仍然需要当前注视方向
    fillPredictions(rec, this.calib, this.geom, targetMm);

    this.live.push(rec);
    // 按帧数封顶（≈300 帧，30–60fps 下约 5–10 秒），避免空闲时长跑吃内存
    if (this.live.length > 300) this.live.splice(0, this.live.length - 300);

    if (this.runState.active && this.runState.collect) {
      this.frames.push(rec);
      this.log.push(rec);
      if (this.log.length > 30000) this.log.splice(0, this.log.length - 30000);
    }

    this.updateReadout();
  }

  private targetMmFromNm(nm: Pt): Pt {
    return {
      x: (nm.x - 0.5) * this.runner.width * this.geom.mmPerPx,
      y: (nm.y - 0.5) * this.runner.height * this.geom.mmPerPx,
    };
  }

  private updateReadout(): void {
    const ratio = this.total ? (this.valid / this.total) * 100 : 0;
    this.total++;
    if (this.latestQuality?.ok) this.valid++;
    if (this.total > 1e6) {
      this.total = Math.round(this.total / 2);
      this.valid = Math.round(this.valid / 2);
    }
    $("roQuality").textContent = this.total ? ratio.toFixed(0) : "--";

    if (!this.runState.active) {
      $("roDevL").textContent = "--";
      $("roDevR").textContent = "--";
      $("roBcea").textContent = "--";
      return;
    }

    const win = this.live.filter(
      (f) => f.quality.ok && f.devPd.imageLeft && f.devPd.imageRight && f.devDeg.imageLeft,
    );
    if (win.length >= 3) {
      for (const side of EYES) {
        const vals = win.map((f) => f.devPd[side]!.x);
        const med = M.quantile(vals, 0.5);
        const el = side === "imageLeft" ? $("roDevL") : $("roDevR");
        el.textContent = `${med >= 0 ? "+" : ""}${med.toFixed(1)}`;
      }
      const pts = win.map((f) => ({ x: f.devDeg.imageLeft!.x, y: f.devDeg.imageLeft!.y }));
      const area = M.bcea(pts);
      $("roBcea").textContent = Number.isFinite(area) ? area.toFixed(2) : "--";
    }
  }

  private updatePills(frame: FaceFrame, q: FrameQuality): void {
    $("pillFps").textContent = `${this.fps.toFixed(0)} fps`;
    $("pillDist").textContent = `${(q.estDistanceMm / 10).toFixed(0)} cm`;
    $("pillDist").className = `pill ${q.ok ? "ok" : "warn"}`;
    const deg = (r: number) => (r * M.RAD2DEG).toFixed(0);
    $("pillPose").textContent = `yaw ${deg(frame.head.yaw)}° · pitch ${deg(frame.head.pitch)}°`;
    $("pillPose").className = `pill ${
      Math.abs(frame.head.yaw) > 18 * M.DEG2RAD || Math.abs(frame.head.pitch) > 18 * M.DEG2RAD
        ? "warn"
        : "ok"
    }`;
  }

  /** 诊断面板：把"为什么没反应"直接写在屏幕上，省掉猜。 */
  private updateDiag(): void {
    const el = document.getElementById("diag");
    if (!el) return;
    const v = this.video;
    const media = !!navigator.mediaDevices?.getUserMedia;
    const rows = [
      `安全上下文 <b>${window.isSecureContext ? "是" : "否"}</b>　getUserMedia <b>${media ? "可用" : "不可用"}</b>`,
      `媒体流 <b>${v.srcObject ? "已绑定" : "无"}</b>　视频 <b>${v.videoWidth || 0}×${v.videoHeight || 0}</b> · readyState <b>${v.readyState}</b>`,      `模型 <b>${this.tracker.ready ? "就绪" : "未就绪"}</b>　人脸 <b>${this.latestFrame ? "有" : "无"}</b>　帧率 <b>${this.fps ? this.fps.toFixed(0) : "--"}</b>`,
    ];
    if (v.srcObject && v.videoWidth === 0) {
      rows.push(`<b style="color:var(--warn)">流已绑定但无画面 → 等 1–2 秒；仍无则被其他程序占用</b>`);
    }
    if (this.tracker.ready && v.videoWidth > 0 && !this.latestFrame) {
      rows.push(`<b style="color:var(--warn)">看不到人脸 → 检查光线、距离、镜头遮挡</b>`);
    }
    if (this.latestFrame && this.latestQuality && !this.latestQuality.ok) {
      rows.push(
        `<b style="color:var(--warn)">质量门控未通过：${this.latestQuality.flags.join(" / ")}</b>`,
      );
    }

    // 虹膜抖动：最近 ~2 秒内 u 的标准差。戴上眼镜前后对比这个数，
    // 就能判断滤片有没有干扰关键点（红片/绿片会让两眼图像变成纯色，是明显的域偏移）。
    const win = this.live.slice(-60);
    if (win.length > 15) {
      const jitter = (side: EyeKey): number => {
        const vals = win
          .map((f) => f.feat?.[side]?.[1])
          .filter((x): x is number => typeof x === "number");
        if (vals.length < 10) return NaN;
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1));
      };
      const jl = jitter("imageLeft");
      const jr = jitter("imageRight");
      if (Number.isFinite(jl) && Number.isFinite(jr)) {
        // 参考量级：不戴眼镜时约 0.001–0.002
        const bad = jl > 0.004 || jr > 0.004;
        rows.push(
          `虹膜抖动 <b style="color:${bad ? "var(--warn)" : "var(--good)"}">左 ${jl.toFixed(5)} · 右 ${jr.toFixed(5)}</b>` +
            `（不戴眼镜约 0.001–0.002；戴眼镜后变大说明滤片在干扰）`,
        );
      }
    }
    el.innerHTML = rows.join("<br>");
  }

  // ------------------------------------------------------------ 叠加层

  private drawOverlay(frame: FaceFrame, q: FrameQuality): void {
    drawFaceOverlay(this.overlay, frame, q.ok);
  }

  private drawGazeDots(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const rec = this.live[this.live.length - 1];
    if (!rec) return;
    for (const side of EYES) {
      const p = rec.predMm[side];
      if (!p) continue;
      const x = w / 2 + p.x / this.geom.mmPerPx;
      const y = h / 2 + p.y / this.geom.mmPerPx;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = COLOR[side];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = COLOR[side];
      ctx.fill();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ 校准

  private async runStepsWithRecording(
    steps: Step[],
    showGazeDots = false,
  ): Promise<{ ok: boolean; collected: FrameRecord[] }> {
    this.frames = [];
    this.runState.active = true;
    this.runState.step = null;
    this.runState.collect = false;
    this.testStart = performance.now();

    const ok = await this.runner.run(steps, {
      onStep: (step) => {
        this.runState.step = step;
        this.runState.tInStep = 0;
        this.runState.collect = false;
      },
      onFrame: (info: FrameInfo) => {
        this.runState.step = info.step;
        this.runState.tInStep = info.tInStep;
        this.runState.targetNm = info.targetNm;
        this.runState.collect =
          !!info.step.collect && info.tInStep >= (info.step.settleMs ?? 0);
      },
      overlay: (ctx, w, h) => {
        // 只在测试阶段画注视点。校准期间画会用"旧模型"的预测，
        // 既误导又会让人以为校准在跟着眼睛走。
        if (showGazeDots && this.calib?.ready) this.drawGazeDots(ctx, w, h);
      },
    });

    this.runState.active = false;
    this.runState.collect = false;
    const collected = this.frames;
    this.frames = [];
    return { ok, collected };
  }

  private async runCalibration(): Promise<void> {
    if (this.busy) return;
    if (!this.tracker.ready) {
      this.toast("请先启动摄像头", "bad");
      return;
    }
    this.busy = true;
    this.setButtons(false);
    try {
      const steps = [
        ...buildWarmupSteps(),
        ...buildCalibrationSteps(),
        buildValidationStep(),
      ];
      const first = await this.runStepsWithRecording(steps);
      if (!first.ok) {
        this.toast("校准已中止", "bad");
        return;
      }

      let frames = first.collected;
      let fit = await this.fitCalibration(frames);
      if (!fit) return;

      // 自动重测漂移点。
      // 实测：13 个点里坏 1–2 个，中位误差会从约 1.7° 抬到 3.2°；
      // 而整轮重做要 30 秒。只补测坏的那几个点，代价 2–5 秒，性价比最高。
      if (fit.badSteps.length > 0 && fit.badSteps.length <= 4) {
        const badSteps = fit.badSteps;
        const names = badSteps.map((s) => Number(s.split("-")[1]) + 1).join("、");
        this.toast(`第 ${names} 点没盯稳，自动重测这几个点…`);
        const retrySteps = buildCalibrationSteps().filter((s) => badSteps.includes(s.id));
      const retry = await this.runStepsWithRecording(retrySteps, false);
        if (retry.ok && retry.collected.length > 0) {
          const replace = new Set(badSteps);
          frames = frames
            .filter((f) => !replace.has(f.step ?? ""))
            .concat(retry.collected);
          const again = await this.fitCalibration(frames, true);
          if (again) fit = again;
        }
      }

      $<HTMLButtonElement>("btnDeviation").disabled = false;
      $<HTMLButtonElement>("btnFixation").disabled = false;
      $<HTMLButtonElement>("btnPursuit").disabled = false;
      $<HTMLButtonElement>("btnRepeat").disabled = false;
      $<HTMLButtonElement>("btnGame").disabled = false;
      $<HTMLButtonElement>("btnExport").disabled = false;

      // 校准一结束就落盘，这样即使后面的测试出问题，校准数据也不丢
      await this.persist(
        `stargazer-${this.currentCaseId()}-calibration-${stamp()}.json`,
        buildExport({
          caseId: this.currentCaseId(),
          geom: this.geom,
          diagonalIn: this.cfg.diagonalIn,
          fovDeg: this.cfg.fovDeg,
          ipdMm: this.cfg.ipdMm,
          calibration: this.calibResult,
          tests: [],
          // 校准帧永远带上：这是诊断映射问题唯一的原始依据，不能靠勾选框
          frames,
        }),
      );

      const head =
        fit.loocvMedian !== null
          ? `交叉验证 ${fit.loocvMedian.toFixed(2)}°`
          : "已完成";
      const msg =
        fit.heldOut === null
          ? `校准完成｜${head}`
          : `校准完成｜${head}｜单点留出 ${fit.heldOut.toFixed(2)}°`;
      this.toast(msg, fit.loocvMedian !== null && fit.loocvMedian > 2.5 ? "bad" : undefined);
    } catch (err) {
      this.toast(`校准失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  /**
   * 用一批采集帧拟合校准并刷新面板。
   * 返回 null 表示数据不足；否则给出漂移点列表，供自动重测使用。
   */
  private async fitCalibration(
    collected: FrameRecord[],
    retried = false,
  ): Promise<{
    badSteps: string[];
    loocvMedian: number | null;
    heldOut: number | null;
  } | null> {
    const fit = fitCalibrationCore(collected, this.geom);
    if (!fit) {
      const usable = collected.filter((f) => f.quality.ok && f.feat && f.targetMm).length;
      this.toast(`有效样本过少（${usable}），请检查光线与距离`, "bad");
      return null;
    }
    const { calib } = fit;
    const fitResidualDeg = fit.result.fitResidualDeg;
    const loocvMedian = fit.loocvMedian;
    const loocvMax = fit.result.loocvMaxDeg;
    const heldOut = fit.heldOut;
    const looPerPoint = fit.looPerPoint;
    this.calib = calib;
    this.calibResult = fit.result;

    $("calibState").innerHTML = `<span>状态</span><b style="color:var(--good)">已校准</b>`;
    $("calibResidualRow").hidden = false;
    $("calibResidual").textContent = `${fitResidualDeg.toFixed(2)}°`;
    $("calibLooRow").hidden = loocvMedian === null;
    if (loocvMedian !== null) {
      $("calibLoo").textContent = `${loocvMedian.toFixed(2)}° / ${(loocvMax ?? NaN).toFixed(2)}°`;
      $("calibLoo").style.color =
        loocvMedian <= 2 ? "var(--good)" : loocvMedian <= 3 ? "var(--warn)" : "var(--bad)";
    }
    $("calibHeldoutRow").hidden = heldOut === null;
    if (heldOut !== null) {
      $("calibHeldout").textContent = `${heldOut.toFixed(2)}°`;
      $("calibHeldout").style.color =
        heldOut <= 1.5 ? "var(--good)" : heldOut <= 2.5 ? "var(--warn)" : "var(--bad)";
    }

    // 把交叉验证直接换算成"绝对偏斜量还能信到什么程度"。
    // 这比一句"不适合做偏斜"有用得多：它给出了数字和前提。
    $("calibUncRow").hidden = loocvMedian === null;
    if (loocvMedian !== null) {
      const uncPd = 100 * Math.tan(((1.96 * loocvMedian) * Math.PI) / 180);
      $("calibUnc").textContent = `±${uncPd.toFixed(1)} PD（跨会话不可比）`;
      $("calibUnc").style.color =
        uncPd <= 8 ? "var(--good)" : uncPd <= 14 ? "var(--warn)" : "var(--bad)";
    }

    // 只有在真的崩了（整体偏差过大）时才拦人；
    // 个别点偏差只提示，不阻断——实测正常校准也会有 1–2 个点偏大。
    const grossFail = loocvMedian !== null && loocvMedian > 5;
    const bad = looPerPoint
      .filter((p) => p.maxDeg > 4)
      .sort((a, b) => b.maxDeg - a.maxDeg);
    const warn = $("calibWarn");
    if (grossFail) {
      warn.hidden = false;
      warn.style.borderColor = "rgba(255,107,107,0.6)";
      warn.innerHTML =
        `<b style="color:var(--bad)">本轮偏差偏大，建议整轮重做</b><br>` +
        `交叉验证中位 ${loocvMedian.toFixed(2)}°，超出可用范围（&gt;5.0°）。<br>` +
        `优先检查：距离是否用尺量准、摄像头是否在眼平、正面有没有强光或阴影。<br>` +
        `仍偏大就重做校准。`;
    } else if (bad.length) {
      warn.hidden = false;
      warn.style.borderColor = "rgba(255,180,84,0.5)";
      warn.innerHTML =
        `<b style="color:var(--warn)">${retried ? "重测后仍偏差较大" : "偏差较大"}的点：</b><br>` +
        bad
          .map(
            (p) =>
              `第 ${Number(p.step.split("-")[1]) + 1} 点 · 交叉验证 ${p.maxDeg.toFixed(1)}°`,
          )
          .join("<br>") +
        `<br><span style="opacity:.75">这几个点单独重测即可，不必整轮重来。<br>` +
        `不影响注视稳定性、追随、偏斜事件；只让绝对偏斜量更不确定。</span>`;
    } else {
      warn.hidden = true;
    }

    return { badSteps: bad.map((b) => b.step), loocvMedian, heldOut };
  }

  // ------------------------------------------------------------ 测试

  private async runTest(
    kind: "deviation" | "fixation" | "pursuit" | "repeatability",
  ): Promise<void> {
    if (this.busy) return;
    if (!this.calib?.ready) {
      this.toast("请先完成校准", "bad");
      return;
    }
    this.busy = true;
    this.setButtons(false);
    try {
      const steps =
        kind === "deviation"
          ? buildDeviationSteps()
          : kind === "fixation"
            ? buildFixationSteps()
            : kind === "pursuit"
              ? buildPursuitSteps()
              : buildRepeatabilitySteps();
      const { ok, collected } = await this.runStepsWithRecording(steps);
      if (!ok) {
        this.toast("测试已中止", "bad");
        return;
      }
      const usable = collected.filter((f) => f.quality.ok);
      if (usable.length < 20) {
        this.toast(`有效帧过少（${usable.length}），结果不可靠`, "bad");
        return;
      }
      const result = summarizeTest(kind, collected, this.geom.distanceMm);
      this.results.push(result);
      this.renderResults();
      await this.recordPrismTrial(result);
      await this.persist(
        `stargazer-${this.currentCaseId()}-${kind}-${stamp()}.json`,
        buildExport({
          caseId: this.currentCaseId(),
          geom: this.geom,
          diagonalIn: this.cfg.diagonalIn,
          fovDeg: this.cfg.fovDeg,
          ipdMm: this.cfg.ipdMm,
          calibration: this.calibResult,
          tests: [result],
          frames: this.wantFrames() ? collected : undefined,
        }),
      );
      this.toast(`${labelOf(kind)} 完成，有效帧 ${usable.length}/${collected.length}`);
    } catch (err) {
      this.toast(`测试失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  private setButtons(enabled: boolean): void {
    const ids = ["btnCalib", "btnDeviation", "btnFixation", "btnPursuit", "btnRepeat", "btnGame"];
    for (const id of ids) {
      const el = $<HTMLButtonElement>(id);
      if (!enabled) {
        el.disabled = true;
      } else {
        if (id === "btnCalib") el.disabled = !this.tracker.ready;
        else el.disabled = !this.calib?.ready;
      }
    }
  }

  // ------------------------------------------------------------ 结果渲染

  private renderResults(): void {
    const host = $("testResults");
    const prism = this.prismTrials.length
      ? `<div class="result-card"><h4>棱镜对照（${this.prismTrials.length} 档）</h4><table>${this.prismTrials
          .map(
            (t) =>
              `<tr><td>${t.prismPd} PD ${t.dir} · ${t.eye === "imageRight" ? "右" : "左"}眼</td><td>测得 ${t.measuredPd.toFixed(1)} PD</td></tr>`,
          )
          .join(
            "",
          )}</table><div class="hint tiny" style="margin:8px 0 0">点「导出 ground_truth.csv」后可做一致性分析</div></div>`
      : "";
    host.innerHTML =
      prism +
      this.results
        .slice()
        .reverse()
        .map((r) => {
        if (r.kind === "deviation") {
          return card(
            "偏斜监测",
            r,
            r.eyes.map((e) => [
              eyeName(e.eye),
              `基线 ${fmt(e.baselinePd)} PD（含模型偏置）｜偏斜占比 ${pct(e.episodeDuty)}｜` +
                `事件 ${e.episodeCount} 次｜最长 ${(e.maxEpisodeMs / 1000).toFixed(1)}s｜` +
                `P95 ${fmt(e.p95AbsPd)} PD`,
            ]),
          );
        }
        if (r.kind === "fixation") {
          return card(
            "注视稳定性",
            r,
            r.eyes.map((e) => [
              eyeName(e.eye),
              `BCEA₁σ ${fmt(e.bcea68)} deg²（去极端 5% 后 ${fmt(e.bcea68Trim)}）｜` +
                `1° 内 ${pct(e.pctWithin1)}｜RMS ${fmt(e.rmsDeg)}°｜注视 ${e.fixationCount} 段`,
            ]),
          );
        }
        if (r.kind === "stereo") {
          const th = r.thresholdArcsec;
          const verdict =
            th === null
              ? "未测出"
              : th <= 60
                ? "正常"
                : th <= 100
                  ? "接近正常"
                  : th <= 200
                    ? "轻度减退"
                    : th <= 400
                      ? "明显减退"
                      : "接近缺失";
          return card("立体视锐度", r, [
            ["阈值", th === null ? "未测出" : `${th} 弧秒`],
            ["判读", verdict],
            ["测试点", `${r.trials} 次 · 正确 ${r.correct} · 反转 ${r.reversals}`],
            ["分辨率下限", `${r.floorArcsec.toFixed(0)} 弧秒（受屏幕像素限制）`],
          ]);
        }
        if (r.kind === "game") {
          const rate = r.trials ? (100 * r.hits) / r.trials : NaN;
          return card("火箭追星星 · 训练", r, [
            ["得分", `${r.score}　追上 ${r.hits} / ${r.trials}`],
            ["命中率", Number.isFinite(rate) ? `${rate.toFixed(0)}%` : "--"],
            ["平均捕获耗时", `${fmt(r.meanCaptureMs / 1000)} s`],
            ["注视误差 中位 / P90", `${fmt(r.medianErrorDeg)}° / ${fmt(r.p90ErrorDeg)}°`],
            ["追上瞬间误差", `${fmt(r.meanHitErrorDeg)}°`],
            [
              "加油 / 锚定修正",
              `加油 ${r.refuels} 次 · ` +
                `<b style="color:${Math.max(r.anchorLeftDeg, r.anchorRightDeg) > 2 ? "var(--warn)" : "var(--good)"}">` +
                `左 ${fmt(r.anchorLeftDeg)}° · 右 ${fmt(r.anchorRightDeg)}°</b>`,
            ],
            [
              "分视设置",
              `优势眼 ${r.dominantEye === "imageRight" ? "右" : "左"} · 对比度 ${(r.contrastRatio * 100).toFixed(0)}%`,
            ],
            [
              "辅助护栏",
              (() => {
                // 这是"辅助有没有过头"的在线护栏：
                // 视线几乎没动就命中的比例，是自动捕获的直接证据。
                const stillRate = r.hits ? r.stillHits / r.hits : 0;
                const over = stillRate > 0.1;
                const flags: string[] = [];
                if (r.anchorRelaxed) flags.push("锚定降级");
                if (r.spawnRelaxed > 0) flags.push(`撒点降级 ${r.spawnRelaxed}`);
                return (
                  `未移动命中 ${r.stillHits}/${r.hits}（${(stillRate * 100).toFixed(0)}%）` +
                  ` · 磁吸生效 ${r.assistHits}` +
                  (over ? `　<b style="color:var(--bad)">超过 10%，辅助过头</b>` : "") +
                  (flags.length ? `　<span style="opacity:.75">${flags.join(" · ")}</span>` : "")
                );
              })(),
            ],
          ]);
        }
        if (r.kind === "repeatability") {
          return card(
            "重复性 · 噪声底线",
            r,
            r.eyes.flatMap((e) => {
              const ex = e.excluded.length
                ? `｜剔除第 ${e.excluded.map((x) => x.index + 1).join("、")} 轮`
                : "";
              const drift = Number.isFinite(e.trendPdPerRound)
                ? `｜趋势 ${e.trendPdPerRound >= 0 ? "+" : ""}${e.trendPdPerRound.toFixed(2)} PD/轮`
                : "";
              const row: [string, string] = [
                eyeName(e.eye),
                `中位 ${fmt(e.medianPd)} PD｜SD ${fmt(e.sdPd)}` +
                  (e.excluded.length ? `（原始 ${fmt(e.rawSdPd)}）` : "") +
                  drift +
                  `｜单次 MDC95 ${fmt(e.mdc95Pd)}｜` +
                  `<b style="color:${e.mdc95Avg3Pd > 5 ? "var(--bad)" : "var(--good)"}">3 轮平均后 ${fmt(e.mdc95Avg3Pd)} PD</b>` +
                  `｜保留 ${e.keptBlocks}/${e.blocks} 轮${ex}`,
              ];
              const extra: Array<[string, string]> = [];
              if (e.excluded.length) {
                extra.push([
                  "剔除原因",
                  e.excluded.map((x) => `第 ${x.index + 1} 轮：${x.reason}`).join("；"),
                ]);
              }
              if (Math.abs(e.trendPdPerRound) > 1) {
                extra.push([
                  "漂移警告",
                  `读数在单向漂移（${e.trendPdPerRound.toFixed(1)} PD/轮），` +
                    `这一轮的 SD 主要来自漂移而不是随机噪声，` +
                    `不能当作噪声底线，也不应据此计算 MDC。`,
                ]);
              }
              return [row, ...extra];
            }),
          );
        }
        return card(
          "水平追随",
          r,
          r.eyes.map((e) => [
            eyeName(e.eye),
            `增益 ${fmt(e.gain)}｜残差 ${fmt(e.rmseDeg)}°｜滞后 ${Number.isFinite(e.lagMs) ? e.lagMs.toFixed(0) : "--"} ms`,
          ]),
        );
      })
      .join("");
  }

  // ------------------------------------------------------------ 导出

  private async doExport(): Promise<void> {
    const caseId = this.currentCaseId();
    const payload = buildExport({
      caseId,
      geom: this.geom,
      diagonalIn: this.cfg.diagonalIn,
      fovDeg: this.cfg.fovDeg,
      ipdMm: this.cfg.ipdMm,
      calibration: this.calibResult,
      tests: this.results,
      frames: this.wantFrames() ? this.log : undefined,
    });
    const name = `stargazer-${caseId}-session-${stamp()}.json`;
    await this.persist(name, payload);
    this.toast(
      this.outDir ? `已写入「${this.outDir.name}」/${name}` : "已下载（不含任何视频/图像）",
    );
  }

  // ------------------------------------------------------------ 训练游戏

  /** 当前注视点：双眼分别给出，由游戏选"正在注视的那只眼" */
  private currentGaze(): { left: Pt | null; right: Pt | null; valid: boolean } | null {
    const rec = this.live[this.live.length - 1];
    if (!rec) return null;
    const left = rec.predMm.imageLeft ?? null;
    const right = rec.predMm.imageRight ?? null;
    if (!left && !right) return null;

    // 游戏用**宽松**门控（与使用模式同一实现，见 core.gameGazeValid）：
    // 只有「虹膜被遮挡」「脸太小」「没人脸」才丢帧。头位/距离的小幅变化
    // 交给游戏内的中心锚定与滤波兜底——冻结比轻微失真糟得多。
    const valid = gameGazeValid(rec.quality);
    return { left, right, valid };
  }

  private async runGame(): Promise<void> {
    if (this.busy) return;
    if (!this.tracker.ready || !this.calib?.ready) {
      this.toast("请先启动摄像头并完成校准", "bad");
      return;
    }
    this.busy = true;
    this.setButtons(false);
    try {
      const dominantEye = $<HTMLSelectElement>("gameDominant").value as EyeKey;
      const glasses = $<HTMLSelectElement>("gameGlasses").value as GlassesKind;
      const contrastRatio =
        Math.max(0.05, Math.min(1, (Number($<HTMLInputElement>("gameRatio").value) || 45) / 100));
      const durationMs = (Number($<HTMLSelectElement>("gameDuration").value) || 60) * 1000;

      const game = new GazeGame({
        canvas: $<HTMLCanvasElement>("testCanvas"),
        hud: $("testHud"),
        promptEl: $("testPrompt"),
        progressEl: document.querySelector("#testProgress i") as HTMLElement,
        geom: this.geom,
        durationMs,
        dominantEye,
        contrastRatio,
        glasses,
        getGaze: () => this.currentGaze(),
      });

      const r = await game.run();
      if (!r) {
        this.toast("训练已中止");
        return;
      }

      this.results.push({ kind: "game", startedAt: new Date().toISOString(), ...r });
      this.renderResults();

      await this.persist(
        `stargazer-${this.currentCaseId()}-game-${stamp()}.json`,
        buildExport({
          caseId: this.currentCaseId(),
          geom: this.geom,
          diagonalIn: this.cfg.diagonalIn,
          fovDeg: this.cfg.fovDeg,
          ipdMm: this.cfg.ipdMm,
          calibration: this.calibResult,
          tests: [this.results[this.results.length - 1]],
        }),
      );

      const rate = r.trials ? (100 * r.hits) / r.trials : NaN;
      this.toast(
        `训练结束：得分 ${r.score}，命中率 ${Number.isFinite(rate) ? rate.toFixed(0) : "--"}%`,
      );
    } catch (err) {
      this.toast(`训练失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  // ------------------------------------------------------------ 立体视锐度

  private async runStereo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const glasses = $<HTMLSelectElement>("gameGlasses").value as GlassesKind;
      if (!requireDichoptic(glasses)) {
        this.toast("立体视必须两只眼看到不同图像，请先选一种眼镜（红青/红绿/红蓝）", "bad");
        return;
      }
      const t0 = performance.now();
      const test = new StereoTest({
        canvas: $<HTMLCanvasElement>("testCanvas"),
        hud: $("testHud"),
        promptEl: $("testPrompt"),
        progressEl: document.querySelector("#testProgress i") as HTMLElement,
        geom: this.geom,
        glasses,
      });
      const r = await test.run();
      if (!r) {
        this.toast("立体视测试已中止");
        return;
      }
      const dur = performance.now() - t0;

      this.results.push({
        kind: "stereo",
        startedAt: new Date().toISOString(),
        durationMs: dur,
        validRatio: 1,
        ...r,
      });
      this.renderResults();

      await this.persist(
        `stargazer-${this.currentCaseId()}-stereo-${stamp()}.json`,
        buildExport({
          caseId: this.currentCaseId(),
          geom: this.geom,
          diagonalIn: this.cfg.diagonalIn,
          fovDeg: this.cfg.fovDeg,
          ipdMm: this.cfg.ipdMm,
          calibration: this.calibResult,
          tests: [this.results[this.results.length - 1]],
        }),
      );

      this.toast(
        r.thresholdArcsec === null
          ? "立体视未测出（最易档也没通过）"
          : `立体视锐度 ≈ ${r.thresholdArcsec} 弧秒`,
      );
    } catch (err) {
      this.toast(`立体视测试失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  private async runStereoCheck(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const glasses = $<HTMLSelectElement>("gameGlasses").value as GlassesKind;
      if (!requireDichoptic(glasses)) {
        this.toast("自检需要在真分视下做，请先选一种眼镜", "bad");
        return;
      }
      const test = new StereoTest({
        canvas: $<HTMLCanvasElement>("testCanvas"),
        hud: $("testHud"),
        promptEl: $("testPrompt"),
        progressEl: document.querySelector("#testProgress i") as HTMLElement,
        geom: this.geom,
        glasses,
      });
      await test.preview();
    } catch (err) {
      this.toast(`自检失败：${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  // ------------------------------------------------------------ 杂项

  private toast(msg: string, kind?: "bad"): void {
    const el = $("toast");
    el.textContent = msg;
    el.className = `show ${kind === "bad" ? "bad" : ""}`;
    window.clearTimeout((this as unknown as { _t?: number })._t);
    (this as unknown as { _t?: number })._t = window.setTimeout(() => {
      el.className = "";
    }, 4200);
  }
}

function eyeName(side: EyeKey): string {
  return side === "imageLeft" ? "左（图像）眼" : "右（图像）眼";
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "--";
}

function pct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "--";
}

function labelOf(kind: string): string {
  return kind === "deviation"
    ? "偏斜监测"
    : kind === "fixation"
      ? "注视稳定性"
      : kind === "repeatability"
        ? "重复性"
        : "水平追随";
}

function card(
  title: string,
  r: TestResult,
  rows: Array<[string, string]>,
): string {
  const meta = `有效帧 ${Math.round(r.validRatio * 100)}% · ${(r.durationMs / 1000).toFixed(1)}s`;
  return `<div class="result-card"><h4>${title}</h4><table>${rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("")}</table><div class="hint tiny" style="margin:8px 0 0">${meta}</div></div>`;
}
