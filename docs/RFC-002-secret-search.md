# RFC-002: 密钥搜索功能

**为持续增长的密钥库提供高效的检索入口**

| 字段 | 值 |
| --- | --- |
| 状态 | Draft（待审阅） |
| 日期 | 2026-09-01（初稿） |
| 作者 | pi（代笔，基于代码审查） |
| 关联模块 | `main.ts` / `src/ui.ts` / `styles.css` |
| 影响版本 | 1.0.4 及后续 |

---

## 修订历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| v1.0（初稿） | 2026-09-01 | 首次提交评审 |

---

## 1. 摘要

随着密钥库中密钥数量的持续增长，现有密钥管理入口在面对几十上百个密钥时变得低效：
`GetSecretModal` / `DeleteSecretModal` / `InsertPlaceholderModal` 均**一次性把全部密钥渲染成列表**，需靠滚动查找；设置页密钥管理区块同样冗长。

本 RFC 提出两条互补的搜索能力：

- **方案 A（选择型搜索）**：把「选一个密钥」类模态框（Get / Delete / Insert）从自建 `Modal` 改造成 Obsidian 原生 `FuzzySuggestModal`，输入即时模糊过滤、键盘选择，体验与命令面板一致。
- **方案 B（列表型搜索）**：在设置页密钥管理区块顶部加入搜索框，实时过滤密钥列表，供浏览/管理（编辑、复制、删除）场景使用。

搜索**只匹配密钥 ID，不触碰密钥值**（值加密且敏感），不引入任何外部依赖，复用 Obsidian `FuzzySuggestModal` / `prepareSimpleSearch`。

## 2. 问题陈述（代码证据）

### 2.1 `GetSecretModal` / `DeleteSecretModal` / `InsertPlaceholderModal` 全量渲染

`main.ts` 中三个「选一个密钥」模态框都在 `onOpen()` 里同步遍历 `listSecrets()` 并对每个 id `new Setting(...)` 建行，密钥多时列表极长：

- `GetSecretModal.onOpen()`（main.ts）：`for (const id of secrets) { new Setting(contentEl).setName(id)... }` —— 无过滤，长列表靠滚动。
- `DeleteSecretModal.onOpen()`：同上，逐 item 渲染 + 删除按钮。
- `InsertPlaceholderModal.onOpen()`：同上，逐 item 渲染 + 插入按钮。

### 2.2 设置页密钥管理区块全量渲染

`SecretStorageSettingTab.renderSecretManagement()`（main.ts）遍历 `secrets`，为每个 id 调用 `renderSecretItem` 或 `renderEditForm` 建行，密钥多时区块冗长难找。

### 2.3 现状代码形态

| 模态框 | 现状类型 | 列表逻辑 |
| --- | --- | --- |
| `GetSecretModal` | 自建 `Modal` | 全量 for 循环 |
| `DeleteSecretModal` | 自建 `Modal` | 全量 for 循环 |
| `InsertPlaceholderModal` | 自建 `Modal` | 全量 for 循环 |
| 设置页区块 | `SecretStorageSettingTab` | 全量 for 循环 |

## 3. 目标 / 非目标

### 3.1 目标

1. 为「选一个密钥」场景（查看/复制、删除、插入占位符）提供可输入过滤的选择器，替换全量列表。
2. 为设置页密钥管理提供实时搜索过滤。
3. 搜索只针对密钥 ID，保证密钥值安全不外泄。
4. 不引入外部依赖，复用 Obsidian 原生搜索组件。
5. 保持桌面端既有视觉与交互习惯尽可能一致；行为向后兼容。

### 3.2 非目标（本次不做）

- **不按密钥值搜索**（值加密且敏感，解密遍历代价高且在 UI 中明文暴露风险大）。
- **不新增单独的全屏列表视图 / 弹窗式密钥浏览器**。
- **不引入第三方模糊搜索库**（如 `fuse.js`），Obsidian 原生能力已足够。
- **不改动数据模型 / 存储格式**（`secrets` 仍是 `{ [id]: secret }`）。
- **不改动占位符处理、加密、同步冲突等既有逻辑**。
- **不做移动端专门适配**（`isDesktopOnly: true` 不变；移动端支持属另一独立改造，见 feature/mobile-support 分支）。

## 4. 设计原则

1. **复用原生能力优先**：`FuzzySuggestModal`（键盘选择型）与 `prepareSimpleSearch` / `prepareFuzzySearch`（列表过滤型）均为 Obsidian 内置，避免自造轮子。
2. **安全默认**：搜索输入框与结果都只显示 ID；`FuzzySuggestModal` 的 `getItemText` 只返回 ID。
3. **一处搜索，处处复用**：统一的搜索过滤逻辑抽成可复用函数，供设置页列表使用；`FuzzySuggestModal` 由各「选一个密钥」模态框继承复用「获取全部 ID」即可，避免重复 `listSecrets()` 逻辑。
4. **最小侵入**：保留各模态框现有的「选择后行为」（查看/复制/删除/插入），仅把「如何呈现候选」替换为可过滤形式。

