# AGENTS.md - Obsidian Secret Storage 插件

本文档面向 AI 编程助手，提供项目架构、技术栈、开发规范和运维指南的快速参考。

> **工作进度记忆约定（默认开启）**
>
> - **开始工作前**：每次开始处理用户任务之前，**默认先用 `basic-memory` 读取本项目之前的工作进度与上下文**
>   - 推荐使用 `bm_recent` 查看最近活动，再用 `bm_search` / `bm_context` 按当前任务主题检索相关笔记
>   - 建议维护一篇「工作进度」类笔记（如 `obsidian-secret-storage 工作进度`），开工前先读取，避免重复劳动或遗漏历史决策
> - **完成后**：任务完成后，**自动将本次工作进展、关键变更、决策与遗留问题写入 `basic-memory`**
>   - 使用 `bm_write` 创建或更新对应笔记；重要决策、规格变更、故障排查结论都应持久化
> - **兜底**：无论任务粒度如何模糊，**每次成功创建/推送 PR 后，必须至少写入一次 basic-memory**，记录 PR 编号、分支、关键变更、验证状态、待 review 事项
>   - 多轮任务期间可按子阶段多次写入；PR 创建是强制写入节点，不可省略
>   - 写入内容应足以让下次会话仅凭进度笔记即可继续 review/merge 链路，无需重新翻阅对话
> - **例外**：用户**显式说明「不读取 / 不写入 basic-memory」**时，可跳过上述步骤；否则一律执行
> - **目的**：跨会话保持上下文连贯，避免 AI 助手因会话重置而丢失项目历史与决策链路

---

## 1. 项目概述

本项目是一个 Obsidian 插件，用于安全存储 API 密钥等敏感信息。提供两套存储方案：

| 模块 | 功能 | 主文件 |
|------|------|--------|
| 插件主类 | 命令注册、占位符处理、设置页 | `main.ts` |
| 加密服务 | PBKDF2 / AES-256-GCM 密钥库读写 | `src/crypto.ts` |
| 存储提供者 | 本地模式 / 同步模式双实现 | `src/storage.ts` |
| UI 组件 | 密码/解锁/冲突/迁移等模态框 | `src/ui.ts` |
| 样式 | 占位符与密钥管理区块样式 | `styles.css` |

### 1.1 技术栈

- **语言**: TypeScript（`strict: false`，`noImplicitAny: false`）
- **构建**: esbuild（`esbuild.config.mjs`，入口 `main.ts` → 产物 `main.js`）
- **测试**: Vitest（`vitest.config.ts`，`tests/*.test.ts`）
- **运行时**: Obsidian 插件 API（`obsidian` 类型包，`minAppVersion 1.11.4`）
- **发布**: GitHub Actions（`.github/workflows/release.yml`，tag 触发 CI 构建发布）

### 1.2 目录结构

```
obsidian-secret-storage-plugin/
├── README.md              # 插件说明与使用文档
├── AGENTS.md              # 本文件
├── main.ts                # 插件主类、命令、设置页、密钥管理 UI
├── main.js                # 构建产物（gitignore，由 CI 构建）
├── manifest.json          # 插件清单（id/name/version/minAppVersion）
├── versions.json          # 版本 → minAppVersion 映射
├── package.json           # npm scripts 与依赖
├── esbuild.config.mjs     # esbuild 构建配置
├── tsconfig.json          # TypeScript 配置
├── vitest.config.ts       # Vitest 配置（覆盖率阈值 80%）
├── styles.css             # 插件样式
├── src/                   # 源码模块
│   ├── crypto.ts          # 加密服务
│   ├── storage.ts         # LocalStorageProvider / SyncStorageProvider
│   └── ui.ts              # 密码/解锁/冲突/迁移模态框
├── tests/                 # 单元测试
│   ├── crypto.test.ts
│   ├── storage.test.ts
│   └── helpers.ts         # mock app.vault.adapter / localStorage / obsidian
├── docs/                  # 规格书与审计
│   ├── RFC-001-sync-initialization.md
│   ├── RFC-002-secret-search.md
│   └── audits/            # 审计报告
└── .github/workflows/     # CI 发布工作流
```

---

## 2. 安装与运行

### 2.1 环境准备

```bash
npm install
```

### 2.2 常用命令

```bash
npm run dev          # esbuild watch 模式（开发）
npm run build        # 生产构建（生成 main.js）
npm run typecheck    # TypeScript 类型检查（tsc -noEmit）
npm test             # Vitest 单元测试
npm run test:coverage # 覆盖率测试（阈值 80%）
```

### 2.3 手动安装到 Obsidian

