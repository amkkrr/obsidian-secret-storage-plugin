# AUDIT-0001: RFC-001 同步模式初始化流程修复 — 实施就绪性审计

**被审计文档**: [RFC-001](../RFC-001-sync-initialization.md)
**关联文档**: 无（项目内唯一规格文档；README.md 未引用）
**前置审计**: 无（首次审计）

**审计日期**: 2026-08-06
**审计范围**: RFC-001 全文；代码交叉验证 `main.ts`、`src/storage.ts`、`src/ui.ts`、`package.json`、`manifest.json`
**审计重点**: 按 RFC 实施是否会引入新的数据丢失/冲突解决死锁；文中代码引用是否属实

---

## 1. 审计结论

**REVISE / 修订（修订后再审）**

RFC 对现状问题的诊断**准确、证据扎实**（§2 所有代码引用经逐行核实基本属实，`checkBeforeSave` 确为死代码、两处初始化入口确实无同步感知）。但 §5 详细设计存在**一个阻断级设计缺陷**（D-1：按文中方案启用 `checkBeforeSave` 会导致冲突解决功能永久失效）和**一个主要逻辑缺陷**（D-2：痕迹检测第 3 条规则在两处触发点分别恒真/恒假，无法实现设计意图）。修复这两项后方可进入实施。

---

## 2. 审计发现

### D-1: `checkBeforeSave` 放进 `persistSecrets()` 会锁死冲突解决路径

**级别**: Critical（阻断）
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.4、§5.5（API 变更清单）
- `src/storage.ts:247`（`persistSecrets`）、`src/storage.ts:443`（`checkBeforeSave`）、`src/storage.ts:459-471`（`resolveConflictWithLocal`）、`src/storage.ts:498-532`（`resolveConflictWithMerge`）

**问题说明**:
RFC §5.4 要求在 `persistSecrets()` 开头插入 `checkBeforeSave()`，并在 §5.5 列出受影响调用方为 `save / delete / resolveConflictWithMerge / migrateFromLocal`——**遗漏了 `resolveConflictWithLocal`**（`src/storage.ts:465` 同样调用 `persistSecrets`）。

更根本的问题是检查时机：`persistSecrets()` 执行时 `this.vault` 仍是**旧的内存版本**（新 `lastModified`/`deviceId` 由 `updateEncryptedVault` 在检查之后才生成）。因此：

- `resolveConflictWithLocal()`：用户明确选择「使用本地版本」→ `persistSecrets` → `detectConflict` 仍返回 `conflict`（两端 deviceId 不同、时间戳不同）→ `canSave=false` → 抛错 → **「使用本地版本」永远无法成功**。
- `resolveConflictWithMerge()`：合并完成后调 `persistSecrets`，`this.vault` 仍是合并前的旧版本 → 同样被判 `conflict` → **合并方案同样被拒绝**。

RFC §5.4 的附注（「内存版本 = 刚解锁版本，首写时不会误报」）只覆盖 `save/delete` 的常规路径，未覆盖冲突解决路径——而冲突解决恰恰是该机制存在的第一理由。

**风险**:
按现方案实施后，场景 G（双设备同时写）的冲突弹窗中「使用本地」「合并」两个按钮全部失效，用户只剩「使用远程」（丢弃本地数据）和「取消」可选——比现状（至少本地能静默写成功）更糟，且与 RFC §3.1「杜绝保存时覆盖远端更新」的目标自相矛盾地制造了新死锁。

**审计建议**:
二选一：
1. **把检查上移**：`checkBeforeSave` 只在 `save()` / `delete()`（及 `migrateFromLocal`）入口调用，不动 `persistSecrets`；冲突解决函数显式豁免。
2. **加显式豁免参数**：`persistSecrets({ skipConflictCheck = false })`，由 `resolveConflictWithLocal/WithMerge` 传 `true`。

无论选哪个，§5.5 调用方清单必须补上 `resolveConflictWithLocal`，并在 §6 场景矩阵中为「冲突弹窗三按钮各自落盘成功」补一条验收场景。

---

### D-2: 痕迹检测第 3 条规则在两处触发点分别恒真/恒假

**级别**: Major
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.2（`hasAnyVaultTraces`）、§6 场景 A
- `main.ts:177-211`（`switchStorageMode`）、`main.ts:234-253`（`ensureUnlocked`）

**问题说明**:
规则 3「`data.json` 中 `storageMode` 曾为 `"sync"`（`loadData` 结果，调用方传入）」有两个问题：

