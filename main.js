// Alarmind Desktop — Electron main process.
//
// A thin, dedicated window around the live Alarmind site (https://alarmind.in).
// The window is frameless with a custom dark titlebar (matching the site's
// #0a0a0a theme) and its own minimize/maximize/close buttons, so it looks
// like a dedicated product app rather than a browser. The site renders in a
// WebContentsView below the titlebar. Navigation is guarded: the marketing
// landing page never shows, and external links open in the real browser.

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  shell,
  session,
  ipcMain,
  nativeImage,
  desktopCapturer,
  screen,
  powerSaveBlocker,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// ---- Configuration -------------------------------------------------------

const SITE_ORIGIN = 'https://alarmind.in';
const API_ORIGIN = 'https://api.alarmind.in';
const START_URL = `${SITE_ORIGIN}/login`;
const DASHBOARD_URL = `${SITE_ORIGIN}/dashboard`;

// Windows shows the App User Model ID's app name on toast notifications.
// Without this, dev runs display "electron.app.Electron" instead of the
// product name. Must match build.appId in package.json so installed builds
// (whose Start Menu shortcut carries the same ID) resolve to "Alarmind".
app.setAppUserModelId('in.alarmind.desktop');
app.setName('Alarmind');

// Use Windows Graphics Capture for screen sharing. Chromium's legacy GDI
// capturer skips console windows (Command Prompt/PowerShell) and some UWP
// apps, so they never appear in the share picker without this. Flag names
// vary across Chromium versions — enabling all is harmless.
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcAllowWgcDesktopCapturers,AllowWgcWindowCapturer,AllowWgcScreenCapturer'
);

// The website checks the userAgent for this marker to hide web-only chrome
// (beta banner, cookie banner, "back to home" links) when running in the app.
const UA_SUFFIX = ` AlarmindDesktop/${app.getVersion()}`;

// Google refuses OAuth from user agents that look like embedded shells
// ("This browser or app may not be secure"). Electron's default UA contains
// "Electron/x.y.z" and the package name, which trigger that block — strip
// both so we present as a normal Chrome browser. Applied app-wide via
// userAgentFallback, so Google's sign-in popup gets the clean UA too.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s(alarmind-desktop|Electron)\/[^\s]+/g, '');

const TITLEBAR_HEIGHT = 40; // must match .titlebar height in titlebar.html

const OFFLINE_PAGE = path.join(__dirname, 'offline.html');
const TITLEBAR_PAGE = path.join(__dirname, 'titlebar.html');
const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'build', 'tray.png');

// Where we remember the window size/position between launches.
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let contentView = null; // the WebContentsView that renders alarmind.in
let tray = null;
// Closing the window hides to tray (socket stays connected → notifications
// keep arriving, like WhatsApp/Slack). Only tray "Quit" really exits.
let isQuitting = false;
// The website reports whether a call is live (Jitsi active) over IPC. While
// true, closing the window collapses to a floating always-on-top mini call
// window (WhatsApp-style) instead of hiding — the call stays visible.
let callActive = false;
let miniCallMode = false;
let boundsBeforeMini = null;
let powerSaveBlockerId = null;

// ---- Window state persistence -------------------------------------------

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (
      typeof state.width === 'number' &&
      typeof state.height === 'number'
    ) {
      return state;
    }
  } catch {
    // No saved state yet (first launch) or unreadable — fall back to defaults.
  }
  return { width: 1280, height: 800 };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (miniCallMode) return; // never persist the tiny call-window bounds
  const isMaximized = mainWindow.isMaximized();
  const bounds = mainWindow.getNormalBounds();
  try {
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ ...bounds, isMaximized })
    );
  } catch {
    // Best-effort only; a failed write just means we use defaults next time.
  }
}

// ---- URL helpers ---------------------------------------------------------

function isAlarmindUrl(url) {
  try {
    return new URL(url).origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

// The marketing landing page is the site root: "/" (optionally with a query or
// hash, but no real path). Everything else on alarmind.in is allowed.
function isLandingPage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== SITE_ORIGIN) return false;
    return parsed.pathname === '/' || parsed.pathname === '';
  } catch {
    return false;
  }
}

