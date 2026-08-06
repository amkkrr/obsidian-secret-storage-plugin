import { Notice } from "obsidian";
import { cryptoService } from "./crypto";

// ============================================
// 错误类型与状态模型（RFC-001 §5.1 / §5.4）
// ============================================
/**
 * 同步冲突错误：persistSecrets 检测到 remote-newer / conflict 时抛出。
 * 由 UI 层（main.ts saveSecret/deleteSecret、MigrationModal）捕获后弹出
 * ConflictResolutionModal（RFC-001 §5.4，审计 D-3）。
 */
export class SyncConflictError extends Error {
  constructor(message = "检测到同步冲突，拒绝写入") {
    super(message);
    this.name = "SyncConflictError";
  }
}

/**
 * 密钥库状态（RFC-001 §5.1）
 * - uninitialized: 文件不存在
 * - locked:       文件存在，unlocked === false
 * - unlocked:     文件存在，unlocked === true
 */
export const VaultState = {
  UNINITIALIZED: "uninitialized",
  LOCKED: "locked",
  UNLOCKED: "unlocked"
};

export class LocalStorageProvider {
  app: any;
  constructor(app) {
    this.app = app;
  }
  async save(id, secret) {
    try {
      this.app.secretStorage.setSecret(id, secret);
      return true;
    } catch (error) {
      console.error("LocalStorageProvider save error:", error);
      return false;
    }
  }
  async get(id) {
    try {
      return this.app.secretStorage.getSecret(id) || null;
    } catch (error) {
      console.error("LocalStorageProvider get error:", error);
      return null;
    }
  }
  async list() {
    try {
      return this.app.secretStorage.listSecrets();
    } catch (error) {
      console.error("LocalStorageProvider list error:", error);
      return [];
    }
  }
  async delete(id) {
    try {
      this.app.secretStorage.setSecret(id, "");
      return true;
    } catch (error) {
      console.error("LocalStorageProvider delete error:", error);
      return false;
    }
  }
  isUnlocked() {
    return true;
  }
  getMode() {
    return "local";
  }
};
export class SyncStorageProvider {
  // 运行时状态
  unlocked: boolean;
  secrets: any;
  vault: any;
  encryptionKey: any;
  password: any;
  // 自动锁定定时器
  lockTimer: any;
  autoLockTimeout: number;
  // 文件路径（vault 根目录，Obsidian Sync 可同步——插件目录内非白名单文件不会同步）
  VAULT_DIR: string;
  VAULT_FILE: string;
  BACKUP_DIR: string;
  // 冲突状态
  conflictRemoteVault: any;
  conflictRemoteSecrets: any;
  conflictCallback: any;
  app: any;
  crypto: any;
  deviceId: string;
  // 冲突检测结果类型（Phase 4.3, 4.4）
  static ConflictType = {
    NONE: "none",
    // 无冲突
    LOCAL_NEWER: "local-newer",
    // 本地版本更新
    REMOTE_NEWER: "remote-newer",
    // 远程版本更新
    CONFLICT: "conflict"
    // 真正的冲突（不同设备同时修改）
  };
  constructor(app, autoLockMinutes = 30) {
    // 运行时状态
    this.unlocked = false;
    this.secrets = {};
    this.vault = null;
    this.encryptionKey = null;
    this.password = null;
    // 自动锁定定时器
    this.lockTimer = null;
    this.autoLockTimeout = 30 * 60 * 1e3;
    // 默认 30 分钟
    // 文件路径（vault 根目录；Obsidian Sync 对插件目录采用文件名白名单，
    // 仅同步 data.json/main.js/manifest.json/styles.css，自定义文件须放 vault 根目录）
    this.VAULT_DIR = "SecretStorage";
    this.VAULT_FILE = "secrets.enc";
    this.BACKUP_DIR = "backups";
    // 冲突状态
    this.conflictRemoteVault = null;
    this.conflictRemoteSecrets = null;
    this.conflictCallback = null;
    this.app = app;
    this.crypto = cryptoService;
    this.deviceId = this.getOrCreateDeviceId();
    this.autoLockTimeout = autoLockMinutes * 60 * 1e3;
  }
  /**
   * 获取或创建设备 ID
   */
  getOrCreateDeviceId() {
    const key = "secret-storage-device-id";
    let deviceId = localStorage.getItem(key);
    if (!deviceId) {
      deviceId = this.crypto.generateDeviceId();
      localStorage.setItem(key, deviceId);
    }
    return deviceId;
  }
  /**
   * 获取插件数据目录路径
   */
  getPluginDir() {
    return `${this.app.vault.configDir}/plugins/secret-storage-demo`;
  }
  /**
   * 获取密钥库文件路径（vault 根目录 `SecretStorage/`，可被 Obsidian Sync 同步）
   * 2026-08-06 修复：原路径在插件目录内，Obsidian Sync 对 `.obsidian/plugins/`
   * 采用文件名白名单（仅 data.json/main.js/manifest.json/styles.css），
   * secrets.enc 永不同步，故移至 vault 根目录（需开启「同步所有其他类型文件」）。
   */
  getVaultPath() {
    return `${this.VAULT_DIR}/${this.VAULT_FILE}`;
  }
  /**
   * 旧路径（1.0.2 及更早）：插件目录内 secrets.enc —— 仅用于兼容迁移与痕迹检测
   */
  getLegacyVaultPath() {
    return `${this.getPluginDir()}/${this.VAULT_FILE}`;
  }
  /**
   * 获取备份目录路径
   */
  getBackupDir() {
    return `${this.VAULT_DIR}/${this.BACKUP_DIR}`;
  }
  /**
   * 确保密钥库目录存在（vault 根目录）
   */
  async ensureVaultDir() {
    if (!await this.app.vault.adapter.exists(this.VAULT_DIR)) {
      await this.app.vault.adapter.mkdir(this.VAULT_DIR);
    }
  }
  /**
   * 检查密钥库是否已初始化
   */
  async isInitialized() {
    try {
      const [current, legacy] = await Promise.all([
        this.app.vault.adapter.exists(this.getVaultPath()),
        this.app.vault.adapter.exists(this.getLegacyVaultPath())
      ]);
      return current || legacy;
    } catch (e) {
      return false;
    }
  }
  /**
   * 获取密钥库状态（RFC-001 §5.1，审计无发现）
   * 文件存在性为异步查询，故 getState 为 async（设计文档中的同步签名按实现妥协）。
   */
  async getState() {
    const exists = await this.isInitialized();
    if (!exists) {
      return VaultState.UNINITIALIZED;
    }
    return this.unlocked ? VaultState.UNLOCKED : VaultState.LOCKED;
  }
  /**
   * 初始化密钥库（首次设置密码）
   */
  /**
   * 初始化密钥库（首次设置密码）
   * 返回区分性结果（RFC-001 §5.2，审计 G-1）：
   * - { ok: true }                             创建成功
   * - { ok: false, reason: "already-exists" }  目标文件已被创建（同步竞态）→ 应引导解锁
   * - { ok: false, reason: "error" }           其他失败
   */
  async initialize(password) {
    try {
      // 写前保护（RFC-001 §5.2，防 §2.3.4 竞态）：exists/write 之间仍有毫秒级窗口（审计 C-1）
      // 新旧路径任一存在即拒绝创建（旧路径兼容 1.0.2 存量库）
      const [currentExists, legacyExists] = await Promise.all([
        this.app.vault.adapter.exists(this.getVaultPath()),
        this.app.vault.adapter.exists(this.getLegacyVaultPath())
      ]);
      if (currentExists || legacyExists) {
        return { ok: false, reason: "already-exists" };
      }
      const vault = await this.crypto.createEncryptedVault(password, {}, this.deviceId);
      await this.ensureVaultDir();
      await this.app.vault.adapter.write(
        this.getVaultPath(),
        JSON.stringify(vault, null, 2)
      );
      this.vault = vault;
      this.secrets = {};
      this.password = password;
      this.unlocked = true;
      this.resetLockTimer();
      return { ok: true };
    } catch (error) {
      console.error("SyncStorageProvider initialize error:", error);
      return { ok: false, reason: "error" };
    }
  }
  /**
   * 解锁密钥库
   */
  async unlock(password) {
    try {
      // 新路径优先；旧路径（1.0.2 及更早）存在则读取并在成功后自动迁移
      let sourcePath = this.getVaultPath();
      let content;
      if (await this.app.vault.adapter.exists(sourcePath)) {
        content = await this.app.vault.adapter.read(sourcePath);
      } else if (await this.app.vault.adapter.exists(this.getLegacyVaultPath())) {
        sourcePath = this.getLegacyVaultPath();
        content = await this.app.vault.adapter.read(sourcePath);
      } else {
        return false;
      }
      const vault = JSON.parse(content);
      const secretsData = await this.crypto.decryptVault(vault, password);
      if (!secretsData) {
        return false;
      }
      this.vault = vault;
      this.secrets = secretsData.secrets;
      this.password = password;
      this.unlocked = true;
      this.resetLockTimer();
      // 旧路径 → 新路径自动迁移（保留旧文件，下一次写盘后旧文件自然过时）
      if (sourcePath === this.getLegacyVaultPath()) {
        await this.ensureVaultDir();
        await this.app.vault.adapter.write(this.getVaultPath(), content);
        new Notice("\u{1F4E6} \u5BC6\u94A5\u5E93\u5DF2\u4ECE\u65E7\u4F4D\u7F6E\u8FC1\u79FB\u81F3 SecretStorage/\uFF08\u4F9B Obsidian Sync \u540C\u6B65\uFF09");
      }
      return true;
    } catch (error) {
      console.error("SyncStorageProvider unlock error:", error);
      return false;
    }
  }
  /**
   * 锁定密钥库
   */
  lock() {
    this.unlocked = false;
    this.secrets = {};
    this.encryptionKey = null;
    this.password = null;
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
  /**
   * 重置自动锁定定时器
   */
  resetLockTimer() {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
    }
    if (this.autoLockTimeout > 0) {
      this.lockTimer = setTimeout(() => {
        this.lock();
        new Notice("\u{1F512} \u5BC6\u94A5\u5E93\u5DF2\u81EA\u52A8\u9501\u5B9A");
      }, this.autoLockTimeout);
    }
  }
  /**
   * 保存密钥
   */
  async save(id, secret) {
    if (!this.unlocked || !this.password) {
      new Notice("\u26A0\uFE0F \u8BF7\u5148\u89E3\u9501\u5BC6\u94A5\u5E93");
      return false;
    }
    try {
      this.secrets[id] = secret;
      await this.persistSecrets();
      this.resetLockTimer();
      return true;
    } catch (error) {
      // 错误传播契约（RFC-001 §5.4，审计 D-3）：SyncConflictError 上抛给 UI 层，其余吞掉返回 false
      if (error instanceof SyncConflictError) {
        throw error;
      }
      console.error("SyncStorageProvider save error:", error);
      return false;
    }
  }
  /**
   * 获取密钥
   */
  async get(id) {
    if (!this.unlocked) {
      return null;
    }
    this.resetLockTimer();
    return this.secrets[id] || null;
  }
  /**
   * 列出所有密钥 ID
   */
  async list() {
    if (!this.unlocked) {
      return [];
    }
    this.resetLockTimer();
    return Object.keys(this.secrets).filter((id) => this.secrets[id] !== "");
  }
  /**
   * 删除密钥
   */
  async delete(id) {
    if (!this.unlocked || !this.password) {
      new Notice("\u26A0\uFE0F \u8BF7\u5148\u89E3\u9501\u5BC6\u94A5\u5E93");
      return false;
    }
    try {
      delete this.secrets[id];
      await this.persistSecrets();
      this.resetLockTimer();
      return true;
    } catch (error) {
      // 错误传播契约（RFC-001 §5.4，审计 D-3）
      if (error instanceof SyncConflictError) {
        throw error;
      }
      console.error("SyncStorageProvider delete error:", error);
      return false;
    }
  }
  /**
   * 持久化密钥到文件
   * @param {Object} [options]
   * @param {boolean} [options.skipConflictCheck=false] 冲突解决路径显式豁免
   *   （RFC-001 §5.4，审计 D-1）：resolveConflictWithLocal/WithMerge 传 true，
   *   避免「使用本地/合并」因旧内存版本被判 conflict 而死锁。
   */
  async persistSecrets({ skipConflictCheck = false } = {}) {
    if (!this.vault || !this.password) {
      throw new Error("Vault not initialized");
    }
    if (!skipConflictCheck) {
      const { canSave } = await this.checkBeforeSave();
      if (!canSave) {
        throw new SyncConflictError();
      }
    }
    await this.createBackup();
    const updatedVault = await this.crypto.updateEncryptedVault(
      this.vault,
      this.password,
      this.secrets,
      this.deviceId
    );
    if (!updatedVault) {
      throw new Error("Failed to update vault");
    }
    await this.ensureVaultDir();
    await this.app.vault.adapter.write(
      this.getVaultPath(),
      JSON.stringify(updatedVault, null, 2)
    );
    this.vault = updatedVault;
  }
  /**
   * 创建备份
   */
  async createBackup() {
    try {
      const backupDir = this.getBackupDir();
      await this.ensureVaultDir();
      if (!await this.app.vault.adapter.exists(backupDir)) {
        await this.app.vault.adapter.mkdir(backupDir);
      }
      const vaultPath = this.getVaultPath();
      if (await this.app.vault.adapter.exists(vaultPath)) {
        const content = await this.app.vault.adapter.read(vaultPath);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${backupDir}/secrets.${timestamp}.enc`;
        await this.app.vault.adapter.write(backupPath, content);
        await this.cleanupBackups(5);
      }
    } catch (error) {
      console.error("Backup creation failed:", error);
    }
  }
  /**
   * 清理旧备份
   */
  async cleanupBackups(keepCount) {
    try {
      const backupDir = this.getBackupDir();
      const files = await this.app.vault.adapter.list(backupDir);
      const backups = files.files.filter((f) => f.endsWith(".enc")).sort().reverse();
      for (let i = keepCount; i < backups.length; i++) {
        await this.app.vault.adapter.remove(backups[i]);
      }
    } catch (error) {
      console.error("Backup cleanup failed:", error);
    }
  }
  /**
   * 修改主密码
   */
  async changePassword(oldPassword, newPassword) {
    if (!this.vault) {
      return false;
    }
    const backupVault = this.vault;
    const backupPassword = this.password;
    try {
      await this.createBackup();
      const newVault = await this.crypto.changePassword(
        this.vault,
        oldPassword,
        newPassword,
        this.deviceId
      );
      if (!newVault) {
        return false;
      }
      await this.app.vault.adapter.write(
        this.getVaultPath(),
        JSON.stringify(newVault, null, 2)
      );
      this.vault = newVault;
      this.password = newPassword;
      return true;
    } catch (error) {
      this.vault = backupVault;
      this.password = backupPassword;
      console.error("Password change failed:", error);
      return false;
    }
  }
  isUnlocked() {
    return this.unlocked;
  }
  getMode() {
    return "sync";
  }
  /**
   * 痕迹检测（RFC-001 §5.2，审计 D-2）：本 vault 是否存在密码库痕迹
   * 规则 1：旧路径主文件存在（1.0.2 及更早的存量库，插件目录内）
   * 规则 2：备份目录（新 SecretStorage/backups 或旧插件目录 backups）含 *.enc
   * 规则 3：插件目录内存在其他 *.enc 文件（basename ≠ secrets.enc，如 conflicted copy）
   */
  async hasAnyVaultTraces() {
    try {
      const isMainFile = (p) => String(p).split("/").pop() === this.VAULT_FILE;
      // 规则 1：旧路径主文件
      if (await this.app.vault.adapter.exists(this.getLegacyVaultPath())) {
        return true;
      }
      // 规则 2：备份痕迹（新旧两处备份目录）
      for (const backupDir of [this.getBackupDir(), `${this.getPluginDir()}/${this.BACKUP_DIR}`]) {
        if (await this.app.vault.adapter.exists(backupDir)) {
          const backupListing = await this.app.vault.adapter.list(backupDir);
          if (backupListing && Array.isArray(backupListing.files) &&
            backupListing.files.some((f) => f.endsWith(".enc"))) {
            return true;
          }
        }
      }
      // 规则 3：插件目录内其他 *.enc（如 conflicted copy）
      const pluginDir = this.getPluginDir();
      if (await this.app.vault.adapter.exists(pluginDir)) {
        const listing = await this.app.vault.adapter.list(pluginDir);
        if (listing && Array.isArray(listing.files)) {
          if (listing.files.some((f) => f.endsWith(".enc") && !isMainFile(f))) {
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      console.error("Trace detection failed:", e);
      return false;
    }
  }
  /**
   * 获取密钥库信息
   */
  getVaultInfo() {
    if (!this.vault) {
      return null;
    }
    return {
      lastModified: this.vault.lastModified,
      deviceId: this.vault.deviceId
    };
  }
  /**
   * 设置自动锁定超时时间
   */
  setAutoLockTimeout(minutes) {
    this.autoLockTimeout = minutes * 60 * 1e3;
    if (this.unlocked) {
      this.resetLockTimer();
    }
  }
  /**
   * 从本地模式迁移密钥
   */
  async migrateFromLocal(localSecrets) {
    if (!this.unlocked || !this.password) {
      return false;
    }
    try {
      this.secrets = { ...this.secrets, ...localSecrets };
      await this.persistSecrets();
      return true;
    } catch (error) {
      // 错误传播契约（RFC-001 §5.4，审计 D-3）
      if (error instanceof SyncConflictError) {
        throw error;
      }
      console.error("Migration failed:", error);
      return false;
    }
  }
  /**
   * 导出所有密钥（用于迁移到本地模式）
   */
  exportSecrets() {
    if (!this.unlocked) {
      return {};
    }
    return { ...this.secrets };
  }
  /**
   * 冲突信息
   */
  getConflictInfo() {
    if (!this.vault || !this.conflictRemoteVault) {
      return null;
    }
    return {
      localVault: this.vault,
      remoteVault: this.conflictRemoteVault,
      localSecrets: Object.keys(this.secrets),
      remoteSecrets: this.conflictRemoteSecrets ? Object.keys(this.conflictRemoteSecrets) : []
    };
  }
  /**
   * 检测同步冲突
   * 在解锁时调用，比较内存中的版本和文件系统中的版本
   */
  async detectConflict() {
    if (!this.vault) {
      return "none";
    }
    try {
      const vaultPath = this.getVaultPath();
      if (!await this.app.vault.adapter.exists(vaultPath)) {
        return "none";
      }
      const remoteContent = await this.app.vault.adapter.read(vaultPath);
      const remoteVault = JSON.parse(remoteContent);
      const localTime = new Date(this.vault.lastModified).getTime();
      const remoteTime = new Date(remoteVault.lastModified).getTime();
      if (localTime === remoteTime) {
        return "none";
      }
      if (this.vault.deviceId === remoteVault.deviceId) {
        return localTime > remoteTime ? "local-newer" : "remote-newer";
      }
      this.conflictRemoteVault = remoteVault;
      if (this.password) {
        const remoteData = await this.crypto.decryptVault(remoteVault, this.password);
        if (remoteData) {
          this.conflictRemoteSecrets = remoteData.secrets;
        }
      }
      return "conflict";
    } catch (error) {
      console.error("Conflict detection failed:", error);
      return "none";
    }
  }
  /**
   * 在保存前检测冲突
   * 返回是否可以继续保存
   */
  async checkBeforeSave() {
    const conflictType = await this.detectConflict();
    switch (conflictType) {
      case "none":
      case "local-newer":
        return { canSave: true, conflictType };
      case "remote-newer":
        return { canSave: false, conflictType };
      case "conflict":
        return { canSave: false, conflictType };
      default:
        return { canSave: true, conflictType: "none" };
    }
  }
  /**
   * 解决冲突 - 使用本地版本
   */
  async resolveConflictWithLocal() {
    if (!this.unlocked || !this.password || !this.vault) {
      return false;
    }
    try {
      // 豁免冲突检查（RFC-001 §5.4，审计 D-1）：用户已显式选择保留本地版本
      await this.persistSecrets({ skipConflictCheck: true });
      this.clearConflictState();
      return true;
    } catch (error) {
      console.error("Resolve conflict with local failed:", error);
      return false;
    }
  }
  /**
   * 解决冲突 - 使用远程版本
   */
  async resolveConflictWithRemote() {
    if (!this.password || !this.conflictRemoteVault) {
      return false;
    }
    try {
      const remoteData = await this.crypto.decryptVault(this.conflictRemoteVault, this.password);
      if (!remoteData) {
        return false;
      }
      this.vault = this.conflictRemoteVault;
      this.secrets = remoteData.secrets;
      this.clearConflictState();
      return true;
    } catch (error) {
      console.error("Resolve conflict with remote failed:", error);
      return false;
    }
  }
  /**
   * 解决冲突 - 合并两个版本
   * 策略: 保留两边所有的密钥，如果同一 ID 存在不同值，保留较新的
   */
  async resolveConflictWithMerge() {
    if (!this.unlocked || !this.password || !this.vault || !this.conflictRemoteVault) {
      return false;
    }
    try {
      const remoteData = await this.crypto.decryptVault(this.conflictRemoteVault, this.password);
      if (!remoteData) {
        return false;
      }
      const localTime = new Date(this.vault.lastModified).getTime();
      const remoteTime = new Date(this.conflictRemoteVault.lastModified).getTime();
      const mergedSecrets = {};
      const allIds = /* @__PURE__ */ new Set([
        ...Object.keys(this.secrets),
        ...Object.keys(remoteData.secrets)
      ]);
      for (const id of allIds) {
        const localValue = this.secrets[id];
        const remoteValue = remoteData.secrets[id];
        if (localValue && remoteValue) {
          mergedSecrets[id] = localTime >= remoteTime ? localValue : remoteValue;
        } else if (localValue) {
          mergedSecrets[id] = localValue;
        } else if (remoteValue) {
          mergedSecrets[id] = remoteValue;
        }
      }
      this.secrets = mergedSecrets;
      // 豁免冲突检查（RFC-001 §5.4，审计 D-1）：用户已显式选择合并
      await this.persistSecrets({ skipConflictCheck: true });
      this.clearConflictState();
      return true;
    } catch (error) {
      console.error("Resolve conflict with merge failed:", error);
      return false;
    }
  }
  /**
   * 清除冲突状态
   */
  clearConflictState() {
    this.conflictRemoteVault = null;
    this.conflictRemoteSecrets = null;
    this.conflictCallback = null;
  }
  /**
   * 检查是否有待解决的冲突
   */
  hasConflict() {
    return this.conflictRemoteVault !== null;
  }
  /**
   * 刷新密钥库 - 从文件重新加载
   * 用于检测远程同步后的变化
   */
  async refresh() {
    if (!this.unlocked || !this.password) {
      return "none";
    }
    const conflictType = await this.detectConflict();
    if (conflictType === "remote-newer") {
      const content = await this.app.vault.adapter.read(this.getVaultPath());
      const remoteVault = JSON.parse(content);
      const remoteData = await this.crypto.decryptVault(remoteVault, this.password);
      if (remoteData) {
        this.vault = remoteVault;
        this.secrets = remoteData.secrets;
      }
    }
    return conflictType;
  }
};
// ============================================
// 冲突检测与解决 (Phase 4.3, 4.4)
// ============================================
// ConflictType 常量已移至 SyncStorageProvider 类内静态声明（见类头）
export function createStorageProvider(app, mode, autoLockMinutes = 30) {
  if (mode === "sync") {
    return new SyncStorageProvider(app, autoLockMinutes);
  }
  return new LocalStorageProvider(app);
}

