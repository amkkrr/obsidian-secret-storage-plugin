# 🔐 Secret Storage Demo

> 演示如何使用 Obsidian SecretStorage API 安全存储 API 密钥等敏感信息的 Obsidian 插件。

Secret Storage Demo 为 Obsidian 提供一套独立的密钥管理方案：既可调用系统级安全存储（Keychain / Credential Manager），也可用主密码加密的「密钥库文件」实现**跨设备同步**。配合 Markdown 占位符 `{{secret:密钥ID}}`，可在笔记中安全引用密钥而不泄露明文。

---

## ✨ 功能特性

- **双存储模式**
  - **本地模式**：调用 Obsidian 内置 `app.secretStorage`，存储于操作系统安全存储（macOS Keychain / Windows Credential Manager / Linux Secret Service），不随 vault 同步。
  - **同步模式**：将密钥以 `AES-256-GCM` 加密写入 `secrets.enc` 文件，可用 remotely-save 等同步插件跨设备共享。
- **强加密**
  - `PBKDF2-SHA256` 派生密钥，**310,000 次迭代**（符合 OWASP 2023 推荐）。
  - `AES-256-GCM` 认证加密，随机 16 字节盐 + 12 字节 IV。
  - 密钥标记为 *non-extractable*，并提供独立的密码验证器，无需解密全量数据即可校验主密码。
- **主密码管理**
  - 首次设置时创建密钥库，并强制密码长度 ≥ 12、强度评分 ≥ 2。
  - 支持随时修改主密码（重新派生密钥并重加密）。
  - 可配置**自动锁定**超时（0–120 分钟，0 表示禁用）。
- **同步冲突处理**
  - 基于设备 ID 与 `lastModified` 时间戳检测本地 / 远程版本差异。
  - 三种解决策略：**使用本地版本** / **使用远程版本** / **智能合并**（保留双方全部密钥，冲突项取较新版本）。
- **版本备份**
  - 每次写入前自动备份到 `backups/`，可配置保留数量（0–20）。
- **Markdown 占位符**
  - 在阅读视图中将 `{{secret:密钥ID}}` 渲染为真实密钥值，支持三种显示样式：
    - **模糊（blur）**：悬停时清晰可见，点击复制。
    - **隐藏（hidden）**：显示为圆点，点击复制。
    - **明文（plain）**：直接显示，点击复制。
  - 未解锁时显示锁定占位符，点击即可触发解锁流程。
- **可视化管理界面**
  - Ribbon 钥匙图标 → 密钥管理器模态框。
  - 设置页内联密钥列表，支持新增 / 编辑 / 复制 / 删除，无需离开设置面板。
  - 设置主密码 / 修改密码 / 解决冲突等模态框均带密码强度指示器与操作提示。

---

## 🆚 两种存储模式对比

| 维度 | 本地模式 (local) | 同步模式 (sync) |
| --- | --- | --- |
| 底层存储 | 操作系统安全存储 | `secrets.enc` 加密文件 |
| 加密 | 由 OS 负责 | AES-256-GCM + PBKDF2 |
| 主密码 | 不需要 | 需要（解锁、修改） |
| 跨设备同步 | ❌ 不可同步 | ✅ 可随 vault 同步 |
| 自动锁定 | 始终「已解锁」 | 可配置超时自动锁定 |
| 备份 | 无 | 自动版本备份 |
| 冲突检测 | 无 | ✅ 三向冲突解决 |
| 适用场景 | 单设备、临时存储 | 多设备、长期管理 |

在「设置 → SecretStorage 插件 → 存储模式」中切换。由本地切换到同步时，若检测到系统钥匙串中已有密钥，会弹出**迁移向导**将本地密钥导入同步密钥库。

---

## 📦 安装

### 方式一：手动安装（当前仓库）

1. 将本目录（`secret-storage-demo`）整个放入 Obsidian vault 的 `.obsidian/plugins/` 下。
2. 打开 Obsidian → `设置 → 第三方插件`，关闭「安全模式」。
3. 在插件列表中找到 **Secret Storage Demo**，启用即可。

### 方式二：从源码构建

仓库已包含完整 TypeScript + esbuild 源码工程：

```
main.ts             # 插件主类、命令、设置页
src/
├── crypto.ts       # 加密服务：PBKDF2 / AES-GCM / 密钥库读写
├── storage.ts      # LocalStorageProvider / SyncStorageProvider
└── ui.ts           # 模态框与密码强度指示器
esbuild.config.mjs  # 构建配置
package.json        # 依赖与脚本
tsconfig.json       # TypeScript 配置
```

构建步骤：