// Decide what to do with a navigation attempt. Returns one of:
//   'allow'    — let it navigate normally (in-app)
//   'redirect' — cancel and send the view to the dashboard instead
//   'external' — cancel and open in the user's real browser
function classifyNavigation(url) {
  if (isLandingPage(url)) return 'redirect';
  if (isAlarmindUrl(url)) return 'allow';
  try {
    const scheme = new URL(url).protocol;
    if (scheme === 'http:' || scheme === 'https:') return 'external';
  } catch {
    // Not a browsable URL — leave it to Electron's default handling.
  }
  return 'allow';
}

// Google sign-in opens a popup to accounts.google.com which must stay inside
// the app: the popup reports the credential back to the opening page via
// postMessage, so sending it to the system browser breaks the flow entirely.
function isGoogleAuthUrl(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'accounts.google.com' ||
      host === 'accounts.youtube.com' ||
      host.endsWith('.accounts.google.com') ||
      host === 'oauth2.googleapis.com'
    );
  } catch {
    return false;
  }
}

// Site pages that are deliberately opened via window.open as tool popups
// (whiteboard during a call, etc.) and should become real child windows.
function isPopupToolUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== SITE_ORIGIN) return false;
    return parsed.pathname.startsWith('/whiteboard');
  } catch {
    return false;
  }
}

// ---- Window creation -----------------------------------------------------

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Alarmind',
    icon: ICON_PATH,
    backgroundColor: '#0a0a0a',
    show: false,
    // Frameless: we draw our own titlebar (dark, matching the site) with
    // custom minimize/maximize/close buttons.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'titlebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The window's own page is just the titlebar strip.
  mainWindow.loadFile(TITLEBAR_PAGE);

  // The website renders in a separate view below the titlebar.
  contentView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep the renderer running at full speed even when the window is
      // hidden to tray. Without this, Chromium throttles hidden windows and
      // the socket.io heartbeat times out ("transport close") — which kills
      // the live connection and, with it, the notifications-while-closed
      // feature. This is what makes tray toasts actually work.
      backgroundThrottling: false,
    },
  });
  contentView.setBackgroundColor('#0a0a0a');
  mainWindow.contentView.addChildView(contentView);
  layoutContentView();

  // Identify as the desktop app so the website can hide web-only chrome
  // (beta banner, cookie banner, "back to home" links).
  contentView.webContents.setUserAgent(
    contentView.webContents.getUserAgent() + UA_SUFFIX
  );

  if (state.isMaximized) mainWindow.maximize();

  // Reveal the window only once the titlebar is ready, to avoid a white
  // flash — unless auto-started at login with --hidden, where we stay in
  // the tray and let notifications flow without opening a window.
  const startHidden = process.argv.includes('--hidden');
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });

  loadStartPage();
  attachNavigationGuards();
  attachShortcuts();
  attachWindowEvents();
}

// Keep the content view filling the window below the titlebar.
// In fullscreen the titlebar is hidden and the content takes the whole area.
function layoutContentView() {
  if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
  const [width, height] = mainWindow.getContentSize();
  const top = mainWindow.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
  contentView.setBounds({
    x: 0,
    y: top,
    width,
    height: Math.max(0, height - top),
  });
}

// On Windows, getContentSize() can report stale bounds while a
// maximize/restore/snap/DPI transition is still in flight, which left the
// site rendered at the old size until the user forced another resize.
// Apply the layout now and again after the transition settles.
function scheduleLayout() {
  layoutContentView();
  setTimeout(layoutContentView, 60);
  setTimeout(layoutContentView, 300);
}

function loadStartPage() {
  contentView.webContents.loadURL(START_URL).catch(() => {
    showOfflinePage();
  });
}

// ---- Offline detection & automatic reconnection ---------------------------
// When a load fails we show the local offline page and start probing the
// site. The moment it responds, we navigate back to where the user was —
// no manual retry needed. The renderer's own online event can't be trusted
// here (it only reflects the OS network state, not actual reachability).

let isShowingOffline = false;
let reconnectTimer = null;
// The last real alarmind.in page the user was on, so reconnection returns
// them there instead of dumping them on the login page.
let lastGoodUrl = START_URL;

