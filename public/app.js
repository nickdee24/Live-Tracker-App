'use strict';
/* Live Tracker client */

const PING_INTERVAL_MS = 10000;      // how often a sharer sends their location
const STALE_MS = 60000;              // grey a person out if we haven't heard in this long
const WALK_MPS = 1.34;               // average walking speed, ~3 mph
const ROUTE_FACTOR = 1.2;            // roads are rarely straight: pad straight-line distance

const $ = id => document.getElementById(id);
// The partner app (/partner) is this page in a simpler mode, with its own saved settings.
const SIMPLE = document.body.classList.contains('simple');
const NS = SIMPLE ? 'ltp.' : 'lt.';
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(NS + k); } catch {} },
};

const me = {
  id: store.get('id') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
  name: store.get('name', ''),
  code: store.get('code', ''),
  sharing: store.get('sharing', !SIMPLE),
  token: store.get('token', ''),
};
store.set('id', me.id);

let ws, wsRetry = 0, home = null, vapidKey = null;
const members = new Map();     // id -> member
const markers = new Map();     // id -> L.marker
let selectedId = store.get('selected');
let following = true;
let map, homeMarker;

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 65% 45%)`; }
const initial = n => (n || '?').trim().charAt(0).toUpperCase();
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function fmtDist(m) {
  const miles = m / 1609.344;
  if (miles < 0.1) return `${Math.round(m * 3.28084)} ft`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} miles`;
}
function fmtWalk(m) {
  const mins = Math.round((m * ROUTE_FACTOR) / WALK_MPS / 60);
  if (mins < 1) return 'under 1 min walk';
  if (mins < 60) return `${mins} min walk`;
  const h = Math.floor(mins / 60), mm = mins % 60;
  return `${h} hr${mm ? ' ' + mm + ' min' : ''} walk`;
}
function fmtAgo(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const hasLoc = m => m && m.sharing && m.lat != null;
const isStale = m => !m.updatedAt || Date.now() - m.updatedAt > STALE_MS;
// Speed in mph with a hint of how they're moving; nothing if the reading is old.
function speedText(m) {
  if (!hasLoc(m) || m.speed == null || isStale(m)) return null;
  const mph = m.speed * 2.23694;
  if (mph < 1) return '🧍 Not moving';
  const how = mph < 5 ? '🚶' : mph < 9 ? '🏃' : mph < 18 ? '🚴' : '🚗';
  return `${how} ${Math.round(mph)} mph`;
}
// A trip shared from NaviGO; ignored if NaviGO has gone quiet for 10 minutes.
function activeTrip(m) {
  return m && m.trip && m.updatedAt && Date.now() - m.updatedAt < 10 * 60000 ? m.trip : null;
}
function tripText(m, long) {
  const t = activeTrip(m);
  if (!t) return null;
  const mins = Math.max(0, Math.round((t.eta - Date.now()) / 60000));
  const at = new Date(t.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const left = t.remainingM != null ? ` · ${fmtDist(t.remainingM)} left` : '';
  return long ? `🚗 Driving to ${t.destName} · arriving ${at} (${mins < 1 ? 'any moment' : 'in ' + mins + ' min'})${left}`
    : `🚗 ${t.destName} · ${at}`;
}
const distInfo = d => ({ dist: fmtDist(d), walk: fmtWalk(d), short: `${fmtDist(d)} · ${fmtWalk(d)}` });
function awayText(m) {
  if (!hasLoc(m) || !home) return null;
  return distInfo(distM(m, home));
}
// Where the viewer is: their latest fix, or a local-only fix if they aren't sharing.
function myPos() {
  if (lastFix) return lastFix;
  const mm = members.get(me.id);
  if (hasLoc(mm)) return mm;
  return localFix;
}
function fromYou(m) {
  const p = myPos();
  if (!hasLoc(m) || m.id === me.id || !p) return null;
  return distInfo(distM(m, p));
}
function toast(msg, ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- join flow ----------
function showJoin(err = '') {
  $('app').classList.add('hidden'); $('join').classList.remove('hidden');
  $('joinName').value = me.name; $('joinCode').value = me.code || new URLSearchParams(location.search).get('code') || '';
  $('joinShare').checked = me.sharing;
  $('joinError').textContent = err;
}
async function doJoin(code) {
  const name = $('joinName').value.trim();
  if (!name) return ($('joinError').textContent = 'Please enter your name.');
  code = (code || $('joinCode').value).trim().toUpperCase();
  if (!code) return ($('joinError').textContent = 'Enter a join code or create a new group.');
  const r = await fetch('/api/groups/check?code=' + encodeURIComponent(code)).then(r => r.json()).catch(() => ({ exists: false }));
  if (!r.exists) return ($('joinError').textContent = "That join code doesn't exist.");
  me.name = name; me.code = code; me.sharing = $('joinShare').checked;
  store.set('name', name); store.set('code', code); store.set('sharing', me.sharing);
  unlockAudio();
  startApp();
}
$('joinBtn').onclick = () => doJoin();
$('createBtn').onclick = async () => {
  if (!$('joinName').value.trim()) return ($('joinError').textContent = 'Please enter your name first.');
  const { code } = await fetch('/api/groups', { method: 'POST' }).then(r => r.json());
  $('joinCode').value = code;
  doJoin(code);
};

// ---------- main app ----------
function startApp() {
  $('join').classList.add('hidden'); $('app').classList.remove('hidden');
  $('codeText').textContent = me.code;
  history.replaceState(null, '', '/');
  if (!map) initMap();
  connect();
  if (me.sharing) startSharing(); else renderMine();
  setPlatformNote();
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([53.5556, -2.7768], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.control.zoom({ position: 'topleft' }).addTo(map);
  map.on('dragstart', () => setFollowing(false));
  map.on('click', e => { if (pickMode) setPicked(e.latlng); });
  renderAlertsOnMap();
  // Keep Leaflet's bottom controls (attribution) above the info bar.
  new ResizeObserver(() => document.documentElement.style.setProperty('--infobar-h', $('infobar').offsetHeight + 'px')).observe($('infobar'));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    wsRetry = 0; $('conn').className = 'dot on';
    send({ t: 'hello', id: me.id, name: me.name, code: me.code, sharing: me.sharing, token: me.token, visible: document.visibilityState === 'visible' });
  };
  ws.onclose = () => {
    $('conn').className = 'dot off';
    if (!me.code) return;
    setTimeout(connect, Math.min(15000, 1000 * 2 ** wsRetry++));
  };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

let firstState = true;
function onMessage(msg) {
  switch (msg.t) {
    case 'error':
      if (msg.error === 'bad-code') { me.code = ''; store.del('code'); stopSharing(false); ws.close(); showJoin(msg.message); }
      break;
    case 'state':
      home = msg.home; vapidKey = msg.vapidKey;
      if (msg.token) { me.token = msg.token; store.set('token', msg.token); }
      drawHome();
      members.clear();
      msg.members.forEach(m => members.set(m.id, m));
      // Tell the server our sharing choice (it may have been changed while offline).
      send({ t: 'sharing', on: me.sharing });
      renderAll();
      if (firstState) { firstState = false; initialView(); }
      maybeSubscribePush();
      if (me.sharing && lastFix) sendLocation(lastFix);
      break;
    case 'home': home = msg.home; drawHome(); renderAll(); break;
    case 'member': {
      const prev = members.get(msg.member.id);
      members.set(msg.member.id, msg.member);
      if (msg.member.id === me.id) members.forEach(renderMember); else renderMember(msg.member);
      checkGeofences(msg.member, prev);
      renderTrips();
      if (msg.member.id === selectedId) { updateStreetView(); renderSelected(); if (following && hasLoc(msg.member)) followSelected(); }
      renderPeople();
      break;
    }
    case 'left':
      members.delete(msg.id);
      if (markers.has(msg.id)) { markers.get(msg.id).remove(); markers.delete(msg.id); }
      if (selectedId === msg.id) select(null);
      renderPeople();
      break;
    case 'ping': showPing(msg.from, msg.text, msg.urgent); break;
    case 'emote': showEmote(msg); break;
    case 'notice':
      if (msg.fromId !== me.id) { toast(`${msg.title}${msg.body ? ' · ' + msg.body : ''}`, 10000); notify(msg.title, msg.body, 'notice'); }
      break;
    case 'pinged': toast(msg.delivered ? `Sent to ${msg.to}.` : `${msg.to} isn't connected right now; they'll see it next time they open the app.`); break;
  }
}

// ---------- rendering ----------
function drawHome() {
  if (!home || !map) return;
  const icon = L.divIcon({ className: 'home-marker', html: '🏠', iconSize: [28, 28], iconAnchor: [14, 14] });
  if (homeMarker) homeMarker.setLatLng([home.lat, home.lng]);
  else homeMarker = L.marker([home.lat, home.lng], { icon, zIndexOffset: -1000 }).addTo(map);
  homeMarker.bindTooltip(home.postcode + (home.approx ? ' (approx.)' : ''));
}
function renderAll() { members.forEach(renderMember); renderSelected(); renderPeople(); renderMine(); renderTrips(); }

function markerHtml(m) {
  const away = awayText(m), fy = fromYou(m);
  const sp = speedText(m), tt = tripText(m);
  return `<div class="label">${esc(m.name)}${m.id === me.id ? ' (you)' : ''}${m.inCall ? '<span class="in-call">📞 In a call</span>' : ''}${tt ? `<small>${esc(tt)}</small>` : ''}${sp ? `<small>${esc(sp)}</small>` : ''}${fy ? `<small>👤 ${esc(fy.short)}</small>` : ''}${away ? `<small>🏠 ${esc(away.short)}</small>` : ''}</div>
          <div class="pin" style="background:${colorFor(m.id)}">${esc(initial(m.name))}</div>`;
}
function renderMember(m) {
  if (!map) return;
  let mk = markers.get(m.id);
  if (!hasLoc(m)) { if (mk) { mk.remove(); markers.delete(m.id); } return; }
  const cls = `person-marker${isStale(m) ? ' stale' : ''}${m.id === selectedId ? ' selected' : ''}`;
  const icon = L.divIcon({ className: cls, html: markerHtml(m), iconSize: [40, 40], iconAnchor: [20, 20] });
  if (!mk) {
    mk = L.marker([m.lat, m.lng], { icon, zIndexOffset: m.id === selectedId ? 1000 : 0 }).addTo(map);
    mk.on('click', () => select(m.id));
    markers.set(m.id, mk);
  } else {
    mk.setLatLng([m.lat, m.lng]); mk.setIcon(icon); mk.setZIndexOffset(m.id === selectedId ? 1000 : 0);
  }
}

function select(id) {
  selectedId = id; store.set('selected', id);
  updateStreetView(true);
  members.forEach(renderMember);
  renderSelected();
  if (id) { setFollowing(true); followSelected(true); }
  $('peoplePanel').classList.add('hidden');
}
function setFollowing(on) {
  following = on;
  $('followBtn').textContent = on ? '🎯 Following' : '🎯 Follow';
  $('followBtn').classList.toggle('off', !on);
}
function followSelected(zoomIn) {
  const m = members.get(selectedId);
  if (!hasLoc(m)) return;
  if (zoomIn) map.flyTo([m.lat, m.lng], Math.max(map.getZoom(), 16), { duration: 0.8 });
  else map.panTo([m.lat, m.lng], { animate: true });
}
function initialView() {
  if (selectedId && hasLoc(members.get(selectedId))) return select(selectedId);
  const pts = [...members.values()].filter(hasLoc).map(m => [m.lat, m.lng]);
  if (home) pts.push([home.lat, home.lng]);
  if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
  else if (pts.length) map.setView(pts[0], 15);
}

function renderSelected() {
  const m = members.get(selectedId);
  $('selected').classList.toggle('hidden', !m);
  $('nobody').classList.toggle('hidden', !!m);
  if (!m) return;
  $('selAvatar').textContent = initial(m.name);
  $('selAvatar').style.background = colorFor(m.id);
  $('selName').textContent = m.name + (m.id === me.id ? ' (you)' : '');
  $('selCall').textContent = m.inCall ? '📞 In a call' : ''; $('selCall').classList.toggle('hidden', !m.inCall);
  const tl = tripText(m, true);
  $('selTrip').textContent = tl || ''; $('selTrip').classList.toggle('hidden', !tl);
  if (!m.sharing) {
    $('selAddr').textContent = 'Not sharing location';
    $('selDist').textContent = ''; $('selFromYou').textContent = ''; $('selSpeed').textContent = ''; $('selBattery').textContent = '';
  } else if (!hasLoc(m)) {
    $('selAddr').textContent = 'Waiting for location…';
  } else {
    $('selAddr').textContent = m.address || 'Looking up address…';
    const away = awayText(m);
    const fy = fromYou(m);
    $('selFromYou').textContent = fy ? `👤 ${m.name} is ${fy.dist} from you · ≈${fy.walk}` : '';
    $('selDist').textContent = away ? `🏠 ${away.dist} from ${home.postcode} · ≈${away.walk}` : '';
    $('selSpeed').textContent = speedText(m) || '';
    $('selBattery').textContent = m.battery != null ? `${m.charging ? '⚡' : '🔋'} ${m.battery}%${m.charging ? ' charging' : ''}` : '🔋 battery n/a';
  }
  const via = !m.sharing ? '' : m.source === 'navigo' ? ' · via NaviGO' : m.source === 'background' && !m.online ? ' · background tracking'
    : !m.online && hasLoc(m) ? ' · app closed, last known spot' : '';
  $('selUpdated').textContent = `🕒 Updated ${fmtAgo(m.updatedAt)}${via}`;
  $('pingBtn').classList.toggle('hidden', m.id === me.id);
  $('pingBtn').textContent = `📳 Ping or message ${m.name}`;
}

function renderPeople() {
  const list = [...members.values()].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));
  $('peopleList').innerHTML = list.map(m => {
    const away = awayText(m), fy = fromYou(m);
    const where = fy ? `${fy.dist} from you · ` : away ? `${away.dist} from ${home.postcode} · ` : '';
    const sub = !m.sharing ? 'Not sharing' : !hasLoc(m) ? 'Waiting for location' : `${where}${fmtAgo(m.updatedAt)}`;
    return `<li data-id="${esc(m.id)}"><div class="avatar" style="background:${colorFor(m.id)}">${esc(initial(m.name))}</div>
      <div class="grow"><b>${esc(m.name)}${m.id === me.id ? ' (you)' : ''}</b><div class="muted small">${esc(sub)}</div></div>
      ${m.battery != null && m.sharing ? `<span class="small">${m.charging ? '⚡' : '🔋'}${m.battery}%</span>` : ''}</li>`;
  }).join('') || '<li class="muted">Nobody here yet. Share the join code!</li>';
  const sel = $('alWho'), cur = sel.value;
  sel.innerHTML = '<option value="*">Anyone</option>' + list.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '*';
}
$('peopleList').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) select(li.dataset.id); };

