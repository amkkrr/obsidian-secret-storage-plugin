---
creation date: 2026-06-30
modified: 2026-06-30
tags: null
reference: null
subject: Obsidian Secret Storage 插件移动端支持
cssclasses:
- academia
- wideTable
url: null
permalink: docs/secret-storage-v2
---

## Secret Storage Demo 插件 — 移动端支持设计文档（v2）

**目标：** 让当前仅桌面端（`isDesktopOnly: true`）的 Secret Storage Demo 插件支持 Obsidian 移动端（iOS / Android），在移动端可使用「同步模式」（AES-256-GCM 加密 + vault 内 `secrets.enc` 跨设备同步），并在移动端 1.13.x+ 上启用「本地模式」（官方 `app.secretStorage`）。不改变桌面端现有行为。

**核心设计理念：**

1. **特性检测优先于版本门槛：** 不靠抬高 `minAppVersion` 来保证 API 存在，而是运行时检测 `app.secretStorage` 是否可用，不可用则优雅降级。
2. **同步模式为移动端主路径：** 同步模式仅依赖 Web Crypto API（`crypto.subtle`）与 vault 文件系统，二者在移动端 WebView 全版本可用，且天然跨设备同步——契合移动端多设备场景。
3. **剪贴板降级：** 移动端 WebView 阻断 `navigator.clipboard`，封装统一复制函数带多层 fallback，保证"点击复制密钥"在移动端不崩溃并尽量可用。
4. **响应式 UI：** 用 `Platform.isMobile` 对固定栅格/像素布局做移动端适配，桌面端外观不变。
5. **移动端后台安全：** 移动端 App 切到后台时 `setTimeout` 可能被操作系统挂起，同步模式的自动锁定定时器有失效风险（详见 §八.6）。未来版本可结合页面可见性 API 主动锁定。
6. **不引入 Node/Electron 依赖：** 本插件本就未用任何 Node/Electron API，满足 `isDesktopOnly: false` 的前置条件。

---

## 一、背景

- 插件当前 `manifest.json` 为 `isDesktopOnly: true`，README 注明"移动端不支持（受系统安全存储 API 与 `crypto.subtle` 限制）"。
- 经调研，该理由**现已部分过时**：官方 `SecretStorage` 插件 API 自桌面 1.11.4（2026-01-07）引入，移动端在 1.13.x（2026-05/06）追赶桌面后才具备；`crypto.subtle`（PBKDF2/AES-GCM）在现代移动端 WebView 已可用。
- 插件源码已为标准 TypeScript + esbuild 工程（`main.ts` + `src/{crypto,storage,ui}.ts`），CI 自动构建发布，具备改造条件。

---

## 二、调研结论

### 2.1 官方 SecretStorage API 移动端支持情况

| 时间 | 版本 | SecretStorage 插件 API |
| --- | --- | --- |
| 2026-01-07 | 桌面 1.11.4（早访） | ✅ 首次暴露 `app.secretStorage` + `SecretComponent` |
| 2026-01-07 | 移动 1.11.4（早访） | ❌ changelog 未提 |
| 2026-01-15/20 | 移动 1.11.5 | 仅用户向「Keychain 设置区」UI，无插件 API |
| 2026-05-28 / 06-09 | 移动 1.13.0 / 1.13.1（早访） | ✅ "Includes all features up to Desktop 1.13.x" |

**证据：** 已安装 `obsidian` 类型包 1.13.1 中 `App.secretStorage: SecretStorage`、`SecretStorage`、`SecretComponent` 均 `@since 1.11.4` 且**无 "Not available on mobile" 标注**（而 `addStatusBarItem` 等桌面专属 API 有此标注）。

**关键限制：** 官方存储为**设备本地、OS 加密、不跨平台同步**（桌面 Electron `safeStorage` → Keychain/DPAPI/libsecret；移动端 → iOS Keychain/Android Keystore）。桌面存的密钥移动端读不到，反之亦然。

### 2.2 插件代码 API 兼容性审计

