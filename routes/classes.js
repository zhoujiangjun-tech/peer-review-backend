/**
 * routes/classes.js
 * 班级管理（教师创建/查看，学生加入）
 *
 *   POST /api/classes              教师创建
 *   GET  /api/classes              列出我的班级
 *   POST /api/classes/join         学生用邀请码加入
 *   GET  /api/classes/:id/members  教师查看班级成员
 */

const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');

const router = express.Router();
router.use(authRequired);

// POST /api/classes —— 教师创建班级
router.post('/', requireRole('teacher'), (req, res) => {
  const { class_name } = req.body || {};
  if (!class_name) return res.status(400).json({ error: 'class_name 必填' });

  const invite_code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const id = Number(db.prepare(
    `INSERT INTO classes (class_name, invite_code, teacher_id)
     VALUES (?, ?, ?)`
  ).run(class_name, invite_code, req.user.id).lastInsertRowid);

  res.status(201).json({ id, class_name, invite_code, teacher_id: req.user.id });
});

// GET /api/classes —— 列出当前用户可见的班级
router.get('/', (req, res) => {
  const classes = req.user.role === 'teacher'
    ? db.prepare(
        'SELECT * FROM classes WHERE teacher_id = ? ORDER BY id DESC'
      ).all(req.user.id)
    : db.prepare(
        `SELECT c.* FROM classes c
         JOIN class_members cm ON cm.class_id = c.id
         WHERE cm.user_id = ? ORDER BY c.id DESC`
      ).all(req.user.id);
  res.json({ classes });
});

// POST /api/classes/join —— 学生用邀请码加入
router.post('/join', requireRole('student'), (req, res) => {
  const { invite_code, student_no } = req.body || {};
  if (!invite_code || !student_no) {
    return res.status(400).json({ error: 'invite_code 和 student_no 必填' });
  }

  const cls = db.prepare('SELECT id FROM classes WHERE invite_code = ?').get(invite_code);
  if (!cls) return res.status(404).json({ error: '邀请码无效' });

  const joined = db.prepare(
    'SELECT id FROM class_members WHERE class_id = ? AND user_id = ?'
  ).get(cls.id, req.user.id);
  if (joined) return res.status(409).json({ error: '已加入该班级' });

  db.prepare(
    'INSERT INTO class_members (class_id, user_id, student_no) VALUES (?, ?, ?)'
  ).run(cls.id, req.user.id, student_no);

  res.json({ class_id: cls.id, student_no });
});

// GET /api/classes/:id/members —— 教师查看成员
router.get('/:id/members', requireRole('teacher'), (req, res) => {
  const classId = Number(req.params.id);
  const cls = db.prepare(
    'SELECT id FROM classes WHERE id = ? AND teacher_id = ?'
  ).get(classId, req.user.id);
  if (!cls) return res.status(404).json({ error: '班级不存在或不属于你' });

  const members = db.prepare(`
    SELECT u.id, u.username, u.real_name, cm.student_no, cm.joined_at
      FROM class_members cm
      JOIN users u ON u.id = cm.user_id
     WHERE cm.class_id = ?
     ORDER BY cm.student_no
  `).all(classId);

  res.json({ members });
});

module.exports = router;
