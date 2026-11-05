/** 摄像头预览上的面部/虹膜标记。调试模式与使用模式共用同一套绘制。 */
import type { EyeKey, Pt } from "../types";
import type { FaceFrame } from "../vision/face";

export const EYE_COLOR: Record<EyeKey, string> = {
  imageLeft: "#4ee0c0",
  imageRight: "#ffb454",
};

/**
 * 在预览画布上画两只眼的虹膜环 + 眼中心十字。
 * `good=false`（质量门控未过）时整体转红，让人一眼看出"现在不算数"。
 */
export function drawFaceOverlay(cv: HTMLCanvasElement, frame: FaceFrame, good: boolean): void {
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!frame) return;

  // video 是 object-fit: contain，算出实际显示区域
  const scale = Math.min(rect.width / frame.videoW, rect.height / frame.videoH);
  const dw = frame.videoW * scale;
  const dh = frame.videoH * scale;
  const ox = (rect.width - dw) / 2;
  const oy = (rect.height - dh) / 2;
  const toCv = (p: Pt): Pt => ({ x: ox + p.x * scale, y: oy + p.y * scale });

  for (const side of ["imageLeft", "imageRight"] as EyeKey[]) {
    const eye = frame.eyes[side];
    const c = toCv(eye.center);
    const ir = toCv(eye.iris);
    const color = good ? EYE_COLOR[side] : "#ff6b6b";
    ctx.strokeStyle = color;
    ctx.globalAlpha = eye.closed ? 0.28 : 0.9;
    ctx.lineWidth = 1.5;

    // 虹膜环
    ctx.beginPath();
    ctx.arc(ir.x, ir.y, Math.max(3, eye.width * 0.19 * scale), 0, Math.PI * 2);
    ctx.stroke();

    // 眼中心十字
    const arm = Math.max(4, eye.width * 0.12 * scale);
    ctx.beginPath();
    ctx.moveTo(c.x - arm, c.y);
    ctx.lineTo(c.x + arm, c.y);
    ctx.moveTo(c.x, c.y - arm);
    ctx.lineTo(c.x, c.y + arm);
    ctx.stroke();

    // 虹膜中心点
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ir.x, ir.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
