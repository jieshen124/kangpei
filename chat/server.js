'use strict';

/**
 * 多人聊天室（含在线用户城市级位置）
 * - 账号：用户名 + 密码（scrypt 加盐哈希）
 * - 会话：HttpOnly Cookie + 内存 session（7 天）
 * - 实时：WebSocket 广播
 * - 位置：按客户端 IP 查询归属地（城市级，非精确坐标），带 24h 缓存
 * - 隐私：用户可关闭位置展示；仅存 IP 掩码，不存完整 IP
 * 仅依赖 ws，监听 127.0.0.1:3000，由 nginx 反代
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const HOST = '127.0.0.1';
const DATA_DIR = '/var/lib/chat';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_MSG_LEN = 500;
const MAX_HISTORY = 200;
const KEEP_MESSAGES = 1000;
const MAX_BODY = 8 * 1024;
const LOC_TTL = 24 * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- 账号 */
let users = {};
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {};
} catch (e) {
  users = {};
}

function saveUsers() {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function hashPwd(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = {
    salt,
    hash: hashPwd(password, salt),
    createdAt: Date.now(),
    loc: null,
    hideLoc: false,
  };
  saveUsers();
}

function verifyUser(username, password) {
  const u = users[username];
  if (!u) return false;
  const h = Buffer.from(hashPwd(password, u.salt), 'hex');
  const saved = Buffer.from(u.hash, 'hex');
  if (h.length !== saved.length) return false;
  return crypto.timingSafeEqual(h, saved);
}

/* ------------------------------------------------------------ 位置查询 */
const locCache = new Map(); // ip -> { loc, ts }

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('127.')) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip)) return true;
  return false;
}

function maskIp(ip) {
  if (!ip) return '';
  const parts = String(ip).split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return String(ip).slice(0, 8) + '…';
}

function fetchJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function resolveLocation(ip) {
  if (!ip || isPrivateIp(ip)) {
    return { country: '', region: '', city: '本地', isp: '', source: 'local' };
  }
  const cached = locCache.get(ip);
  if (cached && Date.now() - cached.ts < LOC_TTL) return cached.loc;

  let loc = null;

  // 主：ip-api.com（支持中文返回，国内 IP 精度较好；限速 45 次/分，靠缓存兜底）
  try {
    const q = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`;
    const j = await fetchJson(q);
    if (j && j.status === 'success') {
      loc = {
        country: j.country || '',
        region: j.regionName || '',
        city: j.city || '',
        isp: j.isp || '',
        source: 'ip-api',
      };
    }
  } catch (e) { /* 走备用 */ }

  // 备：ipinfo.io（城市名多为英文）
  if (!loc || !loc.city) {
    try {
      const j = await fetchJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`);
      if (j && (j.city || j.region)) {
        loc = {
          country: j.country || '',
          region: j.region || '',
          city: j.city || '',
          isp: j.org || '',
          source: 'ipinfo',
        };
      }
    } catch (e) { /* 忽略 */ }
  }

  if (!loc) loc = { country: '', region: '', city: '未知', isp: '', source: 'none' };

  locCache.set(ip, { loc, ts: Date.now() });
  if (locCache.size > 3000) {
    const oldest = [...locCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
    oldest.forEach(([k]) => locCache.delete(k));
  }
  return loc;
}

/** 刷新用户位置，写入 users.json（只存 IP 掩码） */
async function refreshUserLocation(username, ip) {
  const u = users[username];
  if (!u) return null;
  const loc = await resolveLocation(ip);
  u.loc = {
    city: loc.city,
    region: loc.region,
    country: loc.country,
    isp: loc.isp,
    ipMasked: maskIp(ip),
    ts: Date.now(),
  };
  saveUsers();
  return u.loc;
}

/** 给前端展示的位置文本 */
function locText(u) {
  if (!u) return '';
  if (u.hideLoc) return '已隐藏';
  const l = u.loc;
  if (!l) return '未知';
  const parts = [l.region, l.city].filter(Boolean);
  if (!parts.length) return '未知';
  const uniq = parts.filter((v, i) => parts.indexOf(v) === i); // 去掉「上海 上海」这种重复
  return uniq.join(' ');
}

/* ---------------------------------------------------------------- 消息 */
let messages = [];
let lastId = 0;
try {
  const raw = fs.readFileSync(MSG_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      messages.push(m);
      if (m.id > lastId) lastId = m.id;
    } catch (e) { /* 跳过坏行 */ }
  }
  if (messages.length > KEEP_MESSAGES) messages = messages.slice(-KEEP_MESSAGES);
} catch (e) { /* 首次启动 */ }

function addMessage(username, text) {
  const u = users[username] || {};
  const m = {
    id: ++lastId,
    user: username,
    text,
    ts: Date.now(),
    city: u.hideLoc ? '' : ((u.loc || {}).city || ''),
  };
  messages.push(m);
  if (messages.length > KEEP_MESSAGES) messages.shift();
  fs.appendFile(MSG_FILE, JSON.stringify(m) + '\n', () => {});
  return m;
}