function probeSite() {
  return new Promise((resolve) => {
    const req = https.request(
      `${SITE_ORIGIN}/login`,
      { method: 'HEAD', timeout: 8000 },
      (res) => {
        res.resume();
        resolve(res.statusCode > 0);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startReconnectLoop() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (!contentView || contentView.webContents.isDestroyed()) {
      stopReconnectLoop();
      return;
    }
    if (await probeSite()) {
      stopReconnectLoop();
      isShowingOffline = false;
      contentView.webContents.loadURL(lastGoodUrl).catch(() => showOfflinePage());
    }
  }, 4000);
}

function stopReconnectLoop() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

function showOfflinePage() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  isShowingOffline = true;
  contentView.webContents.loadFile(OFFLINE_PAGE).catch(() => {
    /* Nothing more we can do if even the local file fails. */
  });
  startReconnectLoop();
}

// Reload the site — used by the titlebar refresh button and Ctrl+R. If we're
// on the offline screen (or somehow on another local file), a plain reload
// would just re-show that file, so navigate back to the site instead.
function refreshSite() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  const current = contentView.webContents.getURL();
  if (isShowingOffline || current.startsWith('file://')) {
    stopReconnectLoop();
    isShowingOffline = false;
    contentView.webContents.loadURL(lastGoodUrl).catch(() => showOfflinePage());
  } else {
    contentView.webContents.reload();
  }
}

// ---- Navigation guards ---------------------------------------------------

function attachNavigationGuards() {
  const contents = contentView.webContents;

  // Full-page navigations (link clicks, JS location changes, logo → "/").
  contents.on('will-navigate', (event, url) => {
    // Let Google auth flows proceed in place — they return to alarmind.in.
    if (isGoogleAuthUrl(url)) return;
    const decision = classifyNavigation(url);
    if (decision === 'redirect') {
      event.preventDefault();
      // A logged-in user lands on the dashboard; a logged-out user is bounced
      // by the site itself from /dashboard back to /login. Either way the
      // marketing landing page never shows.
      contents.loadURL(DASHBOARD_URL).catch(() => showOfflinePage());
    } else if (decision === 'external') {
      event.preventDefault();
      shell.openExternal(url);
    }
    // 'allow' → do nothing, navigation proceeds.
  });

  // Redirects that resolve to the landing page (e.g. server 302 to "/").
  contents.on('will-redirect', (event, url) => {
    if (isLandingPage(url)) {
      event.preventDefault();
      contents.loadURL(DASHBOARD_URL).catch(() => showOfflinePage());
    }
  });

  // Client-side (SPA) route changes don't fire will-navigate — Next.js links
  // update the URL in-page. This is how the logo click was reaching the
  // landing page. Catch those here and bounce to the dashboard.
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isLandingPage(url)) {
      contents.loadURL(DASHBOARD_URL).catch(() => showOfflinePage());
    }
  });

  // window.open / target="_blank" / new-window requests.
  contents.setWindowOpenHandler(({ url }) => {
    // Google sign-in must open as a real in-app popup: it talks back to the
    // login page via postMessage, which only works if we let Electron create
    // the child window (system browser can't reach back into the app).
    if (isGoogleAuthUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 640,
          autoHideMenuBar: true,
          title: 'Sign in with Google',
          backgroundColor: '#ffffff',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    const decision = classifyNavigation(url);
    if (decision === 'external') {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (decision === 'redirect') {
      contents.loadURL(DASHBOARD_URL).catch(() => showOfflinePage());
      return { action: 'deny' };
    }
    // Tool pages the site intentionally opens as popups (e.g. the whiteboard
    // during a call) get a real child window — loading them in the main view
    // would navigate away from the call.
    if (isPopupToolUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 700,
          autoHideMenuBar: true,
          title: 'Alarmind',
          backgroundColor: '#0a0a0a',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    // Keep other in-app Alarmind links inside the same window (no popups).
    contents.loadURL(url).catch(() => showOfflinePage());
    return { action: 'deny' };
  });

  // Real load failures (DNS, no network, timeouts) → offline screen.
  contents.on('did-fail-load', (event, errorCode, _desc, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires for our own preventDefault redirects.
    if (!isMainFrame || errorCode === -3) return;
    if (validatedURL && validatedURL.startsWith('file://')) return;
    showOfflinePage();
  });

  // Remember the last real page so reconnection/refresh can return to it,
  // and clear the offline flag once any alarmind.in page actually loads.
  contents.on('did-navigate', (_event, url) => {
    if (isAlarmindUrl(url) && !isLandingPage(url)) {
      lastGoodUrl = url;
      isShowingOffline = false;
      stopReconnectLoop();
    }
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && isAlarmindUrl(url) && !isLandingPage(url)) {
      lastGoodUrl = url;
    }
  });

  // If the site's renderer process dies (GPU driver hiccup, out-of-memory,
  // a Chromium crash), reload it instead of leaving a frozen white window.
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    setTimeout(() => {
      if (!contentView || contentView.webContents.isDestroyed()) return;
      contentView.webContents.loadURL(lastGoodUrl).catch(() => showOfflinePage());
    }, 1000);
  });

  // A hung page (unresponsive for 30s+) gets one automatic reload too.
  contents.on('unresponsive', () => {
    setTimeout(() => {
      if (!contentView || contentView.webContents.isDestroyed()) return;
      if (contentView.webContents.isCrashed()) return; // handled above
      contentView.webContents.reload();
    }, 5000);
  });
}