1. **「曾为」无法由 `loadData` 得知**——它只能读当前值，没有历史。
2. **当前值在两条触发路径上取值固定**：
   - `ensureUnlocked` 路径：该函数在 `storageMode === "local"` 时直接 `callback()` 返回（`main.ts:235-238`），能走到文件检测处必然 `storageMode === "sync"` → **规则 3 恒真** → §6 场景 A（真正的首次使用：用户在设置里选了 sync、同步开关未开）必然触发「强警告二次确认」，与场景 A 声称的「无痕迹 → 确认创建」矛盾。
   - `switchStorageMode("sync")` 路径：`settings.storageMode = "sync"` 在 `SetupPasswordModal` 成功回调里才写入（`main.ts:191/196`），检测时仍是旧值 `"local"` → **规则 3 恒假**。

即该规则在任一触发点都不携带有效信息，痕迹检测退化为只剩规则 1/2。

**风险**:
要么首次用户被无端恐吓（恒真分支），要么「其他设备建过库、本机切过模式」的真实痕迹漏检（恒假分支）——实现者按字面实现后行为与 §6 场景矩阵预期不符，且单测难以发现（mock 掉 data.json 后两条路径都"能过"）。

**审计建议**:
- 删除规则 3，或
- 改为有判别力的信号：例如「`data.json` 中存在本插件历史运行字段（如非空 settings 变更记录）」+ 明确标注「本机当前处于 switchStorageMode 中途、settings 尚未落盘」这一状态由调用方显式传入布尔量，而不是让 provider 去读 `loadData`。
- 同步修正 §6 场景 A 的预期描述，使其与最终规则一致。

---

### D-3: 冲突错误传播契约未闭合——`save/delete` 会先吞掉 `SyncConflictError`

**级别**: Major
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.4（「调用方捕获后弹出 `ConflictResolutionModal`」）
- `src/storage.ts:188-204`（`save` 的 try/catch → `return false`）、`src/storage.ts:224-241`（`delete` 同构）

**问题说明**:
RFC 要求 `persistSecrets()` 抛 `SyncConflictError`，「调用方捕获后弹出 `ConflictResolutionModal` 或提示」。但直接调用方是 `save()`/`delete()` 自身，它们现有的契约是 catch-all → `console.error` → `return false`。异常根本传不到能弹窗的 UI 层；UI 层（如 `SecretManagerModal`）只收到 `false`，无法区分「远端冲突」与「写入失败」。

**风险**:
实施后场景 G 表现为「保存静默失败，仅 console 有日志」，与 §6 场景 G「确认弹出冲突解决而非静默覆盖」的验收标准直接冲突。

**审计建议**:
二选一并写进 §5.4/§5.5：
1. `save/delete` 捕获后**识别并重新抛出** `SyncConflictError`（其余错误维持 `return false`），由 `main.ts` 命令层/`SecretManagerModal` 统一捕获弹窗；
2. 或改返回结构化结果 `{ ok: false, reason: "conflict" | "error" }`（破坏性更大，需同步改全部调用点）。
推荐方案 1。

---

### D-4: §5.2 流程内置自动轮询，与 §10 未决问题 2 矛盾

**级别**: Medium
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.2（「轮询 `adapter.exists`（默认 5s×12）」）、§5.5（`waitForFile` 标注「可选」）、§10 问题 2（「或只提供『立即重试』按钮、不做自动轮询」）

**问题说明**:
流程图把轮询写成既定行为，API 清单却把实现它的 `waitForFile` 标为「可选」，§10 又把「要不要轮询」列为未决——三处互相矛盾。轮询 vs 纯手动对 UI 结构（进度条/取消语义）影响很大，属于实施前必须定案的决策。

**审计建议**:
在 RFC 中二选一定案：保守起见建议 v1 只做「立即重试」按钮（无后台定时器，避免 modal 关闭后定时器泄漏），`waitForFile` 从 API 清单删除；若保留轮询，需补充 modal 关闭时清理定时器的要求。

---

### E-1: §2.2 关于 Obsidian Sync 冲突副本行为的断言缺乏出处

**级别**: Medium
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §2.2（「非 markdown 文件不会自动合并，生成 `secrets (conflicted copy ...).enc`」）

**问题说明**:
这是整个 RFC 数据丢失论证的关键事实前提，但未给出官方文档或实测证据。§11 引用的官方文档只覆盖「选择性同步/排除规则」，不覆盖冲突副本行为。Obsidian Sync 与 remotely-save 的冲突处理行为并不相同（Sync 倾向保留版本历史，remotely-save 等第三方插件才会落地 conflicted copy 文件），RFC 把二者混为一谈。

**风险**:
若实际同步工具不产生 conflicted copy 而是直接覆盖，§2.2 的「密钥消失且无警告」叙事与 §7 的「提示用户重命名 conflicted copy 恢复」修复建议都会落空。

