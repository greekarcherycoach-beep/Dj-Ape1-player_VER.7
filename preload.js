'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, cb) => {
  const h = (_e, ...a) => cb(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

// Everything the page can reach in the main process. Nothing else is exposed.
contextBridge.exposeInMainWorld('desktop', {
  toggleFullscreen: () => invoke('app:toggleFullscreen'),
  openLog: () => invoke('app:openLog'),
  getCrash: () => invoke('app:getCrash'),
  diag: (kind, data) => ipcRenderer.send('app:diag', String(kind), data),
  state: (s) => ipcRenderer.send('app:state', s),
  getOpen: () => invoke('app:getOpen'),
  flushDone: () => ipcRenderer.send('app:flushDone'),
  onOpen: (cb) => on('open', cb),
  onFullscreen: (cb) => on('fullscreen', cb),
  onCmd: (cb) => on('cmd', cb),
  onFlush: (cb) => on('flush', cb),
  prefs: {
    get: () => invoke('prefs:get'),
    set: (p) => invoke('prefs:set', p),
  },
  native: {
    pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
    pickFolder: () => invoke('native:pickFolder'),
    readdir: (p) => invoke('native:readdir', p),
    stat: (paths) => invoke('native:stat', paths),
    readTags: (p) => invoke('native:readTags', p),
    libSave: (json) => invoke('lib:save', json),
    libLoad: () => invoke('lib:load'),
    libInfo: () => invoke('lib:info'),
    libBackups: () => invoke('lib:backups'),
    libBackupNow: () => invoke('lib:backupNow'),
    libBackup: (name) => invoke('lib:backup', name),
    openLibDir: () => invoke('lib:openDir'),
    watch: (paths) => ipcRenderer.send('native:watch', paths),
    onChanged: (cb) => on('changed', cb),
  },
});
