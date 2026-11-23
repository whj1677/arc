import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ArcService } from '../src/main/service';
import type { Run } from '../src/shared';

test('streaming events update the run and emit changed only when the thread ID changes', async t => {
  const scratch = path.resolve('.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'run-events-'));
  const emitted: unknown[] = [];
  const service = new ArcService(directory, path.resolve('.'), event => emitted.push(event));
  t.after(async () => {
    await service.shutdown();
    service.store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const runId = 'streaming-run';
  const run: Run = {
    binding: {
      run_id: runId, project_id: 'project', feature_id: 'feature', scenario_id: 'scenario',
      question_revision_id: 'question', source_snapshot_id: 'snapshot',
    },
    provider_id: 'codex', status: 'running', created_at: new Date().toISOString(),
    question: 'How does it run?', title: 'Run log', submission_key: 'submit', output_path: 'result.json',
  };
  service.store.put('run', runId, run);
  const writes = t.mock.method(service.store, 'put');

  const events = [
    { type: 'item.updated', text: 'streaming' },
    { type: 'thread.started', thread_id: 'first-thread' },
    { type: 'item.completed', thread_id: 'first-thread' },
    { type: 'thread.started', thread_id: 'next-thread' },
  ];
  for (const event of events) service.event(runId, event);

  assert.deepEqual(writes.mock.calls.map(call => call.arguments.slice(0, 2)), [['run', runId], ['run', runId]]);
  assert.equal(service.store.get<Run>('run', runId).external_id, 'next-thread');
  assert.deepEqual(service.store.events(runId).map(event => event.type), events.map(event => event.type));
  assert.deepEqual(emitted, events.flatMap((event, index) => [
    ...(index === 1 || index === 3 ? [{ type: 'changed' }] : []),
    { type: 'run_event', run_id: runId, event },
  ]));
});
