export function createReloadCoalescer<T>(load: () => Promise<T>, delay: number, onError: (error: unknown) => void) {
  let inFlight: Promise<T> | undefined;
  let next: Promise<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;

  function cancelScheduled() {
    clearTimeout(timer);
    timer = undefined;
    scheduled = false;
  }

  function armTimer() {
    timer = setTimeout(() => { void reload().catch(onError); }, delay);
  }

  function start() {
    cancelScheduled();
    next = undefined;
    inFlight = load().finally(() => {
      inFlight = undefined;
      if (scheduled && !next) armTimer();
    });
    return inFlight;
  }

  function reload(): Promise<T> {
    if (next) return next;
    if (!inFlight) return start();
    // A request already in flight may have read data before the caller's mutation.
    next = inFlight.then(start, start);
    return next;
  }

  function schedule() {
    if (scheduled || next) return;
    scheduled = true;
    if (!inFlight) armTimer();
  }

  return { reload, schedule, cancelScheduled };
}
