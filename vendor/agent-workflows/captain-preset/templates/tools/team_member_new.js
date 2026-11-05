#!/usr/bin/env node
// team/team_member_new.js —— 新成员对齐工具（M3 决议 §十四 五步流程的工具化）
//
// 用法：
//   node team/team_member_new.js <别名> [--role <角色>] [--team <团队>]
//        [--session <id>] [--cwd <路径>] [--captain <队长别名>] [--notify]
//
// 做四件事（幂等）：
//   1) 复用 pipe2_tool.js peers check 查重（禁泛称/格式/重名）
//   2) 建 team/members/<别名>/AGENTS.md + scratch/（已存在则跳过，不覆盖）
//   3) pipe2_tool.js peers register（写 PEERS.json + PEERS.md）
//   4) --notify 时给队长投一条入列通知
//
// 环境变量：
//   TEAM_ROOT   项目根（默认脚本所在目录的上一级）
//   PIPE2_ROOT  覆盖 pipe2 根（默认 TEAM_ROOT/team/pipe2；测试用）
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TEAM_ROOT = process.env.TEAM_ROOT ? path.resolve(process.env.TEAM_ROOT) : path.join(__dirname, '..');
const TEAM_DIR = path.join(TEAM_ROOT, 'team');
const MEMBERS = path.join(TEAM_DIR, 'members');
const TOOL = path.join(TEAM_DIR, 'pipe2_tool.js');

function parseArgs(argv) {
  const alias = argv[0];
  const options = {
    role: 'member',
    team: 'default',
    session: undefined,
    cwd: TEAM_ROOT,
    captain: undefined,
    notify: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--role') { options.role = value; i++; }
    else if (key === '--team') { options.team = value; i++; }
    else if (key === '--session') { options.session = value; i++; }
    else if (key === '--cwd') { options.cwd = value; i++; }
    else if (key === '--root') { options.root = value; i++; }
    else if (key === '--captain') { options.captain = value; i++; }
    else if (key === '--notify') options.notify = true;
  }
  return { alias, options };
}

function validate(alias) {
  if (typeof alias !== 'string' || alias.length === 0) return '别名必填';
  if (alias.length > 16) return '超过 16 字符（当前 ' + alias.length + '）';
  if (!/^[a-z][a-z0-9-]*$/.test(alias)) return '只允许小写字母/数字/连字符，且必须以字母开头';
  if (alias.startsWith('__')) return '双下划线开头保留给系统';
  return undefined;
}

// 禁泛称：必须无条件检查（不能因为"已登记"就跳过——legacy 别名也在此列）
const RESERVED_NAMES = new Set(['captain', 'lead', 'leader', 'boss', 'admin', 'chief', 'host', 'owner',
  'agent', 'assistant', 'bot', 'team', 'system', 'all', 'everyone', 'main', 'root', '队长', '组长', '管理员', '系统']);

function isReserved(alias) {
  return RESERVED_NAMES.has(alias);
}

function agentsTemplate(alias, role, team, captain) {
  const cap = captain ?? '（待指定）';
  return `# ${alias} 行为规范（AGENTS）

> 团队：${team} ／ 角色：${role} ／ 队长：${cap}
> 本文件由 \`team/team_member_new.js\` 生成（幂等，不覆盖已有文件）；按需修改。

## 一、你是谁

你是【${team}】团队的 **${alias}**，角色是 **${role}**。
别名与队长优先以 team-bus 的 session-network 工具为准（\`network_info\` / \`alias_register\`）；若本工作区仅有旧模板，\`team/pipe2/PEERS.json\` 是 **legacy** 注册表，不要手改，仅按旧模板流程维护。

## 二、写范围

- **可写**：\`team/members/${alias}/\`（本目录）；任务明确授权的代码/文档路径。
- **只读**：\`team/TEAM.md\`、\`team/meetings/\`、其他成员的 \`team/members/*/\`。
- **禁止**：改写他人目录与历史日志；未授权路径；未经报备新建/删除目录。

## 三、六项回报义务（停止时必写）

1. 做了什么（一句话）
2. 改了哪些文件（带路径）
3. 验证结果（命令 + 输出摘要）
4. 遗留风险（没有就写"无"）
5. 未完成项（明确列出）
6. 建议下一步

## 四、上下文纪律

- 每轮开工测一次占用（\`context_usage\` / \`team_hooks_status\`）。
- 占用 ≥50% ⇒ 在本目录写 \`CONTEXT_SNAPSHOT_<YYYYMMDD_HHMMSS>.md\`（5 要素）。
- 同周期内完工只更新该快照，不新建；骤降 ≥15 点 ⇒ 读最新快照核对并追加核对结果。

## 五、禁止事项

- ❌ 改写他人目录/历史日志；❌ 未授权路径写入；❌ 未经报备新建/删除目录。
- ❌ 改别人 \`AGENTS.md\`（要改请让对方自己改）。
- ❌ 声称"做完了"但无验证命令与输出。
- ❌ 装第三方依赖（除非任务明确要求）。

## 六、本文件夹权限

- \`team/members/${alias}/\`：本角色可写（规范、快照、\`scratch/\` 临时文件）。
- \`scratch/\`：临时产物，可清理，不属于交付物。
- 交付物一律写全路径，并在回报中列出。

## 附一、团队义务（M3 决议 §十七）

- 开工先看跨会话消息：优先用 message-bus 的 \`message_queue\` / \`message_read\`（或 team-bus \`network_info\`）；仅当本工作区没有 message-bus 时，才用 **legacy** \`node team/pipe2_tool.js read ${alias}\`（或 \`stat\`）收旧消息。
- 收到主题含「请表态 / 会议邀请 / 四段格式 / M*会议」的消息 ⇒ **必须回**，不许沉默；
  \`read\` 会在消息后直接打 \`⚠ 本条要求表态\` 提示。
- 表态格式：【结论】【依据】【分歧】【建议】。
- 每完成一个任务后跑一次 \`stat\`；有未读就处理。

## 附二、编码铁律（TEAM.md §十六）

- 写中文用 \`write\` 工具或 node \`fs\`（UTF-8）；**不要**用 PowerShell \`Get-Content -Raw\` / \`Add-Content\` / \`Set-Content\`。
- 写完可跑旧模板自带的编码自检（**legacy**，非必需）：\`node team/pipe2_tool.js check-encoding <file>\`（代码块/示例行已豁免）。
`;
}

