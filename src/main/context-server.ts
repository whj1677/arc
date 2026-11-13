// A single-run MCP server. This is a read-only capability, not an Agent loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {readSource} from './snapshot';
import type {Snapshot} from '../shared';
import {listFrozenFiles} from './prompt-context';
async function main() {
const contextPath=process.argv[2];
if(!contextPath||!path.isAbsolute(contextPath))throw new Error('Explicit run context required');
const context=JSON.parse(await fs.readFile(contextPath,'utf8')) as {storage:string;snapshot:Snapshot};
const tools=[
  {name:'arc_list_files',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},description:'分页查找本次授权快照内的文件与完整 SHA-256；query 按路径过滤，next_offset 非空时可继续。',inputSchema:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
  {name:'arc_read_source',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},description:'只读指定快照内的 UTF-8 文件，返回准确行号和完整文件 SHA-256。禁止绝对路径、越界和符号链接。',inputSchema:{type:'object',properties:{path:{type:'string'},line_start:{type:'integer',minimum:1},line_count:{type:'integer',minimum:1,maximum:200}},required:['path'],additionalProperties:false}}
];
async function handle(message:any){
  const send=(result:any)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  if(message.id===undefined)return;
  try{
    if(message.method==='initialize')return send({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'arc-frozen-source',version:'0.1.0'}});
    if(message.method==='ping')return send({});
    if(message.method==='tools/list')return send({tools});
    if(message.method!=='tools/call')throw new Error('不支持的方法');
    const {name,arguments:args={}}=message.params||{};
    let result:unknown;
    if(name==='arc_list_files'){
      result=listFrozenFiles(context.snapshot,args);
    }else if(name==='arc_read_source'){
      if(typeof args.path!=='string')throw new Error('path 必须是字符串');
      const start=args.line_start??1,count=args.line_count??160;
      if(!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>200)throw new Error('行范围超出约束');
      const source=await readSource(context.storage,context.snapshot,args.path);
      result={source_snapshot_id:source.source_snapshot_id,path:source.path,content_sha256:source.content_sha256,total_lines:source.line_count,line_start:start,lines:source.text.split(/\r\n|\n|\r/).slice(start-1,start-1+count).map((text,index)=>({line:start+index,text}))};
    }else throw new Error('未知工具');
    const serialized=JSON.stringify(result);
    if(Buffer.byteLength(serialized)>256*1024)throw new Error('工具返回超过 256 KiB，请缩小行范围');
    return send({content:[{type:'text',text:serialized}]});
  }catch(e){return send({isError:true,content:[{type:'text',text:(e as Error).message}]});}
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{if(Buffer.byteLength(line)>1024*1024){process.stderr.write('Oversize MCP input\n');return;}try{void handle(JSON.parse(line));}catch{process.stderr.write('Invalid MCP JSON\n');}});
}
void main().catch(e=>{process.stderr.write((e as Error).message+'\n');process.exitCode=1;});
