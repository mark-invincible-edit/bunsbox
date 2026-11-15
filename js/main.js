// main.js - bootstrap, game session, input, main loop.
import * as THREE from 'three';
import { NET, PLAYER, LIMITS, ITEMS_CFG as IC, keyIs, TEXTURE_FILES, SOUND_NAMES } from './config.js';
import { SPAWNABLES, getSpawnable } from './spawnables.js';
import { ITEMS, Inventory, ViewModel } from './items.js';
import * as assets from './assets.js';
import * as audio from './audio.js';
import { MAPS, buildMap } from './maps.js';
import { Physics } from './physics.js';
import { LocalPlayer } from './player.js';
import { Effects, Beam, loadExplosionImage } from './effects.js';
import { Net, RemotePlayers, friendlyError } from './network.js';
import * as ui from './ui.js';

const now = () => performance.now() / 1000;
const r3 = v => Math.round(v * 1000) / 1000;
const okVec = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const _tip = new THREE.Vector3(), _tip2 = new THREE.Vector3();

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  ui.fatal('webgl is not available in this browser, the game cannot start.');
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(ui.settings.fov, 1, 0.05, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);                                   // camera must be in the scene so the viewmodel renders
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- state
let game = null;           // active session or null
let locked = false;        // pointer lock
const keys = new Set();

// ---------------------------------------------------------------- boot: preload everything, never block on failures
async function boot() {
  audio.setVolume(ui.settings.volume);
  const models = [...new Set([...SPAWNABLES.map(s => s.glb).filter(Boolean), ...Object.values(ITEMS).map(i => i.glb), 'plr.glb'])];
  const jobs = [...TEXTURE_FILES.map(assets.loadTexture), ...models.map(assets.loadModel), ...SOUND_NAMES.map(audio.load), loadExplosionImage()];
  let done = 0;
  jobs.forEach(p => p.then(() => ui.setLoading(++done / jobs.length, `loading assets ${done}/${jobs.length}`)));
  await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 30000))]);   // hard cap, then go anyway
  ui.showTitle();
}

// ---------------------------------------------------------------- sessions
function pickSpawn(map) { return map.spawns[Math.floor(Math.random() * map.spawns.length)]; }

function startSession({ mode, mapId, net = null, name = 'player', code = '', welcome = null }) {
  endSession();
  const map = MAPS.find(m => m.id === mapId) || MAPS[0];
  const authority = mode !== 'client';
  const group = new THREE.Group();
  scene.add(group);
  scene.background = new THREE.Color(map.sky);
  scene.fog = new THREE.Fog(map.fog.color, map.fog.near, map.fog.far);

  const hemi = new THREE.HemisphereLight(map.hemi[0], map.hemi[1], map.hemi[2]);
  const sun = new THREE.DirectionalLight(map.sun, map.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 150 });
  sun.shadow.bias = -0.0004;
  group.add(hemi, sun, sun.target);

  const physics = new Physics(group, authority);
  buildMap(map, { group, physics });
  const player = new LocalPlayer(physics, camera);
  player.spawn(pickSpawn(map));
  player.onRespawn = () => player.spawn(pickSpawn(map));
  player.onHurt = () => ui.flashHurt();
  player.onDeath = () => { grabEnd(); clearGlueSel(); };
  const effects = new Effects(group);
  const remote = new RemotePlayers(group);
  const vm = new ViewModel(camera);

  game = { mode, map, group, sun, physics, player, effects, remote, vm, net, name, code, myProps: [], names: new Map(),
    paused: false, spawnHeld: false, tickAcc: 0, myId: welcome ? welcome.you : 0, lastHP: -1,
    inv: null, beams: new Map(), grab: null, grabTarget: null, glueSel: null, crowbarCd: 0 };
  const g = game;
  g.inv = new Inventory(onInvChange);

  if (authority) {
    physics.hooks.onSpawn = p => {
      handleSpawnFx(p);
      if (p.owner === 0) g.myProps.push(p.id);
      net?.broadcast({ t: 'spawned', id: p.id, key: p.key, p: [r3(p.body.position.x), r3(p.body.position.y), r3(p.body.position.z)],
        q: [r3(p.body.quaternion.x), r3(p.body.quaternion.y), r3(p.body.quaternion.z), r3(p.body.quaternion.w)], by: p.owner });
    };
    physics.hooks.onRemove = id => net?.broadcast({ t: 'removed', id });
    physics.hooks.onClear = () => { g.myProps.length = 0; net?.broadcast({ t: 'cleared' }); };
    physics.hooks.onThruster = (id, on) => { net?.broadcast({ t: 'thr', id, on }); };
    physics.hooks.onExplosion = (pos, ex) => {
      const e = { radius: ex.radius, force: ex.force, damage: ex.damage };
      handleExplosion(pos, e);
      net?.broadcast({ t: 'boom', p: [r3(pos.x), r3(pos.y), r3(pos.z)], ex: e });
    };
  }

  if (welcome) {   // late joiner: rebuild the current world
    for (const p of welcome.players) { g.names.set(p.id, p.name); if (p.id !== welcome.you) remote.add(p.id, p.name); }
    for (const p of welcome.props) { physics.spawnProp(p.key, p.p, 0, { id: p.id, quat: p.q, owner: -1, silent: true }); if (p.a) physics.setThruster(p.id, true); }
  }

  ui.showHUD(true);
  ui.setRoom(code);
  ui.setPlayers(1 + remote.map.size);
  ui.setHotbar(g.inv.list, g.inv.sel);
  audio.startAmbient();
  audio.unlock();
}