function renderMine() {
  const meM = members.get(me.id);
  let status;
  if (!me.sharing) status = '⏸️ You are not sharing your location';
  else if (geoError) status = `⚠️ ${geoError}`;
  else status = `🟢 Sharing every ${PING_INTERVAL_MS / 1000}s${meM && meM.updatedAt ? ' · last sent ' + fmtAgo(meM.updatedAt) : ''}`;
  $('myStatus').textContent = status;
  $('shareBtn').textContent = me.sharing ? 'Stop sharing' : 'Start sharing';
  // Hide the prompt once OwnTracks has been connected (tapped Connect here, or the server has heard from it).
  $('bgBtn2').classList.toggle('hidden', !me.sharing || store.get('bgSetup', false) || !!(meM && meM.bgAt));
  $('shareBtn').className = 'small' + (me.sharing ? '' : ' primary');
}

// Refresh "x seconds ago" text and stale styling.
setInterval(() => {
  if (!map) return;
  renderSelected(); renderMine();
  members.forEach(m => {
    const mk = markers.get(m.id);
    if (mk) mk.getElement()?.classList.toggle('stale', isStale(m));
  });
}, 1000);

// ---------- sharing my location ----------
let shareTimer = null, lastFix = null, localFix = null, geoError = '', battery = null;
// When not sharing, still read our position locally (never sent) so "from you" distances work.
setInterval(localTick, 30000);
function localTick() {
  if (me.sharing || !me.code || !navigator.permissions) return;
  navigator.permissions.query({ name: 'geolocation' }).then(st => {
    if (st.state !== 'granted') return;
    navigator.geolocation.getCurrentPosition(pos => {
      localFix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      members.forEach(renderMember); renderPeople();
    }, () => {}, { maximumAge: 30000, timeout: 15000 });
  }).catch(() => {});
}
if (navigator.getBattery) navigator.getBattery().then(b => { battery = b; }).catch(() => {});

