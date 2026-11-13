/* fictional=true：演示配置请求处理；A 版本故意保留确认语义缺口。 */
#include "config.h"

config_ack handle_config_request(const device_config *requested)
{
    const config_apply_result result = config_apply(requested);

    /* A 版本仅依据 RAM 是否生效回复，没有检查 result.queued。 */
    if (result.ram_applied) {
        return ACK_OK;
    }
    return ACK_REJECTED;
}
