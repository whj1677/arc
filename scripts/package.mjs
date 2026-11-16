// Build a directory distribution in staging, verify its executable entry, then replace the current package.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';
await fs.mkdir('release',{recursive:true});
const releaseRoot=await fs.realpath('release'),runtime=path.resolve('node_modules/electron/dist'),out=path.join(releaseRoot,'Arc-win32-x64'),stage=path.join(releaseRoot,'.arc-staging'),previous=path.join(releaseRoot,'.arc-replaced'),data=path.resolve('.test-data/package-entry-check');
async function removeGenerated(target){const resolved=await fs.realpath(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!resolved)return;if(![stage,previous,data].includes(resolved)|| (await fs.lstat(target)).isSymbolicLink())throw Error('Unexpected generated package path');await fs.rm(target,{recursive:true,force:false});}
await fs.access(path.join(runtime,'electron.exe'));
await removeGenerated(stage);await fs.mkdir(stage,{recursive:true});
await fs.cp(runtime,stage,{recursive:true,filter:source=>path.basename(source)!=='electron.exe'});await fs.copyFile(path.join(runtime,'electron.exe'),path.join(stage,'Arc.exe'));
const app=path.join(stage,'resources','app');await fs.mkdir(app,{recursive:true});
for(const folder of ['dist','contracts','examples'])await fs.cp(folder,path.join(app,folder),{recursive:true,filter:source=>!source.endsWith('.map')});
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
await fs.writeFile(path.join(app,'package.json'),JSON.stringify({name:'arc-desktop',productName:'Arc',version,main:'dist/main.cjs',private:true}));
await fs.copyFile('docs/DISTRIBUTION.txt',path.join(stage,'运行说明.txt'));
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const info={product:'Arc',version,platform:'win32',arch:'x64',electron:JSON.parse(await fs.readFile('node_modules/electron/package.json','utf8')).version,signed:false,git_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_modified:!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),main_sha256:await hash(path.join(app,'dist/main.cjs')),exe_sha256:await hash(path.join(stage,'Arc.exe')),built_at:new Date().toISOString()};
await fs.writeFile(path.join(stage,'BUILD-INFO.json'),JSON.stringify(info,null,2));
console.log('Checking packaged executable entry…');
const env={...process.env,ARC_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let check;try{check=await electron.launch({executablePath:path.join(stage,'Arc.exe'),env,timeout:30000});const page=await check.firstWindow();await page.getByRole('button',{name:'打开并理解工程',exact:true}).waitFor({timeout:15000});const status=await page.evaluate(()=>window.arc.invoke('settings'));if(status.version!==version)throw Error('Packaged entry version mismatch');}finally{await check?.close();}
await removeGenerated(previous);await fs.mkdir(path.dirname(out),{recursive:true});
async function renameClosedPackage(from,to){for(let attempt=0;;attempt++){try{return await fs.rename(from,to);}catch(error){if(!['EPERM','EBUSY'].includes(error.code)||attempt===10)throw error;await new Promise(resolve=>setTimeout(resolve,500));}}}
let replaced=false;try{await renameClosedPackage(out,previous);replaced=true;}catch(e){if(e.code!=='ENOENT')throw e;}
try{await renameClosedPackage(stage,out);}catch(e){if(replaced)await renameClosedPackage(previous,out);throw e;}
await removeGenerated(previous);await removeGenerated(data);
console.log(JSON.stringify({output:out,...info},null,2));
