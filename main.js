'use strict';
const {
  app, BrowserWindow, ipcMain, dialog, shell, protocol, Tray, Menu, nativeImage,
  globalShortcut, powerSaveBlocker, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const { LibraryStore } = require('./lib/store');
const { readTags } = require('./lib/tags');
const { Diag } = require('./lib/diag');
const { Watcher } = require('./lib/watcher');
const { isAudio } = require('./lib/audio');
const { respond, pathFromUrl } = require('./lib/media');

const APP_NAME = 'Dj Ape1';
const ICON = path.join(__dirname, 'assets', 'icon.png');

// Portable build: keep all data next to the .exe
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'DjApe1Data'));
}

// Big libraries (30k+ tracks) need more than the default V8 heap; timers must keep running
// while the window is minimised, otherwise crossfades / Automix would stall.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

protocol.registerSchemesAsPrivileged([{
  scheme: 'djfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
}]);

/* ------------------------------------------------------------------ state */
let win = null;
let tray = null;
let quitting = false;
let flushed = false;
let flushResolve = null;
let pendingOpen = [];
let crashedFlag = false;
let blocker = null;
let store; let diag; let watcher;
let prefs = { closeToTray: false, bounds: null, max: false };

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
const loadPrefs = () => { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { /* first run */ } };
const savePrefs = () => { try { fs.mkdirSync(path.dirname(prefsFile()), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch { /* ignore */ } };
const markerFile = () => path.join(app.getPath('userData'), '.running');

const memSummary = () => {
  try {
    return app.getAppMetrics()
      .map((m) => `${m.type === 'Tab' ? 'Tab' : m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`)
      .join(' ');
  } catch { return ''; }
};

const send = (ch, ...a) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); } catch { /* window closing */ } };

const argvPaths = (argv) => argv
  .slice(app.isPackaged ? 1 : 2)
  .filter((a) => a && !a.startsWith('-'))
  .filter((a) => { try { const st = fs.statSync(a); return st.isDirectory() || isAudio(a); } catch { return false; } })
  .map((a) => path.resolve(a));

/* ----------------------------------------------------------- single instance */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    const p = argvPaths(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (p.length) send('open', p);
  });
  app.whenReady().then(start);
}

/* ------------------------------------------------------------------- window */
function createWindow(startHidden) {
  const b = prefs.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1360, height: b.height || 860, x: b.x, y: b.y,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0b10', show: false, title: APP_NAME, icon: ICON, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => {
    if (prefs.max) win.maximize();
    if (!startHidden) win.show();
  });

  // links: external sites open in the system browser, the mini player may open as a small popup
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 380, height: 170, alwaysOnTop: true, autoHideMenuBar: true, icon: ICON,
          resizable: /resizable/.test(features || ''), backgroundColor: '#0b0b10',
        },
      };
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I')) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));

  // diagnostics
  win.on('unresponsive', () => diag.write('unresponsive'));
  win.on('responsive', () => diag.write('responsive'));
  win.webContents.on('render-process-gone', (_e, d) => {
    crashedFlag = true;
    diag.write('render-process-gone', { reason: d.reason, exitCode: d.exitCode });
    if (!quitting && d.reason !== 'clean-exit') setTimeout(() => { try { win.reload(); } catch { /* ignore */ } }, 800);
  });

  // close: tray / flush the library before really closing
  win.on('close', (e) => {
    if (!win.isMinimized() && !win.isFullScreen()) {
      try { prefs.bounds = win.getNormalBounds(); prefs.max = win.isMaximized(); savePrefs(); } catch { /* ignore */ }
    }
    if (!quitting && prefs.closeToTray && tray) { e.preventDefault(); win.hide(); return; }
    if (!flushed) {
      e.preventDefault();
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(t); flushed = true; flushResolve = null; if (win && !win.isDestroyed()) win.close(); };
      const t = setTimeout(fin, 6000); // never hang if the page is frozen
      flushResolve = fin;
      try { win.webContents.send('flush'); } catch { fin(); }
    }
  });
  win.on('closed', () => { win = null; });
}

/* --------------------------------------------------------------------- tray */
function setTray(on) {
  if (!on) { if (tray) { tray.destroy(); tray = null; } return; }
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  const show = () => { if (win) { win.show(); win.focus(); } };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Εμφάνιση', click: show },
    { type: 'separator' },
    { label: 'Αναπαραγωγή / Παύση', click: () => send('cmd', 'toggle') },
    { label: 'Προηγούμενο', click: () => send('cmd', 'prev') },
    { label: 'Επόμενο', click: () => send('cmd', 'next') },
    { type: 'separator' },
    { label: 'Έξοδος', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', show);
}

/* --------------------------------------------------------------------- ipc */
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => {
  if (!win || e.sender !== win.webContents) throw new Error('untrusted sender');
  return fn(...a);
});

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

