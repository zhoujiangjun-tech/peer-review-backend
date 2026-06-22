/**
 * middleware/role.js
 * 角色守卫：必须已认证且角色匹配
 *
 *   router.post('/...', requireRole('teacher'), handler)
 */

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未认证' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `需要角色: ${roles.join(' 或 ')}` });
    }
    next();
  };
}

module.exports = { requireRole };
