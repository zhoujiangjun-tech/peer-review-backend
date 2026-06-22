/**
 * smokeTest.js
 * API 端到端冒烟测试：覆盖所有关键路由
 *   - 注册 / 登录
 *   - 创建班级 / 学生加入
 *   - 发布作业 / 学生提交
 *   - 触发分发 / 获取待评 / 提交评审
 *   - 教师查看进度
 *
 * 依赖：服务必须先启动 (node server.js)
 */

const BASE = 'http://localhost:3000';

let pass = 0, fail = 0;

function ok(name, cond, detail = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  if (cond) pass++; else fail++;
  console.log(`  ${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function http(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

function ts() { return Date.now().toString().slice(-6); }

(async () => {
  console.log('━'.repeat(60));
  console.log('▶ API 冒烟测试');

  // 1. 注册教师
  const teacherName = 'tch_' + ts();
  let r = await http('POST', '/api/auth/register', {
    username: teacherName, password: 'pwd123', real_name: '测试老师', role: 'teacher'
  });
  ok('教师注册', r.status === 201 && r.data?.token, `status=${r.status}`);
  const teacherToken = r.data?.token;

  // 2. 注册 4 个学生
  const studentTokens = [];
  const studentIds = [];
  for (let i = 1; i <= 4; i++) {
    const sname = 'stu_' + ts() + '_' + i;
    r = await http('POST', '/api/auth/register', {
      username: sname, password: 'pwd123', real_name: '学生' + i, role: 'student'
    });
    ok(`学生${i}注册`, r.status === 201);
    studentTokens.push(r.data.token);
    studentIds.push(r.data.user.id);
  }

  // 3. 登录测试
  r = await http('POST', '/api/auth/login', { username: teacherName, password: 'pwd123' });
  ok('教师登录', r.status === 200 && r.data?.token);

  // 4. 错误登录应 401
  r = await http('POST', '/api/auth/login', { username: teacherName, password: 'wrong' });
  ok('错误密码被拒', r.status === 401);

  // 5. 创建班级
  r = await http('POST', '/api/classes', { class_name: '冒烟测试班' }, teacherToken);
  ok('教师创建班级', r.status === 201 && r.data?.invite_code);
  const inviteCode = r.data.invite_code;
  const classId = r.data.id;

  // 6. 学生不能创建班级
  r = await http('POST', '/api/classes', { class_name: 'x' }, studentTokens[0]);
  ok('学生创建班级被拒', r.status === 403);

  // 7. 学生加入班级
  for (let i = 0; i < 4; i++) {
    r = await http('POST', '/api/classes/join', {
      invite_code: inviteCode,
      student_no: `S00${i + 1}`
    }, studentTokens[i]);
    ok(`学生${i + 1}加入班级`, r.status === 200);
  }

  // 8. 重复加入应 409
  r = await http('POST', '/api/classes/join', { invite_code: inviteCode, student_no: 'S001' }, studentTokens[0]);
  ok('重复加入被拒', r.status === 409);

  // 9. 教师查看班级成员
  r = await http('GET', `/api/classes/${classId}/members`, null, teacherToken);
  ok('查看班级成员', r.status === 200 && r.data?.members?.length === 4,
     `人数=${r.data?.members?.length}`);

  // 10. 发布作业
  r = await http('POST', '/api/assignments', {
    class_id: classId, title: '冒烟测试作业', description: 'test'
  }, teacherToken);
  ok('教师发布作业', r.status === 201);
  const assignmentId = r.data.id;

  // 11. 学生提交
  for (let i = 0; i < 4; i++) {
    r = await http('POST', '/api/submissions', {
      assignment_id: assignmentId,
      file_name: `homework_${i + 1}.pdf`,
      content: `学生${i + 1} 的作业内容`
    }, studentTokens[i]);
    ok(`学生${i + 1}提交`, r.status === 201);
  }
  // 重复提交应 409
  r = await http('POST', '/api/submissions', {
    assignment_id: assignmentId, content: '重交'
  }, studentTokens[0]);
  ok('重复提交被拒', r.status === 409);

  // 12. 触发分发
  r = await http('POST', `/api/assignments/${assignmentId}/distribute`, {}, teacherToken);
  ok('触发分发', r.status === 200 && r.data?.totalTasks === 12,
     `totalTasks=${r.data?.totalTasks}`);

  // 13. 学生获取待评
  r = await http('GET', `/api/reviews/tasks/my?assignmentId=${assignmentId}`, null, studentTokens[0]);
  ok('学生1获取待评列表', r.status === 200 && r.data?.tasks?.length === 3,
     `task数=${r.data?.tasks?.length}`);
  const myFirstTask = r.data.tasks[0];

  // 14. 匿名 ID 校验：响应里不应该有 student_id
  const hasStudentId = r.data.tasks.some(t => t.student_id !== undefined);
  ok('待评列表不含 student_id（匿名）', !hasStudentId);

  // 15. 学生不能看别人的 task
  r = await http('GET', `/api/reviews/tasks/${myFirstTask.task_id}/submission`, null, studentTokens[1]);
  ok('他人任务不可见', r.status === 404);

  // 16. 学生看自己的 task 内容
  r = await http('GET', `/api/reviews/tasks/${myFirstTask.task_id}/submission`, null, studentTokens[0]);
  ok('查看待评作业', r.status === 200 && r.data?.anonymous_id);
  const anonymousId = r.data.anonymous_id;
  console.log(`     匿名 ID: ${anonymousId}`);

  // 17. 提交评审
  r = await http('POST', '/api/reviews', {
    task_id: myFirstTask.task_id, score: 88, comment: '不错'
  }, studentTokens[0]);
  ok('提交评审', r.status === 201);

  // 18. 重复提交评审应 409
  r = await http('POST', '/api/reviews', {
    task_id: myFirstTask.task_id, score: 70
  }, studentTokens[0]);
  ok('重复评审被拒', r.status === 409);

  // 19. 教师查看进度
  r = await http('GET', `/api/assignments/${assignmentId}/progress`, null, teacherToken);
  ok('查看进度', r.status === 200);
  console.log(`     进度详情: total_tasks=${r.data.total_tasks}, ` +
              `completed=${r.data.completed_reviews}, ` +
              `rate=${r.data.completion_rate}`);

  // 20. 未认证访问应 401
  r = await http('GET', '/api/auth/me');
  ok('未认证被拒', r.status === 401);

  // 21. 学生不能触发分发
  r = await http('POST', `/api/assignments/${assignmentId}/distribute`, {}, studentTokens[0]);
  ok('学生触发分发被拒', r.status === 403);

  // 总结
  console.log('━'.repeat(60));
  console.log(`▶ 测试总结: ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED');
  console.log('━'.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