**审计建议**:
- 在受控环境（双设备 + Obsidian Sync）实测一次冲突，把结果写入 RFC 附录；或
- 把表述弱化为「取决于所用同步工具」，并把 §7 的恢复提示改为「检查 Sync 版本历史 / conflicted copy 文件」两路径并列。

---

### F-1: 测试计划依赖不存在的测试基建

**级别**: Major
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §8（「新增 `tests/storage.test.ts`，mock `app.vault.adapter`」）、§9 P0 验证列
- `package.json`（scripts 仅 `dev/build/typecheck`，devDependencies 无任何测试框架）

**问题说明**:
项目当前没有 `tests/` 目录、没有 vitest/jest 依赖、没有 `test` script。P0 阶段的全部验证（4 条单测）都建立在这套不存在的基建上，但「搭建测试框架」本身未出现在 §9 任何阶段中，也未计入工作量。另外本项目 `src/*.ts` 实为无类型注解的 JS 风格源码（esbuild 直接打包），引入 vitest 需同时决定 mock 方案（`app.vault.adapter` 接口面）。

**风险**:
P0 完成时无法按 §8 验收，实施者要么跳过单测（质量失控），要么临时搭框架（范围蔓延）。

**审计建议**:
在 §9 增加显式的「P0-pre：引入 vitest + adapter mock 基建」步骤，或将 §8 单测降级为「P3 之前补齐」并在 P0/P1 验收中改用手动场景。

---

### B-1: RFC 无双向链接，README 未引用

**级别**: Medium
**问题位置**:
- `docs/RFC-001-sync-initialization.md`（全文无指向其他文档的链接，仅 §11 提及外部官方文档）
- `README.md`（grep 无 `RFC`/`docs/` 引用）

**问题说明**:
项目无 AGENTS.md，无文档链接规范可依（见 H-1），但作为项目唯一的规格文档，README 至少应给出入口，否则评审者/后续维护者难以发现。RFC §9 P3 已含「README 同步（多设备使用说明）」，建议把「README 增加 RFC 链接」一并纳入。

**审计建议**:
P3 验收项补充：README「文档」节新增指向 `docs/RFC-001-sync-initialization.md` 的相对链接。

---

### H-1: 项目缺少文档规范（无 AGENTS.md），命名/目录约定无从审计

**级别**: Medium
**问题位置**:
- 项目根目录（无 `AGENTS.md`、无 `docs/` 下索引文件）

**问题说明**:
`RFC-001-sync-initialization.md` 的命名（3 位序号、kebab-case slug、无日期段）无可对照的项目规范；审计报告目录（`docs/audits/`）、序号宽度等均无约定。本次审计按通用默认（`AUDIT-NNNN-slug-YYYY-MM-DD`，4 位序号）输出。

**审计建议**:
若项目预期持续产出 RFC/规格文档，建议用 project-bootstrap 流程生成 AGENTS.md，固化命名与目录约定；单文档项目可忽略。

---

### G-1: `initialize()` 写保护失败时的用户引导未定义

**级别**: Medium
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.2（「存在则拒绝创建并返回 `false`」）
- `src/ui.ts:142-148`（`handleSetup`：`success=false` → 仅提示「❌ 密钥库创建失败」）

**问题说明**:
写保护触发意味着「同步恰在此时把远端库送来了」——此刻正确动作是引导用户改为解锁，而非笼统的「创建失败」。RFC 未定义 `initialize()` 如何区分「竞态拒绝」与其他失败，也未要求 `SetupPasswordModal` 给出差异化提示。

**审计建议**:
§5.5 补充：`initialize()` 拒绝时返回区分性结果（如 `{ ok:false, reason:"already-exists" }` 或抛出专用错误），`SetupPasswordModal` 对该 reason 提示「检测到密码库文件已存在（同步已完成），请改为解锁」并切换到 `UnlockModal`。

---

### C-1: `initialize()` 的 check-then-write 仍是 TOCTOU，残余竞态未声明

**级别**: Advisory
**问题位置**:
- `docs/RFC-001-sync-initialization.md` §5.2「写保护」、§2.3.4

**问题说明**:
`adapter.exists` → `adapter.write` 之间无法原子化，同步工具的并发写仍可能在检查之后落地。RFC 把该保护称为「防竞态」但未声明它只能缩小窗口、不能根除。

**审计建议**:
在 §5.2 或 §7 补一句残余风险声明：「本保护将竞态窗口从『整段用户操作流程』缩小到『exists/write 之间毫秒级』，无法完全消除；如需根除需文件锁，超出 v1 范围。」

---

## 3. 建议修复顺序

