import { contextBridge, ipcRenderer } from 'electron';
const operations = new Set(['mcp_status','mcp_enable','mcp_disable','overview_create','import_result','data','open_project','open_project_path','demo','feature_open','analysis_prepare','feature_add','scenario_add','scenario_revise','organize','annotate','source','refresh','check_freshness','reading_get','reading_save','reading_ask','reading_retry','providers_probe','run_start','run_cancel','run_revalidate','run_events','run_open_provider','index_cancel','export_project','backup','settings','pick_program']);
contextBridge.exposeInMainWorld('arc', {
  invoke: (operation:string,args?:unknown) => {
    if(!operations.has(operation))return Promise.reject(new Error('未授权 IPC 操作'));
    return ipcRenderer.invoke('arc:invoke',operation,args).then((r:any)=>{if(!r.ok)throw new Error(r.error);return r.value;});
  },
  onEvent: (callback:(e:any)=>void) => {const listener=(_:unknown,e:any)=>callback(e);ipcRenderer.on('arc:event',listener);return()=>ipcRenderer.removeListener('arc:event',listener);}
});
