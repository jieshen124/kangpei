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

const PORT = Number(process.env.PORT || 3001);
const HOST = '127.0.0.1';
const BASE = '/rehab';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/rehab';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 16 * 1024;
// 测试阶段：默认开启免登录模式（设置 TEST_MODE=0 可恢复正式登录）
const TEST_MODE = process.env.TEST_MODE !== '0';

const AREAS = [
  '东城区', '西城区', '朝阳区', '海淀区', '丰台区', '石景山区',
  '通州区', '昌平区', '大兴区', '顺义区', '房山区', '门头沟区',
  '平谷区', '怀柔区', '密云区', '延庆区',
];

const SLOTS = [
  { id: 'am', label: '上午 09:00–11:00' },
  { id: 'pm', label: '下午 14:00–16:00' },
  { id: 'ev', label: '晚间 19:00–21:00' },
];

const FOCUS = ['关节活动度训练', '肌力训练', '平衡与步态', '心肺耐力', '日常生活能力', '术后恢复训练'];

/* ------------------------------------------------------ 卒中量表工具箱 */
const o = (v, l) => ({ v, l });

const BARTHEL_OPTS = {
  a: [o(0, '完全依赖'), o(5, '需部分帮助'), o(10, '完全独立')],          // 进食/穿衣/如厕
  b: [o(0, '完全依赖'), o(5, '完全独立')],                                // 洗澡/修饰
  c: [o(0, '完全失禁'), o(5, '偶尔失禁'), o(10, '能控制')],              // 大便/小便
  d: [o(0, '完全依赖'), o(5, '需大量帮助'), o(10, '需少量帮助'), o(15, '完全独立')], // 转移/行走
  e: [o(0, '不能'), o(5, '需帮助'), o(10, '完全独立')],                  // 上下楼梯
};

const MOTOR_OPTS = [o(1, 'Ⅰ 无随意运动'), o(2, 'Ⅱ 出现联合反应'), o(3, 'Ⅲ 共同运动'), o(4, 'Ⅳ 分离运动'), o(5, 'Ⅴ 分离运动完善'), o(6, 'Ⅵ 接近正常')];

const BERG_OPTS = [o(0, '不能完成'), o(1, '需大量帮助'), o(2, '需中等帮助'), o(3, '需少量帮助'), o(4, '独立完成')];

