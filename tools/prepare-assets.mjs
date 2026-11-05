/**
 * 一次性准备静态资源：
 *   1. 把 @mediapipe/tasks-vision 的 wasm 运行时拷到 public/wasm
 *   2. 下载 face_landmarker.task 到 public/models
 *
 * 这两步都会产生大文件，所以不进 git。首次运行 npm run prepare-assets。
 */
import { cpSync, existsSync, mkdirSync, createWriteStream, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = join(root, "public", "wasm");
const modelDir = join(root, "public", "models");
const modelDst = join(modelDir, "face_landmarker.task");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

function log(msg) {
  console.log(`[prepare] ${msg}`);
}

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    throw new Error(
      `找不到 ${wasmSrc}\n先运行 npm install，再重新执行 npm run prepare-assets`,
    );
  }
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  log(`wasm 已就位 → ${wasmDst}`);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向次数过多"));
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(download(next, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fetchModel() {
  mkdirSync(modelDir, { recursive: true });
  if (existsSync(modelDst)) {
    const size = statSync(modelDst).size;
    if (size > 1_000_000) {
      log(`模型已存在（${(size / 1e6).toFixed(1)} MB），跳过下载`);
      return;
    }
  }
  log("下载 face_landmarker.task（约 3.7 MB）…");
  await download(MODEL_URL, modelDst);
  log(`模型已就位 → ${modelDst}`);
}

try {
  copyWasm();
  await fetchModel();
  log("完成。现在 npm run dev");
} catch (err) {
  console.error(`[prepare] 失败：${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
