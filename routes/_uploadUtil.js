/**
 * routes/_uploadUtil.js
 * 共享的上传 / 文件工具，被 submissions.js 与 assignments.js 复用
 */
const path = require('node:path');
const fs   = require('node:fs');
const multer = require('multer');

// 共享上传目录
const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 允许的扩展名（白名单）
const ALLOWED_EXTS = new Set([
  // 文档
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md', 'rtf',
  // 压缩包
  'zip', '7z', 'rar', 'tar', 'gz',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  // 代码
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'go', 'rs', 'rb', 'php', 'sh', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'sql'
]);

// 把 latin1 的 originalname 还原成 utf8（HTTP header 默认编码）
function decodeOriginalName(name) {
  return Buffer.from(name || '', 'latin1').toString('utf8');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const originalUtf8 = decodeOriginalName(file.originalname);
    const ext = path.extname(originalUtf8).toLowerCase() || '';
    const base = path.basename(originalUtf8, ext)
      .replace(/[^\w一-龥\-_. ]/g, '_')
      .slice(0, 60) || 'file';
    cb(null, `${Date.now()}_${req.user.id}_${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const originalUtf8 = decodeOriginalName(file.originalname);
    const ext = (path.extname(originalUtf8) || '').toLowerCase().replace('.', '');
    if (ALLOWED_EXTS.has(ext)) return cb(null, true);
    cb(new Error(`不支持的文件类型：.${ext}`));
  }
});

// 可内联预览的扩展名
//   - 浏览器原生：图片、PDF、文本/代码
//   - 后端转码  ：Office 文档（docx → HTML，见 submissions 路由）
function isPreviewable(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|pdf|txt|md|json|xml|ya?ml|csv|html|css|js|ts|jsx|tsx|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|sql|log|docx)$/.test(lower);
}

// RFC 5987 文件名编码（中文不乱码）
function rfc5987(name) {
  return encodeURIComponent(name || 'file').replace(/['()]/g, escape).replace(/\*/g, '%2A');
}

module.exports = {
  UPLOAD_DIR,
  ALLOWED_EXTS,
  upload,
  isPreviewable,
  rfc5987,
  decodeOriginalName
};
