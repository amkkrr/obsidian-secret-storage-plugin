/**
 * 测试辅助：mock app.vault.adapter / localStorage / obsidian 模块
 * RFC-001 §8 规定的 mock 方案：
 * - app.vault.adapter 用内存实现（exists/read/write/mkdir/list/remove）
 * - obsidian 模块整体 mock（Notice 等为空实现）
 * - cryptoService 保留真实实现（Node ≥ 20 提供全局 WebCrypto / btoa / atob）
 */

import { vi } from "vitest";

/** 内存 adapter：以 Map<path, content> 模拟文件系统 */
export function createMemoryAdapter() {
  const files = new Map();

  const list = async (path) => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const fileSet = new Set();
    const folderSet = new Set();
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (rest.includes("/")) {
          folderSet.add(`${prefix}${rest.split("/")[0]}`);
        } else {
          fileSet.add(p);
        }
      }
    }
    return { files: [...fileSet], folders: [...folderSet] };
  };

  return {
    async exists(path) {
      if (files.has(path)) {
        return true;
      }
      // 目录存在性：path 是任一已存文件路径的前缀（mkdir 在内存中不落盘）
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    },
    async read(path) {
      if (!files.has(path)) {
        throw new Error(`File not found: ${path}`);
      }
      return files.get(path);
    },
    async write(path, content) {
      files.set(path, content);
    },
    async mkdir(_path) {
      // 内存实现：无需真实创建目录
    },
    async list(path) {
      return list(path);
    },
    async remove(path) {
      files.delete(path);
    },
    // 测试专用：直接操作底层存储
    _files: files,
    _get(path) {
      return files.get(path);
    },
    _set(path, content) {
      files.set(path, content);
    },
    _clear() {
      files.clear();
    }
  };
}

/** 安装 localStorage stub（Node 环境无 localStorage，SyncStorageProvider 依赖 deviceId 存储） */
export function installLocalStorageStub() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    }
  };
  return store;
}

/** 构建 mock App（含 adapter 与 secretStorage） */
export function createMockApp(adapter) {
  const secretStore = new Map();
  return {
    vault: {
      configDir: ".obsidian",
      adapter
    },
    secretStorage: {
      setSecret(id, value) {
        secretStore.set(id, value);
      },
      getSecret(id) {
        return secretStore.get(id) || null;
      },
      listSecrets() {
        return [...secretStore.keys()];
      },
      _store: secretStore
    }
  };
}
