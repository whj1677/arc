# ARC · 工程全貌与功能走读工作台

ARC 是一个基于 Electron + React + TypeScript 的本地工程理解工作台，专注于**只对接 Codex** 的可追溯源码阅读体验：冻结本地源码快照、生成带源码行号依据的工程全貌与函数调用链、在选中对象上原位提问，并将问答、批注与阅读位置持久化保存在本机。

## 核心能力

- **工程全貌与功能目录**：打开工程后自动冻结只读源码快照，生成系统架构、组件关系与功能目录，并经独立源码复核；发现关系疑点时自动补查原冻结快照。
- **函数调用链与调用时间图**：按入口查看跨文件调用链与调用时间图；点选节点、关系或步骤可查看准确文件与行号，不猜测未知实现。
- **原位追问与预载依据**：在任意组件、函数、步骤或文件上直接提问（`reading-1`）。ARC 自动预载选中对象关联的冻结源码片段与整文件 SHA-256，结合精简推理默认设置减少等待时间；回答、纠错批注和阅读位置持久保存。
- **Codex 单通道接入**：
  - **Codex 直接执行**：通过已登录的官方 `codex-cli`（≥ `0.163.0`）以只读沙箱与严格隔离的冻结源码 MCP 执行分析。
  - **Codex 桌面会话 / MCP 派发**：在「连接 Agent」中绑定同目录 Codex 会话或登记 ARC MCP，由已连接的 Codex 对话领取任务并写回结果。
- **本地存储与向后兼容**：数据保存在 `%APPDATA%\Arc`（可用 `ARC_DATA_DIR` 指定独立目录），SQLite v2 完整兼容历史阅读记录与快照。

## 启动与开发

环境要求：Node.js 22+、Git（Windows 下 `start-desktop.cmd` 和 `npm test` 会自动回退查找标准安装的 Git for Windows），以及已安装并登录的官方 Codex CLI。

```powershell
# 安装依赖
npm ci

# 构建并启动桌面端（也可双击仓库根目录或上级目录的 启动Arc.cmd）
npm start
```

### 常用检查命令

```powershell
# 类型检查
npm run typecheck

# 生产构建（UI + 主进程 + preload + MCP 服务端）
npm run build

# 运行单元与集成测试（自动在 Windows 下补全 Git 路径）
npm test

# 按需打包 Windows 分发目录
npm run package
```

## 目录结构

- `src/main/` — Electron 主进程与核心服务：
  - `service.ts`：工作台核心门面（工程、快照、运行生命周期）
  - `reading-service.ts`：原位阅读追问服务
  - `overview-orchestrator.ts`：工程全貌初审、自动补查与子功能图编排
  - `walkthrough-refresh.ts`：开发后同功能走读刷新协调器
  - `project-io.ts`：演示工程、工程导出与手动结果导入
  - `providers.ts`：Codex CLI 能力探测、只读隔离参数、预检复用与执行通道
  - `reading-question.ts` / `prompt-context.ts`：预载冻结源码片段与上下文构建
  - `mcp-bridge.ts` / `external-dispatch.ts`：Codex MCP 桥接与会话派发
  - `engineering-service.ts` / `development-service.ts`：工程上下文与开发记录存储
- `src/ui/` — React 工作台界面：
  - `main.tsx`：工作台外壳与导航状态编排
  - `CatalogSidebar.tsx` / `CanvasPane.tsx` / `DetailPane.tsx`：三栏阅读视图
  - `SettingsModal.tsx` / `EntityFormModal.tsx` / `workbench-primitives.tsx`：设置弹窗、表单弹窗与基础组件
  - `Architecture.tsx` / `FunctionChain.tsx` / `FeatureReading.tsx` / `ReadingQuestions.tsx`：架构、调用链、走读与原位问答组件
- `contracts/` — 分析结果合同（`1.0`）与类型定义。
- `tests/` — 单元与集成测试套件。

## 边界说明

- ARC 负责冻结源码、校验路径/行号/SHA-256 哈希、持久化与展示；源码引用校验通过不等于业务语义已经人工验收或运行验证。
- 仅支持 Codex 作为活动执行通道；旧数据库中保存的历史其他 Provider 记录仍可只读浏览与回看，不会被清空或覆盖。