## 5. 详细设计

### 5.1 统一密钥 ID 搜索助手（`src/search.ts`）

新增独立纯函数模块 `src/search.ts`（不依赖 obsidian 运行时，便于单元测试）：

```ts
// src/search.ts
export function filterSecretIds(ids, query, matcher = null) {
  if (!query || query.trim() === "") return ids;
  const q = query.trim().toLowerCase();
  const match = matcher || ((text) => text.includes(q));
  return ids.filter((id) => match(id.toLowerCase()));
}
```

- 默认用子串 `includes` 匹配（大小写不敏感），满足列表过滤场景。
- 可注入自定义 `matcher`（如 `prepareSimpleSearch` 包装），由调用方决定匹配策略。
- `main.ts` 设置页调用时注入 `prepareSimpleSearch` 包装的 matcher，获得分词匹配手感。

### 5.2 方案 A：三个「选一个密钥」模态框改造成 `FuzzySuggestModal`

三者保持现有「选中后行为」不变，仅把 `extends Modal` + `onOpen` 全量渲染，改为 `extends FuzzySuggestModal<string>`，实现三个抽象方法：

```ts
import { FuzzySuggestModal } from "obsidian";

export class GetSecretModal extends FuzzySuggestModal<string> {
  plugin: any;
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    // 输入框占位提示
    this.setPlaceholder("搜索密钥 ID...");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "↵", purpose: "查看/复制" },
      { command: "esc", purpose: "取消" }
    ]);
    this.limit = 50; // 限制候选数量，避免长列表卡顿
  }
  // listSecrets() 本身为 async，故 getItems 异步
  async getItems(): Promise<string[]> {
    return this.plugin.listSecrets();
  }
  getItemText(id: string): string {
    return id; // 仅返回 ID，不触碰值
  }
  onChooseSuggestion(id: string, evt: MouseEvent | KeyboardEvent) {
    // 原 GetSecretModal 的「查看」按钮行为：这里如何呈现由 UX 决定（见下）
  }
}
```

**各模态框选择后行为映射：**

| 模态框 | 原「全量列表」中每行行为 | 改造后 `onChooseSuggestion` 行为 |
| --- | --- | --- |
| `GetSecretModal` | 每行有「查看」「复制」按钮 | 见 5.2.1 的查看/复制 UX 决策 |
| `DeleteSecretModal` | 每行有「删除」按钮（带确认） | 选中后弹 `ConfirmDeleteModal` 确认 → 删除 → 刷新 |
| `InsertPlaceholderModal` | 每行有「插入」按钮 | 选中后把 `{{secret:<id>}}` 插入编辑器光标处 |

> `FuzzySuggestModal` 是 `SuggestModal` 的子类，自带输入框 + 实时过滤 + 键盘选择；`getItems` 可返回 `Promise`（观测类型 `getSuggestions(query): T[] | Promise<T[]>`、`getItems` 抽象方法见 `obsidian.d.ts:3294` 附近）。

#### 5.2.1 UX 决策：`GetSecretModal` 选中后查看 vs 复制

`FuzzySuggestModal` 单一回车动作。两种候选交互，**本次默认采用后者（直接复制）**，理由（详见 §10 未决问题）：

- **直接复制**：选中回车后 `writeText(id 对应值)` + Notice「已复制到剪贴板」，一步到位，命令面板风格，最快。符合移动端设计文档（feature/mobile-support）也强调的「点击复制」习惯（其 `copyToClipboard` 封装）。
- 二次弹窗查看：选中后弹出值查看浮层，多一步，交互更重。

选复制仍保留「查看」路径：设置页列表已有编辑/复制入口；`GetSecretModal` 定位为「快速取用」。

### 5.3 方案 B：设置页密钥管理区块搜索框

在 `SecretStorageSettingTab.renderSecretManagement` 的密钥列表上方增加搜索框。

**状态**：`SecretStorageSettingTab` 新增 `searchInput: string`（当前搜索关键词）。

**渲染流程：**
```
renderSecretManagement:
  renderAddButton(containerEl)          // 原「+ 新增密钥」按钮
  renderSearchBox(containerEl)          // 新增：搜索框 + 清除按钮
  secrets = await listSecrets()
  filtered = filterSecretIds(secrets, this.searchInput)  // 空则全部
  if filtered.length === 0 → 空状态文案（区分「无密钥」与「无匹配」）
  for id of filtered → renderSecretItem / renderEditForm
```