function endSession() {
  if (!game) return;
  const g = game;
  game = null;                          // handlers check this first, so late messages are ignored
  try { g.net?.close(); } catch (e) {}
  keys.clear();
  try { document.exitPointerLock?.(); } catch (e) {}
  audio.stopAmbient();
  g.remote.clear();
  g.vm.set(null); camera.remove(g.vm.root);
  scene.remove(g.group);
  g.group.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  scene.fog = null; scene.background = null;
  ui.setPrompt(null);
  ui.hideGameUI();
}

// ---------------------------------------------------------------- effects / fx
function handleExplosion(pos, ex) {
  const g = game; if (!g) return;
  g.effects.explosion(pos, ex.radius);
  audio.play('explosion', { at: pos, volume: 1 });
  const d = camera.position.distanceTo(new THREE.Vector3(pos.x, pos.y, pos.z));
  g.effects.shake = Math.max(g.effects.shake, Math.max(0, 1 - d / (ex.radius * 3)) * 0.6);
  g.player.applyBlast(pos, ex);
}
function handleSpawnFx(p) { audio.play('spawn', { at: p.body.position }); }

// ---------------------------------------------------------------- aiming + prop actions
function aim(reach = LIMITS.REACH) {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  return { dir, hit: game.physics.raycastRay(camera.position, dir, reach) };
}
const propAt = hit => (hit && hit.body.propId !== undefined) ? game.physics.props.get(hit.body.propId) : null;

function requestSpawn(key) {
  const g = game; if (!g || g.paused) return;
  const spec = getSpawnable(key); if (!spec) return;
  const { dir, hit } = aim();
  const hh = spec.shape === 'sphere' ? spec.size[0] : spec.size[1];
  let pos;
  if (hit) pos = [hit.point.x + hit.normal.x * (hh + 0.05), hit.point.y + hit.normal.y * (hh + 0.05), hit.point.z + hit.normal.z * (hh + 0.05)];
  else pos = [camera.position.x + dir.x * 4, camera.position.y + dir.y * 4, camera.position.z + dir.z * 4];
  if (g.mode === 'client') g.net.send({ t: 'spawn', key, p: pos, yaw: g.player.yaw });
  else if (!g.physics.spawnProp(key, pos, g.player.yaw, { owner: 0 })) ui.toast(`prop limit reached (${LIMITS.MAX_PROPS})`);
}

function removeById(id) {
  const g = game;
  if (g.mode === 'client') g.net.send({ t: 'remove', id }); else g.physics.removeProp(id);
}
function removeAimed() { const p = propAt(aim().hit); if (p) removeById(p.id); }
function undo() {
  const g = game;
  while (g.myProps.length) { const id = g.myProps.pop(); if (g.physics.props.has(id)) { removeById(id); return; } }
  ui.toast('nothing to undo');
}
function clearAll() {
  const g = game; if (!g) return;
  if (g.mode === 'client') g.net.send({ t: 'clear' }); else g.physics.clearProps();
}
function detonateAimed() {
  const g = game, p = propAt(aim().hit);
  if (!p?.spec.explosive) { ui.toast('aim at an explosive'); return; }
  if (g.mode === 'client') g.net.send({ t: 'det', id: p.id }); else g.physics.detonate(p.id);
}

