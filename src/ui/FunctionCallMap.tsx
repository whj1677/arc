import {edgeSelection} from './reading-target';
import React,{useEffect,useId,useRef} from 'react';
import type {AnalysisResult,SourceEvidence} from '../shared';
import {functionCallMap,callLabelWidth,callLabelHeight} from './function-call-map';
import {functionInfo} from './function-chain';
import {Diagram,shortLabel} from './ReadingDiagrams';

type Props={
  result:AnalysisResult;
  pathId:string;
  selected:string;
  select:(id:string)=>void;
  search:string;
  zoom:number;
  evidence:(evidence:SourceEvidence)=>void;
};

export function FunctionCallMap({result,pathId,selected,select,search,zoom,evidence}:Props){
  const m=functionCallMap(result,pathId,selected);
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{const frame=root.current?.querySelector<HTMLElement>('.reading-diagram-frame'),node=root.current?.querySelector<SVGElement>(`[data-function-node="${CSS.escape(m.focus.selected)}"]`);if(!frame||!node)return;const box=node.getBoundingClientRect(),viewport=frame.getBoundingClientRect();frame.scrollTo({top:frame.scrollTop+box.top-viewport.top-48,left:frame.scrollLeft+box.left-viewport.left-(frame.clientWidth-box.width)/2,behavior:'auto'});},[result.result_id,pathId,selected]);
  const marker='function-map-'+useId().replace(/:/g,'');
  const query=search.trim().toLowerCase();
  const selectedLink=m.links.find(link=>link.id===selected||link.edgeIds.some(id=>edgeSelection(id)===selected));
  const selectedNode=m.nodes.some(node=>node.node_id===m.focus.selected);
  const nodeName=(id:string)=>{const node=m.nodes.find(item=>item.node_id===id);return node?functionInfo(result,node).details?.symbol||node.label:id;};
  const fileName=(path:string|null|undefined)=>path?.split('/').at(-1)||'文件待确认';
  const entryPath=m.focus.entryPath;
  const entryNodes=new Set(entryPath);
  const entryLinks=new Set(entryPath.slice(1).map((id,index)=>`${entryPath[index]}→${id}`));
  const related=new Set([selected,...m.focus.upstream,...m.focus.downstream,...entryPath]);
  const selectedSources=selectedLink?[...new Map([
    selectedLink.callerDefinition,selectedLink.callerDeclaration,selectedLink.calleeDefinition,selectedLink.calleeDeclaration,...selectedLink.callsites
  ].filter((item):item is SourceEvidence=>!!item).map(item=>[item.evidence_id,item] as const)).values()]:[];
  if(!m.nodes.length)return <p className="fr-empty">这版分析尚未提供函数入口与调用依据。</p>;
  const linkLayers=m.links.map(link=>{
    const {d,labelX,labelY}=m.routes.get(link.id)!;
    const siblings=m.links.filter(item=>item.from===link.from&&item.to===link.to);
    const expanded=selected===link.id||link.edgeIds.some(id=>edgeSelection(id)===selected),targetFile=m.nodeSources.get(link.to)?.path;
    const relation=link.fileRelation==='same-file'?'同文件':link.fileRelation==='cross-file'?'跨文件':'文件待确认';
    const height=callLabelHeight(expanded);
    const label=link.fileRelation==='cross-file'?fileName(targetFile)+' → '+nodeName(link.to):nodeName(link.to)+(siblings.length>1?' · '+(siblings.findIndex(item=>item.id===link.id)+1)+'/'+siblings.length:'');
    const className=`function-map-link ${link.kind} ${link.status} ${link.fileRelation} ${expanded?'selected':''} ${entryLinks.has(`${link.from}→${link.to}`)?'on-entry-path':''}`;
    const title=link.label+'\n'+relation+'\n传入：'+link.input+(link.condition?'\n条件：'+link.condition:'');
    const activate=()=>select(link.id);
    return {
      path:<g key={link.id} className={className} aria-hidden="true" onClick={activate}>
        <title>{title}</title><path className="diagram-hit" d={d}/><path className="diagram-link" d={d} markerEnd={`url(#${marker})`}/>
      </g>,
      label:<g key={link.id} className={className} data-function-call={link.id} role="button" tabIndex={0} aria-label={`${link.label}，${relation}，传入：${link.input}`} onClick={activate} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}}}>
        <title>{title}</title>
        <foreignObject x={labelX} y={labelY-height/2} width={callLabelWidth} height={height}>
          <div className="function-map-args"><small>{relation} · {link.kind==='call'?'调用':link.kind==='callback'?'回调':'异步'}{link.condition?' · 有条件':''}</small><span title={expanded?link.input:label}>{expanded?link.input:label}</span></div>
        </foreignObject>
      </g>,
    };
  });
  return <div className="function-call-map" ref={root}><div className="diagram-caption"><strong>从入口沿箭头走 →</strong><span>按文件阅读 · 选中连线查看传入内容、调用点与定义依据</span></div>
    {selectedNode&&<nav className="function-map-focus" aria-label="当前函数的调用位置">
      <div className="function-map-focus-heading">
        <strong>{m.focus.reachable?'入口至此的一条代表最短路径':'当前函数的已记录关系'}</strong>
        <small>{m.focus.reachable?'可能还有其他路径；这不是运行轨迹。':'尚未确认从当前入口到此函数的路径，不据此推断不存在调用。'}</small>
      </div>
      {entryPath.length>0?<div className="function-map-breadcrumb" aria-label="入口路径跳转">
        {entryPath.map((id,index)=><React.Fragment key={id}>{index>0&&<span aria-hidden="true">→</span>}<button className={m.focus.selected===id?'selected':''} aria-current={m.focus.selected===id?'step':undefined} onClick={()=>select(id)}>{nodeName(id)}</button></React.Fragment>)}
      </div>:<p className="muted">可点选下列已记录的上下游函数继续核对。</p>}
      <details><summary>上下游函数 · {m.focus.upstream.length} 个上游 / {m.focus.downstream.length} 个下游（含间接调用）</summary><div className="function-map-neighbours">
        <div><strong>全部上游（含间接调用）</strong>{m.focus.upstream.length?m.focus.upstream.map(id=><button key={id} onClick={()=>select(id)}>{nodeName(id)}</button>):<small>未记录上游</small>}</div>
        <div><strong>全部下游（含间接调用）</strong>{m.focus.downstream.length?m.focus.downstream.map(id=><button key={id} onClick={()=>select(id)}>{nodeName(id)}</button>):<small>未记录下游</small>}</div>
      </div></details>
    </nav>}
    <Diagram key={result.result_id+pathId} width={m.width} height={m.height} zoom={zoom} label="按文件分组的函数调用链"><defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>
      {m.fileGroups.map(group=><g key={group.id} className="function-map-file-group">
        <rect className="function-map-file-band" x={group.bounds.x} y={group.bounds.y} width={group.bounds.w} height={group.bounds.h} rx="15"/>
        <foreignObject x={group.bounds.x+14} y={group.bounds.y+8} width={group.bounds.w-28} height="36">
          <div className="function-map-file-heading" title={group.path||'定义与声明文件均待确认'}>
            <strong>{fileName(group.path)}</strong><span>{group.path||'定义与声明文件均待确认'}</span><small>{group.nodes.length} 个函数</small>
          </div>
        </foreignObject>
      </g>)}
    <g>{linkLayers.map(link=>link.path)}</g>
    <g>{linkLayers.map(link=>link.label)}</g>
    {m.nodes.map(node=>{const b=m.boxes.get(node.node_id)!,info=functionInfo(result,node),source=m.nodeSources.get(node.node_id),symbol=info.details?.symbol||node.label;
      const location=source?.definition||source?.declaration;
      const range=location?`:${location.line_start}–${location.line_end}`:'';
      const unknownLocation='定义与声明位置待确认';
      return <foreignObject key={node.node_id} data-function-node={node.node_id} data-zoom-anchor x={b.x} y={b.y} width={b.w} height={b.h}><button aria-pressed={selected===node.node_id} className={`function-map-node ${selected===node.node_id?'selected':''} ${entryNodes.has(node.node_id)?'on-entry-path':''} ${related.has(node.node_id)?'focus-related':''} ${query&&![symbol,node.description,source?.path].join(' ').toLowerCase().includes(query)?'diagram-dim':''}`} onClick={()=>select(node.node_id)} title={symbol+'\n'+node.description}><small>{m.entry===node.node_id?'● 入口函数':symbol.includes('.')?symbol.split('.').slice(0,-1).join('.'):'函数'}</small><strong>{symbol.split('.').at(-1)}</strong><span>{shortLabel(node.description,28)}</span><small title={location?location.path+range:unknownLocation}>{location?(source?.declaration?'声明 · ':'')+fileName(location.path)+range:unknownLocation}</small></button></foreignObject>;
    })}
    </Diagram>{!m.entry&&<p className="muted">这版仅记录了调用关系，工程入口尚未确认。</p>}
    {selectedLink&&<section className="function-map-selection" aria-label="所选调用关系">
      <div>
        <span className="eyebrow">{selectedLink.fileRelation==='same-file'?'同文件关系':selectedLink.fileRelation==='cross-file'?'跨文件关系':'文件关系待确认'}</span>
        <h3>{selectedLink.label}</h3>
        <p><strong>传入：</strong>{selectedLink.input}</p>
        {selectedLink.condition&&<p className="function-condition">{selectedLink.condition}</p>}
        <small>选中关系已在右侧保留原说明与原位提问上下文。</small>
      </div>
      <div className="function-map-selection-sources">
        {selectedSources.length?selectedSources.map(item=><button key={item.evidence_id} className="function-definition" onClick={()=>evidence(item)}>
          <strong>{item.role==='callsite'?'已确认调用点':item.role==='definition'?'定义':item.role==='declaration'?'声明':'来源'} · {fileName(item.path)}</strong>
          <small>{item.path}:{item.line_start}–{item.line_end}</small>
          {item.note&&<span>{item.note}</span>}
          <b>打开来源依据 →</b>
        </button>):<p className="muted">尚未关联定义、声明或已确认调用点。</p>}
      </div>
    </section>}
  </div>;
}
