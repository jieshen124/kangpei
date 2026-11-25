'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require server 之前指定临时目录，避免碰到 /var/lib/rehab
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rehab-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_FILE = path.join(TMP, 'rehab.db');
process.env.TEST_MODE = '0';

const app = require('../server');
const routes = require('../src/routes');
const access = require('../src/middleware/access');
const repo = require('../src/db/repo');
const catalog = require('../src/data/catalog');

/* --------------------------------------------------------------- 流程数据 */

test('流程步序：每个分期的步数与阶段顺序', () => {
  const expect = { 0: 9, 1: 9, 2: 9, 3: 9, o: 8, c: 8, n: 8, g: 7 };
  for (const [stage, count] of Object.entries(expect)) {
    const steps = app.flowSteps(stage);
    assert.ok(steps, `分期 ${stage} 应存在`);
    assert.equal(steps.length, count, `分期 ${stage} 步数`);
    assert.equal(steps[0].key, 'safe', `分期 ${stage} 首步应是安全检查`);
    assert.equal(steps[steps.length - 1].key, 'scale', `分期 ${stage} 末步应是量表`);
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i].phase >= steps[i - 1].phase, `分期 ${stage} 阶段需单调不回退`);
    }
  }
  assert.equal(app.flowSteps('zzz'), null, '未知分期返回 null');
});

test('骨科/心肺/神经流程把"今天能不能练"放在热身之前', () => {
  for (const stage of ['o', 'c', 'n']) {
    const steps = app.flowSteps(stage);
    const warmIndex = steps.findIndex((s) => s.phase === 1);
    const prep = steps.filter((s) => s.phase === 0);
    assert.ok(warmIndex > 0, `${stage} 应有热身步骤`);
    assert.ok(prep.length >= 2, `${stage} 应有安全检查 + 病种专项判断（均在准备阶段）`);
    assert.ok(steps.slice(warmIndex).every((s) => s.phase !== 0), `${stage} 专项判断不能排到热身之后`);
  }
});

/* ----------------------------------------------------------------- 路由鉴权 */

test('路由清单：未登记 404、未登录 401、角色不符 403', () => {
  assert.equal(routes.check({ method: 'GET', path: '/api/scales', user: null, role: null }).code, 401);
  assert.equal(routes.check({ method: 'GET', path: '/api/nope', user: 'a', role: 'patient' }).code, 404);
  assert.equal(routes.check({ method: 'POST', path: '/api/scales', user: 'a', role: 'patient' }).code, 405);
  assert.equal(routes.check({ method: 'POST', path: '/api/scale', user: 'a', role: 'patient' }).code, 403);
  assert.equal(routes.check({ method: 'POST', path: '/api/session/start', user: 'a', role: 'family' }).code, 403);
});

test('路由清单：公开与放行分支', () => {
  assert.equal(routes.check({ method: 'GET', path: '/api/me', user: null, role: null }), null);
  assert.equal(routes.check({ method: 'POST', path: '/api/login', user: null, role: null }), null);
  assert.equal(routes.check({ method: 'POST', path: '/api/scale', user: 'a', role: 'supervisor' }), null);
  assert.equal(routes.check({ method: 'POST', path: '/api/book', user: 'a', role: 'patient' }), null);
  assert.equal(routes.check({ method: 'POST', path: '/api/book', user: 'a', role: 'supervisor' }).code, 403);
});

/* --------------------------------------------------------------- 患者可见性 */

