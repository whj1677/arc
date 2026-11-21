import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getCodeIndex,type CodeIndex} from '../src/main/code-index';
import {getCallGraph,listModules} from '../src/main/code-index-query';
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
  await fs.writeFile(cache,JSON.stringify({...index,schema_version:3,symbols:[]}));
  assert.deepEqual(await getCodeIndex(storage,snapshot),index);
});

test('indexes callback registration sites and unique shared objects across C/C++ modules',async t=>{
  const base = path.resolve('.test-data');
  await fs.mkdir(base,{recursive:true});
  const dir = await fs.mkdtemp(path.join(base,'index-registration-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root = path.join(dir,'src'), storage = path.join(dir,'arc');
  const sources:Record<string,string> = {
    'core/state.c': 'struct Data { int current; };\nstruct Data g_state __attribute__((section("STATE")));\nint single_dir;\nint isolated;\nstatic int private_state;\nvoid update(void){g_state.current=1; single_dir++; private_state++; isolated++;}',
    'logic/worker.c': 'void tick(void) {}\nstatic void private_tick(void) {}',
    'overload/handlers.cpp': 'void notify(int) {}\nvoid notify(double) {}\nvoid (*handler)(int) = &notify;',
    'board/table.c': 'typedef void (*Task)(void);\nextern void tick(void);\nstatic struct Ops { Task handler; } ops[] = {{.handler = tick}};\nvoid configure(void){ Task handler = &tick; register_task(tick); tick(); }',
    'bus/read.c': 'extern struct Data g_state; extern int shared_sensor;\nint read_it(void){return g_state.current + shared_sensor;}',
    'noise/local.c': '#define FAKE_GLOBAL g_state\nvoid consume(int g_state, void (*tick)(void)){\n register_task(tick); tick(); g_state++; /* g_state, tick */\n { int isolated; isolated++; }\n use("g_state", private_tick, private_state);\n}',
    'api/sensor.h': 'extern int shared_sensor;\nextern int declaration_only;',
    'noise/extern.c': 'extern int single_dir; extern struct Data g_state; extern int declaration_only;',
    'device/core.cpp': 'namespace bus { struct Device { static void work(); void close(); }; void Device::work(){} void Device::close(){} int queue; void poll(){queue++;} }\nnamespace other { void work(){} }\nconstexpr int REG_COUNT=4; const int codes[]={1}; const volatile int status=0; int *const current=&bus::queue;\nvoid inspect(){use(REG_COUNT,codes,status,*current);}',
    'host/main.cpp': 'void start(){\n register_handler(&bus::Device::work); register_handler(&absent::work); bus::queue++; use(REG_COUNT,codes,status,*current,shared_sensor); close(42);\n}',
  };
  for (const [file,text] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});
    await fs.writeFile(path.join(root,file),text);
  }
  const snapshot = await capture(root,'registration',storage,'');
  const index = await getCodeIndex(storage,snapshot);
  assert.equal(index.schema_version,4);
  const graph = (symbol:string)=>getCallGraph(index,{symbol,direction:'outgoing',depth:1});
  assert.deepEqual(graph('handler').edges.map(e=>[e.syntax,e.callee_name,e.line,e.targets]),[['reference','notify',3,[]]]);
  assert.deepEqual(graph('ops').edges.map(e=>[e.line,e.syntax,e.targets[0]?.signature]),[[3,'reference','void tick(void)']]);
  assert.equal(index.symbols.find(s=>s.name === 'ops')?.kind,'initializer');
  assert.equal(graph('configure').roots[0].signature,'void configure(void)');
  assert.deepEqual(graph('configure').edges.filter(e=>e.callee_name === 'tick').map(e=>e.syntax).sort(),['direct','reference','reference']);
  assert.equal(getCallGraph(index,{symbol:'tick',direction:'incoming',depth:1}).edges.filter(e=>e.syntax==='reference').length,3);
  assert.deepEqual(graph('start').edges.filter(e=>e.syntax==='reference').map(e=>e.targets[0]?.qualified_name),['bus::Device::work']);
  assert.deepEqual(graph('start').edges.find(e=>e.callee_name==='close' && e.syntax==='direct')?.targets,[]);
  assert.ok(!index.calls.some(c=>c.syntax === 'reference' && c.file === 'noise/local.c'));
  const shadowCall = graph('consume').edges.find(e=>e.callee_name==='tick');
  assert.equal(shadowCall?.syntax,'indirect');
  assert.deepEqual(shadowCall.targets,[]);
  assert.deepEqual(index.module_edges.filter(e=>e.from === 'board'),[{from:'board',to:'logic',count:4}]);
  assert.deepEqual(listModules(index,{}).shared_states,[
    {name:'bus::queue',file:'device/core.cpp',line:1,access_dirs:['device','host']},
    {name:'current',file:'device/core.cpp',line:3,access_dirs:['device','host']},
    {name:'g_state',file:'core/state.c',line:2,access_dirs:['bus','core']},
    {name:'shared_sensor',file:'api/sensor.h',line:1,location_kind:'extern_declaration',access_dirs:['bus','host']},
    {name:'status',file:'device/core.cpp',line:3,access_dirs:['device','host']},
  ]);
  assert.deepEqual(listModules(index,{dir:'core'}).shared_states.map(s=>s.name),['g_state']);
});

