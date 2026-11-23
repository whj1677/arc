import React from 'react';
import type {AnalysisResult,ReadingGuide,SourceEvidence} from '../shared';
import {guideItemTitle,guidePathForStep,hasCollaborationRoles,readingObjectDetail} from './feature-reading-model';
import {timelineModel} from './timeline-model';
import {BusinessDiagram,CollaborationDiagram,FilesDiagram} from './ReadingDiagrams';
import {claimNames} from './Graph';
import {SourceEditorActions} from './SourceEditorActions';

type Props={result:AnalysisResult;guide:ReadingGuide;view:string;pathId:string;selected:string;focus:string;search:string;zoom:number;onPath:(id:string)=>void;onSelect:(key:string)=>void;onNavigate:(view:string,focus?:string)=>void;onStep:(id:string)=>void};
export function FeatureReading({result,guide:g,view,pathId,selected,focus,search,zoom,onPath,onSelect,onNavigate,onStep}:Props){
  const path=g.paths.find(p=>p.id===pathId)||g.paths[0];
  if(!path)return <p className="fr-empty">这份分析尚未提供可阅读的路径。</p>;
  const ordered=!!result.reading_guide||timelineModel(result).ordered,query=search.trim().toLowerCase();
  const visibleFiles=g.files.filter(f=>!query||(f.path+f.title+f.description).toLowerCase().includes(query));
  const primary=path.files.flatMap(p=>visibleFiles.filter(f=>f.path===p)),other=visibleFiles.filter(f=>!path.files.includes(f.path));
  const common={guide:g,path,selected,search,zoom,onSelect};
  return <section className="feature-reading" aria-label={view==='timeline'?'业务流程':view==='collaboration'?'协作关系':'相关文件'}>
    <div className="fr-path-bar"><span>业务入口</span>{g.paths.length>1
      ? <nav className="architecture-view-switch" aria-label="选择业务入口">{g.paths.map(p=><button key={p.id} aria-pressed={path.id===p.id} onClick={()=>onPath(p.id)} title={p.entry}>{p.label}</button>)}</nav>
      : <strong>{path.label}</strong>}</div>
    {(focus.startsWith('step:')||hasCollaborationRoles(result))&&!!guideItemTitle(g,focus)&&<div className="fr-context"><span>接着阅读：{guideItemTitle(g,focus)}</span><button onClick={()=>focus.startsWith('step:')?onStep(focus.slice(5)):onNavigate('collaboration',focus)}>返回{focus.startsWith('step:')?'这个步骤':'这项协作'} ↗</button></div>}
    <div className="fr-heading"><h2>{view==='timeline'?'处理过程':view==='collaboration'?'参与方与交接':'文件分工'}</h2><span>{view==='timeline'?(ordered?'按执行顺序':'先后关系未确认'):view==='collaboration'?'箭头表示交接方向':'本功能引用的源码'}</span></div>
    <p className="fr-entry-caption">{path.entry}</p>
    {view==='timeline'&&<BusinessDiagram {...common} result={result} ordered={ordered}/>}
    {view==='collaboration'&&<CollaborationDiagram {...common}/>}
    {view==='files'&&<>{query&&<p className="muted">本功能内匹配到 {visibleFiles.length} 个文件</p>}<FilesDiagram files={primary} label={path.label} selected={selected} zoom={zoom} onSelect={onSelect}/>{other.length>0&&<details className="fr-other-files" key={result.result_id+path.id+!!query} open={query?true:undefined}><summary>本功能其他入口引用 · {other.length} 个文件</summary><FilesDiagram files={other} label="本功能其他入口" selected={selected} zoom={zoom} onSelect={onSelect}/></details>}</>}
    <details className="fr-coverage"><summary>路径边界与尚未确认的内容</summary><p>{path.intro}</p>{path.boundary&&<p>{path.boundary}</p>}<p>{result.summary.text}</p>{result.coverage.unresolved_scope.map((text,i)=><p key={i}>{text}</p>)}</details>
  </section>;
}

type DetailProps = {
  guide: ReadingGuide; result: AnalysisResult; selected: string; view: string; pathId?: string;
  onFile: (path: string) => void; onStep: (id: string) => void; onEdge?: (id: string) => void;
  onEvidence: (e: SourceEvidence) => void; askHere?: () => void;
};

