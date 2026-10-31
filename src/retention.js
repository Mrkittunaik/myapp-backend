// Chat messages are temporary: they live 3 hours, and only the newest 10 per conversation are kept.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

module.exports = function makeRetention(db) {
  const imgName = (p) => String(p || '').split('?')[0].split('/').pop();
  // Delete a chat photo file once nothing references it (not another message, not a profile photo).
  function dropImage(name) {
    if (!name || !/^[a-f0-9]+\.(jpg|png|webp)$/.test(name)) return;
    if (db.prepare('SELECT 1 FROM messages WHERE image LIKE ? LIMIT 1').get('%' + name + '%')) return;
    if (db.prepare('SELECT 1 FROM users WHERE photos LIKE ? LIMIT 1').get('%' + name + '%')) return;
    db.prepare('DELETE FROM uploads WHERE name = ?').run(name);
    fs.rm(path.join(cfg.dataDir, 'uploads', name), { force: true }, () => {});
  }
  function remove(rows) {
    if (!rows.length) return 0;
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    db.transaction(() => { for (const r of rows) del.run(r.id); })();
    for (const r of rows) dropImage(imgName(r.image));
    return rows.length;
  }
  // Older than 3 hours (including delete markers, which only exist so the other phone learns about a delete).
  // Delete markers hold no content and only live 10 minutes (long enough for the other phone to hear about it). Message notification texts go with the messages.
  const purgeExpired = (now = Date.now()) => {
    db.prepare("DELETE FROM notifications WHERE kind = 'messages' AND at < ?").run(now - cfg.messageTtlMs);
    return remove(db.prepare('SELECT id, image FROM messages WHERE at < ? OR (deleted = 1 AND COALESCE(deleted_at, 0) < ?)').all(now - cfg.messageTtlMs, now - 10 * 60e3));
  };
  // More than the newest N in one conversation. Deleted messages do not use up a slot.
  const trimPair = (x, y, keep = cfg.messageKeep) => remove(db.prepare(
    "SELECT id, image FROM messages WHERE deleted = 0 AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) ORDER BY at DESC, rev DESC LIMIT -1 OFFSET ?").all(x, y, y, x, keep));
  const trimAll = (keep = cfg.messageKeep) => remove(db.prepare(
    `SELECT id, image FROM (SELECT id, image, ROW_NUMBER() OVER (PARTITION BY MIN(sender, receiver) || '|' || MAX(sender, receiver) ORDER BY at DESC, rev DESC) rn FROM messages WHERE deleted = 0) WHERE rn > ?`).all(keep));
  // Help-board posts live 30 days (hidden after that) and their rows are removed after 40 days. The monthly post count only needs the current month.
  const purgeHelp = (now = Date.now()) => { const old = now - 40 * 86400e3; db.prepare('DELETE FROM help_requests WHERE post_id IN (SELECT id FROM help_posts WHERE created_at < ?)').run(old); return db.prepare('DELETE FROM help_posts WHERE created_at < ?').run(old).changes; };
  return { purgeHelp, purgeExpired, trimPair, trimAll, dropImage, purge: (now) => { purgeHelp(now); const n = purgeExpired(now) + trimAll(); if (n) { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy: next sweep */ } } return n; } };
};
