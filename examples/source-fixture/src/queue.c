/* fictional=true：单槽队列用于走读，不包含 RTOS 并发同步。 */
#include "config.h"
#include <stddef.h>

static bool slot_full = false;
static config_snapshot pending_snapshot;

bool try_queue_config(config_snapshot snapshot)
{
    if (slot_full) {
        return false;
    }
    pending_snapshot = snapshot;
    slot_full = true;
    return true;
}

bool queue_receive_config(config_snapshot *snapshot)
{
    if (!slot_full || snapshot == NULL) {
        return false;
    }
    *snapshot = pending_snapshot;
    slot_full = false;
    return true;
}
