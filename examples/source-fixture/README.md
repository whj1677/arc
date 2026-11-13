# Arc 虚构源码样例 A

`fictional=true`。本目录只用于验证源码锚点、走读关系、输入输出和分析缺口，不对应任何真实设备或用户工程。

## 已包含的逻辑

有效配置进入 `config_apply` 后先更新 RAM，再尝试放入单槽队列。队列已满时投递返回 `false`，RAM 更新仍保留。`handle_config_request` 只检查 `ram_applied`，因此这种情况下也回复 `ACK_OK`。

`storage_task_step` 在取得队列中的快照后调用 `config_write_record`。头文件仅声明这个存储函数，工程故意不包含实现，因此不能从此快照确认写入介质、错误处理、持久化成功或重启后的行为。

## 使用范围

- 这是 A 版本，未附带任何修复版本。
- 单槽队列用于确定性走读；源码没有实现真实 RTOS 的并发同步，不能据此声称线程安全或确定跨任务的全局时序。
- `storage_task_step` 返回 `true` 只表示本轮取出消息并发起存储调用，不能作为写入成功标记。
- C 文件可分别执行语法检查；完整链接因缺少 `config_write_record` 实现和应用入口而不作为本样例的通过条件。
- 相邻的 `source-snapshot.json` 记录 UTF-8 文件完整字节的 SHA-256，以及从 1 开始计算行范围时所需的行数。

## 语法检查示例

在本目录执行：

```sh
cc -std=c11 -Wall -Wextra -Werror -Iinclude -fsyntax-only src/protocol.c src/config_apply.c src/queue.c src/storage_task.c
```

任何文件修改都会改变对应哈希。分析结果的 `source_snapshot_id` 为 `snapshot-demo-a`，证据的文件路径相对于本目录。
