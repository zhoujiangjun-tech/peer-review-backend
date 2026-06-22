/**
 * middleware/auth.js
 * JWT 认证中间件：解析 Authorization: Bearer <token>，校验后挂载 req.user
 */

const { verify } = require('../utils/jwt');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '缺少 Authorization Bearer 令牌' });
  }
  const token = header.slice(7).trim();
  try {
    const payload = verify(token);
    req.user = { id: payload.id, role: payload.role, username: payload.username };
    next();
  } catch (_) {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
}

module.exports = { authRequired };