async function indexFixture(t:TestContext, sources:Record<string,string>) {
  const base = path.resolve('.test-data');
  await fs.mkdir(base,{recursive:true});
  const dir = await fs.mkdtemp(path.join(base,'code-index-scope-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root = path.join(dir,'src'), storage = path.join(dir,'arc');
  for (const [file,text] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});
    await fs.writeFile(path.join(root,file),text);
  }
  return getCodeIndex(storage,await capture(root,'scope',storage,''));
}

test('symbol and initializer end lines stay within files with a trailing newline',async t=>{
  const index = await indexFixture(t,{
    'partial.c':'int eof(void) {\n #define MACRO 1\n',
    'table.c':'void tick(void) {}\nvoid (*handlers[])(void) = {\n  tick\n};\n',
  });
  assert.equal(index.symbols.find(s=>s.name==='eof')?.end_line,2);
  assert.equal(index.symbols.find(s=>s.kind==='initializer' && s.name==='handlers')?.end_line,4);
});

test('indexes modern TypeScript and TSX without parse errors',async t=>{
  const index = await indexFixture(t,{
    'modern.ts':'export class Resource { accessor counter: number = 0; }\nexport function choose<const T>(value: T): T { return value; }\n',
    'view.tsx':'export const View = <const T,>({ value }: { value: T }) => <div>{String(value)}</div>;\n',
  });
  assert.deepEqual(index.parse_errors,[]);
  assert.deepEqual(index.symbols.map(s=>s.name),['Resource','choose','View']);
});

test('a C99 static array parameter preserves external linkage and a public prototype',async t=>{
  const index = await indexFixture(t,{
    'api/read.h': 'int load(int values[static 4]);\nstatic int local_api(void);',
    'impl/read.c': 'int load(int values[static 4]) { return values[0]; }\nstatic int private_api(void) { return 0; }',
    'app/run.c': 'int run(int *input) { return load(input) + private_api(); }',
  });
  const prototype = index.symbols.find(s=>s.file==='api/read.h' && s.name==='load');
  assert.equal(prototype?.public_entry,true);
  assert.equal(index.symbols.find(s=>s.name==='local_api')?.public_entry,false);
  const edges = getCallGraph(index,{symbol:'run',direction:'outgoing',depth:1}).edges;
  assert.deepEqual(edges.map(e=>[e.callee_name,e.targets.map(s=>s.file)]),[['load',['impl/read.c']],['private_api',[]]]);
});

test('C++ condition and range bindings shadow calls only within their scopes',async t=>{
  const index = await indexFixture(t,{'app/loops.cpp':[
    'using Action = void (*)();',
    'struct Actions { Action* begin(); Action* end(); };',
    'Actions tick() { return {}; }',
    'Action callback();',
    'int read(); void use(int);',
    'void run() {',
    '  if (auto tick = callback()) tick(); else tick();',
    '  tick();',
    '  while (auto tick = callback()) tick();',
    '  tick();',
    '  switch (int tick = read()) { default: use(tick); }',
    '  tick();',
    '  for (auto tick : tick()) tick();',
    '  tick();',
    '}',
  ].join('\n')});
  assert.deepEqual(index.parse_errors,[]);
  const edges = getCallGraph(index,{symbol:'run',direction:'outgoing',depth:1}).edges.filter(e=>e.callee_name==='tick');
  assert.deepEqual(edges.map(e=>[e.line,e.syntax,e.targets[0]?.qualified_name]),[
    [7,'indirect',undefined],[7,'indirect',undefined],[8,'direct','tick'],[9,'indirect',undefined],
    [10,'direct','tick'],[12,'direct','tick'],[13,'direct','tick'],[13,'indirect',undefined],[14,'direct','tick'],
  ]);
});

