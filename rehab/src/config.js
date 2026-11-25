'use strict';
const path = require('path');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = '/rehab';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/rehab';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 会话 7 天；请求体上限 16KB（报告/视频走独立上传分支，不受此限制）
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 16 * 1024;

// 测试阶段：默认开启免登录模式（设置 TEST_MODE=0 可恢复正式登录）
const TEST_MODE = process.env.TEST_MODE !== '0';

// 数据库文件：默认与业务数据同目录，便于整目录备份
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'rehab.db');

// 历史 JSON 数据目录（迁移来源，只读）
const LEGACY_DIR = DATA_DIR;

module.exports = {
  PORT, HOST, BASE, DATA_DIR, PUBLIC_DIR,
  SESSION_TTL, MAX_BODY, TEST_MODE, DB_FILE, LEGACY_DIR,
};
