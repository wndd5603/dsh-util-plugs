#!/usr/bin/env node
// team/pipe2_watch.js —— pipe2 事件驱动等待器（★ 零依赖 ✓）
//
// 用 fs.watch 监听 team/pipe2/inbox/<me>/：一有新消息文件出现，就打印它的 JSON
// 并退出（0）。没有新消息则阻塞，直到 --timeout 秒（默认 600）后打印 TIMEOUT 并
// 退出（3）。这样没有 DSH 插件时也能事件驱动，配合 job_output(wait:true) 使用。
//
// 用法：
//   node team/pipe2_watch.js <me> [--timeout 秒] [--all]
//     --all   打印所有未 ACK 消息后退出；默认只打印第一条（随后由调用方 read）
// 环境变量：PIPE2_ROOT 覆盖根目录（测试用）
// 退出码：0 有新消息 / 1 意外错误 / 2 用法错误 / 3 超时
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIPE2 = process.env.PIPE2_ROOT
  ? path.resolve(process.env.PIPE2_ROOT)
  : path.join(ROOT, 'team', 'pipe2');
const INBOX = path.join(PIPE2, 'inbox');
const ACK = path.join(PIPE2, 'ack');

const me = process.argv[2];
if (!me) {
  console.error('用法：node team/pipe2_watch.js <me> [--timeout 秒] [--all]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const all = rest.includes('--all');
const ti = rest.indexOf('--timeout');
const timeoutSec = ti >= 0 ? Math.max(1, Number(rest[ti + 1]) || 600) : 600;

const inbox = path.join(INBOX, me);
fs.mkdirSync(inbox, { recursive: true });

function unacked() {
  const out = [];
  for (const file of fs.readdirSync(inbox)) {
    if (!file.endsWith('.json')) continue;
    const p = path.join(inbox, file);
    let msg = null;
    try { msg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!msg || typeof msg.id !== 'string') continue;
    if (fs.existsSync(path.join(ACK, me, msg.id + '.ack'))) continue;
    out.push(msg);
  }
  out.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return out;
}

function finish(msgs) {
  const picked = all ? msgs : [msgs[0]];
  for (const msg of picked) console.log(JSON.stringify(msg, null, 2));
  process.exit(0);
}

// 1) 先看积压
const backlog = unacked();
if (backlog.length > 0) finish(backlog);

// 2) 没有积压 → fs.watch 等待
let settled = false;
let debounce = null;
let watcher = null;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  if (watcher) try { watcher.close(); } catch { /* ignore */ }
  console.log('TIMEOUT');
  process.exit(3);
}, timeoutSec * 1000);

function checkNow() {
  if (settled) return;
  const fresh = unacked();
  if (fresh.length === 0) return;
  settled = true;
  clearTimeout(timer);
  if (watcher) try { watcher.close(); } catch { /* ignore */ }
  finish(fresh);
}

try {
  watcher = fs.watch(inbox, { persistent: true }, (_event, filename) => {
    if (settled) return;
    clearTimeout(debounce);
    debounce = setTimeout(checkNow, 150);
  });
} catch (error) {
  console.error('watch 失败：' + String(error));
  process.exit(1);
}

process.on('SIGINT', () => { if (watcher) try { watcher.close(); } catch { /* ignore */ } process.exit(3); });
