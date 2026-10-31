// Safe online copy of the database (works while the server runs). Usage: npm run backup  -> data/backups/nearby-<time>.db. Keeps the newest 14.
const fs = require('fs'); const path = require('path'); const Database = require('better-sqlite3'); const cfg = require('../src/config');
(async () => {
  const dir = path.join(cfg.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `nearby-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const db = new Database(path.join(cfg.dataDir, 'nearby.db'), { readonly: true }); await db.backup(out); db.close();
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort(); for (const f of all.slice(0, -14)) fs.rmSync(path.join(dir, f));
  console.log('Backup written:', out, '(copy it off the server too; photos are in', path.join(cfg.dataDir, 'uploads') + ')');
})().catch((e) => { console.error('Backup failed:', e.message); process.exit(1); });
