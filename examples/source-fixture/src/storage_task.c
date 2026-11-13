/* fictional=true：单步模拟存储任务；调度周期由外部环境决定。 */
#include "config.h"

bool storage_task_step(void)
{
    config_snapshot snapshot;
    if (!queue_receive_config(&snapshot)) {
        return false;
    }

    /* 具体实现未包含在快照中；调用发生不代表持久化已经成功。 */
    config_write_record(&snapshot);
    return true;
}
