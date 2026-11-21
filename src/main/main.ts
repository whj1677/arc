import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesUiUrl } from './ipc-origin';
import { isValidCodexModel } from './codex-models';
import {ArcMcpBridge} from './mcp-bridge';
import { ArcService } from './service';
import { redact } from './providers';
import {isExecutionMode,type ExecutionMode,type ReadingQuestion,type Run,type Scenario} from '../shared';
import {scanAecLegacy,applyAecRuleMigration,installArcAgentRules} from './aec-migration';
let window:BrowserWindow|null=null, service:ArcService, bridge:ArcMcpBridge, quitting=false;
function defaultEngine():ExecutionMode {
  return service.store.maybe<ExecutionMode>('settings','default_engine')??'codex';
}
function selectedEngine(mode:unknown):ExecutionMode {
  if(mode===undefined)return defaultEngine();
  if(!isExecutionMode(mode))throw Error('执行方式无效');
  return mode;
}
async function enableExternal(mode:ExecutionMode,projectId:string){
  if(mode==='mcp'||mode==='codex_desktop')await bridge.enable(projectId,false);
}
if(process.env.ARC_DATA_DIR)app.setPath('userData',path.resolve(process.env.ARC_DATA_DIR));
app.setName('Arc');
const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(async()=>{
  if(!primaryInstance)return;
  const resources=app.getAppPath();
  try{service=new ArcService(app.getPath('userData'),resources,event=>{
    window?.webContents.send('arc:event',event);
  });}
  catch(e){dialog.showErrorBox('Arc 无法打开数据',(e as Error).message);app.quit();return;}
  bridge=new ArcMcpBridge(service,resources);await bridge.start();
  window=new BrowserWindow({width:1440,height:900,minWidth:320,minHeight:560,title:'Arc · 工程理解工作台',backgroundColor:'#f4f6f2',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();
  const notifyFocus = () => window?.webContents.send('arc:event', { type: 'window_focus' });
  window.on('focus', notifyFocus);
  window.on('restore', notifyFocus);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  const ui=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
  ipcMain.handle('arc:invoke',async(event,operation:string,args:any={})=>{
    try {
      if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||!matchesUiUrl(event.senderFrame.url,ui))throw new Error('IPC 来源不可信');
      if(JSON.stringify(args).length>200000)throw new Error('请求超过大小限制');
      let value:any;
      switch(operation){
        case 'mcp_status':value=bridge.status();break;
        case 'mcp_enable':value=await bridge.enable(args.project_id,args.register_codex===true);break;
        case 'mcp_disable':value=bridge.disable();break;
        case 'data':value={...service.data(),default_engine:defaultEngine()};break;
        case 'codex_preferences_save':{
          const {model,reasoning_effort}=args;
          if(!isValidCodexModel(model))throw Error('Codex 模型标识无效');
          if(!['auto','low','medium','high'].includes(reasoning_effort))throw Error('Codex 推理强度无效');
          value={model,reasoning_effort};
          service.store.put('settings','codex_preferences',value);service.changed();break;
        }
        case 'default_engine_save':{
          if(!isExecutionMode(args.mode))throw Error('执行方式无效');
          service.store.put('settings','default_engine',args.mode);service.changed();value=args.mode;break;
        }
        case 'engineering_context':await service.engineering.connect(args.project_id);if(args.refresh)await service.refresh(args.project_id);value=await service.engineering.context(args,args.task_id===''&&!args.entry_id&&!args.result_id);break;
        case 'engineering_tasks':value=await service.engineering.currentTasks(args,args.cached===true);break;
        case 'engineering_task_boundaries':value=service.engineering.updateBoundaries(args);break;
        case 'project_environment':value=await service.engineering.projectEnvironment(args.project_id,args.refresh);break;
        case 'project_environment_save':value=await service.engineering.saveEnvironmentCommands(args.project_id,args.effective_commands);break;
        case 'engineering_task':value=await service.engineering.currentTask(args.task_id);break;
        case 'engineering_history':value=service.engineering.history(args.kind,args.id);break;
        case 'engineering_open_link':{const url=new URL(args.url);if(!['https:','http:','mailto:'].includes(url.protocol))throw Error('不支持此链接协议');await shell.openExternal(url.href);value={opened:true};break;}
        case 'engineering_revise':value=service.engineering.reviseContext(args);break;
        case 'engineering_save_entry':value=await service.engineering.saveEntry(args,'user');break;
        case 'engineering_log':value=await service.engineering.readLog(args.task_id,args.path);break;
        case 'engineering_diff':value=await service.engineering.taskDiff(args.task_id,args.path);break;
        case 'engineering_rollback':{
          if(typeof args.task_id!=='string'||!args.task_id.trim()||args.task_id.length>300)throw Error('任务标识无效');
          value=await service.engineering.rollbackTask(args.task_id);break;
        }
        case 'development_refine_goal':value=await service.refineDevelopmentGoal(args.project_id,args.goal,args.non_goals??[],selectedEngine(args.engine)==='dsh'?'dsh':'codex');break;
        case 'development_start':{
          const task=args.task_id?service.engineering.task(args.task_id):undefined;
          const previousMode=task?.execution_mode??(task?.analysis_channel==='dsh'?'dsh':undefined);
          const mode=args.phase==='execution'?(previousMode??'codex_desktop'):selectedEngine(args.mode??previousMode);
          if(args.fast_mode!==undefined&&typeof args.fast_mode!=='boolean')throw Error('快速直改模式参数无效');
          if(args.fast_mode){
            if(mode!=='codex'||args.task_id||args.phase==='execution')throw Error('快速直改仅支持新建 Codex 任务');
            value=await service.development.start({...args,scope:args.scope,fast_mode:true});
          }else{
            value=mode==='codex'||mode==='dsh'?await service.development.submit(args,mode):await bridge.queueDevelopment(args,mode);
          }
          break;
        }
        case 'executor_sessions':{const workspace=await service.engineering.resolve({project_id:args.project_id});value=await bridge.dispatch.sessions(workspace.root_path,args.program);break;}
        case 'executor_copy_workspace':{const workspace=await service.engineering.resolve({project_id:args.project_id});await clipboard.writeText(workspace.root_path);break;}
        case 'executor_open':{const binding=bridge.dispatch.binding(args.project_id);if(!binding)throw Error('请先选择并绑定会话');await shell.openExternal('codex://threads/'+encodeURIComponent(binding.thread_id));value={opened:true};break;}
        case 'executor_status':value=bridge.executorStatus(args.project_id);break;
        case 'executor_bind':{
          const workspace=await service.engineering.resolve({project_id:args.project_id});
          value=await bridge.dispatch.bind(args.project_id,workspace.root_path,args.program,args.thread_id,
            program=>bridge.enable(args.project_id,true,program));break;
        }
        case 'executor_retry':value=await bridge.dispatch.retry(args.dispatch_id);break;
        case 'executor_cancel':value=bridge.cancelDispatch(args.dispatch_id);break;
        case 'executor_acknowledge_stop':value=bridge.acknowledgeStop(args.dispatch_id);break;
        case 'executor_verify_stopped':value=await bridge.verifyStopped(args.dispatch_id);break;
        case 'development_cancel':{
          const task=service.engineering.task(args.task_id);
          const item=task.execution_mode===undefined||task.execution_mode==='codex_desktop'
            ?bridge.dispatch.items(task.project_id).filter(item=>item.task_id===task.task_id).at(-1):undefined;
          value=item?bridge.cancelDispatch(item.dispatch_id):task.execution_mode==='mcp'&&task.status==='pending'
            ?service.engineering.updateTask({task_id:task.task_id,expected_version:task.version,submission_key:`cancel-${task.version}`,status:'cancelled'})
            :await service.development.cancel(task.task_id);
          break;
        }
        case 'development_events':value=service.development.events(args.task_id);break;
        case 'walkthrough_retry':void service.refreshTaskWalkthrough(args.task_id,args.submission_key);value=service.engineering.task(args.task_id);break;
        case 'engineering_connect':{
          const workspace=await service.engineering.connect(args.project_id),legacy=await scanAecLegacy(workspace.root_path);
          // Preserve old managed rules as source history before replacing them.
          const imported=await service.engineering.importAec(args.project_id,legacy);
          const changed=await applyAecRuleMigration(workspace.root_path,legacy.rules);
          const installed=await installArcAgentRules(workspace.root_path,{connectionFile:bridge.connectionFile});
          const connection=await bridge.enable(args.project_id,true);
          await service.engineering.context({project_id:args.project_id,refresh:true});
          value={connection,changed_paths:changed,installed,imported,pending:await bridge.pendingWrites(),warnings:legacy.warnings};break;
        }
        case 'engineering_pending':value=await bridge.pendingWrites();break;
        case 'engineering_sync':value=await bridge.flushPending();break;
        case 'engineering_export':{const dest=await dialog.showSaveDialog(window!,{title:'导出工程记录、历史与引用证据',defaultPath:'Arc-工程记录.json',filters:[{name:'Arc 工程记录',extensions:['json']}]});if(dest.filePath)value=await service.engineering.exportProject(args.project_id,dest.filePath);break;}
        case 'engineering_restore':{const picked=await dialog.showOpenDialog(window!,{title:'恢复 ARC 工程记录',properties:['openFile'],filters:[{name:'Arc 工程记录',extensions:['json']}]});if(!picked.canceled)value=await service.engineering.restoreProject(picked.filePaths[0]);break;}
        case 'engineering_rebind':value=await service.engineering.rebindWorkspace(args.project_id,args.root_path);break;
        case 'pick_project_path':
        case 'open_project':{const picked=await dialog.showOpenDialog(window!,{properties:['openDirectory'],title:'选择要理解的本地工程'});value=picked.canceled?null:operation==='pick_project_path'?picked.filePaths[0]:await service.openProject(picked.filePaths[0]);break;}
        case 'open_project_path':value=await service.openProject(String(args.path));break;
        case 'demo':value=await service.loadDemo();break;
        case 'overview_create':value=service.overview(args.project_id);break;
        case 'import_result':{const picked=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:'Arc 分析结果',extensions:['json']}]});if(!picked.canceled)value=await service.importResult(args.scenario_id,picked.filePaths[0]);break;}
        case 'feature_open':value=service.openDiscoveredFeature(args.project_id,args.result_id,args.node_id,args.request_mcp===true);break;
        case 'analysis_prepare':value=service.prepareAnalysis(args.scenario_id,undefined,true);break;
        case 'feature_add':value=service.addFeature(args.project_id,args.name,args.question);break;
        case 'feature_breakdown':value=await service.breakdownFeature(args.feature_id);break;
        case 'scenario_add':value=service.store.transaction(()=>service.addScenario(args.feature_id,args.question,args.title,args.kind));break;
        case 'scenario_revise':value=service.reviseScenario(args.scenario_id,args.question);break;
        case 'organize':value=service.organize(args.kind,args.id,args.patch);break;
        case 'annotate':value=service.annotate(args.scenario_id,args.text,args.result_id??null,args.object_id??null,args.object_kind);break;
        case 'source':value=await service.source(args.source_snapshot_id,args.path);break;
        case 'code_index_summary':value=await service.codeIndexSummary(args.source_snapshot_id);break;
        case 'refresh':value=await service.refresh(args.project_id,args.build_config);break;
        case 'check_freshness':value=await service.checkFreshness(args.project_id);break;
        case 'reading_get':value=service.reading(args.key);break;
        case 'reading_save':value=service.reading(args.key,args.value);break;
        case 'providers_probe':value=await service.probe(args.config);break;
        case 'run_start':{
          const mode=selectedEngine(args.mode);
          await enableExternal(mode,service.store.get<Scenario>('scenario',args.scenario_id).project_id);
          value=mode==='mcp'?service.prepareAnalysis(args.scenario_id,undefined,true)
            :await service.startRun(args.scenario_id,mode,args.submission_key,args.previous_run_id,{projectAnalysis:true});break;
        }
        case 'overview_research':value=await service.researchOverview(args.result_id,args.submission_key);break;
        case 'reading_ask':{
          const mode=selectedEngine(args.mode);
          await enableExternal(mode,args.project_id);value=await service.askReading({...args,mode});break;
        }
        case 'reading_retry':{
          const mode=selectedEngine(args.mode);
          await enableExternal(mode,service.store.get<ReadingQuestion>('reading_question',args.question_id).project_id);
          value=service.retryReading(args.question_id,mode,args.submission_key);break;
        }
        case 'run_cancel':{
          if(args.queued_only===true){
            const run=service.store.get<Run>('run',args.run_id);
            value=run.status==='queued'?await service.cancel(args.run_id):run;
            break;
          }
          const item=bridge.dispatch.items().find(item=>item.run_id===args.run_id);
          value=item?bridge.cancelDispatch(item.dispatch_id):await service.cancel(args.run_id);break;
        }
        case 'run_revalidate':value=await service.revalidate(args.run_id);break;
        case 'run_events':service.store.get('run',args.run_id);value=service.store.events(args.run_id);break;
        case 'index_cancel':service.cancelIndex(args.project_id);break;
        case 'settings':value={data_directory:service.directory,version:app.getVersion(),platform:process.platform,provider_config:service.providerPathConfig(),runtime_tools:await service.probeRuntimeTools()};break;
        case 'export_project':{const dest=await dialog.showSaveDialog(window!,{title:'导出理解资料和快照（本地文件）',defaultPath:'Arc-工程理解.json',filters:[{name:'Arc JSON',extensions:['json']}]});if(dest.filePath)value=await service.exportProject(args.project_id,dest.filePath);break;}
        case 'backup':{const dest=await dialog.showSaveDialog(window!,{defaultPath:`Arc-backup-${Date.now()}.sqlite`});if(dest.filePath){service.store.backup(dest.filePath);value=dest.filePath;}break;}
        case 'pick_program':{
          const filters=process.platform==='win32'?[{name:'可执行程序',extensions:['exe','cmd']},{name:'所有文件',extensions:['*']}]:undefined;
          const picked=await dialog.showOpenDialog(window!,{properties:['openFile'],title:args?.title??'选择已安装的官方程序',filters});
          value=picked.canceled?null:picked.filePaths[0];break;
        }
        default:throw new Error('未授权操作');
      }
      return {ok:true,value};
    }catch(e){return {ok:false,error:redact((e as Error).message)};}
  });
  await window.loadURL(ui);window.show();
  window.on('closed',()=>{window=null;});
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitting||!service)return;
  event.preventDefault();quitting=true;
  void Promise.allSettled([service.shutdown(),bridge?.close()]).finally(()=>{service.store.close();app.quit();});
});