export function FeatureReadingDetail({ guide, result, selected, view, pathId, onFile, onStep, onEdge, onEvidence, askHere }: DetailProps) {
  const detail = readingObjectDetail(result, guide, selected, pathId);
  if (!detail) return <div className="fr-detail">
    <h2>{view === 'timeline' ? '步骤详情' : view === 'collaboration' ? '协作详情' : '文件详情'}</h2>
    <p>{view === 'timeline' ? '选择处理步骤，查看规则、结果和源码依据。' : view === 'collaboration' ? '选择参与方或交接记录，查看职责与对应源码。' : '选择文件，查看引用依据并返回对应步骤。'}</p>
  </div>;

  const { item, conditions, reads, writes, next, orderedNext, gaps, unresolvedClaims, primaryEvidence, moreEvidence, files } = detail;
  const isFile = 'path' in item, isStep = 'node_ids' in item, isRole = 'duty' in item, isHandoff = 'from' in item;
  const intro = isFile ? item.description : isRole ? item.duty : isStep ? item.text : '';
  const stepTitle = (id: string) => guideItemTitle(guide, 'step:' + id);
  const relatedHandoffs = isRole
    ? guide.handoffs.filter(handoff => handoff.from === item.id || handoff.to === item.id)
    : [];
  return <div className="fr-detail" key={selected}>
    <span className="eyebrow">{isStep ? '当前选中步骤' : isFile ? '当前选中文件' : isRole ? '当前选中模块' : '当前选中交接'}</span>
    <h2>{guideItemTitle(guide, selected)}</h2>
    {isFile && <p className="fr-file-path">{item.path}</p>}
    {intro.trim() && <p>{intro}</p>}
    {conditions.length > 0 && <section>
      <h3>执行条件</h3>
      <ul className="fr-detail-list">{conditions.map(({ text, status }) => <li key={text + status}>
        {text}{status !== 'source_supported' && <small> · {claimNames[status]}</small>}
      </li>)}</ul>
    </section>}
    {(reads.length > 0 || writes.length > 0) && <section>
      <h3>读取与改变</h3>
      <dl className="fr-detail-facts">
        {reads.length > 0 && <div><dt>读取</dt><dd>{reads.join('；')}</dd></div>}
        {writes.length > 0 && <div><dt>改变</dt><dd>{writes.join('；')}</dd></div>}
      </dl>
    </section>}
    {isStep && (item.outcome.trim() || next.length > 0 || orderedNext.length > 0) && <section>
      <h3>结果与后续去向</h3>
      {item.outcome.trim() && <div className="fr-detail-outcome">{item.outcome}</div>}
      {next.map(({ edge, stepId }) => <button className="fr-detail-link" key={edge.edge_id}
        onClick={() => stepId ? onStep(stepId) : onEdge?.(edge.edge_id)}>
        → {stepId ? stepTitle(stepId) : edge.label}
        <small>{[stepId && edge.label, edge.condition, edge.status !== 'source_supported' && claimNames[edge.status]].filter(Boolean).join(' · ')}</small>
      </button>)}
      {orderedNext.map(id => <button className="fr-detail-link" key={id} onClick={() => onStep(id)}>→ 下一步 {stepTitle(id)}</button>)}
    </section>}
    {isHandoff && <>
      <p>{guideItemTitle(guide, 'role:' + item.from)} → {guideItemTitle(guide, 'role:' + item.to)} <small>· {item.kind}</small></p>
      {(item.send.trim() || item.receive.trim()) && <dl className="fr-detail-facts">
        {item.send.trim() && <div><dt>交接内容</dt><dd>{item.send}</dd></div>}
        {item.receive.trim() && <div><dt>接收结果</dt><dd>{item.receive}</dd></div>}
      </dl>}
    </>}
    {isRole && relatedHandoffs.length > 0 && <section>
      <h3>接收与交付</h3>
      <ul className="fr-detail-list">{relatedHandoffs.map(handoff => <li key={handoff.id}>
        <strong>{handoff.to === item.id ? '接收' : '交付'} · {handoff.label}</strong>
        <small>{handoff.to === item.id ? handoff.receive : handoff.send}</small>
      </li>)}</ul>
    </section>}
    {isFile && item.step_ids.length > 0 && <section>
      <h3>在哪一步用到</h3>
      {item.step_ids.map(id => <button className="fr-detail-link" key={id} onClick={() => onStep(id)}>
        {stepTitle(id)}<small>{guidePathForStep(guide, id)?.label} →</small>
      </button>)}
    </section>}
    {(gaps.length > 0 || unresolvedClaims.length > 0) && <section className="fr-detail-gap">
      <div className="row between"><h3>还没查清</h3>{askHere && <button className="quiet" onClick={askHere}>问这里</button>}</div>
      <ul className="fr-detail-list">
        {gaps.map(gap => <li key={gap.gap_id}><strong>{gap.question}</strong><small>{gap.impact}</small></li>)}
        {unresolvedClaims.map(claim => <li key={claim.claim_id}>
          <strong>{claim.statement}</strong><small>{[claimNames[claim.status], ...claim.limitations].join(' · ')}</small>
        </li>)}
      </ul>
    </section>}
    {primaryEvidence && <section className="fr-detail-source">
      <h3>源码依据</h3>
      <strong className="fr-file-path">{primaryEvidence.path}</strong>
      <small>第 {primaryEvidence.line_start}–{primaryEvidence.line_end} 行</small>
      {primaryEvidence.note && <p>{primaryEvidence.note}</p>}
      <button className="secondary" onClick={() => onEvidence(primaryEvidence)}>查看对应代码</button>
      <SourceEditorActions key={primaryEvidence.evidence_id} location={{
        source_snapshot_id: primaryEvidence.source_snapshot_id, path: primaryEvidence.path, line: primaryEvidence.line_start,
      }} />
    </section>}
    {'detail' in item && item.detail.trim() && <details className="fr-detail-more">
      <summary>完整说明</summary><p className="fr-detail-copy">{item.detail}</p>
    </details>}
    {(moreEvidence.length > 0 || files.length > 0) && <details className="fr-detail-more">
      <summary>{[moreEvidence.length > 0 && '更多依据', files.length > 0 && '相关文件'].filter(Boolean).join(' / ')}</summary>
      {moreEvidence.map(evidence => <button className="fr-detail-link" key={evidence.evidence_id} onClick={() => onEvidence(evidence)}>
        {evidence.note || evidence.path}<small>{evidence.path} · {evidence.line_start}–{evidence.line_end} 行</small>
      </button>)}
      {files.map(path => <button className="fr-detail-link" key={path} onClick={() => onFile(path)}>
        {guideItemTitle(guide, 'file:' + path) || path}<small>{path} ↗</small>
      </button>)}
    </details>}
  </div>;
}
