// network.js - peerjs, host-authoritative. host = source of truth for props/explosions.
// players own their own movement and hp (not cheat-proof, see notes).
import { NET, PLAYER } from './config.js';
import { Avatar } from './player.js';
import { SnapshotBuffer } from './interp.js';

let PeerCtor = null;
// loaded lazily so singleplayer still works if the cdn is blocked
async function loadPeer() {
  if (PeerCtor) return PeerCtor;
  for (const src of ['peerjs', 'https://esm.sh/peerjs@1.5.4']) {
    try {
      const m = await import(src);
      const P = m.Peer || m.default?.Peer || m.default;
      if (typeof P === 'function') { PeerCtor = P; return P; }
    } catch (e) { console.warn('[net] could not load peerjs from', src, e); }
  }
  throw new Error('could not load peerjs from the cdn');
}

const peerOpts = () => ({ debug: 1, config: { iceServers: NET.ICE_SERVERS } });
const code5 = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
const cleanName = n => String(n || 'player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'player';

function openPeer(P, id) {
  return new Promise((res, rej) => {
    const peer = id ? new P(id, peerOpts()) : new P(peerOpts());
    const to = setTimeout(() => { try { peer.destroy(); } catch (e) {} rej(Object.assign(new Error('signaling server unreachable'), { type: 'timeout' })); }, NET.CONNECT_TIMEOUT);
    peer.on('open', () => { clearTimeout(to); res(peer); });
    peer.on('error', e => { clearTimeout(to); rej(e); });
  });
}

export function friendlyError(e) {
  switch (e?.type) {
    case 'peer-unavailable': return 'room not found. check the code.';
    case 'unavailable-id': return 'room code already taken, try again.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed': case 'timeout':
      return 'cannot reach the signaling server (or the host). check your connection.';
    case 'webrtc': return 'webrtc failed. a strict nat/firewall probably needs a turn server.';
  }
  return e?.message || 'connection failed';
}

export class Net {
  // h = handlers object (see main.js)
  constructor(h) {
    this.h = h; this.role = 'none'; this.peer = null; this.conn = null;
    this.clients = new Map();   // host: id -> {id, conn, name, state}
    this.nextId = 1; this.myId = 0; this.code = ''; this.connected = false; this.lastRecv = 0;
  }

  // ---------------- host
  async host(name) {
    this.role = 'host';
    const P = await loadPeer();
    let peer = null, code = '';
    for (let i = 0; i < 8 && !peer; i++) {
      code = code5();
      try { peer = await openPeer(P, NET.ROOM_PREFIX + code); }
      catch (e) { if (e.type !== 'unavailable-id') throw e; }
    }
    if (!peer) throw new Error('could not allocate a room code');
    this.peer = peer; this.code = code;
    peer.on('connection', conn => {
      conn.on('data', m => this._hostData(conn, m));
      conn.on('close', () => this._drop(conn));
      conn.on('error', () => this._drop(conn));
    });
    peer.on('error', e => console.warn('[net] peer error', e));
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });   // signaling dropped, existing links survive
    return code;
  }

  _hostData(conn, m) {
    if (!m || typeof m !== 'object') return;
    let c = conn._c;
    if (m.t === 'hello') {
      if (c) return;
      if (this.clients.size >= NET.MAX_PLAYERS - 1) { try { conn.send({ t: 'full' }); } catch (e) {} setTimeout(() => conn.close(), 200); return; }
      c = { id: this.nextId++, conn, name: cleanName(m.name), state: null };
      const w = this.h.getWelcome(c);
      if (!w) { conn.close(); return; }
      conn._c = c; this.clients.set(c.id, c);
      conn.send({ t: 'welcome', you: c.id, ...w });
      this.broadcast({ t: 'join', id: c.id, name: c.name }, conn);
      this.h.onPlayerJoin(c);
      return;
    }
    if (!c) return;
    const h = this.h;
    switch (m.t) {
      case 'st': c.state = m; h.onClientState(c, m); break;
      case 'spawn': h.onSpawnReq(c, m); break;
      case 'remove': h.onRemoveReq(c, m); break;
      case 'clear': h.onClearReq(c, m); break;
      case 'det': h.onDetReq(c, m); break;
      case 'use': h.onUseReq(c, m); break;
      case 'grab': h.onGrabReq(c, m); break;
      case 'gt': h.onGrabTarget(c, m); break;
      case 'rel': h.onGrabRelease(c, m); break;
      case 'melee': h.onMeleeReq(c, m); break;
      case 'hit': h.onHitReq(c, m); break;
      case 'glue': h.onGlueReq(c, m); break;
      case 'unglue': h.onUnglueReq(c, m); break;
    }
  }

  _drop(conn) {
    const c = conn._c;
    if (!c) return;
    conn._c = null; this.clients.delete(c.id);
    this.broadcast({ t: 'leave', id: c.id });
    this.h.onPlayerLeave(c);
  }

  broadcast(msg, except = null) {
    for (const c of this.clients.values()) if (c.conn !== except && c.conn.open) { try { c.conn.send(msg); } catch (e) {} }
  }
  sendTo(c, msg) { try { if (c.conn.open) c.conn.send(msg); } catch (e) {} }

  // ---------------- client
  async join(code, name) {
    this.role = 'client';
    const P = await loadPeer();
    const peer = await openPeer(P);
    this.peer = peer;
    const conn = peer.connect(NET.ROOM_PREFIX + code.trim().toUpperCase(), { reliable: true, serialization: 'json' });
    this.conn = conn;
    const welcome = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(Object.assign(new Error('timed out. host unreachable (strict nat?)'), { type: 'timeout' })), NET.CONNECT_TIMEOUT);
      const fail = e => { clearTimeout(to); rej(e); };
      peer.on('error', fail);
      conn.on('error', fail);
      conn.on('open', () => conn.send({ t: 'hello', name: cleanName(name) }));
      conn.on('close', () => { if (!this.connected) fail(new Error('host closed the connection')); else this.h.onDisconnect('host disconnected'); });
      conn.on('data', m => {
        if (m && m.t === 'welcome') { clearTimeout(to); this.connected = true; this.myId = m.you; this.lastRecv = performance.now() / 1000; res(m); }
        else if (m && m.t === 'full') fail(new Error('room is full'));
        else if (this.connected) this._clientData(m);
      });
    });
    peer.on('error', e => { if (this.connected) this.h.onDisconnect('connection error: ' + friendlyError(e)); });
    return welcome;
  }

  _clientData(m) {
    if (!m || typeof m !== 'object') return;
    this.lastRecv = performance.now() / 1000;
    const h = this.h;
    switch (m.t) {
      case 'snap': h.onSnap(m); break;
      case 'spawned': h.onSpawned(m); break;
      case 'removed': h.onRemoved(m); break;
      case 'cleared': h.onCleared(m); break;
      case 'boom': h.onBoom(m); break;
      case 'thr': h.onThruster(m); break;
      case 'give': h.onGive(m); break;
      case 'hurt': h.onHurt(m); break;
      case 'join': h.onJoin(m); break;
      case 'leave': h.onLeave(m); break;
      case 'toast': h.onToast(m); break;
      case 'bye': h.onDisconnect('host disconnected'); break;
    }
  }
  send(msg) { try { if (this.conn?.open) this.conn.send(msg); } catch (e) {} }

  close() {
    const peer = this.peer;
    if (this.role === 'host') this.broadcast({ t: 'bye' });
    this.connected = false; this.role = 'none'; this.clients.clear(); this.peer = null; this.conn = null;
    if (peer) setTimeout(() => { try { peer.destroy(); } catch (e) {} }, 150);   // let 'bye' flush first
  }
}

