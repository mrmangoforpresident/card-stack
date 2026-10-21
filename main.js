// Card Stack - main process: the transparent pet window, tray, persistence and email.
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell, Notification, nativeImage, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const DATA_DIR = process.env.CARDSTACK_DATA_DIR || path.join(app.getPath('appData'), 'CardStack');
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const BACKUP_PATH = path.join(DATA_DIR, 'data.backup.json');

// Electron keeps the key that encrypts the saved email password in its
// userData folder, which is named after the app. Pin it so renaming the app
// can never make a saved password unreadable.
app.setPath('userData', process.env.CARDSTACK_DATA_DIR
  ? path.join(DATA_DIR, 'electron') // test runs stay separate from the real app
  : path.join(app.getPath('appData'), 'card-stack'));
const ICON = path.join(__dirname, 'icon.png');
const COLORS = ['#ffd166', '#7bdff2', '#b9f2a1', '#f7a8c8', '#c6b6ff', '#ffb68a'];
const WIN_W = 300;
const WIN_H = 580;

let win = null;
let tray = null;
let data = null;
let drag = null;
let sendingReport = false;
let nextRetry = 0;
let quitting = false;

// ---------- persistence ----------

const uid = () => crypto.randomUUID().replace(/-/g, '');

function load() {
  const def = {
    tasks: [
      { id: uid(), text: 'Tap a card to flip to the next one', color: COLORS[0] },
      { id: uid(), text: 'Press and hold a card to complete it', color: COLORS[1] },
      { id: uid(), text: 'Drag a card to move me around', color: COLORS[2] },
    ],
    settings: {}, session: null, recipients: '', last_minutes: 30,
    parked: [], // cards set aside during a focus session
    color_i: 3, always_on_top: true, pos: null,
  };
  // The tutorial cards are only for a true first run. If a save exists but
  // can't be read, fall back to the backup - never to the tutorial cards.
  if (!fs.existsSync(DATA_PATH) && !fs.existsSync(BACKUP_PATH)) return def;
  for (const p of [DATA_PATH, BACKUP_PATH]) {
    try {
      return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch {}
  }
  return { ...def, tasks: [] };
}

function save() {
  const json = JSON.stringify(data, null, 2);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_PATH + '.tmp', json);
      if (fs.existsSync(DATA_PATH)) fs.copyFileSync(DATA_PATH, BACKUP_PATH);
      fs.renameSync(DATA_PATH + '.tmp', DATA_PATH);
      return;
    } catch (e) {
      // antivirus or search indexing can briefly lock the file; try again
      if (attempt === 4) console.error('Card Stack: could not save', e);
    }
  }
}

function getPassword() {
  const s = data.settings;
  if (s.passwordEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.passwordEnc, 'base64'));
    } catch {
      return ''; // saved on another PC or Windows account; the user re-enters it
    }
  }
  return s.password || '';
}

function setPassword(pw) {
  const s = data.settings;
  if (safeStorage.isEncryptionAvailable()) {
    s.passwordEnc = safeStorage.encryptString(pw).toString('base64');
    delete s.password;
  } else {
    s.password = pw;
  }
}

function publicState() {
  const s = data.settings;
  return {
    tasks: data.tasks, parked: data.parked, color_i: data.color_i, session: data.session,
    recipients: data.recipients, last_minutes: data.last_minutes,
    always_on_top: data.always_on_top, email_later: !!data.email_later,
    settings: { name: s.name || '', email: s.email || '', host: s.host || '', port: s.port || 465,
                hasPassword: !!getPassword() },
  };
}

const pushState = () => win && win.webContents.send('state', publicState());
const toast = (msg) => win && win.webContents.send('toast', msg);

// ---------- email ----------

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function fmtDur(minutes) {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60), mm = m % 60;
  const parts = [];
  if (h) parts.push(plural(h, 'hour'));
  if (mm || !h) parts.push(plural(mm, 'minute'));
  return parts.join(' ');
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const msgId = () => `<${uid()}@${(data.settings.email || 'cardstack.local').split('@').pop()}>`;

async function sendMail({ to, subject, text, messageId, inReplyTo }) {
  const s = data.settings;
  if (!getPassword()) throw Object.assign(new Error('no password'), { code: 'NOPASS' });
  const port = Number(s.port);
  const t = nodemailer.createTransport({
    host: s.host, port, secure: port === 465,
    auth: { user: s.email, pass: getPassword() },
    connectionTimeout: 20000,
  });
  await t.sendMail({
    from: { name: s.name || '', address: s.email }, to, subject, text, messageId,
    ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
  });
}

function friendly(e) {
  if (e.code === 'NOPASS')
    return "Card Stack couldn't read your saved app password. Open Email settings and enter it again.";
  if (e.code === 'EAUTH' || e.responseCode === 535)
    return 'Your email provider rejected the sign-in. For Gmail you need an App Password (not your normal password). Right-click a card and open Email settings to fix it.';
  if (e.code === 'EENVELOPE')
    return 'The mail server refused one of the email addresses. Double-check them and try again.';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(e.code))
    return "Couldn't reach the mail server. Check your internet connection and the SMTP server in Email settings.";
  return e.message || String(e);
}

