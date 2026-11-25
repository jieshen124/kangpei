'use strict';
const fs = require('fs');
const path = require('path');
const { Database } = require('node-sqlite3-wasm');

let db = null;

/**
 * 打开数据库并建表。
 * 用 node-sqlite3-wasm（纯 WASM，无本地编译依赖），
 * 好处是线上 Node 18 和本地 Node 22 都能直接跑，不用装编译器。
 */
function open(dbFile) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new Database(dbFile);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

/** 事务包装：异常回滚，避免半截写入 */
function tx(fn) {
  const d = get();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

function close() {
  if (db) { try { db.close(); } catch (_) { /* ignore */ } db = null; }
}

module.exports = { open, get, tx, close };
