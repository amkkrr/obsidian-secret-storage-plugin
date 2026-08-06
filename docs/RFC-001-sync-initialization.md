# RFC-001: 同步模式初始化流程修复

**防止多设备场景下误建/覆盖密码库**

| 字段 | 值 |
| --- | --- |
| 状态 | Revised（已按 AUDIT-0001 修订，待复审） |
| 日期 | 2026-08-06（初稿）/ 2026-08-06（修订 v1.1） |
| 作者 | pi（代笔，基于代码审查） |
| 关联模块 | `main.ts` / `src/storage.ts` / `src/ui.ts` |
| 影响版本 | 1.0.1 及后续 |

---

## 修订历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| v1.0（初稿） | 2026-08-06 | 首次提交评审 |
| v1.1（本次） | 2026-08-06 | 按 [AUDIT-0001](../audits/AUDIT-0001-rfc-001-sync-initialization-2026-08-06.md) 修订：D-1 冲突解决豁免、D-2 痕迹检测规则重定义、D-3 错误传播契约、D-4 轮询定案、E-1 证据表述弱化、F-1 测试基建、G-1 初始化区分性结果、C-1 残余风险声明、B-1 文档链接、行号刷新 |

---

## 1. 摘要

`SyncStorageProvider`（同步模式）把加密密钥库写入 vault 内固定路径
`<vault>/.obsidian/plugins/secret-storage-demo/secrets.enc`，依赖 Obsidian Sync /
remotely-save 等外部工具把文件镜像到其他设备。当前实现把**「文件不存在」无条件
解释为「首次使用」**，导致第二台设备在同步文件尚未到达时，插件直接弹出「设置主
密码」引导用户创建**全新空密码库**，进而覆盖/分裂第一台设备的既有密码库。

本 RFC 提出：把「初始化（创建新库）」从隐式自动流程中拆出，改为**显式确认 +
痕迹检测 + 写前保护**；统一冲突检测入口；启用已定义但未调用的 `checkBeforeSave()`
（冲突解决路径显式豁免，`SyncConflictError` 走显式错误传播契约，见 §5.4）。

> 本文档已按 [AUDIT-0001](../audits/AUDIT-0001-rfc-001-sync-initialization-2026-08-06.md)
> 修订至 v1.1；各发现项处置见 §5 对应小节与文末修订历史。

## 2. 问题陈述（代码证据）

### 2.1 核心缺陷：`isInitialized()` 语义歧义

`src/storage.ts:106-112`：

```ts
async isInitialized() {
  const exists = await this.app.vault.adapter.exists(this.getVaultPath());
  return exists;
}
```

「文件不存在」在多设备场景下有两种含义，当前代码只认一种：

| 文件不存在意味着 | 正确行为 |
| --- | --- |
| 真正首次使用（任何设备都没有） | 创建新库 |
| **同步尚未把文件送到本机**（其他设备已有） | **禁止创建**，提示等待同步/重新检查 |

两处入口共用这个有歧义的判断：

- `main.ts:177-211` `switchStorageMode()`：`!isInitialized` → `SetupPasswordModal`
- `main.ts:234-255` `ensureUnlocked()`：`!isInitialized` → `SetupPasswordModal`

均无同步感知、无等待/重试、无「远程可能已有库」的警告。

### 2.2 数据丢失风险

用户若在第二台设备继续完成 `SetupPasswordModal.handleSetup()`（`src/ui.ts:122`），
`provider.initialize(password)`（`src/storage.ts:117-138`）会用新 `deviceId`、新
`lastModified` 写入一个全新空 `secrets.enc`。随后同步工具在两端做冲突处理
（**具体行为取决于所用同步工具**，见 E-1 处置与 §10 问题 5）：

- 非 markdown 文件不会自动合并：Obsidian Sync 倾向保留版本历史（可从 Sync 版本
  历史手动恢复）；remotely-save 等第三方插件通常落地
  `secrets (conflicted copy ...).enc` 文件（该断言为经验性描述，未经双设备实测）；
