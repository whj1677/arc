import type {Run,AnalysisResult,ReadingState} from '../shared';

export function isLegacyOverview(position:Pick<ReadingState,'entrance'|'view'>){
 return position.entrance==='overview'&&['home','functions','capabilities','dependencies','composition','map'].includes(position.view);
}

export function modernReading(r:ReadingState):ReadingState{
 // Legacy code-view positions restore to evidence metadata, never fetch file contents.
 const withoutCode=<T extends {mode:ReadingState['mode'];detail_tab:string}>(value:T):T=>({...value,mode:value.mode==='source'?'normal':value.mode,detail_tab:value.detail_tab==='source'?'evidence':value.detail_tab});
 r={...withoutCode(r),...(r.view_states?{view_states:Object.fromEntries(Object.entries(r.view_states).map(([key,value])=>[key,withoutCode(value)]))}:{})};
 if(r.entrance==='overview'){
  r={...r,catalog_hidden:true};
  if(isLegacyOverview(r)){
   const {selected,file,evidence_id,source_snapshot_id,mode,detail_tab,zoom,stage,result_id}=r;
   if(['map','composition'].includes(r.view)&&r.architecture_version!==1){
    r={...r,view_states:{...r.view_states,[r.view]:{selected,file,evidence_id,source_snapshot_id,mode,detail_tab,zoom,stage,result_id}}};
   }
   r={...r,view:'system',selected:'',file:'',evidence_id:'',mode:'normal',detail_tab:'details',zoom:1,stage:'',pinned:false};
  }
  r={...r,architecture_version:1};
 }
 if(r.view==='walknav')return {...r,...(r.view_states?.timeline||{selected:'',file:'',evidence_id:'',source_snapshot_id:'',zoom:1,stage:''}),presentation_version:3,view:'timeline',mode:'normal',detail_tab:'details',catalog_hidden:false};
 if(r.presentation_version===3)return r;
 if(r.entrance!=='walk'&&r.view!=='map'||r.entrance==='walk'&&!['flow','sequence','timeline','topicmap'].includes(r.view))return {...r,presentation_version:3};
 const {selected,file,evidence_id,source_snapshot_id,mode,detail_tab,zoom,stage,result_id}=r;
 return {...r,presentation_version:3,view:'timeline',zoom:1,stage:'',mode:'normal',detail_tab:'details',view_states:{...r.view_states,[r.view]:{selected,file,evidence_id,source_snapshot_id,mode,detail_tab,zoom,stage,result_id}}};
}

export function edgeExplanation(result:AnalysisResult,edge:AnalysisResult['edges'][number]){
  return edge.condition||result.claims.find(c=>edge.claim_ids.includes(c.claim_id))?.statement||'本关系尚无补充说明。点击下方端点和依据查看已分析的范围。';
}

export function compactTitle(title:string,limit=32) {
  const text=title.replace(/\s+/g,' ').trim();
  return Array.from(text).length>limit?Array.from(text).slice(0,limit).join('')+'…':text;
}

export function sceneStatus(runs:Run[],hasExplanation:boolean) {
  const latest=runs.at(-1);
  const labels:Record<string,string>={
    queued:'等待分析',running:'分析中',validating:'结果校验中',
    cancel_requested:'正在停止',cancelled:'已停止',failed:'分析失败',
    unknown:'运行状态待核查',blocked_external:'连接受阻',
  };
  if(latest&&labels[latest.status])return labels[latest.status]+(hasExplanation?' · 有历史说明':'');
  return hasExplanation?'有说明 · 可核对':'尚未分析';
}
