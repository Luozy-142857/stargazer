import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * base "./" 让 dist 可以被本地静态服务器或 pywebview 从任意路径加载。
 * --mode https 走自签证书，用于在 iPad / 手机上测摄像头
 * （getUserMedia 只在 localhost 或 https 下可用，局域网 http 会被浏览器拒绝）。
 */
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: mode === "https" ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
    watch: {
      /**
       * 编辑器/工具做原子写入时会在源目录里建 `.xxx.tmpdir` 临时目录，
       * Windows 上 chokidar 抓到这种即刻消失的文件会抛 EBUSY 把整个 dev server 打挂。
       * 必须显式忽略。
       */
      ignored: ["**/*.tmpdir/**", "**/.*.tmpdir/**", "**/.npm-cache/**"],
    },
  },
  build: { target: "es2022", outDir: "dist" },
}));