async function startSession({ minutes, emails, ids }) {
  const name = data.settings.name || 'I';
  const picked = data.tasks.filter((t) => ids.includes(t.id));
  const order = picked.map((t) => t.text);
  const n = order.length;
  const dur = fmtDur(minutes);
  const subject = `${name} is tackling ${plural(n, 'task')} in the next ${dur}`;
  const list = order.map((x, i) => `  ${i + 1}. ${x}`).join('\n');
  const text =
    `Hi!\n\n${name} just started a focus session and committed to finishing ${n === 1 ? 'this task' : `these ${n} tasks`} ` +
    `in the next ${dur} (by about ${clock(Date.now() + minutes * 60000)}):\n\n${list}\n\n` +
    "When the time is up, you'll get a reply on this thread saying how it went.\n\n- Sent with Card Stack";
  const messageId = msgId();
  data.last_minutes = minutes;
  if (emails.length) {
    data.recipients = emails.join(', ');
    save();
    try {
      await sendMail({ to: emails, subject, text, messageId });
    } catch (e) {
      return { ok: false, error: friendly(e) };
    }
  }
  const start = Date.now();
  data.session = {
    tasks: Object.fromEntries(picked.map((t) => [t.id, t.text])),
    order: picked.map((t) => t.id), done: [], to: emails,
    subject, msgid: messageId, minutes, start, end: start + minutes * 60000,
  };
  save();
  return { ok: true, state: publicState() };
}

async function sendReport() {
  const s = data.session;
  sendingReport = true;
  const name = data.settings.name || 'I';
  const done = s.order.filter((i) => s.done.includes(i)).map((i) => s.tasks[i]);
  const left = s.order.filter((i) => !s.done.includes(i)).map((i) => s.tasks[i]);
  const total = s.order.length;
  const head = left.length
    ? `Time's up! ${name} finished ${done.length} of ${plural(total, 'task')}.`
    : `Time's up - ${name} finished all ${plural(total, 'task')}! \u{1F389}`;
  const bullets = (xs) => (xs.length ? xs.map((x) => `  - ${x}`).join('\n') : '  (none)');
  const text = `${head}\n\n✅ Done (${done.length}):\n${bullets(done)}\n\n⬜ Not done (${left.length}):\n${bullets(left)}\n\n- Sent with Card Stack`;
  try {
    // timer-only sessions (no recipients) just finish without emailing
    if (s.to.length) await sendMail({ to: s.to, subject: 'Re: ' + s.subject, text, messageId: msgId(), inReplyTo: s.msgid });
  } catch (e) {
    sendingReport = false;
    nextRetry = Date.now() + 60000;
    toast("Couldn't send results - retrying in a minute");
    return;
  }
  sendingReport = false;
  data.session = null;
  save();
  pushState();
  showWindow();
  const summary = done.length === total
    ? `You finished all ${plural(total, 'task')}. Amazing work!`
    : `You finished ${done.length} of ${plural(total, 'task')}.`;
  win.webContents.send('report-sent', { summary, people: s.to.length });
  if (Notification.isSupported()) new Notification({ title: "Time's up!", body: summary, icon: ICON }).show();
}

setInterval(() => {
  const s = data && data.session;
  if (s && Date.now() >= s.end && !sendingReport && Date.now() >= nextRetry) sendReport();
}, 1000);

// ---------- window ----------

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - 30, y: wa.y + wa.height - 330 };
}

function validPos(p) {
  return p && screen.getAllDisplays().some(({ workArea: a }) =>
    p.x + WIN_W / 2 > a.x && p.x + WIN_W / 2 < a.x + a.width && p.y + 150 > a.y && p.y + 150 < a.y + a.height);
}

function createWindow() {
  const pos = validPos(data.pos) ? data.pos : defaultPos();
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H, x: pos.x, y: pos.y,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: data.always_on_top, icon: ICON, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function setOnTop(v) {
  data.always_on_top = v;
  win.setAlwaysOnTop(v);
  save();
  rebuildTray();
}

function resetPosition() {
  const p = defaultPos();
  win.setBounds({ ...p, width: WIN_W, height: WIN_H });
  data.pos = p;
  save();
}

function quit() {
  if (data.session) {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Quit anyway', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Card Stack', message: 'Your timer is still running.',
      detail: "The results email is only sent while Card Stack is running. If you quit now, it'll be sent the next time you open it.",
    });
    if (r !== 0) return;
  }
  quitting = true;
  app.quit();
}

// Launch at Windows sign-in (a "Run" entry for the current user, like Discord).
const LOGIN = { path: process.execPath, args: app.isPackaged ? [] : [path.resolve(__dirname)], name: 'Card Stack' };
const startsWithWindows = () => app.getLoginItemSettings(LOGIN).openAtLogin;