// ---- Keyboard shortcuts ---------------------------------------------------
// There is no menu bar, so the essentials are wired here directly.

function attachShortcuts() {
  const contents = contentView.webContents;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrl = process.platform === 'darwin' ? input.meta : input.control;

    if ((ctrl && key === 'r') || key === 'f5') {
      refreshSite();
      event.preventDefault();
    } else if (input.alt && key === 'arrowleft') {
      if (contents.canGoBack()) contents.goBack();
      event.preventDefault();
    } else if (input.alt && key === 'arrowright') {
      if (contents.canGoForward()) contents.goForward();
      event.preventDefault();
    } else if (ctrl && (key === '=' || key === '+')) {
      contents.setZoomLevel(contents.getZoomLevel() + 0.5);
      event.preventDefault();
    } else if (ctrl && key === '-') {
      contents.setZoomLevel(contents.getZoomLevel() - 0.5);
      event.preventDefault();
    } else if (ctrl && key === '0') {
      contents.setZoomLevel(0);
      event.preventDefault();
    } else if (key === 'f11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });
}

// ---- Window events (layout, state persistence, titlebar sync) ------------

function attachWindowEvents() {
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };

  mainWindow.on('resize', () => {
    layoutContentView();
    scheduleSave();
  });
  mainWindow.on('move', scheduleSave);

  // Windows fires 'resize' before the new bounds are final during
  // maximize/restore/snap and DPI changes — resettle the layout after.
  mainWindow.on('resized', scheduleLayout);

  // Tell the titlebar to swap its maximize/restore glyph.
  const sendMaximized = (isMaximized) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-change', isMaximized);
    }
  };
  mainWindow.on('maximize', () => {
    scheduleLayout();
    sendMaximized(true);
  });
  mainWindow.on('unmaximize', () => {
    scheduleLayout();
    sendMaximized(false);
  });

  // Hide the titlebar strip in fullscreen (e.g. F11 or video fullscreen).
  mainWindow.on('enter-full-screen', () => scheduleLayout());
  mainWindow.on('leave-full-screen', () => scheduleLayout());

  // Re-showing from tray after a display/DPI change (dock, projector,
  // remote desktop) needs a fresh layout pass too.
  mainWindow.on('show', () => scheduleLayout());
  mainWindow.on('restore', () => scheduleLayout());

  // Zoom/Meet-style: minimizing the window during a live call pops the
  // floating always-on-top mini call window instead of hiding the call.
  mainWindow.on('minimize', () => {
    if (callActive && !miniCallMode) {
      mainWindow.restore();
      enterMiniCallMode();
    }
  });

  mainWindow.on('close', (event) => {
    saveWindowState();
    if (isQuitting) return;
    event.preventDefault();
    // WhatsApp-style: closing during a live call collapses to a small
    // always-on-top floating call window instead of vanishing to the tray —
    // the call continues, visibly. Closing that mini window hides to tray
    // (the call itself still keeps running; audio continues).
    if (callActive && !miniCallMode) {
      enterMiniCallMode();
    } else {
      if (miniCallMode) exitMiniCallMode(false);
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    contentView = null;
  });
}

// ---- Tray (keeps the app alive for notifications) -------------------------

