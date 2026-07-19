// Preload for the screen-share picker dialog. Receives the capturable
// sources from the main process and reports the user's choice back.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenPicker', {
  onSources: (callback) => {
    ipcRenderer.on('screen-picker:sources', (_event, sources) => callback(sources));
  },
  select: (sourceId) => ipcRenderer.send('screen-picker:select', sourceId),
  cancel: () => ipcRenderer.send('screen-picker:cancel'),
});
