import type {AnalysisResult} from '../shared';

// Layout uses only declared containment and relationships; positions add no
// execution order, service boundary or new connection to the analysis.
export function architectureMap(result:AnalysisResult,search=''){
 const all=(result.architecture?.node_ids||[]).map(id=>result.nodes.find(n=>n.node_id===id)).filter(n=>!!n);
 const allIds=new Set(all.map(n=>n.node_id));
 const relationships=(result.architecture?.edge_ids||[]).map(id=>result.edges.find(e=>e.edge_id===id)).filter((e):e is AnalysisResult['edges'][number]=>!!e&&allIds.has(e.source_node_id)&&allIds.has(e.target_node_id));
 const q=search.trim().toLowerCase(),match=new Set(all.filter(n=>`${n.label} ${n.description}`.toLowerCase().includes(q)).map(n=>n.node_id));
 if(q)for(const e of relationships)if(e.label.toLowerCase().includes(q)){match.add(e.source_node_id);match.add(e.target_node_id);}
 // Keep declared ancestors so a search cannot silently turn an internal module
 // into an independent service.
 for(const id of [...match]){let n=all.find(n=>n.node_id===id);const seen=new Set<string>();while(n?.parent_node_id&&allIds.has(n.parent_node_id)&&!seen.has(n.parent_node_id)){seen.add(n.parent_node_id);match.add(n.parent_node_id);n=all.find(p=>p.node_id===n!.parent_node_id);}}
 const nodes=all.filter(n=>!q||match.has(n.node_id)),ids=new Set(nodes.map(n=>n.node_id));
 const edges=relationships.filter(e=>ids.has(e.source_node_id)&&ids.has(e.target_node_id));
 const owner=(id:string)=>{let n=nodes.find(n=>n.node_id===id)!;const seen=new Set([id]);while(n.parent_node_id&&ids.has(n.parent_node_id)&&!seen.has(n.parent_node_id)){seen.add(n.parent_node_id);n=nodes.find(p=>p.node_id===n.parent_node_id)!;}return n.node_id;};
 const groups=new Map<string,typeof nodes>();for(const n of nodes){const root=owner(n.node_id);groups.set(root,[...(groups.get(root)||[]),n]);}
 for(const [id,members]of groups)groups.set(id,[...members].sort((a,b)=>a.node_id===id?-1:b.node_id===id?1:0));
 const score=(id:string)=>edges.filter(e=>owner(e.source_node_id)===id||owner(e.target_node_id)===id).length+(groups.get(id)!.length-1)*2;
 const hub=[...groups.keys()].sort((a,b)=>score(b)-score(a))[0];
 const left:string[]=[],right:string[]=[];
 for(const id of groups.keys()){if(id===hub)continue;const touching=edges.filter(e=>(owner(e.source_node_id)===id&&owner(e.target_node_id)===hub)||(owner(e.target_node_id)===id&&owner(e.source_node_id)===hub));const toward=touching.some(e=>owner(e.source_node_id)===id),from=touching.some(e=>owner(e.source_node_id)===hub);const internalOnly=touching.length>0&&touching.every(e=>e.source_node_id!==hub&&e.target_node_id!==hub);(internalOnly||(toward&&!from)?left:right).push(id);}
 const groupHeight=(id:string)=>groups.get(id)!.length*78+(groups.get(id)!.length-1)*54;
 const stackHeight=(list:string[])=>list.reduce((sum,id)=>sum+groupHeight(id),0)+Math.max(0,list.length-1)*54;
 // Side placement is spatial, not data direction. Avoid a tall one-sided
 // fan-out hiding most collaborators below the fold; keep each parent group
 // intact and retain every arrow's original source/target.
 for(let i=0;i<groups.size;i++){
  const from=stackHeight(right)>stackHeight(left)?right:left,to=from===right?left:right;
  const before=Math.max(stackHeight(left),stackHeight(right));
  const move=from.map((id,index)=>({id,index,height:Math.max(stackHeight(from.filter(v=>v!==id)),stackHeight([...to,id]))})).sort((a,b)=>a.height-b.height||b.index-a.index)[0];
  if(!move||move.height>=before)break;
  from.splice(move.index,1);to.push(move.id);
 }
 const height=Math.max(360,stackHeight(left)+64,stackHeight(right)+64,hub?groupHeight(hub)+64:0);
 const boxes=new Map<string,{x:number;y:number;width:number;height:number}>(),boundaries:{id:string;x:number;y:number;width:number;height:number}[]=[];
 function place(id:string,x:number,y:number){const members=groups.get(id)!;members.forEach((n,i)=>boxes.set(n.node_id,{x:x+(i?12:0),y:y+i*132,width:196-(i?24:0),height:78}));if(members.length>1)boundaries.push({id,x:x-14,y:y-16,width:224,height:groupHeight(id)+32});}
 function stack(list:string[],x:number){let y=(height-stackHeight(list))/2;for(const id of list){place(id,x,y);y+=groupHeight(id)+54;}}
 stack(left,24);stack(right,660);if(hub)place(hub,342,(height-groupHeight(hub))/2);
 const pairs=new Map<string,typeof edges>();for(const e of edges){const key=[e.source_node_id,e.target_node_id].sort().join('\0');pairs.set(key,[...(pairs.get(key)||[]),e]);}
 return {nodes,edges,boxes,boundaries,pairs:[...pairs.values()],hub,width:880,height};
}