// WhatsApp-style floating call window: when the user closes the app during a
// live call, shrink to a small always-on-top window in the bottom-right
// corner instead of hiding. The website sees the resize and collapses the
// call to its own mini-player UI, so what remains on screen is a tidy
// floating call tile that keeps the call fully alive.
const MINI_CALL_WIDTH = 320;
const MINI_CALL_HEIGHT = 300;

function enterMiniCallMode() {
  if (!mainWindow || mainWindow.isDestroyed() || miniCallMode) return;
  miniCallMode = true;
  boundsBeforeMini = {
    bounds: mainWindow.getNormalBounds(),
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen(),
  };
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  if (mainWindow.isMaximized()) mainWindow.unmaximize();

  const { workArea } = screen.getPrimaryDisplay();
  mainWindow.setMinimumSize(MINI_CALL_WIDTH, MINI_CALL_HEIGHT);
  mainWindow.setBounds({
    x: workArea.x + workArea.width - MINI_CALL_WIDTH - 16,
    y: workArea.y + workArea.height - MINI_CALL_HEIGHT - 16,
    width: MINI_CALL_WIDTH,
    height: MINI_CALL_HEIGHT,
  });
  mainWindow.setAlwaysOnTop(true, 'floating');
  scheduleLayout();
  // Tell the site so it can switch the call UI to its mini-player layout.
  sendToSite('desktop:mini-call-change', true);
}

function exitMiniCallMode(restoreVisible) {
  if (!mainWindow || mainWindow.isDestroyed() || !miniCallMode) return;
  miniCallMode = false;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimumSize(900, 600);
  if (boundsBeforeMini) {
    mainWindow.setBounds(boundsBeforeMini.bounds);
    if (boundsBeforeMini.isMaximized) mainWindow.maximize();
    if (boundsBeforeMini.isFullScreen) mainWindow.setFullScreen(true);
    boundsBeforeMini = null;
  }
  scheduleLayout();
  sendToSite('desktop:mini-call-change', false);
  if (restoreVisible) showMainWindow();
}

function sendToSite(channel, payload) {
  if (contentView && !contentView.webContents.isDestroyed()) {
    contentView.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Opening the app while in the floating call window restores the full app.
  if (miniCallMode) {
    exitMiniCallMode(false);
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('Alarmind');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Alarmind', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          // Start hidden in the tray at boot — no window popping up.
          args: ['--hidden'],
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Alarmind',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  // Single click on the tray icon opens the app (standard Windows behavior).
  tray.on('click', showMainWindow);
}

// ---- IPC: titlebar window controls ----------------------------------------

ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});
ipcMain.on('window:refresh', () => {
  refreshSite();
});
// Site-triggered (incoming call / notification click): surface the window
// even when it's hidden in the tray.
ipcMain.on('app:show-window', () => {
  showMainWindow();
});

// The website reports call lifecycle over this channel. While a call is
// live we also block system sleep so Windows doesn't suspend mid-call.
ipcMain.on('call:state', (_event, isActive) => {
  callActive = Boolean(isActive);
  if (callActive) {
    if (powerSaveBlockerId === null) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else {
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
    // Call ended while in the floating mini window → restore the full app.
    if (miniCallMode) exitMiniCallMode(true);
  }
});

// The site's mini-player "maximize" button while in the floating window.
ipcMain.on('call:expand', () => {
  showMainWindow();
});

// The site's PiP button during a call: pop the whole call out into the
// floating always-on-top mini window (Zoom/Meet-style), not an in-page tile.
ipcMain.on('call:collapse', () => {
  if (callActive && !miniCallMode) enterMiniCallMode();
});

// ---- System-browser sign-in handoff ---------------------------------------
// Google-recommended flow for desktop apps: the user signs in with their real
// browser, and the session is handed back via a one-time, single-use code.
// The app registers { codeId, sha256(secret) }, opens the browser with only
// the public codeId, and polls the exchange endpoint with the secret until
// the user approves in the browser.

function apiPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      `${API_ORIGIN}${pathname}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch {
            reject(new Error(`Bad response from ${pathname}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.write(data);
    req.end();
  });
}

let browserSigninActive = false;

