// Card Stack - renderer: the cards, gestures, animations and panels.
const COLORS = ['#ffd166', '#7bdff2', '#b9f2a1', '#f7a8c8', '#c6b6ff', '#ffb68a'];
// Each card's saved color picks one of these glossy Aero tints.
const TINTS = ['#2fa8e8', '#22c4c9', '#62c93a', '#3d8fe0', '#2fc28c', '#7fd0f0'];
const HOLD_DELAY = 220; // ms before a press counts as a hold (shorter = tap)
const HOLD_FILL = 600; // ms for the meter to fill once it appears
const DRAG_START = 5; // px of movement that turns a press into a drag
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const KNOWN_HOSTS = ['', 'smtp.gmail.com', 'smtp-mail.outlook.com', 'smtp.mail.yahoo.com', 'smtp.mail.me.com'];

const $ = (s, root = document) => root.querySelector(s);
const stack = $('#stack');
const stage = $('#stage');
const panel = $('#panel');
const pill = $('#pill');
const dock = $('#dock');
const toastEl = $('#toast');
const btnAlert = $('#btn-alert');

let state = null;
let tasks = []; // the stack on screen
let parked = []; // cards set aside until the focus timer ends
let colorI = 0;
const els = new Map(); // task id -> card element
let press = null;
let panelOpen = false;

