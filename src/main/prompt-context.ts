import type {Snapshot,Annotation,AnalysisResult,ReadingContext,ReadingQuestion,ReadingTarget,Project,Feature,Scenario} from '../shared';
import {relativePath} from './snapshot';

export const overviewDiscoveryBudget = { calls: 64, searchFiles: 24, readLines: 80 } as const;

export function readingTarget(result:AnalysisResult|undefined,target:ReadingTarget,snapshot:Snapshot,feature:Feature) {
  if(!target||!['feature','node','edge','file','directory','step','role','handoff','call_step'].includes(target.kind)||typeof target.id!=='string'||!target.id.trim()||target.id.length>2000)throw Error('阅读对象无效');
  if(target.kind==='feature'){
    if(target.id!==feature.feature_id&&target.id!==feature.project_id)throw Error('功能不属于当前阅读位置');
    return {summary:result?.summary,coverage:result?.coverage,claim_ids:result?.summary.claim_ids||[],evidence_ids:[] as string[]};
  }
  if(target.kind==='file'||target.kind==='directory'){
    relativePath(target.id);
    if(!snapshot.files.some(f=>target.kind==='file'?f.path===target.id:f.path.startsWith(target.id+'/')))throw Error('文件或目录不在本次冻结快照中');
    const matches=(p:string)=>target.kind==='file'?p===target.id:p.startsWith(target.id+'/');
    const nodes=result?.nodes.filter(n=>n.source_scope&&matches(n.source_scope.path))||[];
    return {purpose:nodes,reading_file:result?.reading_guide?.files.find(f=>f.path===target.id),evidence_ids:result?.evidence.filter(e=>matches(e.path)).map(e=>e.evidence_id)||[]};
  }
  if(!result)throw Error('节点和关系提问需要绑定原说明');
  if(target.kind==='call_step'){
    const match=/^call-step:([^:]+):([^:]+)$/.exec(target.id);
    const step=match&&result.function_walkthroughs?.find(p=>p.id===decodeURIComponent(match[1]))?.steps.find(s=>s.id===decodeURIComponent(match[2]));
    if(!step)throw Error('函数步骤不属于原说明');
    return {...step,node_ids:[step.to_node_id,...(step.from_node_id?[step.from_node_id]:[])]};
  }
  const selected=target.kind==='node'?result.nodes.find(n=>n.node_id===target.id):target.kind==='edge'?result.edges.find(e=>e.edge_id===target.id):target.kind==='step'?result.reading_guide?.steps.find(s=>s.id===target.id):target.kind==='role'?result.reading_guide?.roles.find(r=>r.id===target.id):result.reading_guide?.handoffs.find(h=>h.id===target.id);
  if(!selected)throw Error('阅读对象不属于原说明');
  return selected;
}