ipcMain.on('auth:browser-signin', async () => {
  if (browserSigninActive) return; // ignore double-clicks
  browserSigninActive = true;
  try {
    const codeId = crypto.randomBytes(32).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const start = await apiPost('/api/auth/desktop/start', { codeId, secretHash });
    if (start.status !== 200) throw new Error('Could not start sign-in');

    shell.openExternal(`${SITE_ORIGIN}/desktop-login?code=${codeId}`);

    // Poll until approved, expired (~10 min), or the window is gone.
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!contentView || contentView.webContents.isDestroyed()) return;

      const res = await apiPost('/api/auth/desktop/exchange', { codeId, secret });
      if (res.status !== 200) return; // expired or consumed — stop quietly
      if (res.json.pending) continue;

      // Approved: write the session the same way the website stores it
      // (zustand persist "auth-storage"), then go to the dashboard.
      const { token, user } = res.json;
      const authStorage = JSON.stringify({
        state: { token, user, isAuthenticated: true },
        version: 0,
      });
      await contentView.webContents.executeJavaScript(
        `localStorage.setItem('auth-storage', ${JSON.stringify(authStorage)}); true`
      );
      contentView.webContents.loadURL(DASHBOARD_URL).catch(() => showOfflinePage());
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      return;
    }
  } catch (err) {
    console.error('Browser sign-in failed:', err.message);
  } finally {
    browserSigninActive = false;
  }
});

// ---- Security: lock permissions to what the app needs -------------------

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = [
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      // Jitsi calls need camera + microphone ('media' covers both), HTML
      // fullscreen for the call view, and display-capture for screen share.
      'media',
      'fullscreen',
      'display-capture',
    ];
    callback(allowed.includes(permission));
  });

  // Screen sharing: Chromium's picker doesn't exist in Electron — without a
  // handler, Jitsi's "share screen" button silently fails. Show our own
  // picker dialog (screens + application windows with live thumbnails).
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    openScreenPicker(callback);
  });
}

// ---- Screen-share picker ---------------------------------------------------
// A small modal dialog listing every screen and window with thumbnails,
// like Chrome's share dialog. Resolves the display-media callback with the
// chosen source, or {} to cancel (Jitsi treats that as "user cancelled").

let pickerWindow = null;
let pickerCallback = null;

function resolvePicker(result) {
  if (pickerCallback) {
    const cb = pickerCallback;
    pickerCallback = null;
    try {
      cb(result);
    } catch {
      /* stream request may have been aborted meanwhile */
    }
  }
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  pickerWindow = null;
}

async function openScreenPicker(callback) {
  // One picker at a time; a second request cancels the first.
  if (pickerCallback) resolvePicker({});
  pickerCallback = callback;

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 240 },
      fetchWindowIcons: true,
    });
  } catch {
    resolvePicker({});
    return;
  }

  pickerWindow = new BrowserWindow({
    width: 640,
    height: 520,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Share your screen',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'screen-picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pickerWindow.loadFile(path.join(__dirname, 'screen-picker.html'));
  pickerWindow.once('ready-to-show', () => {
    if (!pickerWindow || pickerWindow.isDestroyed()) return;
    pickerWindow.show();
    pickerWindow.webContents.send(
      'screen-picker:sources',
      sources.map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen:'),
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }))
    );
  });
  // Closing the dialog without choosing = cancel.
  pickerWindow.on('closed', () => {
    pickerWindow = null;
    resolvePicker({});
  });

  ipcMain.removeAllListeners('screen-picker:select');
  ipcMain.removeAllListeners('screen-picker:cancel');
  ipcMain.once('screen-picker:select', (_event, sourceId) => {
    const source = sources.find((s) => s.id === sourceId);
    resolvePicker(source ? { video: source } : {});
  });
  ipcMain.once('screen-picker:cancel', () => resolvePicker({}));
}

// ---- App lifecycle -------------------------------------------------------

// Single-instance: focus the existing window instead of opening a second app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Relaunching the app while it sits in the tray reopens the window.
    showMainWindow();
  });

  app.on('before-quit', () => {
    // Covers OS shutdown/logoff quits too, so close doesn't cancel them.
    isQuitting = true;
  });

  app.whenReady().then(() => {
    hardenSession();
    // No application menu anywhere — the custom titlebar is the only chrome.
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  // The window "closing" just hides it — the app lives in the tray, keeping
  // the socket connected so notifications continue. Real exit is tray Quit.
  app.on('window-all-closed', () => {
    // Intentionally no app.quit() here (except macOS convention is kept by
    // the hide-to-tray close handler never destroying the window anyway).
  });
}
