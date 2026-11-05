/**
 * 使用模式：给受试者（孩子）和家长看的简化流程。
 *
 * 设计原则：
 *   1. **校准环节一个不少**——热身、13 点、留出验证点、漂移点自动重测、
 *      同一套质量门控，全部复用 core.ts（与调试模式逐行同一实现）；
 *   2. **术语全部收起来**——交叉验证 / MDC95 / BCEA / PD 这些词不出现，
 *      校准结果只翻译成"状态很好 / 还不错 / 建议重试"三档；
 *   3. **导出留给医生**——结算页一个「保存记录」按钮，生成与调试模式
 *      完全同构的 JSON（含校准与游戏结果），不弹任何目录选择；
 *   4. **流程一步一屏**——准备 → 校准 → 游戏，顶部步骤条永远告诉用户在哪。
 *
 * 与调试模式的边界：这里不放任何诊断面板、棱镜对照、原始日志勾选、
 * 输出目录选择。那些属于验证台，不属于训练。
 */
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
  buildCalibrationSteps,
  buildValidationStep,
  buildWarmupSteps,
  type Step,
} from "../protocols";
import { Runner, type FrameInfo } from "./runner";
import {
  assessFrame,
  computeGeom,
  fillPredictions,
  fitCalibration as fitCalibrationCore,
  gameGazeValid,
  makeRecord,
  type Config,
  type FitOutcome,
} from "./core";
import { drawFaceOverlay } from "./overlay";
import { GazeGame, type GameResult } from "../game/gazeGame";
import type { GlassesKind } from "../game/presenter";
import { buildExport, downloadJson, type TestResult } from "../session";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`页面缺少元素 #${id}。index.html 与脚本不同步，请强制刷新后重试`);
  }
  return el as unknown as T;
};

type ScreenName = "welcome" | "setup" | "camera" | "calib" | "game" | "end";

interface RunState {
  active: boolean;
  step: Step | null;
  collect: boolean;
  tInStep: number;
  targetNm: Pt;
}

/** 校准步骤的朋友版提示语。几何与时长和调试模式完全一致，只换文案。 */
function friendlySteps(steps: Step[]): Step[] {
  let calibSeen = 0;
  const total = steps.filter((s) => s.kind === "calib").length;
  return steps.map((s) => {
    if (s.kind === "rest") {
      const i = Number(s.id.split("-")[1]);
      return {
        ...s,
        label:
          i < 5
            ? "练习 · 光点跳到哪，眼睛就看到哪"
            : i < 10
              ? "练习 · 保持住，头不要动"
              : "准备开始正式校准",
      };
    }
    if (s.kind === "calib") {
      calibSeen++;
      return { ...s, label: `看住发光的点 · ${calibSeen} / ${total}` };
    }
    if (s.kind === "validate") return { ...s, label: "最后一个点 · 看住它" };
    return s;
  });
}

export class UsageApp {
  private video = $<HTMLVideoElement>("uVideo");
  private overlay = $<HTMLCanvasElement>("uOverlay");
  private tracker = new FaceTracker();
  private calib: Calibration | null = null;
  private calibResult: CalibrationResult | null = null;
  private calibFrames: FrameRecord[] = [];
  private runner: Runner;
  private cfg: Config;
  private geom: ScreenGeom;

  private latestFrame: FaceFrame | null = null;
  private latestQuality: FrameQuality | null = null;
  private live: FrameRecord[] = [];

  private runState: RunState = {
    active: false,
    step: null,
    collect: false,
    tInStep: 0,
    targetNm: { x: 0.5, y: 0.5 },
  };
  private frames: FrameRecord[] = [];
  private busy = false;
  private gameResults: TestResult[] = [];
  private lastGame: GameResult | null = null;

  constructor() {
    // FOV / 瞳距在使用模式不暴露：65° 与 58mm 是验证台上行的默认值，
    // 距离校验用它们就够；改它们对训练的收益接近于零。
    this.cfg = { diagonalIn: 15.6, distanceCm: 50, fovDeg: 65, ipdMm: 58 };
    this.geom = computeGeom(this.cfg);
    this.runner = new Runner(this.geom);
    this.restoreSetup();
    this.bindUi();
    requestAnimationFrame(this.loop);
  }

