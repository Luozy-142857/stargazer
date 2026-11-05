/**
 * 双模式：使用模式（受试者/孩子/家长）与调试模式（开发者/验证台）。
 *
 * 默认是**使用模式**——终端用户打开页面看到的应该是简化的训练流程；
 * 调试模式保留全部测量协议、诊断与导出能力，通过 `?mode=debug` 进入。
 * 选择会记住（localStorage），下次打开不用重新带参数。
 */

export type AppMode = "usage" | "debug";

const KEY = "stargazer-mode";

export function detectMode(): AppMode {
  let p: string | null = null;
  try {
    p = new URLSearchParams(location.search).get("mode");
    if (p === "debug" || p === "usage") {
      localStorage.setItem(KEY, p);
      return p;
    }
    p = localStorage.getItem(KEY);
  } catch {
    /* 隐私模式下 localStorage 不可用：按默认模式跑 */
  }
  return p === "debug" ? "debug" : "usage";
}
