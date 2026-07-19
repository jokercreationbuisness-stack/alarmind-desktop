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
  // Call lifecycle: the site reports when a Jitsi call starts/ends so the
  // shell can (a) block system sleep, (b) collapse to a floating always-on-
  // top mini call window if the user closes the app mid-call.
  reportCallState: (isActive) => ipcRenderer.send('call:state', Boolean(isActive)),
  // Expand from the floating mini call window back to the full app.
  expandFromMiniCall: () => ipcRenderer.send('call:expand'),
  // Fired with `true` when the shell shrinks to the floating call window and
  // `false` when it restores — the site switches its call UI accordingly.
  onMiniCallChange: (callback) => {
    ipcRenderer.on('desktop:mini-call-change', (_event, isMini) => callback(isMini));
  },
});
