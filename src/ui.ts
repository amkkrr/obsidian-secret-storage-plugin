import { Modal, Setting, Notice } from "obsidian";

function evaluatePasswordStrength(password) {
  let score = 0;
  const feedback = [];
  if (password.length >= 8)
    score++;
  if (password.length >= 12)
    score++;
  if (password.length >= 16)
    score++;
  if (password.length < 12) {
    feedback.push("\u5EFA\u8BAE\u4F7F\u7528\u81F3\u5C11 12 \u4E2A\u5B57\u7B26");
  }
  if (/[a-z]/.test(password))
    score += 0.25;
  if (/[A-Z]/.test(password))
    score += 0.25;
  if (/[0-9]/.test(password))
    score += 0.25;
  if (/[^a-zA-Z0-9]/.test(password))
    score += 0.25;
  if (!/[A-Z]/.test(password)) {
    feedback.push("\u6DFB\u52A0\u5927\u5199\u5B57\u6BCD");
  }
  if (!/[0-9]/.test(password)) {
    feedback.push("\u6DFB\u52A0\u6570\u5B57");
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    feedback.push("\u6DFB\u52A0\u7279\u6B8A\u5B57\u7B26");
  }
  const commonPatterns = [
    /^123456/,
    /password/i,
    /qwerty/i,
    /^111111/,
    /^000000/
  ];
  for (const pattern of commonPatterns) {
    if (pattern.test(password)) {
      score = Math.max(0, score - 1);
      feedback.push("\u907F\u514D\u4F7F\u7528\u5E38\u89C1\u5BC6\u7801");
      break;
    }
  }
  score = Math.min(4, Math.max(0, Math.floor(score)));
  const labels = ["\u975E\u5E38\u5F31", "\u5F31", "\u4E00\u822C", "\u5F3A", "\u975E\u5E38\u5F3A"];
  const colors = ["#ff4444", "#ff8800", "#ffcc00", "#88cc00", "#00cc44"];
  return {
    score,
    label: labels[score],
    color: colors[score],
    feedback
  };
}
function createPasswordStrengthIndicator(container, password) {
  const strength = evaluatePasswordStrength(password);
  const wrapper = container.createDiv({ cls: "password-strength-wrapper" });
  const bar = wrapper.createDiv({ cls: "password-strength-bar" });
  for (let i = 0; i < 4; i++) {
    const segment = bar.createDiv({ cls: "password-strength-segment" });
    if (i < strength.score) {
      segment.style.backgroundColor = strength.color;
    }
  }
  const label = wrapper.createDiv({ cls: "password-strength-label" });
  label.textContent = `\u5BC6\u7801\u5F3A\u5EA6: ${strength.label}`;
  label.style.color = strength.color;
  if (strength.feedback.length > 0 && password.length > 0) {
    const feedbackEl = wrapper.createDiv({ cls: "password-strength-feedback" });
    feedbackEl.textContent = strength.feedback.join(" \u2022 ");
  }
  return wrapper;
}
export class SetupPasswordModal extends Modal {
  constructor(app, provider, onSuccess) {
    super(app);
    this.provider = provider;
    this.onSuccess = onSuccess;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-storage-modal");
    contentEl.createEl("h2", { text: "\u{1F510} \u8BBE\u7F6E\u4E3B\u5BC6\u7801" });
    const warningEl = contentEl.createDiv({ cls: "setting-item-description" });
    warningEl.style.backgroundColor = "var(--background-modifier-error)";
    warningEl.style.padding = "10px";
    warningEl.style.borderRadius = "5px";
    warningEl.style.marginBottom = "15px";
    warningEl.innerHTML = `
			<strong>\u26A0\uFE0F \u91CD\u8981\u63D0\u793A\uFF1A</strong><br>
			<ul style="margin: 5px 0 0 20px; padding: 0;">
				<li>\u4E3B\u5BC6\u7801\u7528\u4E8E\u52A0\u5BC6\u60A8\u7684\u6240\u6709\u5BC6\u94A5</li>
				<li>\u5982\u679C\u5FD8\u8BB0\u5BC6\u7801\uFF0C<strong>\u65E0\u6CD5\u6062\u590D</strong>\u4EFB\u4F55\u5BC6\u94A5</li>
				<li>\u8BF7\u52A1\u5FC5\u5C06\u5BC6\u7801\u4FDD\u5B58\u5728\u5B89\u5168\u7684\u5730\u65B9</li>
			</ul>
		`;
    new Setting(contentEl).setName("\u4E3B\u5BC6\u7801").setDesc("\u7528\u4E8E\u52A0\u5BC6\u5BC6\u94A5\u5E93").addText((text) => {
      this.passwordInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u8F93\u5165\u4E3B\u5BC6\u7801...");
      text.inputEl.addEventListener("input", () => {
        this.updateStrengthIndicator();
      });
    });
    this.strengthContainer = contentEl.createDiv();
    new Setting(contentEl).setName("\u786E\u8BA4\u5BC6\u7801").setDesc("\u518D\u6B21\u8F93\u5165\u4E3B\u5BC6\u7801").addText((text) => {
      this.confirmInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u786E\u8BA4\u4E3B\u5BC6\u7801...");
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u521B\u5EFA\u5BC6\u94A5\u5E93").setCta().onClick(() => this.handleSetup())).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.close()));
  }
  updateStrengthIndicator() {
    this.strengthContainer.empty();
    const password = this.passwordInput.getValue();
    if (password.length > 0) {
      createPasswordStrengthIndicator(this.strengthContainer, password);
    }
  }
  async handleSetup() {
    const password = this.passwordInput.getValue();
    const confirm = this.confirmInput.getValue();
    if (!password) {
      new Notice("\u26A0\uFE0F \u8BF7\u8F93\u5165\u4E3B\u5BC6\u7801");
      return;
    }
    if (password.length < 12) {
      new Notice("\u26A0\uFE0F \u5BC6\u7801\u81F3\u5C11\u9700\u8981 12 \u4E2A\u5B57\u7B26");
      return;
    }
    if (password !== confirm) {
      new Notice("\u26A0\uFE0F \u4E24\u6B21\u8F93\u5165\u7684\u5BC6\u7801\u4E0D\u4E00\u81F4");
      return;
    }
    const strength = evaluatePasswordStrength(password);
    if (strength.score < 2) {
      new Notice("\u26A0\uFE0F \u5BC6\u7801\u5F3A\u5EA6\u592A\u5F31\uFF0C\u8BF7\u4F7F\u7528\u66F4\u590D\u6742\u7684\u5BC6\u7801");
      return;
    }
    const success = await this.provider.initialize(password);
    if (success) {
      new Notice("\u2705 \u5BC6\u94A5\u5E93\u521B\u5EFA\u6210\u529F");
      this.onSuccess();
      this.close();
    } else {
      new Notice("\u274C \u5BC6\u94A5\u5E93\u521B\u5EFA\u5931\u8D25");
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
export class UnlockModal extends Modal {
  constructor(app, provider, onSuccess, onCancel) {
    super(app);
    this.provider = provider;
    this.onSuccess = onSuccess;
    this.onCancel = onCancel;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-storage-modal");
    contentEl.createEl("h2", { text: "\u{1F513} \u89E3\u9501\u5BC6\u94A5\u5E93" });
    contentEl.createEl("p", {
      text: "\u8BF7\u8F93\u5165\u4E3B\u5BC6\u7801\u4EE5\u8BBF\u95EE\u60A8\u7684\u5BC6\u94A5",
      cls: "setting-item-description"
    });
    new Setting(contentEl).setName("\u4E3B\u5BC6\u7801").addText((text) => {
      this.passwordInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u8F93\u5165\u4E3B\u5BC6\u7801...");
      setTimeout(() => text.inputEl.focus(), 10);
      text.inputEl.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
          this.handleUnlock();
        }
      });
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u89E3\u9501").setCta().onClick(() => this.handleUnlock())).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => {
      if (this.onCancel) {
        this.onCancel();
      }
      this.close();
    }));
    contentEl.createEl("p", {
      text: "\u{1F4A1} \u5BC6\u94A5\u5E93\u4F1A\u5728\u4E00\u6BB5\u65F6\u95F4\u4E0D\u6D3B\u52A8\u540E\u81EA\u52A8\u9501\u5B9A",
      cls: "setting-item-description"
    });
  }
  async handleUnlock() {
    const password = this.passwordInput.getValue();
    if (!password) {
      new Notice("\u26A0\uFE0F \u8BF7\u8F93\u5165\u4E3B\u5BC6\u7801");
      return;
    }
    const success = await this.provider.unlock(password);
    if (success) {
      new Notice("\u2705 \u5BC6\u94A5\u5E93\u5DF2\u89E3\u9501");
      this.onSuccess();
      this.close();
    } else {
      new Notice("\u274C \u5BC6\u7801\u9519\u8BEF");
      this.passwordInput.setValue("");
      this.passwordInput.inputEl.focus();
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
export class ChangePasswordModal extends Modal {
  constructor(app, provider, onSuccess) {
    super(app);
    this.provider = provider;
    this.onSuccess = onSuccess;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-storage-modal");
    contentEl.createEl("h2", { text: "\u{1F511} \u4FEE\u6539\u4E3B\u5BC6\u7801" });
    new Setting(contentEl).setName("\u5F53\u524D\u5BC6\u7801").addText((text) => {
      this.oldPasswordInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u8F93\u5165\u5F53\u524D\u5BC6\u7801...");
    });
    new Setting(contentEl).setName("\u65B0\u5BC6\u7801").addText((text) => {
      this.newPasswordInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u8F93\u5165\u65B0\u5BC6\u7801...");
      text.inputEl.addEventListener("input", () => {
        this.updateStrengthIndicator();
      });
    });
    this.strengthContainer = contentEl.createDiv();
    new Setting(contentEl).setName("\u786E\u8BA4\u65B0\u5BC6\u7801").addText((text) => {
      this.confirmInput = text;
      text.inputEl.type = "password";
      text.setPlaceholder("\u786E\u8BA4\u65B0\u5BC6\u7801...");
    });
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u4FEE\u6539\u5BC6\u7801").setCta().onClick(() => this.handleChange())).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.close()));
  }
  updateStrengthIndicator() {
    this.strengthContainer.empty();
    const password = this.newPasswordInput.getValue();
    if (password.length > 0) {
      createPasswordStrengthIndicator(this.strengthContainer, password);
    }
  }
  async handleChange() {
    const oldPassword = this.oldPasswordInput.getValue();
    const newPassword = this.newPasswordInput.getValue();
    const confirm = this.confirmInput.getValue();
    if (!oldPassword || !newPassword) {
      new Notice("\u26A0\uFE0F \u8BF7\u586B\u5199\u6240\u6709\u5B57\u6BB5");
      return;
    }
    if (oldPassword === newPassword) {
      new Notice("\u26A0\uFE0F \u65B0\u5BC6\u7801\u4E0D\u80FD\u4E0E\u5F53\u524D\u5BC6\u7801\u76F8\u540C");
      return;
    }
    if (newPassword.length < 12) {
      new Notice("\u26A0\uFE0F \u65B0\u5BC6\u7801\u81F3\u5C11\u9700\u8981 12 \u4E2A\u5B57\u7B26");
      return;
    }
    if (newPassword !== confirm) {
      new Notice("\u26A0\uFE0F \u4E24\u6B21\u8F93\u5165\u7684\u65B0\u5BC6\u7801\u4E0D\u4E00\u81F4");
      return;
    }
    const strength = evaluatePasswordStrength(newPassword);
    if (strength.score < 2) {
      new Notice("\u26A0\uFE0F \u65B0\u5BC6\u7801\u5F3A\u5EA6\u592A\u5F31");
      return;
    }
    const submitBtn = this.contentEl.querySelector(".mod-cta");
    const originalText = (submitBtn == null ? void 0 : submitBtn.textContent) || "\u4FEE\u6539\u5BC6\u7801";
    if (submitBtn) {
      submitBtn.textContent = "\u4FEE\u6539\u4E2D...";
      submitBtn.disabled = true;
    }
    try {
      const success = await this.provider.changePassword(oldPassword, newPassword);
      if (success) {
        new Notice("\u2705 \u5BC6\u7801\u4FEE\u6539\u6210\u529F\n\n\u26A0\uFE0F \u8BF7\u52A1\u5FC5\u8BB0\u4F4F\u60A8\u7684\u65B0\u5BC6\u7801\uFF01");
        this.onSuccess();
        this.close();
      } else {
        new Notice("\u274C \u5F53\u524D\u5BC6\u7801\u9519\u8BEF");
        this.oldPasswordInput.setValue("");
        this.oldPasswordInput.inputEl.focus();
      }
    } finally {
      if (submitBtn) {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
      }
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
export class MigrationModal extends Modal {
  constructor(app, provider, localSecrets, onComplete) {
    super(app);
    this.provider = provider;
    this.localSecrets = localSecrets;
    this.onComplete = onComplete;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-storage-modal");
    contentEl.createEl("h2", { text: "\u{1F4E6} \u8FC1\u79FB\u5BC6\u94A5" });
    const secretCount = Object.keys(this.localSecrets).length;
    contentEl.createEl("p", {
      text: `\u53D1\u73B0 ${secretCount} \u4E2A\u5B58\u50A8\u5728\u7CFB\u7EDF\u94A5\u5319\u4E32\u4E2D\u7684\u5BC6\u94A5\u3002\u662F\u5426\u5C06\u5B83\u4EEC\u8FC1\u79FB\u5230\u540C\u6B65\u5BC6\u94A5\u5E93\uFF1F`,
      cls: "setting-item-description"
    });
    if (secretCount > 0) {
      const list = contentEl.createEl("ul");
      for (const id of Object.keys(this.localSecrets)) {
        list.createEl("li", { text: id });
      }
    }
    new Setting(contentEl).addButton((btn) => btn.setButtonText("\u8FC1\u79FB\u5E76\u5220\u9664\u672C\u5730\u5BC6\u94A5").setCta().onClick(() => this.handleMigrate(true))).addButton((btn) => btn.setButtonText("\u4EC5\u8FC1\u79FB\uFF08\u4FDD\u7559\u672C\u5730\uFF09").onClick(() => this.handleMigrate(false))).addButton((btn) => btn.setButtonText("\u8DF3\u8FC7").onClick(() => {
      this.onComplete();
      this.close();
    }));
  }
  async handleMigrate(deleteLocal) {
    const success = await this.provider.migrateFromLocal(this.localSecrets);
    if (success) {
      if (deleteLocal) {
        for (const id of Object.keys(this.localSecrets)) {
          this.app.secretStorage.setSecret(id, "");
        }
        new Notice("\u2705 \u5BC6\u94A5\u5DF2\u8FC1\u79FB\u5E76\u6E05\u9664\u672C\u5730\u526F\u672C");
      } else {
        new Notice("\u2705 \u5BC6\u94A5\u5DF2\u8FC1\u79FB\uFF08\u672C\u5730\u526F\u672C\u5DF2\u4FDD\u7559\uFF09");
      }
      this.onComplete();
      this.close();
    } else {
      new Notice("\u274C \u8FC1\u79FB\u5931\u8D25");
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};
export class ConflictResolutionModal extends Modal {
  constructor(app, provider, conflictInfo, onResolved) {
    super(app);
    this.provider = provider;
    this.conflictInfo = conflictInfo;
    this.onResolved = onResolved;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("secret-storage-modal");
    contentEl.addClass("conflict-resolution-modal");
    contentEl.createEl("h2", { text: "\u26A0\uFE0F \u68C0\u6D4B\u5230\u540C\u6B65\u51B2\u7A81" });
    const warningEl = contentEl.createDiv({ cls: "conflict-warning" });
    warningEl.style.backgroundColor = "var(--background-modifier-error)";
    warningEl.style.padding = "12px";
    warningEl.style.borderRadius = "6px";
    warningEl.style.marginBottom = "16px";
    warningEl.innerHTML = `
			<strong>\u5BC6\u94A5\u5E93\u5728\u591A\u4E2A\u8BBE\u5907\u4E0A\u540C\u65F6\u88AB\u4FEE\u6539</strong><br>
			<span style="font-size: 0.9em;">\u8BF7\u9009\u62E9\u8981\u4FDD\u7559\u7684\u7248\u672C\uFF0C\u6216\u5408\u5E76\u4E24\u4E2A\u7248\u672C\u3002</span>
		`;
    const comparisonEl = contentEl.createDiv({ cls: "conflict-comparison" });
    comparisonEl.style.display = "grid";
    comparisonEl.style.gridTemplateColumns = "1fr 1fr";
    comparisonEl.style.gap = "16px";
    comparisonEl.style.marginBottom = "16px";
    const localEl = comparisonEl.createDiv({ cls: "version-local" });
    localEl.style.padding = "12px";
    localEl.style.backgroundColor = "var(--background-secondary)";
    localEl.style.borderRadius = "6px";
    localEl.style.border = "2px solid var(--interactive-accent)";
    localEl.createEl("h4", { text: "\u{1F4F1} \u672C\u5730\u7248\u672C" });
    localEl.createEl("p", {
      text: `\u4FEE\u6539\u65F6\u95F4: ${this.formatDate(this.conflictInfo.localVault.lastModified)}`,
      cls: "setting-item-description"
    });
    localEl.createEl("p", {
      text: `\u8BBE\u5907: ${this.conflictInfo.localVault.deviceId}`,
      cls: "setting-item-description"
    });
    localEl.createEl("p", {
      text: `\u5BC6\u94A5\u6570\u91CF: ${this.conflictInfo.localSecrets.length}`,
      cls: "setting-item-description"
    });
    if (this.conflictInfo.localSecrets.length > 0) {
      const localList = localEl.createEl("ul");
      localList.style.fontSize = "0.85em";
      localList.style.maxHeight = "100px";
      localList.style.overflowY = "auto";
      this.conflictInfo.localSecrets.forEach((id) => {
        localList.createEl("li", { text: id });
      });
    }
    const remoteEl = comparisonEl.createDiv({ cls: "version-remote" });
    remoteEl.style.padding = "12px";
    remoteEl.style.backgroundColor = "var(--background-secondary)";
    remoteEl.style.borderRadius = "6px";
    remoteEl.style.border = "2px solid var(--text-muted)";
    remoteEl.createEl("h4", { text: "\u2601\uFE0F \u8FDC\u7A0B\u7248\u672C" });
    remoteEl.createEl("p", {
      text: `\u4FEE\u6539\u65F6\u95F4: ${this.formatDate(this.conflictInfo.remoteVault.lastModified)}`,
      cls: "setting-item-description"
    });
    remoteEl.createEl("p", {
      text: `\u8BBE\u5907: ${this.conflictInfo.remoteVault.deviceId}`,
      cls: "setting-item-description"
    });
    remoteEl.createEl("p", {
      text: `\u5BC6\u94A5\u6570\u91CF: ${this.conflictInfo.remoteSecrets.length}`,
      cls: "setting-item-description"
    });
    if (this.conflictInfo.remoteSecrets.length > 0) {
      const remoteList = remoteEl.createEl("ul");
      remoteList.style.fontSize = "0.85em";
      remoteList.style.maxHeight = "100px";
      remoteList.style.overflowY = "auto";
      this.conflictInfo.remoteSecrets.forEach((id) => {
        remoteList.createEl("li", { text: id });
      });
    }
    const diffEl = contentEl.createDiv({ cls: "conflict-diff" });
    diffEl.style.marginBottom = "16px";
    diffEl.style.padding = "12px";
    diffEl.style.backgroundColor = "var(--background-secondary-alt)";
    diffEl.style.borderRadius = "6px";
    const { onlyLocal, onlyRemote, both } = this.analyzeDiff();
    diffEl.createEl("h4", { text: "\u{1F4CA} \u5DEE\u5F02\u5206\u6790" });
    if (both.length > 0) {
      diffEl.createEl("p", {
        text: `\u{1F504} \u4E24\u8FB9\u90FD\u6709: ${both.join(", ")}`,
        cls: "setting-item-description"
      });
    }
    if (onlyLocal.length > 0) {
      diffEl.createEl("p", {
        text: `\u{1F4F1} \u4EC5\u672C\u5730: ${onlyLocal.join(", ")}`,
        cls: "setting-item-description"
      });
    }
    if (onlyRemote.length > 0) {
      diffEl.createEl("p", {
        text: `\u2601\uFE0F \u4EC5\u8FDC\u7A0B: ${onlyRemote.join(", ")}`,
        cls: "setting-item-description"
      });
    }
    const buttonContainer = contentEl.createDiv({ cls: "conflict-buttons" });
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.flexWrap = "wrap";
    new Setting(buttonContainer).addButton((btn) => btn.setButtonText("\u4F7F\u7528\u672C\u5730\u7248\u672C").setTooltip("\u4E22\u5F03\u8FDC\u7A0B\u66F4\u6539\uFF0C\u4FDD\u7559\u672C\u5730\u7248\u672C").onClick(() => this.handleResolution("local"))).addButton((btn) => btn.setButtonText("\u4F7F\u7528\u8FDC\u7A0B\u7248\u672C").setTooltip("\u4E22\u5F03\u672C\u5730\u66F4\u6539\uFF0C\u4F7F\u7528\u8FDC\u7A0B\u7248\u672C").onClick(() => this.handleResolution("remote"))).addButton((btn) => btn.setButtonText("\u5408\u5E76\u4E24\u8005").setCta().setTooltip("\u4FDD\u7559\u4E24\u8FB9\u6240\u6709\u5BC6\u94A5\uFF0C\u51B2\u7A81\u65F6\u53D6\u8F83\u65B0\u7248\u672C").onClick(() => this.handleResolution("merge"))).addButton((btn) => btn.setButtonText("\u53D6\u6D88").onClick(() => this.handleResolution("cancel")));
    const mergeHint = contentEl.createEl("p", {
      cls: "setting-item-description"
    });
    mergeHint.style.marginTop = "12px";
    mergeHint.innerHTML = `
			<strong>\u{1F4A1} \u5408\u5E76\u7B56\u7565:</strong> \u4FDD\u7559\u4E24\u8FB9\u6240\u6709\u7684\u5BC6\u94A5\u3002\u5982\u679C\u540C\u4E00\u5BC6\u94A5\u5728\u4E24\u8FB9\u90FD\u5B58\u5728\u4F46\u503C\u4E0D\u540C\uFF0C\u4FDD\u7559\u8F83\u65B0\u7248\u672C\u7684\u503C\u3002
		`;
  }
  formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  analyzeDiff() {
    const localSet = new Set(this.conflictInfo.localSecrets);
    const remoteSet = new Set(this.conflictInfo.remoteSecrets);
    const onlyLocal = this.conflictInfo.localSecrets.filter((id) => !remoteSet.has(id));
    const onlyRemote = this.conflictInfo.remoteSecrets.filter((id) => !localSet.has(id));
    const both = this.conflictInfo.localSecrets.filter((id) => remoteSet.has(id));
    return { onlyLocal, onlyRemote, both };
  }
  async handleResolution(resolution) {
    let success = false;
    switch (resolution) {
      case "local":
        success = await this.provider.resolveConflictWithLocal();
        if (success) {
          new Notice("\u2705 \u5DF2\u4F7F\u7528\u672C\u5730\u7248\u672C");
        }
        break;
      case "remote":
        success = await this.provider.resolveConflictWithRemote();
        if (success) {
          new Notice("\u2705 \u5DF2\u4F7F\u7528\u8FDC\u7A0B\u7248\u672C");
        }
        break;
      case "merge":
        success = await this.provider.resolveConflictWithMerge();
        if (success) {
          new Notice("\u2705 \u5DF2\u5408\u5E76\u4E24\u4E2A\u7248\u672C");
        }
        break;
      case "cancel":
        this.onResolved("cancel");
        this.close();
        return;
    }
    if (success) {
      this.onResolved(resolution);
      this.close();
    } else {
      new Notice("\u274C \u89E3\u51B3\u51B2\u7A81\u5931\u8D25");
    }
  }
  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
};

