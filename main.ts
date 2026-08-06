import { Plugin, Notice, MarkdownView, Modal, Setting, PluginSettingTab } from "obsidian";
import { createStorageProvider, LocalStorageProvider, SyncStorageProvider, SyncConflictError } from "./src/storage";
import { SetupPasswordModal, UnlockModal, ChangePasswordModal, MigrationModal, ConflictResolutionModal, VaultNotFoundModal } from "./src/ui";

const DEFAULT_SETTINGS = {
  showNotifications: true,
  enablePlaceholderReplacement: true,
  placeholderStyle: "blur",
  // 同步模式默认设置
  storageMode: "local",
  autoLockTimeout: 30,
  keepBackupCount: 5
};
const SECRET_PLACEHOLDER_REGEX = /\{\{secret:([a-z0-9-]+)\}\}/g;
export default class SecretStorageDemoPlugin extends Plugin {
  settings: any;
  storageProvider: any;
  async onload() {
    await this.loadSettings();
    await this.initStorageProvider();
    this.registerMarkdownPostProcessor((element, context) => {
      this.processSecretPlaceholders(element, context);
    });
    this.addCommand({
      id: "insert-secret-placeholder",
      name: "\u63D2\u5165\u5BC6\u94A5\u5360\u4F4D\u7B26 (Insert Secret Placeholder)",
      editorCallback: (editor, view) => {
        this.ensureUnlocked(() => {
          new InsertPlaceholderModal(this.app, this, editor).open();
        });
      }
    });
    this.addCommand({
      id: "replace-selection-with-secret",
      name: "\u5C06\u9009\u4E2D\u6587\u672C\u4FDD\u5B58\u4E3A\u5BC6\u94A5\u5E76\u66FF\u6362 (Save Selection as Secret)",
      editorCallback: (editor, view) => {
        const selection = editor.getSelection();
        if (!selection || selection.trim() === "") {
          new Notice("\u26A0\uFE0F \u8BF7\u5148\u9009\u4E2D\u8981\u4FDD\u5B58\u4E3A\u5BC6\u94A5\u7684\u6587\u672C");
          return;
        }
        this.ensureUnlocked(() => {
          new ReplaceWithSecretModal(this.app, this, editor, selection).open();
        });
      }
    });
    this.addCommand({
      id: "save-secret",
      name: "\u4FDD\u5B58\u5BC6\u94A5 (Save Secret)",
      callback: () => {
        this.ensureUnlocked(() => {
          new SaveSecretModal(this.app, this).open();
        });
      }
    });
    this.addCommand({
      id: "get-secret",
      name: "\u83B7\u53D6\u5BC6\u94A5 (Get Secret)",
      callback: () => {
        this.ensureUnlocked(() => {
          new GetSecretModal(this.app, this).open();
        });
      }
    });
    this.addCommand({
      id: "list-secrets",
      name: "\u5217\u51FA\u6240\u6709\u5BC6\u94A5 (List All Secrets)",
      callback: () => {
        this.ensureUnlocked(() => {
          this.listAllSecrets();
        });
      }
    });
    this.addCommand({
      id: "delete-secret",
      name: "\u5220\u9664\u5BC6\u94A5 (Delete Secret)",
      callback: () => {
        this.ensureUnlocked(() => {
          new DeleteSecretModal(this.app, this).open();
        });
      }
    });
    this.addCommand({
      id: "unlock-vault",
      name: "\u89E3\u9501\u5BC6\u94A5\u5E93 (Unlock Vault)",
      checkCallback: (checking) => {
        if (this.settings.storageMode === "sync") {
          if (!checking) {
            this.ensureUnlocked(() => {
              new Notice("\u2705 \u5BC6\u94A5\u5E93\u5DF2\u89E3\u9501");
            });
          }
          return true;
        }
        return false;
      }
    });
    this.addCommand({
      id: "lock-vault",
      name: "\u9501\u5B9A\u5BC6\u94A5\u5E93 (Lock Vault)",
      checkCallback: (checking) => {
        if (this.settings.storageMode === "sync" && this.storageProvider.isUnlocked()) {
          if (!checking) {
            this.storageProvider.lock();
            new Notice("\u{1F512} \u5BC6\u94A5\u5E93\u5DF2\u9501\u5B9A");
          }
          return true;
        }
        return false;
      }
    });
    this.addCommand({
      id: "change-password",
      name: "\u4FEE\u6539\u4E3B\u5BC6\u7801 (Change Master Password)",
      checkCallback: (checking) => {
        if (this.settings.storageMode !== "sync")
          return false;
        if (!this.storageProvider.isUnlocked())
          return false;
        if (!checking) {
          new ChangePasswordModal(
            this.app,
            this.storageProvider,
            () => new Notice("\u2705 \u5BC6\u7801\u5DF2\u4FEE\u6539")
          ).open();
        }
        return true;
      }
    });
    this.addCommand({
      id: "check-sync",
      name: "\u68C0\u67E5\u540C\u6B65\u72B6\u6001 (Check Sync Status)",
      checkCallback: (checking) => {
        if (this.settings.storageMode === "sync" && this.storageProvider.isUnlocked()) {
          if (!checking) {
            this.checkSyncStatus();
          }
          return true;
        }
        return false;
      }
    });
    this.addSettingTab(new SecretStorageSettingTab(this.app, this));
    this.addRibbonIcon("key", "Secret Storage", () => {
      this.ensureUnlocked(() => {
        new SecretManagerModal(this.app, this).open();
      });
    });
    console.log("SecretStorage Demo Plugin loaded");
  }
  onunload() {
    if (this.settings.storageMode === "sync" && this.storageProvider) {
      this.storageProvider.lock();
    }
    console.log("SecretStorage Demo Plugin unloaded");
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  // ============================================
  // 存储提供者管理
  // ============================================
  /**
   * 初始化存储提供者
   */
  async initStorageProvider() {
    this.storageProvider = createStorageProvider(
      this.app,
      this.settings.storageMode,
      this.settings.autoLockTimeout
    );
  }
  /**
   * 切换存储模式
   */
  async switchStorageMode(newMode) {
    if (newMode === this.settings.storageMode) {
      return;
    }
    if (newMode === "sync") {
      const syncProvider = new SyncStorageProvider(this.app, this.settings.autoLockTimeout);
      const isInitialized = await syncProvider.isInitialized();
      const applySyncMode = async () => {
        this.storageProvider = syncProvider;
        this.settings.storageMode = "sync";
        await this.saveSettings();
        new Notice("✅ 已切换到同步模式");
      };
      const onCreated = async () => {
        const localSecrets = await this.getLocalSecretsMap();
        if (Object.keys(localSecrets).length > 0) {
          new MigrationModal(this.app, syncProvider, localSecrets, applySyncMode).open();
        } else {
          await applySyncMode();
        }
      };
      if (!isInitialized) {
        // RFC-001 §5.2：文件不存在 → VaultNotFoundModal（显式确认 + 痕迹检测 + 二次确认），
        // 不再直接弹 SetupPasswordModal，防止第二台设备误建空库覆盖远端
        new VaultNotFoundModal(this.app, syncProvider, {
          onCreated,
          onUnlocked: applySyncMode,
          onCancel: () => {
            // 审计次要观察：取消时设置页 dropdown 由 display() 重绘回实际 settings
            new Notice("已取消切换到同步模式");
          }
        }).open();
      } else {
        // RFC-001 §5.3：解锁分支与 ensureUnlocked 一致（解锁后做冲突检查）
        this.unlockWithConflictCheck(syncProvider, applySyncMode);
      }
    } else {
      this.storageProvider = new LocalStorageProvider(this.app);
      this.settings.storageMode = "local";
      await this.saveSettings();
      new Notice("\u2705 \u5DF2\u5207\u6362\u5230\u672C\u5730\u6A21\u5F0F");
    }
  }
  /**
   * 获取本地密钥映射
   */
  async getLocalSecretsMap() {
    const localProvider = new LocalStorageProvider(this.app);
    const ids = await localProvider.list();
    const secrets = {};
    for (const id of ids) {
      const secret = await localProvider.get(id);
      if (secret) {
        secrets[id] = secret;
      }
    }
    return secrets;
  }
  /**
   * 确保密钥库已解锁
   */
  ensureUnlocked(callback) {
    if (this.settings.storageMode === "local") {
      callback();
      return;
    }
    const syncProvider = this.storageProvider;
    if (syncProvider.isUnlocked()) {
      this.checkAndHandleConflict(syncProvider, callback);
      return;
    }
    syncProvider.isInitialized().then((initialized) => {
      if (!initialized) {
        // RFC-001 §5.2：文件不存在 → VaultNotFoundModal，不再直接弹 SetupPasswordModal
        new VaultNotFoundModal(this.app, syncProvider, {
          onCreated: callback,
          onUnlocked: callback
        }).open();
      } else {
        this.unlockWithConflictCheck(syncProvider, callback);
      }
    });
  }
  /**
   * 解锁 + 冲突检查公共流程（RFC-001 §5.3）：switchStorageMode 与 ensureUnlocked 共用，
   * 避免两处入口再次分叉
   */
  unlockWithConflictCheck(syncProvider, onSuccess) {
    new UnlockModal(this.app, syncProvider, () => {
      this.checkAndHandleConflict(syncProvider, onSuccess);
    }).open();
  }
  /**
   * 检查并处理同步冲突
   */
  async checkAndHandleConflict(syncProvider, callback) {
    const conflictType = await syncProvider.detectConflict();
    switch (conflictType) {
      case "none":
      case "local-newer":
        callback();
        break;
      case "remote-newer":
        await syncProvider.refresh();
        new Notice("\u{1F504} \u5DF2\u540C\u6B65\u8FDC\u7A0B\u66F4\u65B0");
        callback();
        break;
      case "conflict":
        const conflictInfo = syncProvider.getConflictInfo();
        if (conflictInfo) {
          new ConflictResolutionModal(
            this.app,
            syncProvider,
            conflictInfo,
            (resolution) => {
              if (resolution !== "cancel") {
                callback();
              }
            }
          ).open();
        } else {
          callback();
        }
        break;
    }
  }
  /**
   * 冲突错误统一处理（RFC-001 §5.4，审计 D-3）：
   * 弹出 ConflictResolutionModal，或提示「远端已有更新，请先刷新」
   */
  promptConflictResolution() {
    const syncProvider = this.storageProvider;
    const conflictInfo = syncProvider.getConflictInfo();
    if (conflictInfo) {
      new ConflictResolutionModal(this.app, syncProvider, conflictInfo, (resolution) => {
        if (resolution !== "cancel") {
          new Notice(`✅ 冲突已解决 (${resolution})`);
        }
      }).open();
    } else {
      new Notice("⚠️ 远端已有更新，请先刷新");
    }
  }
  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    if (this.settings.storageMode !== "sync") {
      new Notice("\u26A0\uFE0F \u4EC5\u540C\u6B65\u6A21\u5F0F\u53EF\u7528");
      return;
    }
    const syncProvider = this.storageProvider;
    if (!syncProvider.isUnlocked()) {
      new Notice("\u26A0\uFE0F \u8BF7\u5148\u89E3\u9501\u5BC6\u94A5\u5E93");
      return;
    }
    const conflictType = await syncProvider.detectConflict();
    switch (conflictType) {
      case "none":
        new Notice("\u2705 \u540C\u6B65\u72B6\u6001\u6B63\u5E38\uFF0C\u65E0\u51B2\u7A81");
        break;
      case "local-newer":
        new Notice("\u{1F4F1} \u672C\u5730\u7248\u672C\u8F83\u65B0\uFF0C\u7B49\u5F85\u540C\u6B65\u4E0A\u4F20");
        break;
      case "remote-newer":
        await syncProvider.refresh();
        new Notice("\u{1F504} \u5DF2\u540C\u6B65\u8FDC\u7A0B\u66F4\u65B0");
        break;
      case "conflict":
        const conflictInfo = syncProvider.getConflictInfo();
        if (conflictInfo) {
          new ConflictResolutionModal(
            this.app,
            syncProvider,
            conflictInfo,
            (resolution) => {
              if (resolution !== "cancel") {
                new Notice(`\u2705 \u51B2\u7A81\u5DF2\u89E3\u51B3 (${resolution})`);
              }
            }
          ).open();
        } else {
          new Notice("\u26A0\uFE0F \u68C0\u6D4B\u5230\u51B2\u7A81\u4F46\u65E0\u6CD5\u83B7\u53D6\u8BE6\u60C5");
        }
        break;
    }
  }
  // ============================================
  // SecretStorage API 核心方法
  // ============================================
  /**
   * 保存密钥
   */
  async saveSecret(id, secret) {
    if (!/^[a-z0-9-]+$/.test(id)) {
      new Notice("\u274C \u5BC6\u94A5ID\u53EA\u80FD\u5305\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u77ED\u6A2A\u7EBF");
      return false;
    }
    try {
      const success = await this.storageProvider.save(id, secret);
      if (success && this.settings.showNotifications) {
        const modeText = this.settings.storageMode === "sync" ? "\u540C\u6B65\u5BC6\u94A5\u5E93" : "\u7CFB\u7EDF\u94A5\u5319\u4E32";
        new Notice(`\u2705 \u5BC6\u94A5 "${id}" \u5DF2\u4FDD\u5B58\u5230${modeText}`);
      }
      return success;
    } catch (error) {
      // 错误传播契约（RFC-001 §5.4，审计 D-3）：冲突 → 弹出冲突解决
      if (error instanceof SyncConflictError) {
        this.promptConflictResolution();
        return false;
      }
      console.error("saveSecret error:", error);
      return false;
    }
  }
  /**
   * 获取密钥
   */
  async getSecret(id) {
    return this.storageProvider.get(id);
  }
  /**
   * 列出所有密钥 ID
   */
  async listSecrets() {
    return this.storageProvider.list();
  }
  /**
   * 删除密钥
   */
  async deleteSecret(id) {
    try {
      const success = await this.storageProvider.delete(id);
      if (success && this.settings.showNotifications) {
        new Notice(`\u{1F5D1}\uFE0F \u5BC6\u94A5 "${id}" \u5DF2\u5220\u9664`);
      }
      return success;
    } catch (error) {
      // 错误传播契约（RFC-001 §5.4，审计 D-3）
      if (error instanceof SyncConflictError) {
        this.promptConflictResolution();
        return false;
      }
      console.error("deleteSecret error:", error);
      return false;
    }
  }
  /**
   * 列出并显示所有密钥
   */
  async listAllSecrets() {
    const secrets = await this.listSecrets();
    if (secrets.length === 0) {
      new Notice("\u{1F4ED} \u6CA1\u6709\u5B58\u50A8\u7684\u5BC6\u94A5");
    } else {
      new Notice(`\u{1F511} \u5DF2\u5B58\u50A8\u7684\u5BC6\u94A5 (${secrets.length}\u4E2A):
${secrets.join("\n")}`);
    }
  }
  // ============================================
  // 占位符处理功能
  // ============================================
  /**
   * 处理 Markdown 中的密钥占位符
   */
  processSecretPlaceholders(element, context) {
    if (!this.settings.enablePlaceholderReplacement)
      return;
    const isUnlocked = this.storageProvider.isUnlocked();
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );
    const nodesToReplace = [];
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent || "";
      const matches = [...text.matchAll(SECRET_PLACEHOLDER_REGEX)];
      if (matches.length > 0) {
        nodesToReplace.push({ node, matches });
      }
    }
    for (const { node: node2, matches } of nodesToReplace) {
      const parent = node2.parentNode;
      if (!parent)
        continue;
      let lastIndex = 0;
      const fragment = document.createDocumentFragment();
      const text = node2.textContent || "";
      for (const match of matches) {
        const secretId = match[1];
        const matchIndex = match.index;
        if (matchIndex > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)));
        }
        const secretEl = this.createSecretElement(secretId, isUnlocked);
        fragment.appendChild(secretEl);
        lastIndex = matchIndex + match[0].length;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      parent.replaceChild(fragment, node2);
    }
  }
  /**
   * 创建密钥显示元素
   */
  createSecretElement(secretId, isUnlocked = true) {
    const container = document.createElement("span");
    container.addClass("secret-placeholder");
    if (!isUnlocked) {
      container.addClass("secret-locked");
      const idLength = secretId.length;
      let displayText;
      let titleText;
      if (idLength <= 3) {
        displayText = "\u{1F512}";
        titleText = `\u5BC6\u94A5 "${secretId}" - \u70B9\u51FB\u89E3\u9501`;
      } else if (idLength <= 6) {
        displayText = `\u{1F512} ${secretId}`;
        titleText = "\u70B9\u51FB\u89E3\u9501\u5BC6\u94A5\u5E93";
      } else if (idLength <= 12) {
        displayText = "\u{1F512} \u70B9\u51FB\u89E3\u9501";
        titleText = `\u5BC6\u94A5 "${secretId}" - \u70B9\u51FB\u89E3\u9501\u5BC6\u94A5\u5E93`;
      } else {
        displayText = "\u{1F512} \u70B9\u51FB\u89E3\u9501\u4EE5\u67E5\u770B\u5BC6\u94A5";
        titleText = `\u5BC6\u94A5 "${secretId}"`;
      }
      container.textContent = displayText;
      container.title = titleText;
      container.style.cursor = "pointer";
      container.addEventListener("click", () => {
        this.ensureUnlocked(() => {
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeView) {
            activeView.previewMode.rerender(true);
          }
        });
      });
      return container;
    }
    this.getSecret(secretId).then((secret) => {
      if (!secret) {
        container.addClass("secret-not-found");
        container.textContent = `\u26A0\uFE0F {{secret:${secretId}}}`;
        container.title = `\u5BC6\u94A5 "${secretId}" \u672A\u627E\u5230`;
        return;
      }
      switch (this.settings.placeholderStyle) {
        case "blur":
          container.addClass("secret-blur");
          container.textContent = secret;
          container.title = `\u60AC\u505C\u67E5\u770B | \u70B9\u51FB\u590D\u5236\u5BC6\u94A5 "${secretId}"`;
          break;
        case "hidden":
          container.addClass("secret-hidden");
          container.textContent = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
          container.title = `\u70B9\u51FB\u590D\u5236\u5BC6\u94A5 "${secretId}"`;
          break;
        case "plain":
          container.textContent = secret;
          container.title = `\u70B9\u51FB\u590D\u5236\u5BC6\u94A5 "${secretId}"`;
          break;
      }
      container.style.cursor = "pointer";
      container.addEventListener("click", async () => {
        await navigator.clipboard.writeText(secret);
        new Notice(`\u2705 \u5BC6\u94A5 "${secretId}" \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F`);
      });
    });
    container.textContent = "...";
    return container;
  }
};
class InsertPlaceholderModal extends Modal {
  plugin: any;
  editor: any;
  constructor(app, plugin, editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u{1F4DD} \u63D2\u5165\u5BC6\u94A5\u5360\u4F4D\u7B26" });
    contentEl.createEl("p", {
      text: "\u9009\u62E9\u4E00\u4E2A\u5DF2\u4FDD\u5B58\u7684\u5BC6\u94A5\uFF0C\u63D2\u5165\u5360\u4F4D\u7B26\u5230\u5F53\u524D\u5149\u6807\u4F4D\u7F6E",
      cls: "setting-item-description"
    });
    const secrets = await this.plugin.listSecrets();
    if (secrets.length === 0) {
      contentEl.createEl("p", { text: "\u274C \u6CA1\u6709\u5DF2\u5B58\u50A8\u7684\u5BC6\u94A5\uFF0C\u8BF7\u5148\u4FDD\u5B58\u5BC6\u94A5" });
      new Setting(contentEl).addButton((btn) => btn.setButtonText("\u4FDD\u5B58\u5BC6\u94A5").setCta().onClick(() => {
        this.close();
        new SaveSecretModal(this.app, this.plugin).open();
      }));
      return;
    }
    contentEl.createEl("p", {
      text: "\u5360\u4F4D\u7B26\u8BED\u6CD5: {{secret:\u5BC6\u94A5ID}}",
      cls: "setting-item-description"
    });
    secrets.forEach((id) => {
      new Setting(contentEl).setName(id).setDesc(`\u63D2\u5165 {{secret:${id}}}`).addButton((btn) => btn.setButtonText("\u63D2\u5165").setCta().onClick(() => {
        const placeholder = `{{secret:${id}}}`;
        this.editor.replaceSelection(placeholder);
        this.close();
        new Notice(`\u2705 \u5DF2\u63D2\u5165\u5360\u4F4D\u7B26: ${placeholder}`);
      }));
    });
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class ReplaceWithSecretModal extends Modal {
  plugin: any;
  editor: any;
  selectedText: any;
  idInput: any;
  constructor(app, plugin, editor, selectedText) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.selectedText = selectedText;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u{1F510} \u4FDD\u5B58\u5E76\u66FF\u6362\u4E3A\u5360\u4F4D\u7B26" });
    const maskedText = this.selectedText.length > 8 ? this.selectedText.slice(0, 4) + "\u2022\u2022\u2022\u2022" + this.selectedText.slice(-4) : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
    contentEl.createEl("p", {
      text: `\u9009\u4E2D\u7684\u5BC6\u94A5: ${maskedText}`,
      cls: "setting-item-description"
    });
    contentEl.createEl("p", {
      text: `\u957F\u5EA6: ${this.selectedText.length} \u5B57\u7B26`,
      cls: "setting-item-description"
    });
    new Setting(contentEl).setName("\u5BC6\u94A5 ID").setDesc("\u53EA\u80FD\u5305\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u77ED\u6A2A\u7EBF").addText((text) => {
      this.idInput = text;
      text.setPlaceholder("my-api-key");
      setTimeout(() => text.inputEl.focus(), 10);
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u4FDD\u5B58\u5E76\u66FF\u6362").setCta().onClick(async () => {
      const id = this.idInput.getValue().trim().toLowerCase();
      if (!id) {
        new Notice("\u26A0\uFE0F \u8BF7\u8F93\u5165\u5BC6\u94A5 ID");
        return;
      }
      if (!/^[a-z0-9-]+$/.test(id)) {
        new Notice("\u274C \u5BC6\u94A5ID\u53EA\u80FD\u5305\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u77ED\u6A2A\u7EBF");
        return;
      }
      if (await this.plugin.saveSecret(id, this.selectedText)) {
        const placeholder = `{{secret:${id}}}`;
        this.editor.replaceSelection(placeholder);
        this.close();
        new Notice(`\u2705 \u5DF2\u4FDD\u5B58\u5BC6\u94A5\u5E76\u66FF\u6362\u4E3A: ${placeholder}`);
      }
    })).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.close()));
    contentEl.createEl("hr");
    const tipEl = contentEl.createEl("div", { cls: "setting-item-description" });
    tipEl.innerHTML = `
			<p>\u{1F4A1} <strong>\u64CD\u4F5C\u8BF4\u660E:</strong></p>
			<ol>
				<li>\u8F93\u5165\u4E00\u4E2A\u6613\u8BB0\u7684\u5BC6\u94A5 ID</li>
				<li>\u70B9\u51FB"\u4FDD\u5B58\u5E76\u66FF\u6362"</li>
				<li>\u9009\u4E2D\u7684\u6587\u672C\u5C06\u4FDD\u5B58\u5230\u5BC6\u94A5\u5E93</li>
				<li>\u539F\u6587\u672C\u66FF\u6362\u4E3A <code>{{secret:\u5BC6\u94A5ID}}</code></li>
			</ol>
		`;
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class SaveSecretModal extends Modal {
  plugin: any;
  onSaveSuccess: any;
  idInput: any;
  secretInput: any;
  constructor(app, plugin, onSaveSuccess = null) {
    super(app);
    this.plugin = plugin;
    this.onSaveSuccess = onSaveSuccess;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u{1F510} \u4FDD\u5B58\u5BC6\u94A5" });
    new Setting(contentEl).setName("\u5BC6\u94A5 ID").setDesc("\u53EA\u80FD\u5305\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u77ED\u6A2A\u7EBF (\u4F8B\u5982: my-api-key)").addText((text) => {
      this.idInput = text;
      text.setPlaceholder("my-api-key");
    });
    new Setting(contentEl).setName("\u5BC6\u94A5\u503C").setDesc("\u5C06\u5B89\u5168\u5B58\u50A8\u5728\u5BC6\u94A5\u5E93\u4E2D").addText((text) => {
      this.secretInput = text;
      text.setPlaceholder("your-secret-value");
      text.inputEl.type = "password";
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u4FDD\u5B58").setCta().onClick(async () => {
      var _a;
      const id = this.idInput.getValue().trim();
      const secret = this.secretInput.getValue();
      if (!id || !secret) {
        new Notice("\u8BF7\u586B\u5199\u6240\u6709\u5B57\u6BB5");
        return;
      }
      if (await this.plugin.saveSecret(id, secret)) {
        this.close();
        (_a = this.onSaveSuccess) == null ? void 0 : _a.call(this);
      }
    })).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.close()));
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class GetSecretModal extends Modal {
  plugin: any;
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u{1F50D} \u83B7\u53D6\u5BC6\u94A5" });
    const secrets = await this.plugin.listSecrets();
    if (secrets.length === 0) {
      contentEl.createEl("p", { text: "\u6CA1\u6709\u5DF2\u5B58\u50A8\u7684\u5BC6\u94A5" });
      return;
    }
    for (const id of secrets) {
      new Setting(contentEl).setName(id).addButton((btn) => btn.setButtonText("\u67E5\u770B").onClick(async () => {
        const secret = await this.plugin.getSecret(id);
        if (secret) {
          new Notice(`\u5BC6\u94A5 "${id}":
${secret}`, 5e3);
        } else {
          new Notice(`\u5BC6\u94A5 "${id}" \u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A`);
        }
      })).addButton((btn) => btn.setButtonText("\u590D\u5236").onClick(async () => {
        const secret = await this.plugin.getSecret(id);
        if (secret) {
          await navigator.clipboard.writeText(secret);
          new Notice(`\u2705 \u5BC6\u94A5 "${id}" \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F`);
        }
      }));
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class DeleteSecretModal extends Modal {
  plugin: any;
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u{1F5D1}\uFE0F \u5220\u9664\u5BC6\u94A5" });
    const secrets = await this.plugin.listSecrets();
    if (secrets.length === 0) {
      contentEl.createEl("p", { text: "\u6CA1\u6709\u5DF2\u5B58\u50A8\u7684\u5BC6\u94A5" });
      return;
    }
    for (const id of secrets) {
      new Setting(contentEl).setName(id).addButton((btn) => btn.setButtonText("\u5220\u9664").setWarning().onClick(async () => {
        if (await this.plugin.deleteSecret(id)) {
          this.close();
          new DeleteSecretModal(this.app, this.plugin).open();
        }
      }));
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class SecretManagerModal extends Modal {
  plugin: any;
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-manager-modal");
    contentEl.createEl("h2", { text: "\u{1F510} \u5BC6\u94A5\u7BA1\u7406\u5668" });
    const modeText = this.plugin.settings.storageMode === "sync" ? "\u540C\u6B65\u6A21\u5F0F (\u52A0\u5BC6\u6587\u4EF6)" : "\u672C\u5730\u6A21\u5F0F (\u7CFB\u7EDF\u94A5\u5319\u4E32)";
    const lockStatus = this.plugin.storageProvider.isUnlocked() ? "\u{1F513} \u5DF2\u89E3\u9501" : "\u{1F512} \u5DF2\u9501\u5B9A";
    contentEl.createEl("p", {
      text: `\u6A21\u5F0F: ${modeText} | \u72B6\u6001: ${lockStatus}`,
      cls: "setting-item-description"
    });
    if (this.plugin.settings.storageMode === "sync") {
      const syncProvider = this.plugin.storageProvider;
      new Setting(contentEl).setName("\u9501\u5B9A\u5BC6\u94A5\u5E93").setDesc("\u7ACB\u5373\u9501\u5B9A\uFF0C\u9700\u8981\u91CD\u65B0\u8F93\u5165\u5BC6\u7801\u624D\u80FD\u8BBF\u95EE").addButton((btn) => btn.setButtonText("\u9501\u5B9A").onClick(() => {
        syncProvider.lock();
        this.close();
        new Notice("\u{1F512} \u5BC6\u94A5\u5E93\u5DF2\u9501\u5B9A");
      }));
      new Setting(contentEl).setName("\u4FEE\u6539\u4E3B\u5BC6\u7801").setDesc("\u66F4\u6539\u7528\u4E8E\u52A0\u5BC6\u5BC6\u94A5\u5E93\u7684\u5BC6\u7801").addButton((btn) => btn.setButtonText("\u4FEE\u6539\u5BC6\u7801").onClick(() => {
        this.close();
        new ChangePasswordModal(this.app, syncProvider, () => {
          new Notice("\u2705 \u5BC6\u7801\u5DF2\u4FEE\u6539");
        }).open();
      }));
      contentEl.createEl("hr");
    }
    new Setting(contentEl).setName("\u4FDD\u5B58\u65B0\u5BC6\u94A5").setDesc("\u5C06\u5BC6\u94A5\u5B89\u5168\u5B58\u50A8\u5230\u5BC6\u94A5\u5E93").addButton((btn) => btn.setButtonText("\u4FDD\u5B58\u5BC6\u94A5").setCta().onClick(() => {
      this.close();
      new SaveSecretModal(this.app, this.plugin).open();
    }));
    new Setting(contentEl).setName("\u67E5\u770B/\u590D\u5236\u5BC6\u94A5").setDesc("\u67E5\u770B\u6216\u590D\u5236\u5DF2\u5B58\u50A8\u7684\u5BC6\u94A5").addButton((btn) => btn.setButtonText("\u67E5\u770B\u5BC6\u94A5").onClick(() => {
      this.close();
      new GetSecretModal(this.app, this.plugin).open();
    }));
    new Setting(contentEl).setName("\u5220\u9664\u5BC6\u94A5").setDesc("\u4ECE\u5BC6\u94A5\u5E93\u4E2D\u5220\u9664\u5BC6\u94A5").addButton((btn) => btn.setButtonText("\u5220\u9664\u5BC6\u94A5").setWarning().onClick(() => {
      this.close();
      new DeleteSecretModal(this.app, this.plugin).open();
    }));
    const secrets = await this.plugin.listSecrets();
    contentEl.createEl("hr");
    contentEl.createEl("p", {
      text: `\u{1F4CA} \u5F53\u524D\u5DF2\u5B58\u50A8 ${secrets.length} \u4E2A\u5BC6\u94A5`,
      cls: "setting-item-description"
    });
    if (secrets.length > 0) {
      const list = contentEl.createEl("ul");
      secrets.forEach((id) => {
        list.createEl("li", { text: id });
      });
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
class SecretStorageSettingTab extends PluginSettingTab {
  plugin: any;
  secretSectionEl: any;
  editingId: any;
  constructor(app, plugin) {
    super(app, plugin);
    // 密钥管理区块引用，用于局部刷新
    this.secretSectionEl = null;
    // 当前正在编辑的密钥 ID
    this.editingId = null;
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SecretStorage \u63D2\u4EF6\u8BBE\u7F6E" });
    containerEl.createEl("h3", { text: "\u5B58\u50A8\u6A21\u5F0F" });
    new Setting(containerEl).setName("\u5B58\u50A8\u6A21\u5F0F").setDesc("\u9009\u62E9\u5BC6\u94A5\u5B58\u50A8\u65B9\u5F0F").addDropdown((dropdown) => dropdown.addOption("local", "\u672C\u5730\u6A21\u5F0F (\u7CFB\u7EDF\u94A5\u5319\u4E32\uFF0C\u4E0D\u53EF\u540C\u6B65)").addOption("sync", "\u540C\u6B65\u6A21\u5F0F (\u52A0\u5BC6\u6587\u4EF6\uFF0C\u53EF\u540C\u6B65)").setValue(this.plugin.settings.storageMode).onChange(async (value) => {
      await this.plugin.switchStorageMode(value);
      this.display();
    }));
    if (this.plugin.settings.storageMode === "sync") {
      new Setting(containerEl).setName("\u81EA\u52A8\u9501\u5B9A\u65F6\u95F4").setDesc("\u4E0D\u6D3B\u52A8\u591A\u4E45\u540E\u81EA\u52A8\u9501\u5B9A\u5BC6\u94A5\u5E93\uFF08\u5206\u949F\uFF0C0 \u8868\u793A\u7981\u7528\uFF09").addSlider((slider) => slider.setLimits(0, 120, 5).setValue(this.plugin.settings.autoLockTimeout).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.autoLockTimeout = value;
        await this.plugin.saveSettings();
        if (this.plugin.storageProvider.getMode() === "sync") {
          this.plugin.storageProvider.setAutoLockTimeout(value);
        }
      }));
      new Setting(containerEl).setName("\u5907\u4EFD\u6570\u91CF").setDesc("\u4FDD\u7559\u591A\u5C11\u4E2A\u5386\u53F2\u5907\u4EFD\u7248\u672C").addSlider((slider) => slider.setLimits(0, 20, 1).setValue(this.plugin.settings.keepBackupCount).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.keepBackupCount = value;
        await this.plugin.saveSettings();
      }));
      new Setting(containerEl).setName("\u4FEE\u6539\u4E3B\u5BC6\u7801").setDesc("\u66F4\u6539\u5BC6\u94A5\u5E93\u7684\u4E3B\u5BC6\u7801\uFF08\u9700\u8981\u5148\u89E3\u9501\uFF09").addButton((btn) => btn.setButtonText("\u4FEE\u6539\u5BC6\u7801").onClick(() => {
        if (!this.plugin.storageProvider.isUnlocked()) {
          new Notice("\u26A0\uFE0F \u8BF7\u5148\u89E3\u9501\u5BC6\u94A5\u5E93");
          return;
        }
        new ChangePasswordModal(
          this.app,
          this.plugin.storageProvider,
          () => new Notice("\u2705 \u5BC6\u7801\u5DF2\u4FEE\u6539")
        ).open();
      }));
    }
    containerEl.createEl("h3", { text: "\u901A\u7528\u8BBE\u7F6E" });
    new Setting(containerEl).setName("\u663E\u793A\u901A\u77E5").setDesc("\u64CD\u4F5C\u5B8C\u6210\u540E\u663E\u793A\u901A\u77E5\u6D88\u606F").addToggle((toggle) => toggle.setValue(this.plugin.settings.showNotifications).onChange(async (value) => {
      this.plugin.settings.showNotifications = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "\u5360\u4F4D\u7B26\u8BBE\u7F6E" });
    new Setting(containerEl).setName("\u542F\u7528\u5360\u4F4D\u7B26\u66FF\u6362").setDesc("\u5728\u9605\u8BFB\u6A21\u5F0F\u4E0B\u81EA\u52A8\u5C06 {{secret:\u5BC6\u94A5ID}} \u66FF\u6362\u4E3A\u771F\u5B9E\u5BC6\u94A5\u503C").addToggle((toggle) => toggle.setValue(this.plugin.settings.enablePlaceholderReplacement).onChange(async (value) => {
      this.plugin.settings.enablePlaceholderReplacement = value;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("\u5BC6\u94A5\u663E\u793A\u6837\u5F0F").setDesc("\u5728\u9605\u8BFB\u6A21\u5F0F\u4E0B\u5982\u4F55\u663E\u793A\u5BC6\u94A5").addDropdown((dropdown) => dropdown.addOption("blur", "\u6A21\u7CCA (\u60AC\u505C\u663E\u793A)").addOption("hidden", "\u9690\u85CF (\u70B9\u51FB\u590D\u5236)").addOption("plain", "\u660E\u6587\u663E\u793A").setValue(this.plugin.settings.placeholderStyle).onChange(async (value) => {
      this.plugin.settings.placeholderStyle = value;
      await this.plugin.saveSettings();
    }));
    this.secretSectionEl = containerEl.createDiv({ cls: "secret-management-section" });
    this.secretSectionEl.createEl("h3", { text: "\u{1F511} \u5BC6\u94A5\u7BA1\u7406" });
    this.secretSectionEl.createEl("p", {
      text: "\u52A0\u8F7D\u4E2D...",
      cls: "secret-list-loading"
    });
    this.loadSecretSection();
    containerEl.createEl("h3", { text: "\u4F7F\u7528\u8BF4\u660E" });
    const docEl = containerEl.createEl("div", { cls: "setting-item-description" });
    docEl.innerHTML = `
			<p><strong>\u5B58\u50A8\u6A21\u5F0F\u8BF4\u660E:</strong></p>
			<ul>
				<li><strong>\u672C\u5730\u6A21\u5F0F</strong>: \u4F7F\u7528\u64CD\u4F5C\u7CFB\u7EDF\u7684\u5B89\u5168\u5B58\u50A8 (macOS Keychain / Windows Credential Manager)\uFF0C\u5BC6\u94A5\u4E0D\u4F1A\u540C\u6B65\u5230\u5176\u4ED6\u8BBE\u5907</li>
				<li><strong>\u540C\u6B65\u6A21\u5F0F</strong>: \u4F7F\u7528 AES-256-GCM \u52A0\u5BC6\u5B58\u50A8\u5230 vault \u5185\u7684\u6587\u4EF6\uFF0C\u53EF\u901A\u8FC7 remotely-save \u7B49\u63D2\u4EF6\u540C\u6B65\u5230\u5176\u4ED6\u8BBE\u5907</li>
			</ul>
			<p><strong>\u5360\u4F4D\u7B26\u8BED\u6CD5:</strong></p>
			<code>{{secret:\u5BC6\u94A5ID}}</code>
			<p>\u4F8B\u5982: <code>{{secret:openai-api-key}}</code></p>
		`;
  }
  // ============================================
  // 密钥管理区块 - 异步加载
  // ============================================
  /**
   * 异步加载密钥管理区块
   */
  async loadSecretSection() {
    if (!this.secretSectionEl)
      return;
    this.secretSectionEl.empty();
    this.secretSectionEl.createEl("h3", { text: "\u{1F511} \u5BC6\u94A5\u7BA1\u7406" });
    await this.renderSecretManagement(this.secretSectionEl);
  }
  /**
   * 局部刷新密钥列表
   */
  async refreshSecretList() {
    this.editingId = null;
    await this.loadSecretSection();
  }
  /**
   * 渲染密钥管理区块
   */
  async renderSecretManagement(containerEl) {
    if (this.plugin.settings.storageMode === "sync" && !this.plugin.storageProvider.isUnlocked()) {
      new Setting(containerEl).setName("\u5BC6\u94A5\u5E93\u5DF2\u9501\u5B9A").setDesc("\u8BF7\u5148\u89E3\u9501\u5BC6\u94A5\u5E93\u4EE5\u7BA1\u7406\u5BC6\u94A5").addButton((btn) => btn.setButtonText("\u{1F513} \u89E3\u9501").setCta().onClick(() => {
        this.plugin.ensureUnlocked(() => {
          this.refreshSecretList();
        });
      }));
      return;
    }
    this.renderAddButton(containerEl);
    const secrets = await this.plugin.listSecrets();
    if (secrets.length === 0) {
      containerEl.createEl("p", {
        text: "\u6682\u65E0\u5BC6\u94A5\uFF0C\u70B9\u51FB\u4E0A\u65B9\u6309\u94AE\u6DFB\u52A0",
        cls: "secret-list-empty"
      });
      return;
    }
    const listEl = containerEl.createDiv({ cls: "secret-list" });
    for (const secretId of secrets) {
      if (this.editingId === secretId) {
        this.renderEditForm(listEl, secretId);
      } else {
        this.renderSecretItem(listEl, secretId);
      }
    }
  }
  /**
   * 渲染新增按钮
   */
  renderAddButton(containerEl) {
    new Setting(containerEl).setName("\u6DFB\u52A0\u65B0\u5BC6\u94A5").setDesc("\u5C06\u5BC6\u94A5\u5B89\u5168\u5B58\u50A8\u5230\u5BC6\u94A5\u5E93").addButton((btn) => btn.setButtonText("+ \u65B0\u589E\u5BC6\u94A5").setCta().onClick(() => {
      new SaveSecretModal(this.app, this.plugin, () => {
        this.refreshSecretList();
      }).open();
    }));
  }
  /**
   * 渲染密钥列表项
   */
  renderSecretItem(containerEl, secretId) {
    new Setting(containerEl).setName(secretId).setDesc("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022").addButton((btn) => btn.setIcon("pencil").setTooltip("\u7F16\u8F91").onClick(() => this.startEditing(secretId))).addButton((btn) => btn.setIcon("copy").setTooltip("\u590D\u5236").onClick(() => this.copySecret(secretId))).addButton((btn) => btn.setIcon("trash").setTooltip("\u5220\u9664").setWarning().onClick(() => this.confirmDelete(secretId)));
  }
  /**
   * 渲染编辑表单
   */
  renderEditForm(containerEl, secretId) {
    const formEl = containerEl.createDiv({ cls: "secret-edit-form" });
    formEl.createEl("p", {
      text: `\u7F16\u8F91\u5BC6\u94A5: ${secretId}`,
      cls: "secret-edit-title"
    });
    let secretInput;
    let isVisible = false;
    new Setting(formEl).setName("\u65B0\u5BC6\u94A5\u503C").addText((text) => {
      secretInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u8F93\u5165\u65B0\u7684\u5BC6\u94A5\u503C...");
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.saveEdit(secretId, secretInput.getValue());
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.stopEditing();
        }
      });
      setTimeout(() => text.inputEl.focus(), 10);
    }).addExtraButton((btn) => btn.setIcon("eye").setTooltip("\u663E\u793A/\u9690\u85CF").onClick(() => {
      isVisible = !isVisible;
      secretInput.inputEl.type = isVisible ? "text" : "password";
      btn.setIcon(isVisible ? "eye-off" : "eye");
    }));
    new Setting(formEl).addButton((btn) => btn.setButtonText("\u4FDD\u5B58").setCta().onClick(async () => {
      await this.saveEdit(secretId, secretInput.getValue());
    })).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.stopEditing()));
    formEl.createEl("p", {
      text: "\u{1F4A1} Enter \u4FDD\u5B58 | Escape \u53D6\u6D88",
      cls: "secret-edit-hint"
    });
  }
  /**
   * 开始编辑
   */
  startEditing(secretId) {
    this.editingId = secretId;
    this.loadSecretSection();
  }
  /**
   * 停止编辑
   */
  stopEditing() {
    this.editingId = null;
    this.refreshSecretList();
  }
  /**
   * 保存编辑
   */
  async saveEdit(secretId, newValue) {
    if (!newValue.trim()) {
      new Notice("\u26A0\uFE0F \u8BF7\u8F93\u5165\u5BC6\u94A5\u503C");
      return;
    }
    const success = await this.plugin.saveSecret(secretId, newValue);
    if (success) {
      this.stopEditing();
    }
  }
  /**
   * 复制密钥
   */
  async copySecret(secretId) {
    const secret = await this.plugin.getSecret(secretId);
    if (secret) {
      await navigator.clipboard.writeText(secret);
      new Notice(`\u2705 \u5BC6\u94A5 "${secretId}" \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F`);
    } else {
      new Notice(`\u274C \u65E0\u6CD5\u83B7\u53D6\u5BC6\u94A5 "${secretId}"`);
    }
  }
  /**
   * 确认删除
   */
  async confirmDelete(secretId) {
    const confirmed = await new Promise((resolve) => {
      const modal = new ConfirmDeleteModal(
        this.app,
        secretId,
        (result) => resolve(result)
      );
      modal.open();
    });
    if (confirmed) {
      await this.plugin.deleteSecret(secretId);
      await this.refreshSecretList();
    }
  }
};
class ConfirmDeleteModal extends Modal {
  secretId: any;
  onConfirm: any;
  constructor(app, secretId, onConfirm) {
    super(app);
    this.secretId = secretId;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "\u26A0\uFE0F \u786E\u8BA4\u5220\u9664" });
    contentEl.createEl("p", {
      text: `\u786E\u5B9A\u8981\u5220\u9664\u5BC6\u94A5 "${this.secretId}" \u5417\uFF1F`
    });
    contentEl.createEl("p", {
      text: "\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002",
      cls: "setting-item-description"
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u5220\u9664").setWarning().onClick(() => {
      this.onConfirm(true);
      this.close();
    })).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => {
      this.onConfirm(false);
      this.close();
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};

