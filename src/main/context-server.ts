// A single-run MCP server for frozen-source reads and optional result staging.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import Ajv from 'ajv';
import {linesOf,readSource,relativePath} from './snapshot';
import {analysisBudget,type Snapshot} from '../shared';
import {listFrozenFiles} from './prompt-context';
import {getCodeIndex} from './code-index';
import {getCallGraph,listModules,listSymbols} from './code-index-query';
async function main() {
const contextPath=process.argv[2];
if(!contextPath||!path.isAbsolute(contextPath))throw new Error('Explicit run context required');
const context=JSON.parse(await fs.readFile(contextPath,'utf8')) as {storage:string;snapshot:Snapshot;resultSchema?:object};
const discovery=process.argv[3]==='overview-discovery';
const {discovery:overviewDiscoveryBudget,discoveryMinutes}=analysisBudget(context.snapshot);
const discoveryDeadline=Date.now()+discoveryMinutes*60000;
let remainingCalls:number=overviewDiscoveryBudget.calls;
const resultSchema=context.resultSchema;
const ajv=new Ajv();
let indexPromise:ReturnType<typeof getCodeIndex>|undefined;
const index=()=>indexPromise??=getCodeIndex(context.storage,context.snapshot).catch(error=>{indexPromise=undefined;throw error;});
const searchSchema={
  type:'object',
  properties:{
    query:{type:'string',minLength:1,maxLength:200},
    path:{type:'string'},
    path_prefix:{type:'string'},
    case_sensitive:{type:'boolean'},
    limit:{type:'integer',minimum:1,maximum:60},
  },
  required:['query'],additionalProperties:false,
};
const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const paging={offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}};
const text={type:'string',minLength:1};
const tools=[
  {name:'arc_list_files',annotations:readOnly,description:'分页查找本次授权快照内的文件与完整 SHA-256；query 按路径过滤，next_offset 非空时可继续。',inputSchema:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
  {name:'arc_search_source',annotations:readOnly,description:'在冻结 UTF-8 源码中按字面文本搜索，返回文件路径、准确行号和完整文件 SHA-256。可限定文件或路径前缀，默认忽略大小写。',inputSchema:searchSchema},
  {name:'arc_read_source',annotations:readOnly,description:'只读指定快照内的 UTF-8 文件，返回准确行号和完整文件 SHA-256。禁止绝对路径、越界和符号链接。',inputSchema:{type:'object',properties:{path:{type:'string'},line_start:{type:'integer',minimum:1},line_count:{type:'integer',minimum:1,maximum:400}},required:['path'],additionalProperties:false}},
  {name:'list_modules',annotations:readOnly,description:'分页查看冻结索引中的目录、文件数量和样本、关键符号及跨目录调用数。可按 dir 缩小模块范围。files_truncated 为 true 时，用 list_symbols(dir) 或 arc_list_files(query) 继续查全。',inputSchema:{type:'object',properties:{dir:text,...paging},additionalProperties:false}},
  {name:'list_symbols',annotations:readOnly,description:'按目录 dir、精确文件 path、名称子串 query、类型 kind 过滤冻结符号。返回精确文件和定义行、签名及可用于调用图查询的 id。',inputSchema:{type:'object',properties:{dir:text,path:text,query:text,kind:{enum:['function','method','constructor','destructor','class','struct','interface']},...paging},additionalProperties:false}},
  {name:'get_call_graph',annotations:readOnly,description:'按符号名、限定名或索引 id 查询调用图。可指定 file 消除歧义；每条边包含调用位置和解析到的定义位置。未解析的调用没有 targets。depth 默认为 2，direction 默认为 both。',inputSchema:{type:'object',properties:{symbol:text,file:text,direction:{enum:['outgoing','incoming','both']},depth:{type:'integer',minimum:1,maximum:3},...paging},required:['symbol'],additionalProperties:false}},
  ...(resultSchema?[{name:'arc_submit_result',description:'提交本轮符合合同的完整结果。ARC 将在会话结束后核验并处理；此工具不会修改工程文件。',inputSchema:resultSchema}]:[]),
];
const validators=new Map(tools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
function validateArguments(name:string,args:unknown) {
  const validate=validators.get(name);
  if(!validate)throw new Error('未知工具');
  if(!validate(args))throw new Error('工具参数不匹配：'+ajv.errorsText(validate.errors));
}
async function handle(message:any){
  const send=(result:any)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  if(message.id===undefined)return;
  let reserved=false;
  try{
    if(message.method==='initialize')return send({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'arc-frozen-source',version:'0.1.0'}});
    if(message.method==='ping')return send({});
    if(message.method==='tools/list')return send({tools});
    if(message.method!=='tools/call')throw new Error('不支持的方法');
    const {name,arguments:args={}}=message.params||{};
    validateArguments(name,args);
    let result:object;
    if(discovery&&name!=='arc_submit_result'){
      if(Date.now()>=discoveryDeadline)throw Error(`首轮取证已达到 ${discoveryMinutes} 分钟预算；请用已读源码生成 overview-1 JSON，将未查证的部分写入 unresolved。`);
      if(remainingCalls===0)throw Error('首轮取证预算已用完；用已取得的源码立即输出 overview-1 JSON，将未查证的部分写入 unresolved。');
      if(remainingCalls<=2&&name!=='arc_read_source')throw Error('剩余取证预算只用于 arc_read_source；直接读取已定位的入口，或立即输出 overview-1 JSON。');
      // Reserve the call before doing asynchronous I/O, including parallel requests.
      remainingCalls--;
      reserved=true;
    }
    if(name==='arc_list_files'){
      result=listFrozenFiles(context.snapshot,args);
    }else if(name==='arc_search_source'){
      const {query,path:file,path_prefix:prefix='',case_sensitive:caseSensitive=false,limit=30}=args;
      if(prefix)relativePath(prefix.replace(/\/$/,''));
      const files=file!==undefined?[file]:context.snapshot.files
        .filter(entry=>(!entry.encoding||entry.encoding==='utf-8')&&entry.path.startsWith(prefix))
        .map(entry=>entry.path);
      if(discovery&&files.length>overviewDiscoveryBudget.searchFiles){
        throw Error(`搜索会扫描 ${files.length} 个文件，首轮每次最多 ${overviewDiscoveryBudget.searchFiles} 个。请指定 path 或更精确的 path_prefix。`);
      }
      const needle=caseSensitive?query:query.toLowerCase();
      const matches:{path:string;content_sha256:string;line:number;text:string}[]=[];
      let truncated=false;
      search: for(const file of files){
        const source=await readSource(context.storage,context.snapshot,file);
        const lines=linesOf(source.text);
        for(const [index,lineText] of lines.entries()){
          if(!(caseSensitive?lineText:lineText.toLowerCase()).includes(needle))continue;
          if(matches.length===limit){
            truncated=true;
            break search;
          }
          matches.push({path:source.path,content_sha256:source.content_sha256,line:index+1,text:lineText.slice(0,300)});
        }
      }
      result={source_snapshot_id:context.snapshot.source_snapshot_id,query,matches,truncated};
    }else if(name==='arc_read_source'){
      const start=args.line_start??1,count=args.line_count??160;
      const source=await readSource(context.storage,context.snapshot,args.path);
      if(start>Math.max(1,source.line_count))throw new Error(`起始行超过文件行数 ${source.line_count}`);
      const lineCount=discovery?Math.min(count,overviewDiscoveryBudget.readLines):count;
      result={source_snapshot_id:source.source_snapshot_id,path:source.path,content_sha256:source.content_sha256,total_lines:source.line_count,line_start:start,lines:linesOf(source.text).slice(start-1,start-1+lineCount).map((text,index)=>({line:start+index,text}))};
    }else if(name==='list_modules'){
      result={source_snapshot_id:context.snapshot.source_snapshot_id,...listModules(await index(),args)};
    }else if(name==='list_symbols'){
      result={source_snapshot_id:context.snapshot.source_snapshot_id,...listSymbols(await index(),args)};
    }else if(name==='get_call_graph'){
      result={source_snapshot_id:context.snapshot.source_snapshot_id,...getCallGraph(await index(),args)};
    }else if(name==='arc_submit_result'){
      const data=JSON.stringify(args);
      if(Buffer.byteLength(data)>2*1024*1024)throw Error('结果超过 2 MiB');
      await fs.writeFile(path.join(path.dirname(contextPath),'submitted-result.json'),data,{flag:'wx'});
      result={saved:true};
    }else throw new Error('未知工具');
    const serialized=JSON.stringify(discovery?{...result,remaining_source_calls:remainingCalls}:result);
    if(Buffer.byteLength(serialized)>256*1024)throw new Error('工具返回超过 256 KiB，请减少 limit 或缩小取证范围');
    return send({content:[{type:'text',text:serialized}]});
  }catch(e){
    if(reserved)remainingCalls++;
    return send({isError:true,content:[{type:'text',text:(e as Error).message+(discovery?` 剩余取证调用 ${remainingCalls} 次。`:'')}]});
  }
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const inputLimit=(resultSchema?4:1)*1024*1024;
input.on('line',line=>{if(Buffer.byteLength(line)>inputLimit){process.stderr.write('Oversize MCP input\n');return;}try{void handle(JSON.parse(line));}catch{process.stderr.write('Invalid MCP JSON\n');}});
}
void main().catch(e=>{process.stderr.write((e as Error).message+'\n');process.exitCode=1;});
