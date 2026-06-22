/**
 * routes/assignments.js
 * 作业管理 + 触发分发 + 查看进度
 *
 *   POST /api/assignments                教师发布
 *   GET  /api/assignments?classId=...    列出我的作业
 *   POST /api/assignments/:id/distribute 教师触发分发（核心）
 *   GET  /api/assignments/:id/progress   教师查看评审进度
 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const mime = require('mime-types');

const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { distributeReviews } = require('../assignmentService');
const { UPLOAD_DIR, upload, isPreviewable, rfc5987, decodeOriginalName } = require('./_uploadUtil');

const router = express.Router();
router.use(authRequired);

// ============== Office 文档实时转 HTML 预览 ==============
//   ?format=html    返回 text/html 片段（用于内嵌 iframe srcdoc 预览）
//   不带 format     按原文件流式返回（下载 / 图片 / pdf 预览）
async function tryDocxAsHtml(abs, fileName, res) {
  if (!/\.docx$/i.test(fileName || '')) return false;
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ path: abs });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
           line-height: 1.7; color: #1f2937; padding: 16px 24px; margin: 0;
           background: #fff; font-size: 14px;}
      h1,h2,h3{color: #111; margin: 1em 0 0.5em;}
      p{margin: 0.6em 0;}
      img{max-width: 100%;}
      table{border-collapse: collapse; width: 100%;}
      td,th{border: 1px solid #d1d5db; padding: 4px 8px;}
    </style></head><body>${result.value || '<p><em>（文档无文字内容）</em></p>'}</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(html);
    return true;
  } catch (e) {
    res.status(500).json({ error: 'docx 解析失败：' + e.message });
    return true;
  }
}

// POST /api/assignments —— 教师发布作业（支持可选附件）
router.post('/', requireRole('teacher'), upload.single('attachment'), (req, res) => {
  const { class_id, title, description, submit_deadline, review_deadline } = req.body || {};
  if (!class_id || !title) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'class_id 和 title 必填' });
  }

  const cls = db.prepare(
    'SELECT id FROM classes WHERE id = ? AND teacher_id = ?'
  ).get(Number(class_id), req.user.id);
  if (!cls) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: '班级不存在或不属于你' });
  }

  const file       = req.file;
  const att_path   = file ? `/uploads/${file.filename}` : null;
  const att_name   = file ? decodeOriginalName(file.originalname) : null;
  const att_size   = file ? file.size : null;
  const att_mime   = file ? file.mimetype : null;

  const id = Number(db.prepare(`
    INSERT INTO assignments
      (class_id, title, description, submit_deadline, review_deadline,
       status, attachment_path, attachment_name, attachment_size, attachment_mime)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `).run(
    Number(class_id), title, description || null,
    submit_deadline || null, review_deadline || null,
    att_path, att_name, att_size, att_mime
  ).lastInsertRowid);

  res.status(201).json({
    id, class_id: Number(class_id), title, status: 'open',
    submit_deadline: submit_deadline || null,
    review_deadline: review_deadline || null,
    attachment_name: att_name,
    attachment_size: att_size
  });
});

// GET /api/assignments?classId=X
router.get('/', (req, res) => {
  const classId = req.query.classId ? Number(req.query.classId) : null;
  let assignments;

  if (req.user.role === 'teacher') {
    if (classId) {
      assignments = db.prepare(`
        SELECT a.* FROM assignments a
        JOIN classes c ON c.id = a.class_id
        WHERE a.class_id = ? AND c.teacher_id = ?
        ORDER BY a.id DESC
      `).all(classId, req.user.id);
    } else {
      assignments = db.prepare(`
        SELECT a.* FROM assignments a
        JOIN classes c ON c.id = a.class_id
        WHERE c.teacher_id = ?
        ORDER BY a.id DESC
      `).all(req.user.id);
    }
  } else {
    // student: only assignments in classes they joined
    if (classId) {
      assignments = db.prepare(`
        SELECT a.* FROM assignments a
        JOIN class_members cm ON cm.class_id = a.class_id
        WHERE a.class_id = ? AND cm.user_id = ?
        ORDER BY a.id DESC
      `).all(classId, req.user.id);
    } else {
      assignments = db.prepare(`
        SELECT a.* FROM assignments a
        JOIN class_members cm ON cm.class_id = a.class_id
        WHERE cm.user_id = ?
        ORDER BY a.id DESC
      `).all(req.user.id);
    }
  }
  res.json({ assignments });
});

// POST /api/assignments/:id/distribute —— 教师触发分发
router.post('/:id/distribute', requireRole('teacher'), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare(`
    SELECT a.id FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = ? AND c.teacher_id = ?
  `).get(id, req.user.id);
  if (!a) return res.status(404).json({ error: '作业不存在或不属于你' });

  try {
    const result = distributeReviews(id);
    res.json({ success: true, ...result });
  } catch (err) {
    // 业务错误（人数过少、状态非法等）返回 400
    res.status(400).json({ error: err.message });
  }
});

// GET /api/assignments/:id/progress —— 教师查看评审进度
router.get('/:id/progress', requireRole('teacher'), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare(`
    SELECT a.* FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = ? AND c.teacher_id = ?
  `).get(id, req.user.id);
  if (!a) return res.status(404).json({ error: '作业不存在或不属于你' });

  const totalSubmissions = db.prepare(
    'SELECT COUNT(*) AS c FROM submissions WHERE assignment_id = ?'
  ).get(id).c;
  const totalTasks = db.prepare(
    'SELECT COUNT(*) AS c FROM review_tasks WHERE assignment_id = ?'
  ).get(id).c;
  const completedReviews = db.prepare(`
    SELECT COUNT(*) AS c FROM reviews r
    JOIN review_tasks rt ON rt.id = r.task_id
    WHERE rt.assignment_id = ?
  `).get(id).c;
  const avgRow = db.prepare(`
    SELECT AVG(r.score) AS avg_score FROM reviews r
    JOIN review_tasks rt ON rt.id = r.task_id
    WHERE rt.assignment_id = ?
  `).get(id);

  res.json({
    id,
    title: a.title,
    status: a.status,
    submit_deadline: a.submit_deadline,
    review_deadline: a.review_deadline,
    reviews_per_submission: a.reviews_per_person,
    total_submissions: totalSubmissions,
    total_tasks: totalTasks,
    completed_reviews: completedReviews,
    pending_reviews: totalTasks - completedReviews,
    avg_score: avgRow.avg_score
  });
});

// GET /api/assignments/:id —— 单个作业详情（含附件元数据）
//   权限：作业所在班级的教师 / 学生
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id 无效' });

  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: '作业不存在' });

  // 鉴权：教师必须是该班班主任；学生必须是该班成员
  const me = req.user;
  if (me.role === 'teacher') {
    const ok = db.prepare('SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?')
      .get(a.class_id, me.id);
    if (!ok) return res.status(403).json({ error: '没有访问该作业的权限' });
  } else {
    const ok = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?')
      .get(a.class_id, me.id);
    if (!ok) return res.status(403).json({ error: '没有访问该作业的权限' });
  }

  res.json({
    ...a,
    attachment_url: a.attachment_path ? `/api/assignments/${a.id}/attachment` : null
  });
});

// GET /api/assignments/:id/attachment —— 鉴权下载/预览
//   权限：作业所在班级的教师 / 学生
//   ?format=html  对 .docx 返回 mammoth 转出的 HTML（评审页同款预览）
router.get('/:id/attachment', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'id 无效' });

  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!a || !a.attachment_path) return res.status(404).json({ error: '作业不存在或未上传附件' });

  // 鉴权
  const me = req.user;
  if (me.role === 'teacher') {
    const ok = db.prepare('SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?')
      .get(a.class_id, me.id);
    if (!ok) return res.status(403).json({ error: '没有访问该附件的权限' });
  } else {
    const ok = db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?')
      .get(a.class_id, me.id);
    if (!ok) return res.status(403).json({ error: '没有访问该附件的权限' });
  }

  const abs = path.join(UPLOAD_DIR, path.basename(a.attachment_path));
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });

  // docx HTML 预览
  if (await tryDocxAsHtml(abs, a.attachment_name, res)) return;

  // 普通流式响应
  const m = a.attachment_mime || mime.lookup(a.attachment_name) || 'application/octet-stream';
  res.setHeader('Content-Type', m);
  const disp = isPreviewable(a.attachment_name) ? 'inline' : 'attachment';
  const enc  = rfc5987(a.attachment_name || 'file');
  res.setHeader('Content-Disposition',
    `${disp}; filename="${enc.replace(/%/g, '_')}"; filename*=UTF-8''${enc}`);
  res.setHeader('Content-Length', a.attachment_size || fs.statSync(abs).size);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
