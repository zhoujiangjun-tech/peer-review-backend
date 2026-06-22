/**
 * test.js
 * 端到端测试：循环移位（Cyclic Shift）分发算法
 *
 * 用法：node test.js
 *
 * 流程：
 *   1. 删除旧 data.db（连同 WAL/SHM 文件）
 *   2. 引入 db.js —— 自动建表
 *   3. 准备测试数据：1 教师 + 4 学生(S001-S004) + 1 班级 + 1 作业 + 4 提交
 *   4. 调用 distributeReviews(assignmentId)
 *   5. 自动验证：数量 / 无自评 / 每人评 3 / 每份被评 3 / 匿名 ID 唯一 / 状态变更
 *   6. 打印分发矩阵 + 总结
 *
 * 退出码：0 全部通过，1 存在失败
 */

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.db');

// ============================================================
// 步骤 1：清理旧数据库
// ============================================================
console.log('━'.repeat(64));
console.log('▶ 步骤 1：清理旧数据库');
['data.db', 'data.db-wal', 'data.db-shm'].forEach(name => {
  const f = path.join(__dirname, name);
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`  ✓ 已删除 ${name}`);
  }
});

// ============================================================
// 步骤 2：建立数据库连接（自动建表）
// ============================================================
const db = require('./db');
console.log('  ✓ 数据库连接已建立，表结构已初始化');

// ============================================================
// 步骤 3：准备测试数据
// ============================================================
console.log('━'.repeat(64));
console.log('▶ 步骤 2：准备测试数据');

// 3.1 插入 1 位老师
const teacherId = Number(db.prepare(`
  INSERT INTO users (username, password_hash, real_name, role)
  VALUES (?, ?, ?, ?)
`).run('teacher01', 'hashed_pwd', '张老师', 'teacher').lastInsertRowid);
console.log(`  ✓ 插入老师: id=${teacherId}`);

// 3.2 插入 4 名学生
const studentIds = [];
const insertStudent = db.prepare(`
  INSERT INTO users (username, password_hash, real_name, role)
  VALUES (?, ?, ?, ?)
`);
for (let i = 1; i <= 4; i++) {
  const sid = Number(insertStudent.run(
    `student0${i}`, 'hashed_pwd', `学生${i}`, 'student'
  ).lastInsertRowid);
  studentIds.push(sid);
}
console.log(`  ✓ 插入 4 名学生: ids=[${studentIds.join(', ')}]`);

// 3.3 创建班级
const classId = Number(db.prepare(`
  INSERT INTO classes (class_name, invite_code, teacher_id)
  VALUES (?, ?, ?)
`).run('计算机科学 2024-1 班', 'INV-2024-001', teacherId).lastInsertRowid);
console.log(`  ✓ 创建班级: id=${classId}`);

// 3.4 学生加入班级，学号 S001-S004
const insertMember = db.prepare(`
  INSERT INTO class_members (class_id, user_id, student_no)
  VALUES (?, ?, ?)
`);
const studentNoByUserId = {};
for (let i = 0; i < 4; i++) {
  const no = `S00${i + 1}`;
  insertMember.run(classId, studentIds[i], no);
  studentNoByUserId[studentIds[i]] = no;
}
console.log(`  ✓ 4 名学生加入班级，学号 ${Object.values(studentNoByUserId).join(', ')}`);

// 3.5 创建作业（status=open）
const assignmentId = Number(db.prepare(`
  INSERT INTO assignments (class_id, title, description, status)
  VALUES (?, ?, ?, ?)
`).run(classId, '第一次作业：算法设计', '请提交算法设计报告', 'open').lastInsertRowid);
console.log(`  ✓ 创建作业: id=${assignmentId}, status=open`);

// 3.6 每位学生提交一份作业
const submissionIds = [];
const insertSubmission = db.prepare(`
  INSERT INTO submissions (assignment_id, student_id, file_name, content)
  VALUES (?, ?, ?, ?)
`);
for (let i = 0; i < 4; i++) {
  const subId = Number(insertSubmission.run(
    assignmentId,
    studentIds[i],
    `homework_${i + 1}.pdf`,
    `学生 ${i + 1} 的作业内容`
  ).lastInsertRowid);
  submissionIds.push(subId);
}
console.log(`  ✓ 4 份提交已记录: ids=[${submissionIds.join(', ')}]`);

// ============================================================
// 步骤 4：执行分发
// ============================================================
console.log('━'.repeat(64));
console.log('▶ 步骤 3：执行循环移位分发');
const { distributeReviews } = require('./assignmentService');

let distributeResult;
try {
  distributeResult = distributeReviews(assignmentId);
  console.log(`  ✓ 分发完成: totalTasks=${distributeResult.totalTasks}, ` +
              `nSubmitters=${distributeResult.nSubmitters}, status=${distributeResult.status}`);
} catch (err) {
  console.log('━'.repeat(64));
  console.log(`[FAIL] 分发过程抛出异常: ${err.message}`);
  process.exit(1);
}

// ============================================================
// 步骤 5：自动验证
// ============================================================
console.log('━'.repeat(64));
console.log('▶ 步骤 4：自动验证分发结果');