**搜索框交互：**
- `Setting(containerEl).setName("搜索密钥").addText(...)`，setPlaceholder("输入关键词过滤...")，`onInput`/`input` 事件里更新 `this.searchInput` 并调用 `loadSecretSection()` 重绘列表。为降低频率可做**约 150ms 防抖**。
- 提供清除按钮（`addExtraButton`，icon "cancel"）一键清空。
- 搜索框位于「+ 新增密钥」按钮之后、列表之前。

**与编辑态的交互**：若 `this.editingId !== null` 且该 id 被当前关键词过滤掉，仍应渲染编辑表单（正在编辑的项优先级高于过滤器），避免输入词导致正在编辑的表单从 DOM 消失。

**空状态文案区分：**
- `searchInput` 为空且无密钥 → 「暂无密钥，点击上方按钮添加」
- `searchInput` 非空且无匹配 → 「没有匹配「<关键词>」的密钥」

### 5.4 命令与入口（可选增强，本次默认含）

在 `main.ts` 新增全局命令，作为快速搜索入口（方案 C，轻量并入）：

```ts
this.addCommand({
  id: "search-secret",
  name: "搜索密钥并复制 (Search & Copy Secret)",
  callback: () => {
    this.ensureUnlocked(() => {
      new GetSecretModal(this.app, this).open();
    });
  }
});
```

> 复用 `GetSecretModal`（改造后即搜索+复制），无需新建类型；同时 ribbon 图标仍打开 `SecretManagerModal` 不变。

### 5.5 API / 类变更清单

| 位置 | 变更 | 类型 |
| --- | --- | --- |
| `src/search.ts` | 新增 `filterSecretIds` 纯函数（可注入 matcher） | 新增 |
| `main.ts` helper | 设置页调用 `filterSecretIds` 并注入 `prepareSimpleSearch` matcher | 增强 |
| `main.ts` `GetSecretModal` | 改 `extends FuzzySuggestModal<string>`，`getItems/getItemText/onChooseSuggestion` | 重写 |
| `main.ts` `DeleteSecretModal` | 同上；`onChooseSuggestion` 弹确认 → 删除 | 重写 |
| `main.ts` `InsertPlaceholderModal` | 同上；`onChooseSuggestion` 插入占位符 | 重写 |
| `main.ts` `SecretStorageSettingTab` | 新增 `searchInput` 状态 + `renderSearchBox` + 过滤逻辑 + 空态区分 | 增强 |
| `main.ts` | 新增命令 `search-secret` | 新增 |
| `styles.css` | 搜索框/清除按钮/空态类样式 | 新增 |
| `src/ui.ts` | 无改动（本次不动 ui.ts） | — |

> 说明：三个目标模态框目前定义在 `main.ts`（非 `src/ui.ts`），故改动集中在 `main.ts`。若后续将其迁至 `src/ui.ts` 可一并调整，本次保持文件现状。

### 5.6 UI 文案要点

| 场景 | 文案 |
| --- | --- |
| GetSecretModal 占位 | 「搜索密钥 ID...」 |
| GetSecretModal 无结果 | OnNoSuggestion 默认显示空状态即可（可设 `emptyStateText`） |
| DeleteSecretModal 占位 | 「搜索要删除的密钥 ID...」 |
| InsertPlaceholderModal 占位 | 「搜索要插入的密钥 ID...」 |
| 设置页搜索框占位 | 「输入关键词过滤密钥...」 |
| 设置页空态（无密钥） | 「暂无密钥，点击上方按钮添加」 |
| 设置页空态（无匹配） | 「没有匹配「<关键词>」的密钥」 |
| 复制成功 | 「✅ 密钥 "${id}" 已复制到剪贴板」 |

## 6. 场景走查

**场景 1：快速取用一个 API Key（搜索→复制）**
1. 命令面板（Ctrl+P）运行「搜索密钥并复制」。
2. 弹出 `GetSecretModal`（FuzzySuggestModal），输入 `openai`。
3. 候选即时过滤，回车选中 `openai-api-key`。
4. 值写入剪贴板，Notice 提示。✅

**场景 2：删除一个密钥**
1. 运行「删除密钥」，弹出 `DeleteSecretModal`，输入关键词过滤。
2. 回车选中，弹出 `ConfirmDeleteModal` 确认。
3. 确认后删除，列表刷新（modal 关闭）。✅

**场景 3：在笔记里插入占位符**
1. 编辑模式，运行「插入密钥占位符」，弹出 `InsertPlaceholderModal`。
2. 过滤 → 选中 → `{{secret:<id>}}` 插入光标处。✅

**场景 4：设置页浏览/管理几十个密钥**
1. 打开插件设置 →「密钥管理」区块顶部出现搜索框。
2. 输入关键词，列表实时刷新过滤；清除后恢复全量。
3. 编辑/复制/删除按钮随过滤后的项呈现，行为不变。✅

