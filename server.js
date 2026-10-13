// Live location tracker: static PWA + WebSocket relay + small geocoding proxy.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const HOME_POSTCODE = (process.env.HOME_POSTCODE || 'WN8 8NQ').toUpperCase();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'LiveTracker/1.0 (self-hosted family tracker)';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let db = { groups: {}, subs: {} }; // groups[code].members[id] = member ; subs[memberId] = [pushSubscription]
try { db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
db.groups ||= {}; db.subs ||= {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {});
    });
  }, 1000);
}

// ---------- web push (VAPID keys generated once) ----------
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
// On hosts with no persistent disk, derive stable keys from VAPID_SECRET so push subscriptions survive restarts.
function vapidFromSecret(secret) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(crypto.createHmac('sha256', secret).update('vapid').digest());
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}
let vapid;
if (process.env.VAPID_SECRET) vapid = vapidFromSecret(process.env.VAPID_SECRET);
else {
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid)); }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

async function pushTo(memberId, payload) {
  const list = db.subs[memberId] || [];
  const keep = [];
  await Promise.all(list.map(async sub => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60, urgency: 'high' }); keep.push(sub); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub); }
  }));
  db.subs[memberId] = keep; save();
}

// ---------- geocoding ----------
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

let home = { postcode: HOME_POSTCODE, lat: 53.5556, lng: -2.7768, approx: true }; // fallback until lookup succeeds
async function lookupHome() {
  try {
    const j = await getJSON('https://api.postcodes.io/postcodes/' + encodeURIComponent(HOME_POSTCODE.replace(/\s+/g, '')));
    home = { postcode: j.result.postcode, lat: j.result.latitude, lng: j.result.longitude, approx: false };
    console.log('Home point', home);
    broadcastAll({ t: 'home', home });
  } catch (e) {
    console.warn('Could not look up home postcode, retrying in 60s:', e.message);
    setTimeout(lookupHome, 60000);
  }
}

// Nominatim allows ~1 request/second; queue requests and cache by ~10 m grid.
const addrCache = new Map();
let nominatimChain = Promise.resolve();
function nominatim(url) {
  const p = nominatimChain.then(() => getJSON(url));
  nominatimChain = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, 1100)));
  return p;
}
async function reverseGeocode(lat, lng) {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (addrCache.has(key)) return addrCache.get(key);
  let text = null;
  try {
    const j = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`);
    const a = j.address || {};
    const street = [a.house_number, a.road || a.pedestrian || a.footway || a.path || a.cycleway].filter(Boolean).join(' ');
    const place = a.suburb || a.village || a.town || a.city || a.hamlet || '';
    text = [street, place, a.postcode].filter(Boolean).join(', ') || j.display_name || null;
  } catch {
    try {
      const j = await getJSON(`https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&limit=1`);
      const r = j.result && j.result[0];
      if (r) text = `Near ${r.postcode}, ${r.admin_ward || r.admin_district}`;
    } catch { /* give up */ }
  }
  if (text) { addrCache.set(key, text); if (addrCache.size > 5000) addrCache.delete(addrCache.keys().next().value); }
  return text;
}

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
async function forwardGeocode(q) {
  q = q.trim();
  if (POSTCODE_RE.test(q)) {
    const j = await getJSON('https://api.postcodes.io/postcodes/' + encodeURIComponent(q.replace(/\s+/g, '')));
    return { label: j.result.postcode, lat: j.result.latitude, lng: j.result.longitude, kind: 'postcode', radius: 150 };
  }
  if (OUTCODE_RE.test(q)) {
    const j = await getJSON('https://api.postcodes.io/outcodes/' + encodeURIComponent(q));
    return { label: j.result.outcode, lat: j.result.latitude, lng: j.result.longitude, kind: 'district', radius: 2000 };
  }
  const j = await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=${encodeURIComponent(q)}`);
  if (!j.length) throw new Error('Not found');
  const r = j[0];
  // Size the default radius from the place's bounding box, clamped to something sensible.
  let radius = 200;
  if (r.boundingbox) {
    const [s, n, w, e] = r.boundingbox.map(Number);
    radius = Math.min(5000, Math.max(100, distance(s, w, n, e) / 2));
  }
  return { label: r.name || r.display_name.split(',')[0], lat: +r.lat, lng: +r.lon, kind: 'place', radius: Math.round(radius) };
}

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- groups & sockets ----------
const sockets = new Map(); // ws -> { id, code }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const validCode = c => c.length === 6 && [...c].every(ch => CODE_CHARS.includes(ch));
function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join(''); } while (db.groups[c]);
  return c;
}
const publicMember = m => ({ id: m.id, name: m.name, lat: m.lat, lng: m.lng, acc: m.acc, battery: m.battery, charging: m.charging,
  address: m.address, updatedAt: m.updatedAt, sharing: m.sharing, online: isOnline(m.id), source: m.source || null, speed: m.speed ?? null, bgAt: m.bgAt || null });
