import { contextBridge, ipcRenderer } from 'electron';
const operations = new Set(['mcp_status','mcp_enable','mcp_disable','overview_create','import_result','data','open_project','open_project_path','pick_project_path','demo','feature_open','analysis_prepare','feature_add','feature_breakdown','scenario_add','scenario_revise','organize','annotate','source','code_index_summary','refresh','check_freshness','reading_get','reading_save','reading_ask','reading_retry','providers_probe','default_engine_save','codex_preferences_save','overview_research','run_start','run_cancel','run_revalidate','run_events','index_cancel','export_project','backup','settings','pick_program']);
for(const operation of ['executor_sessions','executor_copy_workspace','executor_open','executor_status','executor_bind','executor_retry','executor_cancel','executor_acknowledge_stop','executor_verify_stopped','engineering_context','engineering_tasks','engineering_task','engineering_task_boundaries','project_environment','project_environment_save','engineering_history','engineering_open_link','engineering_revise','engineering_save_entry','engineering_log','engineering_diff','engineering_rollback','engineering_connect','engineering_pending','engineering_sync','engineering_export','engineering_restore','engineering_rebind','development_refine_goal','development_start','development_cancel','development_events','walkthrough_retry'])operations.add(operation);
operations.add('engineering_task_hud');
operations.add('walkthrough_feature_refresh');
contextBridge.exposeInMainWorld('arc', {
  invoke: (operation:string,args?:unknown) => {
    if(!operations.has(operation))return Promise.reject(new Error('未授权 IPC 操作'));
    return ipcRenderer.invoke('arc:invoke',operation,args).then((r:any)=>{if(!r.ok)throw new Error(r.error);return r.value;});
  },
  onEvent: (callback:(e:any)=>void) => {const listener=(_:unknown,e:any)=>callback(e);ipcRenderer.on('arc:event',listener);return()=>ipcRenderer.removeListener('arc:event',listener);}
});