- 插件只读固定路径 `secrets.enc`（`src/storage.ts:94-95`），冲突副本/版本历史中的
  数据永远不会被插件读取；
- 结果：无论同步工具采用哪种冲突处理方式，第一台设备的密钥从插件视角「消失」，
  且全程无任何警告。

### 2.3 次要缺陷

1. **入口逻辑不统一**：`ensureUnlocked` 解锁后调 `checkAndHandleConflict`
   （`main.ts:248-249`），但 `switchStorageMode` 的解锁分支（`main.ts:202-207`）没有。
2. **死代码**：`checkBeforeSave()`（`src/storage.ts:443-456`）已定义、含「remote-newer /
   conflict 时拒绝保存」语义，但全代码无调用点 —— 保存前从不做冲突检查。
3. **时序不一致**：`data.json`（storageMode 来源，`main.ts:156`）与 `secrets.enc`
   由同步工具独立搬运，到达顺序不保证；`storageMode="sync"` 但文件未到时，所有操作
   走 `ensureUnlocked` → 创建新库。
4. **竞态**：`isInitialized()` 检查通过后到 `initialize()` 写入之间，文件可能已被
   同步工具创建，写入会覆盖它。

## 3. 目标 / 非目标

### 3.1 目标

- 消除「第二台设备误建新库」路径，任何创建动作必须显式确认。
- 在不确定时（文件缺失）把决策权交给用户，提供清晰选项与警告。
- 统一冲突检测入口，启用 `checkBeforeSave`，杜绝保存时覆盖远端更新。
- 写入前防竞态保护。

### 3.2 非目标（v1 不做）

- 不接入 Obsidian Sync 内部 API（`app.internalPlugins.getPluginById('sync')`）查询
  同步状态（非公开 API，版本间不稳定）——见 §10 未决问题。
- 不自动扫描/恢复 `(conflicted copy)` 文件——见 §10。
- 不改变 `secrets.enc` 文件格式（version 2 保持兼容）。

## 4. 设计原则

1. **默认不破坏（Default to safety）**：任何「创建新库」都必须显式二次确认；
   不确定时宁可让用户等同步，也不自动初始化。
2. **把状态机显式化**：`uninitialized` / `locked` / `unlocked` 三态，入口不再
   「隐式初始化」。
3. **写前检查，防竞态**：写入 `secrets.enc` 前重新检查目标文件是否已被创建。
4. **一条冲突检测路径**：所有解锁/刷新/保存入口统一走 `checkAndHandleConflict` /
   `checkBeforeSave`。

## 5. 详细设计

### 5.1 状态模型（`SyncStorageProvider`）

新增枚举与访问器：

```ts
export type VaultState = "uninitialized" | "locked" | "unlocked";

// SyncStorageProvider 新增
getState(): VaultState {
  // uninitialized: 文件不存在
  // locked:       文件存在，unlocked === false
  // unlocked:     文件存在，unlocked === true
}
```

- `isInitialized()` 保留（兼容外部调用），等价于 `getState() !== "uninitialized"`。

### 5.2 初始化决策流程（核心变更）

新增模态框 `VaultNotFoundModal`（`src/ui.ts`），替代所有「文件不存在 → 直接弹
SetupPasswordModal」的路径。触发点：`switchStorageMode("sync")` 与
`ensureUnlocked()` 中 `getState() === "uninitialized"`。

```
文件不存在
   │
   ▼
VaultNotFoundModal（三选一）
   ├─ [创建新密码库] ── 痕迹检测 → 有痕迹? ──是──> 强警告二次确认
   │                                     └─否──> 直接进入 SetupPasswordModal
   ├─ [等待同步后重试] ── 「立即重试」按钮（v1 不做自动轮询，见 D-4 定案）
   │                     → 文件出现 → UnlockModal
   │                     → 仍不存在 → 提示"仍未检测到文件，请检查 Obsidian Sync
   │                                  选择性同步设置（见 §11 附注），可稍后重试"
   └─ [取消]
```

