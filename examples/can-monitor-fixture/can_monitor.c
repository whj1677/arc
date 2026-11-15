#include "can_monitor.h"

static int valid_frame(CanFrame frame) {
  return frame.id == 0x21UL && frame.dlc == 2;
}

void monitor_init(CanMonitor *monitor) {
  monitor->last_valid_ms = 0;
  monitor->offline_threshold_ms = 500;
  monitor->online = 0;
}

void receive_frame(CanMonitor *monitor, CanFrame frame, unsigned long now_ms) {
  if (!valid_frame(frame)) {
    monitor->last_valid_ms = now_ms;
    return;
  }
  monitor->last_valid_ms = now_ms;
  monitor->online = 1;
}

void monitor_tick(CanMonitor *monitor, unsigned long now_ms) {
  if (monitor->online && now_ms - monitor->last_valid_ms > monitor->offline_threshold_ms) {
    monitor->online = 0;
  }
}