function startSharing() {
  me.sharing = true; store.set('sharing', true);
  send({ t: 'sharing', on: true });
  if (!('geolocation' in navigator)) { geoError = 'This browser has no location support'; renderMine(); return; }
  clearInterval(shareTimer);
  tick();
  shareTimer = setInterval(tick, PING_INTERVAL_MS);
  requestWakeLock();
  renderMine();
}
function stopSharing(notify = true) {
  me.sharing = false; store.set('sharing', false);
  clearInterval(shareTimer); shareTimer = null; lastFix = null;
  localTick();
  if (notify) send({ t: 'sharing', on: false });
  releaseWakeLock();
  renderMine();
}
function tick() {
  navigator.geolocation.getCurrentPosition(pos => {
    geoError = '';
    lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, speed: pos.coords.speed, at: Date.now() };
    sendLocation(lastFix);
  }, err => {
    geoError = err.code === 1 ? 'Location permission denied: allow it in your browser settings' : 'Could not get a location fix';
    // Re-send a recent fix so we don't look offline because of one failed read.
    if (lastFix && Date.now() - lastFix.at < 30000) sendLocation(lastFix);
    renderMine();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 9000 });
}
function sendLocation(fix) {
  send({ t: 'loc', lat: fix.lat, lng: fix.lng, acc: fix.acc, speed: fix.speed, battery: battery ? battery.level : null, charging: battery ? battery.charging : null });
}
$('shareBtn').onclick = () => (me.sharing ? stopSharing() : startSharing());

