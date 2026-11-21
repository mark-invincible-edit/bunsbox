// builder.js - in-browser map editor. renders into the shared canvas. the map is plain json (.bm).
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { TEXTURE_FILES } from './config.js';
import { SPAWNABLES, getSpawnable } from './spawnables.js';
import { buildVisual } from './physics.js';
import { makeLabel } from './assets.js';
import { ENVS, ENV_LABELS, MAPLIM, normalizeMap, normalizePart, parseMap, partMesh, partMaterial, propAllowed } from './mapfile.js';

const D2R = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;
const r2 = v => Math.round(v * 100) / 100;
const KEY = 'bunsbox.builder';
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const row = (label, ...c) => el('label', { className: 'bd-row' }, el('span', { textContent: label }), ...c);
const slug = s => (s || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
const clone = o => JSON.parse(JSON.stringify(o));

export class Builder {
  // hooks: { onExit(), onTest(bm) }
  constructor(renderer, canvas, hooks) {
    this.renderer = renderer; this.canvas = canvas; this.hooks = hooks;
    this.active = false; this.loaded = false; this.ents = []; this.sel = null; this.nextId = 1;
    this.keys = new Set(); this.yaw = -0.6; this.pitch = -0.5; this.looking = false; this.snap = true; this.dragging = false; this.dn = null;
    this.prevScale = new THREE.Vector3(1, 1, 1);
    this.meta = { name: 'my map', description: '', author: '' };
    this.env = clone(ENVS.day);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(14, 12, 18);
    this.root = new THREE.Group();
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.position.set(30, 50, 20);
    const grid = new THREE.GridHelper(200, 100, 0x88aaff, 0x445066);
    grid.material.transparent = true; grid.material.opacity = 0.35;
    this.hl = new THREE.BoxHelper(new THREE.Object3D(), 0xffcc00);
    this.hl.visible = false;
    this.scene.add(this.root, this.hemi, this.sun, grid, this.hl);

    this.tc = new TransformControls(this.camera, canvas);
    this.scene.add(this.tc.getHelper ? this.tc.getHelper() : this.tc);
    this.tc.addEventListener('dragging-changed', e => { this.dragging = e.value; if (!e.value) this._afterDrag(); });
    this.tc.addEventListener('objectChange', () => this._onChange());
    this._applySnap();

    this._kd = e => this._keydown(e); this._ku = e => { this.keys.delete(e.code); };
    this._md = e => this._down(e); this._mu = e => this._up(e);
    this._mm = e => this._move(e); this._wh = e => this._wheel(e); this._cm = e => e.preventDefault();
    this._bl = () => this.keys.clear();
    this._buildUI();
  }

  // ------------------------------------------------------------ lifecycle
  open(bm) {
    this.active = true; this.ui.hidden = false; this.tc.enabled = true;
    if (bm) this._replace(bm);
    else if (!this.loaded) this._replace(this._restore() || this._blank());
    this.loaded = true;
    addEventListener('keydown', this._kd); addEventListener('keyup', this._ku); addEventListener('blur', this._bl);
    this.canvas.addEventListener('mousedown', this._md); addEventListener('mouseup', this._mu);
    document.addEventListener('mousemove', this._mm);
    this.canvas.addEventListener('wheel', this._wh, { passive: false });
    this.canvas.addEventListener('contextmenu', this._cm);
  }
  close() {
    this.active = false; this.ui.hidden = true; this.tc.enabled = false; this.tc.detach(); this.hl.visible = false;
    removeEventListener('keydown', this._kd); removeEventListener('keyup', this._ku); removeEventListener('blur', this._bl);
    this.canvas.removeEventListener('mousedown', this._md); removeEventListener('mouseup', this._mu);
    document.removeEventListener('mousemove', this._mm);
    this.canvas.removeEventListener('wheel', this._wh); this.canvas.removeEventListener('contextmenu', this._cm);
    this.keys.clear(); this.looking = false;
    try { document.exitPointerLock?.(); } catch (e) {}
    this._saveNow();
  }

  // ------------------------------------------------------------ data
  _blank() {
    return normalizeMap({ format: 'bunsbox-map', version: 1, meta: { name: 'my map', author: '', description: '' }, env: ENVS.day,
      parts: [{ shape: 'box', pos: [0, -1, 0], size: [100, 2, 100], tex: 'grassground.png', tile: 5, anchored: true, collide: true }], props: [], spawns: [[0, 2, 0]] });
  }
  _replace(bm) {
    this.select(null);
    for (const e of this.ents) this.root.remove(e.obj);
    this.ents = [];
    this.meta = { ...bm.meta }; this.env = clone(bm.env);
    for (const p of bm.parts) this._mkPart(p);
    for (const p of bm.props) this._mkProp(p);
    for (const s of bm.spawns) this._mkSpawn(s);
    this._applyEnv(); this._count();
  }
  toBM() {
    const parts = [], props = [], spawns = [];
    for (const e of this.ents) {
      const o = e.obj, pos = [r2(o.position.x), r2(o.position.y), r2(o.position.z)], rot = [r2(R2D(o.rotation.x)), r2(R2D(o.rotation.y)), r2(R2D(o.rotation.z))];
      if (e.kind === 'part') parts.push({ ...e.data, pos, rot, size: [r2(o.scale.x), r2(o.scale.y), r2(o.scale.z)] });
      else if (e.kind === 'prop') props.push({ key: e.data.key, pos, rot, anchored: e.data.anchored, mass: e.data.mass, damage: e.data.damage, bouncy: e.data.bouncy });
      else spawns.push(pos);
    }
    return { format: 'bunsbox-map', version: 1, meta: { ...this.meta }, env: this.env, parts, props, spawns };
  }
  _save() { clearTimeout(this._st); this._st = setTimeout(() => this._saveNow(), 500); }
  _saveNow() { clearTimeout(this._st); try { localStorage.setItem(KEY, JSON.stringify(this.toBM())); } catch (e) {} }
  _restore() { try { const t = localStorage.getItem(KEY); return t ? parseMap(t) : null; } catch (e) { return null; } }

  _applyEnv() {
    const e = this.env;
    this.scene.background = new THREE.Color(e.sky);
    this.hemi.color.set(e.hemi[0]); this.hemi.groundColor.set(e.hemi[1]); this.hemi.intensity = e.hemi[2];
    this.sun.color.set(e.sun); this.sun.intensity = e.sunI;
    this.envSel.value = Object.keys(ENVS).find(k => JSON.stringify(ENVS[k]) === JSON.stringify(e)) || 'custom';
  }

  // ------------------------------------------------------------ entities
  _reg(kind, data, obj) {
    const e = { id: this.nextId++, kind, data, obj };
    obj.userData.eid = e.id;
    this.root.add(obj); this.ents.push(e);
    return e;
  }
  _mkPart(p) {
    const n = normalizePart(p), m = partMesh(n);
    m.position.set(...n.pos); m.rotation.set(D2R(n.rot[0]), D2R(n.rot[1]), D2R(n.rot[2]));
    return this._reg('part', n, m);
  }
  _mkProp(p) {
    const spec = getSpawnable(p.key), g = buildVisual(spec, null);
    g.position.set(...p.pos); g.rotation.set(D2R(p.rot[0]), D2R(p.rot[1]), D2R(p.rot[2]));
    return this._reg('prop', { key: p.key, anchored: !!p.anchored, mass: p.mass, damage: p.damage, bouncy: !!p.bouncy }, g);
  }
  _mkSpawn(pos) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 16), new THREE.MeshBasicMaterial({ color: 0x4cc26a }));
    cone.rotation.x = Math.PI; cone.position.y = 0.5;
    const lab = makeLabel('spawn', { font: 36, scale: 0.0025 }); lab.position.y = 1.5;
    g.add(cone, lab); g.position.set(...pos);
    return this._reg('spawn', {}, g);
  }

  _spot(lift = 0.5) {                                   // where new things appear: what you look at, else the ground, else 10m ahead
    const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
    const ray = new THREE.Raycaster(this.camera.position.clone(), dir);
    ray.camera = this.camera;                            // sprites (spawn labels, prop labels) need it or raycasting throws
    const hit = ray.intersectObjects(this.root.children, true).find(h => !h.object.isSprite);
    let p;
    if (hit) p = hit.point.clone();
    else if (dir.y < -0.01) p = this.camera.position.clone().addScaledVector(dir, -this.camera.position.y / dir.y);
    else p = this.camera.position.clone().addScaledVector(dir, 10);
    const s = this.snap ? 0.5 : 0.01;
    return [Math.round(p.x / s) * s, Math.round((p.y + lift) / s) * s, Math.round(p.z / s) * s];
  }
  _count() {
    const parts = this.ents.filter(e => e.kind === 'part').length, props = this.ents.filter(e => e.kind === 'prop').length;
    this.countEl.textContent = `parts ${parts}/${MAPLIM.PARTS}  props ${props}/${MAPLIM.PROPS}`;
  }
  say(msg) { this.toastEl.textContent = msg; this.toastEl.hidden = false; clearTimeout(this._tt); this._tt = setTimeout(() => { this.toastEl.hidden = true; }, 2500); }

  _addPart(shape) {
    if (this.ents.filter(e => e.kind === 'part').length >= MAPLIM.PARTS) { this.say(`part limit reached (${MAPLIM.PARTS})`); return; }
    const size = shape === 'sphere' ? [2, 2, 2] : [4, 1, 4];
    const e = this._mkPart({ shape, pos: this._spot(size[1] / 2), rot: [0, 0, 0], size, tex: 'concretewall.png', color: '#ffffff', tile: 4, anchored: true, collide: true, mass: 10, damage: 0, bouncy: false });
    this.select(e); this._save(); this._count();
  }
  _addProp() {
    if (this.ents.filter(e => e.kind === 'prop').length >= MAPLIM.PROPS) { this.say(`prop limit reached (${MAPLIM.PROPS})`); return; }
    const s = getSpawnable(this.propSel.value);
    if (!propAllowed(s)) return;
    const e = this._mkProp({ key: s.id, pos: this._spot(0.5), rot: [0, 0, 0], anchored: false, mass: s.mass, damage: 0, bouncy: !!s.bouncy });
    this.select(e); this._save(); this._count();
  }
  _addSpawn() {
    if (this.ents.filter(e => e.kind === 'spawn').length >= MAPLIM.SPAWNS) { this.say(`spawn limit reached (${MAPLIM.SPAWNS})`); return; }
    const e = this._mkSpawn(this._spot(0)); this.select(e); this._save();
  }
  _delete() {
    const e = this.sel; if (!e) return;
    this.select(null); this.root.remove(e.obj); this.ents.splice(this.ents.indexOf(e), 1);
    this._save(); this._count();
  }
  _duplicate() {
    const e = this.sel; if (!e) return;
    const o = e.obj, pos = [o.position.x + 1, o.position.y, o.position.z + 1], rot = [R2D(o.rotation.x), R2D(o.rotation.y), R2D(o.rotation.z)];
    let n;
    if (e.kind === 'part') n = this._mkPart({ ...e.data, pos, rot, size: [o.scale.x, o.scale.y, o.scale.z] });
    else if (e.kind === 'prop') n = this._mkProp({ ...e.data, pos, rot });
    else n = this._mkSpawn(pos);
    this.select(n); this._save(); this._count();
  }
  _focus() {
    const e = this.sel; if (!e) return;
    const d = new THREE.Vector3(); this.camera.getWorldDirection(d);
    const r = new THREE.Box3().setFromObject(e.obj).getBoundingSphere(new THREE.Sphere()).radius;
    this.camera.position.copy(e.obj.position).addScaledVector(d, -(Math.max(r, 0.5) * 3 + 2));
  }

  // ------------------------------------------------------------ selection + gizmo
  select(e) {
    this.sel = e || null;
    if (e) {
      this.tc.attach(e.obj); this.hl.setFromObject(e.obj); this.hl.visible = true; this.prevScale.copy(e.obj.scale);
      if (e.kind !== 'part' && this.tc.mode === 'scale') this._mode('translate');
    } else { this.tc.detach(); this.hl.visible = false; }
    this._panel();
  }
  _mode(m) {
    if (m === 'scale' && (!this.sel || this.sel.kind !== 'part')) return;
    this.tc.setMode(m);
    for (const k in this.modeBtns) this.modeBtns[k].classList.toggle('on', k === m);
  }
  _applySnap() {
    this.tc.setTranslationSnap(this.snap ? 0.5 : null);
    this.tc.setRotationSnap(this.snap ? D2R(15) : null);
    this.tc.setScaleSnap(this.snap ? 0.25 : null);
  }
  _refresh(e) {
    if (e.kind !== 'part') return;
    const s = e.obj.scale;
    e.data.size = e.data.shape === 'sphere' ? [s.x, s.x, s.x] : [s.x, s.y, s.z];
    e.obj.material = partMaterial(e.data);                 // retile the texture for the new size
  }
  _afterDrag() { if (this.sel) this._refresh(this.sel); this._save(); }
  _onChange() {
    const e = this.sel; if (!e) return;
    if (e.kind === 'part') {
      const s = e.obj.scale, pv = this.prevScale;
      if (e.data.shape === 'sphere') { let k = s.x; if (Math.abs(s.y - pv.y) > 1e-6) k = s.y; else if (Math.abs(s.z - pv.z) > 1e-6) k = s.z; s.setScalar(Math.max(0.1, k)); }
      else s.set(Math.max(0.1, s.x), Math.max(0.1, s.y), Math.max(0.1, s.z));
      this.prevScale.copy(s);
    }
    this.hl.setFromObject(e.obj);
    this._syncPanel();
  }
  _syncPanel() {
    const e = this.sel, f = this.f; if (!e || !f) return;
    const o = e.obj, rot = [o.rotation.x, o.rotation.y, o.rotation.z];
    f.pos.forEach((i, k) => { i.value = r2(o.position.getComponent(k)); });
    f.rot.forEach((i, k) => { i.value = r2(R2D(rot[k])); });
    f.size.forEach((i, k) => { i.value = r2(o.scale.getComponent(e.data.shape === 'sphere' ? 0 : k)); });
  }

  // ------------------------------------------------------------ input
  _keydown(e) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey) { if (e.code === 'KeyD') { e.preventDefault(); this._duplicate(); } return; }
    this.keys.add(e.code);
    switch (e.code) {
      case 'Digit1': this._mode('translate'); break;
      case 'Digit2': this._mode('rotate'); break;
      case 'Digit3': this._mode('scale'); break;
      case 'KeyF': this._focus(); break;
      case 'KeyG': this.snap = !this.snap; this.snapBox.checked = this.snap; this._applySnap(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); this._delete(); break;
      case 'Escape': this.select(null); break;
    }
  }
  _down(e) {
    if (e.button === 2) { this.looking = true; this.canvas.requestPointerLock?.(); }
    else if (e.button === 0) this.dn = { x: e.clientX, y: e.clientY, gizmo: this.tc.axis !== null };
  }
  _up(e) {
    if (e.button === 2 && this.looking) { this.looking = false; try { document.exitPointerLock?.(); } catch (er) {} return; }
    if (e.button !== 0 || !this.dn) return;
    const d = this.dn; this.dn = null;
    if (!d.gizmo && !this.dragging && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) this.select(this._pick(e));
  }
  _move(e) {
    if (!this.looking || document.pointerLockElement !== this.canvas) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0025));
  }
  _wheel(e) {
    e.preventDefault();
    const d = new THREE.Vector3(); this.camera.getWorldDirection(d);
    this.camera.position.addScaledVector(d, -Math.sign(e.deltaY) * 2);
  }
  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    for (const h of ray.intersectObjects(this.root.children, true)) {
      let o = h.object;
      while (o && o.userData.eid === undefined) o = o.parent;
      if (o) return this.ents.find(x => x.id === o.userData.eid) || null;
    }
    return null;
  }

  update(dt) {
    const c = this.camera, asp = innerWidth / innerHeight;
    if (c.aspect !== asp) { c.aspect = asp; c.updateProjectionMatrix(); }
    const k = this.keys, s = (k.has('ShiftLeft') || k.has('ShiftRight') ? 30 : 10) * dt;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    const cp = Math.cos(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    c.position.x += (-sy * cp * f + cy * r) * s;
    c.position.y += (Math.sin(this.pitch) * f + u) * s;
    c.position.z += (-cy * cp * f - sy * r) * s;
    c.rotation.set(this.pitch, this.yaw, 0);
    if (this.sel) this.hl.setFromObject(this.sel.obj);
  }

  // ------------------------------------------------------------ ui
  _buildUI() {
    const ui = this.ui = document.getElementById('builder');
    ui.textContent = '';
    const btn = (text, fn, cls = '') => { const b = el('button', { type: 'button', textContent: text, className: cls }); b.addEventListener('click', fn); return b; };

    // top bar
    const top = el('div', { id: 'bd-top' });
    this.modeBtns = {};
    for (const [m, label] of [['translate', 'move (1)'], ['rotate', 'rotate (2)'], ['scale', 'scale (3)']]) { const b = btn(label, () => this._mode(m)); this.modeBtns[m] = b; top.append(b); }
    this.modeBtns.translate.classList.add('on');
    this.snapBox = el('input', { type: 'checkbox', checked: true });
    this.snapBox.addEventListener('change', () => { this.snap = this.snapBox.checked; this._applySnap(); });
    this.envSel = el('select');
    for (const k of Object.keys(ENVS)) this.envSel.append(el('option', { value: k, textContent: ENV_LABELS[k] }));
    this.envSel.append(el('option', { value: 'custom', textContent: 'custom (from file)' }));
    this.envSel.addEventListener('change', () => { if (this.envSel.value !== 'custom') { this.env = clone(ENVS[this.envSel.value]); this._applyEnv(); this._save(); } });
    this.file = el('input', { type: 'file', accept: '.bm,.json,application/json', hidden: true });
    this.file.addEventListener('change', async () => {
      const f = this.file.files[0]; this.file.value = '';
      if (!f) return;
      try { if (f.size > 2e6) throw new Error('file too big (2mb max)'); this._replace(parseMap(await f.text())); this._save(); this.say(`imported "${this.meta.name}"`); }
      catch (err) { this.say(err.message); }
    });
    top.append(
      el('label', { className: 'bd-inline' }, this.snapBox, ' snap (G)'),
      el('label', { className: 'bd-inline' }, 'sky ', this.envSel),
      btn('new', () => { if (confirm('discard the current map and start a new one?')) { this._replace(this._blank()); this._save(); } }),
      btn('import', () => this.file.click()),
      btn('export .bm', () => this._exportDialog(), 'primary'),
      btn('test play', () => { try { this.hooks.onTest(normalizeMap(this.toBM())); } catch (e) { this.say(e.message); } }),
      btn('exit', () => this.hooks.onExit()),
      this.file);

    // left: add things
    const left = this.left = el('div', { id: 'bd-left' });
    this.propSel = el('select');
    const groups = new Map();
    for (const s of SPAWNABLES) if (propAllowed(s)) { if (!groups.has(s.category)) groups.set(s.category, el('optgroup', { label: s.category })); groups.get(s.category).append(el('option', { value: s.id, textContent: s.name })); }
    for (const g of groups.values()) this.propSel.append(g);
    this.countEl = el('p', { className: 'bd-dim' });
    left.append(el('h3', { textContent: 'add' }), btn('+ block', () => this._addPart('box')), btn('+ sphere', () => this._addPart('sphere')), btn('+ spawn point', () => this._addSpawn()),
      el('hr'), this.propSel, btn('+ prop', () => this._addProp()), this.countEl);

    this.right = el('div', { id: 'bd-right' });
    this.toastEl = el('div', { id: 'bd-toast', hidden: true });
    const help = el('div', { id: 'bd-help', textContent: 'right-click + drag: look - WASD fly - Q/E down/up - shift: fast - scroll: zoom - click: select - F: focus - Del: delete - Ctrl+D: duplicate' });

    // export dialog
    const name = el('input', { maxLength: 60 }), author = el('input', { maxLength: 40 }), desc = el('textarea', { maxLength: 400, rows: 3 });
    const dlg = this.dlg = el('div', { id: 'bd-export', className: 'overlay', hidden: true });
    const form = el('form', { className: 'panel stack' },
      el('h2', { textContent: 'export map' }), row('name', name), row('author', author), row('description', desc),
      btn('download .bm', () => {}, 'primary'), btn('cancel', () => { dlg.hidden = true; }));
    form.querySelector('.primary').type = 'submit';
    form.addEventListener('submit', e => {
      e.preventDefault();
      const bm = normalizeMap({ ...this.toBM(), meta: { name: name.value, author: author.value, description: desc.value } });
      this.meta = bm.meta;
      const url = URL.createObjectURL(new Blob([JSON.stringify(bm, null, 1)], { type: 'application/json' }));
      const a = el('a', { href: url, download: `${slug(bm.meta.name)}.bm` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      dlg.hidden = true; this._save(); this.say('exported');
    });
    dlg.append(form);
    this._fill = () => { name.value = this.meta.name; author.value = this.meta.author === 'unknown' ? '' : this.meta.author; desc.value = this.meta.description; };

    ui.append(top, left, this.right, help, this.toastEl, dlg);
    this._panel();
  }
  _exportDialog() { this._fill(); this.dlg.hidden = false; }

  _panel() {
    const p = this.right;
    p.textContent = ''; this.f = null;
    p.append(el('h3', { textContent: 'properties' }));
    const e = this.sel;
    if (!e) { p.append(el('p', { className: 'bd-dim', textContent: 'nothing selected. click an object, or add one on the left.' })); return; }
    const o = e.obj, d = e.data, f = this.f = { pos: [], rot: [], size: [] };
    const rot = k => [o.rotation.x, o.rotation.y, o.rotation.z][k];
    const v3 = (label, arr, get, set, step, min) => {
      const w = el('div', { className: 'bd-v3' });
      for (let k = 0; k < 3; k++) {
        const i = el('input', { type: 'number', step, value: r2(get(k)) });
        i.addEventListener('input', () => { const v = parseFloat(i.value); if (!Number.isFinite(v)) return; set(k, min === undefined ? v : Math.max(min, v)); this.hl.setFromObject(o); this._save(); });
        i.addEventListener('change', () => this._afterDrag());
        arr.push(i); w.append(i);
      }
      return row(label, w);
    };
    const num = (label, key, min, max, step, refresh) => {
      const i = el('input', { type: 'number', step, value: d[key] });
      i.addEventListener('input', () => { const v = parseFloat(i.value); if (!Number.isFinite(v)) return; d[key] = Math.min(max, Math.max(min, v)); if (refresh) this._refresh(e); this._save(); });
      return row(label, i);
    };
    const chk = (label, key) => {
      const c = el('input', { type: 'checkbox', checked: !!d[key] });
      c.addEventListener('change', () => { d[key] = c.checked; this._save(); });
      return row(label, c);
    };

    p.append(el('p', { className: 'bd-dim', textContent: e.kind === 'part' ? `${d.shape} part` : e.kind === 'prop' ? `prop: ${getSpawnable(d.key).name}` : 'player spawn point' }));
    p.append(v3('position', f.pos, k => o.position.getComponent(k), (k, v) => o.position.setComponent(k, v), 0.5));
    p.append(v3('rotation°', f.rot, k => R2D(rot(k)), (k, v) => { const r = [o.rotation.x, o.rotation.y, o.rotation.z]; r[k] = D2R(v); o.rotation.set(...r); }, 15));

    if (e.kind === 'part') {
      if (d.shape === 'sphere') {
        const i = el('input', { type: 'number', step: 0.5, value: r2(o.scale.x) });
        f.size.push(i);
        i.addEventListener('input', () => { const v = parseFloat(i.value); if (Number.isFinite(v)) { o.scale.setScalar(Math.max(0.1, v)); this.hl.setFromObject(o); this._save(); } });
        i.addEventListener('change', () => this._afterDrag());
        p.append(row('diameter', i));
      } else p.append(v3('size', f.size, k => o.scale.getComponent(k), (k, v) => o.scale.setComponent(k, v), 0.5, 0.1));
      const tex = el('select');
      tex.append(el('option', { value: '', textContent: '(none)' }), ...TEXTURE_FILES.map(t => el('option', { value: t, textContent: t.replace('.png', ''), selected: d.tex === t })));
      tex.addEventListener('change', () => { d.tex = tex.value || null; this._refresh(e); this._save(); });
      const col = el('input', { type: 'color', value: d.color });
      col.addEventListener('input', () => { d.color = col.value; this._refresh(e); this._save(); });
      p.append(row('texture', tex), row('tint', col), num('tile size (m)', 'tile', 0.25, 100, 0.25, true), chk('anchored (fixed in place)', 'anchored'), chk('collides (if anchored)', 'collide'),
        num('mass (if loose)', 'mass', 0.1, 100000, 1), num('contact damage', 'damage', 0, 1000, 5), chk('bouncy', 'bouncy'));
    } else if (e.kind === 'prop') {
      p.append(chk('anchored (fixed in place)', 'anchored'), num('mass', 'mass', 0.1, 100000, 1), num('contact damage', 'damage', 0, 1000, 5), chk('bouncy', 'bouncy'));
    }
    const mk = (t, fn) => { const b = el('button', { type: 'button', textContent: t }); b.addEventListener('click', fn); return b; };
    p.append(el('div', { className: 'bd-btns' }, mk('duplicate', () => this._duplicate()), mk('focus', () => this._focus()), mk('delete', () => this._delete())));
  }
}
