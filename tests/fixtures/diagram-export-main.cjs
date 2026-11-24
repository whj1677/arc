const { app, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { channel } = require('node:diagnostics_channel');

// Exercise the installed IPC handler and writer. Only the native file chooser is driven here.
const operations = [];
const choices = [];
const exportActivity = new AsyncLocalStorage();
const transportCalls = [];
// Version lookup can run Git. A diagram export must never launch a provider or contact a model endpoint.
channel('child_process').subscribe(({ process: child }) => {
  if (exportActivity.getStore()) child.once('spawn', () => {
    const program = path.basename(child.spawnfile).toLowerCase().replace(/\.exe$/, '');
    if (!['git', 'where', 'which'].includes(program)) transportCalls.push(program);
  });
});
for (const name of ['undici:request:create', 'http.client.request.created']) {
  channel(name).subscribe(() => { if (exportActivity.getStore()) transportCalls.push(name); });
}
let destination;
app.on('export-test-path', name => { destination = name; });
dialog.showSaveDialog = async (...args) => {
  const options = args.at(-1);
  choices.push({ defaultPath: options.defaultPath, filters: options.filters });
  if (!destination) throw Error('Unexpected native save dialog');
  const filePath = destination;
  destination = undefined;
  return { canceled: false, filePath };
};
app.on('export-test-records', read => read({ operations, choices, transportCalls, downloads: app.getPath('downloads') }));

const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => register(channel, async (event, operation, args) => {
  if (channel === 'arc:invoke') operations.push({ operation, version: args?.version });
  const exporting = operation === 'export_diagram_file' || (operation === 'architecture_get' && args?.version !== undefined);
  return exportActivity.run(exporting, () => handler(event, operation, args));
});
app.setAppPath(process.cwd());
require(path.resolve('dist/main.cjs'));