function main() {
  const { alias, options } = parseArgs(process.argv.slice(2));
  // 1) 格式校验（长度/字符集/__ 前缀）
  const problem = validate(alias);
  if (problem !== undefined) {
    console.error('✗ ' + (alias ?? '(无)') + '：' + problem);
    process.exit(2);
  }
  // 2) 禁泛称：无条件检查（已登记也不例外；legacy 别名同样拒绝新建）
  if (isReserved(alias)) {
    console.error('✗ ' + alias + '：是禁泛称（' + alias + '）；已登记的历史别名不通过本工具重建目录，'
      + '如需维护请直接改 PEERS.json 走 peers 子命令');
    process.exit(1);
  }
  if (!fs.existsSync(TOOL)) {
    console.error('✗ 找不到 ' + TOOL + '（PIPE2 工具缺失）');
    process.exit(2);
  }

  // 3) 已登记 ⇒ 整个流程早退（不建目录、不写文件、无副作用）
  let alreadyRegistered = false;
  try {
    execFileSync(process.execPath, [TOOL, 'peers', 'check', alias], { stdio: 'inherit' });
  } catch {
    let listed = '';
    try { listed = execFileSync(process.execPath, [TOOL, 'peers', 'list'], { encoding: 'utf8' }); } catch { /* ignore */ }
    alreadyRegistered = listed.includes('[' + alias + ']');
    if (!alreadyRegistered) process.exit(1);
  }
  if (alreadyRegistered) {
    console.log('· ' + alias + ' 已登记 ⇒ 早退（不创建/不覆盖任何文件，幂等无副作用）');
    return;
  }

  // 4) 目录 + AGENTS.md（大小写不敏感文件系统保护）
  const dirs = fs.existsSync(MEMBERS) ? fs.readdirSync(MEMBERS) : [];
  const exact = dirs.find(name => name === alias);
  const caseInsensitive = dirs.find(name => name.toLowerCase() === alias.toLowerCase());
  if (exact === undefined && caseInsensitive !== undefined) {
    console.error('✗ 已存在大小写不同的目录：team/members/' + caseInsensitive
      + '（Windows 大小写不敏感，禁止再建 ' + alias + '）');
    process.exit(1);
  }
  const dir = path.join(MEMBERS, alias);
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    console.log('· team/members/' + alias + '/AGENTS.md 已存在，跳过（不覆盖）');
  } else {
    fs.writeFileSync(agentsPath, agentsTemplate(alias, options.role, options.team, options.captain), 'utf8');
    console.log('✓ 已创建 team/members/' + alias + '/AGENTS.md');
  }

  // 5) 注册 PEERS
  const registerArgs = [TOOL, 'peers', 'register', alias,
    '--role', options.role, '--team', options.team, '--cwd', options.cwd];
  if (options.session !== undefined) registerArgs.push('--session', options.session);
  // 默认 root = pipe2/ROOT_NAME（否则 broadcast --all 按 root 过滤时收不到）
  let rootName = options.root;
  if (rootName === undefined) {
    try {
      const value = fs.readFileSync(path.join(TEAM_DIR, 'pipe2', 'ROOT_NAME'), 'utf8').trim();
      if (value.length > 0) rootName = value;
    } catch { rootName = undefined; }
  }
  if (rootName !== undefined) registerArgs.push('--root', rootName);
  execFileSync(process.execPath, registerArgs, { stdio: 'inherit' });

  // 6) 可选：通知队长
  if (options.notify && options.captain !== undefined) {
    const bodyPath = path.join(dir, '.notify-body.txt');
    fs.writeFileSync(bodyPath,
      '新成员已入列：' + alias + '（角色 ' + options.role + '，团队 ' + options.team + '）。\n'
      + '目录：team/members/' + alias + '/（AGENTS.md 已生成）\n'
      + '注册表：team/pipe2/PEERS.json', 'utf8');
    try {
      execFileSync(process.execPath,
        [TOOL, 'post', alias, options.captain, '新成员入列：' + alias, bodyPath], { stdio: 'inherit' });
    } finally {
      fs.rmSync(bodyPath, { force: true });
    }
  }

  console.log('✓ 完成：' + alias + '（目录 + PEERS.json 登记' + (options.notify && options.captain ? ' + 已通知队长' : '') + '）');
}

main();