> **v1 定案（审计 D-4）**：不提供自动轮询（无后台定时器，避免 modal 关闭后定时器
> 泄漏），只保留手动「立即重试」。`waitForFile()` 从 API 清单移除（见 §5.5），
> 自动轮询（如 5s×12、60s 超时）降级为 v2 候选（见 §10 问题 2）。

**痕迹检测 `hasAnyVaultTraces()`**（`SyncStorageProvider` 新增）：

```ts
async hasAnyVaultTraces(): Promise<boolean> {
  // 1. backups/ 目录存在且含 *.enc 文件（storage.ts:270-283 生成的备份）
  // 2. 插件目录内存在其他 *.enc 文件（basename ≠ secrets.enc，如 conflicted copy）
}
```

任一命中即提示：「检测到本 vault 存在密码库痕迹（可能来自其他设备）。若你并非
首次使用，请先等待同步完成并选择解锁，而不是创建新库。」

> **规则 3 已删除（审计 D-2）**：初稿第 3 条「data.json 中 storageMode 曾为 sync」
> 无法实现——`loadData` 只能读当前值、没有历史；且当前值在两条触发路径上取值固定
> （`ensureUnlocked` 路径必为 `"sync"` 故恒真、`switchStorageMode("sync")` 中途仍为
> `"local"` 故恒假），无判别力。若未来需要「本机曾配置过同步」信号，应由调用方在
> `switchStorageMode` 中途显式传入布尔量，而非让 provider 读 `loadData`。

**写保护（防 §2.3.4 竞态）**：`SetupPasswordModal.handleSetup()`（`src/ui.ts:122`）调
`initialize()` 前，`initialize()` 内部再次检查目标文件是否存在，存在则**拒绝创建**
并返回区分性结果 `{ ok: false, reason: "already-exists" }`（其余失败
`{ ok: false, reason: "error" }`，成功 `{ ok: true }`）。`SetupPasswordModal` 对
`already-exists` 提示「检测到密码库文件已存在（同步已完成），请改为解锁」并切换
到 `UnlockModal`（审计 G-1）。

> **残余竞态声明（审计 C-1）**：`adapter.exists → adapter.write` 之间无法原子化，
> 同步工具的并发写仍可能在检查之后落地。本保护只能把竞态窗口从「整段用户操作流程」
> 缩小到「exists/write 之间毫秒级」，无法根除；如需根除需文件锁，超出 v1 范围。

**取消分支**：`VaultNotFoundModal` 的「取消」需处理设置页 UI 与 settings 的既有
不一致问题（现状：`switchStorageMode` 的 `settings.storageMode = "sync"` 在成功回调
里才写入，见 `main.ts:190/196`；用户中途取消会导致 dropdown 已显示 sync 但 settings
未落盘）。v1 约定：取消时重设设置页 dropdown（重新 `display()`）并 `Notice` 提示
「已取消切换到同步模式」。

### 5.3 统一冲突检测入口

- `switchStorageMode()` 解锁分支（`main.ts:202-207`）回调中追加
  `checkAndHandleConflict(syncProvider, onDone)`，与 `ensureUnlocked` 一致。
- 抽出公共方法 `unlockWithConflictCheck(syncProvider, onSuccess)`，两处共用，避免
  再次分叉。

### 5.4 启用 `checkBeforeSave`（写前冲突检查）+ 豁免 + 错误传播契约

`persistSecrets(options)`（`src/storage.ts:247`）开头（`createBackup()` 之前）插入
冲突检查，并新增 `SyncConflictError` 错误类型：

```ts
async persistSecrets({ skipConflictCheck = false } = {}) {
  if (!this.vault || !this.password) throw new Error("Vault not initialized");
  if (!skipConflictCheck) {
    const { canSave } = await this.checkBeforeSave();   // 复用已有实现 storage.ts:443
    if (!canSave) throw new SyncConflictError();        // 新增错误类型
  }
  await this.createBackup();
  // ...原有加密与写入逻辑不变
}
```

**豁免规则（审计 D-1，阻断级）**：

