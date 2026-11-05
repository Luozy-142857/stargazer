/**
 * File System Access API 的最小封装：把会话直接写进用户选定的文件夹。
 *
 * 为什么需要它：
 * 浏览器默认只能"下载"到 Downloads，反复调试时要翻文件夹找文件。
 * 允许用户指定输出目录后，每次校准/测试都能自动落盘，
 * 便于把会话文件交回工作区做离线验证。
 *
 * 只写本地文件，不发任何网络请求。
 */

export interface WritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

export interface DirHandleLike {
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
}

type Picker = (opts?: { mode?: "read" | "readwrite" }) => Promise<DirHandleLike>;

function pickerFn(): Picker | null {
  const fn = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  return typeof fn === "function" ? fn : null;
}

export function supportsDirectoryWrite(): boolean {
  return pickerFn() !== null;
}

/** 弹出目录选择器；用户取消时返回 null（不抛错）。 */
export async function pickDirectory(): Promise<DirHandleLike | null> {
  const picker = pickerFn();
  if (!picker) return null;
  try {
    return await picker({ mode: "readwrite" });
  } catch {
    return null;
  }
}

/** 写 JSON。返回 false 表示没目录或写失败，调用方应退回下载。 */
export async function writeJsonTo(
  dir: DirHandleLike | null,
  filename: string,
  data: unknown,
): Promise<boolean> {
  if (!dir) return false;
  try {
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    await w.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 句柄持久化

/**
 * 目录句柄只存在内存里的话，刷新页面就丢了，文件会掉进 Downloads。
 * 存进 IndexedDB 可以跨刷新恢复；但浏览器会保留权限判定，
 * 权限已失效时需要用户再点一次（属于安全策略，绕不过去）。
 */
const DB_NAME = "stargazer";
const STORE = "kv";
const KEY = "outDir";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(dir: DirHandleLike): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dir, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* 存不下就算了，不影响主流程 */
  }
}

export async function loadDirHandle(): Promise<DirHandleLike | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<DirHandleLike | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as DirHandleLike) ?? null);
      req.onerror = () => resolve(null);
    });
    db.close();
    if (!handle) return null;
    const probe = handle as unknown as {
      queryPermission?: (o: { mode: string }) => Promise<string>;
    };
    if (probe.queryPermission) {
      const state = await probe.queryPermission({ mode: "readwrite" });
      if (state !== "granted") return null;
    }
    return handle;
  } catch {
    return null;
  }
}
