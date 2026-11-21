// ui.js - menus, spawn menu (3d previews), hud, pause, settings, nextbot dialog, asset problems. plain dom, real buttons.
import { MAPS, drawPreview } from './maps.js';
import { parseMap, drawCustomPreview } from './mapfile.js';
import { SPAWNABLES, CATEGORIES } from './spawnables.js';
import { ITEMS } from './items.js';
import { KEYS, CHAT } from './config.js';
import { loadImage } from './imgutil.js';
import * as audio from './audio.js';
import { listMaps, loadMap, pool, UPLOAD_URL } from './workshop.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'bunsbox.settings', NAME_KEY = 'bunsbox.name';
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export const settings = { sens: 1, volume: 0.7, fov: 75, ...(read(SETTINGS_KEY) || {}) };

let h = {}, intent = 'sp', activeCat = CATEGORIES[0], helpTimer = 0, settingsReturn = null, lastPrompt = null;
let previews = new Map(), isOwner = true;
const customMaps = [];     // maps imported this session (parsed .bm files)

const keyLabel = c => c.startsWith('Key') ? c.slice(3) : c.startsWith('Shift') ? 'Shift' : c;
export const keyLabels = a => [...new Set(KEYS[a].map(keyLabel))].join(' / ');
export const playerName = () => ($('player-name').value.trim() || 'player').slice(0, 16);

