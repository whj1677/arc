import type {AnalysisResult} from '../shared';
type Edge=AnalysisResult['edges'][number];
export type Point={x:number;y:number};
export type Rect=Point&{width:number;height:number};
export const flowSize={width:650,nodeWidth:200,nodeHeight:80,rowHeight:140,labelWidth:164,labelHeight:40};
export function edgeCaption(edge:Edge){
  const transfers=edge.transfers||[];
  return {text:transfers.length?transfers.map(t=>t.label).join('、'):edge.label,data:transfers.length>0,uncertain:edge.status!=='source_supported'||transfers.some(t=>t.status!=='source_supported')};
}
export function overlaps(a:Rect,b:Rect,padding=0){return a.x<b.x+b.width+padding&&a.x+a.width+padding>b.x&&a.y<b.y+b.height+padding&&a.y+a.height+padding>b.y;}
export function cubicPoint(points:Point[],t:number){const u=1-t;return {x:u*u*u*points[0].x+3*u*u*t*points[1].x+3*u*t*t*points[2].x+t*t*t*points[3].x,y:u*u*u*points[0].y+3*u*u*t*points[1].y+3*u*t*t*points[2].y+t*t*t*points[3].y};}
// A serpentine reading layout is only visual placement. Edges remain the sole
// authority for relationships; no connections are inferred from adjacency.
export function flowLayout(nodes:AnalysisResult['nodes'],edges:readonly Edge[]){
  const {width,nodeWidth,nodeHeight,rowHeight,labelWidth,labelHeight}=flowSize;
  const positions=new Map(nodes.map((n,i)=>{const row=Math.floor(i/2),column=row%2?1-i%2:i%2;return [n.node_id,{x:nodes.length===1?225:column?420:30,y:20+row*rowHeight,width:nodeWidth,height:nodeHeight}];}));
  const height=Math.ceil(nodes.length/2)*rowHeight+20;
  const occupied:Rect[]=[];
  const routes=edges.flatMap((edge,index)=>{
    const a=positions.get(edge.source_node_id),b=positions.get(edge.target_node_id);if(!a||!b)return [];
    const cy=(r:Rect)=>r.y+r.height/2,inner=(r:Rect)=>r.x<width/2?r.x+r.width:r.x;
    let points:Point[];
    if(a===b){const single=nodes.length===1,x=single?a.x+a.width:inner(a),lane=single?550:a.x<width/2?350:300;points=[{x,y:cy(a)-15},{x:lane,y:cy(a)-65},{x:lane,y:cy(a)+65},{x,y:cy(a)+15}];}
    else if(a.y===b.y){const direction=b.x>a.x?1:-1,start={x:direction>0?a.x+a.width:a.x,y:cy(a)},end={x:direction>0?b.x:b.x+b.width,y:cy(b)};points=[start,{x:start.x+direction*54,y:start.y-10},{x:end.x-direction*54,y:end.y-10},end];}
    else if(a.x===b.x&&b.y-a.y===rowHeight){const start={x:a.x+a.width/2,y:a.y+a.height},end={x:b.x+b.width/2,y:b.y};points=[start,{x:start.x+18,y:start.y+22},{x:end.x+18,y:end.y-22},end];}
    else {const lane=a.x===b.x?(a.x<width/2?360:300):325;points=[{x:inner(a),y:cy(a)},{x:lane,y:cy(a)},{x:lane,y:cy(b)},{x:inner(b),y:cy(b)}];}
    const [p,c1,c2,q]=points,d=`M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`;
    let label:(Rect&{anchor:Point})|undefined;
    for(const t of [0.5,0.38,0.62,0.25,0.75]){
      const anchor=cubicPoint(points,t);
      for(const dy of [0,-30,30,-52,52]){
        const candidate={x:anchor.x-labelWidth/2,y:anchor.y-labelHeight/2+dy,width:labelWidth,height:labelHeight};
        if(candidate.x<4||candidate.x+labelWidth>width-4||candidate.y<2||candidate.y+labelHeight>height-2)continue;
        if([...positions.values()].some(n=>overlaps(candidate,n,5))||occupied.some(r=>overlaps(candidate,r,5)))continue;
        label={...candidate,anchor};occupied.push(candidate);break;
      }
      if(label)break;
    }
    return [{edge,d,points,label,caption:edgeCaption(edge),index}];
  });
  return {width,height,positions,routes};
}
