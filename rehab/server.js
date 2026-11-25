'use strict';

/**
 * 康复监督预约系统 v2
 *
 * 业务模型：
 *   1. 患者线上预约监督者（按区域 + 时段）
 *   2. 监督者确认后线下到户，辅助/监督患者完成训练
 *   3. 服务结束前必须填写当日量表（疼痛 VAS / 完成度 / 肌力 / 疲劳 / 异常）
 *   4. 患者端可查看量表历史与趋势
 *
 * 定位：康复陪伴与监督（非医疗行为），不做诊断、不做治疗、不开处方
 *
 * 部署：监听 127.0.0.1:3001，由 nginx 挂在 /rehab 路径
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const cfg = require('./src/config');
const {
  PORT, HOST, BASE, DATA_DIR, PUBLIC_DIR, SESSION_TTL, MAX_BODY, TEST_MODE, DB_FILE,
} = cfg;

const repo = require('./src/db/repo');
const access = require('./src/middleware/access');
const routeTable = require('./src/routes');
const { json, readJson, parseCookies } = require('./src/lib/http');

// 打开数据库：首次启动会把历史 JSON 数据一次性导入，之后只读写 SQLite
repo.init(DB_FILE, DATA_DIR);

const {
  AREAS, SLOTS, FOCUS, BARTHEL_OPTS, MOTOR_OPTS, BERG_OPTS,
  TOOLBOX, SCALE_BY_KEY, STROKE_TYPES, STROKE_SIDES, DEFICITS,
  CONDITIONS, CONDITION_FLAT, GROUP_PROGRAM, CONDITION_PROGRAM,
  BRUNNSTROM_CONDITIONS, NEURO_CONDITIONS, CONCERNS,
} = require("./src/data/catalog");


fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- 账号 */
let users = repo.loadUsers();

// 兼容 v1 账号角色命名：user -> patient, therapist -> supervisor
(() => {
  let changed = false;
  for (const [, u] of Object.entries(users)) {
    if (u.role === 'user') { u.role = 'patient'; changed = true; }
    if (u.role === 'therapist') { u.role = 'supervisor'; u.areas = u.areas || []; changed = true; }
    if (!Array.isArray(u.areas)) { u.areas = []; changed = true; }
  }
  if (changed) repo.saveUsers(users);
})();

// 账号表整表同步（账号量很小，语义与原 saveUsers() 一致）
function saveUsers() { repo.saveUsers(users); }

function hashPwd(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }

