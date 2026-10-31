const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cfg = require('../config');
const { h, HttpError, hit } = require('../util');

const kind = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.length > 8 && b.readUInt32BE(0) === 0x89504e47 ? 'png' : b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null);

module.exports = function uploadRoutes({ db, auth }) {
  const r = express.Router();
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 } });
  r.post('/upload', auth, up.single('file'), h(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file.');
    if (!hit('up:' + req.user.id, 40, 3600e3)) throw new HttpError(429, 'Too many uploads. Try again later.');
    const ext = kind(req.file.buffer); if (!ext) throw new HttpError(400, 'Only JPG, PNG or WebP photos are allowed.');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext; // unguessable name; the type comes from the bytes, not from the client
    await fs.promises.writeFile(path.join(cfg.dataDir, 'uploads', name), req.file.buffer);
    db.prepare('INSERT INTO uploads(name,owner,at) VALUES (?,?,?)').run(name, req.user.id, Date.now());
    res.status(201).json({ url: `${cfg.publicUrl}/uploads/${name}` });
  }));
  return r;
};
