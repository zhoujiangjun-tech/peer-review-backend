/**
 * assignmentService.js
 * 作业互评核心服务 —— 循环移位（Cyclic Shift）分发算法
 *
 * 约束（已验证）：
 *   - 每个学生作为 reviewer 恰好出现 3 次（每人评 3 份）
 *   - 每个 submission 恰好被 3 名学生评（每份被评 3 次）
 *   - 不会出现自评（offset ∈ {1,2,3}，N ≥ 4 时 (i+offset) % N ≠ i）
 *
 * 事务保证：
 *   - 使用 BEGIN IMMEDIATE ... COMMIT / ROLLBACK 显式事务
 *   - 函数体内任意 throw 都会触发 ROLLBACK，保证 3N 条 review_tasks 写入的原子性
 *
 * 驱动：Node.js 24 内置 node:sqlite（同步 API，零原生依赖）
 */

const db = require('./db');

/**
 * 执行一次分发
 * @param {number} assignmentId - 目标作业 ID
 * @returns {{ totalTasks: number, nSubmitters: number, status: string }}
 * @throws {Error} 作业不存在 / 状态非法 / 提交人数过少
 */
function distributeReviews(assignmentId) {
  // BEGIN IMMEDIATE 提前获取写锁，避免事务中后期出现 SQLITE_BUSY
  db.exec('BEGIN IMMEDIATE');

  try {
    // 1) 读取作业并校验状态
    const assignment = db.prepare(
      `SELECT id, class_id, status
         FROM assignments
        WHERE id = ?`
    ).get(assignmentId);

    if (!assignment) {
      throw new Error(`[distributeReviews] 作业不存在: id=${assignmentId}`);
    }
    if (assignment.status !== 'open') {
      throw new Error(
        `[distributeReviews] 作业状态非法，当前 status="${assignment.status}"，仅 open 可分发`
      );
    }

    // 2) 拉取该作业下所有提交者，按 class_members.student_no 稳定排序
    //    使用 JOIN 保证顺序与班级学号一致，避免分发结果受插入顺序影响
    const submitters = db.prepare(`
      SELECT s.id AS submission_id,
             s.student_id,
             cm.student_no
        FROM submissions s
        JOIN class_members cm
          ON cm.class_id = ? AND cm.user_id = s.student_id
       WHERE s.assignment_id = ?
       ORDER BY cm.student_no ASC
    `).all(assignment.class_id, assignmentId);

    const N = submitters.length;

    // 3) 临界值校验：N < 4 时循环移位无法在"无自评"前提下凑齐 3 评
    if (N < 4) {
      throw new Error(
        `[distributeReviews] 提交人数过少（${N} 人），至少需要 4 人才能保证每份被评 3 次且无自评`
      );
    }

    // 4) 幂等性：清理可能的历史分发（防止教师误重复点击）
    db.prepare(`DELETE FROM review_tasks WHERE assignment_id = ?`).run(assignmentId);

    // 5) 准备 INSERT 语句（prepared statement）
    const insertTask = db.prepare(`
      INSERT INTO review_tasks (assignment_id, reviewer_id, submission_id, anonymous_id)
      VALUES (?, ?, ?, ?)
    `);

    // 6) 循环移位核心：offset = 1, 2, 3
    //    学生 i 评 (i + offset) mod N 号学生的作业
    const OFFSETS = [1, 2, 3];
    let taskCount = 0;

    for (const offset of OFFSETS) {
      for (let i = 0; i < N; i++) {
        const reviewer = submitters[i];
        const target   = submitters[(i + offset) % N];

        insertTask.run(
          assignmentId,
          Number(reviewer.student_id),  // node:sqlite 返回 BigInt，统一转 Number
          Number(target.submission_id),
          generateAnonymousId()
        );
        taskCount++;
      }
    }

    // 7) 更新作业状态为 reviewing
    db.prepare(
      `UPDATE assignments SET status = 'reviewing' WHERE id = ?`
    ).run(assignmentId);

    // 8) 全部成功，提交事务
    db.exec('COMMIT');

    return {
      totalTasks:  taskCount,   // = 3 * N
      nSubmitters: N,
      status:      'reviewing'
    };
  } catch (err) {
    // 任何步骤失败：回滚事务，向上抛错
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略二次错误 */ }
    throw err;
  }
}

/**
 * 生成匿名 ID：S-XXXX（4 位，去除易混淆字符 0/O/1/I/L）
 * 评阅者界面仅展示该 ID，不暴露真实身份。
 */
function generateAnonymousId() {
  const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 个字符
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return `S-${suffix}`;
}

module.exports = { distributeReviews };

/* ------------------------------------------------------------------ */
/* 可选：直接运行本文件做一次自检                                       */
/*   node assignmentService.js <assignmentId>                          */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  const targetId = Number(process.argv[2]);
  if (!targetId) {
    console.error('用法: node assignmentService.js <assignmentId>');
    process.exit(1);
  }
  try {
    const result = distributeReviews(targetId);
    console.log('[OK] 分发完成:', result);
  } catch (err) {
    console.error('[FAIL]', err.message);
    process.exit(1);
  }
}
