/**
 * routes/submissions.js
 * 学生提交 + 查看我的提交 + 教师查看本作业全部提交
 *
 *   POST /api/submissions                学生提交（支持文件 multipart/form-data）
 *   GET  /api/submissions/mine           学生：我的所有提交
 *   GET  /api/submissions/mine?assignmentId=X
 *   GET  /api/submissions?assignmentId=X 教师：查看作业的所有提交
 *   GET  /api/submissions/file/:id      鉴权下载/预览
 *   PUT  /api/submissions/:id           学生修改自己的提交
 *
 * 支持的文件类型：文档（doc/docx/pdf/ppt/pptx/xls/xlsx/txt/md/zip/7z/rar）
 *               + 图片（png/jpg/jpeg/gif/webp/bmp）+ 代码文件（按需放开）
 * 单文件大小上限：20MB
 */

const express = require('express');

const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requireRole } = require('../middleware/role');
const { UPLOAD_DIR, upload, isPreviewable, rfc5987, decodeOriginalName } = require('./_uploadUtil');

const router = express.Router();
router.use(authRequired);

// POST /api/submissions —— 学生提交
//   Content-Type: multipart/form-data
//   字段：assignment_id, file (可选), content (可选)
router.post('/', requireRole('student'), upload.single('file'), (req, res) => {
  // 兼容两种来源：multipart (req.body) / json
  const assignment_id = Number(req.body.assignment_id);
  const content = req.body.content || null;
  const uploadedFile = req.file; // multer 文件对象

  if (!assignment_id) return res.status(400).json({ error: 'assignment_id 必填' });
  if (!uploadedFile && !content) {
    return res.status(400).json({ error: '请至少上传一个文件或填写文字内容' });
  }

  // 校验：作业存在 + 当前学生在本班 + 状态为 open
  const a = db.prepare(`
    SELECT a.id, a.status FROM assignments a
    JOIN class_members cm ON cm.class_id = a.class_id
    WHERE a.id = ? AND cm.user_id = ?
  `).get(assignment_id, req.user.id);
  if (!a) return res.status(404).json({ error: '作业不存在或你不在该班级' });
  if (a.status !== 'open') {
    // 清理已上传的文件
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    return res.status(400).json({ error: `当前作业状态为 ${a.status}，不允许提交` });
  }

  const file_name  = uploadedFile ? decodeOriginalName(uploadedFile.originalname) : null;
  const file_path  = uploadedFile ? `/uploads/${uploadedFile.filename}` : null;
  const file_size  = uploadedFile ? uploadedFile.size : null;
  const mime_type  = uploadedFile ? uploadedFile.mimetype : null;

  try {
    const id = Number(db.prepare(`
      INSERT INTO submissions
        (assignment_id, student_id, file_name, content, file_path, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignment_id, req.user.id,
      file_name, content, file_path, file_size, mime_type
    ).lastInsertRowid);

    res.status(201).json({
      id,
      assignment_id,
      student_id: req.user.id,
      file_name,
      file_path,
      download_url: `/api/submissions/file/${id}`,
      file_size,
      content
    });
  } catch (err) {
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '你已经提交过该作业' });
    }
    throw err;
  }
});

// multer 错误处理
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件太大，单文件上限 20MB' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message || '上传失败' });
  next();
});

// GET /api/submissions?assignmentId=X —— 教师：查看本作业所有提交
router.get('/', requireRole('teacher'), (req, res) => {
  const aid = req.query.assignmentId ? Number(req.query.assignmentId) : null;
  if (!aid) return res.status(400).json({ error: 'assignmentId 必填' });

  const a = db.prepare(`
    SELECT a.id FROM assignments a
    JOIN classes c ON c.id = a.class_id
    WHERE a.id = ? AND c.teacher_id = ?
  `).get(aid, req.user.id);
  if (!a) return res.status(404).json({ error: '作业不存在或不属于你' });

  const submissions = db.prepare(`
    SELECT s.id,
           s.assignment_id,
           s.student_id,
           s.file_name,
           s.content,
           s.file_path,
           s.file_size,
           s.mime_type,
           s.submitted_at,
           u.username,
           u.real_name,
           cm.student_no
      FROM submissions s
      JOIN assignments  a  ON a.id  = s.assignment_id
      JOIN users u          ON u.id  = s.student_id
      JOIN class_members cm ON cm.user_id = s.student_id AND cm.class_id = a.class_id
     WHERE s.assignment_id = ?
     ORDER BY s.id DESC
  `).all(aid);

  res.json({ submissions });
});

// GET /api/submissions/mine —— 学生：我的提交
router.get('/mine', requireRole('student'), (req, res) => {
  const aid = req.query.assignmentId ? Number(req.query.assignmentId) : null;
  const submissions = aid
    ? db.prepare(
        'SELECT * FROM submissions WHERE student_id = ? AND assignment_id = ? ORDER BY id DESC'
      ).all(req.user.id, aid)
    : db.prepare(
        'SELECT * FROM submissions WHERE student_id = ? ORDER BY id DESC'
      ).all(req.user.id);
  res.json({ submissions });
});

// PUT /api/submissions/:id —— 学生修改自己的提交
//   规则：作业状态必须是 open，且未过 submit_deadline
//   字段：file (可选, 替换旧文件) / content (可选)
router.put('/:id', requireRole('student'), upload.single('file'), (req, res) => {
  const subId = Number(req.params.id);
  if (!subId) return res.status(400).json({ error: '提交 id 无效' });

  // 取提交 + 关联作业
  const sub = db.prepare(`
    SELECT s.*, a.status AS a_status, a.submit_deadline AS a_deadline
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id
     WHERE s.id = ?
  `).get(subId);
  if (!sub) return res.status(404).json({ error: '提交不存在' });
  if (sub.student_id !== req.user.id) return res.status(403).json({ error: '只能修改自己的提交' });
  if (sub.a_status !== 'open') {
    return res.status(400).json({ error: `当前作业处于【${sub.a_status}】阶段，不可修改` });
  }
  if (sub.a_deadline && new Date(sub.a_deadline).getTime() < Date.now()) {
    return res.status(400).json({ error: '已过提交截止时间，无法修改' });
  }

  const uploadedFile = req.file;
  const newContent = (req.body.content !== undefined ? req.body.content : sub.content) || null;

  if (!uploadedFile && (newContent == null || newContent === '')) {
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    return res.status(400).json({ error: '请至少保留文件或文字内容' });
  }

  // 准备新值（不传文件则保留旧文件）
  const file_name = uploadedFile
    ? Buffer.from(uploadedFile.originalname, 'latin1').toString('utf8') : sub.file_name;
  const file_path = uploadedFile ? `/uploads/${uploadedFile.filename}` : sub.file_path;
  const file_size = uploadedFile ? uploadedFile.size : sub.file_size;
  const mime_type = uploadedFile ? uploadedFile.mimetype : sub.mime_type;
  const oldFilePath = sub.file_path; // 用于后面删旧文件

  try {
    db.prepare(`
      UPDATE submissions
         SET file_name = ?, file_path = ?, file_size = ?, mime_type = ?, content = ?,
             submitted_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(file_name, file_path, file_size, mime_type, newContent, subId);

    // 删旧文件（异步，不阻塞响应）
    if (uploadedFile && oldFilePath && oldFilePath !== file_path) {
      const absOld = path.join(UPLOAD_DIR, path.basename(oldFilePath));
      fs.unlink(absOld, () => {});
    }

    res.json({
      id: subId,
      assignment_id: sub.assignment_id,
      file_name, file_path, file_size, mime_type,
      content: newContent,
    });
  } catch (err) {
    if (uploadedFile) fs.unlink(uploadedFile.path, () => {});
    throw err;
  }
});
// GET /api/submissions/file/:id —— 鉴权下载/预览
//   权限：提交者本人 / 同一班级教师 / 在评审任务中已分配到此提交的学生
//   可预览类型返回 Content-Disposition: inline；其他类型返回 attachment 触发下载
router.get('/file/:id', authRequired, async (req, res) => {
  const subId = Number(req.params.id);
  if (!subId) return res.status(400).json({ error: 'id 无效' });

  const sub = db.prepare(`
    SELECT s.*, a.class_id AS a_class_id
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id
     WHERE s.id = ?
  `).get(subId);
  if (!sub || !sub.file_path) return res.status(404).json({ error: '文件不存在' });

  // 鉴权
  const me = req.user;
  const isOwner  = me.role === 'student' && me.id === sub.student_id;
  const isTeacher = me.role === 'teacher' && db.prepare(
    'SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?'
  ).get(sub.a_class_id, me.id);
  const isAssignedReviewer = me.role === 'student' && db.prepare(
    `SELECT 1 FROM review_tasks rt
       JOIN submissions s2 ON s2.assignment_id = rt.assignment_id AND s2.id = ?
      WHERE rt.reviewer_id = ?`
  ).get(subId, me.id);

  if (!isOwner && !isTeacher && !isAssignedReviewer) {
    return res.status(403).json({ error: '没有访问该文件的权限' });
  }

  const abs = path.join(UPLOAD_DIR, path.basename(sub.file_path));
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });

  // ============== Office 文档实时转 HTML 预览 ==============
  //   ?format=html    返回 text/html 片段（用于内嵌 iframe srcdoc 预览）
  //   不带 format     按原文件流式返回（下载 / 图片 / pdf 预览）
  if (req.query.format === 'html' && /\.docx$/i.test(sub.file_name || '')) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.convertToHtml({ path: abs });
      // 套一层基础样式，让 iframe 里看着不辣眼
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
      return res.send(html);
    } catch (e) {
      return res.status(500).json({ error: 'docx 解析失败：' + e.message });
    }
  }

  // 设置 MIME（优先用上传时记录的 mime，否则按扩展名猜）
  const mime = sub.mime_type || (sub.file_name && require('mime-types').lookup(sub.file_name)) || 'application/octet-stream';
  res.setHeader('Content-Type', mime);

  // Content-Disposition：预览型用 inline，文档类用 attachment 强制下载
  const disp = isPreviewable(sub.file_name) ? 'inline' : 'attachment';
  const encoded = rfc5987(sub.file_name || 'file');
  res.setHeader(
    'Content-Disposition',
    `${disp}; filename="${encoded.replace(/%/g, '_')}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader('Content-Length', sub.file_size || fs.statSync(abs).size);
  res.setHeader('Cache-Control', 'private, max-age=3600');

  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
