// Openline signaling + matchmaking server
// - Serves the web client
// - User accounts: sign up, log in, log out (cookie sessions, SQLite storage)
// - Age verification gate on each account before it can be matched
// - Pairs verified adults at random and relays WebRTC signaling between them
// Video/audio NEVER passes through this server: calls are peer-to-peer and
// encrypted with DTLS-SRTP by the browsers.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// Self-declared date of birth is always on in development. In production it is
// off unless explicitly allowed, because a typed-in birthday is easily faked.
const SELF_DECLARED_AGE = !IS_PROD || process.env.ALLOW_SELF_DECLARED_AGE === 'true';
// Number of reverse proxies in front of the app (Render, Fly, nginx...), so
// rate limits see the visitor's real IP address.
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? (IS_PROD ? 1 : 0));
const ICE_SERVERS = buildIceServers();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'openline.db');
const SESSION_COOKIE = 'ol_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // stay logged in for 30 days
const SUSPEND_AFTER_REPORTS = 3;                    // distinct reporters before auto-suspend
const FIND_LIMIT = { max: 20, windowMs: 60_000 };
const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60_000 }; // failed attempts per IP
const SIGNUP_LIMIT = { max: 5, windowMs: 60 * 60_000 }; // new accounts per IP
const FEEDBACK_LIMIT = { max: 10, windowMs: 60 * 60_000 }; // feedback messages per IP
const MAX_MSG_BYTES = 64 * 1024;
const INTEREST_WAIT_MS = 5000;        // how long to hold out for a shared interest
const MAX_INTERESTS = 5;
const HEARTBEAT_MS = 30_000;

// STUN finds a public address; TURN relays the call when two people can't
// connect directly (strict NATs, some mobile networks). Without TURN, roughly
// 10-20% of calls fail.
function buildIceServers() {
  const servers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((u) => u.trim()) }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls: process.env.TURN_URLS.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

