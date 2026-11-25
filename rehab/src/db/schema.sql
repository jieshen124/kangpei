-- 康陪平台数据库结构
-- 设计取舍：业务对象的完整结构仍以 JSON 存在 data 列，关键字段单列建索引。
-- 这样第一步先解决"多进程写文件会丢数据、没有事务、没有索引"的问题，
-- 等接口稳定后再逐步把字段拆成独立列（不必现在做数据迁移）。

CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  supervisor TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_patient ON bookings(patient);
CREATE INDEX IF NOT EXISTS idx_bookings_supervisor ON bookings(supervisor);

CREATE TABLE IF NOT EXISTS scales (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  supervisor TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scales_patient ON scales(patient);

CREATE TABLE IF NOT EXISTS assessments (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  supervisor TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assess_patient ON assessments(patient);

CREATE TABLE IF NOT EXISTS alerts (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON alerts(patient);

CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  uploader   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_patient ON reports(patient);

CREATE TABLE IF NOT EXISTS flows (
  id         TEXT PRIMARY KEY,
  patient    TEXT NOT NULL,
  supervisor TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_supervisor ON flows(supervisor);

CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL DEFAULT '',
  uploaded_at INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch (
  user     TEXT NOT NULL,
  video_id TEXT NOT NULL,
  pos      REAL NOT NULL DEFAULT 0,
  done     INTEGER NOT NULL DEFAULT 0,
  at       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, video_id)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