// ---------------------------------------------------------------- E key: pick up / sit / thruster
function interactTarget() {
  const p = propAt(aim(IC.USE_REACH).hit);
  if (!p) return null;
  if (p.spec.item) return { prop: p, kind: 'item' };
  if (p.spec.thruster) return { prop: p, kind: 'thruster' };
  if (p.spec.seat) return { prop: p, kind: 'seat' };
  return null;
}
function giveItem(item) {
  if (!game || !ITEMS[item]) return;
  if (game.inv.add(item)) { audio.play('pickup'); ui.toast(`picked up: ${ITEMS[item].name}`); }
}
function toggleThruster(id) {
  const g = game;
  if (g.mode === 'client') g.net.send({ t: 'use', id }); else g.physics.toggleThruster(id);
  audio.play('thruster');
}
function useKey() {
  const g = game; if (!g || g.paused || g.player.dead) return;
  const t = interactTarget();
  if (g.player.seat) { if (t?.kind === 'thruster') toggleThruster(t.prop.id); else g.player.unseat(); return; }
  if (!t) return;
  if (t.kind === 'item') {
    const item = t.prop.spec.item;
    if (g.inv.has(item)) { ui.toast(`you already have the ${ITEMS[item].name.toLowerCase()}`); return; }
    if (g.mode === 'client') g.net.send({ t: 'use', id: t.prop.id });      // host removes it and sends us a 'give'
    else { g.physics.removeProp(t.prop.id); giveItem(item); }
  } else if (t.kind === 'seat') {
    if (!g.player.sit(t.prop)) ui.toast('that chair is tipped over');
  } else toggleThruster(t.prop.id);
}

// ---------------------------------------------------------------- items
function onInvChange() {
  const g = game; if (!g) return;
  const cur = g.inv.current;
  ui.setHotbar(g.inv.list, g.inv.sel);
  g.vm.set(cur);
  if (cur !== 'physgun') grabEnd();
  if (cur !== 'glue') clearGlueSel();
}

function primaryDown() {
  const g = game, it = g.inv.current;
  if (!it || g.player.dead) return;
  if (it === 'crowbar') crowbarSwing(); else if (it === 'physgun') grabStart(); else if (it === 'glue') glueClick();
}
function secondaryDown() {
  const g = game;
  if (g.inv.current === 'glue' && !g.player.dead) glueRight();
}

// --- crowbar
function rayHitPlayer(origin, dir, maxDist) {
  let best = null;
  for (const [id, r] of game.remote.map) {
    if (r.av.state === 'dead') continue;
    const p = r.av.group.position;
    for (const [cy, rad] of [[0.5, 0.5], [1.25, 0.45]]) {         // two spheres per player
      const ox = p.x - origin.x, oy = p.y + cy - origin.y, oz = p.z - origin.z;
      const tca = ox * dir.x + oy * dir.y + oz * dir.z;
      if (tca < 0) continue;
      const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
      if (d2 > rad * rad) continue;
      const t = tca - Math.sqrt(rad * rad - d2);
      if (t <= maxDist && (!best || t < best.dist)) best = { id, dist: Math.max(0, t) };
    }
  }
  return best;
}
function crowbarSwing() {
  const g = game, C = IC.CROWBAR;
  if (g.crowbarCd > 0) return;
  g.crowbarCd = C.COOLDOWN; g.vm.swingNow(); audio.play('swing');
  const { dir, hit } = aim(C.REACH);
  const ph = rayHitPlayer(camera.position, dir, C.REACH);
  const d = [dir.x, dir.y, dir.z];
  if (ph && (!hit || ph.dist < hit.dist)) {
    audio.play('hit');
    if (g.mode === 'client') g.net.send({ t: 'hit', target: ph.id, d }); else deliverHit(ph.id, d);
    return;
  }
  const p = propAt(hit);
  if (!p) return;
  audio.play('hit');
  if (g.mode === 'client') g.net.send({ t: 'melee', id: p.id, d }); else meleeProp(p.id, d);
}
function meleeProp(id, d) {           // authority: knock the prop back, set off explosives
  const g = game, p = g.physics.props.get(id);
  if (!p) return;
  g.physics.knockProp(id, { x: d[0], y: d[1], z: d[2] }, IC.CROWBAR.KNOCK);
  if (p.spec.explosive) g.physics.detonate(id);
}
function deliverHit(target, d) {      // host: route crowbar damage to the victim (damage amount is decided here, not by the client)
  const g = game; if (!g) return;
  if (target === 0) g.player.hurt(IC.CROWBAR.DAMAGE, d);
  else { const c = g.net?.clients.get(target); if (c) g.net.sendTo(c, { t: 'hurt', dmg: IC.CROWBAR.DAMAGE, d }); }
}