const TOOLBOX = [
  {
    key: 'barthel', name: 'Barthel 指数', short: '自理能力', desc: '10 项日常生活能力，满分 100 分', score: 'sum', totalMax: 100,
    items: [
      { k: 'feeding', label: '进食', opts: BARTHEL_OPTS.a },
      { k: 'bathing', label: '洗澡', opts: BARTHEL_OPTS.b },
      { k: 'grooming', label: '修饰（洗脸刷牙）', opts: BARTHEL_OPTS.b },
      { k: 'dressing', label: '穿衣', opts: BARTHEL_OPTS.a },
      { k: 'bowel', label: '控制大便', opts: BARTHEL_OPTS.c },
      { k: 'bladder', label: '控制小便', opts: BARTHEL_OPTS.c },
      { k: 'toilet', label: '如厕', opts: BARTHEL_OPTS.a },
      { k: 'transfer', label: '床椅转移', opts: BARTHEL_OPTS.d },
      { k: 'walking', label: '平地行走', opts: BARTHEL_OPTS.d },
      { k: 'stairs', label: '上下楼梯', opts: BARTHEL_OPTS.e },
    ],
  },
  {
    key: 'mrs', name: 'mRS 改良 Rankin 量表', short: '残障分级', desc: '0-6 分，越低越好', score: 'sum', totalMax: 6,
    items: [{
      k: 'level', label: '当前残障等级',
      opts: [o(0, '0 完全无症状'), o(1, '1 无明显残障，能完成日常'), o(2, '2 轻度残障，不能完成原有活动'),
        o(3, '3 中度残障，可独立行走'), o(4, '4 中重度残障，行走需帮助'), o(5, '5 重度残障，卧床/失禁'),
        o(6, '6 死亡')],
    }],
  },
  {
    key: 'brunnstrom', name: 'Brunnstrom 分期', short: '偏瘫运动恢复', desc: 'Ⅰ-Ⅵ 期，按上肢/手/下肢分别记录', score: 'none',
    items: [
      { k: 'upper', label: '上肢', opts: MOTOR_OPTS },
      { k: 'hand', label: '手', opts: MOTOR_OPTS },
      { k: 'lower', label: '下肢', opts: MOTOR_OPTS },
    ],
  },
  {
    key: 'berg', name: 'Berg 平衡量表', short: '平衡', desc: '14 项，满分 56 分，需现场看护下完成', score: 'sum', totalMax: 56,
    items: [
      { k: 'sit2stand', label: '从坐到站', opts: BERG_OPTS },
      { k: 'stand_unsup', label: '无支撑站立', opts: BERG_OPTS },
      { k: 'sit_unsup', label: '无支撑坐位', opts: BERG_OPTS },
      { k: 'stand2sit', label: '从站到坐', opts: BERG_OPTS },
      { k: 'transfer', label: '床椅转移', opts: BERG_OPTS },
      { k: 'stand_eyes', label: '闭眼站立', opts: BERG_OPTS },
      { k: 'stand_feet', label: '双足并拢站立', opts: BERG_OPTS },
      { k: 'reach', label: '站立位上肢前伸', opts: BERG_OPTS },
      { k: 'pickup', label: '站立位从地上拾物', opts: BERG_OPTS },
      { k: 'turn_head', label: '转身向后看', opts: BERG_OPTS },
      { k: 'turn360', label: '360° 转身', opts: BERG_OPTS },
      { k: 'stool', label: '踏凳（单足踏台阶）', opts: BERG_OPTS },
      { k: 'tandem', label: '双足前后站立', opts: BERG_OPTS },
      { k: 'one_leg', label: '单腿站立', opts: BERG_OPTS },
    ],
  },
  {
    key: 'holden', name: 'Holden 步行能力分级', short: '步行', desc: '0-5 级', score: 'sum', totalMax: 5,
    items: [{
      k: 'level', label: '步行能力',
      opts: [o(0, '0 不能步行（需轮椅）'), o(1, '1 室内需辅助步行'), o(2, '2 室内独立步行'),
        o(3, '3 监护下步行'), o(4, '4 平地独立步行'), o(5, '5 独立步行，可上下台阶')],
    }],
  },
  {
    key: 'ashworth', name: '改良 Ashworth 肌张力', short: '肌张力', desc: '按肌群记录 0-4 级', score: 'none',
    items: [
      { k: 'elbow_flex', label: '屈肘肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'elbow_ext', label: '伸肘肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'wrist', label: '腕屈肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'knee', label: '屈膝肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
      { k: 'ankle', label: '踝跖屈肌群', opts: [o(0, '0 无增高'), o(1, '1 轻微增高'), o(2, '2 明显增高'), o(3, '3 显著增高'), o(4, '4 僵硬')] },
    ],
  },
  {
    key: 'phq9', name: 'PHQ-9 情绪量表', short: '情绪', desc: '9 项，满分 27 分，≥10 分提示需关注', score: 'sum', totalMax: 27,
    items: [
      { k: 'q1', label: '做事提不起兴趣', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q2', label: '感到心情低落', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q3', label: '入睡困难或睡不醒', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q4', label: '感到疲倦、没力气', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q5', label: '食欲差或暴食', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q6', label: '自我评价低', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q7', label: '注意力不集中', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q8', label: '动作或说话迟缓/烦躁', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
      { k: 'q9', label: '有自伤念头', opts: [o(0, '完全不会'), o(1, '几天'), o(2, '一半以上时间'), o(3, '几乎每天')] },
    ],
  },
];

const SCALE_BY_KEY = TOOLBOX.reduce((acc, s) => { acc[s.key] = s; return acc; }, {});

const STROKE_TYPES = ['缺血性（脑梗）', '出血性（脑出血/蛛网膜下腔）', '未明确'];
const STROKE_SIDES = ['左侧偏瘫', '右侧偏瘫', '双侧', '无明显偏瘫'];
const DEFICITS = ['失语', '构音障碍', '吞咽困难', '认知障碍', '情绪低落', '肩痛', '足下垂', '平衡障碍', '感觉障碍'];

// 病种目录（按系统/部位分组，覆盖居家康复常见情形）
const CONDITIONS = [
  {
    group: '神经系统',
    items: [
      '脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后',
      '脊髓损伤（颈段）', '脊髓损伤（胸腰段）',
      '帕金森病', '帕金森综合征 / 多系统萎缩',
      '多发性硬化', '格林-巴利综合征恢复期',
      '周围性面瘫（面神经炎）', '小脑共济失调',
      '认知障碍 / 痴呆', '脊髓灰质炎后遗症',
      '臂丛神经损伤', '桡神经 / 尺神经损伤', '坐骨神经损伤',
    ],
  },
  {
    group: '骨与关节',
    items: [
      '髋关节置换术后', '膝关节置换术后', '肩关节置换术后',
      '股骨颈 / 粗隆间骨折术后', '四肢骨折术后', '骨盆骨折术后',
      '脊柱骨折 / 椎体压缩骨折',
      '腰椎间盘突出', '腰椎管狭窄 / 腰椎术后', '颈椎病 / 颈椎术后',
      '肩袖损伤', '肩周炎（冻结肩）',
      '网球肘 / 高尔夫球肘', '腕管综合征 / 腱鞘炎',
      '膝骨关节炎', '类风湿关节炎', '强直性脊柱炎',
      '半月板 / 交叉韧带术后', '跟腱断裂术后', '足底筋膜炎 / 拇外翻术后',
      '手外伤 / 肌腱修复术后', '截肢术后（假肢适配）',
      '烧伤后瘢痕与关节挛缩',
    ],
  },
  {
    group: '心肺',
    items: [
      '冠心病 / 支架术后', '冠脉搭桥术后', '心衰稳定期',
      '心脏起搏器 / 除颤器植入后',
      '慢阻肺（COPD）', '肺纤维化', '肺部感染后 / 术后肺康复',
      '支气管扩张', '长期卧床脱机困难',
    ],
  },
  {
    group: '内科与代谢',
    items: [
      '糖尿病周围神经病变', '糖尿病足（创面愈合期）', '透析患者运动康复',
      '肿瘤术后 / 放化疗后康复', '癌性疲乏', '重症后综合征（ICU 后）',
      '长期卧床 / 失用综合征', '贫血 / 营养不良性衰弱',
      '带状疱疹后神经痛', '感染后疲乏',
    ],
  },
  {
    group: '老年与功能衰退',
    items: [
      '老年衰弱 / 跌倒高风险', '失能老人日常照护',
      '吞咽障碍（老年）', '尿失禁 / 盆底功能训练', '骨质疏松（运动管理）',
    ],
  },
  {
    group: '儿童',
    items: ['脑瘫（儿童）', '发育迟缓', '脊柱侧弯', '先天性肌性斜颈', '臂丛神经产伤'],
  },
  {
    group: '其他',
    items: ['其他（在备注里说明）'],
  },
];
const CONDITION_FLAT = CONDITIONS.reduce((a, g) => a.concat(g.items), []);

// 病种对应的默认流程：0/1/2/3 为 Brunnstrom 分期，o 骨科，c 心肺，n 神经，g 通用
const GROUP_PROGRAM = {
  '神经系统': 'n', '骨与关节': 'o', '心肺': 'c',
  '内科与代谢': 'g', '老年与功能衰退': 'g', '儿童': 'n', '其他': 'g',
};
const CONDITION_PROGRAM = {};
CONDITIONS.forEach((g) => g.items.forEach((it) => { CONDITION_PROGRAM[it] = GROUP_PROGRAM[g.group] || 'g'; }));
// 偏瘫相关走 Brunnstrom
['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后'].forEach((c) => { CONDITION_PROGRAM[c] = '0'; });
// 个别病种单独归口
CONDITION_PROGRAM['糖尿病周围神经病变'] = 'n';
CONDITION_PROGRAM['糖尿病足（创面愈合期）'] = 'o';
CONDITION_PROGRAM['长期卧床 / 失用综合征'] = 'n';
CONDITION_PROGRAM['重症后综合征（ICU 后）'] = 'c';
CONDITION_PROGRAM['带状疱疹后神经痛'] = 'g';

// 只有这些偏瘫相关病种才适合 Brunnstrom 分期流程
const BRUNNSTROM_CONDITIONS = ['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后'];
const NEURO_CONDITIONS = ['脑卒中（脑梗）', '脑出血', '脑外伤术后', '脑肿瘤术后', '脊髓损伤（颈段）', '脊髓损伤（胸腰段）', '帕金森病', '帕金森综合征 / 多系统萎缩', '多发性硬化'];

// 主诉目录：用患者自己的话，不用专业术语
const CONCERNS = [
  '走路不稳、容易摔',
  '一侧胳膊抬不起来',
  '手指抓不住东西、扣不上扣子',
  '说话不清楚',
  '吃饭容易呛、吞咽费劲',
  '肩膀疼、夜里疼醒',
  '腿没劲、站不了多久',
  '上下楼梯费劲',
  '穿衣洗澡要人帮',
  '上厕所不方便',
  '手脚肿',
  '一动就喘、容易累',
  '睡不好、情绪低落',
  '记性差、容易忘事',
  '腰背疼、坐不住',
];


fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- 账号 */
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BOOK_FILE = path.join(DATA_DIR, 'bookings.jsonl');
const SCALE_FILE = path.join(DATA_DIR, 'scales.jsonl');

let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; } catch (e) { users = {}; }

// 兼容 v1 账号角色命名：user -> patient, therapist -> supervisor
(() => {
  let changed = false;
  for (const [name, u] of Object.entries(users)) {
    if (u.role === 'user') { u.role = 'patient'; changed = true; }
    if (u.role === 'therapist') { u.role = 'supervisor'; u.areas = u.areas || []; changed = true; }
    if (!Array.isArray(u.areas)) { u.areas = []; changed = true; }
  }
  if (changed) {
    const tmp = USERS_FILE + '.mig';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, USERS_FILE);
  }
})();

