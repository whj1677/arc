import fs from 'node:fs/promises';
import path from 'node:path';
import {relativePath,safeFile} from './snapshot';

/** Only existing, individually named files can become writable roots. */
export async function resolveDevelopmentScope(workspace:string,scope:unknown){
  if(!Array.isArray(scope)||!scope.length||scope.length>50)throw Error('请选择 1–50 个允许修改的现有文件。');
  const files:string[]=[];
  for(const file of scope){
    if(typeof file!=='string'||file.length>1000||/[\u0000-\u001f\u007f*?\[\]{}<>|"~]/.test(file))throw Error('授权范围只能包含具体文件路径，不能使用通配符。');
    relativePath(file);
    const parts=file.split('/');
    if(parts.some(part=>!part||/[. ]$/.test(part)||/^\.(?:git|codex|agents|aws|arc-local)$/i.test(part)))throw Error('不允许授权 Git、Agent 元数据或非规范路径。');
    if(/^(?:AGENTS(?:\.override)?\.md|\.gitmodules|\.gitattributes)$/i.test(parts.at(-1)!))throw Error('不允许授权 Agent 规则或 Git 配置文件。');
    const target=await safeFile(workspace,file);
    const expected=path.resolve(workspace,file);
    if((process.platform==='win32'?target.toLowerCase()!==expected.toLowerCase():target!==expected)||(await fs.stat(target)).nlink!==1)throw Error('授权文件不能使用路径别名或硬链接。');
    if(!files.includes(target))files.push(target);
  }
  return files;
}
