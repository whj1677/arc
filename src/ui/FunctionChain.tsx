import React,{useId,useState} from 'react';
import type {AnalysisResult,SourceEvidence} from '../shared';
import {FunctionCallMap} from './FunctionCallMap';
import {functionCallMap} from './function-call-map';
import {functionInfo,functionSource} from './function-chain';
import {functionSequence,callStepKey,selectedCallStep} from './function-sequence-model';
import {Diagram} from './ReadingDiagrams';
import {SourceEditorActions} from './SourceEditorActions';

const stepNames={entry:'入口',call:'调用',callback:'回调内调用',dispatch:'异步派发',return:'返回',work:'处理'};
type FunctionChainMode='calls'|'time';
export function FunctionChain({result,selected,select,zoom,search,pathId,onPath,evidence,mode:controlledMode,onModeChange,graphActions,showModeSwitch=true}:{result:AnalysisResult;selected:string;select:(id:string)=>void;zoom:number;search:string;pathId:string;onPath:(id:string,nodeId:string)=>void;evidence:(e:SourceEvidence)=>void;mode?:FunctionChainMode;onModeChange?:(mode:FunctionChainMode)=>void;graphActions?:React.ReactNode;showModeSwitch?:boolean}){
  const [internalMode,setInternalMode]=useState<FunctionChainMode>('calls');
  const mode=controlledMode??internalMode;
  const changeMode=(next:FunctionChainMode)=>{if(controlledMode===undefined)setInternalMode(next);onModeChange?.(next);};
  const model=functionSequence(result,pathId),marker='call-'+useId().replace(/:/g,'');
  const paths=result.function_walkthroughs||[];
  if(pathId&&paths.length&&!paths.some(path=>path.id===pathId))return <section className="function-chain function-sequence-empty"><h2>原入口已不在这版结果中</h2><p>选择这版已记录的入口继续阅读，不自动混入其他路径。</p><nav className="function-entry-paths" aria-label="选择函数入口">{paths.map(p=><button key={p.id} onClick={()=>onPath(p.id,p.entry_node_id)}>{p.label}</button>)}</nav></section>;
  if(!model){
    const ids=new Set(result.nodes.filter(node=>node.kind==='function').map(node=>node.node_id));
    const links=result.edges.filter(edge=>['sync_call','execution_boundary'].includes(edge.kind)&&ids.has(edge.source_node_id)&&ids.has(edge.target_node_id));
    const confirmed=links.filter(edge=>edge.status==='source_supported').length;
    return <section className="function-chain function-sequence-empty">
      <h2>{links.length?'调用时间图尚未生成':'函数调用图尚未生成'}</h2>
      <p>{links.length?`已记录 ${links.length} 条函数关系，其中 ${confirmed} 条有源码支持。这版说明尚未确认完整调用顺序。`:
        ids.size?'当前结果已记录函数，尚未确认函数之间的调用关系。':'这版结果尚未记录此范围内的函数入口和调用关系。'}</p>
      {graphActions}
      {ids.size>0&&<FunctionCallMap result={result} pathId="" selected={selected} select={select} search={search} zoom={zoom} evidence={evidence}/>}
    </section>;
  }
  const headerHeight=104,firstMessageY=headerHeight+49;
  const {path,participants}=model,width=Math.max(520,participants.length*236+70),height=firstMessageY+17+path.steps.length*68;
  const x=(id:string|null)=>id===null?18:132+participants.findIndex(n=>n.node_id===id)*236;
  const query=search.trim().toLowerCase();
  const symbol=(id:string|null)=>{const n=participants.find(n=>n.node_id===id);return n?.function_details?.symbol||n?.label||'外部触发';};
  return <section className="function-chain function-diagram" aria-label="函数走读">
    <div className="function-controls">
      {showModeSwitch && <nav className="architecture-view-switch" aria-label="函数图类型">
        <button aria-pressed={mode==='calls'} onClick={()=>changeMode('calls')}>函数调用链</button>
        <button aria-pressed={mode==='time'} onClick={()=>changeMode('time')}>调用时间图</button>
      </nav>}
      <label className="function-entry-paths">入口路径
        {paths.length > 1 ? <select aria-label="选择函数入口" value={path.id} onChange={event=>{
          const next = paths.find(item => item.id === event.target.value)!;
          onPath(next.id, next.entry_node_id);
        }}>{paths.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          : <strong>{path.label}</strong>}
      </label>
    </div>
    {mode==='calls'?<FunctionCallMap result={result} pathId={path.id} selected={selected} select={select} search={search} zoom={zoom} evidence={evidence}/>:<>
    <div className="diagram-caption"><strong>调用时间图</strong><span>{path.steps.length} 个静态步骤 · 虚线表示返回，蓝线表示异步或回调</span></div>
    <Diagram key={result.result_id+path.id} width={width} height={height} zoom={zoom} label="每个函数一个节点的调用时间图" headerHeight={headerHeight} header={participants.map(node=>{
      const full = symbol(node.node_id), parts = full.split('.'), file = functionSource(result, node).path;
      return <foreignObject key={node.node_id} data-function-node={node.node_id} data-zoom-anchor x={x(node.node_id)-108} y="4" width="216" height="92">
        <button className="fn-participant" aria-pressed={selected===node.node_id} onClick={()=>select(node.node_id)} title={full+(file?'\n'+file:'')}>
          <small className="function-node-meta">
            {node.node_id===path.entry_node_id && <em className="function-entry-badge">入口</em>}
            <span>{parts.slice(0,-1).join('.') || file?.split('/').at(-1) || '函数'}</span>
          </small>
          <strong>{parts.at(-1)}</strong>
        </button>
      </foreignObject>;
    })}>
      <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>
      {participants.map(n=><line key={n.node_id} className="fn-lifeline" x1={x(n.node_id)} y1={headerHeight} x2={x(n.node_id)} y2={height-20}/>)}
      {path.steps.map((step,i)=>{
        const sx=x(step.from_node_id),tx=x(step.to_node_id),y=firstMessageY+i*68,self=sx===tx,key=callStepKey(path.id,step.id);
        const d=self?`M${sx} ${y-16} h60 v26 h-60`:`M${sx} ${y} H${tx}`;
        const label=step.kind==='return'?step.input:step.kind==='entry'?'进入 '+symbol(step.to_node_id).split('.').at(-1):step.text;
        const lw=self?204:step.kind==='entry'?216:Math.max(86,Math.abs(sx-tx)-20);
        const lx=self?Math.min(sx+14,width-lw-8):Math.min(sx,tx)+10;
        const match=!query||[symbol(step.from_node_id),symbol(step.to_node_id),step.text,step.input,step.output].join(' ').toLowerCase().includes(query);
        return <g key={step.id} className={`fn-message ${step.kind} ${selected===key?'selected':''} ${query&&!match?'diagram-dim':''}`} data-call-step={step.id} role="button" tabIndex={0} aria-label={`${i+1} ${stepNames[step.kind]}：${symbol(step.from_node_id)} → ${symbol(step.to_node_id)}，${step.text}`} onClick={()=>select(key)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(key);}}}>
          <title>{step.text+(step.condition?'\n条件：'+step.condition:'')}</title>
          <path className="diagram-hit" d={d}/><path className="fn-message-line" d={d} markerEnd={`url(#${marker})`}/>
          <foreignObject x={lx} y={y-45} width={lw} height="34"><div className="fn-message-label"><b>{String(i+1).padStart(2,'0')}</b><span title={label}>{label}</span>{step.condition&&<em title={step.condition}>条件</em>}</div></foreignObject>
        </g>;
      })}

    </Diagram></>}
    <details className="diagram-scope"><summary>触发入口与路径边界 · 源码静态顺序</summary><p>{path.trigger}</p><p>{path.boundary}</p></details>
  </section>;
}