| 插件用到的 API | 移动端状态 |
| --- | --- |
| `Plugin`/`Modal`/`Setting`/`Notice`/`MarkdownView`/`PluginSettingTab` | ✅ 全平台 |
| `addCommand`（editorCallback/checkCallback/callback）、`addRibbonIcon`、`addSettingTab` | ✅ 全平台 |
| `registerMarkdownPostProcessor` | ✅ 全平台 |
| `app.workspace.getActiveViewOfType` | ✅ 全平台 |
| `app.vault.adapter`（read/write/exists/mkdir/list/remove） | ✅ 全平台（移动端走 `CapacitorAdapter`） |
| `app.vault.configDir`、`loadData/saveData` | ✅ 全平台 |
| `app.secretStorage` | ⚠️ 仅移动端 1.13.x+ |
| `crypto.subtle`（PBKDF2/AES-GCM）、`crypto.getRandomValues` | ✅ 移动端 WebView 支持 |
| `btoa/atob`、`TextEncoder/TextDecoder`、`localStorage`、`setTimeout/clearTimeout` | ✅ |
| `document.createTreeWalker`/`NodeFilter` | ✅ |
| `navigator.clipboard.writeText` | ❌ 移动端 WebView 被阻断 |
| Node/Electron API | ✅ 未使用 |

---

## 三、必须处理的问题

### 问题 1：`app.secretStorage` 版本门槛
manifest `minAppVersion: 1.11.4` 对桌面够用，但移动端 1.11.4–1.12 无此 API。本地模式直接调 `this.app.secretStorage.setSecret(...)` 会抛错。

### 问题 2：剪贴板移动端失效
`navigator.clipboard.writeText` 在 Obsidian 移动端 WebView 被阻断（论坛"Enable mobile apps to use clipboard"(2025-01)、Templater `tp.system.clipboard` 报 "not supported on mobile"、obsidian-copy-as-html 标 `wontfix`）。插件 3 处"点击复制密钥"会失败：`createSecretElement`、`GetSecretModal`、设置页 `copySecret`。

### 问题 3：UI 响应式
模态框使用固定栅格/像素布局，窄屏溢出：
- `ConflictResolutionModal`：`gridTemplateColumns: "1fr 1fr"` + 固定 padding/gap/margin → 手机应改单列。
- 各密码模态框、设置页内联密钥列表的固定宽度需适配。

---

## 四、设计方案

### 4.1 关键决策

- **决策 A①（`minAppVersion`）：** 保持 `1.11.4`，运行时特性检测 `app.secretStorage`。桌面 1.11.4 仍有本地模式；移动端 1.13.x 自动启用本地模式，移动端 1.11.4–1.12 本地模式禁用并提示改用同步模式。兼容性最广。
- **决策 B①（剪贴板）：** 封装 `copyToClipboard(text)`：先试 `navigator.clipboard.writeText`，catch 后降级到隐藏 `textarea` + `document.execCommand('copy')`，再失败则弹出可手选文本 + Notice 提示手动长按复制。体验最好。

### 4.2 改动清单（按文件）

**`manifest.json`**
- `isDesktopOnly: true` → `false`
- `minAppVersion` 保持 `1.11.4`
- `version` 递增（如 `1.0.2`），`versions.json` 增加对应映射

**`src/storage.ts`**
- `LocalStorageProvider`：构造与各方法增加对 `app.secretStorage` 缺失的守卫。
  - 新增 `isAvailable(): boolean`（`!!this.app.secretStorage`）
  - `save/get/list/delete`：当 `!this.app.secretStorage` 时返回安全默认值（`false`/`null`/`[]`）并 `console.warn`，不抛错
- `createStorageProvider(app, mode, autoLockMinutes)`：当 `mode === "local"` 且 `app.secretStorage` 不可用时，记录警告（实际降级决策在 `main.ts` 的 UI 层做，便于提示用户）