function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

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
const ASSESS_FILE = path.join(DATA_DIR, 'assessments.jsonl');
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
  fs.appendFile(ASSESS_FILE, JSON.stringify(a) + '\n', () => {});
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
  fs.appendFile(BOOK_FILE, JSON.stringify({ event: 'create', b, ts: now }) + '\n', () => {});
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
  fs.appendFile(SCALE_FILE, JSON.stringify(s) + '\n', () => {});
  evaluateScaleAlerts(patient, s, prev || null);
  return s;
}

/* ------------------------------------------------------ 异常预警 */
const ALERT_FILE = path.join(DATA_DIR, 'alerts.jsonl');
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
  fs.appendFile(ALERT_FILE, JSON.stringify(a) + '\n', () => {});
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
const COURSES = [
  {
    id: 'c1', title: '卒中基础认知与角色边界', minutes: 25,
    points: [
      '脑卒中分缺血性（脑梗）和出血性，恢复期通常以月计，训练靠日积月累，不存在"练几次就好"。',
      '常见后遗症：一侧肢体无力（偏瘫）、说话不清或听不懂（失语）、吞咽容易呛、走路不稳、情绪低落。',
      '你的角色是「训练陪伴 + 监督 + 记录」，不是治疗者：不做诊断、不判断病情好坏、不调整用药、不推荐保健品。',
      '训练强度要跟着患者当天状态走：疲劳、疼痛、情绪差时减量，不能为了完成计划硬顶。',
      '一切以主治医生和康复治疗师的方案为准，你的方案参考只是"今天练什么"的提示。',
    ],
    quiz: [
      { q: '患者家属问"你看他这样还能恢复吗"，正确做法是？', opts: ['根据经验给出乐观或悲观的判断', '说明自己不做病情判断，建议问主治医生', '说"肯定能好"让家属安心'], a: 1 },
      { q: '训练当天患者说头晕、没力气，你应该？', opts: ['按原计划练完，不能半途而废', '降低强度或改为被动活动，并记录情况', '直接结束服务且不记录'], a: 1 },
      { q: '以下哪项属于你的职责范围？', opts: ['调整降压药用量', '带练动作、监督完成、填写记录', '判断偏瘫能否恢复'], a: 1 },
    ],
  },
  {
    id: 'c2', title: '良肢位摆放与体位转移', minutes: 35,
    points: [
      '良肢位是为了防关节僵硬、防压疮、防肩痛，仰卧、患侧卧、健侧卧轮换，每 2 小时左右更换一次。',
      '仰卧时患侧肩下垫薄枕、手臂略外展；患侧卧时患肩前伸、不压在身上。',
      '翻身要托住患侧肩和髋，不能拽着患侧上肢拉人，容易造成肩关节半脱位和肩痛。',
      '床到椅转移：先让患者双脚踩实，身体前倾，健手扶稳，你站在患侧保护，不要从正面硬抱。',
      '全程防跌倒：地面无水、鞋要防滑、助行器位置放好，患者站起时你必须在患侧一手可及的范围。',
    ],
    quiz: [
      { q: '帮患者翻身时，正确做法是？', opts: ['拉住患侧手臂翻转', '托住患侧肩和髋部翻转', '让患者自己抓床沿硬翻'], a: 1 },
      { q: '床到椅转移时你应站在？', opts: ['患者正前方抱住', '患者患侧，随时可扶', '患者背后推'], a: 1 },
      { q: '良肢位摆放的主要目的不包括？', opts: ['预防关节僵硬与压疮', '预防肩痛', '替代康复训练'], a: 2 },
    ],
  },
  {
    id: 'c3', title: '按分期带练训练动作', minutes: 35,
    points: [
      'Ⅰ-Ⅱ 期以被动活动、良肢位、床上桥式为主，动作慢、幅度小，全程无痛范围。',
      'Ⅲ 期重点是诱发分离动作：双手交叉前伸、肘支撑、患手触肩触口、坐站转移。',
      'Ⅳ-Ⅴ 期练分离运动与平衡：屈肘、旋前旋后、腕背伸、抓放、重心转移、单腿支撑。',
      'Ⅵ 期练功能与耐力：弹力带抗阻、精细手功能、转身跨越、上下台阶、连续步行。',
      '带练口令要短、慢、清楚；每组之间必须休息；患者说疼就停，记录疼痛位置和程度。',
    ],
    quiz: [
      { q: 'Ⅲ 期训练的重点是？', opts: ['大重量抗阻', '诱发分离动作，打破共同运动', '长时间快走'], a: 1 },
      { q: '带练中患者说"疼"，正确做法是？', opts: ['让他忍一下继续', '立即停止该动作，记录位置和程度', '加大幅度活动开'], a: 1 },
      { q: '关于组间休息？', opts: ['尽量不休息提高效率', '每组之间必须安排休息', '只有患者要求才休息'], a: 1 },
    ],
  },
  {
    id: 'c4', title: '量表填写与记录规范', minutes: 25,
    points: [
      '每日量表四项：疼痛 VAS、训练完成度、肌力 MMT、疲劳程度，全部按当天实际情况点选。',
      '记录要客观：写"左膝屈曲到 90° 时诉痛 6 分"，不写"恢复得不错"这类评价。',
      '勾选"异常"时必须写清楚发生了什么、什么时候、当时在做什么。',
      '不能替患者美化数据，也不能凭印象估分；当天没做就不填。',
      '所有记录会同步给家属和平台，属于服务凭证，编造会被追责并取消资格。',
    ],
    quiz: [
      { q: '量表记录应该怎么写？', opts: ['"今天表现不错"', '"左膝屈曲到 90° 时诉痛 6 分"', '凭感觉估个大概分'], a: 1 },
      { q: '勾了"训练中出现异常"后？', opts: ['可以不填说明', '必须写清楚发生什么、何时、在做什么', '等下次再补'], a: 1 },
      { q: '没有完成的训练项目应该？', opts: ['按计划填满分保持好看', '按实际完成情况填写', '直接整个量表不填'], a: 1 },
    ],
  },
  {
    id: 'c5', title: '异常识别与应急处置', minutes: 30,
    points: [
      '立刻停止训练并拨打 120 的红线：胸痛胸闷、呼吸困难、意识模糊或叫不醒、突然说话不清或一侧无力加重、剧烈头痛、抽搐、跌倒撞到头部。',
      '同时做三件事：让患者平躺或侧卧（呕吐时侧卧防呛）、解开领口、立刻联系家属并上报平台。',
      '你不得给患者服用任何药物、不得做推拿复位、不得判断"没事"，一切等急救人员。',
      '轻微情况（训练后肌肉酸痛、轻度疲劳）可以减量并记录，但持续加重必须上报。',
      '每次服务结束前，确认患者状态平稳、家门锁好、家属知情后才能离开。',
    ],
    quiz: [
      { q: '训练中患者突然说话不清、一侧无力加重，你应该？', opts: ['休息一下观察半小时', '立即停止、拨打 120、通知家属并上报', '喂一片家里的药'], a: 1 },
      { q: '患者呕吐时应该让他？', opts: ['仰卧平躺', '侧卧，头偏向一侧防呛', '坐起来喝水'], a: 1 },
      { q: '以下哪项你绝对不能做？', opts: ['记录异常并上报', '给患者服用药物或做推拿复位', '联系家属'], a: 1 },
    ],
  },
  {
    id: 'c6', title: '服务规范与合规红线', minutes: 20,
    points: [
      '准时到达，进门先核对身份和预约信息，穿戴整洁、洗手后再接触患者。',
      '不做医疗承诺：不说"包好""能治好"，不推荐药品、保健品、理疗仪器。',
      '隐私保护：不拍摄患者面部和居家环境外传，不在社交平台发布服务照片。',
      '边界：不与患者发生金钱借贷、代购、私下加价接单；不单独在卧室闭门服务。',
      '服务结束要有双方确认（签到、完成、量表），这是你的服务凭证和纠纷依据。',
    ],
    quiz: [
      { q: '家属问"吃这个保健品有用吗"，你应该？', opts: ['推荐几个自己知道的品牌', '说明自己不推荐任何药品保健品，建议问医生', '说吃了肯定有帮助'], a: 1 },
      { q: '关于拍摄？', opts: ['可以拍患者训练视频发朋友圈宣传', '不拍摄患者面部和居家环境外传', '征得家属口头同意就可以发抖音'], a: 1 },
      { q: '私下和客户约单、绕过平台收款？', opts: ['可以，双方都省钱', '严禁，属于违规', '只要平台不知道就行'], a: 1 },
    ],
  },
];