export function init(handlers) {
  h = handlers;

  document.addEventListener('click', e => { if (e.target.closest('button')) { audio.unlock(); audio.play('click'); } });

  $('player-name').value = read(NAME_KEY) || '';
  $('player-name').addEventListener('change', () => write(NAME_KEY, $('player-name').value.trim()));

  $('btn-sp').addEventListener('click', () => { intent = 'sp'; openMaps(); });
  $('btn-mp').addEventListener('click', () => { setStatus('mp-status', ''); showScreen('mp'); });
  $('btn-builder').addEventListener('click', () => h.onBuilder());
  $('btn-workshop').addEventListener('click', () => { showScreen('workshop'); loadWorkshop(false); });
  initTerm();
  initWorkshop();
  $('btn-mp-back').addEventListener('click', () => showScreen('title'));
  $('btn-host').addEventListener('click', () => { intent = 'host'; openMaps(); });
  $('btn-maps-back').addEventListener('click', () => showScreen(intent === 'sp' ? 'title' : 'mp'));
  $('btn-settings-title').addEventListener('click', () => openSettings($('btn-settings-title')));

  // asset problems (loading screen + title bar)
  $('btn-retry').addEventListener('click', () => { $('btn-retry').disabled = true; h.onRetryAssets(); });
  $('btn-retry-title').addEventListener('click', () => h.onRetryAssets());
  $('btn-continue').addEventListener('click', () => h.onContinueAssets());

  // map import
  $('btn-import-map').addEventListener('click', () => $('map-file').click());
  $('map-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 2e6) throw new Error('file too big (2mb max)');
      const bm = parseMap(await f.text());
      customMaps.unshift(bm);
      openMaps();
      setStatus('maps-status', `imported "${bm.meta.name}"`);
    } catch (err) { setStatus('maps-status', err.message, true); }
  });

  $('join-form').addEventListener('submit', async e => {
    e.preventDefault();
    write(NAME_KEY, $('player-name').value.trim());
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length < 4) { setStatus('mp-status', 'enter the room code first', true); return; }
    setStatus('mp-status', 'connecting...');
    lockButtons(true);
    try { await h.onJoin(code, playerName()); } catch (err) { setStatus('mp-status', err.message, true); }
    lockButtons(false);
  });

  $('btn-resume').addEventListener('click', () => h.onResume());
  $('btn-settings').addEventListener('click', () => openSettings($('btn-settings')));
  $('btn-exit').addEventListener('click', () => h.onExit());
  $('btn-settings-back').addEventListener('click', closeSettings);
  for (const [id, key] of [['set-sens', 'sens'], ['set-volume', 'volume'], ['set-fov', 'fov']]) {
    $(id).value = settings[key];
    $(id).addEventListener('input', () => { settings[key] = Number($(id).value); write(SETTINGS_KEY, settings); h.onSettings?.(); });
  }

  $('lockhint').addEventListener('click', () => h.onLockClick());

  // chat box (multiplayer). main.js opens it with the slash key
  $('chat-input').addEventListener('keydown', e => {
    e.stopPropagation();                                  // game hotkeys must not fire while typing
    if (e.key === 'Enter') { e.preventDefault(); const t = $('chat-input').value.trim(), cb = chatCb; if (t) cb?.onSend?.(t); closeChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
  $('clear-all').addEventListener('click', () => h.onClearAll());

  // nextbot dialog
  $('nb-url').addEventListener('input', () => {
    nb.valid = false; nb.token++; $('nb-spawn').disabled = true;
    clearTimeout(nb.timer); nb.timer = setTimeout(nbValidate, 450);
  });
  $('nb-speed').addEventListener('input', () => { $('nb-speed-out').textContent = $('nb-speed').value; });
  $('nb-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!nb.valid) return;
    nb.onSpawn?.({ url: nb.url, speed: Number($('nb-speed').value) });
    closeNextbot();
  });
  $('nb-cancel').addEventListener('click', closeNextbot);
  $('nb').addEventListener('keydown', e => { if (e.key === 'Escape') closeNextbot(); });

  buildCats();
  buildHelp();
}

// ---- screens
const SCREENS = ['loading', 'title', 'mp', 'maps', 'workshop'];
export function showScreen(name) {
  $('menus').hidden = name === 'none';
  for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
  if (name !== 'none') (name === 'loading' ? $('term-input') : $('screen-' + name).querySelector('button:not([disabled]), input'))?.focus();
}
export function showTitle(notice) {
  hideGameUI();
  $('notice').hidden = !notice; $('notice').textContent = notice || '';
  showScreen('title');
}
// ---- loading console (styled after the gmod console). the game prints what it is loading, asks questions, takes a few commands
let askCb = null, askDef = true, problems = false;
const lineMatches = el => !$('term-filter-on').checked || !$('term-filter').value.trim() || el.textContent.toLowerCase().includes($('term-filter').value.trim().toLowerCase());
const syncActions = () => {
  $('term-ask-btns').hidden = !askCb; $('term-fail-btns').hidden = !problems;
  $('term-actions').hidden = !askCb && !problems;
};
export function termPrint(text, cls = '') {
  const log = $('term-log'), el = document.createElement('div');
  el.className = 'tl' + (cls ? ' ' + cls : ''); el.textContent = text || '\u00a0';
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  el.hidden = !lineMatches(el);
  log.append(el);
  while (log.children.length > 700) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}
export function termClear() { $('term-log').textContent = ''; }
// yes/no question. type y / n (enter = the default) or click a button
export function termAsk(question, defYes = true) {
  return new Promise(res => {
    askDef = defYes;
    termPrint(`${question} ${defYes ? '[Y/n]' : '[y/N]'}`, 'q');
    askCb = ans => { askCb = null; syncActions(); termPrint(`] ${ans ? 'yes' : 'no'}`, 'dim'); res(ans); };
    syncActions();
    $('term-input').focus();
  });
}
export const getPreviewPref = () => read('bunsbox.previews');          // true / false / null (never answered)
export const setPreviewPref = v => write('bunsbox.previews', !!v);

function termCommand(raw) {
  const v = raw.trim(), s = v.toLowerCase();
  if (askCb) {
    if (s === '') return askCb(askDef);
    if (['y', 'yes', 'true', '1'].includes(s)) return askCb(true);
    if (['n', 'no', 'false', '0'].includes(s)) return askCb(false);
    termPrint(`] ${v}`, 'dim'); termPrint('please answer y or n', 'err');
    return;
  }
  if (!v) return;
  termPrint(`] ${v}`, 'dim');
  if (s === 'help') {
    termPrint('commands: help, clear, retry, continue');
    termPrint('retry / continue only do something if some assets timed out.', 'dim');
  } else if (s === 'clear') termClear();
  else if (s === 'retry' || s === 'continue') {
    if (!problems) termPrint(`nothing to ${s} right now.`, 'dim');
    else $(s === 'retry' ? 'btn-retry' : 'btn-continue').click();
  } else termPrint(`Unknown command "${v}"`, 'err');
}
function initTerm() {
  $('term-form').addEventListener('submit', e => { e.preventDefault(); const i = $('term-input'), v = i.value; i.value = ''; termCommand(v); });
  $('term-yes').addEventListener('click', () => askCb?.(true));
  $('term-no').addEventListener('click', () => askCb?.(false));
  const refilter = () => { for (const el of $('term-log').children) el.hidden = !lineMatches(el); };
  $('term-filter').addEventListener('input', () => { $('term-filter-on').checked = !!$('term-filter').value.trim(); refilter(); });
  $('term-filter-on').addEventListener('change', refilter);
  $('term-log').addEventListener('click', () => { if (!getSelection().toString()) $('term-input').focus(); });
}

export function setLoading(frac, text) { $('load-bar').value = frac; if (text) $('loading-text').textContent = text; }
export function fatal(msg) { $('load-bar').hidden = true; $('loading-text').textContent = msg; $('loading-text').classList.add('err'); termPrint(msg, 'err'); }

// assets that timed out / failed: list them in red and offer retry or continue
export function showLoadProblems(list, missingCount) {
  $('loading-text').textContent = 'some assets did not finish loading.';
  termPrint('');
  termPrint(`${list.length} asset${list.length === 1 ? '' : 's'} timed out or failed:`, 'err');
  for (const e of list) termPrint(`  ${e.kind} "${e.path}" - ${e.status === 'timeout' ? 'timed out' : 'failed'}${e.detail ? ` (${e.detail})` : ''}`, 'err');
  if (missingCount) termPrint(`${missingCount} other optional assets were not found (built-in fallbacks are used for those).`, 'dim');
  termPrint('type "retry" or "continue", or use the buttons below.', 'warn');
  problems = true;
  $('btn-retry').disabled = false;
  syncActions();
  showScreen('loading');
}
export function hideLoadProblems() { problems = false; syncActions(); $('load-bar').hidden = false; }
export function setAssetWarning(n) {
  $('asset-warn').hidden = !n;
  $('asset-warn-text').textContent = `${n} asset${n === 1 ? '' : 's'} timed out, fallbacks are in use.`;
}

function setStatus(id, msg, isErr = false) { const el = $(id); el.textContent = msg; el.classList.toggle('err', isErr); }
function lockButtons(on) { document.querySelectorAll('#screen-mp button, #screen-maps button, #screen-workshop button').forEach(b => { b.disabled = on; }); }

function openMaps() {
  $('maps-title').textContent = intent === 'host' ? 'pick a map for your room' : 'pick a map';
  setStatus('maps-status', '');
  const box = $('map-list');
  box.textContent = '';
  const card = (draw, title, desc, pick) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'map-card';
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; cv.setAttribute('aria-hidden', 'true');
    draw(cv);
    const t = document.createElement('strong'); t.textContent = title;
    const d = document.createElement('span'); d.textContent = desc;
    btn.append(cv, t, d);
    btn.addEventListener('click', async () => {
      write(NAME_KEY, $('player-name').value.trim());
      if (intent === 'sp') { pick.sp(); return; }
      setStatus('maps-status', 'creating room...');
      lockButtons(true);
      try { await pick.host(); } catch (err) { setStatus('maps-status', err.message, true); }
      lockButtons(false);
    });
    box.append(btn);
  };
  for (const bm of customMaps) {
    card(cv => drawCustomPreview(cv, bm), `${bm.meta.name} (custom)`, `by ${bm.meta.author}${bm.meta.description ? ' - ' + bm.meta.description : ''}`,
      { sp: () => h.onStartSP(null, bm), host: () => h.onHost(null, playerName(), bm) });
  }
  for (const m of MAPS) card(cv => drawPreview(cv, m), m.name, m.desc, { sp: () => h.onStartSP(m.id, null), host: () => h.onHost(m.id, playerName(), null) });
  showScreen('maps');
}