function registerIpc() {
  handle('native:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Επιλογή φακέλου μουσικής' });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  handle('native:readdir', async (dir) => {
    const ents = await fsp.readdir(String(dir), { withFileTypes: true });
    const out = [];
    await mapLimit(ents, 64, async (d) => {
      const full = path.join(dir, d.name);
      try {
        let isDir = d.isDirectory();
        let isFile = d.isFile();
        let st = null;
        if (d.isSymbolicLink()) { st = await fsp.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); }
        if (isDir) {
          if (d.name.startsWith('$') || d.name === 'System Volume Information') return;
          out.push({ name: d.name, dir: true });
        } else if (isFile) {
          if (isAudio(d.name)) { st = st || await fsp.stat(full); out.push({ name: d.name, dir: false, size: st.size, mtime: st.mtimeMs }); }
          else out.push({ name: d.name, dir: false, size: 0, mtime: 0 });
        }
      } catch { /* unreadable entry */ }
    });
    return out;
  });

  handle('native:stat', async (paths) => {
    const out = [];
    for (const p of paths || []) {
      try {
        const st = await fsp.stat(String(p));
        out.push({ path: String(p), name: path.basename(String(p)), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch { /* missing */ }
    }
    return out;
  });

  handle('native:readTags', (p) => readTags(String(p)));

  handle('lib:save', (json) => store.save(json));
  handle('lib:load', () => store.load());
  handle('lib:info', () => store.info());
  handle('lib:backups', () => store.backups());
  handle('lib:backupNow', () => store.backupNow());
  handle('lib:backup', (name) => store.readBackup(name));
  handle('lib:openDir', () => shell.openPath(store.dir));

  ipcMain.on('native:watch', (e, paths) => {
    if (!win || e.sender !== win.webContents) return;
    watcher.set(Array.isArray(paths) ? paths.map(String) : []);
  });

  handle('app:toggleFullscreen', () => { win.setFullScreen(!win.isFullScreen()); });
  handle('app:openLog', () => shell.openPath(diag.file));
  handle('app:getCrash', () => { const c = crashedFlag; crashedFlag = false; return { crashed: c }; });
  handle('app:getOpen', () => { const p = pendingOpen; pendingOpen = []; return p; });

  handle('prefs:get', () => ({
    closeToTray: !!prefs.closeToTray,
    login: app.getLoginItemSettings().openAtLogin,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
  }));
  handle('prefs:set', (p) => {
    if (p && typeof p.closeToTray === 'boolean') { prefs.closeToTray = p.closeToTray; setTray(p.closeToTray); savePrefs(); }
    if (p && typeof p.login === 'boolean' && !process.env.PORTABLE_EXECUTABLE_DIR) {
      app.setLoginItemSettings({ openAtLogin: p.login, args: ['--hidden'] });
    }
    return true;
  });

  ipcMain.on('app:diag', (e, kind, data) => { if (win && e.sender === win.webContents) diag.write(String(kind).slice(0, 40), data); });
  ipcMain.on('app:flushDone', (e) => { if (win && e.sender === win.webContents && flushResolve) flushResolve(); });
  ipcMain.on('app:state', (e, s) => {
    if (!win || e.sender !== win.webContents || !s) return;
    const label = s.title ? `${s.artist ? s.artist + ' – ' : ''}${s.title}` : '';
    win.setTitle(label ? `${label} · ${APP_NAME}` : APP_NAME);
    if (tray) tray.setToolTip(label || APP_NAME);
    if (s.playing && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!s.playing && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  });
}

/* -------------------------------------------------------------------- start */
async function start() {
  loadPrefs();
  const userData = app.getPath('userData');
  store = new LibraryStore(path.join(userData, 'library'));
  diag = new Diag(path.join(userData, 'logs'), memSummary);
  watcher = new Watcher(() => send('changed'));

  // previous run did not exit cleanly -> tell the page so it restores the library
  try { crashedFlag = fs.existsSync(markerFile()); fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(markerFile(), String(Date.now())); } catch { /* ignore */ }
  diag.write('log-created');

  pendingOpen = argvPaths(process.argv);

  protocol.handle('djfile', async (req) => {
    try {
      const file = pathFromUrl(req.url);
      if (!isAudio(file)) return new Response('forbidden', { status: 403 });
      return await respond(file, req.headers.get('range'));
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));

  registerIpc();
  Menu.setApplicationMenu(null);
  setTray(!!prefs.closeToTray);
  createWindow(process.argv.includes('--hidden') && !!prefs.closeToTray);

  for (const [key, cmd] of [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev'], ['MediaStop', 'stop']]) {
    try { globalShortcut.register(key, () => send('cmd', cmd)); } catch { /* key taken */ }
  }

  app.on('child-process-gone', (_e, d) => diag.write('child-process-gone', { type: d.type, reason: d.reason }));
  app.on('activate', () => { if (win) win.show(); });
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  if (watcher) watcher.close();
  try { fs.unlinkSync(markerFile()); } catch { /* ignore */ } // clean exit
});
app.on('window-all-closed', () => { app.quit(); });