1. **先修 D-1** — 阻断级：确定 `checkBeforeSave` 的挂点（入口 vs persistSecrets 豁免参数），补全调用方清单与场景 G 验收。
2. **再修 D-2** — 痕迹检测规则 3 重定义，同步修正场景 A 预期；D-1/D-2 是仅有的两个会改变代码结构的决策。
3. **再修 D-3** — 错误传播契约二选一，与 D-1 的挂点决策联动（若检查上移到 save/delete，天然解决一半）。
4. **再修 F-1** — 明确测试基建归属阶段，否则 P0 无法验收。
5. **定案 D-4** — 轮询与否二选一，删改 §5.2/§5.5/§10 三处使其一致。
6. **最后处理 E-1 / G-1 / C-1 / B-1 / H-1** — 文案、证据补充与文档链接，不影响设计定型。

---

## 4. 次要观察（不阻断）

- RFC 行号引用整体准确（`isInitialized` storage.ts:106 ✓、`switchStorageMode` main.ts:177 ✓、`ensureUnlocked` main.ts:234 ✓、`checkBeforeSave` storage.ts:443 vs 文中 444、initialize storage.ts:117 vs 文中 115-134，偏差 ≤2 行，可接受）；修订后建议随手刷新一次行号。
- `manifest.json` version 为 `1.0.1` 而 `package.json` 为 `1.0.0`，版本漂移（代码侧问题，与 RFC「影响版本 1.0.1 及后续」的表述建议对齐）。
- §5.1 `getState()` 三态定义清晰，与现有 `unlocked` 布尔字段兼容方案（`isInitialized()` 保留为包装）合理，无发现。
- `switchStorageMode` 的 `!isInitialized` 分支在成功回调里才写 `settings.storageMode`（main.ts:191/196）——若用户在 SetupPasswordModal 点「取消」，设置界面 dropdown 已显示 sync 但 settings 未落盘，存在 UI 状态与 settings 不一致的既有小问题；新流程引入 `VaultNotFoundModal` 的「取消」分支时建议一并处理（重设 dropdown 或 Notice 提示）。

---

*文档版本: 2026-08-06*

---

## 5. 修订处置记录（2026-08-06，RFC v1.1）

以下为本报告发现项在 [RFC-001 v1.1](../RFC-001-sync-initialization.md) 中的处置
状态。审计正文保持原样，供对照复核。

| 编号 | 级别 | 处置 | RFC 落点 |
| --- | --- | --- | --- |
| D-1 | Critical | 已修：采用「显式豁免参数」方案——`persistSecrets({ skipConflictCheck })` 默认检查，`resolveConflictWithLocal/WithMerge` 传 `true`；调用方清单补全 `resolveConflictWithLocal`；场景 G 增加三按钮落盘验收 | §5.4、§5.5、§6-G、§8-4 |
| D-2 | Major | 已修：痕迹检测删除规则 3（data.json，两条路径上恒真/恒假），仅保留规则 1/2；场景 A 预期同步修正 | §5.2、§6-A |
| D-3 | Major | 已修：`save/delete/migrateFromLocal` 捕获后识别并重新抛出 `SyncConflictError`，UI 层（`saveSecret/deleteSecret`/`MigrationModal`）统一捕获弹窗 | §5.4、§5.5 |
| D-4 | Medium | 已定案：v1 不做自动轮询，仅「立即重试」按钮；`waitForFile` 从 API 清单移除；§10 问题 2 关闭 | §5.2、§5.5、§10-2 |
| E-1 | Medium | 已改：§2.2 表述弱化为「取决于所用同步工具」；§7 恢复提示改为「Sync 版本历史 / conflicted copy」两路径并列；新增未决问题 5（双设备实测） | §2.2、§7、§10-5 |
| F-1 | Major | 已修：§9 新增「P0-pre：vitest + adapter mock 基建」阶段；§8 单测补充 D-1 豁免回归与 D-3 契约用例 | §8、§9 |
| B-1 | Medium | 已修：README 新增「📚 文档」节，链接 RFC 与审计 | README.md |
| H-1 | Medium | 暂不处理：单文档项目，未引入 AGENTS.md（若后续持续产出规格文档再行补齐） | — |
| G-1 | Medium | 已修：`initialize()` 返回 `{ ok, reason }`；`SetupPasswordModal` 对 `already-exists` 提示并切换到 `UnlockModal` | §5.2、§5.5 |
| C-1 | Advisory | 已声明：§5.2 写保护段补充残余竞态说明（窗口缩小至毫秒级，根除需文件锁） | §5.2 |
| 次要观察 | — | 行号已刷新（checkBeforeSave 443-456、initialize 117-138、backups 270-283、switchStorageMode 177-211、ensureUnlocked 234-255）；版本漂移（manifest 1.0.1 vs package.json 1.0.0）属代码侧问题，不在本文档处置；dropdown 取消不一致已纳入 §5.2「取消分支」约定 | 全文、§5.2 |
