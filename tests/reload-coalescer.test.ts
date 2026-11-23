import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReloadCoalescer } from '../src/ui/reload-coalescer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('bursts schedule one request and one trailing request without overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred<number>();
  const second = deferred<number>();
  const requests = [first, second];
  let calls = 0;
  let active = 0;
  const loader = createReloadCoalescer(async () => {
    assert.equal(active, 0);
    active++;
    try { return await requests[calls++].promise; }
    finally { active--; }
  }, 150, assert.ifError);

  for (let i = 0; i < 50; i++) loader.schedule();
  t.mock.timers.tick(149);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);

  for (let i = 0; i < 50; i++) loader.schedule();
  t.mock.timers.tick(300);
  assert.equal(calls, 1);
  first.resolve(1);
  await first.promise;
  await Promise.resolve();
  t.mock.timers.tick(150);
  assert.equal(calls, 2);
  second.resolve(2);
  await second.promise;
  await Promise.resolve();
  t.mock.timers.tick(300);
  assert.equal(calls, 2);
});

test('explicit reloads during a request share the fresh trailing result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred<string>();
  const load = t.mock.fn(() => Promise.resolve('fresh'));
  load.mock.mockImplementationOnce(() => first.promise);
  const loader = createReloadCoalescer(load, 150, assert.ifError);

  loader.schedule();
  const initial = loader.reload();
  assert.equal(load.mock.callCount(), 1);
  loader.schedule();
  const pending = loader.reload();
  assert.equal(loader.reload(), pending);
  t.mock.timers.tick(300);
  assert.equal(load.mock.callCount(), 1);

  first.resolve('previous');
  assert.equal(await initial, 'previous');
  assert.equal(await pending, 'fresh');
  t.mock.timers.tick(300);
  assert.equal(load.mock.callCount(), 2);
});

test('a failed scheduled request still runs its trailing refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred<number>();
  const load = t.mock.fn(() => Promise.resolve(2));
  load.mock.mockImplementationOnce(() => first.promise);
  const reported = deferred<unknown>();
  const loader = createReloadCoalescer(load, 250, reported.resolve);

  loader.schedule();
  t.mock.timers.tick(250);
  loader.schedule();
  const error = Error('IPC failed');
  first.reject(error);
  assert.equal(await reported.promise, error);
  t.mock.timers.tick(250);
  assert.equal(load.mock.callCount(), 2);
});

test('cleanup cancels a scheduled timer and a pending trailing refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = deferred<number>();
  const load = t.mock.fn(() => request.promise);
  const loader = createReloadCoalescer(load, 250, assert.ifError);

  loader.schedule();
  loader.cancelScheduled();
  t.mock.timers.tick(250);
  assert.equal(load.mock.callCount(), 0);

  const inFlight = loader.reload();
  loader.schedule();
  loader.cancelScheduled();
  request.resolve(1);
  assert.equal(await inFlight, 1);
  t.mock.timers.tick(250);
  assert.equal(load.mock.callCount(), 1);
});