const PASS_PER_COURSE = 2; // 每门 3 题，答对 2 题及格

/* ------------------------------------------------------ 诊断报告 */
const REPORT_DIR = path.join(DATA_DIR, 'reports');
const REPORT_FILE = path.join(DATA_DIR, 'reports.json');
const REPORT_MAX = 12 * 1024 * 1024;
const REPORT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

let reports = [];
try {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const rr = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  reports = Array.isArray(rr) ? rr : [];
} catch (e) { reports = []; }

function saveReports() {
  const tmp = REPORT_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(reports)); fs.renameSync(tmp, REPORT_FILE); } catch (e) { /* ignore */ }
}

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
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');

const PHASES = ['准备', '热身', '核心训练', '放松', '记录'];

// 每种阶段共用：到场检查 / 热身 / 放松 / 量表交底
const FLOW_SHARED = {
  safe: {
    key: 'safe', phase: 0, title: '到场安全检查', minutes: 3,
    goal: '确认今天可以开始，把不该开始的情况挡在门外',
    cues: ['核对患者姓名与本次预约信息', '问清今天有没有胸痛、头晕、发烧、没吃饭、没睡好', '清地面障碍物，轮椅刹车，座椅靠墙'],
    donts: ['不判断病情、不调药、不建议停药', '状态明显不对时不要"练一点试试"'],
    stops: ['胸痛 / 呼吸困难 / 意识不清 → 不开始，直接 120'],
  },
  warm: {
    key: 'warm', phase: 1, title: '热身与关节活动', minutes: 8,
    goal: '让身体热起来，降低拉伤和血压骤升的风险',
    cues: ['健侧手带动患侧上肢，缓慢来回 10 次', '肩胛骨上下左右各活动 10 次', '踝泵 20 次，配合腹式呼吸 5 次'],
    donts: ['不暴力牵拉，不追求"咔"的响声', '出现疼痛立刻减小幅度'],
    stops: ['疼痛 VAS ≥ 7 → 停止主动活动，改为被动'],
  },
  cool: {
    key: 'cool', phase: 3, title: '放松与收尾', minutes: 5,
    goal: '把心率降下来，固定今天的训练成果',
    cues: ['缓慢被动活动 3 分钟', '患侧肢体垫高 10 分钟', '喝温水，问一句"现在感觉怎么样"'],
    donts: ['不练到大汗淋漓才收', '不让患者自己走回房间'],
    stops: [],
  },
  scale: {
    key: 'scale', phase: 4, title: '填写量表与家属交底', minutes: 5,
    goal: '留下可追踪的记录，让家属知道今天做了什么',
    cues: ['按真实情况填疼痛、完成度、肌力、疲劳', '有异常必须写清发生时间与处理方式', '告诉家属今天练了什么、晚上注意什么'],
    donts: ['不美化数据、不省略异常', '不做"多久能好"的承诺'],
    stops: [],
  },
};