1. 将本目录放入 vault 的 `.obsidian/plugins/` 下
2. Obsidian → 设置 → 第三方插件 → 关闭「安全模式」
3. 启用 **Secret Storage Demo**

---

## 3. 核心模块详解

### 3.1 插件主类（main.ts）

**命令注册**（`onload` 中 `addCommand`）：
| 命令 ID | 功能 |
|---------|------|
| `insert-secret-placeholder` | 插入密钥占位符 |
| `replace-selection-with-secret` | 选中文本保存为密钥并替换 |
| `save-secret` | 保存密钥 |
| `get-secret` | 获取密钥 |
| `list-secrets` | 列出所有密钥 |
| `delete-secret` | 删除密钥 |
| `unlock-vault` / `lock-vault` | 解锁/锁定密钥库（同步模式） |
| `change-password` | 修改主密码 |
| `check-sync` | 检查同步状态 |

**占位符处理**：`registerMarkdownPostProcessor` 将 `{{secret:密钥ID}}` 渲染为真实密钥值，支持 blur / hidden / plain 三种显示样式。

**密钥管理 UI**：`SecretStorageSettingTab`（设置页内联列表）+ `SecretManagerModal`（ribbon 图标）。

### 3.2 加密服务（src/crypto.ts）

- `PBKDF2-SHA256` 派生密钥，**310,000 次迭代**（OWASP 2023 推荐）
- `AES-256-GCM` 认证加密，随机 16 字节盐 + 12 字节 IV
- 密钥标记为 *non-extractable*，独立密码验证器
- 依赖 Web Crypto API（`crypto.subtle`），Node ≥ 20 提供全局实现

### 3.3 存储提供者（src/storage.ts）

**双模式**：
- `LocalStorageProvider`：调用 `app.secretStorage`（OS 安全存储，不可同步）
- `SyncStorageProvider`：AES-256-GCM 加密写入 vault 根目录 `SecretStorage/secrets.enc`（可同步）

**同步模式关键路径**（RFC-001）：
- 密钥库文件位于 **vault 根目录** `SecretStorage/secrets.enc`（v1.2 起从插件目录迁移，因 Obsidian Sync 对插件目录采用文件名白名单，`secrets.enc` 在插件目录内永不同步）
- 状态模型：`uninitialized` / `locked` / `unlocked`
- 冲突检测：基于设备 ID + `lastModified` 时间戳
- 冲突解决：使用本地 / 使用远程 / 智能合并
- 自动备份：每次写入前备份到 `SecretStorage/backups/`

**错误传播契约**（RFC-001 §5.4）：`SyncConflictError` 上抛给 UI 层，由 `ConflictResolutionModal` 处理。

### 3.4 UI 组件（src/ui.ts）

| 模态框 | 功能 |
|--------|------|
| `SetupPasswordModal` | 首次设置主密码（强度校验） |
| `UnlockModal` | 解锁密钥库 |
| `ChangePasswordModal` | 修改主密码 |
| `MigrationModal` | 本地密钥迁移到同步库 |
| `ConflictResolutionModal` | 同步冲突解决 |
| `VaultNotFoundModal` | 文件不存在三选一决策 |

---

## 4. 开发规范

### 4.0 Git / PR 流程

