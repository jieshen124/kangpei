'use strict';
const fs = require('fs');
const path = require('path');
const dbmod = require('./index');

/* ------------------------------------------------------------------ 初始化 */

function init(dbFile, legacyDir) {
  dbmod.open(dbFile);
  const imported = getMeta('legacy_imported');
  if (!imported) {
    const n = importLegacy(legacyDir);
    setMeta('legacy_imported', String(Date.now()));
    if (n > 0) console.log('[db] 已从历史 JSON 导入 ' + n + ' 条记录');
  }
  return dbmod.get();
}

function getMeta(k) {
  const r = dbmod.get().get('SELECT v FROM meta WHERE k = ?', [k]);
  return r ? r.v : null;
}

function setMeta(k, v) {
  dbmod.get().run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [k, String(v)]);
}

/* ------------------------------------------------------------ 历史数据导入 */

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : (v || fallback);
  } catch (e) { return fallback; }
}

function importLegacy(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let n = 0;
  const d = dbmod.get();

  const users = readJson(path.join(dir, 'users.json'), {});
  const t1 = Object.entries(users);
  if (t1.length) {
    dbmod.tx(() => {
      for (const [name, u] of t1) {
        d.run('INSERT OR REPLACE INTO users (name, role, data, created_at) VALUES (?, ?, ?, ?)',
          [name, String(u.role || 'patient'), JSON.stringify(u), Number(u.createdAt || 0)]);
      }
    });
    n += t1.length;
  }

  const bookings = readJson(path.join(dir, 'bookings.json'), null)
    || readJsonl(path.join(dir, 'bookings.jsonl'))
      .filter((x) => x && x.event === 'create' && x.b && x.b.id).map((x) => x.b);
  const scales = readJson(path.join(dir, 'scales.json'), null)
    || readJsonl(path.join(dir, 'scales.jsonl')).filter((x) => x && x.id);
  const assessments = readJson(path.join(dir, 'assessments.json'), null)
    || readJsonl(path.join(dir, 'assessments.jsonl')).filter((x) => x && x.id);
  const alerts = readJson(path.join(dir, 'alerts.json'), null)
    || readJsonl(path.join(dir, 'alerts.jsonl')).filter((x) => x && x.id);
  const reports = readJson(path.join(dir, 'reports.json'), []);
  const flows = readJson(path.join(dir, 'sessions.json'), []);
  const videos = readJson(path.join(dir, 'videos.json'), []);
  const watch = readJson(path.join(dir, 'watch.json'), {});

  if (bookings.length) {
    dbmod.tx(() => { bookings.forEach((b) => putBooking(d, b)); });
    n += bookings.length;
  }
  if (scales.length) {
    dbmod.tx(() => { scales.forEach((s) => putScale(d, s)); });
    n += scales.length;
  }
  if (assessments.length) {
    dbmod.tx(() => { assessments.forEach((a) => putAssessment(d, a)); });
    n += assessments.length;
  }
  if (alerts.length) {
    dbmod.tx(() => { alerts.forEach((a) => putAlert(d, a)); });
    n += alerts.length;
  }
  if (reports.length) {
    dbmod.tx(() => { reports.forEach((r) => putReport(d, r)); });
    n += reports.length;
  }
  if (flows.length) {
    dbmod.tx(() => { flows.forEach((f) => putFlow(d, f)); });
    n += flows.length;
  }
  if (videos.length) {
    dbmod.tx(() => { videos.forEach((v) => putVideo(d, v)); });
    n += videos.length;
  }
  const watchRows = Object.entries(watch || {});
  if (watchRows.length) {
    dbmod.tx(() => {
      for (const [user, per] of watchRows) {
        for (const [vid, w] of Object.entries(per || {})) {
          d.run('INSERT OR REPLACE INTO watch (user, video_id, pos, done, at) VALUES (?, ?, ?, ?, ?)',
            [user, vid, Number(w.pos || 0), w.done ? 1 : 0, Number(w.at || 0)]);
        }
      }
    });
    n += watchRows.length;
  }
  return n;
}

/* ------------------------------------------------------------------ 写入 */