// 按 Brunnstrom 分期给的核心训练步骤
const STAGE_STEPS = {
  '0': {
    label: 'Brunnstrom Ⅰ–Ⅱ 期（卧床 / 联合反应期）',
    short: 'Ⅰ–Ⅱ 期',
    steps: [
      {
        key: 'pos', title: '良肢位摆放', minutes: 5,
        goal: '防止肩痛、关节僵硬和压疮',
        cues: ['仰卧时患侧肩下垫薄枕，上肢略外展', '患侧卧位时患侧在下，健侧腿屈曲在前', '每 2 小时换一次体位'],
        donts: ['翻身时不拽患侧上肢', '不要把枕头垫在肘下，会加重屈曲'],
        stops: ['皮肤发红不消退 → 记录并告知家属'],
      },
      {
        key: 'rom', title: '被动关节活动', minutes: 8,
        goal: '维持关节活动度，防止粘连',
        cues: ['一手固定近端，一手托住远端再动', '肩、肘、腕、髋、膝、踝每个关节 8–10 次', '到有阻力就停，不追求极限'],
        donts: ['不越过疼痛范围', '不快速抖动或甩动肢体'],
        stops: ['关节突然剧痛或肿胀 → 停止，就医'],
      },
      {
        key: 'roll', title: '翻身训练（辅助）', minutes: 6,
        goal: '恢复床上转移能力，减少卧床并发症',
        cues: ['双手交叉抱肩（Bobath 握手）', '屈膝、头转向、用骨盆带动身体', '向患侧翻时护住患肩'],
        donts: ['不让患者拉患侧手臂发力', '不放手让患者独立完成'],
        stops: ['头晕、眼前发黑 → 立即停止，平卧'],
      },
      {
        key: 'sit', title: '坐位平衡（床边）', minutes: 6,
        goal: '建立坐稳的能力，为转移做准备',
        cues: ['双脚踩实地面，膝与髋同高', '双手先撑床面，再逐步减少扶持', '每次坐稳 30 秒，做 3 组'],
        donts: ['不坐软沙发或床沿外侧', '不空腹久坐'],
        stops: ['出现头晕或面色变化 → 立即躺下'],
      },
      {
        key: 'breathe', title: '呼吸与排痰', minutes: 3,
        goal: '改善通气，预防肺部感染',
        cues: ['鼻吸口呼，慢吸慢呼 5 次', '深吸气后轻咳两声', '拍背由下往上、由外向内'],
        donts: ['不重叩脊柱和肾区', '饭后 1 小时内不排痰'],
        stops: ['咳血、胸痛 → 停止并就医'],
      },
    ],
  },
  '1': {
    label: 'Brunnstrom Ⅲ 期（共同运动期）',
    short: 'Ⅲ 期',
    steps: [
      {
        key: 'sitstand', title: '坐-站转移（辅助）', minutes: 8,
        goal: '把"站起来"这件事做对，而不是靠拽',
        cues: ['双脚后收，身体前倾，鼻子过膝盖', '患侧膝顶住健侧膝，防止膝内扣', '站起来站稳 3 秒再坐下'],
        donts: ['不拉扶手硬拽起来', '不许膝盖向内扣着站'],
        stops: ['站起时头晕 → 立即坐下'],
      },
      {
        key: 'support', title: '患侧上肢支撑负重', minutes: 6,
        goal: '给患侧肩肘建立承重能力',
        cues: ['手掌张开撑桌面，肘微屈', '从 10 秒开始，逐次延长到 30 秒', '肩膀不要耸起来'],
        donts: ['不让肘关节过伸锁死', '不撑在软垫或不稳的桌面上'],
        stops: ['肩部疼痛 → 停止支撑，改被动活动'],
      },
      {
        key: 'inhibit', title: '共同运动抑制（慢速）', minutes: 6,
        goal: '学会只动一个关节，而不是整条胳膊一起使劲',
        cues: ['动作放慢到 3 秒一次', '只做目标关节，其他部位保持放松', '一出现代偿动作立即停下重来'],
        donts: ['不追求幅度和次数', '不在疲劳状态下练这个'],
        stops: ['越练越僵、代偿更多 → 减量'],
      },
      {
        key: 'shift', title: '坐位重心转移', minutes: 6,
        goal: '把重心敢放到患侧，是走路的前提',
        cues: ['左右各 10 次，回中间停 3 秒', '患侧多给一点重量', '家属站在患侧保护'],
        donts: ['不突然推患者', '不让患者坐在床边缘'],
        stops: ['心慌、出汗 → 停止休息'],
      },
      {
        key: 'standsit', title: '辅助下站立平衡', minutes: 5,
        goal: '建立站立稳定性',
        cues: ['双手扶持，双脚与肩同宽', '站稳 30 秒，逐步减到单手扶', '眼睛看前方一个固定点'],
        donts: ['不独自站立', '不穿拖鞋练'],
        stops: ['摇晃明显 → 退回坐位'],
      },
    ],
  },
  '2': {
    label: 'Brunnstrom Ⅳ–Ⅴ 期（分离运动期）',
    short: 'Ⅳ–Ⅴ 期',
    steps: [
      {
        key: 'reach', title: '分离运动：够物 / 手碰嘴', minutes: 8,
        goal: '把上肢从"整条一起动"拆成单关节控制',
        cues: ['肩不抬、肘带动，慢慢伸向目标', '目标放在患侧斜前方', '每次 10 遍，中间休息'],
        donts: ['不用健手帮忙推', '不耸肩代偿'],
        stops: ['肩前部疼痛 → 降低高度'],
      },
      {
        key: 'singleleg', title: '单腿负重与重心转移', minutes: 8,
        goal: '让患腿真正承重，减少走路画圈',
        cues: ['患腿承重，健腿迈半步', '手扶固定物，身体直立', '每次 20 秒，做 3 组'],
        donts: ['不锁死膝关节', '不在湿滑地面练'],
        stops: ['膝痛或打软腿 → 停止'],
      },
      {
        key: 'step', title: '原地踏步与迈步分解', minutes: 8,
        goal: '建立正确的迈步顺序',
        cues: ['先抬患腿，再迈健腿', '口令"慢—稳—停"', '一步一停，不连续走'],
        donts: ['不追求速度和距离', '不在疲劳时练步态'],
        stops: ['拖步明显加重 → 休息后再来'],
      },
      {
        key: 'stairs', title: '上下台阶（扶扶手）', minutes: 6,
        goal: '练真实的上下楼能力',
        cues: ['上台阶健腿先，下台阶患腿先', '一级一停，全程扶扶手', '有人在侧后方保护'],
        donts: ['不两级并一步', '不背手上下'],
        stops: ['心慌、腿抖 → 立即停止'],
      },
      {
        key: 'adl', title: '日常生活任务模拟', minutes: 6,
        goal: '把训练变成能用的动作',
        cues: ['穿衣先穿患侧，脱衣先脱健侧', '进食坐正，患手放桌面上', '允许慢，不催'],
        donts: ['不替他全部做完', '不因为慢就上手代劳'],
        stops: ['情绪明显低落 → 停止，先安抚'],
      },
    ],
  },
  '3': {
    label: 'Brunnstrom Ⅵ 期（接近正常期）',
    short: 'Ⅵ 期',
    steps: [
      {
        key: 'hand', title: '精细手功能训练', minutes: 8,
        goal: '恢复抓握、捏取等日常手部能力',
        cues: ['捡豆子、拧瓶盖、捏橡皮，患手为主', '健手只做辅助，不代劳', '每次换一个任务，避免枯燥'],
        donts: ['不长时间持续抓握', '不练到手指僵硬发抖'],
        stops: ['手指肿胀、发紫 → 停止并抬高'],
      },
      {
        key: 'walk', title: '步行耐力与速度控制', minutes: 10,
        goal: '把走路从"能走"变成"走得稳、走得远"',
        cues: ['室内往返 3 趟，每趟休息 1 分钟', '步幅均匀，不快不慢', '以"能说话不喘"为强度上限'],
        donts: ['不走腿发软才停', '无人看护时不练'],
        stops: ['胸闷、头晕 → 立即停止坐下'],
      },
      {
        key: 'balance', title: '平衡干扰训练', minutes: 6,
        goal: '应对真实环境里的意外干扰',
        cues: ['轻推肩部、转身取物、闭眼站立', '始终靠墙或有人保护', '每次 30 秒'],
        donts: ['不突然大力推', '不在软垫或床上练'],
        stops: ['差点跌倒 → 立即降级'],
      },
      {
        key: 'community', title: '社区场景模拟', minutes: 6,
        goal: '把训练带到真实环境',
        cues: ['过门槛、走斜坡、按电梯按钮', '先看路再走，不边走边说话', '全程有人陪同'],
        donts: ['不独自过马路', '不练自动扶梯'],
        stops: ['环境嘈杂导致紧张 → 回到室内'],
      },
      {
        key: 'chore', title: '家务任务分解', minutes: 5,
        goal: '恢复参与家庭事务的能力和信心',
        cues: ['擦桌、叠衣、摆碗筷，分 3 段做', '每段之间休息 2 分钟', '做完一起检查，给正反馈'],
        donts: ['不搬重物、不登高', '不因为做不好就批评'],
        stops: ['腰背痛 → 停止，调整姿势'],
      },
    ],
  },
  'o': {
    label: '骨科术后流程（关节 / 骨折 / 腰颈）',
    short: '骨科术后',
    warm: {
      key: 'oWarm', phase: 1, title: '肌肉激活与关节活动', minutes: 6,
      goal: '让关节和肌肉先苏醒，避免一上来就负重',
      cues: ['绷紧大腿/臀部肌肉 5 秒再放松，做 10 次', '健侧带动患侧，缓慢活动', '任何动作以"疼痛不加重"为界'],
      donts: ['不在肿胀部位做热敷', '不做突然发力、扭转的动作'],
      stops: ['疼痛 VAS ≥ 7 → 停止，改冰敷抬高'],
    },
    pre: [
      {
        key: 'oCheck', phase: 0, title: '今天能不能练（医嘱与伤口）', minutes: 3,
        goal: '确认负重限制和伤口情况，别把康复练成二次损伤',
        cues: ['确认医生说的负重程度：完全 / 部分 / 禁止', '看伤口有没有渗液、红肿、发热', '问夜间痛和肿胀比昨天是轻了还是重了'],
        donts: ['不越过医嘱的负重和角度限制', '有发热或伤口渗液今天就不练'],
        stops: ['伤口渗液增多、发热 → 停止并联系医生'],
      },
    ],
    steps: [
      {
        key: 'oSwelling', title: '消肿与循环', minutes: 12,
        goal: '把肿消下去，肿胀不消关节就练不动',
        cues: ['患肢抬高，高过心脏', '踝泵 20 次，做 3 组', '急性肿胀可冰敷 15 分钟（隔布）'],
        donts: ['不热敷急性肿胀部位', '不揉捏小腿肚（防血栓脱落）'],
        stops: ['小腿突然肿胀、发热疼痛 → 立即就医排查血栓'],
      },
      {
        key: 'oRom', title: '关节活动度', minutes: 15,
        goal: '在安全范围内把角度一点点找回来',
        cues: ['无痛范围内主动活动 + 手辅助', '每个方向 10 次，慢到能控制', '用毛巾、助行器做辅助，不硬掰'],
        donts: ['不暴力掰腿掰肩', '不越医嘱角度（髋屈不超 90°、不内旋）'],
        stops: ['卡住并有锐痛 → 停在痛点之前，不硬顶'],
      },
      {
        key: 'oLoad', title: '负重与力量', minutes: 10,
        goal: '按医嘱恢复承重，走稳比走远重要',
        cues: ['按医嘱部分或完全负重，用助行器/拐杖', '先站稳再迈步，步幅小、节奏慢', '坐站 5 次 × 2 组，膝盖不内扣'],
        donts: ['不单腿跳、不提重物、不爬楼梯练'],
        stops: ['关节突然打软 → 坐下休息，改天再练'],
      },
    ],
    cool: {
      key: 'oCool', phase: 3, title: '冰敷抬高与复查肿胀', minutes: 6,
      goal: '把今天的反应压下去，为明天留余地',
      cues: ['抬高患肢 15 分钟', '记录肿胀围度和疼痛分', '告诉家属今天做了什么、晚上注意什么'],
      donts: ['不马上泡热水澡', '不当天加练第二遍'],
      stops: ['肿胀明显加重 → 明天减量并联系医生'],
    },
  },
  'c': {
    label: '心肺流程（心脏 / 呼吸）',
    short: '心肺',
    warm: {
      key: 'cWarm', phase: 1, title: '慢走与呼吸热身', minutes: 5,
      goal: '让心率平缓上来，避免一开始就喘',
      cues: ['原地或室内慢走 3 分钟', '缩唇呼吸 10 次（吸 2 秒、呼 4 秒）', '测一次静息心率与血氧并记下'],
      donts: ['不做突然用力的动作', '不做憋气发力的动作'],
      stops: ['静息血氧 < 90% → 今天不练，联系家属'],
    },
    pre: [
      {
        key: 'cCheck', phase: 0, title: '今天能不能练（测三项）', minutes: 4,
        goal: '心率和血压决定今天练不练、练多少',
        cues: ['测静息心率、血压、血氧各一次', '问有没有胸闷、夜里憋醒、腿肿', '确认今天按时吃了降压/利尿药'],
        donts: ['血压 ≥180/110 或 ≤90/60 今天不练', '饭后 1 小时内不练'],
        stops: ['胸痛、明显气促 → 立即停止并拨打 120'],
      },
    ],
    steps: [
      {
        key: 'cBreath', title: '呼吸训练', minutes: 10,
        goal: '学会把气呼干净，减少憋气和喘',
        cues: ['缩唇呼吸 10 次，呼气要慢要长', '腹式呼吸：手放肚子上感受起伏', '有痰时身体前倾、轻咳两声'],
        donts: ['不用力憋气', '不深吸到头晕眼花'],
        stops: ['头晕、眼前发黑 → 恢复自然呼吸，坐稳'],
      },
      {
        key: 'cWalk', title: '间歇步行', minutes: 12,
        goal: '在有氧区间里走，而不是走到喘不上气',
        cues: ['走 3 分钟、歇 1 分钟，做 3–5 组', '强度以"能说话不喘"为准', '全程有人陪，随身带水'],
        donts: ['不冲刺、不爬坡、不追赶时间'],
        stops: ['血氧 < 88%、心率超医嘱上限、胸闷 → 立即停'],
      },
      {
        key: 'cStrength', title: '低强度力量', minutes: 8,
        goal: '保住肌肉，不让体力继续往下掉',
        cues: ['坐站 5 次 × 2 组，起身时呼气', '弹力带划船 8 次，动作慢', '组间休息 1 分钟'],
        donts: ['不用力时憋气（瓦尔萨尔瓦动作）', '不做举过头顶的动作'],
        stops: ['头晕、心慌、脸色变白 → 立即停'],
      },
    ],
    cool: {
      key: 'cCool', phase: 3, title: '减速与恢复', minutes: 6,
      goal: '让心率平稳落回来，记录今天的强度',
      cues: ['慢走 2 分钟逐步降速', '呼吸恢复到能正常说话', '记下心率、血氧和疲劳分（Borg）'],
      donts: ['不练完立刻坐下不动', '不当场加量'],
      stops: ['休息 5 分钟心率仍明显偏高 → 记录并告知家属'],
    },
  },
  'n': {
    label: '神经流程（帕金森 / 脊髓损伤 / 周围神经）',
    short: '神经',
    warm: {
      key: 'nWarm', phase: 1, title: '牵伸与关节活动', minutes: 8,
      goal: '先把痉挛和僵硬降下来，再谈动作',
      cues: ['痉挛肌群缓慢牵伸，每个 30 秒', '各关节全范围活动 10 次', '起身前先坐 30 秒，观察有没有头晕'],
      donts: ['不暴力牵拉痉挛肢体', '不长时间站立后突然起身'],
      stops: ['头晕、血压下降 → 平卧抬腿'],
    },
    pre: [
      {
        key: 'nCheck', phase: 0, title: '今天能不能练（皮肤与体位）', minutes: 3,
        goal: '压疮和体位性低血压是这类患者最常见的坑',
        cues: ['检查骶尾、足跟、坐骨结节皮肤', '问有没有起身头晕、痉挛加重、便秘', '检查轮椅刹车、助行器是否完好'],
        donts: ['皮肤发红不消退的地方今天不再受压', '不空腹训练'],
        stops: ['皮肤破溃、发热 → 停止并告知家属'],
      },
    ],
    steps: [
      {
        key: 'nTransfer', title: '转移与体位', minutes: 12,
        goal: '把床、椅、轮椅之间的移动做安全',
        cues: ['床到椅：先坐起停 30 秒再站', '轮椅转移：锁刹车、收脚踏、靠近床边', '每 30 分钟换一次体位减压'],
        donts: ['不拽衣服、不拉手臂起身', '不让患者独自完成第一次转移'],
        stops: ['头晕或腿打软 → 坐回床上'],
      },
      {
        key: 'nBalance', title: '平衡与步态', minutes: 12,
        goal: '减少跌倒，把走路节奏找回来',
        cues: ['帕金森：起步先脚跟踩实，口令"抬—迈"', '转身分两步走，不原地硬转', '脊髓损伤：坐位双手撑、前后左右够物'],
        donts: ['不催促走快', '不在湿滑地面练转身'],
        stops: ['差点跌倒 → 降级为扶持下练习'],
      },
      {
        key: 'nTask', title: '日常任务练习', minutes: 10,
        goal: '让训练变成能自己完成的事',
        cues: ['穿衣先穿患侧、脱衣先脱健侧', '进食坐正，手放桌面上', '手功能：捏豆子、拧瓶盖，患手为主'],
        donts: ['不全部代劳', '不因为慢就批评'],
        stops: ['情绪崩溃 → 停止并安抚'],
      },
    ],
    cool: {
      key: 'nCool', phase: 3, title: '放松与体位摆放', minutes: 6,
      goal: '把痉挛降下来，减少今晚的不适',
      cues: ['缓慢牵伸 3 分钟', '受压部位垫枕、患侧支撑', '喝温水，问一句感受'],
      donts: ['不让患者自己走回房间'],
      stops: ['痉挛明显加重 → 记录并调整下次强度'],
    },
  },
  'g': {
    label: '通用流程（非偏瘫病种）',
    short: '通用',
    steps: [
      {
        key: 'todayTask', title: '定今天要解决的一件事', minutes: 5,
        goal: '把"想解决的问题"缩成今天做得完的一件小事',
        cues: ['从患者的主诉里挑一件最影响生活的事', '跟患者确认：今天就练这一个', '把目标写下来，越小越好'],
        donts: ['一次不要同时改几个问题', '不做"多久能好"的承诺'],
        stops: ['患者明确抗拒 → 换更小的目标，别硬推'],
      },
      {
        key: 'taskStep', title: '任务拆解练习', minutes: 12,
        goal: '把大目标拆成小步骤，一步一步过',
        cues: ['拆成 3 个小步骤，每步做 3–5 次', '每完成一步给一句明确的反馈', '做不到就把步骤再拆细'],
        donts: ['不练到力竭', '不用"再试一次"硬顶'],
        stops: ['疼痛 VAS ≥ 7 或头晕 → 立即停止'],
      },
      {
        key: 'carry', title: '搬进真实场景', minutes: 8,
        goal: '让今天练的动作在生活里真的用得上',
        cues: ['放进真实场景做：穿衣、起身、倒水、上台阶', '让患者自己完成，监督者只在旁边保护', '记下卡在哪一步，下次从这里开始'],
        donts: ['不全部代劳', '不催促、不批评'],
        stops: ['情绪明显崩溃 → 停止，先安抚'],
      },
    ],
  },

};

