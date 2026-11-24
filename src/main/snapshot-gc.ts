import fs from 'node:fs/promises';
import {lstatSync,renameSync} from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldToMain} from 'node:timers/promises';
import type {Store} from './store';

// Include other connections (data_version) and writes on this connection.
function databaseVersion(store:Store) {
  return store.db.prepare("SELECT printf('%d/%d',data_version,total_changes()) AS version FROM pragma_data_version").get()!.version;
}

async function excludeReferenced(store:Store,candidates:Set<string>) {
  // Architecture baselines, update-run read baselines and evidence can pin a
  // snapshot in either the current document or any historical version.
  // Task versions, receipts and attempts also retain frozen evidence. Walk
  // persisted records in bounded batches without holding a transaction open.
  for(const table of ['objects','engineering_versions']){
    const ids=store.db.prepare(`SELECT rowid FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 16`);
    const refs=store.db.prepare(`SELECT DISTINCT field.atom AS id FROM ${table} AS r,json_tree(r.json) AS field
      WHERE r.rowid>? AND r.rowid<=? AND r.kind!='snapshot' AND field.type='text' AND field.atom GLOB 'source-*'`);
    let cursor=0;
    while(candidates.size){
      const last=ids.all(cursor).at(-1);
      if(!last)break;
      for(const row of refs.all(cursor,last.rowid))candidates.delete(String(row.id));
      cursor=Number(last.rowid);
      await yieldToMain();
    }
  }
}

// Move out of the live namespace under SQLite's write lock. Removing large
// trees afterwards keeps recursive filesystem work off the main thread.
export async function pruneUnreferencedSnapshots(directory:string,store:Store) {
  const root=path.join(directory,'snapshots'),cutoff=Date.now()-10*60_000;
  const rootStat=await fs.lstat(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!rootStat?.isDirectory())return;
  let version=databaseVersion(store);
  const candidates=new Set<string>(),pending:string[]=[];
  const metadata=store.db.prepare("SELECT json_extract(json,'$.captured_at') AS captured FROM objects WHERE kind='snapshot' AND id=?");
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    if(/^\.prune-source-[\w-]+$/.test(entry.name)){pending.push(entry.name);continue;}
    if(!/^source-[\w-]+$/.test(entry.name))continue;
    const stat=await fs.lstat(path.join(root,entry.name)).catch(()=>null);
    if(!stat?.isDirectory()||stat.mtimeMs>=cutoff)continue;
    const row=metadata.get(entry.name);
    if(!row||Date.parse(String(row.captured))<cutoff)candidates.add(entry.name);
  }
  // Finish interrupted removals. If a crash rolled back the row deletion,
  // restore the original name so it can be considered afresh on next startup.
  for(const name of pending){
    const original=name.slice('.prune-'.length),trash=path.join(root,name);
    const remove=store.transaction(()=>{
      if(!metadata.get(original))return true;
      const target=path.join(root,original);
      if(!lstatSync(target,{throwIfNoEntry:false})&&lstatSync(trash,{throwIfNoEntry:false})?.isDirectory())renameSync(trash,target);
      return false;
    });
    if(remove)await fs.rm(trash,{recursive:true,force:true});
  }
  if(!candidates.size)return;
  for(const row of store.db.prepare(`SELECT json_extract(json,'$.snapshot_id') AS id FROM objects
    WHERE kind IN ('project','engineering_state')`).all())candidates.delete(String(row.id));
  await excludeReferenced(store,candidates);
  if(!candidates.size)return;

  const forget=store.db.prepare("DELETE FROM objects WHERE kind='snapshot' AND id=?");
  for(const name of candidates){
    const original=path.join(root,name),trash=path.join(root,'.prune-'+name);
    let moved=false;
    try{
      const stillCurrent=store.transaction(()=>{
        if(databaseVersion(store)!==version)return false;
        const stat=lstatSync(original,{throwIfNoEntry:false});
        if(!stat?.isDirectory()||stat.mtimeMs>=cutoff||lstatSync(trash,{throwIfNoEntry:false}))return true;
        renameSync(original,trash);
        moved=true;
        forget.run(name);
        version=databaseVersion(store);
        return true;
      });
      if(!stillCurrent)return;
    }catch(error){
      if(moved)renameSync(trash,original);
      throw error;
    }
    if(moved)await fs.rm(trash,{recursive:true,force:true});
  }
}