test('患者可见性：监督者必须存在业务关系', () => {
  const users = {
    p1: { role: 'patient', createdAt: 1 },
    p2: { role: 'patient', createdAt: 1 },
    s1: { role: 'supervisor', areas: [], createdAt: 1 },
    s2: { role: 'supervisor', areas: [], createdAt: 1 },
    f1: { role: 'family', linkedPatient: 'p1', createdAt: 1 },
    f2: { role: 'family', linkedPatient: 'p2', createdAt: 1 },
    a1: { role: 'admin', createdAt: 1 },
  };
  repo.saveUsers(users);

  // 没有任何预约/流程时，监督者不能读任意患者（这是原来 canViewPatient 的越权点）
  assert.equal(access.canViewPatient('s1', 'p1', users), false);
  assert.equal(access.canViewPatient('s1', 'p2', users), false);

  repo.saveAll({
    bookings: [{
      id: 'B0001', patient: 'p1', supervisor: 's1', status: 'confirmed',
      createdAt: Date.now(), timeline: [],
    }],
  });

  assert.equal(access.canViewPatient('s1', 'p1', users), true, '有预约即可看');
  assert.equal(access.canViewPatient('s1', 'p2', users), false, '不能顺带看别的患者');
  assert.equal(access.canViewPatient('s2', 'p1', users), false, '别的监督者不行');
  assert.equal(access.canViewPatient('f1', 'p1', users), true, '绑定家属可看');
  assert.equal(access.canViewPatient('f2', 'p1', users), false, '未绑定家属不行');
  assert.equal(access.canViewPatient('a1', 'p2', users), true, '管理员可看');
  assert.equal(access.canViewPatient('p1', 'p1', users), true, '本人可看');
  assert.equal(access.canViewPatient('p2', 'p1', users), false, '其他患者不行');
  assert.equal(access.canViewPatient('ghost', 'p1', users), false, '不存在的账号不行');
});

/* ------------------------------------------------------------------ 预约流 */

test('预约状态机：创建 → 确认 → 签到，乱序被拒', () => {
  const p = { role: 'patient', createdAt: 1 };
  const s = { role: 'supervisor', areas: [], createdAt: 1 };
  users_add(p, s);

  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setDate(d.getDate() + 1);
  const date = d.toISOString().slice(0, 10);

  const b = app.createBooking('p_test', {
    supervisor: 's_test',
    date,
    slot: catalog.SLOTS[0].id,
    area: catalog.AREAS[0],
    address: '测试地址一号',
    focus: ['脖子僵'],
  });
  assert.equal(b.status, 'pending');
  assert.ok(b.timeline.length >= 1);

  assert.throws(() => app.checkinBooking('s_test', b.id), /需先确认预约/);
  app.confirmBooking('s_test', b.id);
  assert.equal(b.status, 'confirmed');
  assert.throws(() => app.confirmBooking('s_test', b.id), /已处理/);
  app.checkinBooking('s_test', b.id);
  assert.equal(b.status, 'checked_in');

  // 同一监督者同一时段不能再约
  assert.throws(() => app.createBooking('p_test', {
    supervisor: 's_test', date, slot: catalog.SLOTS[0].id,
    area: catalog.AREAS[0], address: '测试地址二号', focus: [],
  }), /已被预约/);

  // 别的监督者不能操作
  assert.throws(() => app.confirmBooking('s_other', b.id), /不是你的预约/);
});

function users_add(p, s) {
  app.users.p_test = p;
  app.users.s_test = s;
  app.users.s_other = { role: 'supervisor', areas: [], createdAt: 1 };
  repo.saveUsers(app.users);
}

/* -------------------------------------------------------------- 数据落库 */

test('SQLite 往返：写入后能读回同一条预约', () => {
  const id = 'B0901';
  repo.saveAll({
    bookings: [{
      id, patient: 'p1', supervisor: 's1', status: 'pending',
      createdAt: Date.now(), timeline: [], address: '回读测试',
    }],
  });
  const loaded = repo.loadBookings(400).find((x) => x.id === id);
  assert.ok(loaded, '应能从库里读回');
  assert.equal(loaded.address, '回读测试');
  assert.equal(loaded.status, 'pending');
});

test('历史 JSON 导入可重复执行，按 id 覆盖不产生重复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehab-legacy-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ legacy_u: { role: 'patient', createdAt: 1 } }));
  fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify([{
    id: 'B0888', patient: 'legacy_u', supervisor: '', status: 'pending', createdAt: 1, timeline: [],
  }]));
  repo.importLegacy(dir);
  repo.importLegacy(dir);
  const rows = repo.loadBookings(400).filter((x) => x.id === 'B0888');
  assert.equal(rows.length, 1, '重复导入不应产生重复行');
  assert.equal(rows[0].patient, 'legacy_u');
});