```bash
npm install          # 安装依赖
npm run build        # 生产构建，输出压缩版 main.js
npm run dev          # 开发模式，监听变更并自动重建（不压缩）
```

构建产物 `main.js` 已加入 `.gitignore`，不纳入版本库；发布由 GitHub Actions 在 CI 中构建（见下文「发布新版本」）。

---

## 🚀 使用方法

### 命令面板（`Ctrl/Cmd + P`）

| 命令 | 说明 | 模式 |
| --- | --- | --- |
| 插入密钥占位符 (Insert Secret Placeholder) | 从已有密钥中选择并插入 `{{secret:ID}}` 到光标处 | 全部 |
| 将选中文本保存为密钥并替换 (Save Selection as Secret) | 把选中的明文存为密钥，原地替换为占位符 | 全部 |
| 保存密钥 (Save Secret) | 录入新的密钥 ID 与值 | 全部 |
| 获取密钥 (Get Secret) | 查看 / 复制已存密钥 | 全部 |
| 列出所有密钥 (List All Secrets) | 以 Notice 形式列出全部密钥 ID | 全部 |
| 删除密钥 (Delete Secret) | 从密钥库删除指定密钥 | 全部 |
| 解锁密钥库 (Unlock Vault) | 输入主密码解锁 | 同步 |
| 锁定密钥库 (Lock Vault) | 立即锁定，清空内存中的密钥 | 同步 |
| 修改主密码 (Change Master Password) | 重置加密密钥并重写密钥库 | 同步 |
| 检查同步状态 (Check Sync Status) | 检测并处理本地 / 远程冲突 | 同步 |

### Ribbon 图标

左侧栏的 🔑 钥匙图标会打开**密钥管理器**：一个集中入口，可锁定、改密、增删查密钥，并查看当前模式与锁定状态。

### 在笔记中引用密钥

在任意 Markdown 文件中写入：

```markdown
我的 OpenAI Key: {{secret:openai-api-key}}
数据库密码: {{secret:db-password}}
```

切换到阅读视图后，占位符会按所选样式渲染；点击密钥块即可复制到剪贴板。未解锁时显示为锁定占位符，点击触发解锁。

### 密钥 ID 规则

ID 仅允许 **小写字母、数字、短横线**，正则：`^[a-z0-9-]+$`，例如 `openai-api-key`、`github-token`。

---

## ⚙️ 设置项

进入 `设置 → SecretStorage 插件`：

**存储模式**
- **存储模式**：`local` / `sync`
- **自动锁定时间**（仅同步）：不活动多久后自动锁定（分钟，0 = 禁用）
- **备份数量**（仅同步）：保留多少个历史备份版本
- **修改主密码**（仅同步）：打开修改密码模态框

**通用设置**
- **显示通知**：操作完成后是否弹出 Notice
- **启用占位符替换**：阅读视图是否渲染 `{{secret:...}}`
- **密钥显示样式**：`blur` / `hidden` / `plain`

**密钥管理**
- 内联列表：新增 / 编辑 / 复制 / 删除（同步模式锁定时需先解锁）

---

## 🗂 目录结构

```
secret-storage-demo/
├── manifest.json        # 插件清单
├── main.ts              # 插件主类、命令、设置页（源码入口）
├── src/                 # 源码
│   ├── crypto.ts        # 加密服务
│   ├── storage.ts       # 存储提供者
│   └── ui.ts            # 模态框与密码强度
├── styles.css           # 占位符、模态框、设置页样式
├── esbuild.config.mjs   # 构建配置
├── package.json         # 依赖与脚本
├── tsconfig.json        # TypeScript 配置
├── versions.json        # 版本兼容映射
├── main.js              # 构建产物（⚠️ 已 gitignore，由 CI 生成）
├── data.json            # 插件设置（已 gitignore，由 Obsidian 管理）
├── secrets.enc          # 同步模式加密密钥库（已 gitignore，个人数据）
├── backups/             # 历史备份（已 gitignore）
│   └── secrets.<timestamp>.enc
└── .gitignore
```

> ⚠️ `main.js` 为构建产物；`secrets.enc`、`backups/`、`data.json` 为个人/本地数据——均已加入 `.gitignore`，不进入版本库。

### `secrets.enc` 文件格式（同步模式）

```jsonc
{
  "version": 2,
  "algorithm": "AES-256-GCM",
  "kdf": "PBKDF2",
  "kdfIterations": 310000,
  "salt": "<base64>",
  "iv": "<base64>",
  "verifier": "<base64-iv>:<base64-verifier>",   // 用于快速校验主密码
  "data": "<base64 密文>",
  "lastModified": "ISO-8601",
  "deviceId": "device-xxxxxxxxxxxx"
}
```

