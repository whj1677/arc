import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {JsonLines,redact} from '../src/main/providers';

/** Stdio JSON-RPC 2.0 connection helper. */
export class AcpConnection {
  private next=0;private pending=new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout|undefined}>();
  private failed:Error|undefined;
  private parser:JsonLines;
  constructor(readonly child:ChildProcessWithoutNullStreams,readonly update:(frame:any)=>void) {
    this.parser=new JsonLines(frame=>{
      if(frame.jsonrpc!=='2.0')throw new Error('不是 ACP JSON-RPC 2.0 帧');
      if(frame.method){this.update(frame);return;}
      const item=this.pending.get(frame.id);if(!item)return;clearTimeout(item.timer);this.pending.delete(frame.id);
      if(frame.error)item.reject(new Error(redact(JSON.stringify(frame.error))));else item.resolve(frame.result);
    });
    child.stdout.on('data',(chunk:Buffer)=>{if(this.failed)return;try{this.parser.feed(chunk);}catch(e){this.fail(e as Error);}});
    child.on('error',e=>this.fail(e));child.on('close',()=>this.fail(new Error('ACP 连接已关闭；未取得终态的任务状态未知')));
  }
  private fail(e:Error){this.failed=e;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(e);}this.pending.clear();}
  request(method:string,params:any,timeout:number|null=20000){if(this.failed)return Promise.reject(this.failed);const id=++this.next;return new Promise<any>((resolve,reject)=>{const timer=timeout===null?undefined:setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} 超时；不能据此重发任务`));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  notify(method:string,params:any){this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');}
  respond(requestId:unknown,result:unknown){this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,result})+'\n');}
}
