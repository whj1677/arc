#include "can_monitor.h"
#include "can_monitor.c"
#include <stdio.h>

static int failures = 0;
static void check(int condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "BEHAVIOR_ASSERTION_FAILED: %s\n", message);
    failures++;
  }
}

int main(void) {
  CanMonitor monitor;
  CanFrame valid = {0x21UL, 2};
  CanFrame bad_id = {0x20UL, 2};
  CanFrame bad_length = {0x21UL, 1};
  unsigned long times[] = {200, 350, 500, 650, 800};
  unsigned long index;

  monitor_init(&monitor);
  check(monitor.offline_threshold_ms == 500, "original threshold changed");
  receive_frame(&monitor, valid, 100);
  check(monitor.online == 1, "valid frame must bring node online");
  for (index = 0; index < sizeof(times) / sizeof(times[0]); index++) {
    receive_frame(&monitor, index % 2 ? bad_length : bad_id, times[index]);
    monitor_tick(&monitor, times[index]);
  }
  check(monitor.last_valid_ms == 100, "invalid frame refreshed online timing");
  check(monitor.online == 0, "invalid frames kept node online beyond original threshold");

  receive_frame(&monitor, valid, 900);
  check(monitor.online == 1, "original recovery rule changed");
  monitor_tick(&monitor, 1400);
  check(monitor.online == 1, "threshold comparison must remain strict greater-than");
  monitor_tick(&monitor, 1401);
  check(monitor.online == 0, "node did not go offline after original threshold");
  receive_frame(&monitor, bad_id, 1500);
  check(monitor.online == 0, "invalid frame changed the original offline recovery rule");
  check(monitor.last_valid_ms == 900, "invalid frame refreshed timing after recovery");

  if (failures) return 1;
  printf("CAN_BEHAVIOR_OK: invalid timing, timeout boundary and recovery assertions passed\n");
  return 0;
}