---

## 🔒 安全说明

- **主密码无法找回**：主密码仅存于内存，不落盘。忘记密码 = 密钥不可恢复。请务必妥善保管。
- **密码强度门槛**：最少 12 位，且强度评分需 ≥ 2（综合长度、字符种类、常见弱模式判定）。
- **内存中的密钥**：同步模式锁定后会立即清空内存中的密钥与密码；本地模式则依赖 OS 安全存储的解锁状态。
- **自动锁定**：建议启用，避免长时间保持解锁状态。
- **同步风险**：`secrets.enc` 可被同步到云端，但其内容已用 AES-256-GCM 加密，攻击者拿到文件仍需主密码。请确保主密码本身不与 vault 一起同步或明文存放。
- **剪贴板**：点击复制会将密钥写入系统剪贴板，请注意剪贴板被其他程序读取的风险。

> ⚠️ 本插件以 **demo** 为定位，旨在演示 Obsidian SecretStorage API 的用法。生产环境使用前请自行评估安全模型，并考虑硬件密钥 / 专用密码管理器等更严格方案。

---

## 📋 兼容性

- **最低 Obsidian 版本**：1.11.4
- **平台**：仅桌面端（`isDesktopOnly: true`），依赖 `crypto.subtle` 与系统安全存储 API。

---

## 🛠 技术栈与实现要点

- **TypeScript + esbuild** 打包为单文件 `main.js`。
- **Web Crypto API**：`crypto.subtle.importKey` / `deriveKey` / `encrypt` / `decrypt`，全部在浏览器/Electron 侧完成，无外部依赖。
- **存储抽象**：`createStorageProvider(app, mode)` 工厂方法，`LocalStorageProvider` 与 `SyncStorageProvider` 实现相同的 `save / get / list / delete / isUnlocked / getMode` 接口，便于扩展第三种存储后端。
- **冲突检测**：`detectConflict()` 比较内存版本与磁盘版本的 `lastModified` 与 `deviceId`，区分 `none / local-newer / remote-newer / conflict` 四种状态。
- **密码强度评估**：本地启发式评分（0–4），含长度、字符集、常见弱模式扣分，并在设置/改密模态框实时反馈建议。

---

## 📤 发布新版本（自动 Release）

本仓库已配置 GitHub Actions（`.github/workflows/release.yml`）。推送与 `manifest.json` 中 `version` 一致的 tag，即可自动发布符合 Obsidian 标准格式的 Release。

### Obsidian 标准发布格式

Obsidian 从 GitHub Release 的资产中**只读取以下三个文件**，其余资产一律忽略：

- `main.js`
- `manifest.json`
- `styles.css`

工作流会自动校验 tag 与 `manifest.json` 的 `version` 是否一致，然后从 TypeScript 源码构建 `main.js`，最后创建 GitHub Release 并上传这三个文件（`styles.css` 不存在时自动跳过）。

### 发布步骤

1. 更新 `manifest.json` 中的 `version` 为目标版本号（如 `1.0.1`），并在 `versions.json` 中添加 `"1.0.1": "1.11.4"`（版本号 → 最低兼容 Obsidian 版本）。
2. 提交并推送改动：
   ```bash
   git add manifest.json versions.json
   git commit -m "release: 1.0.1"
   git push origin main
   ```
3. 创建并推送与版本号**完全一致**的 tag：
   ```bash
   git tag -a 1.0.1 -m "1.0.1"
   git push origin 1.0.1
   ```
4. GitHub Actions 自动触发：校验版本一致性 → `npm ci` 安装依赖 → `npm run build` 从源码编译 `main.js` → 创建 Release → 上传 `main.js` / `manifest.json` / `styles.css`，并自动生成发布说明。
5. 发布完成后，用户即可通过社区插件入口或 BRAT 安装/更新。

> CI 会从 TypeScript 源码现场构建 `main.js`，因此仓库不保存 `main.js`（已 gitignore）。
> 若希望先以草稿发布再人工确认，可在 `release.yml` 的 `gh release create` 命令中追加 `--draft`。

## 📝 开发计划 / 已知限制

- 当前 `manifest.json` 中 `author` 与 `authorUrl` 仍为占位符，发布前请替换为实际信息。
- 仅桌面端；移动端不支持（受系统安全存储 API 与 `crypto.subtle` 限制）。
- 同步模式下并发写入依赖文件级时间戳，未引入强一致锁，极端并发场景建议依赖备份回滚。

---

## 📄 许可证

本仓库未声明开源许可证。默认版权归原作者所有；如需二次分发或商业使用，请先联系作者添加相应 License。