function verifyUser(name, pw) {
  const u = users[name];
  if (!u) return false;
  const a = Buffer.from(hashPwd(pw, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------ 监督者运行时状态 */
const supState = new Map(); // name -> { online, areas }

function sState(name) {
  if (!supState.has(name)) supState.set(name, { online: false, areas: (users[name] || {}).areas || [] });
  return supState.get(name);
}

/* ---------------------------------------------------------------- 预约 */
let bookings = [];
let bookSeq = 0;
let scales = [];
let scaleSeq = 0;

/* ------------------------------------------------------ 专项量表（工具箱） */
let assessments = [];
let assessSeq = 0;

function buildAssessment(supervisor, patient, type, input) {
  const def = SCALE_BY_KEY[type];
  if (!def) throw new Error('未知道量表类型');
  if (!users[patient] || users[patient].role !== 'patient') throw new Error('患者不存在');

  const date = String((input && input.date) || today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');
  if (date > today()) throw new Error('不能填写未来日期的评估');

  const values = (input && input.values) || {};
  const clean = {};
  let total = 0;
  let filled = 0;

  for (const item of def.items) {
    const raw = values[item.k];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (!item.opts.some((x) => x.v === v)) throw new Error(`「${item.label}」选项无效`);
    clean[item.k] = v;
    total += v;
    filled += 1;
  }
  if (filled < Math.ceil(def.items.length / 2)) throw new Error('请至少完成一半的评估项目');

  const note = String((input && input.note) || '').slice(0, 200);
  const now = Date.now();
  const prevSame = assessments
    .filter((x) => x.patient === patient && x.type === type && x.total !== null)
    .slice(-1)[0];
  const a = {
    id: 'A' + String(++assessSeq).padStart(4, '0'),
    patient, supervisor, type, date,
    values: clean, total: def.score === 'sum' ? total : null,
    note, createdAt: now,
  };
  assessments.push(a);
  if (assessments.length > 800) assessments = assessments.slice(-800);
  evaluateAssessAlerts(patient, a, prevSame || null);
  return a;
}

function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function pushTimeline(b, label) { b.timeline.push({ ts: Date.now(), label }); }

function createBooking(patient, body) {
  const supervisor = String(body.supervisor || '').trim();
  const date = String(body.date || '').trim();
  const slot = String(body.slot || '').trim();
  const area = String(body.area || '').trim();
  const address = String(body.address || '').trim();
  // focus 现在承载"主诉/想解决的问题"，允许目录内选项，也允许用户自己写
  const rawFocus = Array.isArray(body.focus) ? body.focus : [];
  const focus = rawFocus
    .map((f) => String(f || '').trim())
    .filter((f) => f.length >= 2 && f.length <= 16)
    .slice(0, 6);
  const complaint = String(body.complaint || '').slice(0, 200);

  if (!users[supervisor] || users[supervisor].role !== 'supervisor') throw new Error('请选择有效的监督者');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');
  if (date < today()) throw new Error('不能预约过去的日期');
  if (!SLOTS.some((s) => s.id === slot)) throw new Error('请选择有效时段');
  if (!AREAS.includes(area)) throw new Error('请选择有效区域');
  if (address.length < 3 || address.length > 80) throw new Error('地址需 3-80 个字');

  // 同一监督者同一时段只能有一单
  const clash = bookings.find((b) => b.supervisor === supervisor && b.date === date && b.slot === slot
    && ['pending', 'confirmed', 'checked_in'].includes(b.status));
  if (clash) throw new Error('该监督者这个时段已被预约');

  const now = Date.now();
  const b = {
    id: 'B' + String(++bookSeq).padStart(3, '0'),
    patient,
    supervisor,
    date,
    slot,
    area,
    address,
    focus,
    complaint,
    status: 'pending',
    createdAt: now,
    timeline: [],
    scaleId: null,
  };
  pushTimeline(b, '患者发起预约，等待监督者确认');
  bookings.push(b);
  return b;
}

function bookingOf(id) {
  const b = bookings.find((x) => x.id === id);
  if (!b) throw new Error('预约不存在');
  return b;
}

function confirmBooking(name, id) {
  const b = bookingOf(id);
  if (b.supervisor !== name) throw new Error('不是你的预约');
  if (b.status !== 'pending') throw new Error('该预约已处理');
  b.status = 'confirmed';
  pushTimeline(b, '监督者已确认预约');
  return b;
}

function checkinBooking(name, id) {
  const b = bookingOf(id);
  if (b.supervisor !== name) throw new Error('不是你的预约');
  if (b.status !== 'confirmed') throw new Error('需先确认预约才能签到');
  b.status = 'checked_in';
  b.checkedInAt = Date.now();
  pushTimeline(b, '监督者已到场签到');
  return b;
}

function completeBooking(name, id, scaleInput) {
  const b = bookingOf(id);
  if (b.supervisor !== name) throw new Error('不是你的预约');
  if (b.status !== 'checked_in') throw new Error('需先到场签到才能完成');
  const scale = buildScale(name, b.patient, scaleInput, b.id);
  b.status = 'completed';
  b.completedAt = Date.now();
  b.scaleId = scale.id;
  pushTimeline(b, '服务完成，量表已提交');
  return { booking: b, scale };
}

function cancelBooking(name, id, reason) {
  const b = bookingOf(id);
  if (!['pending', 'confirmed'].includes(b.status)) throw new Error('该状态无法取消');
  const u = users[name];
  const related = name === b.patient || name === b.supervisor || (u && u.role === 'family' && u.linkedPatient === b.patient);
  if (!related) throw new Error('无权取消');
  b.status = 'cancelled';
  b.cancelReason = String(reason || '').slice(0, 60);
  pushTimeline(b, `${name} 取消预约${b.cancelReason ? '：' + b.cancelReason : ''}`);
  return b;
}

/* ---------------------------------------------------------------- 量表 */
function buildScale(supervisor, patient, input, bookingId) {
  const date = (input && input.date) || today();
  const vas = Number(input && input.vas);
  const completion = Number(input && input.completion);
  const mmt = Number(input && input.mmt);
  const fatigue = Number(input && input.fatigue);
  const note = String((input && input.note) || '').slice(0, 200);
  const abnormal = !!(input && input.abnormal);

  if (!(vas >= 0 && vas <= 10)) throw new Error('疼痛评分需在 0-10 之间');
  if (!(completion >= 0 && completion <= 100)) throw new Error('训练完成度需在 0-100 之间');
  if (!(mmt >= 0 && mmt <= 5)) throw new Error('肌力等级需在 0-5 之间');
  if (!(fatigue >= 0 && fatigue <= 10)) throw new Error('疲劳评分需在 0-10 之间');
  if (abnormal && note.length < 4) throw new Error('勾选异常时请填写说明');

  const now = Date.now();
  const prev = scales.filter((x) => x.patient === patient).slice(-1)[0];
  const s = {
    id: 'S' + String(++scaleSeq).padStart(4, '0'),
    patient,
    supervisor,
    bookingId: bookingId || null,
    date,
    vas, completion, mmt, fatigue, abnormal, note,
    createdAt: now,
  };
  scales.push(s);
  if (scales.length > 500) scales = scales.slice(-500);
  evaluateScaleAlerts(patient, s, prev || null);
  return s;
}

/* ------------------------------------------------------ 异常预警 */
let alerts = [];
let alertSeq = 0;

function pushAlert(patient, level, key, title, detail) {
  if (alerts.some((a) => a.key === key)) return null;
  const a = {
    id: 'N' + String(++alertSeq).padStart(4, '0'),
    patient, level, key, title, detail,
    createdAt: Date.now(), read: false,
  };
  alerts.push(a);
  if (alerts.length > 1000) alerts = alerts.slice(-1000);
  return a;
}

function evaluateScaleAlerts(patient, s, prev) {
  if (s.abnormal) {
    pushAlert(patient, 'high', 'abn:' + s.id, '训练中出现异常',
      `${s.date} ${s.supervisor} 记录异常：${s.note || '未填写说明'}（VAS ${s.vas}，完成度 ${s.completion}%）`);
  }
  if (prev && s.vas - prev.vas >= 3) {
    pushAlert(patient, 'mid', 'vas:' + s.id, '疼痛评分明显上升',
      `VAS 从 ${prev.vas} 升到 ${s.vas}（${prev.date} → ${s.date}），建议调整训练强度或复诊`);
  }
  if (s.completion <= 30) {
    pushAlert(patient, 'mid', 'low:' + s.id, '训练完成度偏低',
      `${s.date} 完成度仅 ${s.completion}%，可能需要家属多鼓励或调整方案`);
  }
}

function evaluateAssessAlerts(patient, a, prevSame) {
  if (a.type === 'phq9' && a.total >= 10) {
    pushAlert(patient, 'mid', 'phq:' + a.id, '情绪量表提示需关注',
      `PHQ-9 得分 ${a.total}/27（≥10 分建议关注情绪并咨询医生）`);
  }
  if (a.type === 'barthel' && prevSame && prevSame.total != null && a.total != null) {
    if (prevSame.total - a.total >= 10) {
      pushAlert(patient, 'high', 'barthel:' + a.id, '自理能力明显下降',
        `Barthel 从 ${prevSame.total} 降到 ${a.total}（${prevSame.date} → ${a.date}），建议尽快复查`);
    }
  }
  if (a.type === 'mrs' && prevSame && (prevSame.values.level || 0) < (a.values.level || 0)) {
    pushAlert(patient, 'mid', 'mrs:' + a.id, '残障等级上升',
      `mRS 从 ${prevSame.values.level} 升到 ${a.values.level}`);
  }
  if (a.type === 'berg' && a.total != null && a.total < 41 && (!prevSame || prevSame.total >= 41)) {
    pushAlert(patient, 'mid', 'berg:' + a.id, '平衡能力低于安全线',
      `Berg ${a.total}/56（<41 分跌倒风险升高，需全程看护）`);
  }
}

/* ------------------------------------------------------ 监督者培训课程 */
const { COURSES } = require("./src/data/courses");

const PASS_PER_COURSE = 2; // 每门 3 题，答对 2 题及格

/* ------------------------------------------------------ 诊断报告 */
const REPORT_DIR = path.join(DATA_DIR, 'reports');
const REPORT_MAX = 12 * 1024 * 1024;
const REPORT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
let reports = repo.loadReports();

function saveReports() { repo.saveReports(reports); }

function reportsOf(patient) {
  return reports.filter((r) => r.patient === patient).sort((a, b) => b.createdAt - a.createdAt);
}

function reportView(r) {
  return {
    id: r.id, patient: r.patient, name: r.name, size: r.size, mime: r.mime,
    createdAt: r.createdAt, uploader: r.uploader,
    url: BASE + '/api/report/get?id=' + r.id,
  };
}

/* ------------------------------------------------------ 偏瘫陪练流程（SOP） */
const { PHASES, FLOW_SHARED, STAGE_STEPS, INCIDENTS, flowSteps } = require('./src/data/flows');

let flows = [];
let sessionSeq = 0;

/* ------------------------------------------------------ 持久化（SQLite） */
function maxSeq(list, prefix) {
  return list.reduce((m, x) => {
    const n = parseInt(String((x && x.id) || '').slice(prefix.length), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
}

function loadSnapshots() {
  bookings = repo.loadBookings(400);
  scales = repo.loadScales(500);
  alerts = repo.loadAlerts(1000);
  assessments = repo.loadAssessments(500);
  flows = repo.loadFlows(800);
  bookSeq = maxSeq(bookings, 'B');
  scaleSeq = maxSeq(scales, 'S');
  alertSeq = maxSeq(alerts, 'N');
  assessSeq = maxSeq(assessments, 'A');
  sessionSeq = maxSeq(flows, 'F');
}

function persistAll() { repo.saveAll({ bookings, scales, alerts, assessments, flows }); }


function saveFlows() { repo.saveFlows(flows); }


function sessionView(s) {
  const steps = flowSteps(s.stage) || [];
  return {
    id: s.id, patient: s.patient, supervisor: s.supervisor, stage: s.stage,
    stageLabel: (STAGE_STEPS[s.stage] || {}).short || '',
    status: s.status, startedAt: s.startedAt, endedAt: s.endedAt || null,
    total: steps.length,
    done: s.steps.filter((x) => x.doneAt || x.skipped).length,
    currentIndex: s.steps.filter((x) => x.doneAt || x.skipped).length,
    steps, progress: s.steps, incidents: s.incidents, scaleId: s.scaleId || null,
  };
}

/* ------------------------------------------------------ 课程视频 */
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const VIDEO_MAX = 300 * 1024 * 1024; // 单文件 300MB
const VIDEO_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
};
// 看完的判定：播到 95% 或距结尾不足 8 秒
const WATCH_DONE_RATIO = 0.95;
const WATCH_DONE_TAIL = 8;

fs.mkdirSync(VIDEO_DIR, { recursive: true });

let videos = repo.loadVideos();

// 观看进度：{ 用户名: { 视频id: {pos, dur, done, at} } }
let watchState = repo.loadWatch();

function saveVideos() { repo.saveVideos(videos); }

function saveWatch() { repo.saveWatch(watchState); }

function watchOf(name, videoId) {
  return (watchState[name] && watchState[name][videoId]) || null;
}

function videosOf(courseId) {
  return videos.filter((v) => v.courseId === courseId).sort((a, b) => b.uploadedAt - a.uploadedAt);
}

// 对外输出的视频视图（含当前用户的观看状态）
function videoView(v, name) {
  const w = name ? watchOf(name, v.id) : null;
  return {
    id: v.id,
    courseId: v.courseId,
    title: v.title,
    status: v.status || 'ready',
    size: v.size,
    duration: v.duration || 0,
    uploader: v.uploader,
    uploadedAt: v.uploadedAt,
    url: (v.status === 'ready' && v.filename) ? BASE + '/media/' + v.filename : null,
    poster: v.poster ? BASE + '/media/' + v.poster : null,
    done: !!(w && w.done),
    pos: w ? w.pos : 0,
    err: v.err || null,
  };
}

/* ------------------------------------------------------ 视频转码（ffmpeg） */
const { spawn, execFileSync } = require('child_process');

let FFMPEG_OK = null;
function ffmpegOk() {
  if (FFMPEG_OK !== null) return FFMPEG_OK;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); FFMPEG_OK = true; } catch (e) { FFMPEG_OK = false; }
  return FFMPEG_OK;
}

const transcodeQueue = [];
let transcodeBusy = false;

function queueTranscode(v) { transcodeQueue.push(v); pumpQueue(); }

function pumpQueue() {
  if (transcodeBusy || !ffmpegOk()) return;
  const v = transcodeQueue.shift();
  if (!v) return;
  transcodeBusy = true;
  runTranscode(v, () => { transcodeBusy = false; pumpQueue(); });
}

function probeDuration(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
    const d = parseFloat(out);
    return Number.isFinite(d) ? Math.round(d * 10) / 10 : 0;
  } catch (e) { return 0; }
}

function runTranscode(v, done) {
  const src = path.join(VIDEO_DIR, v.rawName);
  const dstName = v.id + '.mp4';
  const dst = path.join(VIDEO_DIR, dstName);
  const posterName = v.id + '.jpg';
  const poster = path.join(VIDEO_DIR, posterName);

  const args = [
    '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
    dst,
  ];

  let errTail = '';
  const p = spawn('ffmpeg', args);
  p.stderr.on('data', (buf) => { errTail = (errTail + buf.toString()).slice(-400); });

  function finish(ok, msg) {
    if (ok) {
      try {
        execFileSync('ffmpeg', ['-y', '-i', dst, '-ss', '1', '-frames:v', '1', '-vf', 'scale=640:-2', poster], { stdio: 'ignore' });
      } catch (e) { /* 封面失败不影响播放 */ }
      v.status = 'ready';
      v.filename = dstName;
      v.poster = fs.existsSync(poster) ? posterName : null;
      v.duration = probeDuration(dst);
      v.size = fs.existsSync(dst) ? fs.statSync(dst).size : v.size;
      fs.unlink(src, () => {});
    } else {
      v.status = 'failed';
      v.err = msg || '转码失败';
    }
    v.rawName = undefined;
    saveVideos();
    broadcastAll();
    done();
  }

  p.on('error', () => finish(false, '没找到 ffmpeg，视频无法处理'));
  p.on('close', (code) => {
    if (code === 0 && fs.existsSync(dst)) finish(true);
    else finish(false, '视频编码无法识别或文件损坏');
  });
}

// 启动时：把上次中断的转码重新排队
for (const v of videos) {
  if (v.status === 'processing' && v.rawName && fs.existsSync(path.join(VIDEO_DIR, v.rawName))) queueTranscode(v);
  else if (v.status === 'processing') { v.status = 'failed'; v.err = '服务重启导致中断，请重新上传'; }
}


function trainingState(name) {
  const u = users[name] || {};
  const t = u.training || { passed: {}, certAt: null };
  const passedIds = Object.keys(t.passed || {});
  const completed = COURSES.filter((c) => passedIds.includes(c.id)).length;
  const certified = completed === COURSES.length;
  return { passed: t.passed || {}, completed, total: COURSES.length, certified, certAt: t.certAt || null };
}

function verifyState(name) {
  const u = users[name] || {};
  const v = u.verify || { status: 'none' };
  return v;
}

function isQualified(name) {
  return verifyState(name).status === 'approved' && trainingState(name).certified;
}
function linkedPatientOf(name) {
  const u = users[name];
  return u && u.role === 'family' ? u.linkedPatient || null : null;
}

function issueInvite(patientName) {
  const u = users[patientName];
  if (!u.invite) {
    u.invite = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    saveUsers();
  }
  return u.invite;
}

/**
 * 患者数据可见性统一走 src/middleware/access.js。
 * 原实现里 supervisor 直接 return true（任意监督者可读任意患者），已经修掉。
 */
function canViewPatient(viewer, patient) {
  return access.canViewPatient(viewer, patient, users);
}

/* ---------------------------------------------------------------- 会话 */
const sessions = new Map();

function createSession(name) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name, exp: Date.now() + SESSION_TTL });
  return token;
}


