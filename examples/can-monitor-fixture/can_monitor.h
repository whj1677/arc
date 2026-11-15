#ifndef CAN_MONITOR_H
#define CAN_MONITOR_H

typedef struct {
  unsigned long id;
  unsigned char dlc;
} CanFrame;

typedef struct {
  unsigned long last_valid_ms;
  unsigned long offline_threshold_ms;
  int online;
} CanMonitor;

void monitor_init(CanMonitor *monitor);
void receive_frame(CanMonitor *monitor, CanFrame frame, unsigned long now_ms);
void monitor_tick(CanMonitor *monitor, unsigned long now_ms);

#endif
