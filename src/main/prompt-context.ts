import type {Snapshot,Annotation} from '../shared';

// The complete manifest remains in source-context.json, never in the initial
// model message. A page can reach every authorized file without widening scope.
export function listFrozenFiles(snapshot:Snapshot,args:{query?:string;offset?:number;limit?:number}={}) {
  if(args.query!==undefined&&typeof args.query!=='string')throw new Error('query 类型错误');
  const offset=args.offset??0,limit=args.limit??100;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('分页范围错误：offset ≥ 0，limit 为 1–100');
  const matches=snapshot.files.filter(f=>!args.query||f.path.toLowerCase().includes(args.query.toLowerCase()));
  const files=[];let size=0;
  for(const file of matches.slice(offset,offset+limit)){
    const bytes=Buffer.byteLength(JSON.stringify(file));
    if(size+bytes>120*1024)break;
    files.push(file);size+=bytes;
  }
  if(!files.length&&offset<matches.length)throw new Error('单条文件信息超过返回上限，请使用更精确的路径查询');
  const next=offset+files.length;
  return {source_snapshot_id:snapshot.source_snapshot_id,total:matches.length,offset,files,next_offset:next<matches.length?next:null,excluded_count:snapshot.excluded.length,build_config:snapshot.build_config};
}

export function promptContext(snapshot:Snapshot,annotations:Annotation[],previous?:any) {
  const clipped=(value:unknown,max:number)=>{const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length<=max?text:text.slice(0,max)+'…（上下文节选，非完整内容）';};
  const roots=new Map<string,number>();
  for(const file of snapshot.files){const root=file.path.includes('/')?file.path.split('/')[0]+'/':'根目录文件';roots.set(root,(roots.get(root)||0)+1);}
  const rootList=[...roots].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([name,count])=>({name:clipped(name,180),count}));
  const hints=snapshot.files.filter(f=>!f.path.includes('/')).slice(0,20).map(f=>clipped(f.path,180));
  const clues=annotations.slice(-12).map(a=>({text:clipped(a.text,600),source_snapshot_id:a.source_snapshot_id,object_id:a.object_id}));
  return {inventory:{total_files:snapshot.files.length,excluded_count:snapshot.excluded.length,largest_roots:rootList,root_file_hints:hints,inventory_is_partial:true},clues:{items:clues,omitted_count:Math.max(0,annotations.length-clues.length)},previous:previous?{result_id:previous.result_id,binding:previous.binding,summary_excerpt:clipped(previous.summary?.text??previous.summary,3000)}:null};
}