// Keep the screen from sleeping while sharing (helps browsers keep sending), where supported.
let wakeLock = null;
async function requestWakeLock() {
  if (!store.get('keepAwake', false) || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
addEventListener('pagehide', () => send({ t: 'vis', on: false }));
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  send({ t: 'vis', on: document.visibilityState === 'visible' });   // no phone notifications while the app is on screen
  if (document.visibilityState === 'visible' && me.sharing && me.code) { requestWakeLock(); tick(); }
});

// ---------- pings & quick messages ----------
$('pingBtn').onclick = () => {
  const m = members.get(selectedId);
  if (!m) return;
  $('pingPanelTitle').textContent = `Ping ${m.name}`;
  togglePanel('pingPanel');
};
function sendPing(text) {
  const m = members.get(selectedId);
  if (!m) return;
  if (!text && !confirm(`Send an EMERGENCY ping to ${m.name}? Their phone will keep buzzing until they answer.`)) return;
  send({ t: 'ping', to: m.id, text: text || '' });
  $('pingPanel').classList.add('hidden');
}
document.querySelectorAll('.send-ping').forEach(b => (b.onclick = () => sendPing(b.dataset.urgent ? '' : b.dataset.text)));
$('pingForm').onsubmit = e => {
  e.preventDefault();
  const t = $('pingCustom').value.trim();
  if (!t) return $('pingCustom').focus();
  sendPing(t); $('pingCustom').value = '';
};
let vibrateTimer = null, audioCtx = null;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
}
document.addEventListener('pointerdown', unlockAudio, { once: true });
function beep() {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}
function showPing(from, text, urgent = !text) {
  $('pingFrom').textContent = from;
  $('pingIcon').textContent = urgent ? '🚨' : '💬';
  $('pingText').textContent = urgent ? 'is pinging you. They may need you urgently.' : `“${text}”`;
  $('pingDismiss').textContent = urgent ? "I'm OK — dismiss" : 'OK';
  $('pingOverlay').classList.toggle('calm', !urgent);
  $('pingOverlay').classList.remove('hidden');
  clearInterval(vibrateTimer);
  if (urgent) {
    const buzz = () => { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]); beep(); };
    buzz(); vibrateTimer = setInterval(buzz, 2500);
    notify(`🚨 ${from} is pinging you`, 'Emergency ping. Open the tracker.', 'ping');
  } else {
    if (navigator.vibrate) navigator.vibrate([300, 120, 300]);
    beep();
    notify(`💬 ${from}`, text, 'msg');
  }
}
$('pingDismiss').onclick = () => {
  clearInterval(vibrateTimer); if (navigator.vibrate) navigator.vibrate(0);
  $('pingOverlay').classList.add('hidden');
};