test('C++ direct calls honor a visible using declaration from its lexical owner',async t=>{
  const index = await indexFixture(t,{
    'app/call.cpp':[
      'namespace api { void tick(); void ping(); void notify(int); void notify(double); }',
      'void tick();',
      'using api::ping;',
      'namespace client {',
      '  namespace api { void ping() {} }',
      '  void run() {',
      '    ping(); tick();',
      '    { using ::api::tick; tick(); }',
      '    tick();',
      '    { auto ping = &::api::ping; ping(); }',
      '    using ::api::notify; notify(1);',
      '  }',
      '}',
      'void explicit_global() { using ::api::tick; ::tick(); }',
      'namespace reopened { using ::api::tick; void outside(); }',
      'namespace reopened { void run() { tick(); } }',
      'void reopened::outside() { tick(); }',
      'namespace local { void ping() {} void run() { ping(); } }',
    ].join('\n'),
    'lib/api.cpp':'namespace api { void tick() {} void ping() {} void notify(int) {} void notify(double) {} }\nvoid tick() {}',
  });
  assert.deepEqual(index.parse_errors,[]);
  const edges = getCallGraph(index,{symbol:'client::run',direction:'outgoing',depth:1}).edges.filter(e=>e.syntax!=='reference');
  assert.deepEqual(edges.map(e=>[e.line,e.syntax,e.callee_name,e.targets.map(s=>[s.qualified_name,s.file])]),[
    [7,'direct','ping',[['api::ping','lib/api.cpp']]],[7,'direct','tick',[['tick','lib/api.cpp']]],
    [8,'direct','tick',[['api::tick','lib/api.cpp']]],[9,'direct','tick',[['tick','lib/api.cpp']]],
    [10,'indirect','ping',[]],[11,'direct','notify',[]],
  ]);
  for (const [caller,target,syntax] of [
    ['explicit_global','tick','scoped'], ['reopened::run','api::tick','direct'],
    ['reopened::outside','api::tick','direct'], ['local::run','local::ping','direct'],
  ]) {
    const graph = getCallGraph(index,{symbol:caller,direction:'outgoing',depth:1});
    assert.deepEqual(graph.edges.map(edge=>[edge.targets[0]?.qualified_name,edge.syntax]),[[target,syntax]],caller);
  }
});

test('C++ member fields do not count as global access in inline or out-of-line methods',async t=>{
  const index = await indexFixture(t,{
    'globals/state.cpp':'int in_class, out_of_class, explicit_access;\nvoid origin() { in_class++; out_of_class++; explicit_access++; }',
    'app/read.cpp': 'namespace app { struct Reader {\n#ifdef ENABLE_READER\nint in_class;\nvoid read() { in_class++; }\n#endif\n}; }',
    'app/update.cpp': 'namespace app { void Writer::update() { out_of_class++; explicit_access++; ::explicit_access++; } }',
    'types/writer.hpp':'namespace app { struct Writer { void update(); int out_of_class, explicit_access; }; }',
  });
  assert.deepEqual(index.parse_errors,[]);
  assert.deepEqual(index.shared_states,[{name:'explicit_access',file:'globals/state.cpp',line:1,access_dirs:['app','globals']}]);
});

test('shared states match filtered module pages and support independent slices',()=>{
  const dirs = ['.','feature','feature/io','other'];
  const files = ['main.c','feature/run.c','feature/io/port.c','other/state.c'];
  const rootStates = Array.from({length:17},(_,i)=>({name:`root${i}`,file:files[0],line:i+1,access_dirs:['.','other']}));
  const state = {name:'io',file:files[3],line:1,access_dirs:['feature/io','other']};
  const index:CodeIndex = {schema_version:4,snapshot_id:'s',fingerprint:'f',files,symbols:[],calls:[],module_edges:[],parse_errors:[],
    modules:dirs.map((dir,i)=>({dir,files:[files[i]],symbol_count:0,key_symbols:[]})),shared_states:[...rootStates,state]};
  const first = listModules(index,{limit:1});
  assert.equal(first.shared_state_count,17);
  assert.deepEqual(first.shared_states,rootStates.slice(0,16));
  assert.deepEqual(listModules(index,{limit:1,shared_state_offset:16,shared_state_limit:1}).shared_states,rootStates.slice(16));
  const parent = listModules(index,{dir:'feature/',limit:1});
  assert.deepEqual([parent.modules[0].dir,parent.shared_state_count,parent.shared_states],['feature',0,[]]);
  const child = listModules(index,{dir:'feature/',limit:1,offset:parent.next_offset!});
  assert.deepEqual([child.modules[0].dir,child.shared_state_count,child.shared_states],['feature/io',1,[state]]);
  assert.deepEqual(listModules(index,{offset:4}).shared_states,[]);
});
