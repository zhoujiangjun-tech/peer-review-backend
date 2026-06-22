/**
 * config.js
 * 应用配置：端口、JWT 密钥等
 *
 * 生产环境请通过环境变量注入 JWT_SECRET，不要使用默认值。
 */

module.exports = {
  PORT:           Number(process.env.PORT) || 3000,
  JWT_SECRET:     process.env.JWT_SECRET || 'dev-secret-please-change-in-prod',
  JWT_EXPIRES_IN: '7d'
};
