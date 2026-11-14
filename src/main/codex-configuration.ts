import {spawn} from 'node:child_process';
import {codexChildEnvironment,JsonLines,stopTree} from './providers';

/** Read resolved project/user configuration via the CLI's own protocol. This
 * starts no model turn and retains only non-secret execution metadata. */
export async function readCodexConfiguration(program:string,cwd:string,overrides:string[]=[],validate?:(config:any)=>void):Promise<{model?:string;model_provider?:string;source:'configured'}>{
  return new Promise((resolve,reject)=>{
    const child=spawn(program,['app-server','--stdio',...overrides],{cwd,env:codexChildEnvironment(process.env),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let done=false;
    const finish=(error?:Error,value?:{model?:string;model_provider?:string;source:'configured'})=>{
      if(done)return;done=true;clearTimeout(timer);child.stdin.end();
      void stopTree(child).then(()=>error?reject(error):resolve(value!),stopError=>{if(child.exitCode!==null||child.signalCode!==null){if(error)reject(error);else resolve(value!);}else reject(error||stopError);});
    };
    const timer=setTimeout(()=>finish(Error('读取 Codex 生效配置超时')),10000);
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    const parser=new JsonLines(frame=>{
      if(frame.id===1){if(frame.error){finish(Error('Codex 配置协议初始化失败'));return;}send({jsonrpc:'2.0',method:'initialized'});send({jsonrpc:'2.0',id:2,method:'config/read',params:{cwd,includeLayers:false}});}
      if(frame.id===2){if(frame.error){finish(Error('Codex 拒绝读取配置'));return;}const config=frame.result?.config;if(!config){finish(Error('Codex 未返回有效配置'));return;}try{validate?.(config);}catch(error){finish(error as Error);return;}finish(undefined,{model:typeof config.model==='string'?config.model:undefined,model_provider:typeof config.model_provider==='string'?config.model_provider:undefined,source:'configured'});}
    });
    child.stdout.on('data',(chunk:Buffer)=>{try{parser.feed(chunk);}catch{finish(Error('Codex 配置协议输出无效'));}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.once('error',error=>finish(error));child.once('close',()=>{if(!done)finish(Error('Codex 配置进程提前退出'));});
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'arc_configuration',version:'0.1.0'}}});
  });
}