// 异常处理指引（现场照着做）
const INCIDENTS = [
  {
    type: 'chest', title: '胸痛 / 胸闷 / 大汗', severity: 'high', label: '立即 120',
    dos: ['立刻停止训练，让患者半坐位', '松开衣领和腰带，保持安静', '拨打 120，记录症状开始的准确时间', '有家属在场就让他陪着，不要离开'],
    donts: ['不要喂硝酸甘油、阿司匹林或任何药', '不要让患者自己走去门口等车'],
    note: '这类情况可能是心脏问题，现场唯一正确动作是停下并叫急救。',
  },
  {
    type: 'stroke', title: '新出现的口齿不清 / 一侧无力 / 脸歪', severity: 'high', label: '立即 120',
    dos: ['立刻停止训练', '记下症状第一次出现的时间（溶栓时间窗靠这个）', '让患者侧卧，防止呕吐误吸', '拨打 120，说明"疑似再发卒中"'],
    donts: ['不要喂水喂饭', '不要掐人中、不要按摩肢体', '不要等"看看会不会自己好"'],
    note: '已经得过卒中的患者再次出现神经症状，时间就是大脑。',
  },
  {
    type: 'dizzy', title: '头晕 / 天旋地转', severity: 'mid', label: '休息后就医',
    dos: ['立即停止，坐下或平卧', '抬高下肢 20–30 厘米', '有血压计就测一次并记录', '休息 5 分钟后再评估'],
    donts: ['不要继续练站立和步行', '不要让患者自己走回房间'],
    note: '5 分钟不缓解，或伴言语不清、走路不稳，按卒中处理直接 120。',
  },
  {
    type: 'pain', title: '疼痛明显加重（VAS ≥ 7 或比上次涨 3 分）', severity: 'mid', label: '降级训练',
    dos: ['停止当前动作', '问清疼痛位置、性质（刺痛 / 胀痛 / 撕裂感）', '换更低强度或改被动活动', '如实记进量表并告知家属'],
    donts: ['不要让患者"忍一忍"', '急性期不要热敷或用力按揉'],
    note: '持续不缓解、局部肿胀或畸形，转就医排查。',
  },
  {
    type: 'fall', title: '跌倒', severity: 'high', label: '评估后再动',
    dos: ['先别急着扶起来', '检查意识、疼痛部位、四肢能不能动', '怀疑骨折就固定原地不动', '拨打 120 或联系家属送医'],
    donts: ['不要抱起、不要摇晃', '不要让患者"试试能不能站"'],
    note: '头部着地即使当时清醒也要就医观察，警惕迟发颅内出血。',
  },
  {
    type: 'emotion', title: '情绪崩溃 / 哭泣 / 拒绝训练', severity: 'mid', label: '陪伴优先',
    dos: ['停止训练，坐下来陪着', '让他把话说完，不打断', '带做 5 次深呼吸，等情绪平复', '记录并提醒家属关注情绪状态'],
    donts: ['不要说"想开点""别人更惨"', '不要用训练进度施压'],
    note: '情绪持续低落两周以上，建议家属带去做专业评估（PHQ-9 可先自查）。',
  },
  {
    type: 'seizure', title: '抽搐 / 意识丧失', severity: 'high', label: '立即 120',
    dos: ['让患者侧卧', '清空周围硬物，垫软物护头', '记录抽搐持续时间', '拨打 120'],
    donts: ['不要按压肢体、不要强行掰开', '不要往嘴里塞任何东西'],
    note: '超过 5 分钟不停，或短时间内反复发作，属于急症。',
  },
  {
    type: 'shoulder', title: '肩痛 / 肩关节半脱位', severity: 'mid', label: '停止牵拉',
    dos: ['停止上举和牵拉动作', '用枕头支撑患侧上肢', '避免拉吊环、拽手臂', '建议就医评估'],
    donts: ['不要强行上举', '不要旋转拉扯肩关节'],
    note: '偏瘫肩很常见，处理原则是"支撑、不拉扯"，硬练会变成慢性疼痛。',
  },
  {
    type: 'bp', title: '血压异常（≥180/110 或 ≤90/60）', severity: 'high', label: '复测后就医',
    dos: ['停止训练，静坐 5 分钟', '复测一次并记录数值', '联系家属说明情况'],
    donts: ['不要自行加服降压药', '不要继续训练"看看会不会降"'],
    note: '复测仍异常，或伴头痛、胸闷、视物模糊，立即就医。',
  },
];

