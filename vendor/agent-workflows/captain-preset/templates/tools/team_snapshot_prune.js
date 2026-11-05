#!/usr/bin/env node
// team/team_snapshot_prune.js —— 快照清理（A6：保留最近 N 份 + 最近 D 天一律保留）
//
// 用法：
//   node team/team_snapshot_prune.js [--keep 3] [--days 30] [--member <别名>] [--fix]
//
// 默认 dry-run：只打印"可清理 N 份"；--fix 才执行。
// 执行前先复制到 file_backups/snapshots_<时间戳>/<别名>/（备份是命根子），再删除。
// A6 决议：`team_member_audit --prune-snapshots` 可直接调用本脚本。
'use strict';

const fs = require('fs');
const path = require('path');

const TEAM_ROOT = process.env.TEAM_ROOT ? path.resolve(process.env.TEAM_ROOT) : path.join(__dirname, '..');
const MEMBERS = path.join(TEAM_ROOT, 'team', 'members');
const BACKUPS = path.join(TEAM_ROOT, 'file_backups');

function parseArgs(argv) {
  const options = { keep: 3, days: 30, member: undefined, fix: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--keep') { options.keep = Number(value); i++; }
    else if (key === '--days') { options.days = Number(value); i++; }
    else if (key === '--member') { options.member = value; i++; }
    else if (key === '--fix') options.fix = true;
  }
  if (!Number.isFinite(options.keep) || options.keep < 1) options.keep = 3;
  if (!Number.isFinite(options.days) || options.days < 0) options.days = 30;
  return options;
}

function timestamp() {
  const d = new Date();
  const pad = value => String(value).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_'
    + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(MEMBERS)) {
    console.log('（team/members 不存在）');
    return;
  }
  const members = fs.readdirSync(MEMBERS).filter(entry => {
    try { return fs.statSync(path.join(MEMBERS, entry)).isDirectory(); } catch { return false; }
  }).filter(entry => options.member === undefined || entry === options.member);
  if (members.length === 0) {
    console.log('（没有匹配的成员目录）');
    return;
  }
  const cutoff = Date.now() - options.days * 86400000;
  const backupRoot = path.join(BACKUPS, 'snapshots_' + timestamp());
  let totalCandidates = 0;
  for (const member of members) {
    const dir = path.join(MEMBERS, member);
    const snapshots = fs.readdirSync(dir)
      .filter(name => /^CONTEXT_SNAPSHOT_.*\.md$/.test(name))
      .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    // 先保护最近 keep 份与最近 days 天内的，再在剩余里挑候选
    const protectedNames = new Set(snapshots.slice(0, options.keep).map(s => s.name));
    const candidates = snapshots.filter(s => !protectedNames.has(s.name) && s.mtime < cutoff);
    if (candidates.length === 0) continue;
    totalCandidates += candidates.length;
    console.log('[' + member + '] 共 ' + snapshots.length + ' 份快照，可清理 ' + candidates.length + ' 份（保留 ' + options.keep + ' 份 / ' + options.days + ' 天）');
    for (const candidate of candidates) console.log('  - ' + candidate.name);
    if (!options.fix) continue;
    const backupDir = path.join(backupRoot, member);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const candidate of candidates) {
      fs.copyFileSync(path.join(dir, candidate.name), path.join(backupDir, candidate.name));
      fs.rmSync(path.join(dir, candidate.name), { force: true });
    }
  }
  if (totalCandidates === 0) {
    console.log('（没有可清理的快照）');
    return;
  }
  if (options.fix) {
    // A6：清理必须留痕（写团队台账）
    const ledger = path.join(TEAM_ROOT, 'team', 'WORK_LEDGER.md');
    try {
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      if (!fs.existsSync(ledger)) {
        fs.writeFileSync(ledger, '# 工作台账\n\n| 时间 | 动作 | 详情 |\n|---|---|---|\n', 'utf8');
      }
      fs.appendFileSync(ledger, '| ' + new Date().toISOString() + ' | 快照清理 | 清理 '
        + totalCandidates + ' 份（keep=' + options.keep + ' days=' + options.days
        + '），备份 ' + backupRoot + ' |\n', 'utf8');
      console.log('✓ 已写入台账 ' + ledger);
    } catch { /* best effort */ }
    console.log('✓ 已清理 ' + totalCandidates + ' 份；备份在 ' + backupRoot);
  } else {
    console.log('（dry-run）执行：node team/team_snapshot_prune.js --fix [--keep ' + options.keep + '] [--days ' + options.days + ']');
  }
}

main();
