/**
 * RFC-001 §8 单元测试：storage.ts（LocalStorageProvider / SyncStorageProvider）
 * mock 方案：app.vault.adapter 用内存实现；obsidian 模块整体 mock；cryptoService 真实。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(message) {
      this.message = message;
    }
  }
}));

import {
  LocalStorageProvider,
  SyncStorageProvider,
  SyncConflictError,
  VaultState,
  createStorageProvider
} from "../src/storage";
import { cryptoService } from "../src/crypto";
import { installLocalStorageStub, createMemoryAdapter, createMockApp } from "./helpers";

const PASSWORD = "test-password-123456!";
const PLUGIN_DIR = ".obsidian/plugins/secret-storage-demo";
const VAULT_PATH = `${PLUGIN_DIR}/secrets.enc`;
const BACKUP_DIR = `${PLUGIN_DIR}/backups`;

function createProvider(app, opts = {}) {
  const provider = new SyncStorageProvider(app, 0);
  if (opts.deviceId) {
    provider.deviceId = opts.deviceId;
  }
  return provider;
}

async function initVault(provider, secrets = { api: "value-1" }) {
  const result = await provider.initialize(PASSWORD);
  expect(result).toEqual({ ok: true });
  for (const [id, value] of Object.entries(secrets)) {
    await provider.save(id, value);
  }
  return provider.vault;
}

describe("LocalStorageProvider", () => {
  let app;
  let provider;

  beforeEach(() => {
    app = createMockApp(createMemoryAdapter());
    provider = new LocalStorageProvider(app);
  });

  it("save/get/list/delete 正常流转", async () => {
    expect(await provider.save("a", "secret-a")).toBe(true);
    expect(await provider.get("a")).toBe("secret-a");
    expect(await provider.list()).toEqual(["a"]);
    expect(await provider.delete("a")).toBe(true);
    expect(await provider.get("a")).toBeNull();
  });

  it("save 异常时返回 false", async () => {
    app.secretStorage.setSecret = () => {
      throw new Error("boom");
    };
    expect(await provider.save("a", "x")).toBe(false);
  });

  it("get 异常时返回 null", async () => {
    app.secretStorage.getSecret = () => {
      throw new Error("boom");
    };
    expect(await provider.get("a")).toBeNull();
  });

  it("list 异常时返回空数组", async () => {
    app.secretStorage.listSecrets = () => {
      throw new Error("boom");
    };
    expect(await provider.list()).toEqual([]);
  });

  it("delete 异常时返回 false", async () => {
    app.secretStorage.setSecret = () => {
      throw new Error("boom");
    };
    expect(await provider.delete("a")).toBe(false);
  });

  it("isUnlocked 恒真，getMode 为 local", () => {
    expect(provider.isUnlocked()).toBe(true);
    expect(provider.getMode()).toBe("local");
  });
});

describe("SyncStorageProvider 基础", () => {
  let adapter;
  let app;
  let provider;

  beforeEach(() => {
    installLocalStorageStub();
    adapter = createMemoryAdapter();
    app = createMockApp(adapter);
    provider = createProvider(app, { deviceId: "device-A" });
  });

  it("constructor 生成 deviceId 并持久化到 localStorage", () => {
    expect(provider.deviceId).toMatch(/^device-/);
    const stored = globalThis.localStorage.getItem("secret-storage-device-id");
    expect(stored).toMatch(/^device-/);
  });

  it("getOrCreateDeviceId 复用已有 deviceId", () => {
    const first = new SyncStorageProvider(app, 0).deviceId;
    const second = new SyncStorageProvider(app, 0).deviceId;
    expect(second).toBe(first);
  });

  it("路径生成正确", () => {
    expect(provider.getPluginDir()).toBe(PLUGIN_DIR);
    expect(provider.getVaultPath()).toBe(VAULT_PATH);
    expect(provider.getBackupDir()).toBe(BACKUP_DIR);
  });

  it("getState 三态：uninitialized → locked → unlocked", async () => {
    expect(await provider.getState()).toBe(VaultState.UNINITIALIZED);
    expect(await provider.isInitialized()).toBe(false);

    await initVault(provider);
    expect(await provider.getState()).toBe(VaultState.UNLOCKED);

    provider.lock();
    expect(await provider.getState()).toBe(VaultState.LOCKED);
  });

  it("isInitialized 在 adapter 异常时返回 false", async () => {
    adapter.exists = async () => {
      throw new Error("boom");
    };
    expect(await provider.isInitialized()).toBe(false);
    expect(await provider.getState()).toBe(VaultState.UNINITIALIZED);
  });

  it("initialize 创建空库并解锁", async () => {
    const result = await provider.initialize(PASSWORD);
    expect(result).toEqual({ ok: true });
    expect(provider.isUnlocked()).toBe(true);
    expect(await provider.isInitialized()).toBe(true);
    const raw = JSON.parse(adapter._get(VAULT_PATH));
    expect(raw.version).toBe(2);
    expect(raw.deviceId).toBe("device-A");
  });

  it("initialize 写前保护：文件已存在时拒绝创建（审计 G-1）", async () => {
    adapter._set(VAULT_PATH, "{}");
    const result = await provider.initialize(PASSWORD);
    expect(result).toEqual({ ok: false, reason: "already-exists" });
    expect(provider.isUnlocked()).toBe(false);
    expect(adapter._get(VAULT_PATH)).toBe("{}");
  });

  it("initialize 写失败返回 error", async () => {
    adapter.write = async () => {
      throw new Error("write boom");
    };
    const result = await provider.initialize(PASSWORD);
    expect(result).toEqual({ ok: false, reason: "error" });
  });

  it("unlock 成功加载密钥", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, { k1: "v1" }, "device-A");
    adapter._set(VAULT_PATH, JSON.stringify(vault));
    expect(await provider.unlock(PASSWORD)).toBe(true);
    expect(provider.secrets).toEqual({ k1: "v1" });
  });

  it("unlock 密码错误返回 false", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, {}, "device-A");
    adapter._set(VAULT_PATH, JSON.stringify(vault));
    expect(await provider.unlock("wrong-password")).toBe(false);
    expect(provider.isUnlocked()).toBe(false);
  });

  it("unlock 文件缺失返回 false", async () => {
    expect(await provider.unlock(PASSWORD)).toBe(false);
  });

  it("lock 清除内存状态", async () => {
    await initVault(provider);
    provider.lock();
    expect(provider.isUnlocked()).toBe(false);
    expect(provider.secrets).toEqual({});
    expect(provider.password).toBeNull();
    expect(provider.encryptionKey).toBeNull();
  });

  it("get/list 未解锁时返回 null/[]", async () => {
    expect(await provider.get("a")).toBeNull();
    expect(await provider.list()).toEqual([]);
  });

  it("get/list 解锁后按需返回（空值过滤）", async () => {
    await initVault(provider, { keep: "x", empty: "" });
    expect(await provider.get("keep")).toBe("x");
    expect(await provider.get("missing")).toBeNull();
    expect(await provider.list()).toEqual(["keep"]);
  });

  it("isUnlocked/getMode/getVaultInfo", async () => {
    expect(provider.getMode()).toBe("sync");
    expect(provider.getVaultInfo()).toBeNull();
    const vault = await initVault(provider);
    expect(provider.getVaultInfo()).toEqual({
      lastModified: vault.lastModified,
      deviceId: "device-A"
    });
  });

  it("setAutoLockTimeout 解锁时重置定时器", async () => {
    const spy = vi.spyOn(provider, "resetLockTimer");
    provider.unlocked = true;
    provider.setAutoLockTimeout(10);
    expect(spy).toHaveBeenCalled();
    provider.setAutoLockTimeout(0);
    expect(provider.autoLockTimeout).toBe(0);
  });
});

describe("保存、删除与迁移", () => {
  let adapter;
  let app;
  let provider;

  beforeEach(async () => {
    installLocalStorageStub();
    adapter = createMemoryAdapter();
    app = createMockApp(adapter);
    provider = createProvider(app, { deviceId: "device-A" });
    await initVault(provider);
  });

  it("save 成功后写入文件并可重新解锁", async () => {
    expect(await provider.save("new-id", "new-secret")).toBe(true);
    const raw = JSON.parse(adapter._get(VAULT_PATH));
    expect(raw.deviceId).toBe("device-A");

    const provider2 = createProvider(app, { deviceId: "device-A" });
    await provider2.unlock(PASSWORD);
    expect(provider2.secrets).toMatchObject({ "new-id": "new-secret" });
  });

  it("save 未解锁时返回 false 且不写入", async () => {
    provider.lock();
    expect(await provider.save("a", "b")).toBe(false);
  });

  it("save 普通错误返回 false（不抛）", async () => {
    adapter.write = async () => {
      throw new Error("write boom");
    };
    expect(await provider.save("a", "b")).toBe(false);
  });

  it("save 冲突时重新抛出 SyncConflictError（审计 D-3）", async () => {
    // 远端已更新（其他设备写入新版本）
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remote: "r" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();

    await expect(provider.save("a", "b")).rejects.toBeInstanceOf(SyncConflictError);
  });

  it("delete 成功移除密钥", async () => {
    await provider.save("del", "x");
    expect(await provider.delete("del")).toBe(true);
    expect(await provider.get("del")).toBeNull();
  });

  it("delete 未解锁返回 false", async () => {
    provider.lock();
    expect(await provider.delete("a")).toBe(false);
  });

  it("delete 冲突时重新抛出 SyncConflictError", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remote: "r" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();

    await expect(provider.delete("a")).rejects.toBeInstanceOf(SyncConflictError);
  });

  it("migrateFromLocal 合并本地密钥", async () => {
    expect(await provider.migrateFromLocal({ local1: "l1" })).toBe(true);
    expect(provider.secrets).toMatchObject({ local1: "l1" });
  });

  it("migrateFromLocal 未解锁返回 false", async () => {
    provider.lock();
    expect(await provider.migrateFromLocal({ a: "b" })).toBe(false);
  });

  it("migrateFromLocal 冲突时重新抛出 SyncConflictError", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remote: "r" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();

    await expect(provider.migrateFromLocal({ local1: "l1" })).rejects.toBeInstanceOf(SyncConflictError);
  });

  it("exportSecrets 导出快照", async () => {
    provider.secrets = { a: "1", b: "2" };
    expect(provider.exportSecrets()).toEqual({ a: "1", b: "2" });
    expect(provider.exportSecrets()).not.toBe(provider.secrets);
  });

  it("exportSecrets 未解锁返回空对象", async () => {
    provider.lock();
    expect(provider.exportSecrets()).toEqual({});
  });
});

describe("persistSecrets 与冲突豁免（审计 D-1）", () => {
  let adapter;
  let app;
  let provider;

  beforeEach(async () => {
    installLocalStorageStub();
    adapter = createMemoryAdapter();
    app = createMockApp(adapter);
    provider = createProvider(app, { deviceId: "device-A" });
    await initVault(provider);
  });

  it("未初始化时 throw", async () => {
    const p = createProvider(app);
    await expect(p.persistSecrets()).rejects.toThrow("Vault not initialized");
  });

  it("远端更新时默认拒绝并抛 SyncConflictError", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { r: "1" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();

    await expect(provider.persistSecrets()).rejects.toBeInstanceOf(SyncConflictError);
  });

  it("skipConflictCheck=true 时豁免检查，冲突中仍可落盘", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { r: "1" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();
    provider.secrets = { local: "kept" };

    await provider.persistSecrets({ skipConflictCheck: true });
    const written = JSON.parse(adapter._get(VAULT_PATH));
    expect(written.deviceId).toBe("device-A");
    const decrypted = await cryptoService.decryptVault(written, PASSWORD);
    expect(decrypted.secrets).toEqual({ local: "kept" });
  });

  it("无冲突时正常写入并更新 lastModified/deviceId", async () => {
    provider.secrets = { n1: "v1" };
    const before = provider.vault.lastModified;
    await provider.persistSecrets();
    expect(provider.vault.lastModified).not.toBe(before);
    expect(provider.vault.deviceId).toBe("device-A");
  });
});

describe("冲突检测与解决", () => {
  let adapter;
  let app;
  let provider;

  beforeEach(async () => {
    installLocalStorageStub();
    adapter = createMemoryAdapter();
    app = createMockApp(adapter);
    provider = createProvider(app, { deviceId: "device-A" });
    await initVault(provider, { localKey: "lv" });
  });

  it("detectConflict：文件不存在 → none", async () => {
    expect(await provider.detectConflict()).toBe("none");
  });

  it("detectConflict：时间戳相同 → none", async () => {
    adapter._set(VAULT_PATH, JSON.stringify(provider.vault));
    expect(await provider.detectConflict()).toBe("none");
  });

  it("detectConflict：同设备本地较新 → local-newer", async () => {
    const newer = { ...provider.vault, lastModified: new Date(Date.now() - 60000).toISOString() };
    adapter._set(VAULT_PATH, JSON.stringify(newer));
    expect(await provider.detectConflict()).toBe("local-newer");
  });

  it("detectConflict：同设备远端较新 → remote-newer", async () => {
    const newer = { ...provider.vault, lastModified: new Date(Date.now() + 60000).toISOString() };
    adapter._set(VAULT_PATH, JSON.stringify(newer));
    expect(await provider.detectConflict()).toBe("remote-newer");
  });

  it("detectConflict：异设备 → conflict 并缓存远端信息", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remoteKey: "rv" }, "device-B");
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    expect(await provider.detectConflict()).toBe("conflict");
    expect(provider.hasConflict()).toBe(true);
    const info = provider.getConflictInfo();
    expect(info.remoteSecrets).toEqual(["remoteKey"]);
    expect(info.localSecrets).toEqual(["localKey"]);
  });

  it("detectConflict：adapter 异常 → none", async () => {
    adapter.read = async () => {
      throw new Error("read boom");
    };
    expect(await provider.detectConflict()).toBe("none");
  });

  it("checkBeforeSave 各分支", async () => {
    // none
    expect(await provider.checkBeforeSave()).toEqual({ canSave: true, conflictType: "none" });
    // local-newer
    adapter._set(VAULT_PATH, JSON.stringify({ ...provider.vault, lastModified: new Date(Date.now() - 60000).toISOString() }));
    expect(await provider.checkBeforeSave()).toEqual({ canSave: true, conflictType: "local-newer" });
    // remote-newer
    adapter._set(VAULT_PATH, JSON.stringify({ ...provider.vault, lastModified: new Date(Date.now() + 60000).toISOString() }));
    expect(await provider.checkBeforeSave()).toEqual({ canSave: false, conflictType: "remote-newer" });
    // conflict
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, {}, "device-B");
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    expect(await provider.checkBeforeSave()).toEqual({ canSave: false, conflictType: "conflict" });
  });

  it("refresh：remote-newer 时自动拉取远端版本", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { refreshed: "yes" }, "device-A");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    expect(await provider.refresh()).toBe("remote-newer");
    expect(provider.secrets).toEqual({ refreshed: "yes" });
  });

  it("refresh：未解锁返回 none", async () => {
    provider.lock();
    expect(await provider.refresh()).toBe("none");
  });

  it("resolveConflictWithLocal：豁免检查并落盘本地版本（审计 D-1）", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remoteKey: "rv" }, "device-B");
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    await provider.detectConflict();

    expect(await provider.resolveConflictWithLocal()).toBe(true);
    expect(provider.hasConflict()).toBe(false);
    const written = JSON.parse(adapter._get(VAULT_PATH));
    const decrypted = await cryptoService.decryptVault(written, PASSWORD);
    expect(decrypted.secrets).toEqual({ localKey: "lv" });
  });

  it("resolveConflictWithRemote：替换为远程版本", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { remoteKey: "rv" }, "device-B");
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    await provider.detectConflict();

    expect(await provider.resolveConflictWithRemote()).toBe(true);
    expect(provider.secrets).toEqual({ remoteKey: "rv" });
    expect(provider.hasConflict()).toBe(false);
  });

  it("resolveConflictWithRemote：无冲突上下文返回 false", async () => {
    expect(await provider.resolveConflictWithRemote()).toBe(false);
  });

  it("resolveConflictWithMerge：合并双方密钥，冲突项取较新", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { onlyRemote: "r", both: "remote-new" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() + 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();
    provider.secrets = { onlyLocal: "l", both: "local-old" };
    await provider.detectConflict();

    expect(await provider.resolveConflictWithMerge()).toBe(true);
    expect(provider.secrets).toEqual({ onlyRemote: "r", onlyLocal: "l", both: "remote-new" });
  });

  it("resolveConflictWithMerge：本地较新时保留本地值", async () => {
    const remoteVault = await cryptoService.createEncryptedVault(PASSWORD, { both: "remote-old" }, "device-B");
    remoteVault.lastModified = new Date(Date.now() - 60000).toISOString();
    adapter._set(VAULT_PATH, JSON.stringify(remoteVault));
    provider.vault.lastModified = new Date().toISOString();
    provider.secrets = { both: "local-new" };
    await provider.detectConflict();

    expect(await provider.resolveConflictWithMerge()).toBe(true);
    expect(provider.secrets).toEqual({ both: "local-new" });
  });

  it("resolveConflictWithMerge：无上下文返回 false", async () => {
    expect(await provider.resolveConflictWithMerge()).toBe(false);
  });

  it("resolveConflictWithLocal 未解锁返回 false", async () => {
    provider.lock();
    expect(await provider.resolveConflictWithLocal()).toBe(false);
  });
});

describe("备份、改密与痕迹检测", () => {
  let adapter;
  let app;
  let provider;

  beforeEach(async () => {
    installLocalStorageStub();
    adapter = createMemoryAdapter();
    app = createMockApp(adapter);
    provider = createProvider(app, { deviceId: "device-A" });
  });

  it("persistSecrets 自动创建备份并清理（默认保留 5 份）", async () => {
    await initVault(provider, { a: "1" });
    for (let i = 0; i < 7; i++) {
      await provider.persistSecrets();
    }
    const listing = await adapter.list(BACKUP_DIR);
    expect(listing.files.length).toBe(5);
  });

  it("cleanupBackups 异常时静默（console.error）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    adapter.list = async () => {
      throw new Error("list boom");
    };
    await provider.cleanupBackups(5);
    expect(spy).toHaveBeenCalled();
  });

  it("createBackup 源文件缺失时静默创建目录", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await provider.createBackup();
    expect(spy).not.toHaveBeenCalled();
  });

  it("changePassword 成功后可用新密码解锁", async () => {
    await initVault(provider, { a: "1" });
    expect(await provider.changePassword(PASSWORD, "new-password-123456!")).toBe(true);
    const p2 = createProvider(app, { deviceId: "device-A" });
    expect(await p2.unlock("new-password-123456!")).toBe(true);
    expect(p2.secrets).toEqual({ a: "1" });
  });

  it("changePassword 旧密码错误返回 false", async () => {
    await initVault(provider);
    expect(await provider.changePassword("wrong-old", "new-password-123456!")).toBe(false);
  });

  it("changePassword 异常时回滚内存状态", async () => {
    await initVault(provider);
    const origVault = provider.vault;
    adapter.write = async () => {
      throw new Error("write boom");
    };
    expect(await provider.changePassword(PASSWORD, "new-password-123456!")).toBe(false);
    expect(provider.vault).toBe(origVault);
    expect(provider.password).toBe(PASSWORD);
  });

  it("hasAnyVaultTraces：插件目录不存在 → false", async () => {
    expect(await provider.hasAnyVaultTraces()).toBe(false);
  });

  it("hasAnyVaultTraces：backups/ 含 *.enc → true（规则 1）", async () => {
    adapter._set(`${BACKUP_DIR}/secrets.2026-01-01.enc`, "{}");
    expect(await provider.hasAnyVaultTraces()).toBe(true);
  });

  it("hasAnyVaultTraces：插件目录内 conflicted copy → true（规则 2）", async () => {
    adapter._set(`${PLUGIN_DIR}/secrets (conflicted copy 2026-08-06 12:00:00).enc`, "{}");
    expect(await provider.hasAnyVaultTraces()).toBe(true);
  });

  it("hasAnyVaultTraces：仅主文件 → false", async () => {
    adapter._set(VAULT_PATH, "{}");
    expect(await provider.hasAnyVaultTraces()).toBe(false);
  });

  it("hasAnyVaultTraces：adapter 异常 → false", async () => {
    adapter.exists = async () => {
      throw new Error("boom");
    };
    expect(await provider.hasAnyVaultTraces()).toBe(false);
  });
});

describe("createStorageProvider 工厂", () => {
  it("sync 模式返回 SyncStorageProvider，local 返回 LocalStorageProvider", () => {
    const app = createMockApp(createMemoryAdapter());
    expect(createStorageProvider(app, "sync")).toBeInstanceOf(SyncStorageProvider);
    expect(createStorageProvider(app, "local")).toBeInstanceOf(LocalStorageProvider);
  });
});

describe("SyncConflictError", () => {
  it("默认消息与名称", () => {
    const err = new SyncConflictError();
    expect(err.name).toBe("SyncConflictError");
    expect(err.message).toContain("冲突");
    const custom = new SyncConflictError("custom");
    expect(custom.message).toBe("custom");
  });
});
