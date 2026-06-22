/**
 * db.js
 * 数据库连接与表结构初始化
 *
 * 使用 Node.js 24 内置的 node:sqlite 模块（同步 API，零依赖）。
 * 首次加载时自动建表；后续加载复用同一连接（Node 模块缓存）。
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// 开启外键约束（SQLite 默认关闭）
db.exec('PRAGMA foreign_keys = ON;');
// WAL 模式提升并发读写性能
db.exec('PRAGMA journal_mode = WAL;');

/**
 * 初始化表结构（IF NOT EXISTS 可重复执行）
 * 与本系统设计文档保持一致。
 */
db.exec(`
  -- 用户表（教师 / 学生）
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    real_name     TEXT,
    role          TEXT    NOT NULL CHECK(role IN ('teacher', 'student')),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 班级表
  CREATE TABLE IF NOT EXISTS classes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name  TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    teacher_id  INTEGER NOT NULL REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 班级成员关联表
  CREATE TABLE IF NOT EXISTS class_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id   INTEGER NOT NULL REFERENCES classes(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    student_no TEXT    NOT NULL,
    joined_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(class_id, user_id)
  );

  -- 作业定义表
  CREATE TABLE IF NOT EXISTS assignments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id          INTEGER NOT NULL REFERENCES classes(id),
    title             TEXT    NOT NULL,
    description       TEXT,
    submit_deadline   DATETIME,
    review_deadline   DATETIME,
    reviews_per_person INTEGER DEFAULT 3,
    status            TEXT    DEFAULT 'open' CHECK(status IN ('open', 'reviewing', 'closed')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 提交表（一人一份）
  CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id),
    student_id    INTEGER NOT NULL REFERENCES users(id),
    file_path     TEXT,
    file_name     TEXT,
    file_size     INTEGER,
    mime_type     TEXT,
    content       TEXT,
    submitted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(assignment_id, student_id)
  );

  -- 分发任务表（核心：谁评谁）
  CREATE TABLE IF NOT EXISTS review_tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id),
    reviewer_id   INTEGER NOT NULL REFERENCES users(id),
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    anonymous_id  TEXT    NOT NULL,
    UNIQUE(assignment_id, reviewer_id, submission_id)
  );

  CREATE INDEX IF NOT EXISTS idx_review_tasks_reviewer
    ON review_tasks(reviewer_id, assignment_id);
  CREATE INDEX IF NOT EXISTS idx_review_tasks_submission
    ON review_tasks(submission_id);

  -- 评审内容表
  CREATE TABLE IF NOT EXISTS reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      INTEGER NOT NULL UNIQUE REFERENCES review_tasks(id),
    score        INTEGER,
    comment      TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 表结构迁移：旧库缺列时自动 ALTER（幂等）
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
ensureColumn('submissions',  'file_size',     'INTEGER');
ensureColumn('submissions',  'mime_type',     'TEXT');
ensureColumn('assignments',  'attachment_path','TEXT');
ensureColumn('assignments',  'attachment_name','TEXT');
ensureColumn('assignments',  'attachment_size','INTEGER');
ensureColumn('assignments',  'attachment_mime','TEXT');

module.exports = db;
