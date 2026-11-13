import React,{useId,useState} from 'react';
import type {AnalysisResult,SourceEvidence} from '../shared';
import {FunctionCallMap} from './FunctionCallMap';
import {functionInfo} from './function-chain';
import {functionSequence,callStepKey,selectedCallStep} from './function-sequence-model';
import {Diagram,shortLabel} from './ReadingDiagrams';

const stepNames={entry:'入口',call:'调用',callback:'回调内调用',dispatch:'异步派发',return:'返回',work:'处理'};
export function FunctionChain({result,selected,select,zoom,search,pathId,onPath}:{result:AnalysisResult;selected:string;select:(id:string)=>void;zoom:number;search:string;pathId:string;onPath:(id:string,nodeId:string)=>void;evidence:(e:SourceEvidence)=>void}){
  const [mode,setMode]=useState<'calls'|'time'>('calls');
  const model=functionSequence(result,pathId),marker='call-'+useId().replace(/:/g,'');
  const paths=result.function_walkthroughs||[],functions=result.nodes.filter(n=>n.kind==='function');
  if(!model)return <section className="function-chain function-sequence-empty"><h2>这版说明尚未确认入口与调用先后</h2><p>已有函数可点选查看；尚无依据的先后顺序不连线。</p><div className="function-unordered">{functions.filter(n=>!search||(n.function_details?.symbol+' '+n.description).toLowerCase().includes(search.toLowerCase())).map(n=><button key={n.node_id} onClick={()=>select(n.node_id)}>{n.function_details?.symbol||n.label}</button>)}</div></section>;
  const {path,participants}=model,width=Math.max(480,participants.length*200+70),height=154+path.steps.length*68;
  const x=(id:string|null)=>id===null?18:120+participants.findIndex(n=>n.node_id===id)*200;
  const query=search.trim().toLowerCase();
  const symbol=(id:string|null)=>{const n=participants.find(n=>n.node_id===id);return n?.function_details?.symbol||n?.label||'外部触发';};
  return <section className="function-chain function-diagram" aria-label="函数走读">
    <nav className="function-entry-paths" aria-label="选择函数入口">{paths.map(p=><button key={p.id} aria-pressed={p.id===path.id} className={p.id===path.id?'selected':''} onClick={()=>onPath(p.id,p.entry_node_id)}>{p.label}</button>)}</nav>
    <nav className="function-view-mode" aria-label="函数图类型"><button aria-pressed={mode==='calls'} onClick={()=>setMode('calls')}>函数调用链</button><button aria-pressed={mode==='time'} onClick={()=>setMode('time')}>调用时间图</button></nav>
    {mode==='calls'?<FunctionCallMap result={result} pathId={path.id} selected={selected} select={select} search={search} zoom={zoom}/>:<>
    <div className="diagram-caption"><strong>从入口往下读 ↓</strong><span>实线 调用　┄ 返回　蓝色 异步 / 回调</span></div>
    <Diagram key={result.result_id+path.id} width={width} height={height} zoom={zoom} label="每个函数一个节点的调用时间图" header={participants.map(n=>{const full=symbol(n.node_id),parts=full.split('.'),file=functionInfo(result,n).definition?.path;return <foreignObject key={n.node_id} data-function-node={n.node_id} data-zoom-anchor x={x(n.node_id)-90} y="4" width="180" height="86"><button className={'fn-participant '+(selected===n.node_id?'selected':'')} onClick={()=>select(n.node_id)} title={full+(file?'\n'+file:'')}><small>{n.node_id===path.entry_node_id?'● 入口 · ':''}{parts.slice(0,-1).join('.')||file?.split('/').at(-1)||'函数'}</small><strong>{parts.at(-1)}</strong></button></foreignObject>;})}>
      <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>
      {participants.map(n=><line key={n.node_id} className="fn-lifeline" x1={x(n.node_id)} y1="90" x2={x(n.node_id)} y2={height-20}/>)}
      {path.steps.map((step,i)=>{
        const sx=x(step.from_node_id),tx=x(step.to_node_id),y=137+i*68,self=sx===tx,key=callStepKey(path.id,step.id);
        const d=self?`M${sx} ${y-16} h60 v26 h-60`:`M${sx} ${y} H${tx}`;
        const label=step.kind==='return'?step.input:step.kind==='entry'?'进入 '+symbol(step.to_node_id).split('.').at(-1):step.text;
        const lx=self?sx+14:Math.min(sx,tx)+10,lw=self?168:Math.max(86,Math.abs(sx-tx)-20);
        const match=!query||[symbol(step.from_node_id),symbol(step.to_node_id),step.text,step.input,step.output].join(' ').toLowerCase().includes(query);
        return <g key={step.id} className={`fn-message ${step.kind} ${selected===key?'selected':''} ${query&&!match?'diagram-dim':''}`} data-call-step={step.id} role="button" tabIndex={0} aria-label={`${i+1} ${stepNames[step.kind]}：${symbol(step.from_node_id)} → ${symbol(step.to_node_id)}，${step.text}`} onClick={()=>select(key)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(key);}}}>
          <title>{step.text+(step.condition?'\n条件：'+step.condition:'')}</title>
          <path className="diagram-hit" d={d}/><path className="fn-message-line" d={d} markerEnd={`url(#${marker})`}/>
          <foreignObject x={lx} y={y-43} width={lw} height="29"><div className="fn-message-label"><b>{String(i+1).padStart(2,'0')}</b><span>{shortLabel(label,Math.max(8,Math.floor((lw-35)/12)))}</span>{step.condition&&<em title={step.condition}>条件</em>}</div></foreignObject>
        </g>;
      })}

    </Diagram></>}
    <details className="diagram-scope"><summary>触发入口与路径边界 · 源码静态顺序</summary><p>{path.trigger}</p><p>{path.boundary}</p></details>
  </section>;
}

