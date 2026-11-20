import fs from 'node:fs/promises';
import path from 'node:path';
import {safeFile} from './snapshot';
import {developmentFileError} from '../engineering';

/** Only existing, individually named files can become writable roots. */
export async function resolveDevelopmentScope(workspace:string,scope:unknown){
  if(!Array.isArray(scope)||!scope.length||scope.length>50)throw Error('请选择 1–50 个允许修改的现有文件。');
  const files:string[]=[];
  for(const file of scope){
    if(typeof file!=='string')throw Error('授权范围只能包含具体文件路径。');
    const error=developmentFileError(file);
    if(error)throw Error(error);
    const target=await safeFile(workspace,file);
    const expected=path.resolve(workspace,file);
    if((process.platform==='win32'?target.toLowerCase()!==expected.toLowerCase():target!==expected)||(await fs.stat(target)).nlink!==1)throw Error('授权文件不能使用路径别名或硬链接。');
    if(!files.includes(target))files.push(target);
  }
  return files;
}
