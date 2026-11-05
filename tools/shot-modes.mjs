/** 截图：使用模式三个主要界面 + 调试模式。 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5199";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await page.screenshot({ path: "out/shot-usage-welcome.png" });

await page.click("#uBtnWelcome");
await page.waitForTimeout(350);
await page.screenshot({ path: "out/shot-usage-setup.png" });

await page.click("#uBtnSetup");
await page.waitForTimeout(1200);
await page.screenshot({ path: "out/shot-usage-camera.png" });

await page.goto(`${BASE}/?mode=debug`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await page.screenshot({ path: "out/shot-debug.png" });

await browser.close();
console.log("screenshots saved");