| 调用方 | 调用方式 | 说明 |
| --- | --- | --- |
| `save()`（storage.ts:191） | `persistSecrets()` | 常规写入，默认检查 |
| `delete()`（storage.ts:229） | `persistSecrets()` | 常规写入，默认检查 |
| `migrateFromLocal()`（storage.ts:367） | `persistSecrets()` | 常规写入，默认检查 |
| `resolveConflictWithLocal()`（storage.ts:460） | `persistSecrets({ skipConflictCheck: true })` | **显式豁免** |
| `resolveConflictWithMerge()`（storage.ts:498） | `persistSecrets({ skipConflictCheck: true })` | **显式豁免** |

豁免原因：冲突解决路径执行时 `this.vault` 仍是**旧的内存版本**（新
`lastModified`/`deviceId` 由 `updateEncryptedVault` 在检查之后才生成），若仍检查
必然判回 `conflict` 而拒绝——「使用本地版本」「合并」按钮将永远无法成功，形成新
死锁。用户已通过弹窗显式做出保留本地 / 合并的选择，此时落盘即为其意图。
`resolveConflictWithRemote()` 不写文件（仅替换内存版本），无需处理。

**错误传播契约（审计 D-3）**：`SyncConflictError` 不得被 `save/delete/migrateFromLocal`
现有的 catch-all → `return false` 吞掉。三者的 catch 需**识别并重新抛出**
`SyncConflictError`（其余错误维持 `return false`），由 UI 层统一处理：

- `main.ts` `saveSecret()`（main.ts:338）/ `deleteSecret()`（main.ts:365）捕获后，
  若 `provider.getConflictInfo()` 可用则弹出 `ConflictResolutionModal`（已有实现），
  否则提示「远端已有更新，请先刷新」；
- `MigrationModal.handleMigrate()` 捕获 `SyncConflictError` → 弹出
  `ConflictResolutionModal`；迁移因冲突失败时 modal 保持打开，用户解决冲突后重试。

> 实现注意：`save/delete` 在调用 `persistSecrets` 前已就地修改 `this.secrets`
> （`save` 先赋值 storage.ts:197、`delete` 先删除 storage.ts:235）。因此冲突弹窗
> 选择「使用本地 / 合并」后，本次未落盘的改动会随解决结果一并写入，用户输入不会
> 丢失；选择「使用远程」则按用户意图丢弃。

> 兼容性：`detectConflict` 内部会 `adapter.read` 当前文件；常规路径下内存版本 =
> 刚解锁版本（`localTime === remoteTime` → `"none"`），首写不会误报。

### 5.5 API 变更清单

| 位置 | 变更 | 类型 |
| --- | --- | --- |
| `storage.ts` | 新增 `getState(): VaultState`（三态；`isInitialized()` 保留为包装） | 新增 |
| `storage.ts` | 新增 `hasAnyVaultTraces(): Promise<boolean>`（规则 1/2，无 data.json 规则，见 D-2） | 新增 |
| `storage.ts` | 新增 `SyncConflictError` 错误类型 | 新增 |
| `storage.ts` | `initialize()` 写前检查文件已存在 → 拒绝，返回 `{ ok: false, reason: "already-exists" }`（见 G-1） | 行为变更 |
| `storage.ts` | `persistSecrets({ skipConflictCheck = false })` 默认调用 `checkBeforeSave()`，冲突时抛 `SyncConflictError`；`resolveConflictWithLocal/WithMerge` 传 `true`（见 D-1） | 行为变更 |
| `storage.ts` | `save/delete/migrateFromLocal` 重新抛出 `SyncConflictError`（其余错误维持 `return false`，见 D-3） | 行为变更 |
| `main.ts` | 两处 `!isInitialized` 分支改为 `VaultNotFoundModal` 流程；取消分支重置 dropdown + Notice（见 §5.2） | 行为变更 |
| `main.ts` | 新增 `unlockWithConflictCheck()` 公共方法，`switchStorageMode` 解锁分支与 `ensureUnlocked` 共用 | 重构 |
| `main.ts` | `saveSecret/deleteSecret` 捕获 `SyncConflictError` → `ConflictResolutionModal` 或「请先刷新」提示 | 行为变更 |
| `ui.ts` | 新增 `VaultNotFoundModal`（三选一 + 痕迹强警告二次确认 + 「立即重试」） | 新增 |
| `ui.ts` | `SetupPasswordModal` 识别 `already-exists` → 提示并切换到 `UnlockModal` | 行为变更 |
| `ui.ts` | `MigrationModal.handleMigrate` 捕获 `SyncConflictError` → `ConflictResolutionModal` | 行为变更 |
| — | ~~`waitForFile(timeoutMs, intervalMs)`~~ 从清单移除（v1 不做自动轮询，见 D-4） | 删除 |