function isOnline(id) { for (const s of sockets.values()) if (s.id === id) return true; return false; }
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(code, msg) { for (const [ws, s] of sockets) if (s.code === code) send(ws, msg); }
function broadcastAll(msg) { for (const ws of sockets.keys()) send(ws, msg); }
function socketsFor(id) { return [...sockets].filter(([, s]) => s.id === id).map(([ws]) => ws); }

function updateLocation(code, me, { lat, lng, acc, battery, charging, speed }) {
  if (!me.sharing) return false;
  lat = +lat; lng = +lng;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  const moved = me.lat == null ? Infinity : distance(me.lat, me.lng, lat, lng);
  const now = Date.now(), dt = me.updatedAt ? (now - me.updatedAt) / 1000 : 0;
  // Prefer the phone's own speed reading (m/s); otherwise work it out from the last two positions.
  let v = speed != null && isFinite(+speed) && +speed >= 0 ? +speed : null;
  if (v == null && me.lat != null && dt >= 3 && dt <= 180) {
    const noise = Math.max(+acc || 0, me.acc || 0, 10);
    v = moved > noise ? moved / dt : 0;
  }
  Object.assign(me, { lat, lng, acc: +acc || null, updatedAt: now, speed: v });
  me.battery = battery != null && isFinite(battery) && battery >= 0 ? battery : null;
  me.charging = me.battery != null ? !!charging : null;
  broadcast(code, { t: 'member', member: publicMember(me) });
  save();
  if (moved > 20 || !me.address) {
    reverseGeocode(lat, lng).then(addr => {
      if (addr && addr !== me.address) { me.address = addr; broadcast(code, { t: 'member', member: publicMember(me) }); save(); }
    });
  }
  return true;
}

// OwnTracks (free iPhone/Android app) posts here in HTTP mode, so location keeps flowing when our app is closed.
// URL: /ot/<code>/<memberId>/<token>?name=<name>
function handleOwnTracks(req, res, [code, id, token], name) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
    let msg; try { msg = JSON.parse(body); } catch { return; }
    if (!msg || msg._type !== 'location' || !validCode(code)) return;
    const g = db.groups[code] ||= { created: Date.now(), members: {} };
    let m = g.members[id];
    if (!m) {
      // Server storage was wiped (free hosting); trust the link and recreate the person.
      if (!name || !token) return;
      m = g.members[id] = { id, name: String(name).slice(0, 30), sharing: true, token };
    }
    if (!m.token || m.token !== token) return;
    // OwnTracks battery status: 2 = charging, 3 = full.
    m.source = 'background'; m.bgAt = Date.now();
    updateLocation(code, m, { lat: msg.lat, lng: msg.lon, acc: msg.acc, battery: msg.batt, charging: msg.bs === 2 || msg.bs === 3,
      speed: msg.vel != null ? +msg.vel / 3.6 : null }); // OwnTracks reports km/h
  });
}

