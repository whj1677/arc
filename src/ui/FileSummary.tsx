import React from 'react';
import type {Snapshot,WorkspaceData} from '../shared';
import {filePurpose} from './file-map';
export function FileSummary({data,projectId,snapshot,path,agent}:{data:WorkspaceData;projectId:string;snapshot:Snapshot;path:string;agent:()=>void}){
 const file=snapshot.files.find(f=>f.path===path),folder=!file;
 const purpose=filePurpose(data,projectId,snapshot.source_snapshot_id,path,folder);
 const overview=data.projects.find(p=>p.project_id===projectId)?.overview_scenario_id;
 const whole=data.explanations.filter(e=>e.scenario_id===overview&&e.result.binding.source_snapshot_id===snapshot.source_snapshot_id).at(-1);
 const count=snapshot.files.filter(f=>!path||f.path.startsWith(path+'/')).length;
 return <article className="file-summary"><span className="eyebrow">{folder?'文件夹作用':'文件摘要'}</span><h2>{path?path.split('/').at(-1):'工程根目录'}</h2><p className="path">{path||snapshot.root_path}</p>
 {purpose?<><p className="file-purpose">{purpose.node.description}</p><p className="summary-state">{purpose.explanation.source_status==='current'?'来源引用 · 结论待核对':'原快照说明 · 当前目录变化需复核'}</p>{[...purpose.node.inputs,...purpose.node.outputs].map(io=><div className="io-row" key={io.io_id}><strong>{io.name}</strong><p>{io.description}</p></div>)}<details><summary>说明依据与边界</summary>{purpose.explanation.result.claims.filter(c=>purpose.node.claim_ids.includes(c.claim_id)).map(c=><div key={c.claim_id}><p>{c.statement}</p>{c.limitations.map((x,i)=><small key={i}>{x}</small>)}</div>)}{purpose.explanation.result.evidence.filter(e=>purpose.node.evidence_ids.includes(e.evidence_id)).map(e=><p className="path" key={e.evidence_id}>{e.path}:{e.line_start}–{e.line_end}</p>)}</details><details className="file-scope-meta"><summary>任务与源码绑定</summary><dl><dt>原问题</dt><dd>{data.scenarios.find(s=>s.scenario_id===purpose.explanation.scenario_id)?.title}</dd><dt>运行</dt><dd>{purpose.explanation.result.binding.run_id}</dd><dt>问题修订</dt><dd>{purpose.explanation.result.binding.question_revision_id}</dd><dt>源码快照</dt><dd>{purpose.explanation.result.binding.source_snapshot_id}</dd></dl></details></>:!path&&whole?<><p className="file-purpose">{whole.result.summary.text}</p><p className="summary-state">工程全貌说明 · {whole.source_status==='current'?'来源引用待核对':'原快照，目录变化需复核'}</p></>:<><h3>用途尚未分析</h3><p>当前快照已索引这个{folder?'文件夹':'文件'}，还没有明确的{folder?'目录作用':'整文件摘要'}。局部代码引用和文件名不能代替文件级说明。</p><button onClick={agent}>查看 Agent 接入</button></>}
 <p className="muted">{folder?`本范围索引 ${count} 个文本文件。`:`${file.line_count} 行 · ${file.encoding} · ${file.bytes} 字节。`}</p>
 </article>;
}
