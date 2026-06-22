/**
 * routes/reviews.js
 * 学生评审相关
 *
 *   GET  /api/reviews/tasks/my?assignmentId=X     我的待评列表
 *   GET  /api/reviews/tasks/:id/submission        查看待评作业（仅本人）
 *   POST /api/reviews                              提交评审
 */

const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');

const router = express.Router();
router.use(authRequired);

// GET /api/reviews/all?assignmentId=X —— 教师：查看本作业的所有评审
router.get('/all', requireRole('teacher'), (req, res) => {
  const aid = req.query.assignmentId ? Number(req.query.assignmentId) : null;
  if (!aid) return res.status(400).json({ error: 'assignmentId 必填' });

  const a = db.prepare(`
    SELECT a.id FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = ? AND c.teacher_id = ?
  `).get(aid, req.user.id);
  if (!a) return res.status(404).json({ error: '作业不存在或不属于你' });

  const rows = db.prepare(`
    SELECT rt.id            AS task_id,
           rt.assignment_id,
           rt.submission_id,
           rt.anonymous_id,
           rt.reviewer_id,
           ru.username       AS reviewer_username,
           ru.real_name      AS reviewer_name,
           (rv.id IS NOT NULL) AS completed,
           rv.score,
           rv.comment,
           rv.submitted_at
      FROM review_tasks rt
      JOIN users ru ON ru.id = rt.reviewer_id
      LEFT JOIN reviews rv ON rv.task_id = rt.id
     WHERE rt.assignment_id = ?
     ORDER BY rt.id
  `).all(aid);

  res.json({ tasks: rows });
});

// GET /api/reviews/tasks/my
router.get('/tasks/my', requireRole('student'), (req, res) => {
  const aid = req.query.assignmentId ? Number(req.query.assignmentId) : null;
  if (!aid) return res.status(400).json({ error: 'assignmentId 必填' });

  const tasks = db.prepare(`
    SELECT rt.id            AS task_id,
           rt.assignment_id,
           rt.anonymous_id,
           rt.submission_id,
           (rv.id IS NOT NULL) AS completed,
           rv.score,
           rv.comment,
           rv.submitted_at
      FROM review_tasks rt
      LEFT JOIN reviews rv ON rv.task_id = rt.id
     WHERE rt.assignment_id = ? AND rt.reviewer_id = ?
     ORDER BY rt.id
  `).all(aid, req.user.id);

  res.json({ tasks });
});

// GET /api/reviews/tasks/:id/submission —— 仅指派的 reviewer 可看
router.get('/tasks/:id/submission', requireRole('student'), (req, res) => {
  const tid = Number(req.params.id);
  const task = db.prepare(`
    SELECT rt.id, rt.anonymous_id, rt.assignment_id,
           s.id AS submission_id, s.file_name, s.content, s.file_path, s.file_size, s.mime_type
      FROM review_tasks rt
      JOIN submissions s ON s.id = rt.submission_id
     WHERE rt.id = ? AND rt.reviewer_id = ?
  `).get(tid, req.user.id);
  if (!task) return res.status(404).json({ error: '任务不存在或不属于你' });

  // 注意：这里只返回 anonymous_id，不返回 submission 的 student_id
  // 评阅者无法得知被评人真实身份
  res.json({
    task_id:        task.id,
    anonymous_id:   task.anonymous_id,
    submission_id:  task.submission_id,
    file_name:      task.file_name,
    file_size:      task.file_size,
    mime_type:      task.mime_type,
    download_url:   task.submission_id ? `/api/submissions/file/${task.submission_id}` : null,
    content:        task.content
  });
});

// POST /api/reviews —— 提交评审
router.post('/', requireRole('student'), (req, res) => {
  const { task_id, score, comment } = req.body || {};
  if (!task_id || score == null) {
    return res.status(400).json({ error: 'task_id 和 score 必填' });
  }
  if (typeof score !== 'number' || score < 0 || score > 100) {
    return res.status(400).json({ error: 'score 必须是 0-100 的数字' });
  }

  const task = db.prepare(
    'SELECT id FROM review_tasks WHERE id = ? AND reviewer_id = ?'
  ).get(task_id, req.user.id);
  if (!task) return res.status(404).json({ error: '任务不存在或不属于你' });

  const existed = db.prepare('SELECT id FROM reviews WHERE task_id = ?').get(task_id);
  if (existed) return res.status(409).json({ error: '已经评过该任务' });

  const id = Number(db.prepare(
    'INSERT INTO reviews (task_id, score, comment) VALUES (?, ?, ?)'
  ).run(task_id, Math.round(score), comment || null).lastInsertRowid);

  res.status(201).json({ id, task_id, score: Math.round(score), comment: comment || null });
});

module.exports = router;