// ---- map workshop: community maps fetched from the github repo
let wsToken = 0, wsCards = [];
function initWorkshop() {
  $('ws-back').addEventListener('click', () => showScreen('title'));
  $('ws-refresh').addEventListener('click', () => loadWorkshop(true));
  $('ws-upload').href = UPLOAD_URL;
  $('ws-search').addEventListener('input', () => {
    const q = $('ws-search').value.trim().toLowerCase();
    for (const c of wsCards) c.el.hidden = !!q && !c.text.includes(q);
  });
}
function wsCard(entry, token) {
  const el = document.createElement('div');
  el.className = 'ws-card';
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; cv.setAttribute('aria-hidden', 'true');
  const t = document.createElement('strong'); t.textContent = entry.name;
  const d = document.createElement('span'); d.textContent = 'loading...';
  const m = document.createElement('small'); m.textContent = `${Math.max(1, Math.round(entry.size / 1024))} kb`;
  const row = document.createElement('div'); row.className = 'row';
  const mk = (label, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.disabled = true; if (cls) b.className = cls; row.append(b); return b; };
  const play = mk('play', 'primary'), host = mk('host'), edit = mk('edit');
  el.append(cv, t, d, m, row);
  const card = { el, text: entry.name.toLowerCase() };
  loadMap(entry).then(bm => {
    if (token !== wsToken) return;
    drawCustomPreview(cv, bm);
    t.textContent = bm.meta.name;
    d.textContent = `by ${bm.meta.author}${bm.meta.description ? ' - ' + bm.meta.description : ''}`;
    m.textContent = `${bm.parts.length} parts, ${bm.props.length} props - ${Math.max(1, Math.round(entry.size / 1024))} kb - ${entry.path}`;
    card.text = `${bm.meta.name} ${bm.meta.author} ${bm.meta.description} ${entry.name}`.toLowerCase();
    play.disabled = host.disabled = edit.disabled = false;
    play.addEventListener('click', () => { write(NAME_KEY, $('player-name').value.trim()); h.onStartSP(null, bm); });
    host.addEventListener('click', async () => {
      write(NAME_KEY, $('player-name').value.trim());
      setStatus('ws-status', 'creating room...'); lockButtons(true);
      try { await h.onHost(null, playerName(), bm); } catch (err) { setStatus('ws-status', err.message, true); }
      lockButtons(false);
    });
    edit.addEventListener('click', () => {
      if (confirm(`open "${bm.meta.name}" in the map builder?\n\nthis replaces the map that is currently in the builder. export it first if you want to keep it.`)) h.onBuilder(bm);
    });
  }).catch(() => { el.remove(); wsCards = wsCards.filter(c => c !== card); wsCards.skipped = (wsCards.skipped || 0) + 1; });
  wsCards.push(card);
  return el;
}
async function loadWorkshop(force) {
  const token = ++wsToken, box = $('ws-list');
  box.textContent = ''; wsCards = [];
  $('ws-refresh').disabled = true;
  setStatus('ws-status', 'fetching the map list from github...');
  let list;
  try { list = await listMaps(force); }
  catch (e) { if (token === wsToken) { setStatus('ws-status', `could not reach github (${e.message}). check your connection and hit refresh.`, true); $('ws-refresh').disabled = false; } return; }
  if (token !== wsToken) return;
  if (!list.length) { setStatus('ws-status', 'no maps in the workshop yet. upload the first one!'); $('ws-refresh').disabled = false; return; }
  setStatus('ws-status', `loading ${list.length} map${list.length === 1 ? '' : 's'}...`);
  let done = 0;
  for (const e of list) box.append(wsCard(e, token));
  await pool(list, 4, async e => { try { await loadMap(e, force); } catch (err) { /* the card removes itself */ } if (token === wsToken) setStatus('ws-status', `loading maps ${++done}/${list.length}...`); });
  if (token !== wsToken) return;
  await new Promise(r => setTimeout(r, 0));
  const shown = box.children.length;
  setStatus('ws-status', shown ? `${shown} map${shown === 1 ? '' : 's'} in the workshop${shown < list.length ? ` (${list.length - shown} files skipped: not valid bunsbox maps)` : ''}` : 'no valid maps found in the repo yet. upload one!');
  $('ws-refresh').disabled = false;
}

