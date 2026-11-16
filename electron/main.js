'use strict';
// Desktop shell: starts the engine in this process and shows its UI in a window, with a tray icon.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { Messenger } = require('../core/messenger');
const { startServer } = require('../core/server');

let win = null, tray = null, messenger = null, server = null, quitting = false;

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
  messenger = new Messenger(app.getPath('userData'));
  await messenger.start();
  server = await startServer(messenger);
  const origin = `http://127.0.0.1:${server.port}`;

  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 380, minHeight: 480, title: 'TeamLink', autoHideMenuBar: true, show: !process.argv.includes('--hidden'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.loadURL(server.url);

  // The window only ever shows the local UI; links in messages open in the system browser.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) { e.preventDefault(); external(url); } });
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'notifications'));

  // Closing the window keeps the app running in the tray so messages still arrive.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });

  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('TeamLink');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open TeamLink', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch {}

  messenger.on('event', (name) => { if (name === 'incoming' && !win.isFocused()) win.flashFrame(true); });
  win.on('focus', () => win.flashFrame(false));
  app.on('activate', showWindow);
}

const fromUi = (e) => !!win && e.sender === win.webContents;
// Only files the engine already knows about may be opened from the UI.
const knownPath = (p) => !!messenger.store.get('SELECT 1 x FROM files WHERE path=?', String(p));

ipcMain.handle('pickFiles', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths : []));
ipcMain.handle('pickFolder', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openDirectory'] })).filePaths : []));
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

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (!messenger) return;
  e.preventDefault();
  Promise.resolve().then(() => { server && server.close(); return messenger.stop(); }).catch(() => {}).finally(() => app.exit(0));
});
app.on('window-all-closed', () => {});
