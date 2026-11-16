'use strict';
// Desktop shell: starts the engine in this process and shows its UI in a window, with a tray icon.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { Messenger } = require('../core/messenger');
const { startServer } = require('../core/server');

let win = null, tray = null, messenger = null, server = null, exiting = false;

// Tray icon drawn in code (a teal disc), so the app ships without binary assets.
function trayIcon() {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), a = Math.max(0, Math.min(1, 14.5 - d));
    buf.set([0x88 * a, 0x94 * a, 0x0d * a, 255 * a], (y * size + x) * 4); // premultiplied BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch((e) => { dialog.showErrorBox('TeamLink could not start', String(e && e.stack || e)); app.exit(1); });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function start() {
  // After a silent self-update the app comes back the way it was: hidden in the tray.
  const hiddenOnce = path.join(app.getPath('userData'), 'start-hidden-once');
  const startHidden = process.argv.includes('--hidden') || fs.existsSync(hiddenOnce);
  fs.rmSync(hiddenOnce, { force: true });

  messenger = new Messenger(app.getPath('userData'));
  await messenger.start();
  server = await startServer(messenger);
  const origin = `http://127.0.0.1:${server.port}`;

  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 380, minHeight: 480, title: 'TeamLink', autoHideMenuBar: true, show: !startHidden,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.loadURL(server.url);

  // The window only ever shows the local UI; links in messages open in the system browser.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) { e.preventDefault(); external(url); } });
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'notifications'));

  // Closing the window keeps the app running in the tray so messages still arrive.
  win.on('close', (e) => { if (!exiting) { e.preventDefault(); win.hide(); } });
  // Windows signs out / shuts down: this is the one case where the app must really stop.
  win.on('session-end', exitApp);
  powerMonitor.on('shutdown', exitApp);

  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('TeamLink');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open TeamLink', click: showWindow },
      { type: 'separator' },
      { label: 'Exit TeamLink completely…', click: confirmExit },
    ]));
    tray.on('click', showWindow);
  } catch {}

  messenger.on('event', (name) => { if (name === 'incoming' && !win.isFocused()) win.flashFrame(true); });
  win.on('focus', () => win.flashFrame(false));
  win.on('hide', installIfReady);
  setupUpdates();

  // Installed app: start with the computer by default, once. It can be switched off in Settings.
  const marker = path.join(app.getPath('userData'), 'autostart-set');
  if (app.isPackaged && !fs.existsSync(marker)) {
    try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); fs.writeFileSync(marker, '1'); } catch {}
  }
  app.on('activate', showWindow);
}

const fromUi = (e) => !!win && e.sender === win.webContents;
// Only files the engine already knows about may be opened from the UI.
const knownPath = (p) => !!messenger.store.get('SELECT 1 x FROM files WHERE path=?', String(p));

ipcMain.handle('pickFiles', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths : []));
ipcMain.handle('pickFolder', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openDirectory'] })).filePaths : []));
ipcMain.handle('pickSave', async (e, name) => {
  if (!fromUi(e)) return null;
  const dir = messenger.cfg.downloadDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const r = await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: path.join(dir, path.basename(String(name || 'file'))) });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('openPath', async (e, p) => {
  if (!fromUi(e) || !knownPath(p)) return;
  const choice = await dialog.showMessageBox(win, { type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Open "${path.basename(p)}"?`, detail: 'Only open files from people you trust. Programs and scripts can harm your computer.' });
  if (choice.response === 0) shell.openPath(p);
});
ipcMain.handle('showItem', (e, p) => { if (fromUi(e) && knownPath(p)) shell.showItemInFolder(p); });
ipcMain.handle('setUnread', (e, n) => {
  if (!fromUi(e)) return;
  try { app.setBadgeCount(Number(n) || 0); } catch {}
  if (tray) tray.setToolTip(n ? `TeamLink (${n} unread)` : 'TeamLink');
});
ipcMain.handle('focus', (e) => { if (fromUi(e)) showWindow(); });
ipcMain.handle('getAutostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('setAutostart', (e, on) => { if (fromUi(e)) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); });

// TeamLink is meant to stay reachable all day. Closing the window, Quit in the menu, Alt+F4 or Cmd+Q
// only hide it; it keeps running in the tray. The only way to stop it is the tray's "Exit completely".
app.on('before-quit', (e) => {
  if (exiting) return;
  e.preventDefault();
  if (win) win.hide();
});

async function confirmExit() {
  const choice = await dialog.showMessageBox({ type: 'question', buttons: ['Keep running', 'Exit'], defaultId: 0, cancelId: 0,
    message: 'Exit TeamLink completely?', detail: 'You will appear offline and will not receive messages or files until you start it again.' });
  if (choice.response === 1) exitApp();
}

function exitApp() {
  if (exiting) return;
  exiting = true;
  Promise.resolve().then(() => { server && server.close(); return messenger && messenger.stop(); }).catch(() => {}).finally(() => app.exit(0));
}

app.on('window-all-closed', () => {});

// ------------------------------------------------------------------ updates
// New versions come from the project's GitHub Releases. Windows and Linux download and install them
// by themselves; unsigned macOS builds cannot self-install, so there the app only points to the download.
const RELEASES = 'https://github.com/sinhahk2812-lab/teamlink/releases/latest';
const canSelfInstall = process.platform !== 'darwin';
let updater = null;
const update = { current: app.getVersion(), status: app.isPackaged ? 'idle' : 'dev', version: '', percent: 0, error: '', canSelfInstall };

function setUpdate(patch) {
  Object.assign(update, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update', update);
}

function setupUpdates() {
  if (!app.isPackaged) return;
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return setUpdate({ status: 'error', error: e.message }); }
  updater.autoDownload = canSelfInstall;
  updater.autoInstallOnAppQuit = canSelfInstall;
  updater.on('checking-for-update', () => setUpdate({ status: 'checking', error: '' }));
  updater.on('update-not-available', () => setUpdate({ status: 'latest' }));
  updater.on('update-available', (info) => setUpdate({ status: canSelfInstall ? 'downloading' : 'available', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => { setUpdate({ status: 'ready', version: info.version }); installIfReady(); });
  updater.on('error', (e) => setUpdate({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
  setTimeout(checkNow, 15000);
  setInterval(checkNow, 4 * 3600 * 1000);
}

function checkNow() {
  if (!updater || ['checking', 'downloading', 'ready'].includes(update.status)) return;
  updater.checkForUpdates()
    .then((r) => { if (!r && update.status !== 'error') setUpdate({ status: 'error', error: 'this kind of install cannot update itself' }); })
    .catch((e) => setUpdate({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
}

// A downloaded update installs by itself as soon as nobody is looking at the window.
function installIfReady() {
  if (update.status === 'ready' && win && !win.isVisible()) installUpdate(true);
}

function installUpdate(comeBackHidden) {
  if (!updater || update.status !== 'ready' || exiting) return;
  exiting = true;
  if (comeBackHidden) { try { fs.writeFileSync(path.join(app.getPath('userData'), 'start-hidden-once'), '1'); } catch {} }
  Promise.resolve().then(() => { server && server.close(); return messenger && messenger.stop(); }).catch(() => {})
    .finally(() => updater.quitAndInstall(true, true));
}

ipcMain.handle('getUpdate', () => update);
ipcMain.handle('checkUpdate', (e) => {
  if (fromUi(e)) checkNow();
  return update;
});
ipcMain.handle('installUpdate', (e) => {
  if (!fromUi(e)) return;
  if (update.status === 'available') shell.openExternal(RELEASES);
  else installUpdate(false);
});