export function buildReadingContext(input:{project:Project;feature:Feature;scenario:Scenario;result?:AnalysisResult;target:ReadingTarget;snapshot:Snapshot;annotations:Annotation[];questions:ReadingQuestion[];sourceMode:'bound'|'latest';previousSnapshotId:string|null;replyTo?:ReadingQuestion}):ReadingContext {
  const {project,feature,scenario,result,target,snapshot}=input;
  const selected=readingTarget(result,target,snapshot,feature),evidenceIds=new Set(selected.evidence_ids);
  const nodeIds=new Set<string>(target.kind==='node'?[target.id]:'node_ids'in selected?selected.node_ids:[]);
  if(target.kind==='edge'&&'source_node_id'in selected){nodeIds.add(selected.source_node_id);nodeIds.add(selected.target_node_id);}
  const claimIds=('claim_ids'in selected?selected.claim_ids:[])||[];
  const relatedClaims=result?.claims.filter(c=>claimIds.includes(c.claim_id)||c.targets.node_ids.some(id=>nodeIds.has(id)))||[];
  for(const c of relatedClaims)for(const id of c.evidence_ids)evidenceIds.add(id);
  const evidence=(result?.evidence.filter(e=>evidenceIds.has(e.evidence_id))||[]).slice(0,24);
  const matchingTarget=(t:ReadingTarget)=>t.kind===target.kind&&t.id===target.id;
  const annotations=input.annotations.filter(a=>a.project_id===project.project_id&&a.scenario_id===scenario.scenario_id&&(a.result_id===null||a.result_id===(result?.result_id??null))&&(
    a.target?matchingTarget(a.target)||(a.target.kind==='node'&&nodeIds.has(a.target.id)):!a.object_id||a.object_id===target.id||nodeIds.has(a.object_id)
  )).slice(-12).map(a=>({...a,text:a.text.slice(0,1600)}));
  const recent=input.questions.filter(q=>q.question_id!==input.replyTo?.question_id&&q.project_id===project.project_id&&q.scenario_id===scenario.scenario_id&&q.result_id===(result?.result_id??null)&&matchingTarget(q.target)&&q.source_snapshot_id===snapshot.source_snapshot_id).slice(-6);
  const excerpt=(v:unknown,max:number)=>{const raw=JSON.stringify(v);return raw.length<=max?v:{excerpt:raw.slice(0,max),truncated:true};};
  return {
    project:{project_id:project.project_id,name:project.name},feature:{feature_id:feature.feature_id,name:feature.name},
    scenario:{scenario_id:scenario.scenario_id,title:scenario.title,question:scenario.question,question_revision_id:scenario.question_revision_id},
    result_id:result?.result_id??null,target,source_snapshot_id:snapshot.source_snapshot_id,
    source:{captured_at:snapshot.captured_at,commit:snapshot.commit,fingerprint:snapshot.fingerprint,mode:input.sourceMode,previous_snapshot_id:input.previousSnapshotId},
    existing_explanation:result?{source_snapshot_id:result.binding.source_snapshot_id,historical:result.binding.source_snapshot_id!==snapshot.source_snapshot_id,selected:excerpt(selected,10000),claims:excerpt(relatedClaims,5000)}:null,
    evidence,annotations,
    reply_to:input.replyTo?{question_id:input.replyTo.question_id,result_id:input.replyTo.result_id,question:input.replyTo.question,answer:input.replyTo.answer?.answer??null,evidence:input.replyTo.answer?.evidence||[],uncertainties:input.replyTo.answer?.uncertainties||[],source_snapshot_id:input.replyTo.source_snapshot_id,historical:input.replyTo.source_snapshot_id!==snapshot.source_snapshot_id}:null,
    recent_questions:recent.map(q=>({question_id:q.question_id,question:q.question,answer:q.answer?.answer.slice(0,2400)??null,evidence:q.answer?.evidence.slice(0,8)||[],source_snapshot_id:q.source_snapshot_id})),
  };
}

// The complete manifest remains in source-context.json, never in the initial
// model message. A page can reach every authorized file without widening scope.
export function listFrozenFiles(snapshot:Snapshot,args:{query?:string;offset?:number;limit?:number}={}) {
  if(args.query!==undefined&&typeof args.query!=='string')throw new Error('query 类型错误');
  const offset=args.offset??0,limit=args.limit??100;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('分页范围错误：offset ≥ 0，limit 为 1–100');
  const matches=snapshot.files.filter(f=>!args.query||f.path.toLowerCase().includes(args.query.toLowerCase()));
  const files=[];let size=0;
  for(const file of matches.slice(offset,offset+limit)){
    const bytes=Buffer.byteLength(JSON.stringify(file));
    if(size+bytes>120*1024)break;
    files.push(file);size+=bytes;
  }
  if(!files.length&&offset<matches.length)throw new Error('单条文件信息超过返回上限，请使用更精确的路径查询');
  const next=offset+files.length;
  return {source_snapshot_id:snapshot.source_snapshot_id,total:matches.length,offset,files,next_offset:next<matches.length?next:null,excluded_count:snapshot.excluded.length,build_config:snapshot.build_config};
}

const sourceFile=/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|swift|m|mm|vue|svelte|sql|proto)$/i;
const headerFile=/\.(?:h|hh|hpp|hxx|d\.ts)$/i;
const nonSourceDirectory=/(?:^|\/)(?:tests?|gtest|glog|third_party|vendor|CMakeFiles|build)\//i;
const preferredModule=/^(?:src|app|mid|hal|core|modules|services|components|pkg|internal|lib)$/i;

function wrapperPrefix(snapshot:Snapshot) {
  let prefix='';
  for(const dir of (snapshot.files[0]?.path??'').split('/').slice(0,-1)){
    const next=prefix+dir+'/';
    if(preferredModule.test(dir)||!snapshot.files.every(file=>file.path.startsWith(next)))break;
    prefix=next;
  }
  return prefix;
}

