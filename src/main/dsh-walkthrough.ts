import type {Snapshot, SourceEvidence} from '../shared';
import {parseProviderText} from './dsh';
import {readSource} from './snapshot';

export const dshWalkthroughReviewSummary='DeepSeek Harness 已在第二回合按冻结源码复核走读中的调用顺序与分支条件。';

export async function makeDshWalkthroughReview(draft:string,snapshot:Snapshot,storage:string,changedPaths:readonly string[]){
  let evidence:Partial<SourceEvidence>[]=[];
  try {
    const value=parseProviderText(draft,'dsh');
    if(Array.isArray(value?.evidence))evidence=value.evidence.filter((item:unknown)=>item&&typeof item==='object');
  } catch (error) {
    if(!(error instanceof SyntaxError))throw error;
  }

  const changed=new Set(changedPaths);
  const available=new Set(snapshot.files.map(file=>file.path));
  const paths=[...new Set([
    ...[...changed].filter(path=>available.has(path)).slice(0,8),
    ...[...new Set(evidence.map(item=>item.path).filter((path):path is string=>
      typeof path==='string'&&available.has(path)&&!changed.has(path)))].slice(0,2),
  ])];
  const excerpts=[];
  let remaining=24000;
  for(const path of paths){
    const file=await readSource(storage,snapshot,path);
    const lines=file.text.split(/\r\n|\n|\r/);
    const ranges=lines.length<=160?[[1,lines.length]]:evidence.flatMap(item=>{
      const {line_start:start,line_end:end}=item;
      return item.path===path&&item.content_sha256===file.content_sha256&&typeof start==='number'&&typeof end==='number'&&
        Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=1&&end>=start&&end<=lines.length
        ?[[Math.max(1,start-20),Math.min(lines.length,start+80,end+20)]]:[];
    });
    const selected=new Set<number>();
    for(const [start,end] of ranges)for(let line=start;line<=end;line++)selected.add(line);
    const numbered:string[]=[];
    for(const line of [...selected].sort((a,b)=>a-b)){
      const entry=`${line} | ${lines[line-1]}`;
      if(entry.length>remaining)break;
      numbered.push(entry);
      remaining-=entry.length+1;
    }
    excerpts.push({path,source_snapshot_id:file.source_snapshot_id,content_sha256:file.content_sha256,
      line_count:file.line_count,lines:numbered});
  }

  return [
    '复核你上一回合的候选走读。候选是待证实的草稿。下列冻结源码由 ARC 按快照哈希读出，是核查依据。如行段不足，用 arc_read_source 实读完整的调用和分支。',
    '逐处检查摘要、节点、关系标签与条件、断言、阅读和函数走读中的先后描述。先定位两个真实调用点，再读从第一个到第二个的完整语句、分支与嵌套范围。分别描述进入条件、调用顺序及结果处理。区分调用或生成子校验的时机与用户数据实际执行校验的时机。不要根据错误被输出的时机反推错误参数何时设置。',
    '对不同模块分别核对。没有调度、直接调用或同一执行路径的依据，就去掉断言先后或调用关系的边，并在说明中保留各自局部路径。相邻代码行若分属不同分支或回调，不足以证明运行时顺序。',
    '修正所有受影响的展示文字和源码引用。每组可证实的关键顺序在摘要或来源断言中直接写成“先…，再…”，写出具体函数名和两处准确行号，并添加相应源码证据。只保留可以从冻结源码核对的结论。无法判断时说明缺少的证据。保留原绑定和已有 Arc 分析 JSON 合同，返回一个完整 JSON，不输出复核过程。',
    JSON.stringify(excerpts),
  ].join('\n');
}
