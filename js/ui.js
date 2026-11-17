// ui.js - menus, spawn menu (3d previews), hud, pause, settings, nextbot dialog. plain dom, real buttons.
import { MAPS, drawPreview } from './maps.js';
import { SPAWNABLES, CATEGORIES } from './spawnables.js';
import { ITEMS } from './items.js';
import { KEYS } from './config.js';
import { loadImage } from './imgutil.js';
import * as audio from './audio.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'bunsbox.settings', NAME_KEY = 'bunsbox.name';
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

export const settings = { sens: 1, volume: 0.7, fov: 75, ...(read(SETTINGS_KEY) || {}) };

let h = {}, intent = 'sp', activeCat = CATEGORIES[0], helpTimer = 0, settingsReturn = null, lastPrompt = null;
let previews = new Map(), isOwner = true;

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
  $('btn-mp-back').addEventListener('click', () => showScreen('title'));
  $('btn-host').addEventListener('click', () => { intent = 'host'; openMaps(); });
  $('btn-maps-back').addEventListener('click', () => showScreen(intent === 'sp' ? 'title' : 'mp'));
  $('btn-settings-title').addEventListener('click', () => openSettings($('btn-settings-title')));

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
const SCREENS = ['loading', 'title', 'mp', 'maps'];
export function showScreen(name) {
  $('menus').hidden = name === 'none';
  for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
  if (name !== 'none') $('screen-' + name).querySelector('button, input')?.focus();
}
export function showTitle(notice) {
  hideGameUI();
  $('notice').hidden = !notice; $('notice').textContent = notice || '';
  showScreen('title');
}
export function setLoading(frac, text) { $('load-bar').value = frac; if (text) $('loading-text').textContent = text; }
export function fatal(msg) { $('load-bar').hidden = true; $('loading-text').textContent = msg; $('loading-text').classList.add('err'); }

function setStatus(id, msg, isErr = false) { const el = $(id); el.textContent = msg; el.classList.toggle('err', isErr); }
function lockButtons(on) { document.querySelectorAll('#screen-mp button, #screen-maps button').forEach(b => { b.disabled = on; }); }

function openMaps() {
  $('maps-title').textContent = intent === 'host' ? 'pick a map for your room' : 'pick a map';
  setStatus('maps-status', '');
  const box = $('map-list');
  box.textContent = '';
  for (const m of MAPS) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'map-card';
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; cv.setAttribute('aria-hidden', 'true');
    drawPreview(cv, m);
    const t = document.createElement('strong'); t.textContent = m.name;
    const d = document.createElement('span'); d.textContent = m.desc;
    btn.append(cv, t, d);
    btn.addEventListener('click', async () => {
      write(NAME_KEY, $('player-name').value.trim());
      if (intent === 'sp') { h.onStartSP(m.id); return; }
      setStatus('maps-status', 'creating room...');
      lockButtons(true);
      try { await h.onHost(m.id, playerName()); } catch (err) { setStatus('maps-status', err.message, true); }
      lockButtons(false);
    });
    box.append(btn);
  }
  showScreen('maps');
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
    ['use: pick up / sit / thruster', keyLabels('use')], ['use held item', 'left click'], ['glue/hinge: cancel / remove', 'right click'], ['switch items', 'scroll wheel'],
    ['remove aimed prop', keyLabels('remove')], ['undo last spawn', keyLabels('undo')],
    ['detonate aimed explosive', keyLabels('detonate')], ['clear all props', keyLabels('clearAll')], ['this help', keyLabels('help')], ['pause', 'Esc'],
  ];
  const dl = $('help-list');
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = v; const dd = document.createElement('dd'); dd.textContent = k; dl.append(dt, dd); }
  $('spawn-hint').textContent = `click an item to spawn it at the crosshair - ${keyLabels('remove')} remove - ${keyLabels('undo')} undo - ${keyLabels('detonate')} detonate - ${keyLabels('use')} on an item picks it up`;
}

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
