import { contextBridge, ipcRenderer } from 'electron';
const operations = new Set(['mcp_status','mcp_enable','mcp_disable','overview_create','import_result','data','open_project','open_project_path','pick_project_path','demo','feature_open','analysis_prepare','feature_add','scenario_add','scenario_revise','organize','annotate','source','refresh','check_freshness','reading_get','reading_save','reading_ask','reading_retry','providers_probe','overview_research','run_start','run_cancel','run_revalidate','run_events','run_open_provider','index_cancel','export_project','backup','settings','pick_program']);
for(const operation of ['executor_sessions','executor_copy_workspace','executor_open','executor_status','executor_bind','executor_retry','executor_cancel','executor_acknowledge_stop','executor_verify_stopped','engineering_context','engineering_tasks','engineering_task','engineering_history','engineering_revise','engineering_save_entry','engineering_log','engineering_diff','engineering_connect','engineering_pending','engineering_sync','engineering_export','engineering_restore','engineering_rebind','development_start','development_begin_kimi','development_cancel','development_events','walkthrough_retry'])operations.add(operation);
contextBridge.exposeInMainWorld('arc', {
  invoke: (operation:string,args?:unknown) => {
    if(!operations.has(operation))return Promise.reject(new Error('未授权 IPC 操作'));
    return ipcRenderer.invoke('arc:invoke',operation,args).then((r:any)=>{if(!r.ok)throw new Error(r.error);return r.value;});
  },
  onEvent: (callback:(e:any)=>void) => {const listener=(_:unknown,e:any)=>callback(e);ipcRenderer.on('arc:event',listener);return()=>ipcRenderer.removeListener('arc:event',listener);}
});