// ---------- notifications & push ----------
let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(r => { swReg = r; maybeSubscribePush(); }).catch(() => {});
navigator.serviceWorker?.addEventListener('message', e => { if (e.data && e.data.type === 'ping') showPing(e.data.from, e.data.text, e.data.urgent); });
{ const q = new URLSearchParams(location.search); if (q.get('ping')) setTimeout(() => showPing(q.get('ping'), q.get('msg') || ''), 500); }

function urlB64ToUint8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function maybeSubscribePush() {
  if (!swReg || !vapidKey || !('PushManager' in window) || Notification.permission !== 'granted') return;
  try {
    const sub = (await swReg.pushManager.getSubscription()) ||
      (await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidKey) }));
    send({ t: 'pushsub', sub: sub.toJSON() });
  } catch (e) { console.warn('push subscribe failed', e); }
}
$('notifyBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('Notifications are not supported here. On iPhone, add the app to your Home Screen first.');
  const p = await Notification.requestPermission();
  if (p === 'granted') { await maybeSubscribePush(); toast('Notifications on. Pings will reach you even when the app is closed.'); }
  else toast('Notifications were not allowed.');
};
function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const opts = { body, tag, icon: '/icon.svg', vibrate: [300, 100, 300] };
  if (swReg) swReg.showNotification(title, opts); else new Notification(title, opts);
}

// ---------- arrive / leave alerts ----------
let alerts = store.get('alerts', []);
let fenceState = store.get('fenceState', {}); // `${alertId}|${memberId}` -> true (inside) / false
const alertLayers = new Map();
let pickMode = false, picked = null, pickMarker = null;

