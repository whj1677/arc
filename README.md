# Arc

Arc 是本地工程理解工作台，索引本地源码并通过 MCP 与已授权的 Agent 协作，分析结果保存在本机。

开发版：Node.js 22+、Windows；执行 npm ci、npm run typecheck、npm start。npm run package 构建 Windows 目录发行件。Agent 需单独安装和授权；源码会按所选 Agent 的数据处理方式提供给模型。

快照按文件哈希校验一致性，分析依据仍需要人工核对。应用数据位于 %APPDATA%\Arc。未完成跨机、全部 Agent 和正式发布验收。

测试：npm test 包含依赖原始私有工程验收数据的历史用例；这些数据未公开，因此完整测试不能在公开仓库直接运行。可执行不依赖私有数据的测试，例如 npx tsx --test tests/core.test.ts。

