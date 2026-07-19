// Preload for the custom titlebar only (not for the website). Exposes the
// three window controls over IPC — nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizedChange: (callback) => {
    ipcRenderer.on('window:maximized-change', (_event, isMaximized) => callback(isMaximized));
  },
});
