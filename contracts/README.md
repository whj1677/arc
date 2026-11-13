# Arc 初始合同与验证记录

## 合同范围

2026-10-22：函数节点可选 `function_details`，保存 `symbol`、可空的 `signature`、`definition_evidence_id`、可空的 `parameter_io_ids` 和 `return_io_ids`。精确定义必须由属于本节点且符号相同的 definition/declaration 证据支持；参数/返回引用只能指向本节点的输入/输出。`null` 表示未查明，`[]` 表示明确为空。未标记为返回值的输出单独展示，避免把持久化或参数更新误当 return。旧合同仍可导入，未知信息不自动补造。详见 [函数链验收](../docs/FUNCTION-CHAIN-20261022.md)。

`agent-adapter.ts` 与 `analysis-result.schema.json` 是 Arc 自有初始合同，用于启动实现和约束适配边界；不是供应商原生协议，也不是全产品数据模型。供应商是否原生支持结构化输出，通过能力探测记录；Arc 始终负责结果结构及源码锚点校验。

一次运行冻结 `project_id / feature_id / scenario_id / question_revision_id / source_snapshot_id / run_id`。供应商的 `external_provider_id / external_session_id / external_thread_id / external_task_id / external_run_id` 独立存放在 `provider` 中。结果的 `summary` 使用 `{text, claim_ids}`，使主结论也能回到具体断言。

执行上下文使用 `nodes[].execution_context` 明确表示类型、身份、标签与依据。`parent_node_id` 只表示图形聚合，`execution_episode_id` 表示被分析工程的执行轮次，均不能替代调用边或 Arc 的分析 `run_id`。本静态样例没有实际运行追踪，所以省略执行轮次，并把上下文分组标记为推断或未知。返回边可以通过 `related_call_edge_id` 对应方向相反的同步调用。

任务生命周期、问题覆盖、证据依据和源码新鲜度分别记录。`source_supported` 只说明当前陈述有来源依据，不能解释为全部产品语义已经证实。文件哈希必须取完整原始字节，不能先转码或改换行；提供的 C fixture 单独声明为 UTF-8、LF。

## 适配器闭环

- 产品身份未核验或授权状态不明时不能 `ready`，包括用户原称 `wordbuddy` 的候选产品。
- 受控读取使用 `read_artifact({run_ref, artifact_id, max_bytes, authorization_reference})`。供应商地址保留在适配器内部；宿主核对任务归属、权限与允许来源后读取，前端不能按任意 URL 请求产物。
- `max_bytes` 必须是正数，且受本次运行总输出上限约束；按解码后实际字节计算。超限返回明确错误，不能默默截断并标记为有效结果。
- 取消回执分为请求已发送与远端终止已确认；恢复原任务不等于重复提交。
- `submission_unknown` 表示任务可能已被接收，强制 `retryable=false`；先查询或恢复对账，不能按一般网络重试策略自动重发。
- 只读作用于被分析工程范围，不能只凭提示词宣称保护已落实。供应商原有规则、工作区权限和授权边界仍须由宿主执行。能力不支持时返回明确 `unsupported`，不以启动程序或演示事件冒充完成接入。

## 本次已执行的检查

| 检查 | 结果 |
|---|---|
| JSON Schema 自身符合 Draft 2020-12 | 通过，使用 jsonschema 4.26.0 |
| `analysis-result.json` 符合结果 Schema | 通过 |
| 请求与结果六项绑定、Provider 与演示身份 | 通过 |
| 节点、关系、断言、证据、输入输出与缺口 ID 的唯一性及引用 | 通过 |
| 6 个 fixture 文件的完整 SHA-256 与行数 | 通过 |
| 15 个证据的快照、路径、行范围及 fixture 符号范围 | 通过 |
| 父节点存在性、父子循环、3 组调用/返回方向 | 通过 |
| TypeScript 合同严格检查，无输出文件 | 通过，使用 TypeScript 7.0.2 |
| 请求/结果样例字面量与 TypeScript 合同一致 | 通过 |
| 三条类型反例：未核验即 ready、请求取消即确认终止、不确定提交自动重试 | 均被正确拒绝 |
| 4 个 C 文件的 C11 严格语法检查 | 通过 |

结果样例含 11 个节点、14 条关系、12 条断言、15 个证据和 3 个明确缺口。`config_write_record` 的实现和应用入口故意缺失，不以完整链接通过作为验收条件。检查范围为合同结构、来源锚点和极小 fixture；没有执行真实 App 或供应商接入联调，也不构成全局语义证明。

## 在开发环境重跑

开发环境具备 Python 3.10+ 及 `jsonschema` 包、TypeScript 编译器与 C 编译器后，在交付包根目录执行：

```sh
python examples/validate_examples.py

tsc --strict --noEmit --target ES2022 --module ESNext --moduleResolution bundler contracts/agent-adapter.ts

cc -std=c11 -Wall -Wextra -Werror -Iexamples/source-fixture/include -fsyntax-only examples/source-fixture/src/protocol.c examples/source-fixture/src/config_apply.c examples/source-fixture/src/queue.c examples/source-fixture/src/storage_task.c
```

`validate_examples.py` 不修改文件。它先执行标准 Schema 校验，再执行跨对象引用与源码锚点校验；两部分不能互相替代。符号范围验证针对所附极小 C fixture，正式工程仍需合适的语言解析和符号解析实现。

本次临时环境另生成样例字面量的 TypeScript `satisfies` 检查及三条 `@ts-expect-error` 反例；这些检查已实际通过，未将临时依赖目录放入交付包。

## 系统架构视图（2026-10-20，向后兼容）

结果可增加 `architecture: {node_ids: [...], edge_ids: [...]}`，引用同一结果中的高层组件与组件间连接。组件允许 stage、resource、execution_boundary；内部函数和条件不得直接冒充系统组件。架构边的两端必须都在组件列表内。原有源码锚点、断言和绑定校验继续生效。

节点标签表达实际技术组成，例如“前端 / JavaScript”“后端 / Python”；关系标签表达有源码支持的通信或数据访问方式，例如“HTTP / JSON”“SQL / sqlite3”。未知协议明确写未知，不按文件夹名猜数据库或部署方式。数组顺序只用于布局，不能证明请求执行顺序。组件内部仍使用 `parent_node_id` 关联，库依赖不冒充外部网络服务。

缺少 architecture 的旧结果保持合法。界面显示“这份结果还没有系统架构”，可继续查阅既有模块说明；不会将旧调用图或预置三层图当成新架构分析。


业务时间线补充：control_flow 可用 `flow_role: main | alternative | exception`。新功能结果应显式标注；main 必须连续、无环、无分叉。错误响应也可有真实 transfers，但不因此成为正常主线。旧合同结果仍可读取，未标注的历史结果不自动获得语义角色。