function setPicked(latlng) {
  picked = { lat: latlng.lat, lng: latlng.lng };
  pickMode = false;
  $('alPicked').textContent = `${picked.lat.toFixed(4)}, ${picked.lng.toFixed(4)}`;
  $('alQuery').value = '';
  if (pickMarker) pickMarker.remove();
  pickMarker = L.circle([picked.lat, picked.lng], { radius: +$('alRadius').value, color: '#1f6feb', dashArray: '4' }).addTo(map);
  $('alertsPanel').classList.remove('hidden');
}
$('alPick').onclick = () => { pickMode = true; $('alertsPanel').classList.add('hidden'); toast('Tap the map to choose the centre of the area.'); };
$('alRadius').oninput = () => {
  const r = +$('alRadius').value;
  $('alRadiusText').textContent = r >= 1000 ? `${(r / 1000).toFixed(1)} km (${(r / 1609.344).toFixed(1)} mi)` : `${r} m`;
  if (pickMarker) pickMarker.setRadius(r);
};
$('alQuery').addEventListener('change', async () => {
  const q = $('alQuery').value.trim();
  if (!q) return;
  try {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(q)).then(r => (r.ok ? r.json() : Promise.reject()));
    picked = { lat: r.lat, lng: r.lng };
    $('alPicked').textContent = `📍 ${r.label}`;
    if (!$('alName').value) $('alName').value = r.label;
    $('alRadius').value = r.radius; $('alRadius').oninput();
    if (pickMarker) pickMarker.remove();
    pickMarker = L.circle([r.lat, r.lng], { radius: r.radius, color: '#1f6feb', dashArray: '4' }).addTo(map);
    map.fitBounds(pickMarker.getBounds());
    $('alError').textContent = '';
  } catch { $('alError').textContent = "Couldn't find that postcode or place."; picked = null; $('alPicked').textContent = ''; }
});
$('alertForm').onsubmit = async e => {
  e.preventDefault();
  if (!picked && $('alQuery').value.trim()) { await new Promise(r => { $('alQuery').dispatchEvent(new Event('change')); setTimeout(r, 1500); }); }
  if (!picked) return ($('alError').textContent = 'Enter a postcode/place or pick a spot on the map.');
  const a = { id: String(Date.now()), name: $('alName').value.trim(), lat: picked.lat, lng: picked.lng, radius: +$('alRadius').value, who: $('alWho').value };
  alerts.push(a); store.set('alerts', alerts);
  // Seed current inside/outside state silently so we only alert on real changes.
  members.forEach(m => { if (hasLoc(m)) fenceState[a.id + '|' + m.id] = distM(m, a) <= a.radius; });
  store.set('fenceState', fenceState);
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  picked = null; $('alertForm').reset(); $('alPicked').textContent = ''; $('alRadius').oninput(); $('alError').textContent = '';
  renderAlertsOnMap();
  toast(`Alert added for "${a.name}".`);
};
function renderAlertsOnMap() {
  alertLayers.forEach(l => l.remove()); alertLayers.clear();
  alerts.forEach(a => {
    const c = L.circle([a.lat, a.lng], { radius: a.radius, color: '#8250df', weight: 2, fillOpacity: 0.08 }).addTo(map);
    c.bindTooltip(a.name, { permanent: false });
    alertLayers.set(a.id, c);
  });
  $('alertList').innerHTML = alerts.map(a => {
    const who = a.who === '*' ? 'anyone' : (members.get(a.who)?.name || 'someone');
    return `<li data-id="${a.id}"><div class="grow"><b>${esc(a.name)}</b><div class="muted small">${a.radius} m radius · ${esc(who)}</div></div>
      <button class="small" data-del="${a.id}">Delete</button></li>`;
  }).join('') || '<li class="muted">No alerts yet.</li>';
}
$('alertList').onclick = e => {
  const del = e.target.dataset.del;
  if (del) { alerts = alerts.filter(a => a.id !== del); store.set('alerts', alerts); renderAlertsOnMap(); return; }
  const li = e.target.closest('li[data-id]');
  const a = li && alerts.find(x => x.id === li.dataset.id);
  if (a) { map.fitBounds(alertLayers.get(a.id).getBounds()); setFollowing(false); }
};
function checkGeofences(m, prev) {
  if (!hasLoc(m)) return;
  if (prev && prev.lat === m.lat && prev.lng === m.lng) return;
  let changed = false;
  for (const a of alerts) {
    if (a.who !== '*' && a.who !== m.id) continue;
    const key = a.id + '|' + m.id, d = distM(m, a), was = fenceState[key];
    // Hysteresis: must be clearly outside to count as having left, to avoid GPS jitter flapping.
    const inside = was ? d <= a.radius + Math.max(25, Math.min(m.acc || 0, 100)) : d <= a.radius;
    if (was === undefined) { fenceState[key] = inside; changed = true; continue; }
    if (inside !== was) {
      fenceState[key] = inside; changed = true;
      const who = m.id === me.id ? 'You' : m.name;
      const text = inside ? `📍 ${who} ${m.id === me.id ? 'have' : 'has'} arrived at ${a.name}` : `🚶 ${who} ${m.id === me.id ? 'have' : 'has'} left ${a.name}`;
      toast(text, 8000);
      notify(text, m.address || '', 'fence-' + key);
    }
  }
  if (changed) store.set('fenceState', fenceState);
}

