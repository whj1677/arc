import {useEffect,useState,useSyncExternalStore} from 'react';
import type {WorkspaceBinding} from '../engineering';
import type {ProjectEnvironment} from '../main/env-probe';

const cache=new Map<string,ProjectEnvironment>();
const pending=new Map<string,Promise<void>>();
const listeners=new Set<()=>void>();
function subscribe(listener:()=>void){
  listeners.add(listener);
  return ()=>{listeners.delete(listener);};
}
function bindingKey(workspace:WorkspaceBinding){
  return JSON.stringify([workspace.project_id,workspace.root_path,workspace.rebound_at]);
}
export function rememberEnvironment(workspace:WorkspaceBinding,environment:ProjectEnvironment){
  cache.set(bindingKey(workspace),environment);
  for(const listener of listeners)listener();
}
export function useProjectEnvironment(workspace?:WorkspaceBinding){
  const key=workspace?.status==='bound'?bindingKey(workspace):'';
  const environment=useSyncExternalStore(subscribe,()=>cache.get(key));
  const [error,setError]=useState('');
  useEffect(()=>{
    setError('');
    if(!workspace||!key||cache.has(key))return;
    let active=true;
    let request=pending.get(key);
    if(!request){
      request=window.arc.invoke<ProjectEnvironment>('project_environment',{project_id:workspace.project_id})
        .then(value=>rememberEnvironment(workspace,value)).finally(()=>pending.delete(key));
      pending.set(key,request);
    }
    void request.catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[key]);
  return {environment,error};
}