  /** 回头客不用每次重填设置（只存本地，不联网） */
  private restoreSetup(): void {
    try {
      const raw = localStorage.getItem("stargazer-usage-setup");
      if (!raw) return;
      const s = JSON.parse(raw) as {
        glasses?: string;
        dominant?: string;
        diagonalIn?: number;
        distanceCm?: number;
        name?: string;
      };
      if (s.glasses) $<HTMLSelectElement>("uGlasses").value = s.glasses;
      if (s.dominant) $<HTMLSelectElement>("uDominant").value = s.dominant;
      if (Number.isFinite(s.diagonalIn)) {
        $<HTMLInputElement>("uDiag").value = String(s.diagonalIn);
      }
      if (Number.isFinite(s.distanceCm)) {
        $<HTMLInputElement>("uDist").value = String(s.distanceCm);
      }
      if (s.name) $<HTMLInputElement>("uName").value = s.name;
    } catch {
      /* 缓存损坏就按默认值跑 */
    }
  }

  // ------------------------------------------------------------ UI 骨架

  private bindUi(): void {
    $("uBtnWelcome").addEventListener("click", () => this.show("setup"));
    $("uBtnSetup").addEventListener("click", () => {
      this.applySetup();
      this.show("camera");
      void this.startCamera();
    });
    $("uBtnBackSetup").addEventListener("click", () => this.show("setup"));
    $("uBtnCalib").addEventListener("click", () => {
      $("uCalibIntro").hidden = false;
      $("uCalibResult").hidden = true;
      this.show("calib");
    });
    $("uBtnCalibStart").addEventListener("click", () => void this.runCalibration());
    $("uBtnRecalib").addEventListener("click", () => void this.runCalibration());
    $("uBtnRecalib2").addEventListener("click", () => void this.runCalibration());
    $("uBtnToGame").addEventListener("click", () => {
      $("uGameIntro").hidden = false;
      $("uGameSummary").hidden = true;
      this.show("game");
    });
    $("uBtnGame").addEventListener("click", () => void this.runGame());
    $("uBtnAgain").addEventListener("click", () => void this.runGame());
    $("uBtnSave").addEventListener("click", () => this.saveSession());
    $("uBtnFinish").addEventListener("click", () => this.show("end"));
    $("uBtnRestart").addEventListener("click", () => this.restart());
  }

  private show(name: ScreenName): void {
    document.querySelectorAll<HTMLElement>(".u-screen").forEach((s) => {
      s.classList.toggle("active", s.id === `uScr${name[0].toUpperCase()}${name.slice(1)}`);
    });
    const stepNo = name === "welcome" || name === "setup" || name === "camera" ? 1 : name === "calib" ? 2 : name === "game" ? 3 : 3;
    document.querySelectorAll<HTMLElement>(".u-step").forEach((s) => {
      s.classList.toggle("active", Number(s.dataset.step) === stepNo);
      s.classList.toggle("done", Number(s.dataset.step) < stepNo);
    });
  }

  private toast(msg: string): void {
    const el = $("uToast");
    el.textContent = msg;
    el.classList.add("show");
    window.clearTimeout((this as unknown as { _t?: number })._t);
    (this as unknown as { _t?: number })._t = window.setTimeout(() => {
      el.classList.remove("show");
    }, 3600);
  }

  // ------------------------------------------------------------ 设置

  private applySetup(): void {
    const diagonalIn = Number($<HTMLInputElement>("uDiag").value) || 15.6;
    const distanceCm = Math.max(20, Math.min(200, Number($<HTMLInputElement>("uDist").value) || 50));
    this.cfg = { ...this.cfg, diagonalIn, distanceCm };
    this.geom = computeGeom(this.cfg);
    this.runner = new Runner(this.geom);
    $("uDistEcho").textContent = String(distanceCm);
    $("uPillDist").textContent = `-- cm`;
    $("uPillDist").className = "pill";
    try {
      localStorage.setItem(
        "stargazer-usage-setup",
        JSON.stringify({
          glasses: $<HTMLSelectElement>("uGlasses").value,
          dominant: $<HTMLSelectElement>("uDominant").value,
          diagonalIn,
          distanceCm,
          name: $<HTMLInputElement>("uName").value.trim(),
        }),
      );
    } catch {
      /* 隐私模式下记不住，不影响本次使用 */
    }
  }