const uid = () => crypto.randomUUID().replace(/-/g, '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tf = (d) => `translateY(${d * 13}px) scale(${1 - d * 0.05})`;
const persist = () => api.send('set-tasks', { tasks, parked, color_i: colorI });
const focusing = () => !!(state && state.session && state.session.end > Date.now());

// ---------- animation bookkeeping ----------
// Every running animation / delayed step is tracked so a new gesture can
// fast-forward the previous one instead of fighting it.

let pending = [];

function untrack(p) {
  const i = pending.indexOf(p);
  if (i < 0) return false;
  pending.splice(i, 1);
  return true;
}

function later(ms, fn) {
  const p = { fn };
  p.timer = setTimeout(() => untrack(p) && fn(), ms);
  pending.push(p);
}

function play(el, keyframes, opts, fn) {
  const p = { fn };
  p.anim = el.animate(keyframes, opts);
  p.anim.onfinish = () => untrack(p) && fn && fn();
  pending.push(p);
}

function flush() {
  const ps = pending;
  pending = [];
  for (const p of ps) {
    if (p.timer) clearTimeout(p.timer);
    if (p.anim) p.anim.cancel();
    if (p.fn) p.fn();
  }
}

// ---------- cards ----------

function sizeClass(text) {
  return text.length < 40 ? '' : text.length < 80 ? 'm' : text.length < 130 ? 's' : 'xs';
}

function setText(el, text) {
  const t = $('.text', el);
  t.textContent = text.length > 200 ? text.slice(0, 197) + '…' : text;
  t.className = 'text ' + sizeClass(text);
}

function makeCard(task) {
  const el = document.createElement('div');
  el.className = 'card hit';
  el.style.setProperty('--tint', TINTS[Math.max(0, COLORS.indexOf(task.color)) % TINTS.length]);
  el.innerHTML = `
    <div class="content">
      <div class="label">TO-DO</div>
      <div class="text"></div>
      <div class="hint">tap → next &nbsp;·&nbsp; hold → done</div>
    </div>
    <div class="meter"><i></i></div>
    <div class="check"><svg viewBox="0 0 24 24" width="34" height="34"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  setText(el, task.text);
  stack.appendChild(el);
  els.set(task.id, el);
  return el;
}

function layout() {
  tasks.forEach((t, i) => {
    const el = els.get(t.id) || makeCard(t);
    el.style.setProperty('--d', Math.min(i, 3));
    el.style.zIndex = 100 - i;
    el.classList.toggle('front', i === 0);
    el.classList.toggle('deep', i > 3);
  });
  dock.classList.toggle('show', tasks.length === 0);
  // back cards peek 13px each below the front card; the buttons sit under the lowest one
  stage.style.setProperty('--peek', `${Math.min(Math.max(tasks.length - 1, 0), 3) * 13}px`);
}

function shuffle() {
  flush();
  if (tasks.length < 2) {
    if (tasks.length) {
      wiggle(els.get(tasks[0].id));
      showToast("That's your only card");
    }
    return;
  }
  const t = tasks.shift();
  tasks.push(t);
  persist();
  const el = els.get(t.id);
  const back = Math.min(tasks.length - 1, 3);
  el.classList.add('anim');
  el.style.setProperty('--d', back);
  el.style.zIndex = 100 - (tasks.length - 1);
  // Lift straight up, then slide down behind the rest of the stack.
  const up = 'translateY(-128px) rotate(-2deg) scale(1.02)';
  const lit = 'brightness(1)';
  play(el, [
    { transform: tf(0), zIndex: 200, filter: lit, easing: 'cubic-bezier(.3,.7,.4,1)' },
    { transform: up, zIndex: 200, filter: lit, offset: 0.42 },
    { transform: up, zIndex: 1, filter: lit, offset: 0.43, easing: 'cubic-bezier(.5,0,.25,1)' },
    { transform: tf(back), zIndex: 1, filter: `brightness(${1 - back * 0.09})` },
  ], { duration: 640 }, () => el.classList.remove('anim'));
  later(270, layout);
}

function complete() {
  flush();
  if (!tasks.length) return;
  const t = tasks.shift();
  persist();
  api.send('task-done', t.id);
  const el = els.get(t.id);
  els.delete(t.id);
  el.classList.remove('front', 'holding', 'pressed');
  el.classList.add('done', 'anim');
  el.style.setProperty('--press', 1);
  el.style.zIndex = 250;
  play(el, [
    { transform: tf(0), easing: 'cubic-bezier(.2,.8,.2,1)' },
    { transform: 'translateY(-6px) scale(1.04)', offset: 0.28 },
    { transform: 'translateY(-6px) scale(1.04)', opacity: 1, offset: 0.5, easing: 'cubic-bezier(.55,0,.75,.2)' },
    { transform: 'translateY(-190px) scale(.94) rotate(-3deg)', opacity: 0 },
  ], { duration: 820 }, () => el.remove());
  later(420, layout);
  showToast(tasks.length ? `Done! ${tasks.length} to go` : 'Done! Stack cleared');
}

function removeTop() {
  flush();
  if (!tasks.length) return;
  const t = tasks.shift();
  persist();
  const el = els.get(t.id);
  els.delete(t.id);
  el.classList.remove('front');
  el.classList.add('anim');
  el.style.zIndex = 250;
  play(el, [
    { transform: tf(0), opacity: 1 },
    { transform: 'translateY(24px) scale(.86)', opacity: 0 },
  ], { duration: 280, easing: 'ease-in' }, () => el.remove());
  later(120, layout);
}

function addTasks(texts) {
  flush();
  const fresh = texts.map((text) => ({ id: uid(), text, color: COLORS[colorI++ % COLORS.length] }));
  if (focusing()) {
    // stay focused: new cards wait with the others until the timer ends
    parked.unshift(...fresh);
    persist();
    showToast(`${fresh.length === 1 ? 'Saved' : `Saved ${fresh.length} cards`} for after your focus timer`, 3000);
    return;
  }
  tasks.unshift(...fresh);
  persist();
  layout();
  const el = els.get(fresh[0].id);
  el.classList.add('anim');
  play(el, [
    { transform: 'translateY(-150px) scale(.96)', opacity: 0 },
    { transform: tf(0), opacity: 1 },
  ], { duration: 520, easing: 'cubic-bezier(.34,1.4,.64,1)' }, () => el.classList.remove('anim'));
  if (fresh.length > 1) showToast(`Added ${fresh.length} cards`);
}

// Start of a focus session: everything not picked slides out of the stack.
function parkExcept(ids) {
  flush();
  const out = tasks.filter((t) => !ids.includes(t.id));
  if (!out.length) return;
  tasks = tasks.filter((t) => ids.includes(t.id));
  parked = [...out, ...parked];
  persist();
  for (const t of out) {
    const el = els.get(t.id);
    els.delete(t.id);
    el.classList.remove('front');
    el.classList.add('anim');
    play(el, [{ opacity: 0, transform: 'translateY(40px) scale(.8)' }], { duration: 350, easing: 'ease-in' }, () => el.remove());
  }
  layout();
}

// Timer over: the set-aside cards come back behind whatever is left.
function restoreParked() {
  flush();
  const back = parked;
  parked = [];
  tasks.push(...back);
  persist();
  layout();
  back.forEach((t, i) => {
    const el = els.get(t.id);
    const d = Math.min(tasks.indexOf(t), 3);
    el.classList.add('anim');
    play(el, [
      { opacity: 0, transform: 'translateY(-60px) scale(.95)' },
      { opacity: el.classList.contains('deep') ? 0 : 1, transform: tf(d) },
    ], { duration: 480, delay: i * 70, easing: 'cubic-bezier(.34,1.4,.64,1)', fill: 'backwards' }, () => el.classList.remove('anim'));
  });
  showToast('Focus time is over · your other cards are back', 3500);
}

function wiggle(el) {
  el.classList.add('anim');
  play(el, [
    { transform: tf(0) },
    { transform: 'translateX(-9px) rotate(-1.5deg)' },
    { transform: 'translateX(7px) rotate(1deg)' },
    { transform: 'translateX(-3px)' },
    { transform: tf(0) },
  ], { duration: 420, easing: 'ease-in-out' }, () => el.classList.remove('anim'));
}

// ---------- gestures: tap = next, hold = done, drag = move window ----------

function resetHold(el) {
  if (!el) return;
  el.classList.remove('holding', 'pressed');
  el.style.setProperty('--press', 1);
  const bar = $('.meter i', el);
  setTimeout(() => { if (!el.classList.contains('holding')) bar.style.transform = 'scaleX(0)'; }, 160);
}

function holdTick(now) {
  const p = press;
  if (!p || p.dragging || !p.el || p.completed) return;
  const t = now - p.t0;
  if (t >= HOLD_DELAY) {
    p.el.classList.add('holding');
    const k = Math.min(1, (t - HOLD_DELAY) / HOLD_FILL);
    $('.meter i', p.el).style.transform = `scaleX(${k})`;
    if (k >= 1) {
      p.completed = true;
      complete();
      return;
    }
  }
  p.raf = requestAnimationFrame(holdTick);
}

function startPress(e, target, withCard) {
  if (e.button !== 0 || panelOpen) return;
  flush();
  const el = withCard && tasks.length ? els.get(tasks[0].id) : null;
  target.setPointerCapture(e.pointerId);
  press = { x: e.screenX, y: e.screenY, t0: performance.now(), el, dragging: false, completed: false };
  if (el) {
    el.classList.add('pressed');
    el.style.setProperty('--press', 0.97);
    press.raf = requestAnimationFrame(holdTick);
  }
}

function endPress(cancelled) {
  const p = press;
  if (!p) return;
  press = null;
  cancelAnimationFrame(p.raf);
  if (!p.completed) resetHold(p.el);
  if (p.dragging) {
    api.send('drag-end');
    document.body.style.cursor = '';
    return;
  }
  if (!cancelled && !p.completed && p.el && performance.now() - p.t0 < HOLD_DELAY) shuffle();
}

stack.addEventListener('pointerdown', (e) => e.target.closest('.card') && startPress(e, stack, true));
dock.addEventListener('pointerdown', (e) => startPress(e, dock, false));

window.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > DRAG_START) {
    press.dragging = true;
    cancelAnimationFrame(press.raf);
    resetHold(press.el);
    document.body.style.cursor = 'grabbing';
    api.send('drag-start');
  }
  if (press.dragging) api.send('drag-move');
});
window.addEventListener('pointerup', () => endPress(false));
window.addEventListener('pointercancel', () => endPress(true));

// Click-through: the window ignores the mouse except over real UI.
let ignoring = true;
function setIgnore(v) {
  if (v !== ignoring) {
    ignoring = v;
    api.send('set-ignore', v);
  }
}
window.addEventListener('mousemove', (e) => {
  if (press) return setIgnore(false);
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setIgnore(!(el && el.closest('.hit')));
});
document.addEventListener('mouseleave', () => !press && setIgnore(true));

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.send('menu', { card: !!e.target.closest('.card') && tasks.length > 0 });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelOpen) closePanel();
  if (panelOpen) return;
  if (e.key === ' ') shuffle();
  if (e.key === 'n' && e.ctrlKey) openAdd();
});

$('#btn-add').addEventListener('click', () => openAdd());
btnAlert.addEventListener('click', () => openAlert());
$('#btn-think').addEventListener('click', () => openThink());
pill.addEventListener('click', () => confirmFinish());

// ---------- toast & timer pill ----------

let toastTimer = 0;
function showToast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

function updatePill() {
  const s = state && state.session;
  pill.classList.toggle('hidden', !s);
  btnAlert.classList.toggle('dim', !!s);
  if (parked.length && !focusing() && tasks) restoreParked();
  if (!s) return;
  const left = s.end - Date.now();
  $('#pill-text').textContent = left > 0
    ? `${fmtLeft(left)} left  ·  ${s.done.length}/${s.order.length} done`
    : "Time's up — sending results…";
}
setInterval(updatePill, 250);

// ---------- panels ----------

function openPanel(html, setup) {
  flush();
  panel.innerHTML = html;
  panel.classList.remove('hidden');
  stage.classList.add('away');
  if (!panelOpen) api.send('panel', true);
  panelOpen = true;
  panel.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  setup && setup();
  const f = $('[autofocus]', panel);
  if (f) { f.focus(); if (f.select) f.select(); }
}

function closePanel() {
  panel.classList.add('hidden');
  panel.innerHTML = '';
  stage.classList.remove('away');
  panelOpen = false;
  api.send('panel', false);
}

function onEnter(el, fn) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); }
  });
}

function openInfo(title, msg) {
  openPanel(`<h2>${esc(title)}</h2><p class="sub">${esc(msg)}</p>
    <div class="actions"><button class="btn" data-close autofocus>OK</button></div>`);
}

function openConfirm(title, msg, yes, cls, cb) {
  openPanel(`<h2>${esc(title)}</h2><p class="sub">${esc(msg)}</p>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button>
    <button class="btn ${cls}" id="ok" autofocus>${esc(yes)}</button></div>`,
  () => $('#ok').addEventListener('click', () => { closePanel(); cb(); }));
}

function openAdd() {
  openPanel(`<h2>New card</h2>
    <p class="sub">What do you need to do? Put each task on its own line to add several cards at once.</p>
    <label>Task</label>
    <textarea id="f-text" rows="4" autofocus placeholder="e.g. Finish the history essay"></textarea>
    <div class="hint">Enter to add · Shift+Enter for a new line</div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ok">Add card</button></div>`,
  () => {
    const go = () => {
      const lines = $('#f-text').value.split('\n').map((l) => l.trim()).filter(Boolean);
      closePanel();
      if (lines.length) addTasks(lines);
    };
    $('#ok').addEventListener('click', go);
    onEnter($('#f-text'), go);
  });
}