// ---------- top bar & panels ----------
function togglePanel(id) {
  ['peoplePanel', 'alertsPanel', 'menuPanel', 'bgPanel', 'pingPanel'].forEach(p => { if (p !== id) $(p).classList.add('hidden'); });
  $(id).classList.toggle('hidden');
}
$('peopleBtn').onclick = () => togglePanel('peoplePanel');
$('alertsBtn').onclick = () => togglePanel('alertsPanel');
$('menuBtn').onclick = () => togglePanel('menuPanel');
$('bgBtn').onclick = $('bgBtn2').onclick = () => { setupBackground(); togglePanel('bgPanel'); };
$('otConnect').addEventListener('click', () => { store.set('bgSetup', true); renderMine(); });
$('otCopy').onclick = () => { navigator.clipboard?.writeText($('otUrl').value).then(() => toast('URL copied.')).catch(() => {}); };
document.querySelectorAll('[data-close]').forEach(b => (b.onclick = () => $(b.dataset.close).classList.add('hidden')));
$('followBtn').onclick = () => { setFollowing(!following); if (following) followSelected(true); };
$('codeBtn').onclick = async () => {
  const url = `${location.origin}/?code=${me.code}`;
  const text = `Join me on Live Tracker. Code: ${me.code}`;
  try { if (navigator.share) await navigator.share({ title: 'Live Tracker', text, url }); else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Join link copied.'); } } catch {}
};
$('renameBtn').onclick = () => {
  const n = prompt('Your name', me.name);
  if (n && n.trim()) { me.name = n.trim().slice(0, 30); store.set('name', me.name); send({ t: 'hello', id: me.id, name: me.name, code: me.code, sharing: me.sharing, token: me.token, visible: document.visibilityState === 'visible' }); }
};
$('leaveBtn').onclick = () => {
  if (!confirm('Leave this group? You will stop sharing and disappear from everyone\'s map.')) return;
  stopSharing(); send({ t: 'leave' });
  me.code = ''; store.del('code'); store.del('selected');
  members.clear(); markers.forEach(m => m.remove()); markers.clear(); selectedId = null; firstState = true;
  ws.close();
  $('menuPanel').classList.add('hidden');
  showJoin();
};

// Keep-awake option lives in the settings panel.
(() => {
  const b = document.createElement('button');
  const label = () => (b.textContent = `☀️ Keep screen awake while sharing: ${store.get('keepAwake', false) ? 'On' : 'Off'}`);
  b.onclick = () => { store.set('keepAwake', !store.get('keepAwake', false)); label(); store.get('keepAwake') && me.sharing ? requestWakeLock() : releaseWakeLock(); };
  label(); $('leaveBtn').before(b);
})();

let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = () => { installEvt?.prompt(); $('installBtn').classList.add('hidden'); };

function setPlatformNote() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('platformNote').textContent = ios
    ? 'iPhone: Safari does not allow vibration or battery level, and stops sending location when the app is in the background. Add this app to your Home Screen and enable notifications so emergency pings still alert you.'
    : 'Location is sent while the app is open. Browsers pause it when the app is in the background or the screen is off; turn on "Keep screen awake" for continuous tracking.';
}

// ---------- background tracking via OwnTracks ----------
function setupBackground() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const url = `${location.origin}/ot/${me.code}/${encodeURIComponent(me.id)}/${me.token}?name=${encodeURIComponent(me.name)}`;
  const config = {
    _type: 'configuration', mode: 3, url, auth: false, monitoring: 2, locatorInterval: 30, locatorDisplacement: 10,
    moveModeLocatorInterval: 30, pubExtendedData: true, tid: me.name.slice(0, 2).toUpperCase(), deviceId: 'phone',
  };
  $('otUrl').value = url;
  $('otConnect').href = 'owntracks:///config?inline=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(config)))));
  $('otStore').href = ios ? 'https://apps.apple.com/app/owntracks/id692424691'
    : 'https://play.google.com/store/apps/details?id=org.owntracks.android';
  $('otAlways').innerHTML = ios
    ? '3. When OwnTracks asks for location, choose <b>Allow While Using</b>, then later <b>Change to Always Allow</b> (or Settings → OwnTracks → Location → <b>Always</b>). In OwnTracks, tap the mode icon at the top and pick <b>Move</b>.'
    : '3. When OwnTracks asks for location, choose <b>Allow all the time</b>. If asked about battery optimisation, choose <b>Allow</b> / <b>Don\'t optimise</b> so it keeps running.';
}

// ---------- shared trips ----------
// Each driver's road route as a green line (the part still to drive) and a 🏁 at the destination.
const tripLayers = new Map();   // member id -> { key, layer }
function remainingRoute(m, route) {
  if (!hasLoc(m)) return route;
  let best = 0, bestD = Infinity;
  route.forEach((p, i) => { const d = (p[0] - m.lat) ** 2 + ((p[1] - m.lng) * Math.cos(m.lat * Math.PI / 180)) ** 2; if (d < bestD) { bestD = d; best = i; } });
  return [[m.lat, m.lng], ...route.slice(best + 1)];
}
function drawTrips() {
  if (!map) return;
  const seen = new Set();
  for (const m of members.values()) {
    const t = activeTrip(m);
    if (!t || !isFinite(t.destLat)) continue;
    seen.add(m.id);
    const key = `${t.destLat}|${t.destLng}|${t.route ? t.route.length + '|' + t.route[0] : ''}|${m.lat}|${m.lng}`;
    const old = tripLayers.get(m.id);
    if (old && old.key === key) continue;
    if (old) old.layer.remove();
    const layer = L.layerGroup();
    if (t.route) {
      const pts = remainingRoute(m, t.route);
      L.polyline(pts, { color: '#0b6b2e', weight: 9, opacity: 0.5, interactive: false }).addTo(layer);
      L.polyline(pts, { color: '#22c55e', weight: 5, opacity: 0.95, interactive: false }).addTo(layer);
    } else if (hasLoc(m)) {
      L.polyline([[m.lat, m.lng], [t.destLat, t.destLng]], { color: '#22c55e', weight: 3, dashArray: '6 8', opacity: 0.8, interactive: false }).addTo(layer);
    }
    L.marker([t.destLat, t.destLng], { icon: L.divIcon({ className: 'home-marker', html: '🏁', iconSize: [28, 28], iconAnchor: [6, 26] }) })
      .bindTooltip(`${m.name} → ${t.destName}`).addTo(layer);
    layer.addTo(map);
    tripLayers.set(m.id, { key, layer });
  }
  for (const [id, v] of tripLayers) if (!seen.has(id)) { v.layer.remove(); tripLayers.delete(id); }
}
function renderTrips() {
  drawTrips();
  const list = [...members.values()].filter(m => m.id !== me.id && activeTrip(m));
  $('tripBanner').innerHTML = list.map(m => `<button class="trip-chip" data-id="${esc(m.id)}"><b>${esc(m.name)}</b> ${esc(tripText(m, true).replace('🚗 Driving to', '→'))}</button>`).join('');
  $('tripBanner').classList.toggle('hidden', !list.length);
}
$('tripBanner').onclick = e => { const b = e.target.closest('[data-id]'); if (b) select(b.dataset.id); };
setInterval(() => { if (map) renderTrips(); }, 5000);

