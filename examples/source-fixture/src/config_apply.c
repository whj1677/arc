/* fictional=true：演示先应用 RAM，再尝试投递配置快照的 A 版本。 */
#include "config.h"
#include <stddef.h>

static device_config runtime_config = {1000, false};
static uint32_t ram_revision = 0;

config_apply_result config_apply(const device_config *requested)
{
    if (requested == NULL || requested->interval_ms == 0) {
        return (config_apply_result){false, false};
    }

    runtime_config = *requested;
    ram_revision += 1;
    const config_snapshot snapshot = {ram_revision, runtime_config};

    /* 队列满时不会撤销已经完成的 RAM 更新。 */
    const bool queued = try_queue_config(snapshot);
    return (config_apply_result){true, queued};
}
