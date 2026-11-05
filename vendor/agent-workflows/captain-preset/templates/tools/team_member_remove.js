#!/usr/bin/env node
// team/team_member_remove.js —— 成员移除（A1 九步流程，与 team_member_new.js 对称）
//
// 用法：
//   node team/team_member_remove.js <别名> [--reason <原因>] [--ledger <台账路径>]
//        [--captain <队长别名>] [--notify] [--yes] [--force-infra]
//        [--tasks-check <文件>] [--confirm-tasks-transferred]
//
// 九步（默认 dry-run，只打印计划；--yes 才执行）：
//   0. 在途任务门禁：--yes 必须带 --tasks-check <文件> + --confirm-tasks-transferred
//   1. 精确匹配 team/members/<别名>（readdirSync，禁止大小写不敏感的 existsSync）
//   2. 校验 PEERS 登记；kind=infra 需 --force-infra
//   3. 备份整目录 → file_backups/成员归档_<别名>_<时间戳>/
//   3b. 归档目录生成 INDEX.md（快照/产出清单）
//   4. peers remove
//   5. 删除目录（仅 --yes）
//   6. 台账追加一行（谁/何时/原因/归档路径/证据文件）
//   6b. 跑 tools/team_member_audit.js 验证（存在才跑；失败告警不自动恢复）
//   7. --notify 时给队长投一条通知
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TEAM_ROOT = process.env.TEAM_ROOT ? path.resolve(process.env.TEAM_ROOT) : path.join(__dirname, '..');
const TEAM_DIR = path.join(TEAM_ROOT, 'team');
const MEMBERS = path.join(TEAM_DIR, 'members');
const TOOL = path.join(TEAM_DIR, 'pipe2_tool.js');
const PEERS = path.join(TEAM_DIR, 'pipe2', 'PEERS.json');
const BACKUPS = path.join(TEAM_ROOT, 'file_backups');

function parseArgs(argv) {
  const alias = argv[0];
  const options = {
    reason: undefined,
    ledger: path.join(TEAM_DIR, 'WORK_LEDGER.md'),
    captain: undefined,
    notify: false,
    yes: false,
    forceInfra: false,
    tasksCheck: undefined,
    confirmTasks: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--reason') { options.reason = value; i++; }
    else if (key === '--ledger') { options.ledger = value; i++; }
    else if (key === '--captain') { options.captain = value; i++; }
    else if (key === '--from') { options.from = value; i++; }
    else if (key === '--tasks-check') { options.tasksCheck = value; i++; }
    else if (key === '--notify') options.notify = true;
    else if (key === '--yes') options.yes = true;
    else if (key === '--force-infra') options.forceInfra = true;
    else if (key === '--confirm-tasks-transferred') options.confirmTasks = true;
  }
  return { alias, options };
}

function readPeers() {
  try { return JSON.parse(fs.readFileSync(PEERS, 'utf8')); } catch { return { peers: [] }; }
}

function timestamp() {
  const d = new Date();
  const pad = value => String(value).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_'
    + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function writeIndex(archiveDir, alias) {
  const lines = ['# 成员归档索引 —— ' + alias, '', '归档时间：' + new Date().toISOString(), ''];
  const snapshots = fs.readdirSync(archiveDir).filter(name => /^CONTEXT_SNAPSHOT_.*\.md$/.test(name)).sort();
  lines.push('## 快照（' + snapshots.length + '）', '');
  for (const name of snapshots) lines.push('- ' + name);
  if (snapshots.length === 0) lines.push('（无）');
  const scratch = path.join(archiveDir, 'scratch');
  const scratchFiles = fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];
  lines.push('', '## scratch 产出（' + scratchFiles.length + '）', '');
  for (const name of scratchFiles.slice(0, 50)) lines.push('- scratch/' + name);
  if (scratchFiles.length > 50) lines.push('- …（其余 ' + (scratchFiles.length - 50) + ' 个略）');
  if (scratchFiles.length === 0) lines.push('（无）');
  const agents = fs.existsSync(path.join(archiveDir, 'AGENTS.md')) ? '有' : '无';
  lines.push('', '## AGENTS.md', '', '- ' + agents);
  fs.writeFileSync(path.join(archiveDir, 'INDEX.md'), lines.join('\n') + '\n', 'utf8');
}

function appendLedger(ledgerPath, line) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, '# 工作台账\n\n| 时间 | 动作 | 详情 |\n|---|---|---|\n', 'utf8');
  }
  fs.appendFileSync(ledgerPath, '| ' + new Date().toISOString() + ' | 成员移除 | ' + line + ' |\n', 'utf8');
}

