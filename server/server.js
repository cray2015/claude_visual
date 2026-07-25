// SPDX-License-Identifier: Apache-2.0
'use strict';

// claude_visual receiver.
//
// Runs under *Windows* node.exe (C:\Program Files\nodejs\node.exe) on purpose:
// it binds the machine's real LAN address directly, so the phone can reach it
// with no netsh portproxy and no WSL networking changes. Files land in
// D:\code\claude_visual\inbox, which WSL sees as /mnt/d/code/claude_visual/inbox.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { parse, boundaryFrom } = require('./multipart');
const { addresses } = require('./netrank');
const page = require('./page');
const cfg = require('../config');

const { inbox: INBOX, manifest: MANIFEST, tokenFile: TOKEN_F, urlsFile: URLS_F } = cfg;
const { port: PORT, host: HOST, maxFileBytes: MAX_FILE, maxBodyBytes: MAX_BODY } = cfg;

fs.mkdirSync(INBOX, { recursive: true });

// ---------------------------------------------------------------- token

function loadToken() {
  if (cfg.token) return cfg.token;              // pinned in .env
  try {
    const t = fs.readFileSync(TOKEN_F, 'utf8').trim();
    if (t) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(TOKEN_F, t + '\n');
  return t;
}
const TOKEN = loadToken();

function authed(req, url) {
  const given = req.headers['x-token'] || url.searchParams.get('k') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- image sniffing

// Trust the bytes, not the declared content-type or the filename extension.
function sniff(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(brand)) return 'heic';
  }
  if (buf.subarray(0, 6).toString('latin1') === 'GIF89a' ||
      buf.subarray(0, 6).toString('latin1') === 'GIF87a') return 'gif';
  return null;
}

// ---------------------------------------------------------------- app icon

// A tiny PNG writer, so the home-screen icon looks deliberate instead of
// letting iOS fall back to a screenshot of the page.
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 180 for apple-touch-icon, 192/512 for the Android web app manifest.
const ICONS = new Map();
function icon(size) {
  if (!ICONS.has(size)) ICONS.set(size, makeIcon(size));
  return ICONS.get(size);
}

function makeIcon(size = 180) {
  const bg = [201, 100, 66];        // terracotta
  const fg = [255, 255, 255];
  const rows = [];
  const cx = size / 2, cy = size / 2, r = size * 0.20, ring = size * 0.30;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);   // leading filter byte 0
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const on = d <= r || (d >= ring && d <= ring + size * 0.055);
      const c = on ? fg : bg;
      row[1 + x * 3] = c[0];
      row[2 + x * 3] = c[1];
      row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- naming

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const cleanTag = t => String(t || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
                        .replace(/^-+|-+$/g, '').slice(0, 24);

function uniqueName(base, ext) {
  for (let i = 0; ; i++) {
    const name = i === 0 ? `${base}.${ext}` : `${base}-${i}.${ext}`;
    if (!fs.existsSync(path.join(INBOX, name))) return name;
  }
}

function logManifest(rec) {
  try {
    fs.appendFileSync(MANIFEST, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('  ! manifest write failed:', e.message);
  }
}

// ---------------------------------------------------------------- server

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (url.pathname === '/health') return send(200, 'ok');

  if (url.pathname === '/icon.png') {
    const want = Number(url.searchParams.get('size'));
    const size = [180, 192, 512].includes(want) ? want : 180;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    return res.end(icon(size));
  }

  // Makes the page installable as a standalone app on Android/Chrome, the way
  // apple-mobile-web-app-capable does on iOS. start_url carries the token
  // through: an installed app that launched at bare "/" could never
  // authenticate — the same trap the iOS icon fell into.
  if (url.pathname === '/manifest.webmanifest') {
    const k = url.searchParams.get('k') || '';
    const start = '/' + (k ? '?k=' + encodeURIComponent(k) : '');
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      name: 'Send to Claude',
      short_name: 'Claude',
      start_url: start,
      scope: '/',
      display: 'standalone',
      background_color: '#141413',
      theme_color: '#141413',
      icons: [
        { src: '/icon.png?size=192', sizes: '192x192', type: 'image/png' },
        { src: '/icon.png?size=512', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }));
  }

  if (url.pathname === '/' && req.method === 'GET') {
    // The page is served unauthenticated; it is inert without a valid token,
    // and this keeps the "open the link, add to home screen" flow painless.
    return send(200, page(cfg), 'text/html; charset=utf-8');
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    if (!authed(req, url)) return send(401, 'bad or missing token');

    const boundary = boundaryFrom(req.headers['content-type']);
    if (!boundary) return send(400, 'expected multipart/form-data');

    let body;
    try {
      body = await readBody(req, MAX_BODY);
    } catch {
      return send(413, 'too large');
    }

    const parts = parse(body, boundary);
    const tag = cleanTag((parts.find(p => p.name === 'tag') || {}).data);
    const files = parts.filter(p => p.name === 'file' && p.filename && p.data.length);
    if (!files.length) return send(400, 'no file');

    const saved = [];
    for (const f of files) {
      if (f.data.length > MAX_FILE) { console.log('  ! rejected (too big):', f.filename); continue; }
      const ext = sniff(f.data);
      if (!ext) { console.log('  ! rejected (not an image):', f.filename); continue; }

      const base = stamp(new Date()) + (tag ? '-' + tag : '');
      const name = uniqueName(base, ext);
      fs.writeFileSync(path.join(INBOX, name), f.data);

      logManifest({
        event: 'upload',
        t: new Date().toISOString(),
        file: name,
        tag: tag || null,
        bytes: f.data.length,
        original: f.filename,
        from: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      });

      saved.push(name);
      console.log(`  + ${name}  ${(f.data.length / 1024).toFixed(0)} KB${tag ? '  #' + tag : ''}`);
    }

    if (!saved.length) return send(415, 'no usable image in upload');
    return send(200, JSON.stringify({ ok: true, saved }), 'application/json');
  }

  send(404, 'not found');
});

// ---------------------------------------------------------------- startup

server.listen(PORT, HOST, () => {
  const list = addresses().filter(a => a.rank >= 0);
  const all = addresses();
  const lines = list.map(a => `http://${a.ip}:${PORT}/?k=${TOKEN}`);

  console.log('');
  console.log('  claude_visual  —  listening on port ' + PORT);
  console.log('  inbox: ' + INBOX);
  console.log(`  resize: ${cfg.maxEdge}px @ q${cfg.jpegQuality}   /vis window: ${cfg.windowMin} min`);
  console.log('');
  console.log('  Open on the iPhone (same Wi-Fi), then Share → Add to Home Screen:');
  const w = Math.max(...all.map(a => a.iface.length), 8);
  for (const a of all) {
    const note = a.rank < 0 ? '   (virtual — phone cannot reach this)' : '';
    console.log(`    ${a.iface.padEnd(w)}  http://${a.ip}:${PORT}/?k=${TOKEN}${note}`);
  }
  console.log('');

  try {
    fs.writeFileSync(URLS_F, lines.join('\n') + '\n');
  } catch { /* claim.js just loses its hint text */ }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  port ${PORT} is already in use — the server may already be running.\n`);
    process.exit(1);
  }
  throw e;
});