文件格式（`secrets.enc` v2）、`data.json` 结构不变。

### 5.6 UI 文案要点

- `VaultNotFoundModal` 需说明两种可能（首次使用 / 同步未完成），并附「若这是新设备，
  请先在 Obsidian Sync 设置中确认「同步所有其他类型文件」与「其他文件类型」已开启」。
- 创建新库按钮红色警示样式（复用 `.mod-warning`）。

## 6. 场景走查

| # | 场景 | 现状 | 修复后 |
| --- | --- | --- | --- |
| A | 首次使用（无任何设备有库） | 设置密码创建库 ✓ | 弹 VaultNotFoundModal → 无痕迹（规则 1/2 均未命中）→ 确认创建 ✓（不再依赖 data.json 规则，见 D-2） |
| B | 第二台设备，同步已完成 | 解锁 ✓ | 解锁 ✓（不变） |
| C | 第二台设备，同步未完成 | **弹设置密码 → 误建空库** ✗ | 弹 VaultNotFoundModal → 警告痕迹/等待同步，禁止默认创建 ✓ |
| D | 第二台设备，同步未完成但用户坚持创建 | 静默覆盖/分裂 | 强警告 + 二次确认 + 写前检查 ✓ |
| E | 本地有备份痕迹（backups/*.enc）但主文件缺失 | 创建新库，痕迹被忽略 | 强警告，提示可能丢失的既有库 ✓ |
| F | 解锁后本地文件被同步工具更新 | detectConflict → remote-newer → refresh ✓ | 不变（`switchStorageMode` 路径补齐） |
| G | 双设备同时写 | 仅解锁后入口触发冲突弹窗 | 保存前 `checkBeforeSave` 兜底，杜绝静默覆盖 ✓；验收：冲突弹窗「使用本地 / 合并 / 使用远程」三按钮**各自落盘成功**（豁免生效，无死锁）；选择本地/合并时本次未落盘的保存改动随解决结果一并写入（D-1/D-3 验收场景） |
| H | 本地模式 → 同步模式迁移（B 有本机钥匙串密钥） | 迁移向导 ✓ | 不变（保留现有 MigrationModal 流程） |

## 7. 兼容性与迁移

- 已有同步库的用户：文件存在 → 走原解锁路径，行为不变。
- 已误建空库的用户（存量数据问题）：插件可在解锁失败后提示「检测到可能被覆盖的旧
  密钥库，请检查 Sync 版本历史 / 冲突副本文件（`secrets (conflicted copy ...).enc`）
  并按需恢复」——两条恢复路径并列（以所用同步工具为准，见 E-1 处置），仅提示，
  不自动处理（v1）。
- `data.json` 无新增字段，无需迁移。

## 8. 测试计划

**单元测试**（新增 `tests/storage.test.ts` + vitest；测试基建见 §9「P0-pre」）：

1. `getState()` 三态转换（uninitialized → locked → unlocked）。
2. `initialize()`：目标文件已被创建时返回 `{ ok: false, reason: "already-exists" }`
   （G-1 区分性结果）。
3. `hasAnyVaultTraces()`：backups/ 有/无 `*.enc` 两种结果（规则 1/2）。
4. `persistSecrets()`：远端更新时抛 `SyncConflictError`（checkBeforeSave 生效）；
   `resolveConflictWithLocal/WithMerge` 传 `skipConflictCheck: true` 后可成功落盘
   （D-1 豁免回归）。
5. `save()/delete()`：捕获 `SyncConflictError` 后**重新抛出**，而非吞掉返回 `false`
   （D-3 错误传播契约）。

> mock 方案：`app.vault.adapter` 用内存实现（`exists/read/write/mkdir/list/remove`）；
> `obsidian` 模块整体 mock（`Notice`/`Modal` 等为空实现）；`cryptoService` 保留真实
> 实现（Node ≥ 20 提供全局 WebCrypto / btoa / atob）。

**手动验收**（对照 §6 场景矩阵 A–H）：

- 两台设备 + Obsidian Sync（开启「同步所有其他类型文件」「其他文件类型」）。
- 场景 C：确保不出现 SetupPasswordModal；VaultNotFoundModal 提供等待/重试。
- 场景 G：双端同时保存，确认弹出冲突解决而非静默覆盖。

**回归**：`npm run typecheck`、`npm run build` 通过；本地模式全部命令不受影响。

## 9. 实施分阶段

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P0-pre | 测试基建：引入 vitest + adapter mock + `tests/storage.test.ts` 骨架（审计 F-1，为前置投入，单独计工作量） | `npm test` 可跑通 |
| P0 | `storage.ts`：`getState`/`hasAnyVaultTraces`/写保护/`SyncConflictError`/`checkBeforeSave` 启用 + 冲突解决豁免 + 错误传播重抛 | 单测（§8 用例 1–5） |
| P1 | `ui.ts`：`VaultNotFoundModal`、`SetupPasswordModal` 的 `already-exists` 分支、`MigrationModal` 冲突捕获 | 手动场景 C/G |
| P2 | `main.ts`：两入口接入新流程 + `unlockWithConflictCheck` 重构 + `saveSecret/deleteSecret` 冲突捕获 | 手动场景 A–H |
| P3 | 文案打磨、README 同步（多设备使用说明 + 本文档链接，见 B-1） | 评审 |

## 10. 未决问题（Open Questions）

1. **是否读取 Obsidian Sync 内部状态**？`app.internalPlugins.getPluginById("sync")`
   可探测同步是否完成，但为非公开 API。v1 不依赖，仅作 v2 增强候选。
2. ~~**`waitForFile` 轮询默认参数**~~ **已定案（审计 D-4）**：v1 只提供「立即重试」
   按钮，不做自动轮询（避免 modal 关闭后定时器泄漏）；自动轮询（如 5s×12、60s 超时）
   列为 v2 候选，届时需补充「modal 关闭时清理定时器」的要求。
3. **是否自动恢复 `(conflicted copy)` 文件**？v1 仅提示，v2 可做「解锁失败时自动
   检测并让用户选择恢复」。
4. **是否需要「vault 归属」标识**（例如库内记录创建设备名），帮助用户在
   VaultNotFoundModal 中判断是否自己的库？会增加文件格式变更（v3），暂缓。
5. **同步工具冲突副本行为实测（审计 E-1）**：§2.2 关于「非 markdown 文件不自动合并、
   落地 conflicted copy / 保留版本历史」的断言需在受控环境（双设备 + 目标同步工具）
   实测一次，结果回写 §2.2 与 §7。

## 11. 附注：Obsidian Sync 设置核对项（配套文档）

同步模式可用需用户在每台设备的 **设置 → 同步** 中确认：

1. 选择性同步 → **同步所有其他类型文件**：开启（`secrets.enc` 属其他类型）。
2. 同步配置文件 → **其他文件类型**：开启（覆盖插件数据文件）。
3. 同步配置文件 → **第三方插件启用情况 / 已安装的社区插件列表**：开启（可选，
   用于自动安装插件本体）。
4. **需要排除的文件夹**：不得包含 `.obsidian` 或插件目录。

（官方依据：《Obsidian 帮助 · 同步设置》"选择性同步"与"始终被排除的内容"章节。）