function FunctionEvidence({data,label,open}:{
  data:SourceEvidence;label:string;open:(evidence:SourceEvidence)=>void
}){
  return <button className="function-definition function-source-evidence" onClick={()=>open(data)}>
    <strong>{label} · {data.path.split('/').at(-1)}</strong>
    <small>{data.path}:{data.line_start}–{data.line_end}</small>
    {data.note&&<span>{data.note}</span>}
    <b>打开来源依据 →</b>
  </button>;
}

export function FunctionStepDetail({result,selection,select,evidence}:{result:AnalysisResult;selection:NonNullable<ReturnType<typeof selectedCallStep>>;select:(id:string)=>void;evidence:(e:SourceEvidence)=>void}){
  const {path,step,index}=selection;
  const name=(id:string)=>{const node=result.nodes.find(item=>item.node_id===id);return node?.function_details?.symbol||node?.label||id;};
  const relation=functionCallMap(result,path.id).links.find(link=>link.id===callStepKey(path.id,step.id));
  const stepEvidence=result.evidence.filter(item=>step.evidence_ids.includes(item.evidence_id));
  return <article className="function-detail"><span className="eyebrow">{String(index+1).padStart(2,'0')} · {stepNames[step.kind]}</span><h2>{step.text}</h2>
    <div className="function-step-pair">{step.from_node_id&&step.from_node_id!==step.to_node_id&&<><button onClick={()=>select(step.from_node_id!)}>{name(step.from_node_id)}</button><span>{step.kind==='return'?'┄ 返回到 →':'→'}</span></>}<button onClick={()=>select(step.to_node_id)}>{name(step.to_node_id)}</button></div>
    {step.condition&&<p className="function-condition"><strong>触发条件</strong>{step.condition}</p>}
    <dl className="function-step-facts">
      <div><dt>{step.kind==='return'?'返回内容':'传入 / 起点'}</dt><dd>{step.input}</dd></div>
      <div><dt>本步结果</dt><dd>{step.output}</dd></div>
    </dl>
    {relation&&<section className="function-relation-evidence">
      <h3>调用位置与实现依据</h3>
      <p className="muted">{relation.fileRelation==='same-file'?'调用者与目标位于同一文件。':relation.fileRelation==='cross-file'?'这是跨文件关系；请分别核对两端定义和实际调用点。':'两端文件关系尚未确认。'}</p>
      <div className="function-endpoint-sources">
        {relation.callerDefinition&&<FunctionEvidence data={relation.callerDefinition} label="调用者定义" open={evidence}/>}
        {relation.callerDeclaration&&<FunctionEvidence data={relation.callerDeclaration} label="调用者声明（不是实现）" open={evidence}/>}
        {relation.calleeDefinition&&<FunctionEvidence data={relation.calleeDefinition} label="目标定义" open={evidence}/>}
        {relation.calleeDeclaration&&<FunctionEvidence data={relation.calleeDeclaration} label="目标声明（不是实现）" open={evidence}/>}
      </div>
      <h4>已确认的调用点</h4>
      {relation.callsites.length?relation.callsites.map(item=><FunctionEvidence key={item.evidence_id} data={item} label="调用点" open={evidence}/>):<p className="muted">这版未记录可核对的调用点；定义或声明不能替代调用发生位置。</p>}
    </section>}
    <h3>本步依据</h3>
    {stepEvidence.length?stepEvidence.map(item=><FunctionEvidence key={item.evidence_id} data={item} label="路径依据" open={evidence}/>):<p className="muted">本步尚未关联来源依据。</p>}
    <details><summary>这条路径的触发与边界</summary><p>{path.trigger}</p><p>{path.boundary}</p></details></article>;
}

