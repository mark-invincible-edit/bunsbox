// interp.js - tiny snapshot buffer for smooth remote movement.
export function lerpAngle(a, b, t) {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}

export class SnapshotBuffer {
  constructor(max = 16) { this.s = []; this.max = max; }

  // t: local arrival time in seconds, p: [x,y,z], q: [x,y,z,w]|null, ex: {yaw,pitch,...}|null
  push(t, p, q = null, ex = null) {
    const s = this.s;
    if (s.length && t <= s[s.length - 1].t) t = s[s.length - 1].t + 1e-4;
    s.push({ t, p, q, ex });
    if (s.length > this.max) s.shift();
  }

  // state at render time rt (holds the last sample if rt is past the newest one)
  sample(rt) {
    const s = this.s;
    if (!s.length) return null;
    const last = s[s.length - 1];
    if (rt >= last.t || s.length === 1) return { p: last.p, q: last.q, ex: last.ex };
    if (rt <= s[0].t) return { p: s[0].p, q: s[0].q, ex: s[0].ex };
    let i = s.length - 2;
    while (i > 0 && s[i].t > rt) i--;
    const a = s[i], b = s[i + 1], k = (rt - a.t) / (b.t - a.t);
    const p = [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k];
    let q = b.q;
    if (a.q && b.q) {                       // nlerp is plenty for 50ms steps
      const dot = a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3];
      const sg = dot < 0 ? -1 : 1;
      q = a.q.map((v, n) => v + (sg * b.q[n] - v) * k);
      const l = Math.hypot(...q) || 1;
      q = q.map(v => v / l);
    }
    let ex = b.ex ? { ...b.ex } : null;
    if (ex && a.ex) {
      ex.yaw = lerpAngle(a.ex.yaw, b.ex.yaw, k);
      ex.pitch = a.ex.pitch + (b.ex.pitch - a.ex.pitch) * k;
    }
    return { p, q, ex };
  }
}
