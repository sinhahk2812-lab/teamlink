'use strict';
// Desktop shell: starts the engine in this process and shows its UI in a window, with a tray icon.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage, powerMonitor, screen, nativeTheme, net, Notification } = require('electron');
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
  messenger.on('event', (name, d) => { if (name === 'intakeAlert') onIntakeAlert(d); }); // WHATSAPP-INTAKE
  win.on('focus', () => { win.flashFrame(false); hidePopup(); });
  win.on('hide', installIfReady);
  // Sealed messages that were open are hidden again as soon as the window is put away or minimised.
  win.on('hide', () => messenger.hideSealed());
  win.on('minimize', () => messenger.hideSealed());
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

// A small log of every popup decision (shown, skipped and why, failed). It makes "the popup did not come"
// answerable: Popup settings has a button that opens it.
function popupLog(text) {
  try {
    const file = path.join(app.getPath('userData'), 'popup.log');
    try { if (fs.statSync(file).size > 200 * 1024) fs.renameSync(file, file + '.old'); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

// The popup is skipped only when the user is really looking at that very conversation: TeamLink is the
// active window, not minimised, and that chat is the one open. Being in another chat (or having the
// window merely open behind other programs) still gets the popup, like IP Messenger.
let activeConv = null;
function lookingAt(conv) {
  return win.isVisible() && !win.isMinimized() && win.isFocused() && activeConv === conv;
}
ipcMain.on('activeConv', (e, conv) => { if (win && e.sender === win.webContents) activeConv = conv ? String(conv) : null; });

// Who the popup is about: their profile photo, or their initials on their colour when they have none.
const FACE_COLORS = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309', '#be123c'];
function popupFace(peerId, name) {
  let n = 0;
  for (const c of String(peerId)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const face = { initials: String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?', faceColor: FACE_COLORS[n % FACE_COLORS.length], avatar: '' };
  try {
    const peer = messenger.peers.get(peerId), file = messenger.avatarPath(peerId);
    if (peer && peer.avatar && fs.existsSync(file)) {
      const buf = fs.readFileSync(file), kind = Messenger.imageKind(buf);
      if (kind && buf.length < 300 * 1024) face.avatar = `data:${kind};base64,${buf.toString('base64')}`;
    }
  } catch {}
  return face;
}

function onIncoming(d) {
  try { incomingPopup(d); } catch (e) { popupLog('ERROR while preparing the popup: ' + (e && e.stack || e)); fallbackNotice('New message', 'Open TeamLink to read it'); }
}
function incomingPopup(d) {
  if (lookingAt(d.conv)) return popupLog('skipped: that chat is open in front'); // that chat is open in front of the user right now
  win.flashFrame(true);
  if (messenger.cfg.popup === false) return popupLog('skipped: popups are switched off in Settings');
  const conv = messenger.convView(messenger.store.conv(d.conv));
  const peer = messenger.peers.get(d.from);
  const who = (peer && peer.name) || 'Someone';
  const prefs = messenger.popupPrefs();
  popupCount += 1;
  popupData = { conv: d.conv, count: popupCount, body: prefs.showText ? (conv.last && conv.last.preview) || 'New message' : 'New message',
    title: conv.type === 'dm' ? who : `${who}${d.mention ? ' mentioned you' : ''} · ${conv.type === 'all' ? 'Everyone' : conv.name || 'Group'}`, ...popupFace(d.from, who) };
  showPopup();
  if (prefs.sound) shell.beep();
}

// The other person opened a sealed message you sent: tell the sender, like IP Messenger's "opened" notice.
function onOpened(d) {
  if (lookingAt(d.conv) || messenger.cfg.popup === false) return; // the window shows it itself
  const peer = messenger.peers.get(d.by);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  popupData = { conv: d.conv, count: 1, title: `${(peer && peer.name) || 'Someone'} opened your message`,
    body: d.locked ? '🔑 Your locked message was opened' : '🔒 Your sealed message was opened', note: `Opened at ${time} · click to open the chat`, ...popupFace(d.by, peer && peer.name) };
  showPopup();
}

// WHATSAPP-INTAKE: begin (popup for a high-priority WhatsApp item or one newly assigned to me; clicking opens the inbox)
function onIntakeAlert(d) {
  if (messenger.cfg.popup === false) return;
  popupData = { conv: 'intake:' + d.id, count: 1, title: d.reason === 'assigned' ? 'Assigned to you' : d.reason === 'shared' ? 'Shared with you' : `High priority · ${d.sender}`,
    body: messenger.popupPrefs().showText ? d.title : 'WhatsApp item', note: `${d.chat} · click to open the WhatsApp Inbox` };
  showPopup();
  if (messenger.popupPrefs().sound) shell.beep();
}
// WHATSAPP-INTAKE: end

// Colours for the popup: the user's own choice from the popup settings, otherwise the app theme.
function popupLook() {
  const a = messenger.appearance(), p = messenger.popupPrefs();
  const themeLight = ['rose', 'lavender', 'sand'].includes(a.preset) || (a.preset === 'classic' && (a.mode === 'light' || (a.mode === 'system' && !nativeTheme.shouldUseDarkColors)));
  return { accent: p.color || a.accent, light: p.tone === 'auto' ? themeLight : p.tone === 'light', motion: a.motion, design: p.design };
}

const POPUP_SCALE = { s: 0.8, m: 1, l: 1.22, xl: 1.45 };
let popupHideTimer = null;

// If the popup window cannot be shown, the message must still be announced: use the system's own notification.
function fallbackNotice(title, body) {
  try { if (Notification.isSupported()) { const n = new Notification({ title, body, icon: ICON }); n.on('click', showWindow); n.show(); } } catch {}
}

function createPopup(W, H) {
  popupReady = false;
  const w = new BrowserWindow({ width: W, height: H, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, minimizable: false, maximizable: false, focusable: true,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'TeamLink message', icon: ICON,
    // backgroundThrottling off: a window that is shown without being activated must still paint straight away
    webPreferences: { preload: path.join(__dirname, 'popup-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  w.setAlwaysOnTop(true, 'screen-saver'); // above other always-on-top windows and borderless full-screen programs
  try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('render-process-gone', (e, details) => { popupLog('ERROR: popup window crashed: ' + details.reason); if (popup === w) { popup = null; if (popupData) fallbackNotice(popupData.title, popupData.body); } });
  w.webContents.on('did-fail-load', (e, code, desc) => popupLog('ERROR: popup page did not load: ' + desc));
  w.on('closed', () => { if (popup === w) popup = null; });
  w.loadFile(path.join(__dirname, 'popup.html'));
  return w;
}

function showPopup() {
  try {
    const prefs = messenger.popupPrefs();
    Object.assign(popupData, popupLook());
    // Size and place come from the popup settings. The page is zoomed with the window so everything scales together.
    const scale = POPUP_SCALE[prefs.size] || 1, W = Math.round(POPUP_W * scale), H = Math.round(POPUP_H * scale);
    popupData.scale = scale;
    // On the screen the user is working on (where the mouse is), not always the primary one.
    let display;
    try { display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } catch { display = screen.getPrimaryDisplay(); }
    const area = display.workArea, [vert, horiz] = prefs.pos.split('-'), EDGE = 6;
    const x = horiz === 'left' ? area.x + EDGE : horiz === 'right' ? area.x + area.width - W - EDGE : Math.round(area.x + (area.width - W) / 2);
    const restY = vert === 'top' ? area.y + EDGE : vert === 'bottom' ? area.y + area.height - H - EDGE : Math.round(area.y + (area.height - H) / 2);
    // It slides in from the nearest screen edge (from just above its place when it sits in the middle).
    const fromY = vert === 'top' ? area.y - H : vert === 'bottom' ? area.y + area.height : restY - 60;
    clearTimeout(popupHideTimer);
    if (prefs.hideAfter) popupHideTimer = setTimeout(hidePopup, prefs.hideAfter * 1000);

    // Already on screen in the same place: only the text changes (the page plays a short pulse).
    if (popup && !popup.isDestroyed() && popup.isVisible()) {
      const now = popup.getBounds();
      if (popupReady) popup.webContents.send('popupData', popupData);
      if (!popupAnim && Math.abs(now.x - x) < 3 && Math.abs(now.y - restY) < 3 && Math.abs(now.width - W) < 3) { popup.moveTop(); return popupLog(`updated: "${popupData.title}"`); }
    } else {
      // A fresh window for every appearance. Re-showing a hidden transparent window is unreliable on Windows
      // (it can come back without painting), and making a new one costs only a moment.
      if (popup && !popup.isDestroyed()) popup.destroy();
      popup = createPopup(W, H);
    }
    clearInterval(popupAnim);
    const started = Date.now(), DURATION = 380, w = popup;
    w.setBounds({ x, y: fromY, width: W, height: H });
    w.showInactive(); // never steals the keyboard from what the user is typing in
    w.moveTop();
    popupLog(`shown: "${popupData.title}" at ${x},${restY} size ${W}x${H} on display ${display.id}${prefs.hideAfter ? ' (hides after ' + prefs.hideAfter + 's)' : ''}`);
    popupAnim = setInterval(() => {
      if (w.isDestroyed()) { clearInterval(popupAnim); popupAnim = null; return; }
      const t = Math.min(1, (Date.now() - started) / DURATION);
      const c1 = 1.70158, c3 = c1 + 1, ease = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); // ease-out with a small overshoot
      w.setBounds({ x, y: Math.round(fromY + (restY - fromY) * ease), width: W, height: H });
      if (t >= 1) { clearInterval(popupAnim); popupAnim = null; }
    }, 12);
  } catch (e) {
    popupLog('ERROR while showing the popup: ' + (e && e.stack || e));
    if (popupData) fallbackNotice(popupData.title, popupData.body);
  }
}

ipcMain.handle('openPopupLog', (e) => { if (win && e.sender === win.webContents) { popupLog('(log opened from Popup settings)'); shell.openPath(path.join(app.getPath('userData'), 'popup.log')); } });

// "Show a test popup" in the popup settings.
ipcMain.handle('testPopup', (e) => {
  if (!win || e.sender !== win.webContents) return;
  popupCount = 0;
  popupData = { conv: null, count: 1, title: 'Asha Verma', body: 'This is how a new message will pop up on your screen.', note: 'Test popup · click to close', ...popupFace(messenger.me.id, messenger.cfg.name), ...(() => { try { const f = messenger.avatarPath(messenger.me.id); if (messenger.cfg.avatar && fs.existsSync(f)) { const b = fs.readFileSync(f); return { avatar: `data:${Messenger.imageKind(b)};base64,${b.toString('base64')}` }; } } catch {} return {}; })() };
  if (popup && !popup.isDestroyed()) { const w = popup; popup = null; w.destroy(); } // replay the entrance with the new settings
  showPopup();
});

function hidePopup() {
  popupCount = 0;
  clearTimeout(popupHideTimer);
  clearInterval(popupAnim); popupAnim = null;
  if (popup && !popup.isDestroyed()) { const w = popup; popup = null; w.destroy(); } // gone for good; the next message gets a new one
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
const update = { current: app.getVersion(), status: app.isPackaged ? 'idle' : 'dev', version: '', percent: 0, error: '', canSelfInstall, latest: '' };

function setUpdate(patch) {
  Object.assign(update, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update', update);
}

// "Is there a newer release?" is asked separately from the self-updater, so the app can say "update available"
// even where the automatic download does not work (a blocked download, macOS, an old installer).
// It reads where github.com/.../releases/latest redirects to; nothing about the user is sent.
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkLatest() {
  try {
    let latest = !app.isPackaged && process.env.TEAMLINK_TEST_LATEST; // lets the notice be tested from source
    if (!latest) {
      // /releases/latest answers with a redirect to /releases/tag/v<version>; only that address is needed.
      const target = await new Promise((resolve) => {
        const rq = net.request({ url: RELEASES, method: 'HEAD', redirect: 'manual' });
        rq.on('redirect', (status, method, url) => { resolve(url); rq.abort(); });
        rq.on('response', () => resolve(''));
        rq.on('error', () => resolve(''));
        setTimeout(() => resolve(''), 15000);
        rq.end();
      });
      latest = (/\/tag\/v?(\d+\.\d+\.\d+)$/.exec(target) || [])[1];
    }
    if (latest && newer(latest, update.current) && latest !== update.latest) setUpdate({ latest });
  } catch {}
}

function setupUpdates() {
  setTimeout(checkLatest, 8000);
  setInterval(checkLatest, 2 * 3600 * 1000);
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
  if (fromUi(e)) { checkNow(); checkLatest(); }
  return update;
});
ipcMain.handle('installUpdate', (e) => {
  if (!fromUi(e)) return;
  if (update.status === 'ready') return installUpdate(false);
  if (update.status === 'downloading') return;
  // Not downloaded yet: start the self-updater where it can work; if it cannot (or fails), open the download page.
  if (updater && canSelfInstall && update.status !== 'error') { checkNow(); setTimeout(() => { if (update.status === 'error') shell.openExternal(RELEASES); }, 6000); }
  else shell.openExternal(RELEASES);
});