function sessionName(req) {
  const c = parseCookies(req.headers.cookie);
  if (!c.rpsid) return null;
  const s = sessions.get(c.rpsid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(c.rpsid); return null; }
  return s.name;
}

function cookieHeader(t) {
  return `rpsid=${t}; Path=${BASE}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
}

/* ---------------------------------------------------------------- 工具 */

/* ---------------------------------------------------------------- HTTP */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length) || '/';

  try {
    // 统一鉴权入口：/api/ 下未登记路径 404，未登录 401，角色不符 403
    // 细粒度的资源归属（这条预约是不是你的、这个患者你能不能看）仍在各 handler 内判断
    const currentUser = sessionName(req);
    const gate = routeTable.check({
      method: req.method, path: p, user: currentUser, role: access.roleOf(currentUser, users),
    });
    if (gate) return json(res, gate.code, { ok: false, err: gate.err });

    if (p === '/' || p === '/index.html') {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
        if (err) { res.writeHead(500); return res.end('missing page'); }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache, must-revalidate',
        });
        res.end(data);
      });
    }

    if (p === '/meta') {
      return json(res, 200, {
        ok: true, devMode: TEST_MODE,
        areas: AREAS, slots: SLOTS, focus: FOCUS, today: today(),
        strokeTypes: STROKE_TYPES, strokeSides: STROKE_SIDES, deficits: DEFICITS,
        conditions: CONDITIONS, neuroConditions: NEURO_CONDITIONS,
        brunstromConditions: BRUNNSTROM_CONDITIONS, conditionProgram: CONDITION_PROGRAM, concerns: CONCERNS,
        toolbox: TOOLBOX.map((s) => ({ key: s.key, name: s.name, short: s.short, desc: s.desc, itemCount: s.items.length, totalMax: s.totalMax })),
        scaleItems: [
          { key: 'vas', label: '疼痛评分 (VAS)', min: 0, max: 10, unit: '分' },
          { key: 'completion', label: '训练完成度', min: 0, max: 100, unit: '%' },
          { key: 'mmt', label: '肌力等级 (MMT)', min: 0, max: 5, unit: '级' },
          { key: 'fatigue', label: '疲劳程度', min: 0, max: 10, unit: '分' },
        ],
      });
    }

    if (p === '/api/me') {
      const name = sessionName(req);
      if (!name) return json(res, 200, { ok: true, user: null });
      return json(res, 200, { ok: true, user: name, role: users[name].role, profile: profileOf(name) });
    }

    if (p === '/api/register' && req.method === 'POST') {
      const body = await readJson(req);
      const name = String(body.username || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'supervisor' ? 'supervisor' : 'patient';
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/.test(name)) return json(res, 400, { ok: false, err: '用户名需 2-20 位' });
      if (password.length < 6 || password.length > 64) return json(res, 400, { ok: false, err: '密码需 6-64 位' });
      if (users[name]) return json(res, 409, { ok: false, err: '用户名已被占用' });

      const salt = crypto.randomBytes(16).toString('hex');
      users[name] = { salt, hash: hashPwd(password, salt), role, createdAt: Date.now(), areas: [] };
      saveUsers();
      const token = createSession(name);
      return json(res, 200, { ok: true, user: name, role, profile: profileOf(name) }, { 'Set-Cookie': cookieHeader(token) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const name = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!verifyUser(name, password)) return json(res, 401, { ok: false, err: '用户名或密码不正确' });
      const token = createSession(name);
      return json(res, 200, { ok: true, user: name, role: users[name].role, profile: profileOf(name) }, { 'Set-Cookie': cookieHeader(token) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const c = parseCookies(req.headers.cookie);
      if (c.rpsid) sessions.delete(c.rpsid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `rpsid=; Path=${BASE}; HttpOnly; Max-Age=0` });
    }

    // ---------------- 测试模式：免登录直接进入 ----------------
    if (p === '/api/dev-login' && req.method === 'POST') {
      if (!TEST_MODE) return json(res, 403, { ok: false, err: '测试模式已关闭，请使用账号登录' });
      const body = await readJson(req);
      const wanted = body.role === 'supervisor' ? 'supervisor'
        : body.role === 'family' ? 'family'
          : body.role === 'admin' ? 'admin' : 'patient';
      let name = String(body.name || '').trim();
      if (!name) {
        name = wanted === 'supervisor' ? '测试监督者'
          : wanted === 'family' ? '测试家属'
            : wanted === 'admin' ? '管理员' : '测试患者';
      }
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/.test(name)) {
        return json(res, 400, { ok: false, err: '名称需 2-20 位中文/字母/数字' });
      }
      if (users[name] && users[name].role !== wanted) {
        return json(res, 409, { ok: false, err: '该名称已被另一个身份占用，换个名字' });
      }
      if (!users[name]) {
        const salt = crypto.randomBytes(16).toString('hex');
        users[name] = {
          salt, hash: hashPwd('dev' + salt, salt), role: wanted,
          createdAt: Date.now(), areas: wanted === 'supervisor' ? ['朝阳区'] : [], dev: true,
        };
        saveUsers();
      }

      // 家属身份需绑定一个患者
      let linkedError = null;
      if (wanted === 'family') {
        const target = String(body.patient || '').trim() || '测试患者';
        const fallback = Object.entries(users).find(([, u]) => u.role === 'patient');
        const patientName = users[target] && users[target].role === 'patient'
          ? target : (fallback ? fallback[0] : null);
        if (!patientName) linkedError = '目前没有可绑定的患者账号';
        else {
          users[name].linkedPatient = patientName;
          saveUsers();
        }
      }

      const token = createSession(name);
      return json(res, 200, {
        ok: true, user: name, role: wanted, profile: profileOf(name),
        linkedPatient: linkedPatientOf(name), dev: true, linkedError,
      }, { 'Set-Cookie': cookieHeader(token) });
    }

    // ---------------- 患者：监督者列表 ----------------
    if (p === '/api/supervisors') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const area = url.searchParams.get('area') || '';
      const date = url.searchParams.get('date') || '';
      const slot = url.searchParams.get('slot') || '';

      const list = Object.entries(users)
        .filter(([uname, u]) => u.role === 'supervisor' && isQualified(uname))
        .map(([uname]) => {
          const st = sState(uname);
          const doing = bookings.filter((b) => b.supervisor === uname && ['pending', 'confirmed', 'checked_in'].includes(b.status)).length;
          const done = bookings.filter((b) => b.supervisor === uname && b.status === 'completed').length;
          let available = st.online;
          if (area) available = available && st.areas.includes(area);
          if (date && slot) {
            const busy = bookings.some((b) => b.supervisor === uname && b.date === date && b.slot === slot
              && ['pending', 'confirmed', 'checked_in'].includes(b.status));
            available = available && !busy;
          }
          return {
            name: uname,
            areas: st.areas,
            online: st.online,
            available,
            doing,
            done,
            rating: done ? Math.min(5, 4 + Math.min(done, 40) / 40) : 5,
          };
        })
        .sort((a, b) => (b.available - a.available) || (b.done - a.done));

      return json(res, 200, { ok: true, supervisors: list });
    }

    // ---------------- 患者：下单预约 ----------------
    if (p === '/api/book' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      let patient = name;
      if (role === 'family') {
        patient = linkedPatientOf(name);
        if (!patient) return json(res, 400, { ok: false, err: '家属账号未绑定患者，请先绑定' });
      } else if (role !== 'patient') {
        return json(res, 403, { ok: false, err: '请用患者或家属账号预约' });
      }
      const body = await readJson(req);
      const b = createBooking(patient, body);
      broadcastAll();
      return json(res, 200, { ok: true, booking: publicBooking(b), forPatient: patient });
    }

    // ---------------- 监督者：上线/区域 ----------------
    if (p === '/api/supervisor/online' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '不是监督者账号' });
      const body = await readJson(req);
      const st = sState(name);
      if (Array.isArray(body.areas)) {
        st.areas = body.areas.filter((a) => AREAS.includes(a));
        users[name].areas = st.areas;
        saveUsers();
      }
      if (!st.areas.length && body.online) return json(res, 400, { ok: false, err: '请先选择至少一个服务区域' });

      // 上岗门槛：资料审核通过 + 培训结业
      if (body.online && !isQualified(name)) {
        const v = verifyState(name);
        const t = trainingState(name);
        const reason = v.status !== 'approved'
          ? (v.status === 'pending' ? '资料正在审核中，通过后才能上线' : (v.status === 'rejected' ? '资料审核未通过，请修改后重新提交' : '请先在「认证培训」提交个人资料'))
          : `培训未结业（已完成 ${t.completed}/${t.total} 门课程）`;
        return json(res, 403, { ok: false, err: reason, needCert: true });
      }

      st.online = !!body.online;
      broadcastAll();
      return json(res, 200, { ok: true, online: st.online, areas: st.areas });
    }

    // ---------------- 培训与认证 ----------------
    if (p === '/api/training/courses') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者账号可培训' });
      return json(res, 200, {
        ok: true,
        courses: COURSES.map((c) => ({
          id: c.id, title: c.title, minutes: c.minutes, points: c.points,
          questions: c.quiz.map((q) => ({ q: q.q, opts: q.opts })),
          videos: videosOf(c.id).map((v) => videoView(v, name)),
        })),
        progress: trainingState(name),
        verify: verifyState(name),
      });
    }

    if (p === '/api/training/exam' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者账号可培训' });
      const body = await readJson(req);
      const course = COURSES.find((c) => c.id === String(body.courseId || ''));
      if (!course) return json(res, 404, { ok: false, err: '课程不存在' });

      const answers = Array.isArray(body.answers) ? body.answers : [];
      if (answers.length !== course.quiz.length) return json(res, 400, { ok: false, err: '请回答全部题目' });

      // 观看门禁：本课有已处理完的视频时，必须全部看完才能考试
      const courseVideos = videosOf(course.id).filter((v) => v.status === 'ready');
      if (courseVideos.length) {
        const missing = courseVideos.filter((v) => !(watchOf(name, v.id) && watchOf(name, v.id).done));
        if (missing.length) {
          return json(res, 400, {
            ok: false,
            err: `请先看完本课视频（还剩 ${missing.length} 个）`,
            needWatch: missing.length,
          });
        }
      }

      let correct = 0;
      course.quiz.forEach((q, i) => { if (Number(answers[i]) === q.a) correct += 1; });

      const passed = correct >= PASS_PER_COURSE;
      const t = users[name].training || { passed: {} };
      t.passed = t.passed || {};
      if (passed) t.passed[course.id] = correct;
      users[name].training = t;
      const st = trainingState(name);
      if (st.certified && !t.certAt) users[name].training.certAt = Date.now();
      saveUsers();
      broadcastAll();

      const explanations = course.quiz.map((q, i) => ({ index: i, answer: q.a, ok: Number(answers[i]) === q.a }));
      return json(res, 200, {
        ok: true, score: correct, total: course.quiz.length, passed,
        explanations, progress: trainingState(name),
      });
    }

    // 课程视频上传（原始二进制流，不做 multipart 解析）
    if (p === '/api/training/video/upload' && req.method === 'POST') {
      // 有请求体时不能提前断，否则 nginx 会拿到 502：先排空再回错误
      let rejected = false;
      function rejectUpload(code, msg) {
        if (rejected) return;
        rejected = true;
        let sent = false;
        const send = () => { if (sent) return; sent = true; try { json(res, code, { ok: false, err: msg }); } catch (e) { /* ignore */ } };
        let drained = 0;
        req.on('data', (c) => { drained += c.length; if (drained > 16 * 1024 * 1024) { send(); req.destroy(); } });
        req.on('end', send);
        req.on('error', send);
        req.resume();
        setTimeout(send, 4000).unref();
      }

      const name = sessionName(req);
      if (!name) return rejectUpload(401, '未登录');
      const role = users[name].role;
      if (role !== 'admin' && role !== 'supervisor') return rejectUpload(403, '无上传权限');

      const courseId = url.searchParams.get('courseId') || '';
      const course = COURSES.find((c) => c.id === courseId);
      if (!course) return rejectUpload(404, '课程不存在');

      const title = String(url.searchParams.get('title') || '').trim().slice(0, 60);
      if (title.length < 2) return rejectUpload(400, '请填写视频标题（至少 2 字）');

      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      const ext = VIDEO_TYPES[mime];
      if (!ext) return rejectUpload(400, '仅支持 mp4 / webm / mov / mkv 格式');

      const id = 'V' + Date.now().toString(36);
      const rawName = 'raw_' + id + ext;
      const filePath = path.join(VIDEO_DIR, rawName);

      let written = 0;
      let tooBig = false;
      let responded = false;
      const stream = fs.createWriteStream(filePath);

      function failWith(code, msg) {
        if (responded) return;
        responded = true;
        fs.unlink(filePath, () => {});
        try { json(res, code, { ok: false, err: msg }); } catch (e) { /* ignore */ }
      }

      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > VIDEO_MAX) {
          tooBig = true;
          req.destroy();
          stream.destroy();
          failWith(413, '视频过大，单文件上限 300MB');
        }
      });

      stream.on('finish', () => {
        if (responded) return;
        if (tooBig || written === 0) return failWith(400, '上传内容为空');
        responded = true;
        const v = {
          id, courseId, title, rawName, size: written, mime,
          uploader: name, uploaderRole: role, uploadedAt: Date.now(),
          status: ffmpegOk() ? 'processing' : 'failed',
          err: ffmpegOk() ? null : '服务器未安装 ffmpeg，无法处理视频',
        };
        videos.push(v);
        saveVideos();
        broadcastAll();
        if (v.status === 'processing') queueTranscode(v);
        json(res, 200, { ok: true, video: videoView(v, name) });
      });

      stream.on('error', () => failWith(500, '写入失败，请重试'));
      req.on('aborted', () => { if (!responded) { responded = true; fs.unlink(filePath, () => {}); } });
      req.pipe(stream);
      return;
    }

    if (p === '/api/training/videos') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const courseId = url.searchParams.get('courseId') || '';
      const list = (courseId ? videosOf(courseId) : videos.slice().reverse())
        .filter((v) => v.status !== 'failed' || courseId)
        .map((v) => videoView(v, name));
      return json(res, 200, { ok: true, videos: list });
    }

    // 观看进度上报（前端每 5 秒打一次，播完时再补一次）
    if (p === '/api/training/video/watch' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const v = videos.find((x) => x.id === String(body.videoId || ''));
      if (!v) return json(res, 404, { ok: false, err: '视频不存在' });
      if ((v.status || 'ready') !== 'ready') return json(res, 400, { ok: false, err: '视频还在处理中' });

      const pos = Math.max(0, Number(body.pos) || 0);
      const dur = Math.max(0, Number(body.dur) || v.duration || 0);
      watchState[name] = watchState[name] || {};
      const prev = watchState[name][v.id] || { done: false };
      // 尾段阈值最多取视频时长的 10%，避免短视频播一半就算看完
      const tail = dur > 0 ? Math.min(WATCH_DONE_TAIL, dur * 0.1) : WATCH_DONE_TAIL;
      const reachedEnd = dur > 0 && (pos / dur >= WATCH_DONE_RATIO || (dur - pos) <= tail);
      const done = !!prev.done || reachedEnd;
      const before = prev.done;
      watchState[name][v.id] = { pos: Math.round(pos), dur: Math.round(dur), done, at: Date.now() };
      saveWatch();
      if (done && !before) broadcastAll();
      return json(res, 200, { ok: true, done, pos: Math.round(pos), dur: Math.round(dur) });
    }

    if (p === '/api/training/video/delete' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'admin') return json(res, 403, { ok: false, err: '仅管理员可删除视频' });
      const body = await readJson(req);
      const idx = videos.findIndex((v) => v.id === String(body.id || ''));
      if (idx < 0) return json(res, 404, { ok: false, err: '视频不存在' });
      const v = videos[idx];
      videos.splice(idx, 1);
      saveVideos();
      const targets = [];
      if (v.filename) targets.push(path.join(VIDEO_DIR, v.filename));
      if (v.rawName) targets.push(path.join(VIDEO_DIR, v.rawName));
      if (v.poster) targets.push(path.join(VIDEO_DIR, v.poster));
      targets.forEach((f) => { try { fs.unlink(f, () => {}); } catch (e) { /* ignore */ } });
      broadcastAll();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/supervisor/credentials' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者账号可提交' });
      const body = await readJson(req);

      const realName = String(body.realName || '').trim();
      const idNo = String(body.idNo || '').trim().toUpperCase();
      const yearsExp = Number(body.yearsExp || 0);
      const background = String(body.background || '').slice(0, 120);
      const healthCert = !!body.healthCert;
      const noRecord = !!body.noRecord;

      if (!/^[\u4e00-\u9fa5]{2,10}$/.test(realName)) return json(res, 400, { ok: false, err: '请填写真实中文姓名' });
      if (!/^\d{17}[\dX]$/.test(idNo)) return json(res, 400, { ok: false, err: '身份证号格式不正确' });
      if (!healthCert) return json(res, 400, { ok: false, err: '需持有有效健康证' });
      if (!noRecord) return json(res, 400, { ok: false, err: '需确认无犯罪记录' });
      if (!(yearsExp >= 0 && yearsExp <= 40)) return json(res, 400, { ok: false, err: '从业年限不正确' });
      if (background.length < 4) return json(res, 400, { ok: false, err: '请填写相关背景（护理/康复/照护等）' });

      const st = verifyState(name);
      if (st.status === 'approved') return json(res, 400, { ok: false, err: '资料已通过审核，无需重复提交' });

      const masked = idNo.slice(0, 4) + '**********' + idNo.slice(-4);
      users[name].verify = {
        status: 'pending', realName, idNoMasked: masked, yearsExp, background, healthCert, noRecord,
        submittedAt: Date.now(), note: '', reviewedAt: null, reviewer: null,
      };
      saveUsers();
      broadcastAll();
      return json(res, 200, { ok: true, verify: verifyState(name) });
    }

    if (p === '/api/admin/overview') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'admin') return json(res, 403, { ok: false, err: '仅管理员可查看' });
      const sups = Object.entries(users).filter(([, u]) => u.role === 'supervisor').map(([n, u]) => ({
        name: n,
        verify: verifyState(n),
        training: trainingState(n),
        online: sState(n).online,
        areas: sState(n).areas,
      }));
      return json(res, 200, {
        ok: true,
        supervisors: sups,
        pending: sups.filter((x) => x.verify.status === 'pending'),
        approved: sups.filter((x) => x.verify.status === 'approved').length,
        certified: sups.filter((x) => x.training.certified).length,
        onlineNow: sups.filter((x) => x.online).length,
      });
    }

    if (p === '/api/admin/review' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'admin') return json(res, 403, { ok: false, err: '仅管理员可审核' });
      const body = await readJson(req);
      const target = String(body.name || '').trim();
      if (!users[target] || users[target].role !== 'supervisor') return json(res, 404, { ok: false, err: '监督者不存在' });
      const action = body.action === 'approve' ? 'approve' : (body.action === 'reject' ? 'reject' : '');
      if (!action) return json(res, 400, { ok: false, err: '审核动作无效' });
      const v = users[target].verify || { status: 'none' };
      if (v.status !== 'pending') return json(res, 400, { ok: false, err: '该资料不在待审核状态' });

      v.status = action === 'approve' ? 'approved' : 'rejected';
      v.note = String(body.note || '').slice(0, 120);
      v.reviewedAt = Date.now();
      v.reviewer = name;
      users[target].verify = v;
      saveUsers();
      broadcastAll();
      return json(res, 200, { ok: true, verify: v });
    }

    if (p === '/api/training/demo' && req.method === 'POST') {
      if (!TEST_MODE) return json(res, 403, { ok: false, err: '仅测试模式可用' });
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者账号可用' });
      const u = users[name];
      if (!u.verify || u.verify.status === 'none') {
        u.verify = { status: 'approved', realName: '测试员', idNoMasked: '1101**********1234', yearsExp: 3, background: '测试用账号，跳过真实审核', healthCert: true, noRecord: true, submittedAt: Date.now(), reviewedAt: Date.now(), reviewer: 'demo', note: '测试模式一键认证' };
      } else if (u.verify.status !== 'approved') {
        u.verify.status = 'approved'; u.verify.note = '测试模式一键认证'; u.verify.reviewedAt = Date.now();
      }
      u.training = u.training || { passed: {} };
      u.training.passed = {};
      COURSES.forEach((c) => { u.training.passed[c.id] = 3; });
      u.training.certAt = u.training.certAt || Date.now();
      saveUsers();
      broadcastAll();
      return json(res, 200, { ok: true, verify: verifyState(name), training: trainingState(name) });
    }

    // ---------------- 监督者：确认 / 签到 / 完成 ----------------
    if (p === '/api/book/confirm' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const b = confirmBooking(name, String(body.id || ''));
      broadcastAll();
      return json(res, 200, { ok: true, booking: publicBooking(b) });
    }

    if (p === '/api/book/checkin' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const b = checkinBooking(name, String(body.id || ''));
      broadcastAll();
      return json(res, 200, { ok: true, booking: publicBooking(b) });
    }

    if (p === '/api/book/complete' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const { booking, scale } = completeBooking(name, String(body.id || ''), body.scale || {});
      broadcastAll();
      return json(res, 200, { ok: true, booking: publicBooking(booking), scale });
    }

    if (p === '/api/book/cancel' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const b = cancelBooking(name, String(body.id || ''), body.reason);
      broadcastAll();
      return json(res, 200, { ok: true, booking: publicBooking(b) });
    }

    // ---------------- 量表 ----------------
    // ---------------- 偏瘫陪练流程 ----------------
    if (p === '/api/protocol') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      return json(res, 200, {
        ok: true,
        phases: PHASES,
        incidents: INCIDENTS,
        stages: Object.keys(STAGE_STEPS).map((k) => ({
          id: k,
          label: STAGE_STEPS[k].label,
          short: STAGE_STEPS[k].short,
          count: flowSteps(k).length,
        })),
        rules: [
          '步骤必须按顺序完成，不能跳步；确实做不了要点"跳过"并写明原因',
          '每一步都有"不能做什么"，那些是红线',
          '出现异常先停下，按异常指引处理，再决定是否继续',
          '流程走完必须填量表，否则本次记录不算完成',
        ],
      });
    }

    if (p === '/api/session/start' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者可以发起陪练' });
      const body = await readJson(req);
      const patient = String(body.patient || '').trim();
      if (!users[patient] || users[patient].role !== 'patient') return json(res, 400, { ok: false, err: '患者不存在' });
      // 必须与该患者存在服务关系（有预约或历史流程），不能给任意患者开流程
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '该患者不在你的服务范围内' });
      // 正式环境要求"认证 + 培训合格"；测试模式放行，方便演示
      if (!TEST_MODE && !isQualified(name)) return json(res, 403, { ok: false, err: '请先完成认证与培训', needCert: true });
      const bookingId = String(body.bookingId || '').trim();
      if (bookingId) {
        const b = bookings.find((x) => x.id === bookingId);
        if (!b || b.supervisor !== name || b.patient !== patient) {
          return json(res, 400, { ok: false, err: '预约与本次陪练不匹配' });
        }
        if (b.status !== 'checked_in') return json(res, 400, { ok: false, err: '请先到场签到再开始陪练' });
      }
      const stage = String(body.stage || '');
      const steps = flowSteps(stage);
      if (!steps) return json(res, 400, { ok: false, err: '请选择训练分期' });
      const s = {
        id: 'F' + String(++sessionSeq).padStart(4, '0'),
        patient, supervisor: name, stage, bookingId: bookingId || null,
        status: 'running', startedAt: Date.now(), endedAt: null,
        steps: steps.map((st) => ({ key: st.key, doneAt: null, skipped: false, reason: '' })),
        incidents: [], scaleId: null,
      };
      flows.push(s);
      if (flows.length > 800) flows = flows.slice(-800);
      saveFlows();
      broadcastAll();
      return json(res, 200, { ok: true, session: sessionView(s) });
    }

    if (p === '/api/session/step' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const s = flows.find((x) => x.id === String(body.sessionId || ''));
      if (!s) return json(res, 404, { ok: false, err: '流程不存在' });
      if (s.supervisor !== name) return json(res, 403, { ok: false, err: '不是你的流程' });
      if (s.status !== 'running') return json(res, 400, { ok: false, err: '流程已结束' });

      const steps = flowSteps(s.stage);
      const idx = s.steps.filter((x) => x.doneAt || x.skipped).length;
      if (idx >= steps.length) return json(res, 400, { ok: false, err: '流程已走完' });
      const expect = steps[idx];
      const key = String(body.stepKey || '');
      if (key !== expect.key) {
        return json(res, 400, {
          ok: false,
          err: `请按顺序完成第 ${idx + 1} 步：${expect.title}`,
          needStep: expect.key, index: idx,
        });
      }
      const action = body.action === 'skip' ? 'skip' : 'done';
      const note = String(body.note || '').slice(0, 120);
      if (action === 'skip' && note.trim().length < 4) {
        return json(res, 400, { ok: false, err: '跳过必须写明原因（至少 4 个字）' });
      }
      if (action === 'done') s.steps[idx].doneAt = Date.now();
      else { s.steps[idx].skipped = true; s.steps[idx].reason = note.trim(); }
      saveFlows();
      return json(res, 200, { ok: true, session: sessionView(s) });
    }

    if (p === '/api/session/incident' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const s = flows.find((x) => x.id === String(body.sessionId || ''));
      if (!s) return json(res, 404, { ok: false, err: '流程不存在' });
      if (s.supervisor !== name) return json(res, 403, { ok: false, err: '不是你的流程' });
      const inc = INCIDENTS.find((x) => x.type === String(body.type || ''));
      if (!inc) return json(res, 400, { ok: false, err: '异常类型不存在' });
      const note = String(body.note || '').slice(0, 160);
      const rec = { type: inc.type, title: inc.title, severity: inc.severity, note, at: Date.now() };
      s.incidents.push(rec);
      saveFlows();
      if (inc.severity === 'high') {
        pushAlert(s.patient, 'high', 'flow:' + s.id + ':' + inc.type,
          '陪练中出现高危情况：' + inc.title,
          `${s.supervisor} 在 ${new Date().toLocaleString('zh-CN')} 记录：${inc.title}${note ? '；说明：' + note : ''}`);
        broadcastAll();
      }
      return json(res, 200, { ok: true, session: sessionView(s) });
    }

    if (p === '/api/session/abort' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const s = flows.find((x) => x.id === String(body.sessionId || ''));
      if (!s) return json(res, 404, { ok: false, err: '流程不存在' });
      if (s.supervisor !== name) return json(res, 403, { ok: false, err: '不是你的流程' });
      const reason = String(body.reason || '').slice(0, 160);
      if (reason.trim().length < 4) return json(res, 400, { ok: false, err: '请写明终止原因（至少 4 个字）' });
      s.status = 'aborted'; s.endedAt = Date.now(); s.abortReason = reason.trim();
      saveFlows();
      pushAlert(s.patient, 'high', 'abort:' + s.id, '本次陪练被提前终止',
        `${s.supervisor} 终止：${reason.trim()}`);
      broadcastAll();
      return json(res, 200, { ok: true, session: sessionView(s) });
    }

    if (p === '/api/session/finish' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const s = flows.find((x) => x.id === String(body.sessionId || ''));
      if (!s) return json(res, 404, { ok: false, err: '流程不存在' });
      if (s.supervisor !== name) return json(res, 403, { ok: false, err: '不是你的流程' });
      if (s.status !== 'running') return json(res, 400, { ok: false, err: '流程已结束' });
      const steps = flowSteps(s.stage);
      const left = s.steps.filter((x) => !x.doneAt && !x.skipped).length;
      if (left > 0) return json(res, 400, { ok: false, err: `还有 ${left} 步没处理，不能结束`, left });
      let scale;
      try {
        scale = buildScale(name, s.patient, body.scale || {}, null);
      } catch (e) {
        return json(res, 400, { ok: false, err: e.message });
      }
      s.status = 'done'; s.endedAt = Date.now(); s.scaleId = scale.id;
      scale.sessionId = s.id;
      saveFlows();
      broadcastAll();
      return json(res, 200, { ok: true, session: sessionView(s), scale });
    }

    if (p === '/api/sessions') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      let list;
      if (role === 'supervisor') list = flows.filter((s) => s.supervisor === name);
      else if (role === 'patient') list = flows.filter((s) => s.patient === name);
      else if (role === 'family') list = flows.filter((s) => s.patient === linkedPatientOf(name));
      else list = sessions;
      const running = list.filter((s) => s.status === 'running');
      const done = list.filter((s) => s.status !== 'running').slice(-20).reverse();
      return json(res, 200, {
        ok: true,
        running: running.map(sessionView),
        list: done.map(sessionView),
      });
    }

    if (p === '/api/scale' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者可以填写量表' });
      const body = await readJson(req);
      const patient = String(body.patient || '').trim();
      if (!users[patient] || users[patient].role !== 'patient') return json(res, 400, { ok: false, err: '患者不存在' });
      // 量表属于评估记录，必须与该患者有服务关系；正式环境还要求认证与培训合格
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '该患者不在你的服务范围内' });
      if (!TEST_MODE && !isQualified(name)) return json(res, 403, { ok: false, err: '请先完成认证与培训', needCert: true });
      const s = buildScale(name, patient, body.scale || {}, null);
      broadcastAll();
      return json(res, 200, { ok: true, scale: s });
    }

    if (p === '/api/scales') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      const fallback = role === 'family' ? (linkedPatientOf(name) || '') : (role === 'patient' ? name : '');
      const patient = url.searchParams.get('patient') || fallback;
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      const list = scales.filter((s) => s.patient === patient).slice(-30).reverse();
      return json(res, 200, { ok: true, scales: list });
    }

    if (p === '/api/bookings') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const u = users[name];
      let list;
      if (u.role === 'family') {
        const p2 = linkedPatientOf(name);
        list = bookings.filter((b) => b.patient === p2);
      } else if (u.role === 'patient') {
        list = bookings.filter((b) => b.patient === name);
      } else {
        list = bookings.filter((b) => b.supervisor === name);
      }
      const mine = list.slice(-40).reverse().map(publicBooking);
      return json(res, 200, { ok: true, bookings: mine });
    }

    // ---------------- 卒中工具箱 ----------------
    if (p === '/api/toolbox/meta') {
      return json(res, 200, {
        ok: true,
        scales: TOOLBOX,
        strokeTypes: STROKE_TYPES,
        strokeSides: STROKE_SIDES,
        deficits: DEFICITS,
        conditions: CONDITIONS,
        concerns: CONCERNS,
      });
    }


    // ---------------- 诊断报告 ----------------
    if (p === '/api/patient/report/upload' && req.method === 'POST') {
      // 有请求体时不能提前断，先排空再回错误（否则 nginx 会拿到 502）
      let rejected = false;
      function rejectUpload(code, msg) {
        if (rejected) return;
        rejected = true;
        let sent = false;
        const send = () => { if (sent) return; sent = true; try { json(res, code, { ok: false, err: msg }); } catch (e) { /* ignore */ } };
        let drained = 0;
        req.on('data', (c) => { drained += c.length; if (drained > 20 * 1024 * 1024) { send(); req.destroy(); } });
        req.on('end', send);
        req.on('error', send);
        req.resume();
        setTimeout(send, 4000).unref();
      }

      const name = sessionName(req);
      if (!name) return rejectUpload(401, '未登录');
      const role = users[name].role;
      if (role !== 'patient' && role !== 'family') return rejectUpload(403, '只有患者或家属可以上传报告');

      const patient = role === 'family' ? linkedPatientOf(name) : name;
      if (!patient || !users[patient] || users[patient].role !== 'patient') return rejectUpload(400, '未绑定患者');

      if (reportsOf(patient).length >= 10) return rejectUpload(400, '每人最多 10 份报告，请先删掉旧的');

      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      const ext = REPORT_TYPES[mime];
      if (!ext) return rejectUpload(400, '仅支持 JPG / PNG / WebP / HEIC 图片或 PDF');

      const label = String(url.searchParams.get('name') || '诊断报告').replace(/[\r\n]/g, ' ').trim().slice(0, 40) || '诊断报告';
      const id = 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const filePath = path.join(REPORT_DIR, id + '.' + ext);

      let written = 0;
      let tooBig = false;
      let responded = false;
      const stream = fs.createWriteStream(filePath);

      function failWith(code, msg) {
        if (responded) return;
        responded = true;
        fs.unlink(filePath, () => {});
        try { json(res, code, { ok: false, err: msg }); } catch (e) { /* ignore */ }
      }

      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > REPORT_MAX) {
          tooBig = true;
          req.destroy();
          stream.destroy();
          failWith(413, '文件过大，单份上限 12MB');
        }
      });

      stream.on('finish', () => {
        if (responded) return;
        if (tooBig || written === 0) return failWith(400, '上传内容为空');
        responded = true;
        const r = {
          id, patient, name: label, size: written, mime, ext,
          uploader: name, uploaderRole: role, createdAt: Date.now(),
        };
        reports.push(r);
        if (reports.length > 500) reports = reports.slice(-500);
        saveReports();
        broadcastAll();
        json(res, 200, { ok: true, report: reportView(r) });
      });

      stream.on('error', () => failWith(500, '写入失败，请重试'));
      req.on('aborted', () => { if (!responded) { responded = true; fs.unlink(filePath, () => {}); } });
      req.pipe(stream);
      return;
    }

    if (p === '/api/patient/reports') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      const fallback = role === 'patient' ? name : (role === 'family' ? (linkedPatientOf(name) || '') : '');
      const patient = url.searchParams.get('patient') || fallback;
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      return json(res, 200, { ok: true, reports: reportsOf(patient).map(reportView) });
    }

    if (p === '/api/report/get') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const id = url.searchParams.get('id') || '';
      const r = reports.find((x) => x.id === id);
      if (!r) return json(res, 404, { ok: false, err: '报告不存在' });
      if (!canViewPatient(name, r.patient)) return json(res, 403, { ok: false, err: '无权查看' });
      const fp = path.join(REPORT_DIR, r.id + '.' + (r.ext || 'jpg'));
      if (!fs.existsSync(fp)) return json(res, 404, { ok: false, err: '文件已丢失' });
      res.writeHead(200, {
        'Content-Type': r.mime || 'application/octet-stream',
        'Content-Length': r.size,
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(r.name || 'report'),
        'Cache-Control': 'private, max-age=600',
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    if (p === '/api/report/delete' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const id = String(body.id || '');
      const r = reports.find((x) => x.id === id);
      if (!r) return json(res, 404, { ok: false, err: '报告不存在' });
      const allowed = users[name].role === 'patient' && r.patient === name;
      if (!allowed && r.uploader !== name) return json(res, 403, { ok: false, err: '无权删除' });
      reports = reports.filter((x) => x.id !== id);
      saveReports();
      fs.unlink(path.join(REPORT_DIR, r.id + '.' + (r.ext || 'jpg')), () => {});
      broadcastAll();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/patient/profile' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'patient') return json(res, 403, { ok: false, err: '只有患者账号可填写档案' });
      const body = await readJson(req);
      const condition = String(body.condition || '').trim();
      const strokeType = String(body.strokeType || '');
      const side = String(body.side || '');
      const onsetDate = String(body.onsetDate || '');
      const concerns = Array.isArray(body.concerns)
        ? body.concerns.map((x) => String(x || '').trim()).filter((x) => x.length >= 2 && x.length <= 16).slice(0, 8)
        : [];
      const deficits = Array.isArray(body.deficits) ? body.deficits.filter((d) => DEFICITS.includes(d)) : [];
      const note = String(body.note || '').slice(0, 200);

      if (condition && !CONDITION_FLAT.includes(condition)) return json(res, 400, { ok: false, err: '病种无效' });
      if (strokeType && !STROKE_TYPES.includes(strokeType)) return json(res, 400, { ok: false, err: '卒中类型无效' });
      if (side && !STROKE_SIDES.includes(side)) return json(res, 400, { ok: false, err: '偏瘫侧无效' });
      if (onsetDate && (!/^\d{4}-\d{2}-\d{2}$/.test(onsetDate) || onsetDate > today())) {
        return json(res, 400, { ok: false, err: '发病日期不正确' });
      }

      users[name].profile = { condition, strokeType, side, onsetDate, concerns, deficits, note, updatedAt: Date.now() };
      saveUsers();
      broadcastAll();
      return json(res, 200, { ok: true, profile: users[name].profile });
    }

    if (p === '/api/patient/profile') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const patient = url.searchParams.get('patient') || (users[name].role === 'patient' ? name : '');
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      if (!users[patient]) return json(res, 404, { ok: false, err: '患者不存在' });
      return json(res, 200, { ok: true, profile: users[patient].profile || null });
    }

    if (p === '/api/assessment' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '只有监督者可以填写评估量表' });
      const body = await readJson(req);
      const a = buildAssessment(name, String(body.patient || '').trim(), String(body.type || ''), body);
      broadcastAll();
      return json(res, 200, { ok: true, assessment: a });
    }

    if (p === '/api/assessments') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      const fallback = role === 'family' ? (linkedPatientOf(name) || '') : (role === 'patient' ? name : '');
      const patient = url.searchParams.get('patient') || fallback;
      const type = url.searchParams.get('type') || '';
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      const list = assessments
        .filter((a) => a.patient === patient && (!type || a.type === type))
        .slice(-40).reverse();
      return json(res, 200, { ok: true, assessments: list, scales: TOOLBOX.map((s) => ({ key: s.key, name: s.name, short: s.short, totalMax: s.totalMax })) });
    }

    if (p === '/api/patients') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (!TEST_MODE && users[name].role !== 'supervisor') return json(res, 403, { ok: false, err: '无权查看' });
      const list = Object.entries(users).filter(([, u]) => u.role === 'patient').map(([n]) => n);
      return json(res, 200, { ok: true, patients: list });
    }

    // ---------------- 家属绑定 ----------------
    if (p === '/api/patient/invite') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'patient') return json(res, 403, { ok: false, err: '只有患者账号可生成绑定码' });
      return json(res, 200, { ok: true, code: issueInvite(name) });
    }

    if (p === '/api/family/link' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      if (users[name].role !== 'family') return json(res, 403, { ok: false, err: '只有家属账号可绑定' });
      const body = await readJson(req);
      const code = String(body.code || '').trim().toUpperCase();
      let patientName = null;
      if (code) {
        patientName = Object.keys(users).find((n) => users[n].role === 'patient' && (users[n].invite || '').toUpperCase() === code) || null;
        if (!patientName) return json(res, 400, { ok: false, err: '绑定码无效' });
      } else if (body.patient) {
        if (!TEST_MODE) return json(res, 400, { ok: false, err: '请使用绑定码' });
        const p2 = String(body.patient).trim();
        if (!users[p2] || users[p2].role !== 'patient') return json(res, 400, { ok: false, err: '患者不存在' });
        patientName = p2;
      } else {
        return json(res, 400, { ok: false, err: '请填写绑定码或选择患者' });
      }
      users[name].linkedPatient = patientName;
      saveUsers();
      broadcastAll();
      return json(res, 200, { ok: true, linkedPatient: patientName });
    }

    // ---------------- 异常预警 ----------------
    if (p === '/api/alerts') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      const fallback = role === 'family' ? (linkedPatientOf(name) || '') : (role === 'patient' ? name : '');
      const patient = url.searchParams.get('patient') || fallback;
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      const list = alerts.filter((a) => a.patient === patient).slice(-30).reverse();
      const unread = list.filter((a) => !a.read).length;
      return json(res, 200, { ok: true, alerts: list, unread });
    }

    if (p === '/api/alerts/read' && req.method === 'POST') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const body = await readJson(req);
      const id = String(body.id || '');
      const a = alerts.find((x) => x.id === id);
      if (!a) return json(res, 404, { ok: false, err: '预警不存在' });
      if (!canViewPatient(name, a.patient)) return json(res, 403, { ok: false, err: '无权操作' });
      a.read = true;
      broadcastAll();
      return json(res, 200, { ok: true });
    }

    // ---------------- 周报 ----------------
    if (p === '/api/weekly') {
      const name = sessionName(req);
      if (!name) return json(res, 401, { ok: false, err: '未登录' });
      const role = users[name].role;
      const fallback = role === 'family' ? (linkedPatientOf(name) || '') : (role === 'patient' ? name : '');
      const patient = url.searchParams.get('patient') || fallback;
      if (!patient) return json(res, 400, { ok: false, err: '请指定患者' });
      if (!canViewPatient(name, patient)) return json(res, 403, { ok: false, err: '无权查看' });
      const days = Math.min(30, Math.max(3, Number(url.searchParams.get('days') || 7)));
      return json(res, 200, { ok: true, report: weeklyReport(patient, days) });
    }

    return json(res, 404, { ok: false, err: 'not found' });
  } catch (e) {
    return json(res, 400, { ok: false, err: e.message || '请求失败' });
  }
});

/* ---------------------------------------------------------------- 视图 */
function profileOf(name) {
  const u = users[name] || {};
  const st = u.role === 'supervisor' ? sState(name) : null;
  return {
    name, role: u.role,
    areas: st ? st.areas : [],
    online: st ? st.online : false,
    verify: u.role === 'supervisor' ? verifyState(name) : null,
    training: u.role === 'supervisor' ? trainingState(name) : null,
    qualified: u.role === 'supervisor' ? isQualified(name) : null,
  };
}

function publicBooking(b) {
  return {
    id: b.id, patient: b.patient, supervisor: b.supervisor, date: b.date, slot: b.slot,
    area: b.area, address: b.address, focus: b.focus, complaint: b.complaint || '', status: b.status,
    createdAt: b.createdAt, scaleId: b.scaleId, timeline: b.timeline, cancelReason: b.cancelReason || '',
  };
}

/* ---------------------------------------------------------------- 周报 */
function round1(v) { return Math.round(v * 10) / 10; }

function weeklyReport(patient, days) {
  const to = Date.now();
  const from = to - days * 86400000;
  const completed = bookings.filter((b) => b.patient === patient && b.status === 'completed'
    && (b.completedAt || b.createdAt) >= from);
  const ss = scales.filter((s) => s.patient === patient && s.createdAt >= from);
  const as = assessments.filter((a) => a.patient === patient && a.createdAt >= from);
  const al = alerts.filter((a) => a.patient === patient && a.createdAt >= from);

  const avg = (arr, key) => (arr.length ? round1(arr.reduce((sum, x) => sum + x[key], 0) / arr.length) : null);
  const focus = completed.flatMap((b) => b.focus || []);
  const focusTop = Object.entries(focus.reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  const allAssess = assessments.filter((a) => a.patient === patient).slice(-60).reverse();
  const latest = {};
  allAssess.forEach((a) => { if (!latest[a.type]) latest[a.type] = a; });

  return {
    patient,
    days,
    window: { from, to },
    serviceCount: completed.length,
    serviceDates: [...new Set(completed.map((b) => b.date))],
    scaleCount: ss.length,
    vasAvg: avg(ss, 'vas'),
    completionAvg: avg(ss, 'completion'),
    vasMin: ss.length ? Math.min(...ss.map((s) => s.vas)) : null,
    vasMax: ss.length ? Math.max(...ss.map((s) => s.vas)) : null,
    abnormalCount: ss.filter((s) => s.abnormal).length,
    alertCount: al.length,
    alertHigh: al.filter((a) => a.level === 'high').length,
    focusTop,
    scaleSeries: ss.slice().reverse().map((s) => ({ date: s.date, vas: s.vas, completion: s.completion })),
    assessments: as.map((a) => ({ id: a.id, type: a.type, total: a.total, date: a.date, values: a.values })),
    latest: Object.entries(latest).map(([type, a]) => ({ type, total: a.total, date: a.date })),
    patientProfile: users[patient] ? users[patient].profile || null : null,
    generatedAt: to,
  };
}

function snapshotFor(name) {
  const u = users[name] || {};

  if (u.role === 'admin') {
    const sups = Object.entries(users).filter(([, x]) => x.role === 'supervisor').map(([n]) => ({
      name: n,
      verify: verifyState(n),
      training: trainingState(n),
      online: sState(n).online,
      areas: sState(n).areas,
    }));
    return {
      type: 'snapshot', role: 'admin', profile: profileOf(name),
      supervisors: sups,
      pending: sups.filter((x) => x.verify.status === 'pending'),
      stats: {
        total: sups.length,
        pending: sups.filter((x) => x.verify.status === 'pending').length,
        approved: sups.filter((x) => x.verify.status === 'approved').length,
        certified: sups.filter((x) => x.training.certified).length,
        onlineNow: sups.filter((x) => x.online).length,
      },
    };
  }

  if (u.role === 'family') {
    const p = linkedPatientOf(name);
    const mine = p ? bookings.filter((b) => b.patient === p) : [];
    return {
      type: 'snapshot',
      role: 'family',
      profile: profileOf(name),
      linkedPatient: p,
      patientProfile: p && users[p] ? users[p].profile || null : null,
      active: mine.filter((b) => ['pending', 'confirmed', 'checked_in'].includes(b.status)).slice(-10).map(publicBooking),
      history: mine.slice(-10).reverse().map(publicBooking),
      scales: p ? scales.filter((s) => s.patient === p).slice(-14).reverse() : [],
      assessments: p ? assessments.filter((a) => a.patient === p).slice(-40).reverse() : [],
      alerts: p ? alerts.filter((a) => a.patient === p).slice(-20).reverse() : [],
    };
  }

  if (u.role === 'supervisor') {
    const st = sState(name);
    const mine = bookings.filter((b) => b.supervisor === name);
    // 测试模式：监督者可见全部患者，方便直接试用工具箱；正式模式只看自己服务过的患者
    const bookingPatients = [...new Set(mine.map((b) => b.patient))];
    const myPatients = TEST_MODE
      ? [...new Set([...bookingPatients, ...Object.entries(users).filter(([, u]) => u.role === 'patient').map(([n]) => n)])]
      : bookingPatients;
    return {
      type: 'snapshot',
      role: 'supervisor',
      profile: profileOf(name),
      verify: verifyState(name),
      training: trainingState(name),
      qualified: isQualified(name),
      pendingList: mine.filter((b) => b.status === 'pending').slice(-20).map(publicBooking),
      activeList: mine.filter((b) => ['confirmed', 'checked_in'].includes(b.status)).slice(-20).map(publicBooking),
      history: mine.slice(-10).reverse().map(publicBooking),
      patients: myPatients,
      patientProfiles: myPatients.reduce((acc, p) => { acc[p] = users[p] ? users[p].profile || null : null; return acc; }, {}),
      assessments: assessments.filter((a) => myPatients.includes(a.patient)).slice(-40).reverse(),
    };
  }
  const mine = bookings.filter((b) => b.patient === name);
  return {
    type: 'snapshot',
    role: 'patient',
    profile: profileOf(name),
    patientProfile: users[name].profile || null,
    invite: users[name].invite || null,
    active: mine.filter((b) => ['pending', 'confirmed', 'checked_in'].includes(b.status)).slice(-10).map(publicBooking),
    history: mine.slice(-10).reverse().map(publicBooking),
    scales: scales.filter((s) => s.patient === name).slice(-14).reverse(),
    assessments: assessments.filter((a) => a.patient === name).slice(-40).reverse(),
    alerts: alerts.filter((a) => a.patient === name).slice(-20).reverse(),
  };
}

/* ---------------------------------------------------------------- WS */
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcastAll() {
  try { persistAll(); } catch (e) { /* ignore */ }
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(JSON.stringify(snapshotFor(ws.name))); } catch (e) { /* ignore */ }
  }
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { /* ignore */ }
  if (pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  if (pathname !== '/ws') { socket.destroy(); return; }

  const name = sessionName(req);
  if (!name) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.name = name; ws.isAlive = true;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(snapshotFor(ws.name)));
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

const ticker = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { clients.delete(ws); try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30 * 1000);

// 允许作为模块被测试引用时进程能正常退出（不影响线上心跳）
ticker.unref();

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

loadSnapshots();

module.exports = {
  start, canViewPatient, createBooking, confirmBooking, checkinBooking, completeBooking,
  buildScale, flowSteps, sessionView, users, sessions, routes: routeTable, access,
};

function start() {
  server.listen(PORT, HOST, () => {
    console.log(`[rehab] listening http://${HOST}:${PORT}${BASE}/ users=${Object.keys(users).length} bookings=${bookings.length} scales=${scales.length}`);
  });
}

if (require.main === module) start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(ticker);
    // 先断开所有 WS，否则 server.close() 会一直等长连接，导致重启卡在 deactivating
    for (const ws of clients) { try { ws.terminate(); } catch (e) { /* ignore */ } }
    clients.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  });
}
