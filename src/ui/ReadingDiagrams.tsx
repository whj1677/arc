import React,{useEffect,useRef,useState,useId} from 'react';
import type {AnalysisResult,ReadingGuide} from '../shared';
import {readingFailureLinks,readingCollaboration} from './reading-diagram-model';

export const shortLabel=(text:string,length=24)=>text.length>length?text.slice(0,length-1)+'…':text;
export function Diagram({width,height,zoom,label,children,header}:{width:number;height:number;zoom:number;label:string;children:React.ReactNode;header?:React.ReactNode}){
  const root=useRef<HTMLDivElement>(null),[available,setAvailable]=useState(800);
  useEffect(()=>{if(!root.current)return;const o=new ResizeObserver(es=>setAvailable(es[0].contentRect.width));o.observe(root.current);return()=>o.disconnect();},[]);
  const scale=Math.max(.85,Math.min(1,available/width))*zoom;
  return <div className={'reading-diagram-frame'+(header?' function-time-scroll':'')} ref={root}>{header&&<svg className="function-time-header" data-zoom-surface width={width*scale} height={98*scale} viewBox={`0 0 ${width} 98`} role="group" aria-label="函数节点">{header}</svg>}<svg data-zoom-surface className="reading-diagram" width={width*scale} height={(height-(header?98:0))*scale} viewBox={`0 ${header?98:0} ${width} ${height-(header?98:0)}`} role="group" aria-label={label}>{children}</svg></div>;
}
type Common={guide:ReadingGuide;path:ReadingGuide['paths'][number];selected:string;search:string;zoom:number;onSelect:(key:string)=>void};
function Arrow({id}:{id:string}){return <defs><marker id={id} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="context-stroke"/></marker></defs>;}

export function BusinessDiagram({result,guide:g,path,selected,search,zoom,onSelect,ordered}:Common&{result:AnalysisResult;ordered:boolean}){
  const marker='business-'+useId().replace(/:/g,''),query=search.toLowerCase();
  const rows=[...(path.step_ids.length?[{label:path.lanes.length?'共同起点':'',step_ids:path.step_ids,link_labels:[] as readonly string[]}]:[]),...path.lanes];
  const width=Math.max(660,...rows.map(r=>r.step_ids.length*162+12)),failureTop=rows.length*210+82;
  const failures=g.steps.filter(s=>path.failure_ids.includes(s.id));
  const links=readingFailureLinks(result,g,path),height=failures.length?failureTop+Math.ceil(failures.length/3)*160:rows.length*210+10;
  const box=(row:number,col:number)=>({x:16+col*162,y:30+row*210,width:136,height:144});
  const positions=new Map<string,ReturnType<typeof box>>();rows.forEach((r,ri)=>r.step_ids.forEach((id,ci)=>{if(!positions.has(id))positions.set(id,box(ri,ci));}));
  const failureBox=(i:number)=>({x:20+(i%3)*(width/3),y:failureTop+Math.floor(i/3)*160,width:Math.min(220,width/3-28),height:106});
  return <Diagram width={width} height={height} zoom={zoom} label="业务时间图与失败分支"><Arrow id={marker}/>
    {rows.map((row,ri)=><g key={ri}>{row.label&&<text className="diagram-row-title" x="16" y={18+ri*210}>{row.label}</text>}{row.step_ids.map((id,ci)=>{const s=g.steps.find(s=>s.id===id);if(!s)return null;const b=box(ri,ci),dim=query&&![s.title,s.text,s.detail,s.outcome].join(' ').toLowerCase().includes(query);return <g key={id}>
      {ordered&&ci<row.step_ids.length-1&&<g><path className="diagram-link" d={`M${b.x+b.width} ${b.y+71} H${b.x+162-3}`} markerEnd={`url(#${marker})`}/>{row.link_labels[ci]&&<text className="diagram-edge-label" x={b.x+b.width+13} y={b.y+164} textAnchor="middle"><title>{row.link_labels[ci]}</title>{shortLabel(row.link_labels[ci],12)}</text>}</g>}
      <foreignObject data-zoom-anchor x={b.x} y={b.y} width={b.width} height={b.height}><button className={`diagram-node business-node ${selected==='step:'+id?'selected':''} ${dim?'diagram-dim':''}`} data-reading-step={id} onClick={()=>onSelect('step:'+id)} title={s.text}><small>{ordered?String(ci+1).padStart(2,'0')+' · ':''}{s.actor}</small><strong>{s.title}</strong><span title={s.outcome}>{shortLabel(s.outcome,19)}</span></button></foreignObject>
    </g>;})}</g>)}
    {links.map((link,i)=>{const a=positions.get(link.from),bi=failures.findIndex(s=>s.id===link.to);if(!a||bi<0)return null;const b=failureBox(bi),sx=a.x+a.width/2,sy=a.y+a.height,tx=b.x+b.width/2,ty=b.y;return <g key={link.id} className="business-exception"><path className="diagram-link" d={`M${sx} ${sy} V${sy+25+i*12} H${tx} V${ty-4}`} markerEnd={`url(#${marker})`}/><foreignObject x={tx-b.width/2} y={ty-35-i*3} width={b.width} height="28"><button className="diagram-condition" onClick={()=>onSelect('step:'+link.to)} title={link.label}>{shortLabel(link.label,19)}</button></foreignObject></g>;})}
    {failures.map((s,i)=>{const b=failureBox(i);return <foreignObject key={s.id} data-zoom-anchor x={b.x} y={b.y} width={b.width} height={b.height}><button className={`diagram-node failure-node ${selected==='step:'+s.id?'selected':''}`} onClick={()=>onSelect('step:'+s.id)} title={s.text}><small>分支 · {links.some(l=>l.to===s.id)?s.actor:'触发位置尚未明确'}</small><strong>{s.title}</strong><span>{shortLabel(s.outcome,24)}</span></button></foreignObject>;})}
  </Diagram>;
}