/* ---------------------------------------------------------------- 会话 */
const sessions = new Map(); // token -> { username, exp }

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, exp: Date.now() + SESSION_TTL });
  return token;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionUser(req) {
  const c = parseCookies(req.headers.cookie);
  if (!c.sid) return null;
  const s = sessions.get(c.sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(c.sid); return null; }
  return s.username;
}

function cookieHeader(token) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
}

function clientIp(req) {
  const ra = req.headers['x-real-ip'];
  if (ra) return String(ra).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

/* ---------------------------------------------------------------- 限流 */
const loginAttempts = new Map();

function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.reset) { loginAttempts.delete(ip); return false; }
  return rec.count >= 8;
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  loginAttempts.set(ip, rec);
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------ HTTP 工具 */
function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('页面文件缺失');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(data);
  });
}

const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/;
const TEXT_OK = (t) => typeof t === 'string' && t.trim().length > 0 && t.length <= MAX_MSG_LEN;

/* ---------------------------------------------------------------- HTTP */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, err: 'method' });
      return serveIndex(res);
    }

    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (p === '/health') return json(res, 200, { ok: true, online: onlineUsernames().length });

    if (p === '/api/me') {
      const user = sessionUser(req);
      if (!user) return json(res, 200, { ok: true, user: null });
      const u = users[user] || {};
      return json(res, 200, { ok: true, user, hideLoc: !!u.hideLoc, location: locText(u) });
    }

    if (p === '/api/history') {
      const user = sessionUser(req);
      if (!user) return json(res, 401, { ok: false, err: '未登录' });
      return json(res, 200, { ok: true, messages: messages.slice(-MAX_HISTORY) });
    }

    if (p === '/api/online') {
      const user = sessionUser(req);
      if (!user) return json(res, 401, { ok: false, err: '未登录' });
      return json(res, 200, { ok: true, users: presenceList() });
    }

    // 隐私开关：是否展示我的位置
    if (p === '/api/privacy' && req.method === 'POST') {
      const user = sessionUser(req);
      if (!user) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      users[user].hideLoc = !!body.hideLoc;
      saveUsers();
      presence();
      return json(res, 200, { ok: true, hideLoc: users[user].hideLoc, location: locText(users[user]) });
    }

    if (p === '/api/register' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!USERNAME_RE.test(username)) {
        return json(res, 400, { ok: false, err: '用户名需 2-20 位，只能是中文、字母、数字、下划线或短横线' });
      }
      if (password.length < 6 || password.length > 64) {
        return json(res, 400, { ok: false, err: '密码长度需 6-64 位' });
      }
      if (users[username]) {
        return json(res, 409, { ok: false, err: '这个用户名已经被注册了' });
      }
      createUser(username, password);
      await refreshUserLocation(username, ip);
      const token = createSession(username);
      return json(res, 200, {
        ok: true, user: username, hideLoc: false, location: locText(users[username]),
      }, { 'Set-Cookie': cookieHeader(token) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (loginBlocked(ip)) return json(res, 429, { ok: false, err: '尝试次数过多，请 10 分钟后再试' });
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!verifyUser(username, password)) {
        recordLoginFail(ip);
        return json(res, 401, { ok: false, err: '用户名或密码不正确' });
      }
      const u = users[username];
      // 24 小时刷新一次，或 IP 变了才重新查询，避免频繁打外部接口
      if (!u.loc || Date.now() - (u.loc.ts || 0) > LOC_TTL || u.loc.ipMasked !== maskIp(ip)) {
        await refreshUserLocation(username, ip);
      }
      const token = createSession(username);
      return json(res, 200, {
        ok: true, user: username, hideLoc: !!u.hideLoc, location: locText(u),
      }, { 'Set-Cookie': cookieHeader(token) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const c = parseCookies(req.headers.cookie);
      if (c.sid) sessions.delete(c.sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' });
    }

    return json(res, 404, { ok: false, err: 'not found' });
  } catch (e) {
    return json(res, 400, { ok: false, err: '请求格式错误' });
  }
});

/* ------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function onlineUsernames() {
  return [...new Set([...clients].map((ws) => ws.username).filter(Boolean))];
}

function presenceList() {
  return onlineUsernames().sort().map((name) => ({
    user: name,
    location: locText(users[name]),
    hide: !!(users[name] || {}).hideLoc,
  }));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function presence() {
  broadcast({ type: 'presence', users: presenceList() });
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* ignore */ }
  if (pathname !== '/ws') { socket.destroy(); return; }

  const username = sessionUser(req);
  if (!username) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.username = username;
    ws.isAlive = true;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'history', messages: messages.slice(-MAX_HISTORY) }));
  presence();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    if (data && data.type === 'send') {
      if (!TEXT_OK(data.text)) return;
      const now = Date.now();
      if (now - (ws.lastMsgAt || 0) < 300) return;
      ws.lastMsgAt = now;
      const m = addMessage(ws.username, data.text.trim());
      broadcast({ type: 'msg', message: m });
    }
  });

  ws.on('close', () => { clients.delete(ws); presence(); });
  ws.on('error', () => { clients.delete(ws); });
});

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      try { ws.terminate(); } catch (e) { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30 * 1000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`[chat] listening on http://${HOST}:${PORT}, users=${Object.keys(users).length}, messages=${messages.length}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[chat] ${sig} received, closing`);
    server.close(() => process.exit(0));
  });
}
