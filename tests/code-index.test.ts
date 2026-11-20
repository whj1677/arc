import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getCodeIndex} from '../src/main/code-index';
import {ArcService} from '../src/main/service';
import {capture} from '../src/main/snapshot';

test('indexes seven grammars from frozen files and resolves call sites to definitions',async t=>{
  const base = path.resolve('.test-data');
  await fs.mkdir(base,{recursive:true});
  const dir = await fs.mkdtemp(path.join(base,'code-index-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root = path.join(dir,'工程'), storage = path.join(dir,'arc');
  const sources:Record<string,string> = {
    'c/reader.c':'int read_value(void);\nint run_c(void) { return read_value(); }',
    'driver/read.c':'int read_value(void) { return 2; }',
    'cpp/engine.h':'namespace app { int public_api(); struct Engine { Engine(); ~Engine(); int read(); int &run(); }; }',
    'cpp/engine.cpp':'namespace app {\nEngine::Engine() {}\nEngine::~Engine() {}\nint Engine::read() { return 2; }\nint &Engine::run() { return this->read(); }\n}\nstatic int hot(){return 1;}\nint app::public_api(){return hot()+hot()+hot();}',
    'app/main.cpp':'int main() { return app::Engine::read(); }',
    'py/task.py':'class Worker:\n def read(self): return 1\n def run(self): return self.read()',
    'js/task.jsx':'class Worker { read() { return 1 } run() { return this.read() } }',
    'ts/task.mts':'interface Reader { read():number }\nexport function getValue() { return 1 }',
    'ts/view.tsx':"import * as task from './task.mjs'; const View = () => <div>{task.getValue()}</div>;",
    'java/Task.java':'package tools;\ninterface Reader { int read(); }\nclass Task { Task() {} int read(){return 1;} int run(){return this.read();} }',
    'ignored.md':'Read me',
  };
  for (const [file,source] of Object.entries(sources)) {
    const target = path.join(root,file);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,source);
  }
  const snapshot = await capture(root,'test',storage,'');
  await fs.writeFile(path.join(root,'c/reader.c'),'int changed_after_capture;');
  const index = await getCodeIndex(storage,snapshot);
  assert.deepEqual(index.parse_errors,[]);
  assert.equal(index.files.length,10);
  assert.deepEqual(new Set(index.symbols.map(s=>s.language)),new Set(['c','cpp','python','javascript','typescript','tsx','java']));
  for (const [file,caller,targetFile,target,line] of [
    ['c/reader.c','run_c','driver/read.c','read_value',2],
    ['cpp/engine.cpp','app::Engine::run','cpp/engine.cpp','app::Engine::read',5],
    ['app/main.cpp','main','cpp/engine.cpp','app::Engine::read',1],
    ['py/task.py','Worker.run','py/task.py','Worker.read',3],
    ['js/task.jsx','Worker.run','js/task.jsx','Worker.read',1],
    ['ts/view.tsx','View','ts/task.mts','getValue',1],
    ['java/Task.java','tools.Task.run','java/Task.java','tools.Task.read',3],
  ] as const) {
    const symbol = index.symbols.find(s=>s.file===file && s.qualified_name===caller);
    const callee = index.symbols.find(s=>s.file===targetFile && s.qualified_name===target);
    assert.ok(symbol && callee,caller+' -> '+target);
    assert.deepEqual(index.calls.find(c=>c.caller_id===symbol.id && c.line===line)?.target_ids,[callee.id],caller);
  }
  for (const [qualified,kind] of [['app::Engine','struct'],['app::Engine::Engine','constructor'],['app::Engine::~Engine','destructor'],['tools.Task','class'],['tools.Reader','interface']]) {
    assert.ok(index.symbols.some(s=>s.qualified_name===qualified && s.kind===kind),qualified);
  }
  assert.deepEqual(index.module_edges.filter(e=>e.from==='app'),[{from:'app',to:'cpp',count:1}]);
  const module = index.modules.find(m=>m.dir==='cpp')!;
  assert.ok(module.symbol_count > 2 && module.files.includes('cpp/engine.h') && module.key_symbols.length);
  const keys = module.key_symbols.map(id=>index.symbols.find(s=>s.id===id)!);
  assert.equal(keys.filter(s=>s.qualified_name==='app::public_api').length,1);
  assert.ok(keys.findIndex(s=>s.qualified_name==='app::public_api') < keys.findIndex(s=>s.name==='hot'));
  assert.ok(keys.some(s=>s.qualified_name==='app::public_api' && s.kind==='function' && s.has_body));
  assert.deepEqual((await fs.readdir(path.join(storage,'snapshots',snapshot.source_snapshot_id))).sort(),['app','c','cpp','driver','ignored.md','java','js','py','ts']);
  const cache = path.join(storage,'indexes',snapshot.source_snapshot_id+'.json');
  assert.deepEqual(JSON.parse(await fs.readFile(cache,'utf8')),index);
  const service = new ArcService(storage, process.cwd());
  try {
    service.store.put('snapshot', snapshot.source_snapshot_id, snapshot);
    const [summary, concurrent] = await Promise.all([
      service.codeIndexSummary(snapshot.source_snapshot_id), service.codeIndexSummary(snapshot.source_snapshot_id),
    ]);
    assert.strictEqual(summary, concurrent);
    assert.strictEqual(await service.codeIndexSummary(snapshot.source_snapshot_id), summary);
    assert.deepEqual([summary.total_files, summary.total_symbols, summary.total_calls], [10, index.symbols.length, index.calls.length]);
    assert.deepEqual(summary.modules.find(m => m.dir === 'cpp'), {
      dir: 'cpp', files: module.files, file_count: 2, symbol_count: module.symbol_count, key_symbols: keys.map(s => s.qualified_name),
    });
    assert.deepEqual(summary.module_edges.filter(e => e.from === 'app'), [{from: 'app', to: 'cpp', count: 1}]);
    await assert.rejects(service.codeIndexSummary('missing'), /未找到 snapshot/);
    // A failed read for a new fingerprint must be retried once its frozen source is available.
    service.store.put('snapshot', snapshot.source_snapshot_id, {...snapshot, fingerprint: 'refreshed'});
    const frozen = path.join(storage, 'snapshots', snapshot.source_snapshot_id, 'c/reader.c');
    await fs.rename(frozen, frozen + '.held');
    try { await assert.rejects(service.codeIndexSummary(snapshot.source_snapshot_id)); }
    finally { await fs.rename(frozen + '.held', frozen); }
    assert.deepEqual(await service.codeIndexSummary(snapshot.source_snapshot_id), summary);
  } finally { service.store.db.close(); }
  await fs.writeFile(cache,JSON.stringify({...index,schema_version:0,symbols:[]}));
  assert.deepEqual(await getCodeIndex(storage,snapshot),index);
});