// --- physics gun
function grabStart() {
  const g = game, P = IC.PHYSGUN;
  const { hit } = aim(P.REACH), p = propAt(hit);
  if (!p) return;
  g.grab = { id: p.id, dist: clamp(hit.dist, P.MIN_DIST, P.MAX_DIST) };
  if (g.mode === 'client') g.net.send({ t: 'grab', id: p.id }); else g.physics.startGrab(0, p.id);
}
function grabEnd() {
  const g = game; if (!g || !g.grab) return;
  g.grab = null; g.grabTarget = null;
  if (g.mode === 'client') g.net.send({ t: 'rel' }); else g.physics.endGrab(0);
}
function updateGrab() {
  const g = game; if (!g.grab) return;
  if (!g.physics.props.has(g.grab.id) || g.player.dead) { grabEnd(); return; }
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const t = [camera.position.x + dir.x * g.grab.dist, camera.position.y + dir.y * g.grab.dist, camera.position.z + dir.z * g.grab.dist];
  if (g.mode === 'client') g.grabTarget = t; else g.physics.setGrabTarget(0, t);
}

// --- glue
function selectGlue(prop) {
  const g = game, helper = new THREE.BoxHelper(prop.mesh, 0x66ccff);
  g.group.add(helper);
  g.glueSel = { prop, helper };
}
function clearGlueSel() {
  const g = game; if (!g?.glueSel) return;
  g.group.remove(g.glueSel.helper); g.glueSel.helper.dispose?.(); g.glueSel = null;
}
function glueClick() {
  const g = game, p = propAt(aim(IC.GLUE_REACH).hit);
  if (!p) { ui.toast('aim at a prop'); return; }
  if (!g.glueSel) { selectGlue(p); audio.play('click'); ui.toast('now pick the second prop'); return; }
  if (g.glueSel.prop.id === p.id) { ui.toast('pick a different prop'); return; }
  const a = g.glueSel.prop.id;
  clearGlueSel();
  audio.play('glue');
  if (g.mode === 'client') g.net.send({ t: 'glue', a, b: p.id });
  else ui.toast(g.physics.glue(a, p.id) ? 'glued' : 'those are already glued');
}
function glueRight() {
  const g = game;
  if (g.glueSel) { clearGlueSel(); ui.toast('cancelled'); return; }
  const p = propAt(aim(IC.GLUE_REACH).hit);
  if (!p) return;
  if (g.mode === 'client') { g.net.send({ t: 'unglue', id: p.id }); ui.toast('unglued'); }
  else ui.toast(g.physics.unglue(p.id) ? 'unglued' : 'nothing glued to that');
}

