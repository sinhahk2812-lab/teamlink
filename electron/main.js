'use strict';
// Desktop shell: starts the engine in this process and shows its UI in a window, with a tray icon.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage, powerMonitor, screen, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Messenger } = require('../core/messenger');
const { startServer } = require('../core/server');

let win = null, tray = null, messenger = null, server = null, exiting = false;

// Windows only shows notifications and groups taskbar windows correctly when this matches the installer's appId.
app.setAppUserModelId('team.teamlink.app');
const ICON = path.join(__dirname, 'icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch((e) => { dialog.showErrorBox('TeamLink could not start', String(e && e.stack || e)); app.exit(1); });
}

function openSend() {
  showWindow();
  if (win) win.webContents.send('openSend');
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

  Messenger.applyPendingRestore(app.getPath('userData')); // a restore chosen before the restart
  messenger = new Messenger(app.getPath('userData'));
  await messenger.start();
  server = await startServer(messenger);
  const origin = `http://127.0.0.1:${server.port}`;

  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 380, minHeight: 480, title: 'TeamLink', icon: ICON, autoHideMenuBar: true, show: !startHidden,
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
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
    tray.setToolTip('TeamLink');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'New message…', click: openSend },
      { label: 'Open TeamLink', click: showWindow },
      { type: 'separator' },
      { label: 'Exit TeamLink completely…', click: confirmExit },
    ]));
    tray.on('click', showWindow);
  } catch {}

  messenger.on('event', (name, d) => { if (name === 'incoming') onIncoming(d); else if (name === 'opened') onOpened(d); });
  win.on('focus', () => { win.flashFrame(false); hidePopup(); });
  win.on('hide', installIfReady);
  setupUpdates();

  // Installed app: start with the computer by default, once. It can be switched off in Settings.
  // ("-2": versions before 1.2.0 could switch it off by mistake when Settings was saved, so it is applied once more.)
  const marker = path.join(app.getPath('userData'), 'autostart-set-2');
  if (app.isPackaged && !fs.existsSync(marker)) {
    try { setAutostart(true); fs.writeFileSync(marker, '1'); } catch {}
  }
  app.on('activate', showWindow);
}

// ------------------------------------------------------------------ message popup
// Like IP Messenger: a new message pops up in the corner of the screen, on top of other programs,
// and stays there until it is clicked (opens the chat) or dismissed.
const POPUP_W = 584, POPUP_H = 200; // includes a transparent margin for the card's glow and shadow
let popupAnim = null;
let popup = null, popupReady = false, popupData = null, popupCount = 0;

// The popup is skipped only when the user is really looking at that very conversation: TeamLink is the
// active window, not minimised, and that chat is the one open. Being in another chat (or having the
// window merely open behind other programs) still gets the popup, like IP Messenger.
let activeConv = null;
function lookingAt(conv) {
  return win.isVisible() && !win.isMinimized() && win.isFocused() && activeConv === conv;
}
ipcMain.on('activeConv', (e, conv) => { if (win && e.sender === win.webContents) activeConv = conv ? String(conv) : null; });

function onIncoming(d) {
  if (lookingAt(d.conv)) return; // that chat is open in front of the user right now
  win.flashFrame(true);
  if (messenger.cfg.popup === false) return;
  const conv = messenger.convView(messenger.store.conv(d.conv));
  const peer = messenger.peers.get(d.from);
  const who = (peer && peer.name) || 'Someone';
  const prefs = messenger.popupPrefs();
  popupCount += 1;
  popupData = { conv: d.conv, count: popupCount, body: prefs.showText ? (conv.last && conv.last.preview) || 'New message' : 'New message',
    title: conv.type === 'dm' ? who : `${who} · ${conv.type === 'all' ? 'Everyone' : conv.name || 'Group'}` };
  showPopup();
  if (prefs.sound) shell.beep();
}

// The other person opened a sealed message you sent: tell the sender, like IP Messenger's "opened" notice.
function onOpened(d) {
  if (lookingAt(d.conv) || messenger.cfg.popup === false) return; // the window shows it itself
  const peer = messenger.peers.get(d.by);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  popupData = { conv: d.conv, count: 1, title: `${(peer && peer.name) || 'Someone'} opened your message`,
    body: messenger.popupPrefs().showText ? d.preview : 'Sealed message', note: `Opened at ${time} · click to open the chat` };
  showPopup();
}

// Colours for the popup: the user's own choice from the popup settings, otherwise the app theme.
function popupLook() {
  const a = messenger.appearance(), p = messenger.popupPrefs();
  const themeLight = ['rose', 'lavender', 'sand'].includes(a.preset) || (a.preset === 'classic' && (a.mode === 'light' || (a.mode === 'system' && !nativeTheme.shouldUseDarkColors)));
  return { accent: p.color || a.accent, light: p.tone === 'auto' ? themeLight : p.tone === 'light', motion: a.motion, design: p.design };
}

const POPUP_SCALE = { s: 0.8, m: 1, l: 1.22, xl: 1.45 };
let popupHideTimer = null;

