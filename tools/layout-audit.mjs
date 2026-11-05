/** 布局审计：溢出、越界、卡片实际宽度。 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5199";
const browser = await chromium.launch({ channel: "msedge" });

for (const vp of [
  { width: 1280, height: 800 },
  { width: 800, height: 1000 },
  { width: 420, height: 860 },
]) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  const report = await page.evaluate(() => {
    const card = document.querySelector(".u-screen.active .u-card");
    const r = card.getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      cardW: Math.round(r.width),
      cardH: Math.round(r.height),
      cardTop: Math.round(r.top),
      cardLeft: Math.round(r.left),
      scrollable: (() => {
        const m = document.getElementById("uMain");
        return m.scrollHeight > m.clientHeight;
      })(),
    };
  });
  console.log(
    `视口 ${vp.width}×${vp.height}: 卡片 ${report.cardW}×${report.cardH} @ (${report.cardLeft},${report.cardTop}) | 横向溢出=${report.overflowX} | 需要滚动=${report.scrollable}`,
  );
  await page.close();
}

await browser.close();
