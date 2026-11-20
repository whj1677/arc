import React from 'react';
import {edgeSelection} from './reading-target';
import type { AnalysisResult } from '../shared';
import {flowLayout,flowSize} from './flow-layout';
import {RelationRows} from './RelationRows';
import {focusRelations,canShowSequence,architectureOnlyDependencies} from './graph-presentation';
export const edgeNames:Record<string,string>={sync_call:'同步调用',return:'返回',queue_send:'队列发送',queue_receive:'队列接收',data_publish:'数据发布',data_read:'数据读取',dependency:'依赖',control_flow:'条件 / 局部顺序',execution_boundary:'执行边界'};
export const claimNames:Record<string,string>={source_supported:'来源引用 · 待核对',inferred:'推断',unknown:'未知',user_clue:'用户线索'};
export const nodeNames:Record<string,string>={stage:'聚合阶段',function:'函数',resource:'资源',decision:'条件',execution_boundary:'执行边界'};
interface Props {result:AnalysisResult;selected:string;select:(id:string)=>void;view:string;stage:string;expand?:(id:string)=>void;zoom:number;search:string;scope?:'focus'|'all';changeScope?:(scope:'focus'|'all')=>void}
export function Graph({result,selected,select,view,stage,expand,zoom,search,scope,changeScope}:Props){
  const parent=result.nodes.find(n=>n.node_id===stage);
  let nodes=result.nodes.filter(n=>(parent?n.node_id===stage||n.parent_node_id===stage:!stage||n.execution_context.label===stage)&&(!search||`${n.label} ${n.description}`.toLowerCase().includes(search.toLowerCase())));
  const folded=!stage&&!search&&view!=='dependencies'&&view!=='sequence'&&result.nodes.some(n=>n.parent_node_id);
  if(folded)nodes=nodes.filter(n=>!n.parent_node_id);
  const dependencies=view==='dependencies';
  const edges=result.edges.filter(e=>(!dependencies||e.kind==='dependency')&&(folded||nodes.some(n=>n.node_id===e.source_node_id)||nodes.some(n=>n.node_id===e.target_node_id)));
  if(dependencies)nodes=nodes.filter(n=>edges.some(e=>e.source_node_id===n.node_id||e.target_node_id===n.node_id));
  const external=result.nodes.filter(n=>!nodes.includes(n)&&!folded&&edges.some(e=>e.source_node_id===n.node_id||e.target_node_id===n.node_id));
  const shown=[...nodes,...external].slice(0,100);
  if(!shown.length)return <div className="empty compact"><span className="empty-mark">◇</span><h2>{dependencies?'依赖关系尚未分析':'没有匹配节点'}</h2><p>{dependencies?'没有依赖结果不代表没有第三方依赖。可在场景中向 Agent 提出依赖分析问题。':'清除搜索或阶段筛选，返回完整关系。'}</p></div>;
  const stageNav=<div className="stage-nav">{stage&&<button onClick={()=>expand?.('')}>← 返回阶段总览</button>}{result.nodes.filter(n=>result.nodes.some(c=>c.parent_node_id===n.node_id)).map(n=><button key={n.node_id} onClick={()=>expand?.(n.node_id)}>查看内部：{n.label} · {result.nodes.filter(c=>c.parent_node_id===n.node_id).length}</button>)}</div>;
  const completeEdges=edges.filter(e=>shown.some(n=>n.node_id===e.source_node_id)&&shown.some(n=>n.node_id===e.target_node_id));
  if(dependencies)return <div className="dependency-view"><h2>谁依赖谁</h2><p className="graph-note">从使用方指向依赖项；点中间的标签查看用途与依据。这里不表示业务先后。</p>{architectureOnlyDependencies(result,completeEdges)&&<p className="warning dependency-gap">本版本只分析了系统组件之间的依赖，尚未覆盖内部模块和第三方软件包。需要 Agent 补充依赖分析；不能把这两类缺项当作没有依赖。</p>}<div className="flow-caption">{completeEdges.length} 条已分析依赖 · {shown.length} 个关联节点</div><RelationRows result={result} edges={completeEdges} selected={selected} select={select} zoom={zoom} label="依赖关系清单"/></div>;
  if(view==='sequence')return canShowSequence(shown)?<div>{stageNav}<Sequence result={result} nodes={shown} selected={selected} select={select} zoom={zoom}/></div>:<div className="step-relations"><h2>步骤之间的关系</h2><p className="graph-note">这份说明没有可区分的执行上下文，因此按实际起点和终点展示关系，不绘制同一泳道的自循环。每行独立，行的位置不代表执行先后；条件与失败去向请点标签查看。</p><RelationRows result={result} edges={completeEdges} selected={selected} select={select} zoom={zoom} label="业务步骤关系"/></div>;
  const dense=completeEdges.length>shown.length;
  const focused=(scope|| (dense?'focus':'all'))==='focus';
  const focus=focusRelations(shown,completeEdges,selected);
  const scopeTools=<div className="graph-scope" role="group" aria-label="连线显示方式"><button aria-pressed={focused} onClick={()=>changeScope?.('focus')}>逐步查看</button><button aria-pressed={!focused} onClick={()=>changeScope?.('all')}>全部连线 · {completeEdges.length}</button></div>;
  const relations=<details className="flow-relations"><summary>查看分支与关系 · {edges.length} 条</summary><p className="graph-note">只有关系明确表达的方向与条件有依据；列表位置不代表全局先后。{external.length>0&&`含 ${external.length} 个外部端点。`}</p><div className="relation-list" aria-label="可选关系">{edges.map(e=><button key={e.edge_id} className={selected===edgeSelection(e.edge_id)?'selected':''} onClick={()=>select(edgeSelection(e.edge_id))}><span className="tag">{edgeNames[e.kind]}</span> {result.nodes.find(n=>n.node_id===e.source_node_id)?.label} → {result.nodes.find(n=>n.node_id===e.target_node_id)?.label}<strong>{e.label}</strong>{e.condition&&<small>条件：{e.condition}</small>}</button>)}</div></details>;
  if(focused)return <div className="graph-wrap focused-graph">{scopeTools}<div className="focus-steps" aria-label="选择要看的步骤">{shown.map(n=><button key={n.node_id} aria-pressed={focus.id===n.node_id} onClick={()=>select(n.node_id)}>{n.label}</button>)}</div><p className="graph-note">当前步骤：{shown.find(n=>n.node_id===focus.id)?.label}。逐条查看实际端点与传递内容；步骤按钮的位置不代表执行顺序。</p><RelationRows result={result} edges={focus.main} selected={selected} select={select} zoom={zoom} label="当前步骤的关系"/>{focus.returns.length>0&&<details className="focus-returns"><summary>查看当前步骤的返回 · {focus.returns.length} 条</summary><RelationRows result={result} edges={focus.returns} selected={selected} select={select} zoom={zoom} label="当前步骤的返回关系"/></details>}{!focus.main.length&&<p>本结果没有分析当前步骤的其他连接。</p>}{relations}</div>;
  const {width,height,positions,routes}=flowLayout(shown,edges);
  return <div className="graph-wrap">
    {stageNav}
    {folded&&<p className="graph-note">阶段内部已折叠。下面的关系列表仍保留跨层调用、失败条件与异步边界；展开后查看准确端点。</p>}
    <div className="flow-caption"><span>步骤与分支 · {shown.length} 个节点</span>{scopeTools}<small><span className="flow-legend">传递内容</span> / 条件关系 · 标签可点开</small></div>
    <svg className="graph" data-zoom-surface width={width*zoom} height={height*zoom} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="关键调用关系图">
      <defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#acd0ff"/></marker><marker id="data-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#88edd0"/></marker></defs>
      {routes.map(({edge,d,caption})=>{
        return <g key={edge.edge_id} className={`wire ${selected===edgeSelection(edge.edge_id)?'chosen':''}`} onClick={()=>select(edgeSelection(edge.edge_id))} tabIndex={0} role="button" aria-label={`${edgeNames[edge.kind]}：${edge.label}`} onKeyDown={e=>{if(e.key==='Enter')select(edgeSelection(edge.edge_id));}}>
          <title>{edgeNames[edge.kind]} · {edge.label} · {claimNames[edge.status]}</title>
          <path className="wire-hit" d={d}/><path data-edge-id={edge.edge_id} className={`wire-line ${edge.kind} ${caption.data?'data-transfer':''}`} d={d} markerEnd={`url(#${caption.data?'data-arrow':'arrow'})`}/>
        </g>;
      })}
      {shown.map((node,index)=>{
        const p=positions.get(node.node_id)!;
        const uncertain=result.claims.filter(c=>node.claim_ids.includes(c.claim_id)).some(c=>c.status==='unknown'||c.status==='inferred');
        return <foreignObject key={node.node_id} x={p.x} y={p.y} width={flowSize.nodeWidth} height={flowSize.nodeHeight}>
          <button className={`graph-node ${selected===node.node_id?'selected':''} ${external.includes(node)?'external':''}`} onClick={()=>select(node.node_id)}>
            <span className="node-meta"><span>{String(index+1).padStart(2,'0')}</span><span>{external.includes(node)?'范围外端点':uncertain?'含待确认判断':''}</span></span>
            <strong title={node.label}>{node.label}</strong>
          </button>
        </foreignObject>;
      })}
      {routes.filter(r=>r.label).map(({edge,label,caption})=><g key={'label-'+edge.edge_id}>
        <line className="flow-label-leader" x1={label!.anchor.x} y1={label!.anchor.y} x2={label!.x+label!.width/2} y2={label!.y+label!.height/2}/>
        <foreignObject x={label!.x} y={label!.y} width={label!.width} height={label!.height} className="edge-label-box">
          <button data-edge-id={edge.edge_id} data-label-kind={caption.data?'transfer':'relation'} className={`edge-label ${caption.data?'transfer':''} ${caption.uncertain?'uncertain':''} ${selected===edgeSelection(edge.edge_id)?'selected':''}`} aria-label={`${caption.data?'传递内容':'关系'}：${caption.text}${caption.uncertain?' · 待确认':''}`} title={`${caption.text}\n${caption.data?'明确的输出 → 输入映射':'关系说明；未建立明确输入输出映射'}${caption.uncertain?' · 待确认':''}`} onClick={()=>select(edgeSelection(edge.edge_id))}><span>{caption.text}</span>{caption.uncertain&&<small>待确认</small>}</button>
        </foreignObject>
      </g>)}
    </svg>
    {routes.some(r=>!r.label)&&<p className="graph-note">部分关系标注已避让；点击连线或展开关系列表查看完整内容。</p>}
    {relations}
    {shown.length===100&&<p className="warning">当前最多呈现 100 个节点，请按阶段或搜索聚焦；其余结果仍保存在说明中。</p>}
  </div>;
}
function Sequence({result,nodes,selected,select,zoom}:{result:AnalysisResult;nodes:AnalysisResult['nodes'];selected:string;select:(id:string)=>void;zoom:number}){
  const participants=[...new Set(nodes.map(n=>n.execution_context.identity!))];
  const width=Math.max(660,participants.length*190+80),height=result.edges.length*66+110;
  const nx=(id:string)=>{const node=nodes.find(n=>n.node_id===id);return 130+participants.indexOf(node?.execution_context.identity||'')*190;};
  return <div><p className="graph-note">参与者按有依据的执行上下文分组。纵向仅列出来源关系，不是运行 trace，不推定全局时序或耗时。</p><svg data-zoom-surface width={width*zoom} height={height*zoom} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="模块时序">
    <defs><marker id="sequence-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L7,4 L0,8" fill="#acd0ff"/></marker></defs>
    {participants.map((p,i)=><g key={p}><line x1={130+i*190} x2={130+i*190} y1="50" y2={height} stroke="#52647b" strokeDasharray="5 5"/><text x={130+i*190} y="25" textAnchor="middle" fill="#88edd0" fontSize="13">{p.slice(0,13)}</text></g>)}
    {result.edges.filter(e=>nodes.some(n=>n.node_id===e.source_node_id)&&nodes.some(n=>n.node_id===e.target_node_id)).map((edge,i)=>{
      const a=nx(edge.source_node_id),b=nx(edge.target_node_id),y=90+i*66;
      return <g key={edge.edge_id} role="button" tabIndex={0} aria-label={`时序关系 ${edge.label}`} onClick={()=>select(edgeSelection(edge.edge_id))} onKeyDown={e=>{if(e.key==='Enter')select(edgeSelection(edge.edge_id));}} className={`wire ${selected===edgeSelection(edge.edge_id)?'chosen':''}`}>
        <title>{edge.label}</title><path d={a===b?`M${a},${y} h50 v25 h-50`:`M${a},${y} H${b}`} fill="none" className={`wire-line ${edge.kind}`} markerEnd="url(#sequence-arrow)"/>
        <text x={Math.min(a,b)+8} y={y-9} fill={selected===edgeSelection(edge.edge_id)?'#88edd0':'#ced8e6'} fontSize="13">{edgeNames[edge.kind]} · {edge.label.slice(0,28)}</text>
      </g>;
    })}
  </svg></div>;
}
