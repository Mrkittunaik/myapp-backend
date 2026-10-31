const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');
const cfg = require('./config');
const { open } = require('./db');
const makeStore = require('./store');
const { createHub } = require('./realtime');
const makeRetention = require('./retention');
const { HttpError } = require('./util');

function createApp(dir) {
  const db = open(dir); const rt = createHub(); const store = makeStore(db, rt); const retention = makeRetention(db);
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors()); // the mobile app is not a browser; open CORS only matters for web tools
  app.use(express.json({ limit: '100kb' }));
  app.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.use('/uploads', express.static(path.join(cfg.dataDir, 'uploads'), { maxAge: '365d', immutable: true, index: false, dotfiles: 'deny' }));
  app.get('/health', (_, res) => res.json({ ok: true, users: db.prepare('SELECT COUNT(*) c FROM users').get().c }));

  const auth = (req, res, next) => {
    let u;
    try {
      const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const p = jwt.verify(t, cfg.jwtSecret);
      u = store.getUser(p.sub); if (!u || u.token_version !== p.tv) throw new Error('stale');
    } catch { return next(new HttpError(401, 'Please log in again.', 'unauthorized')); }
    if (u.banned) return next(new HttpError(403, 'This account has been suspended.', 'banned'));
    req.user = u; next();
  };
  // Nearby, messages and requests need a verified email and a verified face.
  const requireFace = (req, res, next) => {
    if (!req.user.email_verified) return next(new HttpError(403, 'Verify your email first.', 'email_required'));
    if (req.user.face_status !== 'verified') return next(new HttpError(403, 'Verify your face to continue.', 'face_required'));
    next();
  };
  const ctx = { db, store, auth, requireFace, rt, retention };
  app.use('/auth', require('./routes/auth')(ctx));
  app.use(require('./routes/me')(ctx));
  app.use(require('./routes/upload')(ctx));
  app.use(require('./routes/face')(ctx));
  app.use(require('./routes/social')(ctx));
  app.use(require('./routes/help')(ctx));
  app.use('/admin', require('./routes/admin')(ctx));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => { // eslint-disable-line
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large.' });
    if (err && err.name === 'MulterError') return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Bad upload.' });
    console.error('[error]', err); res.status(500).json({ error: 'Something went wrong. Try again.' });
  });
  return { app, db, store, rt, retention };
}
module.exports = { createApp };
