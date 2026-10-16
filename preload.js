const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studioApi', {
  openFile: () => ipcRenderer.invoke('studio:open-file'),
  loadPath: (filePath) => ipcRenderer.invoke('studio:load-path', filePath),
  updateSettings: (settings) => ipcRenderer.invoke('studio:update-settings', settings),
  validateSelector: (selector) => ipcRenderer.invoke('studio:validate-selector', selector),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  exportPdf: () => ipcRenderer.invoke('studio:export'),
  resetSettings: () => ipcRenderer.invoke('studio:reset-settings'),
  openOutputFolder: (filePath) => ipcRenderer.invoke('studio:open-output-folder', filePath),
  setPreviewTheme: (theme) => ipcRenderer.invoke('studio:set-preview-theme', theme),
  onStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('studio:status', handler);
    return () => ipcRenderer.removeListener('studio:status', handler);
  }
});