// ---------- Database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    verified_at   INTEGER,
    suspended_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,
    reporter TEXT NOT NULL,
    target   TEXT NOT NULL,
    reason   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_target ON reports(target);
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    message    TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE TABLE IF NOT EXISTS blocked_pairs (pair TEXT PRIMARY KEY);
`);
// Added after the first release: when a moderator lifted a suspension.
// Reports made before then no longer count toward a new automatic suspension.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'cleared_at')) {
  db.exec('ALTER TABLE users ADD COLUMN cleared_at INTEGER');
}

const q = {
  userByEmail:   db.prepare('SELECT * FROM users WHERE email = ?'),
  userById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser:    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  verifyUser:    db.prepare('UPDATE users SET verified_at = ? WHERE id = ?'),
  setPassword:   db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser:    db.prepare('DELETE FROM users WHERE id = ?'),
  suspendUser:   db.prepare('UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL'),
  insertSession: db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser:   db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.id_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
  deleteUserSessions:      db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  deleteOtherUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  insertReport:  db.prepare('INSERT INTO reports (at, reporter, target, reason) VALUES (?, ?, ?, ?)'),
  reporterCount: db.prepare(`SELECT COUNT(DISTINCT reporter) AS n FROM reports
                             WHERE target = ? AND at > COALESCE((SELECT cleared_at FROM users WHERE id = ?), 0)`),
  blockPair:     db.prepare('INSERT OR IGNORE INTO blocked_pairs (pair) VALUES (?)'),
  insertFeedback: db.prepare('INSERT INTO feedback (at, user_id, message, user_agent) VALUES (?, ?, ?, ?)'),
  isBlocked:     db.prepare('SELECT 1 FROM blocked_pairs WHERE pair = ?'),
};

setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60_000).unref();

// ---------- Passwords (scrypt, built into Node) ----------
const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

// Compared against when the email doesn't exist, so response time doesn't
// reveal which emails have accounts.
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------- Sessions ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

function sessionHashFrom(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return sid ? sha256(sid) : null;
}

function userFromRequest(req) {
  const h = sessionHashFrom(req);
  return h ? q.sessionUser.get(h, Date.now()) || null : null;
}

function startSession(res, userId) {
  // Only the hash is stored, so a leaked database can't be used to log in.
  const sid = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(sid), userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/', maxAge: SESSION_TTL_MS,
  });
}

// Browsers send Origin on cross-site requests; refuse anything from another site.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return !IS_PROD;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const publicUser = (u) => ({
  email: u.email,
  verified: Boolean(u.verified_at),
  suspended: Boolean(u.suspended_at),
});

// ---------- HTTP app ----------
const app = express();
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Older Safari doesn't count ws:/wss: as 'self', so name the socket origin.
  const host = /^[a-z0-9.:[\]-]+$/i.test(req.headers.host || '') ? req.headers.host : '';
  const wsSrc = host ? ` ${IS_PROD ? 'wss' : 'ws'}://${host}` : '';
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      `connect-src 'self'${wsSrc}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin.' });
  req.user = userFromRequest(req);
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Log in to continue.' });

// Per-IP throttles (in memory).
function rateLimiter({ max, windowMs }) {
  const hits = new Map(); // ip -> [timestamps]
  setInterval(() => {
    const now = Date.now();
    for (const [ip, list] of hits) if (list.every((t) => now - t >= windowMs)) hits.delete(ip);
  }, windowMs).unref();
  return {
    blocked(ip) {
      const now = Date.now();
      const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
      hits.set(ip, recent);
      return recent.length >= max;
    },
    hit(ip) {
      if (!hits.has(ip)) hits.set(ip, []);
      hits.get(ip).push(Date.now());
    },
  };
}
const loginLimiter = rateLimiter(LOGIN_LIMIT);   // counts failed password checks
const signupLimiter = rateLimiter(SIGNUP_LIMIT); // counts accounts created
const feedbackLimiter = rateLimiter(FEEDBACK_LIMIT);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  return { email, password };
}

app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/config', (_req, res) => res.json({ selfDeclaredAge: SELF_DECLARED_AGE, dev: !IS_PROD }));

// Connection servers, including TURN credentials, only go to people who can call.
app.get('/api/ice', requireUser, (req, res) => {
  if (!req.user.verified_at || req.user.suspended_at) return res.status(403).json({ error: 'Not allowed.' });
  res.set('Cache-Control', 'no-store').json({ iceServers: ICE_SERVERS });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

app.post('/api/signup', async (req, res) => {
  if (signupLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Too many new accounts from this network. Try again later.' });
  const { email, password } = readCredentials(req.body);
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long.' });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });

  const id = crypto.randomUUID();
  try {
    q.insertUser.run(id, email, await hashPassword(password), Date.now());
  } catch {
    return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });
  }
  signupLimiter.hit(req.ip);
  startSession(res, id);
  res.status(201).json({ user: publicUser(q.userById.get(id)) });
});

app.post('/api/login', async (req, res) => {
  if (loginLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes, then try again.' });
  const { email, password } = readCredentials(req.body);
  const user = email ? q.userByEmail.get(email) : null;
  const ok = await checkPassword(password, user ? user.password_hash : await DUMMY_HASH_PROMISE);
  if (!user || !ok) {
    loginLimiter.hit(req.ip);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

// Read with: npm run admin -- feedback
app.post('/api/feedback', requireUser, (req, res) => {
  if (feedbackLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Thanks! You\'ve sent a lot of feedback. Try again in a while.' });
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Write a message first.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Keep it under 2000 characters.' });
  // The browser name helps reproduce bugs ("calls fail on Safari").
  q.insertFeedback.run(Date.now(), req.user.id, message, String(req.headers['user-agent'] || '').slice(0, 300));
  feedbackLimiter.hit(req.ip);
  res.status(201).json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const h = sessionHashFrom(req);
  if (h) {
    q.deleteSession.run(h);
    for (const c of clientsBySession.get(h) || []) c.ws.close(4001, 'logged out');
  }
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' });
  res.json({ ok: true });
});

// ---------- Account settings ----------
// Each of these re-checks the current password, so a session left open on a
// shared computer can't be used to take over or delete the account.
async function confirmPassword(req, res) {
  if (loginLimiter.blocked(req.ip)) {
    res.status(429).json({ error: 'Too many attempts. Wait 15 minutes, then try again.' });
    return false;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (await checkPassword(password, req.user.password_hash)) return true;
  loginLimiter.hit(req.ip);
  res.status(401).json({ error: 'Current password is incorrect.' });
  return false;
}

function closeSockets(map, key, code, reason) {
  for (const c of map.get(key) || []) c.ws.close(code, reason);
}

app.post('/api/account/password', requireUser, async (req, res) => {
  const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (next.length < 8) return res.status(400).json({ error: 'Use a new password of at least 8 characters.' });
  if (next.length > 200) return res.status(400).json({ error: 'That password is too long.' });
  if (!(await confirmPassword(req, res))) return;
  q.setPassword.run(await hashPassword(next), req.user.id);
  // Sign out everywhere else, in case the old password was known to someone.
  const current = sessionHashFrom(req);
  q.deleteOtherUserSessions.run(req.user.id, current);
  for (const c of clientsBySub.get(req.user.id) || []) if (c.sessionHash !== current) c.ws.close(4001, 'password changed');
  res.json({ ok: true });
});

app.post('/api/account/logout-all', requireUser, (req, res) => {
  q.deleteUserSessions.run(req.user.id);
  closeSockets(clientsBySub, req.user.id, 4001, 'logged out');
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' });
  res.json({ ok: true });
});

app.post('/api/account/delete', requireUser, async (req, res) => {
  // Keep suspended accounts so moderators can review them.
  if (req.user.suspended_at) return res.status(403).json({ error: 'Suspended accounts can\'t be deleted while under review.' });
  if (!(await confirmPassword(req, res))) return;
  q.deleteUserSessions.run(req.user.id);
  q.deleteUser.run(req.user.id);
  closeSockets(clientsBySub, req.user.id, 4001, 'account deleted');
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' });
  res.json({ ok: true });
});

// ---------- Age verification ----------
// STRONGER OPTION: replace this with a real provider (Yoti, Persona, Veriff...).
// Their webhook/callback tells you the logged-in user passed an 18+ check;
// set verified_at on that account. Store the provider's stable person id too,
// and refuse to verify a second account for the same person, so bans can't be
// dodged by signing up again.
//
// SELF-DECLARED: the user types their date of birth. Always on in development;
// in production only when ALLOW_SELF_DECLARED_AGE=true.
function ageFromDob(dob) {
  const d = new Date(dob);
  if (!dob || Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

app.post('/api/verify/age', requireUser, (req, res) => {
  if (!SELF_DECLARED_AGE) return res.status(404).json({ error: 'Age verification is not available yet.' });
  const age = ageFromDob(req.body && req.body.dob);
  if (age === null) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  if (age < 18) return res.status(403).json({ error: 'You must be 18 or older to use Openline.' });
  q.verifyUser.run(Date.now(), req.user.id);
  res.json({ user: publicUser(q.userById.get(req.user.id)) });
});

// ---------- Matchmaking state (live connections stay in memory) ----------
const clientsBySub = new Map();       // user id -> Set(clients)
const clientsBySession = new Map();   // session hash -> Set(clients)
let waiting = [];

const pairKey = (a, b) => [a, b].sort().join('|');

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function removeFromQueue(client) {
  waiting = waiting.filter((c) => c !== client);
}

function unpair(client, notifyPeer = true) {
  const peer = client.peer;
  if (!peer) return;
  client.peer = null;
  peer.peer = null;
  if (notifyPeer) send(peer.ws, { type: 'peer-left' });
}

function normalizeInterests(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24);
    if (tag) out.add(tag);
    if (out.size >= MAX_INTERESTS) break;
  }
  return [...out];
}

// Someone with interests holds out for a shared one for a few seconds, then
// takes anyone. Someone without interests is open to anyone right away.
const isOpen = (c, now) => !c.interests.length || now - c.since >= INTEREST_WAIT_MS;

function pickPartner(client, now) {
  let fallback = null;
  for (const c of waiting) {
    if (c === client || c.ws.readyState !== 1 || c.sub === client.sub) continue;
    if (q.isBlocked.get(pairKey(c.sub, client.sub))) continue;
    const common = client.interests.filter((t) => c.interests.includes(t));
    if (common.length) return { peer: c, common };
    if (!fallback && isOpen(client, now) && isOpen(c, now)) fallback = { peer: c, common: [] };
  }
  return fallback;
}

function pair(a, b, common) {
  removeFromQueue(a);
  removeFromQueue(b);
  a.peer = b;
  b.peer = a;
  send(a.ws, { type: 'matched', role: 'caller', common });
  send(b.ws, { type: 'matched', role: 'callee', common });
}

function findMatch(client, interests) {
  removeFromQueue(client);
  client.interests = normalizeInterests(interests);
  client.since = Date.now();
  const match = pickPartner(client, client.since);
  if (match) return pair(client, match.peer, match.common);
  waiting.push(client);
  send(client.ws, { type: 'waiting', interests: client.interests });
}

// Pairs people whose interest wait has run out.
setInterval(() => {
  const now = Date.now();
  for (const c of [...waiting]) {
    if (!waiting.includes(c) || !isOpen(c, now)) continue;
    const match = pickPartner(c, now);
    if (match) pair(c, match.peer, match.common);
  }
}, 1000).unref();

// Online count: distinct logged-in users with an open connection.
let lastOnline = -1;
function broadcastOnline() {
  const count = clientsBySub.size;
  if (count === lastOnline) return;
  lastOnline = count;
  for (const set of clientsBySub.values()) for (const c of set) send(c.ws, { type: 'online', count });
}
setInterval(broadcastOnline, 3000).unref();

function withinRate(client) {
  const now = Date.now();
  client.finds = client.finds.filter((t) => now - t < FIND_LIMIT.windowMs);
  if (client.finds.length >= FIND_LIMIT.max) return false;
  client.finds.push(now);
  return true;
}

const REPORT_REASONS = new Set(['sexual', 'harassment', 'underage', 'spam', 'other']);

function handleReport(client, reason) {
  const peer = client.peer;
  if (!peer) return;
  const target = peer.sub;
  q.blockPair.run(pairKey(client.sub, target));
  q.insertReport.run(Date.now(), client.sub, target, reason); // review these in a moderation queue
  console.log('[report]', reason, 'against', target);

  unpair(client);
  send(client.ws, { type: 'reported' });

  // An "appears under 18" report suspends immediately pending human review.
  if (reason === 'underage' || q.reporterCount.get(target, target).n >= SUSPEND_AFTER_REPORTS) {
    q.suspendUser.run(Date.now(), target);
    for (const c of clientsBySub.get(target) || []) c.ws.close(4004, 'suspended');
  }
}

function track(map, key, client) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(client);
}

function untrack(map, key, client) {
  const set = map.get(key);
  if (!set) return;
  set.delete(client);
  if (!set.size) map.delete(key);
}

// ---------- WebSocket signaling ----------
// The socket is authenticated by the same session cookie as the website.
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  // Stops other sites from opening a socket with this user's cookie.
  if (!sameOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  // ws emits 'error' for bad frames (e.g. over maxPayload) and then closes the
  // socket; without a listener Node treats it as fatal.
  ws.on('error', () => {});
  const sessionHash = sessionHashFrom(req);
  const user = sessionHash ? q.sessionUser.get(sessionHash, Date.now()) : null;
  if (!user) return ws.close(4001, 'log in required');
  if (!user.verified_at) return ws.close(4003, 'age verification required');
  if (user.suspended_at) return ws.close(4004, 'suspended');

  const client = { ws, sub: user.id, sessionHash, peer: null, finds: [], interests: [], since: 0, alive: true };
  track(clientsBySub, client.sub, client);
  track(clientsBySession, sessionHash, client);
  send(ws, { type: 'ready' });
  send(ws, { type: 'online', count: clientsBySub.size });
  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'find': {
        // Re-check the account, so moderator actions and logouts elsewhere take effect.
        const current = q.sessionUser.get(sessionHash, Date.now());
        if (!current) return ws.close(4001, 'logged out');
        if (current.suspended_at) return ws.close(4004, 'suspended');
        if (!withinRate(client)) {
          return send(ws, { type: 'error', message: 'Too many skips. Wait a minute, then try again.' });
        }
        unpair(client);
        findMatch(client, msg.interests);
        break;
      }
      case 'signal':
        // Relay SDP/ICE only to the current partner. Content is opaque to us.
        if (client.peer) send(client.peer.ws, { type: 'signal', data: msg.data });
        break;
      case 'report':
        handleReport(client, REPORT_REASONS.has(msg.reason) ? msg.reason : 'other');
        break;
      case 'leave':
        unpair(client);
        removeFromQueue(client);
        break;
    }
  });

  ws.on('close', () => {
    unpair(client);
    removeFromQueue(client);
    untrack(clientsBySub, client.sub, client);
    untrack(clientsBySession, sessionHash, client);
  });
});

// Drops connections that silently died (closed laptop, lost Wi-Fi) so they
// don't sit in the queue or hold a partner.
setInterval(() => {
  for (const set of clientsBySub.values()) {
    for (const c of set) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }
}, HEARTBEAT_MS).unref();

// Close the database cleanly when the host stops the process.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of wss.clients) c.close(1001, 'server restarting');
    server.close();
    db.close();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Openline running on http://localhost:${PORT}${IS_PROD ? ' (production)' : ' (development)'}`);
  if (IS_PROD && !SELF_DECLARED_AGE) console.warn('Age verification is off: nobody can be verified. Set ALLOW_SELF_DECLARED_AGE=true or connect a provider.');
  if (IS_PROD && !process.env.TURN_URLS) console.warn('No TURN server set (TURN_URLS): some users will not be able to connect.');
});