// ---------------------------------------------------------------- network handlers
const updateCount = () => game && ui.setPlayers(1 + game.remote.map.size);
const netHandlers = {
  // ---- host side
  getWelcome() {
    const g = game; if (!g) return null;
    return {
      map: g.map.id,
      players: [{ id: 0, name: g.name }, ...[...g.net.clients.values()].map(c => ({ id: c.id, name: c.name }))],
      props: [...g.physics.props.values()].map(p => ({ id: p.id, key: p.key, a: p.active ? 1 : 0,
        p: [p.body.position.x, p.body.position.y, p.body.position.z],
        q: [p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w] })),
    };
  },
  onPlayerJoin(c) { const g = game; if (!g) return; g.names.set(c.id, c.name); g.remote.add(c.id, c.name); g.physics.addRemoteBody(c.id); ui.toast(`${c.name} joined`); updateCount(); },
  onPlayerLeave(c) { const g = game; if (!g) return; g.physics.endGrab(c.id); g.remote.remove(c.id); g.physics.removeRemoteBody(c.id); ui.toast(`${c.name} left`); updateCount(); },
  onClientState(c, m) {
    if (!game || !okVec(m.p) || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
    game.remote.push(c.id, m, now());
  },
  onSpawnReq(c, m) {
    const g = game; if (!g || typeof m.key !== 'string' || !okVec(m.p) || !Number.isFinite(m.yaw)) return;
    if (!g.physics.spawnProp(m.key, m.p, m.yaw, { owner: c.id })) g.net.sendTo(c, { t: 'toast', msg: 'prop limit reached' });
  },
  onRemoveReq(c, m) { game?.physics.removeProp(m.id); },
  onClearReq() { game?.physics.clearProps(); },
  onDetReq(c, m) { game?.physics.detonate(m.id); },
  onUseReq(c, m) {
    const g = game, p = g?.physics.props.get(m.id);
    if (!p) return;
    if (p.spec.item) { g.physics.removeProp(m.id); g.net.sendTo(c, { t: 'give', item: p.spec.item }); }
    else if (p.spec.thruster) g.physics.toggleThruster(m.id);
  },
  onGrabReq(c, m) { game?.physics.startGrab(c.id, m.id); },
  onGrabTarget(c, m) { if (okVec(m.p)) game?.physics.setGrabTarget(c.id, m.p); },
  onGrabRelease(c) { game?.physics.endGrab(c.id); },
  onMeleeReq(c, m) { if (game && okVec(m.d)) meleeProp(m.id, m.d); },
  onHitReq(c, m) { if (game && okVec(m.d)) deliverHit(m.target, m.d); },
  onGlueReq(c, m) { const g = game; if (g && g.physics.glue(m.a, m.b)) g.net.sendTo(c, { t: 'toast', msg: 'glued' }); },
  onUnglueReq(c, m) { game?.physics.unglue(m.id); },

  // ---- client side
  onSnap(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const t = now();
    for (const e of m.pl || []) {
      if (e[0] === g.myId) continue;
      if (!g.remote.map.has(e[0])) g.remote.add(e[0], g.names.get(e[0]) || 'player');
      g.remote.push(e[0], { p: [e[1], e[2], e[3]], yaw: e[4], pitch: e[5], an: e[6], it: e[7] || null, gr: e[8] || 0 }, t);
    }
    g.physics.applyPropStates(m.pr, t);
    updateCount();
  },
  onSpawned(m) {
    const g = game; if (!g || g.mode !== 'client') return;
    const p = g.physics.spawnProp(m.key, m.p, 0, { id: m.id, quat: m.q, owner: m.by, silent: true });
    if (!p) return;
    handleSpawnFx(p);
    if (m.by === g.myId) g.myProps.push(m.id);
  },
  onRemoved(m) { game?.physics.removeProp(m.id, true); },
  onCleared() { if (game) { game.physics.clearProps(); game.myProps.length = 0; } },
  onBoom(m) { if (game && okVec(m.p)) handleExplosion({ x: m.p[0], y: m.p[1], z: m.p[2] }, m.ex); },
  onThruster(m) { game?.physics.setThruster(m.id, !!m.on); },
  onGive(m) { giveItem(m.item); },
  onHurt(m) { if (game && Number.isFinite(m.dmg) && okVec(m.d)) game.player.hurt(m.dmg, m.d); },
  onJoin(m) { const g = game; if (!g) return; g.names.set(m.id, m.name); g.remote.add(m.id, m.name); ui.toast(`${m.name} joined`); updateCount(); },
  onLeave(m) { const g = game; if (!g) return; g.remote.remove(m.id); ui.toast(`${g.names.get(m.id) || 'player'} left`); updateCount(); },
  onToast(m) { ui.toast(String(m.msg)); },
  onDisconnect(reason) { if (!game) return; endSession(); ui.showTitle(reason); },
};

// ---------------------------------------------------------------- pointer lock, pause, input
function lock() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => ui.showLockHint(!!game && !game.paused));
  } catch (e) { ui.showLockHint(true); }
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  ui.showLockHint(!!game && !locked && !game.paused && !game.spawnHeld);
  if (game && !locked && !game.spawnHeld && !game.paused) pause();      // lost the lock (esc / alt-tab) -> pause menu
});
document.addEventListener('pointerlockerror', () => { if (game && !game.paused) ui.showLockHint(true); });
canvas.addEventListener('click', () => { if (game && !game.paused && !locked && !game.spawnHeld) lock(); });

