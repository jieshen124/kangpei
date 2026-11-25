'use strict';
const repo = require('../db/repo');

const ALL_ROLES = ['patient', 'family', 'supervisor', 'admin'];

/**
 * 患者数据可见性：唯一出口。
 * 原来的实现在 supervisor 分支直接 return true，等于任意监督者可读任意患者档案。
 * 现在改成"必须存在业务关系"：自己 / 管理员 / 绑定家属 / 有预约或流程的监督者。
 */
function canViewPatient(viewer, patient, users) {
  if (!viewer || !patient) return false;
  if (!users[viewer] || !users[patient]) return false;
  if (viewer === patient) return true;
  const role = users[viewer].role;
  if (role === 'admin') return true;
  if (role === 'family') return repo.familyHasPatient(viewer, patient, users);
  if (role === 'supervisor') return repo.supervisorHasPatient(viewer, patient);
  return false;
}

function roleOf(user, users) {
  return user && users[user] ? users[user].role : null;
}

module.exports = { canViewPatient, roleOf, ALL_ROLES };