function openEdit() {
  if (!tasks.length) return;
  const task = tasks[0];
  openPanel(`<h2>Edit card</h2>
    <label>Task</label>
    <textarea id="f-text" rows="3" autofocus>${esc(task.text)}</textarea>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ok">Save</button></div>`,
  () => {
    const go = () => {
      const text = $('#f-text').value.split(/\s+/).filter(Boolean).join(' ');
      closePanel();
      if (text) {
        task.text = text;
        setText(els.get(task.id), text);
        persist();
      }
    };
    $('#ok').addEventListener('click', go);
    onEnter($('#f-text'), go);
  });
}

function guessSmtp(email) {
  const d = email.split('@').pop().toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return ['smtp.gmail.com', 465];
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(d)) return ['smtp-mail.outlook.com', 587];
  if (d.startsWith('yahoo.')) return ['smtp.mail.yahoo.com', 465];
  if (['icloud.com', 'me.com', 'mac.com'].includes(d)) return ['smtp.mail.me.com', 587];
  return ['smtp.' + d, 465];
}

function openSettings(then, first) {
  const st = state.settings;
  openPanel(`<h2>${first ? 'Connect your email' : 'Email settings'}</h2>
    <p class="sub">Alerts are sent from your own email account. For Gmail, create an App Password and paste it below — your normal password won't work.
    <a id="apw">Get a Gmail App Password ↗</a></p>
    <label>Your name (shown in the emails)</label>
    <input id="f-name" value="${esc(st.name)}" ${!st.email ? 'autofocus' : ''}>
    <label>Your email address</label>
    <input id="f-email" value="${esc(st.email)}">
    <label>App password</label>
    <input id="f-pw" type="password" placeholder="${st.hasPassword ? 'Saved — leave blank to keep it' : ''}" ${st.email ? 'autofocus' : ''}>
    <label>Mail server (SMTP) and port</label>
    <div class="row"><input id="f-host" value="${esc(st.host || 'smtp.gmail.com')}"><input id="f-port" value="${esc(st.port || 465)}" style="width:72px;flex:none"></div>
    <div class="hint">Filled in automatically for Gmail, Outlook, Yahoo and iCloud. Your password is stored encrypted on this PC.</div>
    <div class="err" id="err">${st.email && !st.hasPassword ? 'Please enter your app password again.' : ''}</div>
    <div class="actions">${first ? '<button class="btn ghost" id="later">Do later</button>' : '<button class="btn ghost" data-close>Cancel</button>'}<button class="btn" id="ok">Save</button></div>`,
  () => {
    if (first) {
      // skip email for now: the focus timer still works, it just doesn't notify anyone
      $('#later').addEventListener('click', () => {
        api.send('email-later');
        state.email_later = true;
        closePanel();
        if (then) then();
      });
    }
    $('#apw').addEventListener('click', () => api.send('open-external', 'https://myaccount.google.com/apppasswords'));
    const autofill = () => {
      const addr = $('#f-email').value.trim();
      if (EMAIL_RE.test(addr) && KNOWN_HOSTS.includes($('#f-host').value.trim())) {
        const [h, p] = guessSmtp(addr);
        $('#f-host').value = h;
        $('#f-port').value = p;
      }
    };
    $('#f-email').addEventListener('blur', autofill);
    const go = async () => {
      autofill();
      const err = $('#err');
      const email = $('#f-email').value.trim();
      const host = $('#f-host').value.trim();
      let pw = $('#f-pw').value.trim();
      if (host === 'smtp.gmail.com') pw = pw.replace(/\s/g, ''); // Google shows app passwords in groups of four
      const port = parseInt($('#f-port').value, 10);
      if (!EMAIL_RE.test(email)) return (err.textContent = 'Enter a valid email address.');
      if (!pw && !st.hasPassword) return (err.textContent = 'Enter your app password.');
      if (!host) return (err.textContent = 'Enter the SMTP server.');
      if (!port) return (err.textContent = 'The port should be a number (usually 465 or 587).');
      const name = $('#f-name').value.trim() ||
        email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      state = await api.invoke('save-settings', { name, email, password: pw, host, port });
      closePanel();
      showToast('Email settings saved');
      if (then) then();
    };
    $('#ok').addEventListener('click', go);
    panel.querySelectorAll('input').forEach((i) => onEnter(i, go));
  });
}

