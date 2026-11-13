import type {SourceFile,WorkspaceData} from '../shared';
export interface FileTopic {path:string;name:string;folder:boolean;children:FileTopic[];count:number}
export function fileIndex(files:readonly SourceFile[]){
 const root:FileTopic={path:'',name:'工程根目录',folder:true,children:[],count:0},index=new Map<string,FileTopic>([['',root]]);
 for(const f of files){let parent=root;const parts=f.path.split('/');for(let i=0;i<parts.length;i++){const path=parts.slice(0,i+1).join('/');let item=index.get(path);if(!item){item={path,name:parts[i],folder:i<parts.length-1,children:[],count:0};index.set(path,item);parent.children.push(item);}if(item.folder)item.count++;parent=item;}root.count++;}
 for(const node of index.values())node.children.sort((a,b)=>Number(b.folder)-Number(a.folder)||a.name.localeCompare(b.name));return {root,index};
}
export function filePurpose(data:WorkspaceData,projectId:string,snapshotId:string,path:string,folder:boolean){
 return data.explanations.filter(e=>e.result.binding.project_id===projectId&&e.result.binding.source_snapshot_id===snapshotId).toSorted((a,b)=>b.created_at.localeCompare(a.created_at)).flatMap(explanation=>explanation.result.nodes.filter(n=>n.source_scope?.kind===(folder?'folder':'file')&&n.source_scope.path===path).map(node=>({node,explanation}))).at(0);
}