- **禁止直接合并到主分支**：所有代码、文档、配置更新都不得直接合并到 `main`
- **必须走分支 + PR**：实现任何变更时，先在非主分支上开发，再通过 Pull Request 审核与合并
- **禁止在主分支上直接交付变更**：AI 助手如果当前位于 `main`，开始修改前应先创建并切换到功能分支
- **提交粒度要求**：保持原子化提交；文档审计/规格修复、实现、CI 或测试补充应尽量分成独立提交
- **提交信息规范**：遵循 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:` / `ci:` / `test:`），参考现有历史

### 4.1 代码风格

- TypeScript，遵循 `tsconfig.json`（`strict: false`，但新代码尽量显式类型）
- 字符串优先使用模板字符串
- 常量使用 `const`，避免硬编码魔法值
- 中文注释与文档（项目语言为中文）

### 4.2 错误处理

- 存储层方法返回 `boolean` / `null` 表示失败，不静默抛错
- `SyncConflictError` 走显式错误传播契约（RFC-001 §5.4）
- 异步操作使用 `try/catch`，`console.error` 记录上下文
- 用户操作失败用 `new Notice(...)` 提示

### 4.3 测试规范

- 单元测试放 `tests/*.test.ts`，用 Vitest
- mock 方案（`tests/helpers.ts`）：
  - `app.vault.adapter` 用内存实现（`createMemoryAdapter`）
  - `obsidian` 模块整体 mock（`Notice` 等为空实现）
  - `cryptoService` 保留真实实现（Node ≥ 20 提供全局 WebCrypto）
- 覆盖率阈值 80%（`vitest.config.ts`），`src/ui.ts` 依赖 DOM 由手动验收覆盖
- 新增纯函数应抽成可导出、可测试的形式

### 4.4 文档规范

**双向链接要求：**

技术规格文档之间需要在文档开头显式地添加双向链接，具体包括：

- **规格书**（`RFC-*.md`）与**审计报告**（`docs/audits/AUDIT-*.md`）之间必须双向链接
- **增量规格书**与**基线规格书**之间必须链接（如 `RFC-002` 建立在 `RFC-001` 基础上）
- **功能规格书**与**架构/父规格书**之间应链接

**链接格式示例：**
```markdown
**关联规格书**: [RFC-001-sync-initialization.md](./RFC-001-sync-initialization.md)
**审计报告**: [AUDIT-0001-rfc-001-sync-initialization-2026-08-06.md](./audits/AUDIT-0001-rfc-001-sync-initialization-2026-08-06.md)
```

**规格书结构**（参考 RFC-001 / RFC-002）：
- 修订历史表
- 摘要
- 问题陈述（代码证据）
- 目标 / 非目标
- 设计原则
- 详细设计（含 API 变更清单、UI 文案）
- 场景走查
- 兼容性与迁移
- 测试计划
- 实施分阶段
- 未决问题（Open Questions）

**不需要关联的文档类型：**
- **用户指南**（如 README）不需要与规格书关联
- **维护文档**保持独立，面向不同受众

### 4.5 构建与发布

- **构建**：`npm run build`（esbuild 生产构建，生成 `main.js`）
- **发布**：推送与 `manifest.json` 中 `version` 字段匹配的 tag（如 `1.0.4`），触发 `.github/workflows/release.yml`
  - CI 校验 tag 与 manifest version 一致 → `npm ci` → `npm run build` → 创建 GitHub Release
  - 附带三个资产：`main.js`（CI 构建产物）、`manifest.json`、`styles.css`
- **版本递增**：改代码时同步更新 `manifest.json` 的 `version` 和 `versions.json` 映射
- `main.js` 是构建产物，**不手动编辑、不提交**（gitignore，由 CI 构建）

---

## 5. 安全注意事项

1. **密钥库文件**：`SecretStorage/secrets.enc` 含加密密钥，勿提交到版本控制（已在 `.gitignore`）
2. **主密码不可恢复**：忘记主密码无法恢复任何密钥（README 已声明）
3. **搜索只匹配 ID**：密钥搜索功能只匹配密钥 ID，不触碰密钥值（值加密且敏感）
4. **占位符安全**：`{{secret:密钥ID}}` 在阅读视图渲染真实值，注意显示样式（blur/hidden/plain）选择
5. **同步模式**：密钥库文件在 vault 根目录，需开启 Obsidian Sync「同步所有其他类型文件」才能跨设备同步

---

## 6. 故障排查

### 6.1 密钥库文件不同步

- 确认密钥库在 vault 根目录 `SecretStorage/secrets.enc`（v1.2 起）
- 确认 Obsidian Sync 已开启「同步所有其他类型文件」与「其他文件类型」
- 旧路径（插件目录内）的库会自动迁移

### 6.2 同步冲突

- 解锁时自动检测冲突，弹出 `ConflictResolutionModal`
- 三种解决策略：使用本地 / 使用远程 / 智能合并
- 冲突解决路径显式豁免冲突检查（RFC-001 §5.4，审计 D-1）

### 6.3 测试失败

```bash
npm test              # 运行全部测试
npm run test:coverage # 检查覆盖率是否达标（80%）
npm run typecheck     # 类型检查
```

---

## 7. 扩展开发

### 7.1 新增命令

在 `main.ts` 的 `onload` 中 `addCommand`，注意：
- `editorCallback`：需要编辑器上下文
- `checkCallback`：需要条件判断（如同步模式、解锁状态）
- `callback`：普通命令

### 7.2 新增存储模式

在 `src/storage.ts` 实现 Provider，实现 `save/get/list/delete/isUnlocked/getMode` 接口，并在 `createStorageProvider` 中注册。

### 7.3 新增 UI 模态框

在 `src/ui.ts` 或 `main.ts` 中 `extends Modal`，遵循现有模态框风格（`contentEl.empty()` + `addClass("secret-storage-modal")` + `onClose` 清理）。

---

*文档版本: 2026-09-01*
*项目语言: 中文（代码注释和文档主要使用中文）*