let flows = [];
try { const pf = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8')); flows = Array.isArray(pf) ? pf : []; } catch (e) { flows = []; }
let sessionSeq = flows.length;

/* ------------------------------------------------------ 快照持久化 */
const BOOK_SNAP = path.join(DATA_DIR, 'bookings.json');
const SCALE_SNAP = path.join(DATA_DIR, 'scales.json');
const ALERT_SNAP = path.join(DATA_DIR, 'alerts.json');
const ASSESS_SNAP = path.join(DATA_DIR, 'assessments.json');

function readJsonlSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}
function readSnapSafe(file) {
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(x) ? x : null;
  } catch (e) { return null; }
}
function writeSnap(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) { /* 忽略：下次再写 */ }
}
function maxSeq(list, prefix) {
  return list.reduce((m, x) => {
    const n = parseInt(String((x && x.id) || '').slice(prefix.length), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
}

function loadSnapshots() {
  // 预约：优先快照；没有快照时用 jsonl 的 create 事件兜底
  bookings = readSnapSafe(BOOK_SNAP) || readJsonlSafe(BOOK_FILE)
    .filter((x) => x && x.event === 'create' && x.b && x.b.id)
    .map((x) => x.b);
  scales = readSnapSafe(SCALE_SNAP) || readJsonlSafe(SCALE_FILE).filter((x) => x && x.id);
  alerts = readSnapSafe(ALERT_SNAP) || readJsonlSafe(ALERT_FILE).filter((x) => x && x.id);
  assessments = readSnapSafe(ASSESS_SNAP) || readJsonlSafe(ASSESS_FILE).filter((x) => x && x.id);
  bookSeq = maxSeq(bookings, 'B');
  scaleSeq = maxSeq(scales, 'S');
  alertSeq = maxSeq(alerts, 'N');
  assessSeq = maxSeq(assessments, 'A');
  sessionSeq = maxSeq(flows, 'F');
}

function persistAll() {
  writeSnap(BOOK_SNAP, bookings.slice(-400));
  writeSnap(SCALE_SNAP, scales.slice(-500));
  writeSnap(ALERT_SNAP, alerts.slice(-1000));
  writeSnap(ASSESS_SNAP, assessments.slice(-500));
  writeSnap(path.join(DATA_DIR, 'sessions.json'), flows.slice(-800));
}


function saveFlows() {
  const tmp = path.join(DATA_DIR, 'sessions.json') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(flows, null, 2));
  fs.renameSync(tmp, path.join(DATA_DIR, 'sessions.json'));
}

function flowSteps(stage) {
  const st = STAGE_STEPS[String(stage)];
  if (!st) return null;
  const order = [
    FLOW_SHARED.safe,
    ...(st.pre || []),
    st.warm || FLOW_SHARED.warm,
    ...st.steps,
    st.cool || FLOW_SHARED.cool,
    FLOW_SHARED.scale,
  ];
  const last = order.length - 1;
  return order.map((s, i) => {
    // 阶段按位置推导：首=准备，次=热身，末=记录，倒数第二=放松，其余=核心
    const derived = (i === 0) ? 0 : (i === 1) ? 1 : (i === last) ? 4 : (i === last - 1) ? 3 : 2;
    const phase = (s.phase != null) ? s.phase : derived;
    return {
      key: s.key, phase, phaseLabel: PHASES[phase],
      title: s.title, goal: s.goal, minutes: s.minutes,
      cues: s.cues || [], donts: s.donts || [], stops: s.stops || [],
    };
  });
}

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
const VIDEO_FILE = path.join(DATA_DIR, 'videos.json');
const WATCH_FILE = path.join(DATA_DIR, 'watch.json');
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

let videos = [];
try { videos = JSON.parse(fs.readFileSync(VIDEO_FILE, 'utf8')) || []; } catch (e) { videos = []; }

// 观看进度：{ 用户名: { 视频id: {pos, dur, done, at} } }
let watchState = {};
try { watchState = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')) || {}; } catch (e) { watchState = {}; }

function saveVideos() {
  const tmp = VIDEO_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(videos, null, 2));
  fs.renameSync(tmp, VIDEO_FILE);
}

function saveWatch() {
  const tmp = WATCH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(watchState, null, 2));
  fs.renameSync(tmp, WATCH_FILE);
}

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

function canViewPatient(viewer, patient) {
  if (!users[viewer] || !users[patient]) return false;
  if (viewer === patient) return true;
  const u = users[viewer];
  if (u.role === 'supervisor') return true;
  if (u.role === 'family') return u.linkedPatient === patient;
  return false;
}

/* ---------------------------------------------------------------- 会话 */
const sessions = new Map();

function createSession(name) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name, exp: Date.now() + SESSION_TTL });
  return token;
}

function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
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
    let size = 0; const chunks = [];
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

/* ---------------------------------------------------------------- HTTP */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length) || '/';

  try {
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
      const stage = String(body.stage || '');
      const steps = flowSteps(stage);
      if (!steps) return json(res, 400, { ok: false, err: '请选择 Brunnstrom 分期' });
      const s = {
        id: 'F' + String(++sessionSeq).padStart(4, '0'),
        patient, supervisor: name, stage,
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

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

loadSnapshots();

server.listen(PORT, HOST, () => {
  console.log(`[rehab] v2 listening http://${HOST}:${PORT}${BASE}/ users=${Object.keys(users).length} bookings=${bookings.length} scales=${scales.length}`);
});

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