**`main.ts`**
- `initStorageProvider`：若设置中 `storageMode === "local"` 但 `app.secretStorage` 不可用（移动端低版本），自动切到 `sync` 并 Notice 提示"当前版本不支持本地密钥库，已自动切换到同步模式。桌面端的本地密钥不会同步到本设备，请使用同步模式管理跨设备密钥。"。
- `switchStorageMode`：选择 `local` 时先检测 `app.secretStorage`，不可用则 Notice 阻止并维持原模式。
- 设置页存储模式下拉：`local` 选项在 `app.secretStorage` 不可用时禁用并标注"(当前版本不支持)"。
- 新增 `copyToClipboard(text): Promise<boolean>` 工具函数（B① 多层 fallback），替换 3 处直接 `navigator.clipboard.writeText`：
  - `createSecretElement` 的点击复制
  - `GetSecretModal` 的"复制"按钮
  - `SecretStorageSettingTab.copySecret`
- 复制失败时统一 Notice 提示（不静默失败）。

**`src/ui.ts`**
- 引入 `Platform`（`import { ..., Platform } from "obsidian"`，或经 `main.ts` 传入 `isMobile`）。
- `ConflictResolutionModal`：`Platform.isMobile` 时把 `gridTemplateColumns` 改为单列（`"1fr"`），缩小 padding/margin，允许纵向滚动。
- 各密码模态框：移动端移除/缩小固定像素宽度，按钮区允许换行（`flexWrap` 已有，确认可用）。
- 不改变桌面端布局。

**`README.md`**
- 更新"📋 兼容性"章节：去掉"仅桌面端"，改为"桌面端 + 移动端（iOS/Android）；本地模式需移动端 1.13.x+，低版本自动降级为同步模式"。
- 更新"🔒 安全说明"中关于移动端同步的提示。
- 更新 manifest 说明中 `isDesktopOnly` 的描述。

### 4.3 接口签名（设计层，非实现）

```
// storage.ts
class LocalStorageProvider {
  isAvailable(): boolean;              // 新增：!!this.app.secretStorage
  // save/get/list/delete 内部前置 isAvailable 守卫
}

// main.ts
async function copyToClipboard(text: string): Promise<boolean>;
//   1. navigator.clipboard.writeText → 成功返回 true
//   2. 隐藏 textarea + document.execCommand('copy') → 成功返回 true
//   3. 都失败 → 返回 false（调用方 Notice 提示手动复制）
```

---

## 五、实施计划

1. `manifest.json`：`isDesktopOnly` → `false`，版本递增。
2. `src/storage.ts`：加 `isAvailable()` 与守卫。
3. `main.ts`：本地模式降级逻辑 + `copyToClipboard` + 替换 3 处剪贴板调用 + 设置页选项禁用。
4. `src/ui.ts`：`Platform.isMobile` 响应式（重点 `ConflictResolutionModal`）。
5. `README.md`：兼容性/安全说明更新。
6. 本地 `npm run build` 验证构建通过。
7. `this.app.emulateMobile(true)` 桌面模拟移动端 UI 自测。
8. 合并到 `main` 分支，打 tag（如 `1.0.2`）触发 CI 构建发布。也可先在 `feature/mobile-support` 分支打 pre-release tag（如 `1.0.2-beta`）进行 CI 构建测试，确认无问题后合并 `main` 并打正式版本 tag。
9. 真机 iOS / Android 实测（最终验收）。

---

## 六、测试方案

- **桌面模拟：** 开发者工具 Console 执行 `this.app.emulateMobile(true)`，验证模态框单列布局、剪贴板 fallback 路径。
  - 注意①：`emulateMobile(true)` 不会使 `app.vault.adapter instanceof CapacitorAdapter` 为真，但本插件不依赖 adapter 类型判断，仅用通用方法，故模拟足够。
  - 注意②：桌面始终存在 `app.secretStorage`（Electron safeStorage），**无法通过模拟测试 `app.secretStorage` 不可用的降级路径**。该路径必须真机测试（或临时在代码中 mock `app.secretStorage` 为 `undefined`）。