function setStartWithWindows(on) {
  app.setLoginItemSettings({ ...LOGIN, openAtLogin: on });
  data.start_with_windows = on;
  save();
  rebuildTray();
}

function open(what) {
  showWindow();
  win.webContents.send('open', what);
}

function menuTemplate(card) {
  return [
    ...(card ? [
      { label: 'Edit card…', click: () => win.webContents.send('card-action', 'edit') },
      { label: 'Mark done', click: () => win.webContents.send('card-action', 'done') },
      { label: 'Delete card', click: () => win.webContents.send('card-action', 'delete') },
      { type: 'separator' },
    ] : []),
    { label: 'Add cards…', click: () => open('add') },
    { label: 'Think a task through…', click: () => open('think') },
    { label: 'Start a focus timer…', click: () => open('alert') },
    { label: 'Email settings…', click: () => open('settings') },
    { type: 'separator' },
    { label: 'Always on top', type: 'checkbox', checked: data.always_on_top, click: (i) => setOnTop(i.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (i) => setStartWithWindows(i.checked) },
    { label: 'Reset position', click: resetPosition },
    { label: win && win.isVisible() ? 'Hide' : 'Show', click: () => (win.isVisible() ? win.hide() : showWindow()) },
    { type: 'separator' },
    { label: 'Quit Card Stack', click: quit },
  ];
}

function rebuildTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(false)));
}

// ---------- ipc ----------

ipcMain.handle('get-state', () => publicState());

ipcMain.on('set-tasks', (_e, { tasks, parked, color_i }) => {
  data.tasks = tasks;
  data.parked = parked;
  data.color_i = color_i;
  save();
});

ipcMain.on('task-done', (_e, id) => {
  const s = data.session;
  if (s && s.tasks[id] && !s.done.includes(id)) {
    s.done.push(id);
    save();
    pushState();
  }
});

ipcMain.on('email-later', () => {
  data.email_later = true;
  save();
});

ipcMain.handle('save-settings', (_e, st) => {
  Object.assign(data.settings, { name: st.name, email: st.email, host: st.host, port: st.port });
  if (st.password) setPassword(st.password);
  save();
  return publicState();
});

ipcMain.handle('start-session', (_e, args) => startSession(args));

ipcMain.handle('finish-now', () => {
  if (data.session) {
    data.session.end = Date.now();
    nextRetry = 0;
    save();
  }
  return publicState();
});

ipcMain.on('set-ignore', (_e, ignore) => win && win.setIgnoreMouseEvents(ignore, { forward: true }));

ipcMain.on('drag-start', () => {
  drag = { cursor: screen.getCursorScreenPoint(), pos: win.getPosition() };
});

ipcMain.on('drag-move', () => {
  if (!drag) return;
  const c = screen.getCursorScreenPoint();
  win.setBounds({ x: drag.pos[0] + c.x - drag.cursor.x, y: drag.pos[1] + c.y - drag.cursor.y, width: WIN_W, height: WIN_H });
});

ipcMain.on('drag-end', () => {
  drag = null;
  const [x, y] = win.getPosition();
  data.pos = { x, y };
  save();
});

let panelShift = null;
ipcMain.on('panel', (_e, open) => {
  const b = win.getBounds();
  if (open) {
    // nudge the window back on screen so the whole panel is visible
    const a = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, a.x), a.x + a.width - WIN_W);
    const y = Math.min(Math.max(b.y, a.y), a.y + a.height - WIN_H);
    if (x !== b.x || y !== b.y) {
      panelShift = { x: b.x, y: b.y };
      win.setBounds({ x, y, width: WIN_W, height: WIN_H });
    }
  } else if (panelShift) {
    win.setBounds({ ...panelShift, width: WIN_W, height: WIN_H });
    panelShift = null;
  }
});

ipcMain.on('menu', (_e, { card }) => Menu.buildFromTemplate(menuTemplate(card)).popup({ window: win }));
ipcMain.on('open-external', (_e, url) => {
  if (url.startsWith('https://myaccount.google.com/')) shell.openExternal(url);
});

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('com.cardstack.app');
  app.whenReady().then(() => {
    data = load();
    if (data.pos && data.layout !== 2) {
      // the window grew; shift it so the pet stays where the user left it
      data.pos = { x: data.pos.x + 53, y: data.pos.y + 148 };
    }
    data.layout = 2;
    if (data.start_with_windows === undefined && !process.env.CARDSTACK_DATA_DIR) setStartWithWindows(true);
    if (data.settings.password && safeStorage.isEncryptionAvailable()) {
      setPassword(data.settings.password); // migrate a plain-text password from the old version
      save();
    }
    createWindow();
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Card Stack');
    tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
    rebuildTray();
    win.on('show', rebuildTray);
    win.on('hide', rebuildTray);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
