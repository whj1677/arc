// Electron directory distribution. Copying the installed runtime avoids
// Windows directory-rename locks during packager staging.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const runtime=path.resolve('node_modules/electron/dist'),out=path.resolve('release/Arc-win32-x64');
await fs.access(path.join(runtime,'electron.exe'));
await fs.mkdir(out,{recursive:true});
await fs.cp(runtime,out,{recursive:true,force:true,filter:source=>path.basename(source)!=='electron.exe'});
await fs.copyFile(path.join(runtime,'electron.exe'),path.join(out,'Arc.exe'));
const app=path.join(out,'resources','app');await fs.mkdir(app,{recursive:true});
// Only clean this script's generated distribution assets, after checking the
// resolved target cannot leave the explicitly named release directory.
const generated=path.join(app,'dist');
try{
  const resolved=await fs.realpath(generated),root=await fs.realpath(out);
  if(path.relative(root,resolved)!==path.join('resources','app','dist'))throw new Error('Unexpected release asset path');
  if((await fs.lstat(generated)).isSymbolicLink())throw new Error('Release assets must not be a link');
  await fs.rm(generated,{recursive:true,force:false});
}catch(e){if(e.code!=='ENOENT')throw e;}
for(const folder of ['dist','contracts','examples'])await fs.cp(folder,path.join(app,folder),{recursive:true,force:true,filter:source=>!source.endsWith('.map')});
await fs.writeFile(path.join(app,'package.json'),JSON.stringify({name:'arc-desktop',productName:'Arc',version:'0.1.0',main:'dist/main.cjs',private:true}));
await fs.copyFile('docs/DISTRIBUTION.txt',path.join(out,'运行说明.txt'));
const hash=createHash('sha256').update(await fs.readFile(path.join(out,'Arc.exe'))).digest('hex');
await fs.writeFile(path.join(out,'BUILD-INFO.json'),JSON.stringify({product:'Arc',version:'0.1.0',platform:'win32',arch:'x64',electron:JSON.parse(await fs.readFile('node_modules/electron/package.json','utf8')).version,signed:false,packaging:'Electron directory distribution; no development server',exe_sha256:hash,built_at:new Date().toISOString()},null,2));
console.log(JSON.stringify({output:out,exe_sha256:hash,signed:false},null,2));
