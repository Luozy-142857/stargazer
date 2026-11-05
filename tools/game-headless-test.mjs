/** 无头驱动 GazeGame：栅格扫描注视点，强制触发捕获路径，验证渲染与结果。 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack?.split("\n")[1] ?? ""}`));

await page.goto("http://127.0.0.1:5198/", { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async () => {
  const { GazeGame } = await import("/src/game/gazeGame.ts");
  const canvas = document.createElement("canvas");
  canvas.id = "testCanvas";
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  document.body.appendChild(canvas);
  const hud = document.createElement("div");
  hud.id = "testHud";
  const prompt = document.createElement("div");
  prompt.id = "testPrompt";
  const prog = document.createElement("div");
  prog.innerHTML = "<i></i>";
  hud.appendChild(prompt);
  hud.appendChild(prog);
  document.body.appendChild(hud);

  const geom = {
    widthMm: 337,
    heightMm: 190,
    mmPerPx: 0.264,
    distanceMm: 500,
    pxPerDeg: 21.5,
  };
  const mm = (deg) => (geom.distanceMm * Math.PI * deg) / 180;

  // 前 4.5 秒盯中心（完成首次加油锚定），之后栅格扫描 ±8°×±5°，
  // 步长 4°/3°、每点停 260ms——捕获半径 ≥4°，必然命中多颗星。
  const t0 = performance.now();
  const xs = [-8, -4, 0, 4, 8];
  const ys = [-5, -2, 1, 4];
  const gaze = () => {
    const t = (performance.now() - t0) / 1000;
    if (t < 4.5) {
      return {
        left: { x: mm(0.6 * Math.sin(t * 3)), y: mm(0.4 * Math.sin(t * 4)) },
        right: { x: mm(0.5 * Math.sin(t * 3 + 0.3)), y: mm(0.35 * Math.sin(t * 4 + 0.2)) },
        valid: true,
      };
    }
    const step = 0.26;
    const n = xs.length * ys.length;
    const i = Math.floor((t - 4.5) / step) % n;
    const x = xs[i % xs.length];
    const y = ys[Math.floor(i / xs.length)];
    const k = ((t - 4.5) % step) / step;
    const ease = k * k * (3 - 2 * k);
    return {
      left: { x: mm(x), y: mm(y) },
      right: { x: mm(x * 0.96), y: mm(y * 0.94) },
      valid: true,
      _ease: ease,
    };
  };

  const game = new GazeGame({
    canvas,
    hud,
    promptEl: prompt,
    progressEl: prog.querySelector("i"),
    geom,
    durationMs: 22000,
    dominantEye: "imageRight",
    contrastRatio: 0.45,
    glasses: "cyan",
    getGaze: gaze,
  });
  return await game.run();
});

console.log(
  "游戏结果:",
  JSON.stringify({
    score: result?.score,
    trials: result?.trials,
    hits: result?.hits,
    expired: result?.expired,
    refuels: result?.refuels,
    validRatio: result?.validRatio?.toFixed(2),
    presenter: result?.presenter,
    meanHitErr: result?.meanHitErrorDeg?.toFixed(2),
  }),
);
await browser.close();
console.log(errors.length ? `\n发现 ${errors.length} 个错误:\n` + errors.join("\n") : "\n游戏循环无 JS 错误 ✓");