function main() {
  const { alias, options } = parseArgs(process.argv.slice(2));
  if (typeof alias !== 'string' || alias.length === 0) {
    console.error('用法：team_member_remove.js <别名> [--reason ...] [--yes] ...');
    process.exit(2);
  }
  const plan = [];
  const fail = (message) => { console.error('✗ ' + message); process.exit(1); };

  // 0) 在途任务门禁
  if (options.yes) {
    if (options.tasksCheck === undefined || !fs.existsSync(options.tasksCheck)) {
      fail('--yes 需要 --tasks-check <文件>（队长侧 team_task_list 输出存档）');
    }
    if (!options.confirmTasks) {
      fail('--yes 需要 --confirm-tasks-transferred（确认无未完成任务或已转派）');
    }
    plan.push('0. 在途任务证据：' + options.tasksCheck);
  } else {
    plan.push('0. 在途任务：dry-run 不校验；执行前须先跑 team_task_list 并带 --tasks-check');
  }

  // 1) 精确匹配
  const dirs = fs.existsSync(MEMBERS) ? fs.readdirSync(MEMBERS) : [];
  if (!dirs.includes(alias)) {
    fail('team/members/' + alias + ' 不存在（readdir 精确匹配；目录名大小写敏感）');
  }
  plan.push('1. 目录存在：team/members/' + alias);

  // 2) 校验 PEERS
  const store = readPeers();
  const peer = store.peers.find(entry => entry.alias === alias);
  if (peer === undefined) fail(alias + ' 未在 PEERS.json 登记（拒绝移除未登记目录）');
  if (peer.kind === 'infra' && !options.forceInfra) {
    fail(alias + ' 是 infra（基础设施）角色；确需移除请加 --force-infra');
  }
  plan.push('2. PEERS 已登记（kind=' + (peer.kind ?? 'member') + '，status=' + (peer.status ?? 'active') + '）');

  // 3) 备份
  const archiveDir = path.join(BACKUPS, '成员归档_' + alias + '_' + timestamp());
  plan.push('3. 备份 → ' + archiveDir);

  // 3b) 索引
  plan.push('3b. 归档目录生成 INDEX.md（快照/scratch 清单）');

  // 4/5/6
  plan.push('4. peers remove ' + alias);
  plan.push('5. 删除 team/members/' + alias + '（仅 --yes）');
  plan.push('6. 台账追加：' + options.ledger);
  plan.push('6b. 跑 tools/team_member_audit.js 验证（存在才跑）');
  if (options.notify && options.captain !== undefined) plan.push('7. 通知队长 ' + options.captain);

  if (!options.yes) {
    console.log('（dry-run）计划：');
    for (const line of plan) console.log('  ' + line);
    console.log('  执行：node team/team_member_remove.js ' + alias + ' --yes --tasks-check <file> --confirm-tasks-transferred [--reason ...]');
    return;
  }

  // 3) 备份（copy）
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
  fs.cpSync(path.join(MEMBERS, alias), archiveDir, { recursive: true });
  // 3a) 证据文件随备份归档（台账引用的证据不能因清理而失效）
  if (options.tasksCheck !== undefined && fs.existsSync(options.tasksCheck)) {
    try {
      fs.copyFileSync(options.tasksCheck, path.join(archiveDir, 'tasks-check.txt'));
    } catch { /* best effort */ }
  }
  // 3b) 索引
  writeIndex(archiveDir, alias);
  // 4) 移除 PEERS
  execFileSync(process.execPath, [TOOL, 'peers', 'remove', alias], { stdio: 'inherit' });
  // 5) 删除目录
  fs.rmSync(path.join(MEMBERS, alias), { recursive: true, force: true });
  // 6) 台账
  appendLedger(options.ledger, '移除 ' + alias + '｜归档 ' + archiveDir + '｜证据 ' + options.tasksCheck
    + '｜原因 ' + (options.reason ?? '（未写）'));
  // 6b) 审计（存在才跑；失败告警不自动恢复）
  const audit = path.join(TEAM_ROOT, 'tools', 'team_member_audit.js');
  if (fs.existsSync(audit)) {
    try {
      execFileSync(process.execPath, [audit], { stdio: 'inherit' });
    } catch {
      console.error('⚠ team_member_audit 未通过（请人工核查，不做自动恢复）');
    }
  }
  // 7) 通知
  if (options.notify && options.captain !== undefined) {
    const bodyPath = path.join(TEAM_DIR, '.remove-notify.txt');
    fs.writeFileSync(bodyPath, '成员已移除：' + alias + '\n归档：' + archiveDir + '\n原因：' + (options.reason ?? '（未写）'), 'utf8');
    try {
      execFileSync(process.execPath, [TOOL, 'post', options.from, options.captain, '成员移除：' + alias, bodyPath], { stdio: 'inherit' });
    } finally {
      fs.rmSync(bodyPath, { force: true });
    }
  }
  console.log('✓ 完成：' + alias + ' 已移除（备份在 ' + archiveDir + '）');
}

main();