- **真机：** iOS / Android 各一台，覆盖：
  - 同步模式：初始化、解锁、增删查密钥、占位符渲染、改密、冲突解决。
  - 本地模式：1.13.x 上 `app.secretStorage` 可用；低于 1.13.x 应见降级提示。
  - 剪贴板：点击复制走 fallback；占位符点击复制。
- **回归：** 桌面端全部原有行为不变。

---

## 七、版本兼容矩阵

| 平台 \ 模式 | 本地模式（`app.secretStorage`） | 同步模式（`crypto.subtle` + `secrets.enc`） |
| --- | --- | --- |
| 桌面 ≥ 1.11.4 | ✅ | ✅ |
| 移动端 ≥ 1.13.x | ✅ | ✅ |
| 移动端 1.11.4–1.12 | ❌（降级提示→同步模式） | ✅ |

---

## 八、风险与限制

1. **剪贴板 fallback 不保证 100% 可用：** `execCommand('copy')` 在部分 WebView 亦可能被禁；最终兜底为"提示手动复制"。需真机实测确认各平台实际行为。
2. **`app.secretStorage` 移动端行为未经官方文档明确：** 类型未标注限制 + 移动 1.13.x "包含桌面全部功能"为间接证据；真机需确认 `setSecret/getSecret/listSecrets` 在 iOS/Android 实际可用且持久化。
3. **本地模式不跨平台同步：** 移动端本地模式密钥仅存于该设备 OS 钥匙串，不与桌面/其他移动设备共享——这是官方 API 设计，非本插件缺陷。跨设备需求应引导用同步模式。
4. **`localStorage` 设备 ID 在移动端：** 用于 `secret-storage-device-id`，WebView `localStorage` 可用，但若 Obsidian 清理 WebView 存储可能丢失设备 ID（会重新生成，仅影响冲突判定中的设备标识，非安全风险）。
5. **UI 适配范围：** 仅对已知固定栅格/像素布局做响应式；其他细微排版问题留待真机实测发现后补充。
6. **移动端后台自动锁定不可靠：** 同步模式的 `setTimeout` 自动锁定在移动端 App 切到后台时可能被操作系统挂起，导致密钥库保持解锁状态超出预期时长。当前版本未实现页面可见性 API（`document.addEventListener('visibilitychange'`）主动锁定。用户在敏感环境中使用移动端时，建议缩短自动锁定超时或手动锁定。
7. **`blur` 显示样式在移动端触屏体验差：** `blur` 模式依赖 CSS `:hover` 来临时清晰显示密钥。移动端无 hover 操作，轻触可能仅瞬间清晰即恢复模糊，用户难以看清密钥值。建议移动端用户优先使用 `hidden` 或 `plain` 显示样式，后续版本可考虑为移动端增加 tap-to-reveal 逻辑。

---

## 九、不在本次范围

- 不实现"忘记主密码重置"（与安全设计冲突，README 已声明不可恢复）。
- 不改造加密算法或密钥库文件格式（`secrets.enc` v2 格式保持不变）。
- 不处理旧备份在改密后的重新加密（属另一独立改进点）。
- 不提交至 Obsidian 社区插件商店（`manifest.json` 作者信息仍为占位符，需另行处理）。

---

## 附录：v2 修订记录

| 修订点 | 内容 |
| --- | --- |
| 核心设计理念 #5 | 新增「移动端后台安全」，指出 `setTimeout` 自动锁定在后台可能失效 |
| §四.4.2 `initStorageProvider` | Notice 措辞增强，说明桌面本地密钥不会同步到移动设备 |
| §五 步骤 8 | 明确合并到 `main` 后打正式 tag，也可在分支打 pre-release tag 测试 |
| §六 测试方案 | 修正：`emulateMobile(true)` 无法测试 `app.secretStorage` 不可用路径（桌面始终有此 API），需真机或 mock |
| §八 风险 #6 | 新增「移动端后台自动锁定不可靠」 |
| §八 风险 #7 | 新增「blur 显示样式在移动端触屏体验差」 |