export function CollaborationDiagram({guide:g,path,selected,search,zoom,onSelect}:Common){
  const marker='handoff-'+useId().replace(/:/g,''),{roles,handoffs}=readingCollaboration(g,path),query=search.toLowerCase();
  if(!roles.length)return <p className="fr-empty">本分析尚未明确参与方。</p>;
  // Place each role once. Vertical placement is spatial grouping, not time.
  const cols=roles.length<3?roles.length:3,width=760,rowHeight=290,height=Math.max(350,Math.ceil(roles.length/3)*rowHeight+30);
  const positions=new Map(roles.map((r,i)=>[r.id,{x:28+(i%cols)*(700/cols),y:roles.length===3&&i===1?215:30+Math.floor(i/cols)*rowHeight,w:190,h:112}]));
  return <Diagram width={width} height={height} zoom={zoom} label="参与方职责与交接图"><Arrow id={marker}/>
    {handoffs.map((h,i)=>{const a=positions.get(h.from)!,b=positions.get(h.to)!,same=a===b,down=b.y>a.y,up=b.y<a.y;
      const sx=a.x+a.w/2,sy=a.y+a.h,tx=b.x+b.w/2,ty=down?b.y:up?b.y+b.h:b.y+b.h;
      const startY=up?a.y:sy,bend=down||up?(startY+ty)/2:Math.max(sy,ty)+60+i*38;
      const d=same?`M${a.x+a.w} ${a.y+30} c65 -40 65 95 0 60`:down||up?`M${sx} ${down?sy:a.y} C${sx} ${bend} ${tx} ${bend} ${tx} ${ty}`:`M${sx} ${sy} C${sx} ${bend} ${tx} ${bend} ${tx} ${ty}`;
      const lx=same?a.x+a.w+12:(sx+tx)/2,ly=down||up?(startY+ty)/2:sy+(bend-sy)*.75;
      const dim=query&&![h.label,h.send,h.receive,h.detail].join(' ').toLowerCase().includes(query);
      return <g key={h.id} className={`handoff-connection ${selected==='handoff:'+h.id?'selected':''} ${dim?'diagram-dim':''}`} role="button" tabIndex={0} onClick={()=>onSelect('handoff:'+h.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect('handoff:'+h.id);}}} aria-label={`${roles.find(r=>r.id===h.from)?.title} → ${roles.find(r=>r.id===h.to)?.title}：${h.label}`}><title>{[h.label,h.send,h.receive,h.detail].filter(Boolean).join('\n')}</title><path className="diagram-hit" d={d}/><path className="diagram-link" d={d} markerEnd={`url(#${marker})`}/><foreignObject x={lx-88} y={ly-26} width="176" height="55"><div className="handoff-label"><strong>{shortLabel(h.label,15)}</strong><small>{shortLabel(h.send,18)}</small></div></foreignObject></g>;
    })}
    {roles.map(r=>{const b=positions.get(r.id)!;return <foreignObject key={r.id} data-zoom-anchor x={b.x} y={b.y} width={b.w} height={b.h}><button className={`diagram-node role-node ${selected==='role:'+r.id?'selected':''} ${query&&!(r.title+r.duty).toLowerCase().includes(query)?'diagram-dim':''}`} onClick={()=>onSelect('role:'+r.id)} title={r.duty}><small>参与方</small><strong>{r.title}</strong><span>{shortLabel(r.duty,32)}</span></button></foreignObject>;})}
  </Diagram>;
}

export function FilesDiagram({files,label,selected,zoom,onSelect}:{files:ReadingGuide['files'];label:string;selected:string;zoom:number;onSelect:(key:string)=>void}){
  if(!files.length)return <p className="fr-empty">当前路径没有匹配文件。</p>;
  const height=Math.max(150,files.length*136),rootY=Math.min(240,height/2),width=760;
  return <Diagram width={width} height={height} zoom={zoom} label="本功能相关文件与职责导图">
    <path className="file-trunk" d={`M224 ${rootY} H268 M268 63 V${(files.length-1)*136+63}`}/>
    {files.map((f,i)=><g key={f.path}><path className="file-trunk" d={`M268 ${i*136+63} H310`}/><foreignObject data-zoom-anchor x="310" y={i*136+6} width="434" height="116"><button className={`diagram-node file-node ${selected==='file:'+f.path?'selected':''}`} data-file-path={f.path} onClick={()=>onSelect('file:'+f.path)} title={f.path+'\n'+f.description}><div><strong>{f.title}</strong><small>{f.path.split('/').at(-1)}</small></div><span>{shortLabel(f.description,70)}</span><small className="file-directory">{f.path.split('/').slice(0,-1).join('/')}</small></button></foreignObject></g>)}
    <foreignObject x="10" y={rootY-48} width="214" height="96"><div className="file-map-root"><small>相关文件 · {files.length}</small><strong>{label}</strong><span>连线表示本路径引用</span></div></foreignObject>
  </Diagram>;
}