function openAlert() {
  if (state.session) return showToast('A timer is already running');
  if (!tasks.length) return showToast('Add some cards first');
  const st = state.settings;
  const connected = !!(st.email && st.hasPassword);
  if (!connected && !state.email_later) return openSettings(openAlert, true);
  const chips = [[15, '15m'], [30, '30m'], [45, '45m'], [60, '1h'], [90, '1½h'], [120, '2h']];
  openPanel(`<h2>Start a focus timer</h2>
    <p class="sub">Only the cards you pick stay in your stack until the timer ends.</p>
    <label>Which tasks will you do? <a id="all" class="right">Select none</a></label>
    <div class="picks">${tasks.map((t) => `<label class="pick"><input type="checkbox" value="${t.id}" checked><span>${esc(t.text)}</span></label>`).join('')}</div>
    <label>How long will they take?</label>
    <div class="row"><input id="f-min" value="${esc(state.last_minutes)}" style="width:72px;flex:none" autofocus><span class="hint" style="margin:0">minutes</span></div>
    <div class="chips">${chips.map(([m, l]) => `<button class="chip" data-m="${m}">${l}</button>`).join('')}</div>
    ${connected ? `<label>Who should get an alert? <span class="hint" style="font-weight:400">(optional)</span></label>
    <textarea id="f-to" rows="2" placeholder="Emails, separated by commas">${esc(state.recipients)}</textarea>
    <div class="hint">Leave blank to just run the timer. Sending from ${esc(st.email)} · <a id="change">Change</a></div>`
    : `<label>Alerts</label>
    <div class="hint" style="margin-top:0">Email isn't connected, so this timer won't notify anyone. <a id="change">Connect email</a></div>`}
    <div class="err" id="err"></div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn orange" id="ok">Start timer</button></div>`,
  () => {
    const min = $('#f-min');
    const refresh = () => panel.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.m === min.value.trim()));
    panel.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { min.value = c.dataset.m; refresh(); }));
    min.addEventListener('input', refresh);
    refresh();
    $('#change').addEventListener('click', () => openSettings(openAlert));
    const toBox = $('#f-to');
    const label = () => ($('#ok').textContent = toBox && toBox.value.trim() ? 'Start timer & send' : 'Start timer');
    if (toBox) toBox.addEventListener('input', label);
    label();
    const boxes = [...panel.querySelectorAll('.pick input')];
    const syncAll = () => ($('#all').textContent = boxes.every((b) => b.checked) ? 'Select none' : 'Select all');
    boxes.forEach((b) => b.addEventListener('change', syncAll));
    $('#all').addEventListener('click', (e) => {
      e.preventDefault();
      const on = !boxes.every((b) => b.checked);
      boxes.forEach((b) => (b.checked = on));
      syncAll();
    });
    const go = async () => {
      const err = $('#err');
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) return (err.textContent = 'Pick at least one task to focus on.');
      const m = parseFloat(min.value);
      if (!(m > 0 && m <= 24 * 60)) return (err.textContent = 'Enter how many minutes the tasks will take (for example 45).');
      const emails = connected ? $('#f-to').value.split(/[\s,;]+/).filter(Boolean) : [];
      const bad = emails.find((x) => !EMAIL_RE.test(x));
      if (bad) return (err.textContent = `That doesn't look like an email address: ${bad}`);
      const ok = $('#ok');
      ok.disabled = true;
      ok.textContent = emails.length ? 'Sending…' : 'Starting…';
      err.textContent = '';
      const res = await api.invoke('start-session', { minutes: m, emails, ids });
      if (!panelOpen) return;
      if (!res.ok) {
        ok.disabled = false;
        ok.textContent = 'Try again';
        err.textContent = res.error;
        return;
      }
      state = res.state;
      closePanel();
      parkExcept(ids);
      updatePill();
      showToast(emails.length ? `Alert sent to ${emails.length} ${emails.length === 1 ? 'person' : 'people'} · timer started` : 'Focus timer started', 3500);
    };
    $('#ok').addEventListener('click', go);
    onEnter(min, go);
  });
}