  // ------------------------------------------------------------ 摄像头

  private async startCamera(): Promise<void> {
    const hint = $("uVideoHint");
    const say = (s: string) => {
      hint.style.display = "grid";
      hint.innerHTML = s;
    };
    $("uPill").textContent = "正在打开摄像头…";
    $("uPill").className = "pill warn";

    if (!navigator.mediaDevices?.getUserMedia) {
      $("uPill").textContent = "摄像头不可用";
      $("uPill").className = "pill bad";
      say(
        `这个浏览器不让用摄像头。<br>请换用 Chrome / Edge，或通过 localhost 打开页面` +
          `（点「修改设置」返回上一步也不会丢）`,
      );
      return;
    }

    say("请在弹窗里点「允许」使用摄像头");
    try {
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
      hint.style.display = "none";

      if (!this.tracker.ready) {
        say("第一次打开要加载模型，约 3–8 秒…");
        await this.tracker.init((s) => {
          $("uPill").textContent = s;
        });
      }
      $("uPill").textContent = "摄像头就绪";
      $("uPill").className = "pill ok";
      $<HTMLButtonElement>("uBtnCalib").disabled = false;
      this.toast("看到眼睛后，就可以开始校准了");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      let msg = err instanceof Error ? err.message : String(err);
      if (name === "NotAllowedError") msg = "权限被拒绝。点地址栏左侧的图标 → 允许摄像头，然后刷新页面";
      else if (name === "NotFoundError" || name === "OverconstrainedError") msg = "没有找到可用摄像头";
      else if (name === "NotReadableError") msg = "摄像头被其他程序占用（微信/会议软件常见），先关掉它";
      $("uPill").textContent = "摄像头打开失败";
      $("uPill").className = "pill bad";
      say(`打不开摄像头：${msg}<br><br>点「修改设置」回到上一步，处理好后再来`);
    }
  }

  // ------------------------------------------------------------ 主循环

  private loop = (ts: number): void => {
    requestAnimationFrame(this.loop);
    if (!this.tracker.ready || this.video.readyState < 2) return;

    const frame = this.tracker.detect(this.video, ts);
    if (!frame) {
      // 短暂丢脸不该让预览"变灰说找不到"——保留最后一帧的提示即可
      return;
    }

    const q = assessFrame(frame, this.cfg, this.calib, this.geom);
    this.latestFrame = frame;
    this.latestQuality = q;
    drawFaceOverlay(this.overlay, frame, q.ok);
    this.updateLivePills(frame, q);
    this.pushFrame(frame, q);
  };

  /** 预览页的三个 pill：只给"现在能不能开始校准"用的粗反馈 */
  private updateLivePills(frame: FaceFrame, q: FrameQuality): void {
    const face = $("uPillFace");
    face.textContent = "已看到眼睛";
    face.className = "pill ok";

    const dist = q.estDistanceMm / 10;
    const off = Math.abs(q.estDistanceMm - this.geom.distanceMm) / this.geom.distanceMm;
    $("uPillDist").textContent = `${dist.toFixed(0)} cm${off > 0.15 ? "（偏离设定）" : ""}`;
    $("uPillDist").className = `pill ${off > 0.15 ? "warn" : "ok"}`;

    const deg = (r: number) => Math.round(r * M.RAD2DEG);
    const yaw = deg(frame.head.yaw);
    const pitch = deg(frame.head.pitch);
    const tilted = Math.abs(yaw) > 14 || Math.abs(pitch) > 14;
    $("uPillPose").textContent = `yaw ${yaw}° · pitch ${pitch}°`;
    $("uPillPose").className = `pill ${tilted ? "warn" : "ok"}`;
  }