**场景 5：编辑中的表单不因过滤消失**
1. 设置页搜索框输入 A，列表过滤；点击某项「编辑」进入编辑态。
2. 关键词输入改为 B，原项被过滤掉——编辑表单仍保留（§5.3）。✅

## 7. 兼容性与迁移

- **纯增量新功能，无数据结构变更**，`versions.json` 无需映射，版本号从 1.0.3 → 1.0.4。
- `FuzzySuggestModal` `@since 0.9.20`，`prepareSimpleSearch` `@since 0.9.20`，`minAppVersion 1.11.4` 完全满足。
- 既有自建 `Modal` 的 `SecretManagerModal`、`SaveSecretModal`、密码/冲突/迁移等模态框**完全不动**。
- 设置页搜索为新增区块行为，不影响原有密钥管理功能与排序。
- 桌面端 `isDesktopOnly: true` 保持不变。

## 8. 测试计划

### 8.1 单元测试（vitest）

`filterSecretIds` 为纯函数，可直接测，放 `tests/`：

| 用例 | 期望 |
| --- | --- |
| 空 query → 返回全部 | 原数组 |
| 全字匹配 → 仅命中 | 命中项 |
| 子串/分词部分命中 | 相关项 |
| 大小写不敏感 | 命中（内部 toLowerCase） |
| 无匹配 | `[]` |

> `filterSecretIds` 建议抽成可导出纯函数（不依赖 plugin/app），便于测试。`prepareSimpleSearch` 在 Obsidian 运行时可用；若 vitest 环境下无法 import obsidian 运行时，可把纯过滤逻辑（`ids.filter(id => id.includes(q) ...)` 或注入 matcher）与「prepared 函数」分离，注入以便测试。

> **测试基建注意**：现有 `tests/storage.test.ts` 通过 `helpers.ts` mock 环境。若需 import `obsidian`，参考 helpers 的 mock 方式；否则让 `filterSecretIds` 不依赖 obsidian import（纯 includes 过滤即可满足列表场景），规避运行环境差异。

### 8.2 手动回归（桌面）

| 用例 | 期望 |
| --- | --- |
| 三个「选一个密钥」模态框打开即显示候选、可输入过滤、键盘选择 | ✅ |
| 设置页搜索框输入/清除/空态 | ✅ |
| 编辑态与过滤共存 | ✅ |
| 新增命令「搜索密钥并复制」 | ✅ |
| 原有 Save/Manager/密码/冲突/迁移模态框不受影响 | ✅ |
| 本地模式与同步模式（解锁后）均验证 | ✅ |
| `npm run build` / `typecheck` 通过 | ✅ |

## 9. 实施分阶段

1. `main.ts`：抽 `filterSecretIds` 纯函数（可测试）。
2. 方案 A：`GetSecretModal` 改 `FuzzySuggestModal`（含 `search-secret` 命令）。
3. 方案 A：`DeleteSecretModal`、`InsertPlaceholderModal` 改造。
4. 方案 B：设置页搜索框 + 状态 + 过滤 + 空态 + 编辑态共存。
5. `styles.css`：搜索框相关样式。
6. 单测（8.1）+ `npm run build` / `typecheck` 验证。
7. 手动回归（8.2），确认稳定后提交、打 tag 1.0.4。

## 10. 未决问题（Open Questions）

1. **`GetSecretModal` 选中后直接复制 还是 二次查看？**
   本次默认「直接复制」（§5.2.1）。若期望「先查看再决定复制」，可改为选中后弹出值浮层（类似原「查看」按钮的 Notice 展示）。→ 待确认。
2. **列表过滤用 `prepareSimpleSearch` 还是 `prepareFuzzySearch`？**
   `prepareFuzzySearch` 更接近 `FuzzySuggestModal` 的模糊手感但性能开销略高；`prepareSimpleSearch` 分词匹配更简单。设置页列表倾向 `prepareSimpleSearch`（数据量适中，简单可靠）。→ 待确认。
3. **`limit` 上限取值**（如 50）是否合适？密钥超限时是否需要提示？
4. **是否保留「GetSecretModal 查看值」能力**？删除后原「查看」路径消失（改由设置页 / 复制覆盖）。

## 11. 附注：与移动端支持（feature/mobile-support）的关系

- 搜索功能不依赖任何桌面专属 API，`FuzzySuggestModal` / `prepareSimpleSearch` 在移动端均可用于后续移动端改造。
- 若后续并入移动端，`GetSecretModal` 的复制应改用移动端设计文档 §四.4.2 提出的 `copyToClipboard(text)` 多层 fallback 封装，而非直接 `navigator.clipboard.writeText`。本次桌面端保持现状，但复制路径建议先行抽成 `copyToClipboard` 以便未来复用。
