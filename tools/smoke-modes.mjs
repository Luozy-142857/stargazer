/** 冒烟测试：使用模式与调试模式的加载、切换、导航不报错。 */
import { chromium } from "playwright";

const BASE = "http://localhost:5199";
const errors = [];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

// ---- 1. 使用模式（默认）
await page.goto(BASE, { waitUntil: "networkidle" });
const mode1 = await page.evaluate(() => document.documentElement.dataset.mode);
const welcomeVisible = await page.isVisible("#uScrWelcome");
const debugHidden = await page.evaluate(
  () => getComputedStyle(document.getElementById("app")).display,
);
console.log("使用模式: mode =", mode1, "| 欢迎页可见 =", welcomeVisible, "| 调试面板 display =", debugHidden);

// 导航：欢迎 → 设置
await page.click("#uBtnWelcome");
await page.waitForTimeout(300);
const setupVisible = await page.isVisible("#uScrSetup");
console.log("欢迎 → 设置页可见 =", setupVisible);

// 设置 → 摄像头页（摄像头会失败，但页面不应崩）
await page.fill("#uDiag", "15.6");
await page.fill("#uDist", "50");
await page.click("#uBtnSetup");
await page.waitForTimeout(2500);
const camVisible = await page.isVisible("#uScrCamera");
const hint = await page.textContent("#uVideoHint");
console.log("摄像头页可见 =", camVisible, "| 提示 =", (hint || "").slice(0, 40));
const camBtnDisabled = await page.isDisabled("#uBtnCalib");
console.log("校准按钮禁用（摄像头未就绪时）=", camBtnDisabled);

// ---- 2. 调试模式
await page.goto(`${BASE}/?mode=debug`, { waitUntil: "networkidle" });
const mode2 = await page.evaluate(() => document.documentElement.dataset.mode);
const tabsVisible = await page.isVisible("#tabs");
const usageHidden = await page.evaluate(
  () => getComputedStyle(document.getElementById("usageRoot")).display,
);
console.log("调试模式: mode =", mode2, "| 标签页可见 =", tabsVisible, "| 使用面板 display =", usageHidden);
const tabCount = await page.locator(".tabbtn").count();
console.log("调试标签数 =", tabCount);

// ---- 3. 切回使用模式（链接）
await page.click('a.modelink[href="?mode=usage"]');
await page.waitForTimeout(600);
const mode3 = await page.evaluate(() => document.documentElement.dataset.mode);
console.log("点链接回到: mode =", mode3);

// ---- 4. localStorage 记忆
await page.goto(BASE, { waitUntil: "networkidle" });
const mode4 = await page.evaluate(() => document.documentElement.dataset.mode);
console.log("无参数重开（应记住 usage）=", mode4);

await browser.close();
console.log(errors.length ? `\n发现 ${errors.length} 个错误:\n` + errors.join("\n") : "\n无 JS 错误 ✓");