  private pushFrame(frame: FaceFrame, q: FrameQuality): void {
    const rec = makeRecord(
      this.runState.tInStep,
      performance.now(),
      this.runState.step?.id ?? null,
      frame,
      q,
    );
    const active = this.runState.active && this.runState.step !== null;
    const targetMm = active ? this.targetMmFromNm(this.runState.targetNm) : null;
    fillPredictions(rec, this.calib, this.geom, targetMm);

    this.live.push(rec);
    if (this.live.length > 300) this.live.splice(0, this.live.length - 300);
    if (this.runState.active && this.runState.collect) this.frames.push(rec);
  }

  private targetMmFromNm(nm: Pt): Pt {
    return {
      x: (nm.x - 0.5) * this.runner.width * this.geom.mmPerPx,
      y: (nm.y - 0.5) * this.runner.height * this.geom.mmPerPx,
    };
  }

  /** 游戏用的当前注视点（双眼分别给，宽松门控——与调试模式同一实现） */
  private currentGaze(): { left: Pt | null; right: Pt | null; valid: boolean } | null {
    const rec = this.live[this.live.length - 1];
    if (!rec) return null;
    const left = rec.predMm.imageLeft ?? null;
    const right = rec.predMm.imageRight ?? null;
    if (!left && !right) return null;
    return { left, right, valid: gameGazeValid(rec.quality) };
  }

  // ------------------------------------------------------------ 校准

