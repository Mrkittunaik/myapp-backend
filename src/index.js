const cfg = require('./config');
const { createApp } = require('./app');
const { app, db, store, rt, retention } = createApp();
const server = app.listen(cfg.port, '0.0.0.0', () => console.log(`Nearby backend on :${cfg.port} (${cfg.isProd ? 'production' : 'development'}) data=${cfg.dataDir}`));
rt.attach(server, store);
// Messages live 3 hours and only the newest 10 per chat are kept: sweep every minute (sends also trim at once).
retention.purge(); setInterval(() => { try { retention.purge(); } catch (e) { console.error('[retention]', e.message); } }, 60e3).unref();
// Remove expired codes and face sessions, and offline location pins, once an hour.
setInterval(() => {
  try {
    db.prepare('DELETE FROM codes WHERE expires < ?').run(Date.now());
    db.prepare('DELETE FROM face_sessions WHERE expires < ?').run(Date.now() - 3600e3);
  } catch (e) { console.error('[cleanup]', e.message); }
}, 3600e3).unref();
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