function showPopup() {
  const prefs = messenger.popupPrefs();
  Object.assign(popupData, popupLook());
  if (!popup || popup.isDestroyed()) {
    popupReady = false;
    popup = new BrowserWindow({ width: POPUP_W, height: POPUP_H, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'TeamLink message', icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'popup-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    popup.setAlwaysOnTop(true, 'pop-up-menu');
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (e) => e.preventDefault());
    popup.loadFile(path.join(__dirname, 'popup.html'));
  }
  // Size and place come from the popup settings. The page is zoomed with the window so everything scales together.
  const scale = POPUP_SCALE[prefs.size] || 1, W = Math.round(POPUP_W * scale), H = Math.round(POPUP_H * scale);
  popupData.scale = scale;
  const area = screen.getPrimaryDisplay().workArea, [vert, horiz] = prefs.pos.split('-'), EDGE = 6;
  const x = horiz === 'left' ? area.x + EDGE : horiz === 'right' ? area.x + area.width - W - EDGE : Math.round(area.x + (area.width - W) / 2);
  const restY = vert === 'top' ? area.y + EDGE : vert === 'bottom' ? area.y + area.height - H - EDGE : Math.round(area.y + (area.height - H) / 2);
  // It slides in from the nearest screen edge (from just above its place when it sits in the middle).
  const fromY = vert === 'top' ? area.y - H : vert === 'bottom' ? area.y + area.height : restY - 60;
  if (popupReady) popup.webContents.send('popupData', popupData);
  clearTimeout(popupHideTimer);
  if (prefs.hideAfter) popupHideTimer = setTimeout(hidePopup, prefs.hideAfter * 1000);
  // A popup that is already showing in the same place just refreshes its text (the page plays a short pulse).
  const now = popup.getBounds();
  if (popup.isVisible() && !popupAnim && now.x === x && now.y === restY && now.width === W) return;
  clearInterval(popupAnim);
  const started = Date.now(), DURATION = 380;
  popup.setBounds({ x, y: fromY, width: W, height: H });
  try { popup.setOpacity(0); } catch {}
  popup.showInactive(); // never steals the keyboard from what the user is typing in
  popupAnim = setInterval(() => {
    if (!popup || popup.isDestroyed()) { clearInterval(popupAnim); popupAnim = null; return; }
    const t = Math.min(1, (Date.now() - started) / DURATION);
    const c1 = 1.70158, c3 = c1 + 1, ease = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); // ease-out with a small overshoot
    popup.setBounds({ x, y: Math.round(fromY + (restY - fromY) * ease), width: W, height: H });
    try { popup.setOpacity(Math.min(1, t * 1.6)); } catch {}
    if (t >= 1) { clearInterval(popupAnim); popupAnim = null; }
  }, 12);
}

// "Show a test popup" in the popup settings.
ipcMain.handle('testPopup', (e) => {
  if (!win || e.sender !== win.webContents) return;
  popupCount = 0;
  popupData = { conv: null, count: 1, title: 'Asha Verma', body: 'This is how a new message will pop up on your screen.', note: 'Test popup · click to close' };
  if (popup && !popup.isDestroyed()) popup.hide(); // replay the entrance with the new settings
  showPopup();
});

function hidePopup() {
  popupCount = 0;
  clearTimeout(popupHideTimer);
  clearInterval(popupAnim); popupAnim = null;
  if (popup && !popup.isDestroyed()) popup.hide();
}

const fromPopup = (e) => !!popup && !popup.isDestroyed() && e.sender === popup.webContents;
ipcMain.on('popupReady', (e) => { if (fromPopup(e)) { popupReady = true; if (popupData) e.sender.send('popupData', popupData); } });
ipcMain.on('popupClose', (e) => { if (fromPopup(e)) hidePopup(); });
ipcMain.on('popupOpen', (e) => {
  if (!fromPopup(e) || !popupData) return;
  const conv = popupData.conv;
  hidePopup();
  if (!conv) return; // the test popup
  showWindow();
  win.webContents.send('openConv', conv);
});

const fromUi = (e) => !!win && e.sender === win.webContents;
// Only files the engine already knows about may be opened from the UI.
const knownPath = (p) => !!messenger.store.get('SELECT 1 x FROM files WHERE path=?', String(p));

ipcMain.handle('pickFiles', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths : []));
ipcMain.handle('pickFolder', async (e) => (fromUi(e) ? (await dialog.showOpenDialog(win, { properties: ['openDirectory'] })).filePaths : []));
// Save dialogs open in the folder the user saved to last time (falling back to the download folder).
function saveStartDir() {
  const last = messenger.cfg.lastSaveDir;
  if (last && fs.existsSync(last)) return last;
  const dir = messenger.cfg.downloadDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function rememberSaveDir(dir) {
  if (!dir || messenger.cfg.lastSaveDir === dir) return;
  messenger.cfg.lastSaveDir = dir;
  messenger.saveCfg();
}
ipcMain.handle('pickSave', async (e, name) => {
  if (!fromUi(e)) return null;
  const r = await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: path.join(saveStartDir(), path.basename(String(name || 'file'))) });
  if (r.canceled || !r.filePath) return null;
  rememberSaveDir(path.dirname(r.filePath));
  return r.filePath;
});
ipcMain.handle('pickSaveFolder', async (e) => {
  if (!fromUi(e)) return null;
  const r = await dialog.showOpenDialog(win, { title: 'Save all files to', buttonLabel: 'Save here', defaultPath: saveStartDir(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  rememberSaveDir(r.filePaths[0]);
  return r.filePaths[0];
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
// Restart the app (used after a restore, which is applied at start-up).
ipcMain.handle('restart', (e) => {
  if (!fromUi(e) || exiting) return;
  exiting = true;
  Promise.resolve().then(() => { server && server.close(); return messenger && messenger.stop(); }).catch(() => {}).finally(() => { app.relaunch(); app.exit(0); });
});
// Start with the computer. Windows only reports the entry when it is asked with the same path and
// arguments it was written with, so reading and writing must use identical options.
const LOGIN = { path: process.execPath, args: ['--hidden'] };
function getAutostart() { return !!app.getLoginItemSettings(LOGIN).openAtLogin; }
function setAutostart(on) { app.setLoginItemSettings({ ...LOGIN, openAtLogin: !!on }); }
ipcMain.handle('getAutostart', () => getAutostart());
ipcMain.handle('setAutostart', (e, on) => { if (fromUi(e) && !!on !== getAutostart()) setAutostart(on); });

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