let passCount = 0;
let failCount = 0;

function check(name, ok, detail = '') {
  const tag = ok ? '[PASS]' : '[FAIL]';
  if (ok) passCount++; else failCount++;
  console.log(`  ${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

// 5.1 数量验证：应生成 4 * 3 = 12 条
const totalTasks = db.prepare(
  `SELECT COUNT(*) AS c FROM review_tasks WHERE assignment_id = ?`
).get(assignmentId).c;
check('共生成 12 个评审任务', totalTasks === 12, `实际 ${totalTasks} 条`);

// 5.2 自评检查：reviewer_id 绝不能等于 submission 的 student_id
const selfReviewCount = db.prepare(`
  SELECT COUNT(*) AS c
    FROM review_tasks rt
    JOIN submissions s ON s.id = rt.submission_id
   WHERE rt.assignment_id = ? AND rt.reviewer_id = s.student_id
`).get(assignmentId).c;
check('无自评记录', selfReviewCount === 0, `发现 ${selfReviewCount} 条自评`);

// 5.3 每名学生作为 reviewer 恰好 3 次
const reviewerStats = db.prepare(`
  SELECT reviewer_id, COUNT(*) AS c
    FROM review_tasks
   WHERE assignment_id = ?
   GROUP BY reviewer_id
   ORDER BY reviewer_id
`).all(assignmentId);
const reviewerDetail = reviewerStats
  .map(r => `${studentNoByUserId[r.reviewer_id] || r.reviewer_id}=${r.c}`).join(', ');
const allReviewerOk = reviewerStats.length === 4 &&
                      reviewerStats.every(r => r.c === 3);
check('每名学生恰好评 3 份', allReviewerOk, reviewerDetail);

// 5.4 每份 submission 恰好被 3 人评
const submissionStats = db.prepare(`
  SELECT submission_id, COUNT(*) AS c
    FROM review_tasks
   WHERE assignment_id = ?
   GROUP BY submission_id
   ORDER BY submission_id
`).all(assignmentId);

// 把 submission_id 映射回学号，便于阅读
const studentNoBySubId = {};
db.prepare(`
  SELECT s.id AS submission_id, cm.student_no
    FROM submissions s
    JOIN class_members cm ON cm.user_id = s.student_id AND cm.class_id = ?
   WHERE s.assignment_id = ?
`).all(classId, assignmentId).forEach(r => {
  studentNoBySubId[r.submission_id] = r.student_no;
});
const submissionDetail = submissionStats
  .map(r => `${studentNoBySubId[r.submission_id] || r.submission_id}=${r.c}`).join(', ');
const allSubmissionOk = submissionStats.length === 4 &&
                        submissionStats.every(r => r.c === 3);
check('每份提交恰好被 3 人评', allSubmissionOk, submissionDetail);

// 5.5 匿名 ID 唯一性
const dupAnon = db.prepare(`
  SELECT anonymous_id, COUNT(*) AS c
    FROM review_tasks
   WHERE assignment_id = ?
   GROUP BY anonymous_id
   HAVING c > 1
`).all(assignmentId);
check('所有 anonymous_id 唯一', dupAnon.length === 0,
      dupAnon.length ? `重复 ${dupAnon.length} 个` : '');

// 5.6 作业状态从 open → reviewing
const newStatus = db.prepare(
  `SELECT status FROM assignments WHERE id = ?`
).get(assignmentId).status;
check('作业状态变更为 reviewing', newStatus === 'reviewing', `当前=${newStatus}`);

// ============================================================
// 步骤 6：可视化分发矩阵
// ============================================================
console.log('━'.repeat(64));
console.log('▶ 步骤 5：分发矩阵（行=评阅人，列=被评者）');

const N = studentIds.length;
const grid = Array.from({ length: N }, () => Array(N).fill('·'));

const matrix = db.prepare(`
  SELECT rt.reviewer_id, s.student_id AS target_student
    FROM review_tasks rt
    JOIN submissions s ON s.id = rt.submission_id
   WHERE rt.assignment_id = ?
`).all(assignmentId);

matrix.forEach(({ reviewer_id, target_student }) => {
  const ri = studentIds.indexOf(reviewer_id);
  const ti = studentIds.indexOf(target_student);
  if (ri >= 0 && ti >= 0) grid[ri][ti] = 'O';
});

const labels = studentIds.map(id => studentNoByUserId[id]);
const W = 6;
const header = '         ' + labels.map(l => l.padStart(W)).join('');
console.log(header);
console.log('         ' + labels.map(() => '-'.repeat(W)).join(''));
labels.forEach((label, i) => {
  const row = grid[i].map(c => c.padStart(W)).join('');
  console.log(`  ${label.padEnd(5)} |${row}`);
});
console.log('  (O = 被分配评审该作业)');

// ============================================================
// 总结
// ============================================================
console.log('━'.repeat(64));
const allPass = failCount === 0;
console.log(`▶ 测试总结：${passCount} 通过 / ${failCount} 失败`);
console.log(allPass ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED');
console.log('━'.repeat(64));
process.exit(allPass ? 0 : 1);
