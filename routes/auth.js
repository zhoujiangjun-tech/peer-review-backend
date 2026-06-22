/**
 * routes/auth.js
 * 用户注册 / 登录 / 获取当前用户
 *
 *   POST /api/auth/register
 *   POST /api/auth/login
 *   GET  /api/auth/me
 */

const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../utils/password');
const { sign } = require('../utils/jwt');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { username, password, real_name, role } = req.body || {};

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, role 必填' });
  }
  if (!['teacher', 'student'].includes(role)) {
    return res.status(400).json({ error: 'role 必须是 teacher 或 student' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已被占用' });

  const id = Number(db.prepare(
    `INSERT INTO users (username, password_hash, real_name, role)
     VALUES (?, ?, ?, ?)`
  ).run(username, hashPassword(password), real_name || null, role).lastInsertRowid);

  const token = sign({ id, username, role });
  res.status(201).json({
    token,
    user: { id, username, real_name: real_name || null, role }
  });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username 和 password 必填' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = sign({ id: user.id, username: user.username, role: user.role });
  res.json({
    token,
    user: { id: user.id, username: user.username, real_name: user.real_name, role: user.role }
  });
});

// GET /api/auth/me
router.get('/me', authRequired, (req, res) => {
  const u = db.prepare(
    'SELECT id, username, real_name, role, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: u });
});

module.exports = router;
