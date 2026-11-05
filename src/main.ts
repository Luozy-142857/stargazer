import "./styles.css";
import { detectMode } from "./ui/mode";

/**
 * 启动器：先装错误捕获，再按模式动态加载应用。
 *
 * 用动态 import 是为了让启动期的异常（包括模块解析失败）也能被这里接住。
 * 否则出错时页面只是"点了没反应"，屏幕上什么都不会显示——排查成本极高。
 */

function fatal(msg: string): void {
  let el = document.getElementById("fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "fatal";
    document.body.appendChild(el);
  }
  el.textContent = `运行出错：${msg}`;
  el.classList.add("show");
}

window.addEventListener("error", (e) => {
  fatal(e.message || String(e.error ?? "未知错误"));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  fatal(r instanceof Error ? r.message : String(r));
});

const mode = detectMode();

try {
  if (mode === "debug") {
    const { App } = await import("./ui/app");
    new App();
  } else {
    const { UsageApp } = await import("./ui/usage");
    new UsageApp();
  }
} catch (err) {
  fatal(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}
