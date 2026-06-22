/**
 * utils/password.js
 * 密码哈希与校验（使用 Node.js 内置 scrypt，零依赖）
 *
 * 存储格式：`<saltHex>:<hashHex>`，使用 timingSafeEqual 防止计时攻击。
 */

const crypto = require('node:crypto');

const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = (stored || '').split(':');
  if (!salt || !hashHex) return false;

  const candidate = crypto.scryptSync(password, salt, KEY_LEN);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (candidate.length !== storedBuf.length) return false;

  return crypto.timingSafeEqual(candidate, storedBuf);
}

module.exports = { hashPassword, verifyPassword };