// ---- hud
export function showHUD(on) { $('hud').hidden = !on; if (on) { showScreen('none'); showHelp(true); clearTimeout(helpTimer); helpTimer = setTimeout(() => showHelp(false), 9000); } }
export function hideGameUI() { for (const id of ['hud', 'pause', 'settings', 'spawnmenu', 'nb']) $(id).hidden = true; }
export function setHP(hp, max) {
  $('hp-fill').style.width = (100 * hp / max) + '%';
  $('hp').classList.toggle('low', hp < max * 0.3);
  $('hp-text').textContent = Math.ceil(hp);
  $('hp').setAttribute('aria-valuenow', Math.ceil(hp));
}
export function flashHurt() { const el = $('hurt'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
export function setPlayers(n) { $('players').textContent = `players: ${n}`; }
export function setRoom(code) { $('room').textContent = code ? `room: ${code}` : ''; }
export function setDeath(text) { $('death').hidden = !text; $('death').textContent = text || ''; }
export function setPrompt(text) { if (text === lastPrompt) return; lastPrompt = text; $('prompt').hidden = !text; $('prompt').textContent = text || ''; }
export function showLockHint(on) { $('lockhint').hidden = !on; }
export function showHelp(on) { $('help').hidden = !on; }
export function toggleHelp() { clearTimeout(helpTimer); showHelp($('help').hidden); }
export function toast(msg) {
  const d = document.createElement('div'); d.textContent = msg; $('toasts').append(d);
  setTimeout(() => d.remove(), 3500);
}
export function setHotbar(list, sel) {
  const bar = $('hotbar');
  bar.hidden = list.length <= 1;
  bar.textContent = '';
  list.forEach((id, i) => {
    const d = document.createElement('div'); d.className = 'slot' + (i === sel ? ' sel' : '');
    const n = document.createElement('b'); n.textContent = i;
    const t = document.createElement('span'); t.textContent = id ? ITEMS[id].name : 'hands';
    d.append(n, t); bar.append(d);
  });
  $('item-hint').textContent = list[sel] ? ITEMS[list[sel]].hint : '';
}

function buildHelp() {
  const rows = [
    ['move', 'W A S D'], ['jump (hold to bunny hop)', keyLabels('jump')], ['sprint (forward only)', keyLabels('sprint') + ' + W'],
    ['spawn menu (hold)', keyLabels('spawnMenu')],
    ['use: pick up / sit / thruster / drive', keyLabels('use')], ['use held item', 'left click'], ['glue/hinge: cancel / remove, scale: shrink', 'right click'], ['switch items', 'scroll wheel'],
    ['equip item (0 = hands)', '0 - 9'], ['chat (multiplayer)', keyLabels('chat')], ['driving: gas / steer / brake', 'W S / A D / ' + keyLabels('jump')],
    ['remove aimed prop', keyLabels('remove')], ['undo last spawn', keyLabels('undo')],
    ['detonate aimed explosive', keyLabels('detonate')], ['clear all props', keyLabels('clearAll')], ['this help', keyLabels('help')], ['pause', 'Esc'],
  ];
  const dl = $('help-list');
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = v; const dd = document.createElement('dd'); dd.textContent = k; dl.append(dt, dd); }
  $('spawn-hint').textContent = `click an item to spawn it at the crosshair - ${keyLabels('remove')} remove - ${keyLabels('undo')} undo - ${keyLabels('detonate')} detonate - ${keyLabels('use')} on an item picks it up`;
}

// ---- chat
let chatCb = null;
export function openChat(onSend, onClose) {
  chatCb = { onSend, onClose };
  $('chat').classList.add('open');
  const i = $('chat-input'); i.hidden = false; i.value = ''; i.focus();
}
export function closeChat(silent = false) {
  const i = $('chat-input');
  if (i.hidden) return;
  i.hidden = true; i.blur(); $('chat').classList.remove('open');
  const cb = chatCb; chatCb = null;
  if (!silent) cb?.onClose?.();
}
export function chatLine(name, text) {
  const log = $('chat-log'), d = document.createElement('div');
  if (name) { const b = document.createElement('b'); b.textContent = name + ': '; d.append(b); }
  d.append(document.createTextNode(text));
  log.append(d);
  while (log.children.length > CHAT.MAX_LINES) log.firstChild.remove();
  setTimeout(() => d.classList.add('old'), CHAT.SHOW_SECONDS * 1000);
}
export function chatClear() { $('chat-log').textContent = ''; }

// ---- spawn menu
export function setPreviews(map) { previews = map; selectCat(activeCat); }
export function setOwner(owner) {           // the OP tab only exists for the server owner (host / singleplayer)
  isOwner = owner;
  buildCats();
}
const catVisible = c => isOwner || SPAWNABLES.some(s => s.category === c && !s.op);

function buildCats() {
  const cats = $('cats');
  cats.textContent = '';
  const visible = CATEGORIES.filter(catVisible);
  if (!visible.includes(activeCat)) activeCat = visible[0];
  for (const c of visible) {
    const b = document.createElement('button');
    b.type = 'button'; b.role = 'tab'; b.textContent = c; b.dataset.cat = c;
    b.addEventListener('click', () => selectCat(c));
    cats.append(b);
  }
  selectCat(activeCat);
}
function selectCat(c) {
  activeCat = c;
  for (const b of $('cats').children) b.setAttribute('aria-selected', String(b.dataset.cat === c));
  const box = $('items'); box.textContent = '';
  SPAWNABLES.filter(x => x.category === c && (isOwner || !x.op)).forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'item'; b.style.animationDelay = (i * 25) + 'ms';
    const pv = previews.get(s.id);
    let icon;
    if (pv) { icon = document.createElement('img'); icon.src = pv; icon.alt = ''; }
    else { icon = document.createElement('i'); icon.style.background = '#' + s.color.toString(16).padStart(6, '0'); }
    const n = document.createElement('span'); n.textContent = s.name;
    b.append(icon, n);
    b.addEventListener('click', () => h.onSpawnItem(s.id));
    box.append(b);
  });
}
export function openSpawn() { $('spawnmenu').hidden = false; }
export function closeSpawn() { $('spawnmenu').hidden = true; }

