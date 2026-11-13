import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {ArcMcpBridge} from './mcp-bridge';
import { ArcService } from './service';
import { redact } from './providers';
let window:BrowserWindow|null=null, service:ArcService, bridge:ArcMcpBridge, quitting=false;
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
    if(event.type==='run_event'&&event.event?.type==='dsh.session_ready')void service.providerSessionUrl(event.run_id).then(url=>shell.openExternal(url)).then(()=>service.event(event.run_id,{type:'local.stage',stage:'native_opened',message:'已请求浏览器打开对应 DSH 会话；任务继续分析并自动写回'})).catch(e=>service.event(event.run_id,{type:'local.stage',stage:'native_open_failed',message:'打开 DSH 对话失败：'+redact((e as Error).message)}));
  });}
  catch(e){dialog.showErrorBox('Arc 无法打开数据',(e as Error).message);app.quit();return;}
  bridge=new ArcMcpBridge(service,resources);await bridge.start();
  window=new BrowserWindow({width:1440,height:900,minWidth:320,minHeight:560,title:'Arc · 工程理解工作台',backgroundColor:'#101923',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  const ui=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
  ipcMain.handle('arc:invoke',async(event,operation:string,args:any={})=>{
    try {
      if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||!event.senderFrame.url.startsWith(ui))throw new Error('IPC 来源不可信');
      if(JSON.stringify(args).length>200000)throw new Error('请求超过大小限制');
      let value:any;
      switch(operation){
        case 'mcp_status':value=bridge.status();break;
        case 'mcp_enable':value=await bridge.enable(args.project_id,args.register_codex===true);break;
        case 'mcp_disable':value=bridge.disable();break;
        case 'data':value=service.data();break;
        case 'pick_project_path':
        case 'open_project':{const picked=await dialog.showOpenDialog(window!,{properties:['openDirectory'],title:'选择要理解的本地工程'});value=picked.canceled?null:operation==='pick_project_path'?picked.filePaths[0]:await service.openProject(picked.filePaths[0]);break;}
        case 'open_project_path':value=await service.openProject(String(args.path));break;
        case 'demo':value=await service.loadDemo();break;
        case 'overview_create':value=service.overview(args.project_id);break;
        case 'import_result':{const picked=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:'Arc 分析结果',extensions:['json']}]});if(!picked.canceled)value=await service.importResult(args.scenario_id,picked.filePaths[0]);break;}
        case 'feature_open':value=service.openDiscoveredFeature(args.project_id,args.result_id,args.node_id,args.request_mcp===true);break;
        case 'analysis_prepare':value=service.prepareAnalysis(args.scenario_id);break;
        case 'feature_add':value=service.addFeature(args.project_id,args.name,args.question);break;
        case 'scenario_add':value=service.store.transaction(()=>service.addScenario(args.feature_id,args.question));break;
        case 'scenario_revise':value=service.reviseScenario(args.scenario_id,args.question);break;
        case 'organize':value=service.organize(args.kind,args.id,args.patch);break;
        case 'annotate':value=service.annotate(args.scenario_id,args.text,args.result_id??null,args.object_id??null);break;
        case 'source':value=await service.source(args.source_snapshot_id,args.path);break;
        case 'refresh':value=await service.refresh(args.project_id,args.build_config);break;
        case 'check_freshness':value=await service.checkFreshness(args.project_id);break;
        case 'reading_get':value=service.reading(args.key);break;
        case 'reading_save':value=service.reading(args.key,args.value);break;
        case 'providers_probe':value=await service.probe(args.config);break;
        case 'run_start':value=await service.startRun(args.scenario_id,args.provider_id,args.submission_key,args.previous_run_id);break;
        case 'reading_ask':value=await service.askReading(args);break;
        case 'reading_retry':value=service.retryReading(args.question_id,args.mode,args.submission_key);break;
        case 'run_cancel':value=await service.cancel(args.run_id);break;
        case 'run_revalidate':value=await service.revalidate(args.run_id);break;
        case 'run_events':service.store.get('run',args.run_id);value=service.store.events(args.run_id);break;
        case 'run_open_provider':await shell.openExternal(await service.providerSessionUrl(args.run_id));value={opened:true};break;
        case 'index_cancel':service.cancelIndex(args.project_id);break;
        case 'settings':value={data_directory:service.directory,version:app.getVersion(),platform:process.platform};break;
        case 'export_project':{const dest=await dialog.showSaveDialog(window!,{title:'导出理解资料和快照（本地文件）',defaultPath:'Arc-工程理解.json',filters:[{name:'Arc JSON',extensions:['json']}]});if(dest.filePath)value=await service.exportProject(args.project_id,dest.filePath);break;}
        case 'backup':{const dest=await dialog.showSaveDialog(window!,{defaultPath:`Arc-backup-${Date.now()}.sqlite`});if(dest.filePath){service.store.backup(dest.filePath);value=dest.filePath;}break;}
        case 'pick_program':{const picked=await dialog.showOpenDialog(window!,{properties:['openFile'],title:'选择已安装的官方程序'});value=picked.canceled?null:picked.filePaths[0];break;}
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
