const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call =
    (c) =>
    (...a) =>
        ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('api', {
    getSettings: call('settings:get'),
    setSettings: call('settings:set'),
    pick: call('pick'),
    pickFolder: call('pickFolder'),
    analyze: call('analyze'),
    save: call('save'),
    open: call('open'),
    abort: call('abort'),
    convert: call('convert'),
    // Dropped and picked files no longer carry a path of their own, so ask Electron for it.
    pathFor: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch {
            return '';
        }
    },
    expand: call('files:expand'),
    readFile: call('files:read'),
    existing: call('files:existing'),
    rename: call('files:rename'),
    listModels: call('models:list'),
    getUpdateState: call('updates:get'),
    checkForUpdates: call('updates:check'),
    installUpdate: call('updates:install'),
    onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (_e, state) => cb(state)),
    onAnalyzeStatus: (cb) => ipcRenderer.on('analyze:status', (_e, status) => cb(status)),
    zipFiles: call('zip:create'),
    cancelZip: call('zip:cancel'),
    onZipProgress: (cb) => ipcRenderer.on('zip:progress', (_e, progress) => cb(progress))
});