// ---------------------------------------------------------------- remote players
export class RemotePlayers {
  constructor(parent) { this.parent = parent; this.map = new Map(); }

  add(id, name) {
    if (this.map.has(id)) return;
    const av = new Avatar(name);
    this.parent.add(av.group);
    this.map.set(id, { id, name, av, buf: new SnapshotBuffer(), grab: 0 });
  }
  remove(id) { const r = this.map.get(id); if (r) { r.av.dispose(); this.map.delete(id); } }
  push(id, st, t) {
    const r = this.map.get(id);
    if (r) r.buf.push(t, st.p, null, { yaw: st.yaw, pitch: st.pitch, state: st.an, item: typeof st.it === 'string' ? st.it : null, grab: Number.isInteger(st.gr) ? st.gr : 0 });
  }

  update(dt, renderTime) {
    for (const r of this.map.values()) {
      const s = r.buf.sample(renderTime);
      if (!s) continue;
      r.av.group.position.set(s.p[0], s.p[1], s.p[2]);
      r.av.group.rotation.y = s.ex.yaw + PLAYER.MODEL_YAW_OFFSET;
      r.av.setState(s.ex.state);
      r.av.holdItem(s.ex.item);
      r.grab = s.ex.grab;
      r.av.update(dt);
    }
  }
  clear() { for (const id of [...this.map.keys()]) this.remove(id); }
}
