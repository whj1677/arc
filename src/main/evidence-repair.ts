import Ajv2020 from 'ajv/dist/2020';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Snapshot} from '../shared';
import {linesOf,readSource} from './snapshot';
import {overviewSchema,OverviewValidationError,schemaErrors} from './overview-result';

export type EvidenceDraft={evidence:{id:string}[];[key:string]:unknown};
export interface EvidenceRepairBase {draft:EvidenceDraft;ids:string[]}
type CompactAnchor={id:string;path:string;start:number;end:number;quote:string};
type SourceHint={id:string;path:string;start:number;end:number;candidates:{line:number;source_excerpt:string;quote:string}[]};

export async function evidenceSourceHints(base:EvidenceRepairBase,snapshot:Snapshot,storage:string):Promise<SourceHint[]>{
  const files=new Map<string,string[]>(),allowed=new Set(snapshot.files.map(file=>file.path));
  const anchors=base.draft.evidence as CompactAnchor[],hints:SourceHint[]=[];
  for(const anchor of anchors.filter(item=>base.ids.includes(item.id))){
    if(!allowed.has(anchor.path)||anchor.start>anchor.end||anchor.end-anchor.start>=40)continue;
    let lines=files.get(anchor.path);
    if(!lines){lines=linesOf((await readSource(storage,snapshot,anchor.path)).text);files.set(anchor.path,lines);}
    const words=new Set(anchor.quote.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]);
    const choices=lines.slice(anchor.start-1,anchor.end).flatMap((line,i)=>{
      // Quote delimiters, escapes and indentation are frequent transcription errors.
      // Every option is an actual contiguous substring; the model must choose its meaning.
      const spans=[...line.matchAll(/[\p{L}\p{N}_][^"'\x60\\\r\n]{2,95}/gu)].map(m=>m[0].trimEnd());
      const ranked=spans.map(quote=>({quote,score:(quote.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]).filter(w=>words.has(w)).length}));
      ranked.sort((a,b)=>b.score-a.score||b.quote.length-a.quote.length);
      const best=ranked[0];if(!best)return [];
      const offset=Math.max(0,line.indexOf(best.quote)-40);
      return [{score:best.score,line:anchor.start+i,source_excerpt:line.length<=200?line:line.slice(offset,offset+200),quote:best.quote}];
    });
    const candidates=choices.sort((a,b)=>b.score-a.score||a.line-b.line).slice(0,3).map(({line,source_excerpt,quote})=>({line,source_excerpt,quote}));
    if(candidates.length)hints.push({id:anchor.id,path:anchor.path,start:anchor.start,end:anchor.end,candidates});
  }
  return hints;
}

export function shrinkingEvidence(previous:string[]|undefined,remaining:string[]|undefined){
  return !!previous&&!!remaining?.length&&remaining.length<previous.length&&remaining.every(id=>previous.includes(id));
}
export const evidenceRepairSchema={
  type:'object',additionalProperties:false,required:['evidence'],
  properties:{evidence:overviewSchema.properties.evidence},
};
const validatePatch=new Ajv2020({allErrors:true,strict:false}).compile(evidenceRepairSchema);

export function applyEvidenceRepair(base:EvidenceRepairBase,patch:unknown):EvidenceDraft {
  if(!validatePatch(patch))throw new OverviewValidationError('证据补丁格式无效：'+schemaErrors(validatePatch.errors));
  const rows=(patch as {evidence:{id:string}[]}).evidence,changes=new Map(rows.map(row=>[row.id,row]));
  if(changes.size!==rows.length||rows.length!==base.ids.length||base.ids.some(id=>!changes.has(id)))
    throw new OverviewValidationError('证据补丁必须各返回一次且只返回这些 ID：'+base.ids.join('、'));
  return {...base.draft,evidence:base.draft.evidence.map(row=>changes.get(row.id)??row)};
}

// Each successful or rejected native reply keeps the exact base it was asked to patch.
export async function readRepairBase(replyFile:string,kind:'input'|'rejected'):Promise<EvidenceRepairBase|undefined>{
  try{return JSON.parse(await fs.readFile(path.join(path.dirname(replyFile),kind+'-graph-base.json'),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
export async function saveRepairBase(replyFile:string,kind:'input'|'rejected',base:EvidenceRepairBase){
  const dir=path.dirname(replyFile);
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,kind+'-graph-base.json'),JSON.stringify(base));
}