// ---------- think it through: one question at a time, ending in new cards ----------

const QUESTIONS = [
  ['What task are you thinking about?', 'Describe it messily.'],
  ['Who is this for, and why do they need it?', ''],
  ['What are the basic requirements for this task?', ''],
  ['What are your obstacles?', "Things you don't know, people you have to wait on."],
  ['Do you have all the resources you need at hand?', 'Websites, people to ask, other important material.'],
  ['If you had to create a list of to-do items to get to the end, what would they be?', 'Put each one on its own line. They’ll become cards.'],
];
// Closing the panel keeps your answers, so you can pick up where you left off.
let think = { step: 0, answers: [] };

function openThink() {
  const i = think.step;
  const last = i === QUESTIONS.length - 1;
  const [q, help] = QUESTIONS[i];
  openPanel(`<div class="think-head"><span class="think-tag">THINK IT THROUGH</span>
      <span class="hint">Step ${i + 1} of ${QUESTIONS.length}</span></div>
    <div class="steps">${QUESTIONS.map((_, k) => `<i class="${k < i ? 'past' : k === i ? 'now' : ''}"></i>`).join('')}</div>
    <h2>${esc(q)}</h2>
    ${help ? `<p class="sub">${esc(help)}</p>` : ''}
    <textarea id="f-ans" rows="${last ? 6 : 5}" autofocus placeholder="${last ? 'One task per line' : ''}">${esc(think.answers[i] || '')}</textarea>
    <div id="think-out" class="hidden"></div>
    <div class="hint">Ctrl+Enter for ${last ? 'make cards' : 'next'}${i > 0 || think.answers.some(Boolean) ? ' · <a id="restart">Start over</a>' : ''}</div>
    <div class="err" id="err"></div>
    <div class="actions">
      <button class="btn ghost" id="back">${i === 0 ? 'Close' : 'Back'}</button>
      ${last ? '' : '<button class="btn ghost" id="skip">Skip</button>'}
      <button class="btn ${last ? 'orange' : ''}" id="next">${last ? 'Make cards' : 'Next'}</button>
    </div>`,
  () => {
    const box = $('#f-ans');
    const keep = () => (think.answers[i] = box.value);
    const go = (step) => { keep(); think.step = step; openThink(); };
    box.setSelectionRange(box.value.length, box.value.length);
    $('#back').addEventListener('click', () => (i === 0 ? (keep(), closePanel()) : go(i - 1)));
    if (!last) $('#skip').addEventListener('click', () => go(i + 1));
    const next = () => {
      if (!last) return go(i + 1);
      const lines = box.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return ($('#err').textContent = 'Write at least one task, one per line.');
      think = { step: 0, answers: [] };
      turnIntoCards(lines);
    };
    $('#next').addEventListener('click', next);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); next(); }
    });
    const restart = $('#restart');
    if (restart) restart.addEventListener('click', () => { think = { step: 0, answers: [] }; openThink(); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Each line becomes a little card in the panel, then flies into the stack and
// becomes a real card. Lines land last-to-first so the first one ends on top.
async function turnIntoCards(lines) {
  const out = $('#think-out');
  $('#f-ans').classList.add('hidden');
  panel.querySelectorAll('.actions .btn').forEach((b) => (b.disabled = true));
  const order = lines.slice().reverse();
  const tintOf = (k) => TINTS[(colorI + k) % TINTS.length];
  out.innerHTML = lines.map((l, i) => `<div class="mini-card" style="--c:${tintOf(lines.length - 1 - i)}">${esc(l)}</div>`).join('');
  out.classList.remove('hidden');
  await wait(450);

  const minis = [...out.children];
  const flies = minis.map((m) => {
    const r = m.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'fly-card';
    f.textContent = m.textContent;
    f.style.setProperty('--c', m.style.getPropertyValue('--c'));
    Object.assign(f.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    $('#app').appendChild(f);
    return f;
  });
  closePanel();
  await wait(260); // let the stack fade back in before measuring where it is
  const t = stack.getBoundingClientRect();
  const parkedNow = focusing();

  flies.slice().reverse().forEach((f, k) => {
    const r = f.getBoundingClientRect();
    const from = { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '8px', fontSize: '12px', transform: 'rotate(0deg)', opacity: 1 };
    const midTop = Math.min(r.top, t.top) - 50;
    const anim = f.animate([
      from,
      { left: `${(r.left + t.left) / 2}px`, top: `${midTop}px`, width: `${(r.width + t.width) / 2}px`, height: `${(r.height + t.height) / 2}px`,
        borderRadius: '10px', fontSize: '14px', transform: `rotate(${k % 2 ? 4 : -4}deg)`, opacity: 1, offset: 0.5 },
      { left: `${t.left}px`, top: `${t.top}px`, width: `${t.width}px`, height: `${t.height}px`,
        borderRadius: '13px', fontSize: '16px', transform: 'rotate(0deg)', opacity: parkedNow ? 0 : 1 },
    ], { duration: 650, delay: k * 160, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'both' });
    anim.onfinish = () => {
      placeCard(order[k]);
      f.remove();
    };
  });

  await wait(650 + (lines.length - 1) * 160 + 50);
  showToast(parkedNow
    ? `Saved ${plural(lines.length, 'card')} for after your focus timer`
    : `Added ${plural(lines.length, 'card')} to your stack`, 3000);
}

// Like addTasks, but for one card at a time without cancelling other
// in-flight animations (the flying cards land one after another).
function placeCard(text) {
  const t = { id: uid(), text, color: COLORS[colorI++ % COLORS.length] };
  if (focusing()) {
    parked.unshift(t);
    persist();
    return;
  }
  tasks.unshift(t);
  persist();
  layout();
  els.get(t.id).animate([{ transform: 'translateY(-4px) scale(1.04)' }, { transform: tf(0) }], { duration: 280, easing: 'ease-out' });
}

function confirmFinish() {
  const s = state.session;
  if (!s || s.end <= Date.now()) return;
  openConfirm('Finish early?',
    `You've completed ${s.done.length} of ${plural(s.order.length, 'task')}. Stop the timer now and email your results?`,
    'Finish & send results', 'orange',
    async () => { state = await api.invoke('finish-now'); updatePill(); });
}

// ---------- messages from the main process ----------

api.on('state', (s) => {
  state = s; // tasks are owned by this window; only session/settings are taken from here
  updatePill();
});
api.on('toast', (msg) => showToast(msg, 4000));
api.on('report-sent', ({ summary, people }) =>
  openInfo("Time's up!", people ? `${summary} Your results were emailed to ${people} ${people === 1 ? 'person' : 'people'}.` : summary));
api.on('open', (what) => ({ add: openAdd, alert: openAlert, think: openThink, settings: () => openSettings() })[what]());
api.on('card-action', (a) => ({ edit: openEdit, done: complete, delete: removeTop })[a]());

(async () => {
  state = await api.invoke('get-state');
  tasks = state.tasks;
  parked = state.parked || [];
  colorI = state.color_i;
  layout();
  updatePill();
})();