  private async runSteps(steps: Step[]): Promise<{ ok: boolean; collected: FrameRecord[] }> {
    this.frames = [];
    this.runState.active = true;
    this.runState.step = null;
    this.runState.collect = false;

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
      this.toast("请先打开摄像头");
      return;
    }
    this.busy = true;
    $("uCalibIntro").hidden = false;
    $("uCalibResult").hidden = true;
    try {
      const steps = friendlySteps([
        ...buildWarmupSteps(),
        ...buildCalibrationSteps(),
        buildValidationStep(),
      ]);
      const first = await this.runSteps(steps);
      if (!first.ok) {
        this.toast("已退出校准");
        return;
      }

      let fit = fitCalibrationCore(first.collected, this.geom);
      if (!fit) {
        this.showCalibFail();
        return;
      }
      let framesUsed = first.collected;

      // 与调试模式相同的漂移点自动重测：只补测坏的那几个点，2–5 秒的代价
      if (fit.badSteps.length > 0 && fit.badSteps.length <= 4) {
        this.toast(`有 ${fit.badSteps.length} 个点没盯稳，补测一下…`);
        const retrySteps = friendlySteps(
          buildCalibrationSteps().filter((s) => fit!.badSteps.includes(s.id)),
        );
        const retry = await this.runSteps(retrySteps);
        if (retry.ok && retry.collected.length > 0) {
          const replace = new Set(fit.badSteps);
          const merged = first.collected
            .filter((f) => !replace.has(f.step ?? ""))
            .concat(retry.collected);
          const again = fitCalibrationCore(merged, this.geom);
          if (again) {
            fit = again;
            framesUsed = merged;
          }
        }
      }

      this.calib = fit.calib;
      this.calibResult = fit.result;
      this.calibFrames = framesUsed;
      this.showCalibResult(fit);
    } catch (err) {
      this.toast(`校准出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** 把交叉验证误差翻译成三档人话。判定阈值与调试面板一致（≤3 / ≤5）。 */
  private showCalibResult(fit: FitOutcome): void {
    $("uCalibIntro").hidden = true;
    const card = $("uCalibResult");
    card.hidden = false;
    const title = $("uCalibTitle");
    const msg = $("uCalibMsg");

    const loo = fit.loocvMedian;
    if (loo === null) {
      title.textContent = "这次数据不够";
      msg.innerHTML = "有效样本太少，可能是光线或距离的问题。<br>调整一下，我们再试一次。";
      return;
    }
    if (loo <= 3) {
      title.textContent = "校准完成，状态很好！";
      msg.textContent = "眼睛和屏幕已经对上了。去开火箭吧。";
    } else if (loo <= 5) {
      title.textContent = "校准完成";
      msg.textContent = "状态还不错。如果觉得火箭不太跟眼，可以重新校准一次再来。";
    } else {
      title.textContent = "这次校准不太理想";
      msg.innerHTML =
        "可能是距离没量准、光线不好，或者头动了。<br>调整一下再来一次，会好很多。";
    }
  }

  private showCalibFail(): void {
    $("uCalibIntro").hidden = true;
    $("uCalibResult").hidden = false;
    $("uCalibTitle").textContent = "没看清，再来一次";
    $("uCalibMsg").innerHTML =
      "有效样本太少。请检查：<br>光线是否均匀、脸是否正对摄像头、距离是否还是设定值。";
  }

  // ------------------------------------------------------------ 游戏

  private async runGame(): Promise<void> {
    if (this.busy) return;
    if (!this.tracker.ready || !this.calib?.ready) {
      this.toast("请先完成校准");
      return;
    }
    this.busy = true;
    $("uGameIntro").hidden = false;
    $("uGameSummary").hidden = true;
    try {
      const glasses = $<HTMLSelectElement>("uGlasses").value as GlassesKind;
      const dom = $<HTMLSelectElement>("uDominant").value;
      // 「不确定」按右眼处理——人群里右优势眼居多，且对比度默认 45%，
      // 即便选错也只是训练强度略偏，不会造成伤害。
      const dominantEye: EyeKey = dom === "imageLeft" ? "imageLeft" : "imageRight";

      const game = new GazeGame({
        canvas: $<HTMLCanvasElement>("testCanvas"),
        hud: $("testHud"),
        promptEl: $("testPrompt"),
        progressEl: document.querySelector("#testProgress i") as HTMLElement,
        geom: this.geom,
        durationMs: 60000,
        dominantEye,
        contrastRatio: 0.45,
        glasses,
        getGaze: () => this.currentGaze(),
      });

      const r = await game.run();
      if (!r) {
        this.toast("已退出游戏");
        return;
      }
      this.lastGame = r;
      this.gameResults.push({ kind: "game", startedAt: new Date().toISOString(), ...r });
      this.showGameSummary(r);
    } catch (err) {
      this.toast(`游戏出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private showGameSummary(r: GameResult): void {
    $("uGameIntro").hidden = true;
    const card = $("uGameSummary");
    card.hidden = false;
    $("uSumScore").textContent = String(r.score);
    $("uSumHits").textContent = String(r.trials);
    $("uSumFuel").textContent = String(r.refuels);

    const rate = r.trials ? r.hits / r.trials : 0;
    const msg = $("uGameMsg");
    if (r.trials === 0) {
      msg.textContent = "这一局没有追上星星。没关系，熟练之后火箭就听话了。";
    } else if (rate >= 0.6) {
      msg.textContent = "大部分星星都追上了，眼睛状态在线！";
    } else if (rate >= 0.3) {
      msg.textContent = "追上了一半左右，不错。多练几次会更稳。";
    } else {
      msg.innerHTML = "这次追上的不多。可以重新校准一次，<br>或者放慢速度、专心看星星的正中间。";
    }
  }

  // ------------------------------------------------------------ 保存 / 重置

  private saveSession(): void {
    const name = $<HTMLInputElement>("uName").value.trim() || "anon";
    const payload = buildExport({
      caseId: name,
      geom: this.geom,
      diagonalIn: this.cfg.diagonalIn,
      fovDeg: this.cfg.fovDeg,
      ipdMm: this.cfg.ipdMm,
      calibration: this.calibResult,
      tests: this.gameResults,
      // 校准帧永远带上：这是诊断映射问题唯一的原始依据
      frames: this.calibFrames,
    });
    downloadJson(payload, `stargazer-${name}-session-${stamp()}.json`);
    this.toast("已保存到下载文件夹，可以发给医生");
  }

  private restart(): void {
    this.calib = null;
    this.calibResult = null;
    this.calibFrames = [];
    this.gameResults = [];
    this.lastGame = null;
    this.live = [];
    $("uCalibResult").hidden = true;
    $("uCalibIntro").hidden = false;
    $("uGameSummary").hidden = true;
    $("uGameIntro").hidden = false;
    this.show("welcome");
    $("uPill").textContent = "准备中";
    $("uPill").className = "pill";
  }
}