function putBooking(d, b) {
  d.run('INSERT OR REPLACE INTO bookings (id, patient, supervisor, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    [b.id, b.patient || '', b.supervisor || '', b.status || '', Number(b.updatedAt || b.createdAt || 0), JSON.stringify(b)]);
}

function putScale(d, s) {
  d.run('INSERT OR REPLACE INTO scales (id, patient, supervisor, created_at, data) VALUES (?, ?, ?, ?, ?)',
    [s.id, s.patient || '', s.supervisor || '', Number(s.createdAt || 0), JSON.stringify(s)]);
}

function putAssessment(d, a) {
  d.run('INSERT OR REPLACE INTO assessments (id, patient, supervisor, type, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    [a.id, a.patient || '', a.supervisor || '', a.type || '', Number(a.createdAt || 0), JSON.stringify(a)]);
}

function putAlert(d, a) {
  d.run('INSERT OR REPLACE INTO alerts (id, patient, level, created_at, data) VALUES (?, ?, ?, ?, ?)',
    [a.id, a.patient || '', a.level || '', Number(a.createdAt || 0), JSON.stringify(a)]);
}

function putReport(d, r) {
  d.run('INSERT OR REPLACE INTO reports (id, patient, uploader, created_at, data) VALUES (?, ?, ?, ?, ?)',
    [r.id, r.patient || '', r.uploader || '', Number(r.createdAt || 0), JSON.stringify(r)]);
}

function putFlow(d, f) {
  d.run('INSERT OR REPLACE INTO flows (id, patient, supervisor, status, started_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    [f.id, f.patient || '', f.supervisor || '', f.status || '', Number(f.startedAt || 0), JSON.stringify(f)]);
}

function putVideo(d, v) {
  d.run('INSERT OR REPLACE INTO videos (id, course_id, uploaded_at, data) VALUES (?, ?, ?, ?)',
    [v.id, v.courseId || '', Number(v.uploadedAt || 0), JSON.stringify(v)]);
}

/** 用户表：整表同步（账号量很小，语义与原来的 saveUsers() 一致） */
function saveUsers(users) {
  dbmod.tx(() => {
    const d = dbmod.get();
    const names = new Set();
    for (const [name, u] of Object.entries(users)) {
      names.add(name);
      d.run('INSERT OR REPLACE INTO users (name, role, data, created_at) VALUES (?, ?, ?, ?)',
        [name, String(u.role || 'patient'), JSON.stringify(u), Number(u.createdAt || 0)]);
    }
    // 删除已不存在的账号（原来整文件覆盖写天然具备这个语义）
    const rows = d.all('SELECT name FROM users', []);
    for (const r of rows) {
      if (!names.has(r.name)) d.run('DELETE FROM users WHERE name = ?', [r.name]);
    }
  });
}

function saveAll({ bookings = [], scales = [], alerts = [], assessments = [], flows = [] }) {
  dbmod.tx(() => {
    const d = dbmod.get();
    bookings.forEach((b) => putBooking(d, b));
    scales.forEach((s) => putScale(d, s));
    alerts.forEach((a) => putAlert(d, a));
    assessments.forEach((a) => putAssessment(d, a));
    flows.forEach((f) => putFlow(d, f));
  });
}

function saveFlows(flows) {
  dbmod.tx(() => { const d = dbmod.get(); flows.forEach((f) => putFlow(d, f)); });
}

function saveReports(reports) {
  dbmod.tx(() => { const d = dbmod.get(); reports.forEach((r) => putReport(d, r)); });
}

function saveVideos(videos) {
  dbmod.tx(() => {
    const d = dbmod.get();
    videos.forEach((v) => putVideo(d, v));
    const ids = new Set(videos.map((v) => v.id));
    const rows = d.all('SELECT id FROM videos', []);
    for (const r of rows) if (!ids.has(r.id)) d.run('DELETE FROM videos WHERE id = ?', [r.id]);
  });
}

function saveWatch(watchState) {
  dbmod.tx(() => {
    const d = dbmod.get();
    d.run('DELETE FROM watch', []);
    for (const [user, per] of Object.entries(watchState || {})) {
      for (const [vid, w] of Object.entries(per || {})) {
        d.run('INSERT OR REPLACE INTO watch (user, video_id, pos, done, at) VALUES (?, ?, ?, ?, ?)',
          [user, vid, Number(w.pos || 0), w.done ? 1 : 0, Number(w.at || 0)]);
      }
    }
  });
}

/* ------------------------------------------------------------------ 读取 */

function parseRows(rows) {
  return rows.map((r) => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
}

/** 只把最近 N 条载入内存；完整历史仍留在库里 */
function tail(sql, params, limit) {
  const rows = dbmod.get().all(sql + ' ORDER BY rowid DESC LIMIT ?', params.concat([limit]));
  return parseRows(rows).reverse();
}

function loadUsers() {
  const rows = dbmod.get().all('SELECT name, data FROM users', []);
  const out = {};
  for (const r of rows) {
    try { out[r.name] = JSON.parse(r.data); } catch (e) { /* 跳过坏行 */ }
  }
  return out;
}

function loadBookings(limit = 400) { return tail('SELECT data FROM bookings', [], limit); }
function loadScales(limit = 500) { return tail('SELECT data FROM scales', [], limit); }
function loadAlerts(limit = 1000) { return tail('SELECT data FROM alerts', [], limit); }
function loadAssessments(limit = 500) { return tail('SELECT data FROM assessments', [], limit); }
function loadFlows(limit = 800) { return tail('SELECT data FROM flows', [], limit); }
function loadReports(limit = 1000) { return tail('SELECT data FROM reports', [], limit); }

function loadVideos() {
  const rows = dbmod.get().all('SELECT data FROM videos', []);
  return parseRows(rows);
}

function loadWatch() {
  const rows = dbmod.get().all('SELECT user, video_id, pos, done, at FROM watch', []);
  const out = {};
  for (const r of rows) {
    (out[r.user] = out[r.user] || {})[r.video_id] = { pos: r.pos, done: !!r.done, at: r.at };
  }
  return out;
}

/* --------------------------------------------------- 权限判断用的关系查询 */

/** 监督者与患者之间是否存在有效关系（有预约或已执行过流程） */
function supervisorHasPatient(supervisor, patient) {
  const d = dbmod.get();
  const b = d.get('SELECT 1 AS x FROM bookings WHERE supervisor = ? AND patient = ? AND status <> ? LIMIT 1',
    [supervisor, patient, 'cancelled']);
  if (b) return true;
  const f = d.get('SELECT 1 AS x FROM flows WHERE supervisor = ? AND patient = ? LIMIT 1',
    [supervisor, patient]);
  return !!f;
}

/** 患者是否属于该家属（家属账号上记录 linkedPatient） */
function familyHasPatient(family, patient, users) {
  const u = users[family];
  return !!(u && u.role === 'family' && u.linkedPatient === patient);
}

module.exports = {
  init, saveUsers, saveAll, saveFlows, saveReports, saveVideos, saveWatch,
  loadUsers, loadBookings, loadScales, loadAlerts, loadAssessments, loadFlows, loadReports,
  loadVideos, loadWatch, supervisorHasPatient, familyHasPatient,
  importLegacy,
};
