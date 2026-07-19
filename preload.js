// Preload for the website content view. Exposes exactly one capability to
// alarmind.in: starting the system-browser sign-in handoff. Nothing else —
// contextIsolation stays on and the site cannot reach into Node/Electron.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alarmindDesktop', {
  // Sign in via the user's real browser (Google-recommended for desktop).
  // The main process opens the browser, polls for approval, then injects
  // the session and navigates to the dashboard.
  signInWithBrowser: () => ipcRenderer.send('auth:browser-signin'),
  // Bring the app window to the front (restore from tray). The site calls
  // this on incoming calls and notification clicks — otherwise the ringtone
  // plays and toasts appear while the window itself stays hidden.
  showWindow: () => ipcRenderer.send('app:show-window'),
});
