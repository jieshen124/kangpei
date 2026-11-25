'use strict';

/**
 * 路由权限清单：一处声明，中间件统一执行。
 * 以前权限判断散在 50 个 if 分支里，漏一个就是越权；现在默认拒绝，
 * /api/ 下没有登记的路径直接 404，未登录一律 401。
 *
 * roles: 'public' 表示不需要登录；数组表示允许的角色。
 * handler 内部仍保留更细的资源级判断（例如"这条预约是不是你的"）。
 */
const ROUTES = [
  ['GET', '/api/me', 'public'],
  ['POST', '/api/register', 'public'],
  ['POST', '/api/login', 'public'],
  ['POST', '/api/logout', 'public'],
  ['POST', '/api/dev-login', 'public'],

  ['GET', '/api/supervisors', 'auth'],
  ['POST', '/api/book', ['patient', 'family']],
  ['POST', '/api/supervisor/online', ['supervisor']],

  ['GET', '/api/training/courses', 'auth'],
  ['POST', '/api/training/exam', ['supervisor']],
  ['POST', '/api/training/video/upload', ['admin', 'supervisor']],
  ['GET', '/api/training/videos', 'auth'],
  ['POST', '/api/training/video/watch', 'auth'],
  ['POST', '/api/training/video/delete', ['admin']],
  ['POST', '/api/training/demo', ['supervisor']],

  ['POST', '/api/supervisor/credentials', ['supervisor']],
  ['GET', '/api/admin/overview', ['admin']],
  ['POST', '/api/admin/review', ['admin']],

  ['POST', '/api/book/confirm', ['supervisor']],
  ['POST', '/api/book/checkin', ['supervisor']],
  ['POST', '/api/book/complete', ['supervisor']],
  ['POST', '/api/book/cancel', ['patient', 'family', 'supervisor', 'admin']],
  ['GET', '/api/bookings', 'auth'],

  ['GET', '/api/protocol', ['supervisor']],
  ['POST', '/api/session/start', ['supervisor']],
  ['POST', '/api/session/step', ['supervisor']],
  ['POST', '/api/session/incident', ['supervisor']],
  ['POST', '/api/session/abort', ['supervisor']],
  ['POST', '/api/session/finish', ['supervisor']],
  ['GET', '/api/sessions', 'auth'],

  ['POST', '/api/scale', ['supervisor']],
  ['GET', '/api/scales', 'auth'],
  ['GET', '/api/toolbox/meta', 'auth'],

  ['POST', '/api/patient/report/upload', ['patient', 'family']],
  ['GET', '/api/patient/reports', 'auth'],
  ['GET', '/api/report/get', 'auth'],
  ['POST', '/api/report/delete', 'auth'],

  ['POST', '/api/patient/profile', ['patient']],
  ['GET', '/api/patient/profile', 'auth'],
  ['GET', '/api/patients', ['supervisor', 'admin']],
  ['GET', '/api/patient/invite', ['patient']],
  ['POST', '/api/family/link', ['family']],

  ['POST', '/api/assessment', ['supervisor']],
  ['GET', '/api/assessments', 'auth'],

  ['GET', '/api/alerts', 'auth'],
  ['POST', '/api/alerts/read', 'auth'],
  ['GET', '/api/weekly', 'auth'],
];

const TABLE = new Map(ROUTES.map(([m, p, roles]) => [m + ' ' + p, { m, p, roles }]));
const PATHS = new Set(ROUTES.map(([, p]) => p));

function match(method, path) {
  return TABLE.get(method + ' ' + path) || null;
}

function knownPath(path) {
  return PATHS.has(path);
}

/**
 * 统一鉴权。返回 null 表示放行，否则返回 {code, err}。
 * @param {{method:string, path:string, user:string|null, role:string|null}} ctx
 */
function check({ method, path, user, role }) {
  if (!path.startsWith('/api/')) return null; // 静态资源与 /meta 走各自分支
  const route = match(method, path);
  if (!route) {
    if (knownPath(path)) return { code: 405, err: '请求方法不允许' };
    return { code: 404, err: '接口不存在' };
  }
  if (route.roles === 'public') return null;
  if (!user) return { code: 401, err: '请先登录' };
  if (route.roles === 'auth') return null;
  if (!route.roles.includes(role)) return { code: 403, err: '当前账号无权执行该操作' };
  return null;
}

module.exports = { ROUTES, TABLE, match, knownPath, check };
