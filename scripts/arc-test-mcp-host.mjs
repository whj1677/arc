// Authenticated ARC MCP host for real independent-session acceptance.
// It owns the normal ArcService lifecycle; stopping it closes the bridge and store.
import path from 'node:path';
import {ArcService} from '../src/main/service.ts';
import {ArcMcpBridge} from '../src/main/mcp-bridge.ts';
const directory=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Usage: arc-test-mcp-host <ARC data directory>');
const service=new ArcService(directory,path.resolve('.')),bridge=new ArcMcpBridge(service,path.resolve('.'));
let closing=false;
async function close(){if(closing)return;closing=true;await bridge.close();await service.shutdown();service.store.close();}
await bridge.start();
console.log(JSON.stringify({ready:true,connection_file:bridge.connectionFile}));
process.once('SIGINT',()=>void close().then(()=>process.exit(0)));
process.once('SIGTERM',()=>void close().then(()=>process.exit(0)));
