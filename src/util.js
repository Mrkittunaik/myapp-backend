const crypto = require('crypto');
const R = 6371000, rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const distanceM = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const bearingDeg = (a, b) => { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return (deg(Math.atan2(y, x)) + 360) % 360; };
const newId = (p) => p + crypto.randomBytes(8).toString('hex');
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^\S+@\S+\.\S+$/.test(e.trim());
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128 && /\d/.test(p);
const normEmail = (e) => String(e || '').trim().toLowerCase();
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function ageFromDob(dob, now = new Date()) {
  if (!isIsoDate(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)) age--;
  return age;
}
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // async route wrapper
const strArr = (v, max, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= len).slice(0, max) : undefined);
// Tiny in-memory limiter for per-user actions (messages, waves). Resets on restart, which is fine for abuse control.
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now(); const b = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (b.length >= limit) { buckets.set(key, b); return false; }
  b.push(now); buckets.set(key, b); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();
module.exports = { distanceM, bearingDeg, newId, validEmail, validPassword, normEmail, isIsoDate, ageFromDob, HttpError, h, strArr, hit };