// ---- nextbot dialog: paste an image link, see if it works, pick a speed
const nb = { token: 0, valid: false, url: '', onSpawn: null, onClose: null, timer: 0 };
function nbStatus(msg, cls = '') { const el = $('nb-status'); el.textContent = msg; el.className = cls; }
function nbValidate() {
  const url = $('nb-url').value.trim(), prev = $('nb-preview');
  nb.valid = false; $('nb-spawn').disabled = true;
  if (!url) { prev.textContent = 'no image yet'; nbStatus(''); return; }
  const token = ++nb.token;
  prev.textContent = '...'; nbStatus('checking link...');
  loadImage(url).then(img => {
    if (token !== nb.token) return;
    nb.valid = true; nb.url = url;
    prev.replaceChildren(img);
    nbStatus(`works! image is ${img.naturalWidth}x${img.naturalHeight}`, 'ok');
    $('nb-spawn').disabled = false;
  }).catch(e => {
    if (token !== nb.token) return;
    prev.textContent = 'invalid';
    nbStatus(e.message, 'err');
  });
}
export function openNextbot(onSpawn, onClose) {
  nb.onSpawn = onSpawn; nb.onClose = onClose; nb.valid = false; nb.token++;
  $('nb').hidden = false;
  $('nb-spawn').disabled = true;
  $('nb-speed-out').textContent = $('nb-speed').value;
  nbValidate();
  $('nb-url').focus();
}
function closeNextbot() {
  $('nb').hidden = true; nb.token++; clearTimeout(nb.timer);
  const cb = nb.onClose; nb.onClose = null; nb.onSpawn = null;
  cb?.();
}

// ---- pause + settings
export function showPause(on, room) {
  $('pause').hidden = !on;
  $('pause-room').textContent = room ? `room code: ${room}` : '';
  if (on) $('btn-resume').focus(); else $('settings').hidden = true;
}
function openSettings(from) { settingsReturn = from; $('settings').hidden = false; $('btn-settings-back').focus(); }
function closeSettings() { $('settings').hidden = true; settingsReturn?.focus(); }
