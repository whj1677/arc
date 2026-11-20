import React from 'react';
import type {AnalysisResult,ReadingGuide,SourceEvidence} from '../shared';
import {guideItem,guideItemTitle,guidePathForStep,hasCollaborationRoles} from './feature-reading-model';
import {timelineModel} from './timeline-model';
import {BusinessDiagram,CollaborationDiagram,FilesDiagram} from './ReadingDiagrams';

type Props={result:AnalysisResult;guide:ReadingGuide;view:string;pathId:string;selected:string;focus:string;search:string;zoom:number;onPath:(id:string)=>void;onSelect:(key:string)=>void;onNavigate:(view:string,focus?:string)=>void;onStep:(id:string)=>void};
export function FeatureReading({result,guide:g,view,pathId,selected,focus,search,zoom,onPath,onSelect,onNavigate,onStep}:Props){
  const path=g.paths.find(p=>p.id===pathId)||g.paths[0];
  if(!path)return <p className="fr-empty">这份分析尚未提供可阅读的路径。</p>;
  const ordered=!!result.reading_guide||timelineModel(result).ordered,query=search.trim().toLowerCase();
  const visibleFiles=g.files.filter(f=>!query||(f.path+f.title+f.description).toLowerCase().includes(query));
  const primary=path.files.flatMap(p=>visibleFiles.filter(f=>f.path===p)),other=visibleFiles.filter(f=>!path.files.includes(f.path));
  const collaborationLink=hasCollaborationRoles(result)&&<button onClick={()=>onNavigate('collaboration')}>协作关系 →</button>;
  const common={guide:g,path,selected,search,zoom,onSelect};
  return <section className="feature-reading" aria-label={view==='timeline'?'业务流程':view==='collaboration'?'协作关系':'相关文件'}>
    <nav className="fr-paths" aria-label="选择业务入口">{g.paths.map(p=><button key={p.id} aria-pressed={path.id===p.id} onClick={()=>onPath(p.id)} title={p.entry}><strong>{p.label}</strong></button>)}</nav>
    {(focus.startsWith('step:')||hasCollaborationRoles(result))&&!!guideItemTitle(g,focus)&&<div className="fr-context"><span>接着阅读：{guideItemTitle(g,focus)}</span><button onClick={()=>focus.startsWith('step:')?onStep(focus.slice(5)):onNavigate('collaboration',focus)}>返回{focus.startsWith('step:')?'这个步骤':'这项协作'} ↗</button></div>}
    <div className="fr-heading"><h2>{view==='timeline'?'一次操作，如何走到结果':view==='collaboration'?'谁与谁配合，交接什么':path.label+' · 文件分工'}</h2><span>{view==='timeline'?(ordered?'从左往右 → 先后顺序':'先后关系未确认 · 不连顺序线'):view==='collaboration'?'箭头表示交接方向 · 不表示执行顺序':'只展示本功能引用的文件'}</span></div>
    <p className="fr-entry-caption">{path.entry}</p>
    {view==='timeline'&&<><BusinessDiagram {...common} result={result} ordered={ordered}/><div className="fr-next">{collaborationLink}<button onClick={()=>onNavigate('files')}>相关文件 →</button></div></>}
    {view==='collaboration'&&<><CollaborationDiagram {...common}/><div className="fr-next"><button onClick={()=>onNavigate('timeline')}>业务时间图 →</button><button onClick={()=>onNavigate('files')}>相关文件 →</button></div></>}
    {view==='files'&&<>{query&&<p className="muted">本功能内匹配到 {visibleFiles.length} 个文件</p>}<FilesDiagram files={primary} label={path.label} selected={selected} zoom={zoom} onSelect={onSelect}/>{other.length>0&&<details className="fr-other-files" key={result.result_id+path.id+!!query} open={query?true:undefined}><summary>本功能其他入口引用 · {other.length} 个文件</summary><FilesDiagram files={other} label="本功能其他入口" selected={selected} zoom={zoom} onSelect={onSelect}/></details>}<div className="fr-next"><button onClick={()=>onNavigate('timeline')}>业务时间图 →</button>{collaborationLink}</div></>}
    <details className="fr-coverage"><summary>路径边界与尚未确认的内容</summary><p>{path.intro}</p>{path.boundary&&<p>{path.boundary}</p>}<p>{result.summary.text}</p>{result.coverage.unresolved_scope.map((text,i)=><p key={i}>{text}</p>)}</details>
  </section>;
}

type DetailProps={guide:ReadingGuide;result:AnalysisResult;selected:string;view:string;onFile:(path:string)=>void;onStep:(id:string)=>void;onEvidence:(e:SourceEvidence)=>void};
export function FeatureReadingDetail({guide:g,result,selected,view,onFile,onStep,onEvidence}:DetailProps){
  const item=guideItem(g,selected);
  if(!item)return <div className="fr-detail"><span className="eyebrow">阅读方式</span><h2>{view==='timeline'?'顺着时间图读一次操作':view==='collaboration'?'看清职责如何配合':'找到文件在功能中的作用'}</h2><p>{view==='timeline'?'先选择业务入口，再从左往右读触发、处理和结果。点击步骤查看补充规则和依据。':view==='collaboration'?'节点表示参与方，箭头表示交接。点节点看职责，点连线看传递内容和对应文件。':'每个文件保留一条用途描述。点击后可看补充边界、引用依据，并返回对应业务步骤。'}</p></div>;
  const isFile='path' in item,isStep='node_ids' in item,isRole='duty' in item,isHandoff='from' in item;
  const files=isFile?[]:isRole?item.files:isHandoff?[...new Set(g.roles.filter(r=>r.id===item.from||r.id===item.to).flatMap(r=>r.files))]:[...new Set(result.evidence.filter(e=>item.evidence_ids.includes(e.evidence_id)).map(e=>e.path))];
  return <div className="fr-detail"><span className="eyebrow">{isFile?'文件说明':isStep?'步骤与条件':isRole?'职责落点':'交接说明'}</span><h2>{guideItemTitle(g,selected)}</h2>{isFile&&<p className="fr-file-path">{item.path}</p>}<p>{isFile?item.description:isRole?item.duty:isStep?item.text:item.send}</p>{'detail' in item&&item.detail&&<p className="fr-detail-copy">{item.detail}</p>}{isStep&&<div className="fr-detail-outcome">{item.outcome}</div>}{isHandoff&&<p><strong>得到的结果：</strong>{item.receive}</p>}
    {isFile&&item.step_ids.length>0&&<><h3>在哪一步用到</h3>{item.step_ids.map(id=><button className="fr-detail-link" key={id} onClick={()=>onStep(id)}>{g.steps.find(s=>s.id===id)?.title}<small>{guidePathForStep(g,id)?.label} →</small></button>)}</>}
    {files.length>0&&<><h3>相关文件</h3>{files.map(path=><button className="fr-detail-link" key={path} onClick={()=>onFile(path)}>{g.files.find(f=>f.path===path)?.title||path}<small>{path} ↗</small></button>)}</>}
    <h3>这条说明的依据</h3>{result.evidence.filter(e=>item.evidence_ids.includes(e.evidence_id)).map(e=><button className="fr-detail-link" key={e.evidence_id} onClick={()=>onEvidence(e)}>{e.note||e.path}<small>{e.path} · {e.line_start}–{e.line_end} 行</small></button>)}
  </div>;
}
