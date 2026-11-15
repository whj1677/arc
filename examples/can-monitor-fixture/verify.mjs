import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url)),compiler=process.env.ARC_TEST_CC||process.env.CC||'tcc';
const executable=path.join(directory,process.platform==='win32'?'test_can_monitor.exe':'test_can_monitor');
function run(command,args,stage){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.once('error',reject);child.once('close',code=>{if(stdout)process.stdout.write(stdout);if(stderr)process.stderr.write(stderr);console.log(JSON.stringify({stage,exit_code:code}));resolve(code??1);});});}
try{
  const compiled=await run(compiler,['-o',executable,'test_can_monitor.c'],'compile');if(compiled!==0)process.exitCode=compiled;
  else{const behavior=await run(executable,[],'behavior');if(behavior!==0)process.exitCode=behavior;}
}catch(error){console.error(JSON.stringify({stage:'compile_or_launch',error:error instanceof Error?error.message:String(error)}));process.exitCode=1;}