function pause() {
  if (!game || game.paused) return;
  grabEnd();
  game.paused = true; keys.clear();
  ui.showLockHint(false); ui.showPause(true, game.code);
}
function resume() {
  if (!game) return;
  game.paused = false; ui.showPause(false); lock();
}
function openSpawnMenu() {
  const g = game; if (!g || g.paused || g.player.dead) return;
  g.spawnHeld = true; ui.openSpawn(); document.exitPointerLock();
}
function closeSpawnMenu(relock = true) {
  const g = game; if (!g || !g.spawnHeld) return;
  g.spawnHeld = false; ui.closeSpawn();
  if (relock && !g.paused) lock();
}

addEventListener('keydown', e => {
  if (!game) return;
  if (game.paused) { if (e.code === 'Escape') resume(); return; }
  if (keyIs(e.code, 'help')) { e.preventDefault(); if (!e.repeat) ui.toggleHelp(); return; }
  if (!locked && !game.spawnHeld) return;
  if (['Space', 'Tab'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (keyIs(e.code, 'spawnMenu') && locked) openSpawnMenu();
  else if (keyIs(e.code, 'use') && locked) useKey();
  else if (keyIs(e.code, 'remove')) removeAimed();
  else if (keyIs(e.code, 'undo')) undo();
  else if (keyIs(e.code, 'detonate')) detonateAimed();
  else if (keyIs(e.code, 'clearAll')) clearAll();
});
addEventListener('keyup', e => {
  keys.delete(e.code);
  if (game?.spawnHeld && keyIs(e.code, 'spawnMenu')) closeSpawnMenu();
});
addEventListener('blur', () => { keys.clear(); closeSpawnMenu(false); });
document.addEventListener('mousemove', e => {
  if (locked && game && !game.paused) game.player.look(e.movementX, e.movementY, 0.0022 * ui.settings.sens);
});
addEventListener('mousedown', e => {
  if (!locked || !game || game.paused) return;
  if (e.button === 0) primaryDown(); else if (e.button === 2) secondaryDown();
});
addEventListener('mouseup', e => { if (e.button === 0 && game?.grab) grabEnd(); });
addEventListener('contextmenu', e => { if (game) e.preventDefault(); });
addEventListener('wheel', e => {
  if (!game || game.paused || !locked) return;
  e.preventDefault();
  const dir = Math.sign(e.deltaY);
  if (game.grab) game.grab.dist = clamp(game.grab.dist - dir, IC.PHYSGUN.MIN_DIST, IC.PHYSGUN.MAX_DIST);   // physgun: scroll = distance
  else game.inv.cycle(dir > 0 ? 1 : -1);
}, { passive: false });
addEventListener('beforeunload', () => game?.net?.close());

// ---------------------------------------------------------------- ui wiring
ui.init({
  onStartSP(mapId) { startSession({ mode: 'sp', mapId }); lock(); },
  async onHost(mapId, name) {
    const net = new Net(netHandlers);
    try { const code = await net.host(name); startSession({ mode: 'host', mapId, net, name, code }); lock(); }
    catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  async onJoin(code, name) {
    const net = new Net(netHandlers);
    try { const w = await net.join(code, name); startSession({ mode: 'client', mapId: w.map, net, name, code: code.toUpperCase(), welcome: w }); lock(); }
    catch (e) { net.close(); throw new Error(friendlyError(e)); }
  },
  onResume: resume,
  onExit() { endSession(); ui.showTitle(); },
  onSettings() { camera.fov = ui.settings.fov; camera.updateProjectionMatrix(); audio.setVolume(ui.settings.volume); },
  onSpawnItem(id) { requestSpawn(id); },
  onClearAll() { clearAll(); },
  onLockClick() { lock(); },
});
camera.fov = ui.settings.fov; camera.updateProjectionMatrix();

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!game) return;
  update(dt);
  renderer.render(scene, camera);
}

function getBeam(key) {
  let b = game.beams.get(key);
  if (!b) { b = new Beam(game.group); game.beams.set(key, b); }
  return b;
}
function updateBeams(t) {
  const g = game;
  const mine = getBeam('me'), gp = g.grab ? g.physics.props.get(g.grab.id) : null;
  if (gp && g.inv.current === 'physgun' && !g.player.dead && g.vm.tip(_tip)) mine.update(_tip, gp.mesh.position, t); else mine.hide();
  for (const [id, r] of g.remote.map) {                     // everyone else's beams, from the item in their hand
    const b = getBeam(id), pr = r.grab ? g.physics.props.get(r.grab) : null;
    if (pr && r.av.itemTip(_tip2)) b.update(_tip2, pr.mesh.position, t); else b.hide();
  }
}
function updatePrompt() {
  const g = game;
  let text = null;
  if (locked && !g.paused && !g.spawnHeld && !g.player.dead) {
    const t = interactTarget(), k = ui.keyLabels('use');
    if (g.player.seat) text = t?.kind === 'thruster' ? `[${k}] toggle thruster` : `[${k}] stand up`;
    else if (t) text = t.kind === 'item' ? `[${k}] pick up ${ITEMS[t.prop.spec.item].name}` : t.kind === 'seat' ? `[${k}] sit` : `[${k}] toggle thruster`;
  }
  ui.setPrompt(text);
}

function update(dt) {
  const g = game, t = now();
  const sim = !(g.paused && g.mode === 'sp');      // singleplayer pause freezes the world, multiplayer cannot
  g.crowbarCd = Math.max(0, g.crowbarCd - dt);
  if (sim) {
    g.player.update(dt, keys, locked && !g.paused);
    g.physics.step(dt);
    if (g.mode === 'client') g.physics.updateClient(t - NET.INTERP_DELAY);
    g.remote.update(dt, t - NET.INTERP_DELAY);
    if (g.mode === 'host') for (const [id, r] of g.remote.map) g.physics.moveRemoteBody(id, r.av.group.position, dt);
  }
  g.player.placeCamera(dt);
  g.effects.update(dt);
  if (g.effects.shake > 0) {                          // blast shake
    const s = g.effects.shake * 0.12;
    camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s;
  }
  camera.updateMatrixWorld(true);
  audio.setListener(camera.position);

  const b = g.player.body, hs = Math.hypot(b.velocity.x, b.velocity.z);
  g.vm.update(dt, g.player.grounded ? hs : 0, !g.player.dead);
  updateGrab();
  updateBeams(t);
  if (g.glueSel) { if (!g.physics.props.has(g.glueSel.prop.id)) clearGlueSel(); else g.glueSel.helper.update(); }
  updatePrompt();

  // sun follows the player so shadows stay sharp
  const p = b.position;
  g.sun.position.set(p.x + 30, p.y + 50, p.z + 20);
  g.sun.target.position.set(p.x, p.y, p.z);

  // hud
  if (g.player.hp !== g.lastHP) { g.lastHP = g.player.hp; ui.setHP(g.player.hp, PLAYER.MAX_HP); }
  ui.setDeath(g.player.dead ? `you died. respawning in ${Math.max(1, Math.ceil(g.player.deathTimer))}` : null);

  // network tick
  if (g.net) {
    g.tickAcc += dt;
    if (g.tickAcc >= 1 / NET.TICK_RATE) {
      g.tickAcc = 0;
      const me = g.player.netState(), it = g.inv.current || '', gr = g.grab ? g.grab.id : 0;
      if (g.mode === 'host') {
        const pl = [[0, r3(me.p[0]), r3(me.p[1]), r3(me.p[2]), r3(me.yaw), r3(me.pitch), me.an, it, gr]];
        for (const c of g.net.clients.values()) {
          const s = c.state; if (!s) continue;
          pl.push([c.id, r3(s.p[0]), r3(s.p[1]), r3(s.p[2]), r3(s.yaw), r3(s.pitch), String(s.an), (typeof s.it === 'string' && ITEMS[s.it]) ? s.it : '', Number.isInteger(s.gr) ? s.gr : 0]);
        }
        g.net.broadcast({ t: 'snap', pl, pr: g.physics.collectDelta() });
      } else if (g.mode === 'client') {
        g.net.send({ t: 'st', p: me.p.map(r3), yaw: r3(me.yaw), pitch: r3(me.pitch), an: me.an, it, gr });
        if (g.grab && g.grabTarget) g.net.send({ t: 'gt', p: g.grabTarget.map(r3) });
        if (t - g.net.lastRecv > NET.HOST_TIMEOUT) netHandlers.onDisconnect('lost connection to the host');
      }
    }
  }
}

boot();
frame();
