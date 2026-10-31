const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

function open(dir = cfg.dataDir) {
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const db = new Database(path.join(dir, 'nearby.db'));
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON'); // deleted rows are overwritten on disk, not just unlinked
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, token_version INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0, pending_email TEXT,
    name TEXT NOT NULL DEFAULT '', dob TEXT NOT NULL DEFAULT '', gender_claimed TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    photos TEXT NOT NULL DEFAULT '[]', interests TEXT NOT NULL DEFAULT '[]', intentions TEXT NOT NULL DEFAULT '[]',
    languages TEXT NOT NULL DEFAULT '[]', socials TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'everyone',
    interested_in TEXT NOT NULL DEFAULT 'Everyone', prefs TEXT NOT NULL DEFAULT '{}',
    lat REAL, lng REAL, accuracy REAL, loc_at INTEGER, visible INTEGER NOT NULL DEFAULT 1, push_token TEXT,
    face_status TEXT NOT NULL DEFAULT 'none', face_gender TEXT, face_age INTEGER, face_confidence REAL, face_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS users_loc ON users(lat, lng);
  CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, purpose TEXT NOT NULL, hash TEXT NOT NULL,
    expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, user_id TEXT
  );
  CREATE INDEX IF NOT EXISTS codes_email ON codes(email, purpose);
  CREATE TABLE IF NOT EXISTS links (
    a TEXT NOT NULL, b TEXT NOT NULL, state TEXT NOT NULL, requester TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (a, b)
  );
  CREATE TABLE IF NOT EXISTS blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (blocker, blocked));
  CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS msg_pair ON messages(sender, receiver);
  CREATE INDEX IF NOT EXISTS msg_rev ON messages(rev);
  CREATE TABLE IF NOT EXISTS chat_state (user_id TEXT NOT NULL, peer TEXT NOT NULL, cleared_at INTEGER NOT NULL, PRIMARY KEY (user_id, peer));
  CREATE TABLE IF NOT EXISTS notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, icon TEXT NOT NULL, text TEXT NOT NULL,
    target TEXT NOT NULL, at INTEGER NOT NULL, pushed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, seq);
  CREATE TABLE IF NOT EXISTS uploads (name TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS face_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, steps TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS passes (viewer TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (viewer, target));
  CREATE TABLE IF NOT EXISTS help_posts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, offer INTEGER NOT NULL DEFAULT 0,
    pref TEXT NOT NULL DEFAULT 'Anyone', status TEXT NOT NULL DEFAULT 'open', accepted TEXT, created_at INTEGER NOT NULL, expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS help_open ON help_posts(status, created_at);
  CREATE INDEX IF NOT EXISTS help_owner ON help_posts(owner, created_at);
  CREATE TABLE IF NOT EXISTS help_requests (
    post_id TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', at INTEGER NOT NULL, PRIMARY KEY (post_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS help_req_user ON help_requests(user_id);
  CREATE TABLE IF NOT EXISTS waves (a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b));
  CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, val INTEGER NOT NULL);
  INSERT OR IGNORE INTO counters(name, val) VALUES ('rev', 0);
  `);
  for (const c of ['ALTER TABLE messages ADD COLUMN deleted_at INTEGER', 'ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN ban_reason TEXT', 'ALTER TABLE users ADD COLUMN face_consent_at INTEGER']) { try { db.exec(c); } catch { /* column already there */ } }
  const nextRev = db.transaction(() => { db.prepare("UPDATE counters SET val = val + 1 WHERE name = 'rev'").run(); return db.prepare("SELECT val FROM counters WHERE name = 'rev'").get().val; });
  db.nextRev = nextRev;
  return db;
}
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
module.exports = { open, pair };
