/**
 * server.js
 * Express 应用入口：挂载中间件、路由、错误处理、监听端口
 *
 *   node server.js         启动服务
 *   http://localhost:3000/health   健康检查
 */

const express = require('express');
const config = require('./config');
const db = require('./db'); // 启动时自动建表

const app = express();

// JSON body 解析（保留，但提交接口用 multipart 覆盖）
app.use(express.json({ limit: '1mb' }));

// 静态资源：上传的作业文件统一走 /api/submissions/file/:id 鉴权接口，不再开放匿名目录
// （避免别人猜到 /uploads/xxx 就能直接下载）

// 简易请求日志（开发期可见）
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 健康检查
app.get('/health', (_req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: { users: userCount }
  });
});

// 挂载路由
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/classes',     require('./routes/classes'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/reviews',     require('./routes/reviews'));

// 404 处理
app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'production' ? undefined : err.message
  });
});

app.listen(config.PORT, () => {
  console.log('━'.repeat(60));
  console.log(` 作业互评匿名分发系统后端服务已启动`);
  console.log(` 监听端口: ${config.PORT}`);
  console.log(` 健康检查: http://localhost:${config.PORT}/health`);
  console.log('━'.repeat(60));
});
