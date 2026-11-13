/* fictional=true：Arc 演示工程 A 版本，不对应任何真实设备。 */
#ifndef ARC_DEMO_CONFIG_H
#define ARC_DEMO_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint16_t interval_ms;
    bool enabled;
} device_config;

typedef struct {
    uint32_t revision;
    device_config config;
} config_snapshot;

typedef struct {
    bool ram_applied;
    bool queued;
} config_apply_result;

typedef enum {
    ACK_OK,
    ACK_REJECTED
} config_ack;

config_apply_result config_apply(const device_config *requested);
config_ack handle_config_request(const device_config *requested);

/* 单槽演示队列；传入值会被复制，不保留调用方栈地址。 */
bool try_queue_config(config_snapshot snapshot);
bool queue_receive_config(config_snapshot *snapshot);

/* 返回值仅说明本轮取得了消息并发起存储调用。 */
bool storage_task_step(void);

/* 故意只有声明：缺少具体存储实现，不能据此确认持久化成功。 */
void config_write_record(const config_snapshot *snapshot);

#endif