export function FunctionStepDetail({result,selection,select,evidence}:{result:AnalysisResult;selection:NonNullable<ReturnType<typeof selectedCallStep>>;select:(id:string)=>void;evidence:(e:SourceEvidence)=>void}){
  const {path,step,index}=selection;
  const name=(id:string)=>{const n=result.nodes.find(n=>n.node_id===id);return n?.function_details?.symbol||n?.label||id;};
  return <article className="function-detail"><span className="eyebrow">{String(index+1).padStart(2,'0')} · {stepNames[step.kind]}</span><h2>{step.text}</h2><div className="function-step-pair">{step.from_node_id&&step.from_node_id!==step.to_node_id&&<><button onClick={()=>select(step.from_node_id!)}>{name(step.from_node_id)}</button><span>{step.kind==='return'?'┄ 返回到 →':'→'}</span></>}<button onClick={()=>select(step.to_node_id)}>{name(step.to_node_id)}</button></div>{step.condition&&<p className="function-condition">{step.condition}</p>}<h3>{step.kind==='return'?'返回内容':'传入 / 起点'}</h3><p>{step.input}</p><h3>本步结果</h3><p>{step.output}</p><h3>依据</h3>{result.evidence.filter(e=>step.evidence_ids.includes(e.evidence_id)).map(e=><button key={e.evidence_id} className="function-definition" onClick={()=>evidence(e)}>{e.note||e.path}<small>{e.path}:{e.line_start}–{e.line_end}</small></button>)}<details><summary>这条路径的触发与边界</summary><p>{path.trigger}</p><p>{path.boundary}</p></details></article>;
}

export function FunctionDetail({result,node,select,evidence}:{result:AnalysisResult;node:AnalysisResult['nodes'][number];select:(id:string)=>void;evidence:(e:SourceEvidence)=>void}){
  const info=functionInfo(result,node),calls=result.edges.filter(e=>['sync_call','execution_boundary'].includes(e.kind)&&(e.source_node_id===node.node_id||e.target_node_id===node.node_id));
  const ioList=(list:AnalysisResult['nodes'][number]['inputs']|null,unknown:string,empty:string)=>list===null?<p className="muted">{unknown}</p>:list.length?list.map(io=><article className="function-io" key={io.io_id}><strong>{io.name}</strong><span className="tag">{io.data_type||'类型未知'}</span><p>{io.description}</p>{io.value_or_shape&&<code>{io.value_or_shape}</code>}{io.availability!=='specified'&&<small className="warning">{io.availability==='partial'?'仅部分已知':'尚未查明'}</small>}</article>):<p>{empty}</p>;
  return <article className="function-detail"><span className="eyebrow">函数详情</span><h2>{info.details?.symbol||node.label}</h2><p>{node.description}</p><h3>所属文件</h3>{info.definition?<button className="function-definition" onClick={()=>evidence(info.definition!)}><strong>{info.definition.path.split('/').at(-1)}</strong><small>{info.definition.path} : {info.definition.line_start}–{info.definition.line_end}</small><span>查看定义依据 →</span></button>:<p className="muted">尚未记录准确的函数定义文件。下方来源引用不自动等于所属文件。</p>}
    <h3>输入参数</h3>{ioList(info.parameters,'尚未区分具体参数；不能将业务输入直接当作函数形参。','已记录为无输入参数。')}
    <h3>返回值</h3>{ioList(info.returns,'返回值尚未明确，不能把所有输出都当作 return。','已记录为无返回值。')}
    {info.otherOutputs.length>0&&<><h3>{info.returns===null?'已记录输出（尚未区分返回值）':'其他输出 / 副作用'}</h3>{ioList(info.otherOutputs,'','无')}</>}
    {!info.details&&node.inputs.length>0&&<details><summary>已有业务输入说明</summary>{ioList(node.inputs,'','未说明')}</details>}
    <h3>谁调用它 / 它调用谁</h3>{calls.length?calls.map(e=>{const incoming=e.target_node_id===node.node_id,peer=result.nodes.find(n=>n.node_id===(incoming?e.source_node_id:e.target_node_id));return <button className="function-peer" key={e.edge_id} onClick={()=>select(e.edge_id)}>{incoming?'来自':'调用'} · {peer?.function_details?.symbol||peer?.label}<small>{e.label}{e.status!=='source_supported'?' · 待确认':''}</small></button>;}):<p className="muted">本结果未记录关联调用，不能推断无人调用。</p>}
  </article>;
}
