const { contextBridge, ipcRenderer } = require('electron');
const call = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('api', {
  getSettings: call('settings:get'), setSettings: call('settings:set'),
  pick: call('pick'), analyze: call('analyze'), save: call('save'), open: call('open')
});