export function FunctionDetail({result,node,select,evidence}:{result:AnalysisResult;node:AnalysisResult['nodes'][number];select:(id:string)=>void;evidence:(e:SourceEvidence)=>void}){
  const info=functionInfo(result,node),source=functionSource(result,node),calls=result.edges.filter(e=>['sync_call','execution_boundary'].includes(e.kind)&&(e.source_node_id===node.node_id||e.target_node_id===node.node_id));
  const location=source.definition??source.declaration;
  const ioList=(list:AnalysisResult['nodes'][number]['inputs']|null,unknown:string,empty:string)=>list===null?<p className="muted">{unknown}</p>:list.length?list.map(io=><article className="function-io" key={io.io_id}><strong>{io.name}</strong><span className="tag">{io.data_type||'类型未知'}</span><p>{io.description}</p>{io.value_or_shape&&<code>{io.value_or_shape}</code>}{io.availability!=='specified'&&<small className="warning">{io.availability==='partial'?'仅部分已知':'尚未查明'}</small>}</article>):<p>{empty}</p>;
  return <article className="function-detail">
    <span className="eyebrow">函数详情</span><h2 className="function-symbol">{info.details?.symbol||node.label}</h2><p>{node.description}</p>
    {info.details?.signature && <code className="function-signature">{info.details.signature}</code>}
    <h3>定义与声明</h3>
    {source.definition?<FunctionEvidence data={source.definition} label="函数定义（实现）" open={evidence}/>:<p className="muted">{source.declaration?'当前只记录了声明位置；声明不等于函数实现。':'尚未记录准确的函数定义或声明文件。下方来源引用不自动等于所属文件。'}</p>}
    {source.declaration&&<FunctionEvidence data={source.declaration} label="函数声明（不是实现）" open={evidence}/>}
    {location&&<SourceEditorActions key={`${result.result_id}/${node.node_id}`} location={{source_snapshot_id:location.source_snapshot_id,path:location.path,line:location.line_start}}/>}
    <h3>输入参数</h3>{ioList(info.parameters,'尚未区分具体参数；不能将业务输入直接当作函数形参。','已记录为无输入参数。')}
    <h3>返回值</h3>{ioList(info.returns,'返回值尚未明确，不能把所有输出都当作 return。','已记录为无返回值。')}
    {info.otherOutputs.length>0&&<><h3>{info.returns===null?'已记录输出（尚未区分返回值）':'其他输出 / 副作用'}</h3>{ioList(info.otherOutputs,'','无')}</>}
    {!info.details&&node.inputs.length>0&&<details><summary>已有业务输入说明</summary>{ioList(node.inputs,'','未说明')}</details>}
    <h3>谁调用它 / 它调用谁</h3>{calls.length?calls.map(e=>{const incoming=e.target_node_id===node.node_id,peer=result.nodes.find(n=>n.node_id===(incoming?e.source_node_id:e.target_node_id));return <button className="function-peer" key={e.edge_id} onClick={()=>select(e.edge_id)}>{incoming?'来自':'调用'} · {peer?.function_details?.symbol||peer?.label}<small>{e.label}{e.status!=='source_supported'?' · 待确认':''}</small></button>;}):<p className="muted">本结果未记录关联调用，不能推断无人调用。</p>}
  </article>;
}
