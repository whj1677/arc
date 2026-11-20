const { app, ipcMain } = require('electron');
const path = require('node:path');

// Use ARC's built main, preload and renderer, with only the model reply replaced.
const register = ipcMain.handle.bind(ipcMain);
let nextReply = Promise.withResolvers();
app.on('test-refinement', reply => nextReply.resolve(reply));
ipcMain.handle = (channel, handler) => register(channel, async (event, operation, args) => {
  if (channel === 'arc:invoke' && operation === 'development_refine_goal') {
    const reply = await nextReply.promise;
    nextReply = Promise.withResolvers();
    return reply;
  }
  return handler(event, operation, args);
});
app.setAppPath(process.cwd());
require(path.resolve('dist/main.cjs'));