// ---------- Street View picture-in-picture ----------
// Uses Google's keyless Street View embed; it points the camera the way the person is heading.
let svOn = store.get('sv', !SIMPLE), svShown = null; // svShown: { id, lat, lng }
const svPrev = new Map(); // id -> last position used to work out heading
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function updateStreetView(force) {
  const m = members.get(selectedId);
  $('svBtn').classList.toggle('on', svOn);
  if (!svOn || !hasLoc(m)) { $('svBox').classList.add('hidden'); svShown = null; return; }
  $('svBox').classList.remove('hidden');
  $('svName').textContent = m.name;
  // Only reload the view when they've moved a bit, so it doesn't flicker every 10 seconds.
  if (!force && svShown && svShown.id === m.id && distM(svShown, m) < 25) return;
  const prev = svPrev.get(m.id);
  const heading = prev && distM(prev, m) > 10 ? Math.round(bearing(prev, m)) : 0;
  svPrev.set(m.id, { lat: m.lat, lng: m.lng });
  svShown = { id: m.id, lat: m.lat, lng: m.lng };
  $('svFrame').src = `https://maps.google.com/maps?layer=c&cbll=${m.lat},${m.lng}&cbp=11,${heading},0,0,0&output=svembed`;
  $('svOpen').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${m.lat},${m.lng}&heading=${heading}`;
}
$('svBtn').onclick = () => { svOn = !svOn; store.set('sv', svOn); updateStreetView(true); };
$('svClose').onclick = () => { svOn = false; store.set('sv', false); updateStreetView(); };
$('svSize').onclick = () => $('svBox').classList.toggle('big');

// ---------- partner app ----------
if (SIMPLE) {
  document.querySelector('#join h1').textContent = '💞 Family Tracker';
  document.querySelector('#join p.muted').textContent = 'See where your people are and when they\'ll be home.';
  const lm = document.querySelector('link[rel="apple-touch-icon"]'); if (lm) lm.href = '/icon-partner-192.png';
}

// ---------- boot ----------
if (me.name && me.code) startApp(); else showJoin();

// ---------- emotes: a big emoji floats up on everyone's screen ----------
const EMOTES = ['😊', '❤️', '😘', '🥰', '😂', '👍', '👋', '🎉', '🙏', '😢', '🚗', '🏠'];
$('emoteTray').innerHTML = EMOTES.map(e => `<button data-e="${e}">${e}</button>`).join('');
$('emoteBtn').onclick = () => $('emoteTray').classList.toggle('hidden');
$('emoteTray').onclick = e => {
  const b = e.target.closest('[data-e]'); if (!b) return;
  if (!ws || ws.readyState !== 1) return toast('Not connected right now, try again in a moment.');
  send({ t: 'emote', e: b.dataset.e });
  $('emoteTray').classList.add('hidden');
};
function showEmote({ fromId, name, e }) {
  const layer = $('emoteLayer');
  for (let i = 0; i < 7; i++) {
    const el = document.createElement('div');
    el.className = 'emote-float';
    el.textContent = e;
    el.style.left = (10 + Math.random() * 80) + '%';
    el.style.fontSize = (i === 0 ? 96 : 36 + Math.random() * 30) + 'px';
    el.style.animationDelay = (i === 0 ? 0 : Math.random() * 0.8) + 's';
    if (i === 0) el.style.left = '50%';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
  const label = document.createElement('div');
  label.className = 'emote-label';
  label.textContent = `${fromId === me.id ? 'You' : name} sent ${e}`;
  layer.appendChild(label);
  setTimeout(() => label.remove(), 3500);
  if (fromId !== me.id && navigator.vibrate) navigator.vibrate(80);
}