function moduleSamples(paths:string[]) {
  const ordered=paths.sort((a,b)=>Number(headerFile.test(a))-Number(headerFile.test(b)));
  const parents=new Set<string>(),samples=new Set<string>();
  for(const file of ordered){
    const parent=file.slice(0,file.lastIndexOf('/')+1);
    if(parents.has(parent))continue;
    parents.add(parent);
    samples.add(file);
    if(samples.size===6)return [...samples];
  }
  for(const file of ordered){samples.add(file);if(samples.size===6)break;}
  return [...samples];
}

function sourceDirectories(snapshot:Snapshot,prefix:string) {
  type Directory={dir:string;count:number;samples:string[]};
  const groups=new Map<string,string[]>();
  for(const file of snapshot.files){
    if(!sourceFile.test(file.path)||nonSourceDirectory.test(file.path))continue;
    const parts=file.path.slice(prefix.length).split('/');
    const depth=Math.min(4,parts.length-1);
    const dir=(prefix+parts.slice(0,depth).join('/')).replace(/\/$/,'')||'.';
    let paths=groups.get(dir);
    if(!paths){paths=[];groups.set(dir,paths);}
    paths.push(parts.slice(depth).join('/'));
  }
  const priority=(dir:string)=>Number(dir.split('/').some(part=>preferredModule.test(part)));
  const ranked=[...groups].sort(([a,filesA],[b,filesB])=>filesB.length-filesA.length||priority(b)-priority(a)||a.localeCompare(b));
  const result:Directory[]=[], candidates:string[][]=[];
  // Give each module a representative before spending the remaining bytes on
  // more examples. Keep paths intact so each hint can be opened in the snapshot.
  let remaining=4096-2;
  for(const [dir,paths] of ranked){
    const choices=moduleSamples(paths);
    const entry={dir,count:paths.length,samples:choices.slice(0,1)};
    const size=Buffer.byteLength(JSON.stringify(entry))+(result.length?1:0);
    if(size>remaining)continue;
    result.push(entry);
    candidates.push(choices);
    remaining-=size;
    if(result.length===30)break;
  }
  for(let i=1;i<6;i++){
    for(const [index,choices] of candidates.entries()){
      const sample=choices[i];
      if(!sample)continue;
      const size=Buffer.byteLength(JSON.stringify(sample))+1;
      if(size>remaining)continue;
      result[index].samples.push(sample);
      remaining-=size;
    }
  }
  return result;
}

export function promptContext(snapshot:Snapshot,annotations:Annotation[],previous?:any) {
  const clipped=(value:unknown,max:number)=>{const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length<=max?text:text.slice(0,max)+'…（上下文节选，非完整内容）';};
  const roots=new Map<string,number>();
  const prefix=wrapperPrefix(snapshot);
  for(const file of snapshot.files){const relative=file.path.slice(prefix.length);const root=relative.includes('/')?prefix+relative.split('/')[0]+'/':'根目录文件';roots.set(root,(roots.get(root)||0)+1);}
  const rootList=[...roots].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,count])=>({name:clipped(name,180),count}));
  const hints=snapshot.files.filter(f=>!f.path.slice(prefix.length).includes('/')).slice(0,20).map(f=>clipped(f.path,180));
  const entryPattern=/(?:^|\/)(?:package\.json|cargo\.toml|pyproject\.toml|go\.mod|cmakelists\.txt|makefile|readme(?:\.[a-z0-9]+)?|(?:main|index|app|server|cli|init|entry)\.[a-z0-9]+)$/i;
  const entryHints=snapshot.files.filter(f=>entryPattern.test(f.path)&&!nonSourceDirectory.test(f.path)&&f.path.split('/').length<=5).slice(0,20).map(f=>clipped(f.path,180));
  const clues=annotations.slice(-12).map(a=>({text:clipped(a.text,600),source_snapshot_id:a.source_snapshot_id,result_id:a.result_id,object_id:a.object_id,target:a.target}));
  return {inventory:{total_files:snapshot.files.length,excluded_count:snapshot.excluded.length,largest_roots:rootList,root_file_hints:hints,entry_file_hints:entryHints,source_directories:sourceDirectories(snapshot,prefix),inventory_is_partial:true},clues:{items:clues,omitted_count:Math.max(0,annotations.length-clues.length)},previous:previous?{result_id:previous.result_id,binding:previous.binding,summary_excerpt:clipped(previous.summary?.text??previous.summary,3000)}:null};
}
