// Live channel: the app keeps one WebSocket open. The server never sends data over it, only a tiny "something changed" hint
// ({t:'sync'} or {t:'nearby'}); the app then fetches the real data over the normal authenticated HTTP calls. So all privacy rules stay in one place.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const cfg = require('./config');

function createHub() {
  const conns = new Map(); // userId -> Set<ws>
  const lastNearby = new Map(); // userId -> last nearby hint time (throttle)
  let store = null;

  const send = (ws, o) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch { /* socket closing */ } } };
  const emit = (userId, t) => { const set = conns.get(String(userId)); if (set) for (const ws of set) send(ws, { t }); };
  const broadcast = (t) => { for (const set of conns.values()) for (const ws of set) send(ws, { t }); };
  const emitMany = (ids, t) => { for (const id of new Set(ids)) emit(id, t); };
  // Hint every online person whose Nearby list may have changed because `me` moved, appeared or vanished.
  function nearbyChanged(me, radiusM = 20000) {
    if (!store || me.lat == null) return;
    const dLat = radiusM / 111320, dLng = radiusM / (111320 * Math.max(Math.cos((me.lat * Math.PI) / 180), 0.01)); const now = Date.now();
    for (const id of conns.keys()) {
      if (id === me.id) continue;
      if (now - (lastNearby.get(id) || 0) < 700) continue;
      const u = store.getUser(id); if (!u || u.lat == null || Math.abs(u.lat - me.lat) > dLat || Math.abs(u.lng - me.lng) > dLng) continue;
      lastNearby.set(id, now); emit(id, 'nearby');
    }
  }
  function attach(server, st) {
    store = st;
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
    wss.on('connection', (ws) => {
      ws.alive = true; ws.uid = null;
      const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 8000);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        ws.alive = true;
        if (m.t === 'ping') return send(ws, { t: 'pong' });
        // Typing / read signals go only to a connected, unblocked peer. Nothing is stored.
        if ((m.t === 'typing' || m.t === 'read') && ws.uid && typeof m.to === 'string') {
          const now = Date.now(); if (m.t === 'typing' && now - (ws.lastTyping || 0) < 1000) return; if (m.t === 'typing') ws.lastTyping = now;
          if (store.relationFor(ws.uid, m.to) !== 'connected' || store.blockedEither(ws.uid, m.to)) return;
          const set = conns.get(m.to); if (set) for (const p of set) send(p, { t: m.t, from: ws.uid, at: now });
          return;
        }
        if (m.t !== 'auth' || ws.uid) return;
        try {
          const p = jwt.verify(String(m.token || ''), cfg.jwtSecret); const u = store.getUser(p.sub); if (!u || u.banned || u.token_version !== p.tv) throw new Error('stale');
          clearTimeout(authTimer); ws.uid = u.id;
          let set = conns.get(u.id); if (!set) conns.set(u.id, (set = new Set()));
          if (set.size >= 5) { const old = set.values().next().value; old.close(4002, 'replaced'); set.delete(old); }
          set.add(ws); send(ws, { t: 'ready' });
        } catch { ws.close(4003, 'unauthorized'); }
      });
      ws.on('close', () => { clearTimeout(authTimer); if (ws.uid) { const set = conns.get(ws.uid); if (set) { set.delete(ws); if (!set.size) conns.delete(ws.uid); } } });
      ws.on('error', () => {});
    });
    // Heartbeat: drop dead sockets, and give the app a sign of life it can watch for.
    const beat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch { /* closing */ } send(ws, { t: 'hb' }); } }, 20000);
    beat.unref(); wss.on('close', () => clearInterval(beat));
    return wss;
  }
  const kick = (id) => { const set = conns.get(String(id)); if (set) for (const ws of [...set]) ws.close(4003, 'unauthorized'); };
  return { attach, kick, broadcast, emit, emitMany, nearbyChanged, online: () => [...conns.keys()] };
}
module.exports = { createHub };