function handle(ws, msg) {
  const s = sockets.get(ws);
  if (msg.t === 'hello') {
    const code = String(msg.code || '').toUpperCase().trim();
    const id = String(msg.id || '').slice(0, 64);
    const name = String(msg.name || '').trim().slice(0, 30);
    if (!validCode(code)) return send(ws, { t: 'error', error: 'bad-code', message: 'That join code doesn\'t exist.' });
    // Free hosts can wipe storage on restart; members' phones remember the code, so recreate the group.
    db.groups[code] ||= { created: Date.now(), members: {} };
    if (!id || !name) return send(ws, { t: 'error', error: 'bad-hello', message: 'Name required.' });
    const g = db.groups[code];
    const m = g.members[id] ||= { id, sharing: !!msg.sharing };
    m.name = name;
    // Reuse the token the phone remembers so its background-tracking link survives a storage wipe.
    m.token ||= /^[a-f0-9]{24}$/.test(msg.token || '') ? msg.token : crypto.randomBytes(12).toString('hex');
    s.id = id; s.code = code;
    save();
    send(ws, { t: 'state', code, home, vapidKey: vapid.publicKey, token: m.token, members: Object.values(g.members).map(publicMember) });
    broadcast(code, { t: 'member', member: publicMember(m) });
    return;
  }
  if (!s.code) return;
  const g = db.groups[s.code];
  const me = g && g.members[s.id];
  if (!me) return;

  if (msg.t === 'loc') {
    me.source = 'app';
    updateLocation(s.code, me, { lat: msg.lat, lng: msg.lng, acc: msg.acc,
      battery: msg.battery != null ? Math.round(+msg.battery * 100) : null, charging: msg.charging, speed: msg.speed });
  } else if (msg.t === 'sharing') {
    me.sharing = !!msg.on;
    if (!me.sharing) { me.lat = me.lng = me.acc = me.address = me.battery = null; me.updatedAt = Date.now(); }
    broadcast(s.code, { t: 'member', member: publicMember(me) });
    save();
  } else if (msg.t === 'ping') {
    const target = g.members[msg.to];
    if (!target) return;
    const text = String(msg.text || '').trim().slice(0, 200);
    const urgent = !text; // a plain ping is the emergency one; a message ping is a gentler alert
    const payload = { t: 'ping', from: me.name, fromId: me.id, text, urgent, at: Date.now() };
    const live = socketsFor(target.id);
    live.forEach(w => send(w, payload));
    pushTo(target.id, urgent
      ? { type: 'ping', urgent, title: `🚨 ${me.name} is pinging you`, body: 'Emergency ping — open the tracker.', from: me.name, text }
      : { type: 'ping', urgent, title: `💬 ${me.name}`, body: text, from: me.name, text });
    send(ws, { t: 'pinged', to: target.name, delivered: live.length > 0 || (db.subs[target.id] || []).length > 0 });
  } else if (msg.t === 'pushsub') {
    if (!msg.sub || !msg.sub.endpoint) return;
    const list = db.subs[me.id] ||= [];
    if (!list.some(x => x.endpoint === msg.sub.endpoint)) list.push(msg.sub);
    save();
  } else if (msg.t === 'leave') {
    delete g.members[me.id];
    delete db.subs[me.id];
    broadcast(s.code, { t: 'left', id: me.id });
    s.code = null; save();
  }
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ot = url.pathname.match(/^\/ot\/([A-Z0-9]{6})\/([\w-]{1,64})\/([a-f0-9]{24})$/);
  if (ot && req.method === 'POST') return handleOwnTracks(req, res, ot.slice(1), url.searchParams.get('name'));
  if (req.method === 'POST' && url.pathname === '/api/groups') {
    const code = newCode();
    db.groups[code] = { created: Date.now(), members: {} };
    save();
    return json(res, 200, { code });
  }
  if (url.pathname === '/api/groups/check') {
    const code = String(url.searchParams.get('code') || '').toUpperCase().trim();
    return json(res, 200, { exists: !!db.groups[code] || (validCode(code) && process.env.EPHEMERAL_STORAGE === '1') });
  }
  if (url.pathname === '/api/geocode') {
    try { return json(res, 200, await forwardGeocode(url.searchParams.get('q') || '')); }
    catch (e) { return json(res, 404, { error: 'Could not find that place or postcode.' }); }
  }
  if (url.pathname === '/api/home') return json(res, 200, home);

  let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  sockets.set(ws, { id: null, code: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { try { handle(ws, JSON.parse(raw)); } catch (e) { console.warn('bad message', e.message); } });
  ws.on('close', () => {
    const s = sockets.get(ws); sockets.delete(ws);
    const m = s && s.code && db.groups[s.code] && db.groups[s.code].members[s.id];
    if (m) broadcast(s.code, { t: 'member', member: publicMember(m) });
  });
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } } }, 30000);

server.listen(PORT, () => { console.log(`Tracker running on http://localhost:${PORT}`); lookupHome(); });
