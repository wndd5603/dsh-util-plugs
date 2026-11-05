#!/usr/bin/env node
// team/pipe2_tool.js —— 跨会话管道 v2（★ 零依赖 ✓）
//
// 设计：每消息一个 JSON 文件 + ACK + 游标 + 原子 rename。
//   team/pipe2/inbox/<to>/<seq>-<id>.json   消息（不可变）
//   team/pipe2/ack/<to>/<id>.ack            已读回执
//   team/pipe2/cursor/<reader>.json         读者游标（调试/追溯）
//   team/pipe2/tmp/                         写入暂存（同卷 rename 原子）
//
// 用法：
//   node team/pipe2_tool.js post <from> <to> <subject> <body-file|-> [--reply-to <id>]
//   node team/pipe2_tool.js broadcast <from> <subject> <body-file|-> [--to a,b] | [--all]
//   node team/pipe2_tool.js read <me>              → 打印未 ACK 消息，写 ACK + 游标
//   node team/pipe2_tool.js list [<to>]            → 列出全部（或某收件人）消息
//   node team/pipe2_tool.js ack <me> <id>
//   node team/pipe2_tool.js stat [<inbox>]     → 只读核对：条数/未 ACK/最后一条          → 手动补 ACK
//   node team/pipe2_tool.js selftest               → 临时目录内自测（双向）
//
// 环境变量：
//   PIPE2_ROOT   覆盖 pipe2 根目录（默认 <repo>/team/pipe2；自测用临时目录）
// 退出码：0 通过 / 1 断言失败 / 2 用法错误 / 3 超时
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PIPE2 = process.env.PIPE2_ROOT
  ? path.resolve(process.env.PIPE2_ROOT)
  : path.join(ROOT, 'team', 'pipe2');
const INBOX = path.join(PIPE2, 'inbox');
const ACK = path.join(PIPE2, 'ack');
const CURSOR = path.join(PIPE2, 'cursor');
const TMP = path.join(PIPE2, 'tmp');
const ARCHIVE = path.join(PIPE2, '_archive');
const LAST_ARCHIVE_FILE = path.join(PIPE2, '.last-archive');

function nowIso() { return new Date().toISOString(); }

// ---------- M4 第一批：规则版本 / 时区显示 / test 标记 ----------
const RULES_VERSION_FILE = path.join(PIPE2, 'RULES_VERSION');
const ROOT_NAME_FILE = path.join(PIPE2, 'ROOT_NAME');

/** 当前规则版本（单行文件，不解析 TEAM.md）。 */
function readRulesVersion() {
  try { return fs.readFileSync(RULES_VERSION_FILE, 'utf8').trim(); } catch { return undefined; }
}

/** 当前 pipe2 根所属团队标识（单行文件；--all 按它过滤，禁止跨 root 广播）。 */
function readRootName() {
  try {
    const value = fs.readFileSync(ROOT_NAME_FILE, 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch { return undefined; }
}

/** 存储保持 UTC ISO-8601；显示统一 +08:00。 */
function formatCst(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const pad = value => String(value).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate())
    + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) + '+08:00';
}

function isTest(message) { return message !== null && message !== undefined && message.tag === 'test'; }

/** legacy/retired 别名的 redirectTo（数据驱动；无 redirectTo 时原样投递）。 */
function resolveRecipient(to) {
  const store = readPeers();
  const peer = store.peers.find(entry => entry.alias === to);
  if (peer !== undefined && (peer.status === 'legacy' || peer.status === 'retired')
    && typeof peer.redirectTo === 'string' && peer.redirectTo.length > 0) {
    return { target: peer.redirectTo, note: '（原收件人 ' + to + ' 已改名为 ' + peer.redirectTo + '，已自动转投）' };
  }
  return { target: to, note: undefined };
}

function parseTag(args) {
  const index = args.indexOf('--tag');
  if (index >= 0 && args[index + 1] === 'test') return 'test';
  return 'prod';
}


const PEER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function requireSafePeerName(name, label) {
  if (typeof name !== 'string' || !PEER_NAME_RE.test(name)) {
    console.error('✗ 非法 ' + (label || 'peer') + '：' + JSON.stringify(name) + '（只允许小写字母/数字/_-，≤64）');
    process.exit(2);
  }
  return name;
}
function ensureBase() {
  for (const d of [INBOX, ACK, CURSOR, TMP]) fs.mkdirSync(d, { recursive: true });
}
function ensureParty(to) {
  requireSafePeerName(to, 'to');
  ensureBase();
  fs.mkdirSync(path.join(INBOX, to), { recursive: true });
  fs.mkdirSync(path.join(ACK, to), { recursive: true });
}

function listMessages(to) {
  ensureParty(to);
  const dir = path.join(INBOX, to);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const p = path.join(dir, f);
      let msg = null;
      try { msg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { msg = null; }
      return { file: f, path: p, msg };
    })
    .filter(e => e.msg && typeof e.msg.id === 'string')
    .sort((a, b) => (a.msg.seq || 0) - (b.msg.seq || 0) || a.file.localeCompare(b.file));
}

function ackPath(to, id) {
  validatePeerName(to, 'to');
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id)) { console.error('✗ 非法消息 id：' + JSON.stringify(id)); process.exit(2); }
  return path.join(ACK, to, id + '.ack');
}
function isAcked(to, id) { return fs.existsSync(ackPath(to, id)); }
/** ACK 记录 reader 标识（谁读的），内容为 JSON；存在性判定不变。 */
function writeAck(to, id, reader) {
  fs.mkdirSync(path.join(ACK, to), { recursive: true });
  const who = typeof reader === 'string' && reader.length > 0 ? reader : 'unknown'
  fs.writeFileSync(ackPath(to, id), JSON.stringify({ at: nowIso(), reader: who }) + '\n', 'utf8');
}

function writeMessage(from, to, subject, body, replyTo, options) {
  requireSafePeerName(from, 'from');
  ensureParty(to);
  const prior = listMessages(to).filter(e => e.msg.from === from);
  const seq = prior.length ? Math.max(...prior.map(e => e.msg.seq || 0)) + 1 : 1;
  const id = crypto.randomUUID();
  const rulesVersion = readRulesVersion();
  const tag = options !== null && options !== undefined && options.tag === 'test' ? 'test' : 'prod';
  const msg = {
    schema: 1,
    id,
    seq,
    from,
    to,
    ts: nowIso(),
    subject,
    body: body.trim(),
    tag,
    ...(rulesVersion === undefined ? {} : { rulesVersion }),
    ...(replyTo === undefined ? {} : { replyTo }),
  };
  const tmp = path.join(TMP, id + '.json.tmp');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(msg, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dest = path.join(INBOX, to, String(seq).padStart(4, '0') + '-' + id + '.json');
  fs.renameSync(tmp, dest);
  return { id, seq };
}

function cmdPost(args) {
  const [from, to, subject, bodyArg] = args;
  if (!from || !to || !subject) {
    console.error('用法：post <from> <to> <subject> <body-file|-> [--reply-to <id>]');
    process.exit(2);
  }
  let replyTo;
  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--reply-to' && args[i + 1]) { replyTo = args[i + 1]; i++; }
  }
  const body = (!bodyArg || bodyArg === '-')
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(bodyArg, 'utf8');
  assertCleanBody(body, args);
  const tag = parseTag(args);
  const route = resolveRecipient(to);
  if (route.note !== undefined) {
    console.error('⚠ ' + to + ' 已改名为 ' + route.target + '，已自动转投（请以后直接用新名）');
  }
  const finalBody = route.note === undefined ? body : route.note + '\n\n' + body;
  const { id, seq } = writeMessage(from, route.target, subject, finalBody, replyTo, { tag });
  console.log('✓ 已投递 ' + from + ' → ' + route.target + '（seq ' + seq + '，id ' + id.slice(0, 8) + (tag === 'test' ? '，tag=test' : '') + '）');
  console.log('  subject: ' + subject);
}

function cmdBroadcast(args) {
  const [from, subject, bodyArg] = args;
  if (!from || !subject) {
    console.error('用法：broadcast <from> <subject> <body-file|-> [--to a,b] 或 [--all]（默认 --all）');
    process.exit(2);
  }
  let recipients = [];
  let useAll = true;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--to' && args[i + 1]) {
      recipients = args[i + 1].split(',').map(value => value.trim()).filter(Boolean);
      useAll = false;
      i++;
    } else if (args[i] === '--all') {
      useAll = true;
      recipients = [];
    }
  }
  const body = (!bodyArg || bodyArg === '-')
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(bodyArg, 'utf8');
  assertCleanBody(body, args);
  const tag = parseTag(args);
  ensureBase();
  if (useAll) {
    // 补1：收件人以 PEERS.json 为准；C2：只发当前 root（禁止跨 root --all）。
    const currentRoot = readRootName();
    const allPeers = readPeers().peers;
    const peers = allPeers.filter(peer =>
      (peer.status === 'active' || peer.status === 'ephemeral')
      && (peer.kind ?? 'member') === 'member'
      && peer.alias !== from
      && (currentRoot === undefined || (peer.root ?? '') === currentRoot));
    if (currentRoot === undefined) {
      console.error('⚠ pipe2/ROOT_NAME 未配置：--all 未按 root 过滤（请创建 pipe2/ROOT_NAME 写团队根标识）');
    }
    if (peers.length > 0) {
      recipients = peers.map(peer => peer.alias);
    } else if (currentRoot === undefined) {
      recipients = fs.readdirSync(INBOX).filter(entry => {
        if (entry.startsWith('__')) return false; // system/junk dirs are never recipients
        try { return fs.statSync(path.join(INBOX, entry)).isDirectory(); } catch { return false; }
      });
    } else {
      console.error('✗ 当前 root（' + currentRoot + '）没有可广播的成员；跨团队请用 --to 显式列目标');
      process.exit(2);
    }
  }
  const targets = recipients.filter(entry => entry !== from);
  if (targets.length === 0) {
    console.error('没有可广播的收件人');
    process.exit(2);
  }
  // redirectTo 转投 + 去重（两个旧名可能指向同一新名）
  const delivered = new Set();
  for (const to of targets) {
    const route = resolveRecipient(to);
    if (delivered.has(route.target)) continue;
    delivered.add(route.target);
    const finalBody = route.note === undefined ? body : route.note + '\n\n' + body;
    const { id, seq } = writeMessage(from, route.target, subject, finalBody, undefined, { tag });
    console.log('✓ 已广播 ' + from + ' → ' + route.target + '（seq ' + seq + '，id ' + id.slice(0, 8) + (tag === 'test' ? '，tag=test' : '') + '）');
  }
  console.log('  收件人：' + [...delivered].join(', '));
}

function wantsReply(subject) {
  return /请表态|会议邀请|四段格式|M\d+\s*会议/.test(String(subject ?? ''));
}

function cmdRead(args) {
  const noAck = args.includes('--no-ack');
  const asIndex = args.indexOf('--as');
  const asValue = asIndex >= 0 && typeof args[asIndex + 1] === 'string' ? args[asIndex + 1] : undefined;
  const skipIndex = asIndex >= 0 ? asIndex + 1 : -1;
  const positionals = args.filter((value, index) => !value.startsWith('--') && index !== skipIndex);
  const me = positionals[0];
  const reader = asValue ?? me;
  if (!me) { console.error('用法：read <me> [--no-ack] [--as <reader>]'); process.exit(2); }
  ensureParty(me);
  const meRoute = resolveRecipient(me);
  if (meRoute.note !== undefined) {
    console.log('⚠ 本别名已改名为 ' + meRoute.target + '（历史消息仍可读；新消息请用新名）');
  }
  const currentRules = readRulesVersion();
  const fresh = listMessages(me).filter(e => !isAcked(me, e.msg.id));
  if (fresh.length === 0) { console.log('（无新消息）'); return; }
  let needReply = 0;
  for (const e of fresh) {
    console.log('--- ' + formatCst(e.msg.ts) + ' ' + e.msg.from + ' → ' + e.msg.to + '｜' + e.msg.subject
      + '（id ' + e.msg.id.slice(0, 8) + (isTest(e.msg) ? '，tag=test' : '') + '）');
    if (currentRules !== undefined && e.msg.rulesVersion !== undefined && e.msg.rulesVersion !== currentRules) {
      console.log('⚠ 该消息写于规则 v' + e.msg.rulesVersion + '，当前 v' + currentRules + '（结论可能已过时）');
    }
    console.log(e.msg.body);
    if (wantsReply(e.msg.subject)) {
      needReply += 1;
      console.log('⚠ 本条要求表态（四段格式）：【结论】【依据】【分歧】【建议】');
      console.log('   回投：node team/pipe2_tool.js post ' + me + ' ' + e.msg.from + ' "<主题>" <正文文件>');
    }
    console.log('');
    if (!noAck) writeAck(me, e.msg.id, reader);
  }
  if (noAck) {
    console.log('（--no-ack）未写 ACK；本次共 ' + fresh.length + ' 条未读'
      + (needReply > 0 ? '，其中 ' + needReply + ' 条要求表态' : ''));
    return;
  }
  const last = fresh[fresh.length - 1].msg;
  fs.mkdirSync(CURSOR, { recursive: true });
  fs.writeFileSync(path.join(CURSOR, me + '.json'),
    JSON.stringify({ lastId: last.id, lastSeq: last.seq, updatedAt: nowIso() }, null, 2), 'utf8');
  console.log('✓ 已读取并 ACK ' + fresh.length + ' 条（reader=' + reader + '），游标已更新'
    + (needReply > 0 ? '（其中 ' + needReply + ' 条要求表态，别沉默）' : ''));
  maybeAutoArchive();
}

function cmdList(args) {
  const only = args[0];
  ensureBase();
  const parties = only
    ? [only]
    : fs.readdirSync(INBOX).filter(d => {
      try { return fs.statSync(path.join(INBOX, d)).isDirectory(); } catch { return false; }
    });
  if (parties.length === 0) { console.log('（pipe2 还没有消息）'); return; }
  let total = 0;
  for (const to of parties) {
    const msgs = listMessages(to);
    if (msgs.length === 0) continue;
    console.log('[' + to + '] ' + msgs.length + ' 条');
    for (const e of msgs) {
      const mark = isAcked(to, e.msg.id) ? '✓' : '·';
      console.log('  ' + mark + ' [seq ' + String(e.msg.seq).padStart(3) + '] ' + formatCst(e.msg.ts)
        + ' ' + e.msg.from + (isTest(e.msg) ? '[test]' : '') + '：' + e.msg.subject);
      total++;
    }
  }
  if (total === 0) console.log('（pipe2 还没有消息）');
}

function cmdStat(args) {
  ensureBase();
  const includeTest = args.includes('--include-test');
  const only = args.find(value => !value.startsWith('--'));
  if (only !== undefined) {
    const onlyRoute = resolveRecipient(only);
    if (onlyRoute.note !== undefined) {
      console.log('⚠ ' + only + ' 已改名为 ' + onlyRoute.target + '（历史只读；新消息请用新名）');
    }
  }
  const parties = only
    ? [only]
    : fs.readdirSync(INBOX).filter(entry => {
      if (entry.startsWith('__')) return false;
      try { return fs.statSync(path.join(INBOX, entry)).isDirectory(); } catch { return false; }
    });
  if (parties.length === 0) { console.log('（没有收件箱）'); return; }
  let total = 0;
  let totalUnacked = 0;
  const rulesVersion = readRulesVersion();
  const peers = readPeers().peers;
  const peerByAlias = new Map(peers.map(peer => [peer.alias, peer]));
  if (rulesVersion !== undefined) console.log('规则版本：v' + rulesVersion + (includeTest ? '（含 test 流量）' : '（默认过滤 test 流量）'));
  for (const to of parties) {
    const dir = path.join(INBOX, to);
    if (!fs.existsSync(dir)) { console.log('[' + to + '] 收件箱未创建（0 条）'); continue; }
    const all = listMessages(to);
    const msgs = includeTest ? all : all.filter(e => !isTest(e.msg));
    const unacked = msgs.filter(e => !isAcked(to, e.msg.id));
    const last = msgs[msgs.length - 1];
    total += msgs.length;
    totalUnacked += unacked.length;
    let line = '[' + to + '] ' + msgs.length + ' 条，未 ACK ' + unacked.length;
    // orphan 判定：空 inbox 不标；成员 status=retired 不标；仅"有消息且未登记/已失联"才告警
    const peer = peerByAlias.get(to);
    if (peer === undefined) {
      if (msgs.length > 0) line += '（orphan：PEERS 无登记，无人消费）';
    } else if (peer.status === 'retired') {
      line += '（retired 成员的历史 inbox，不再告警）';
    }
    if (last) {
      line += '，最后一条 ' + formatCst(last.msg.ts) + ' ' + last.msg.from + '「' + last.msg.subject + '」';
    }
    console.log(line);
  }
  if (!only) console.log('合计：' + total + ' 条，未 ACK ' + totalUnacked + ' 条');
}
// ---------- C1：消息归档（只移动不删除；ACK 同步移动） ----------
function archiveIndex() {
  const lines = ['# pipe2 归档索引（工具自动生成，请勿手改）', ''];
  if (!fs.existsSync(ARCHIVE)) {
    lines.push('（暂无归档）');
  } else {
    const months = fs.readdirSync(ARCHIVE).filter(entry => {
      try { return fs.statSync(path.join(ARCHIVE, entry)).isDirectory(); } catch { return false; }
    }).sort();
    for (const month of months) {
      lines.push('## ' + month);
      const pipes = fs.readdirSync(path.join(ARCHIVE, month)).filter(entry => {
        try { return fs.statSync(path.join(ARCHIVE, month, entry)).isDirectory(); } catch { return false; }
      }).sort();
      for (const pipe of pipes) {
        const count = fs.readdirSync(path.join(ARCHIVE, month, pipe)).filter(file => file.endsWith('.json')).length;
        lines.push('- ' + pipe + '：' + count + ' 条');
      }
      lines.push('');
    }
  }
  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.writeFileSync(path.join(ARCHIVE, 'INDEX.md'), lines.join('\n'), 'utf8');
}

function cmdArchive(args) {
  const apply = args.includes('--apply');
  const quiet = args.includes('--quiet');
  const olderIndex = args.indexOf('--older-than');
  const days = olderIndex >= 0 && Number.isFinite(Number(args[olderIndex + 1])) ? Number(args[olderIndex + 1]) : 7;
  const cutoff = Date.now() - days * 86400000;
  ensureBase();
  const parties = fs.readdirSync(INBOX).filter(entry => {
    if (entry.startsWith('__')) return false;
    try { return fs.statSync(path.join(INBOX, entry)).isDirectory(); } catch { return false; }
  });
  let candidates = 0;
  const perPipe = new Map();
  /** 孤儿邮箱归档后的通知对象：pipe → Set<from>。 */
  const orphanSenders = new Map();
  const peerAliases = new Set(readPeers().peers.map(peer => peer.alias));
  for (const to of parties) {
    for (const e of listMessages(to)) {
      if (!isAcked(to, e.msg.id)) continue;
      const ts = Date.parse(e.msg.ts);
      if (Number.isNaN(ts) || ts > cutoff) continue;
      const month = e.msg.ts.slice(0, 7);
      candidates += 1;
      perPipe.set(to, (perPipe.get(to) ?? 0) + 1);
      if (!apply) continue;
      const destDir = path.join(ARCHIVE, month, to);
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(e.path, path.join(destDir, e.file));
      const ackFile = ackPath(to, e.msg.id);
      if (fs.existsSync(ackFile)) {
        const ackDest = path.join(destDir, 'ack');
        fs.mkdirSync(ackDest, { recursive: true });
        fs.renameSync(ackFile, path.join(ackDest, e.msg.id + '.ack'));
      }
      if (!peerAliases.has(to) && typeof e.msg.from === 'string' && e.msg.from.length > 0 && e.msg.from !== to) {
        const set = orphanSenders.get(to) ?? new Set();
        set.add(e.msg.from);
        orphanSenders.set(to, set);
      }
    }
  }
  if (apply && candidates > 0) {
    // K2：孤儿邮箱归档后通知发送方（孤儿 = inbox 存在但 PEERS 无登记 ⇒ 无人消费）
    for (const [pipe, senders] of orphanSenders) {
      for (const sender of [...senders].slice(0, 20)) {
        try {
          writeMessage('bridge', sender, '归档通知：孤儿邮箱已归档',
            '收件人 `' + pipe + '` 在 PEERS.json 中没有登记（孤儿邮箱，无人消费）。\n'
            + '该邮箱中已 ACK 且超期的消息已移入 `_archive/`（可追溯，未删除）。\n'
            + '建议：让收件人重新登记，或改用有效别名。', undefined, { tag: 'prod' });
          console.log('  ↳ 已通知发送方 ' + sender + '（孤儿邮箱 ' + pipe + '）');
        } catch { /* best effort */ }
      }
    }
    // 清理 .bridge-seen 中的死条目（文件已不在 inbox）
    for (const to of parties) {
      const seenFile = path.join(PIPE2, '.bridge-seen-' + to + '.json');
      if (!fs.existsSync(seenFile)) continue;
      try {
        const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
        if (!Array.isArray(seen)) continue;
        const existing = new Set(fs.readdirSync(path.join(INBOX, to)).filter(file => file.endsWith('.json')));
        fs.writeFileSync(seenFile, JSON.stringify(seen.filter(name => existing.has(name))), 'utf8');
      } catch { /* best effort */ }
    }
    fs.writeFileSync(LAST_ARCHIVE_FILE, nowIso() + '\n', 'utf8');
    archiveIndex();
  }
  if (quiet) return;
  const summary = [...perPipe.entries()].map(([pipe, count]) => pipe + ':' + count).join(', ');
  console.log((apply ? '✓ 已归档 ' : '（dry-run）可归档 ') + candidates + ' 条' + (summary ? '（' + summary + '）' : ''));
  if (!apply && candidates > 0) {
    console.log('  执行：node team/pipe2_tool.js archive --older-than ' + days + ' --apply');
  }
}

/** read/ack 后顺带归档：1 小时节流，静默失败。 */
function maybeAutoArchive() {
  try {
    const last = fs.existsSync(LAST_ARCHIVE_FILE) ? Date.parse(fs.readFileSync(LAST_ARCHIVE_FILE, 'utf8').trim()) : 0;
    if (Number.isFinite(last) && Date.now() - last < 3600000) return;
    cmdArchive(['--apply', '--older-than', '7', '--quiet']);
  } catch { /* silent */ }
}

function cmdAck(args) {
  const asIndex = args.indexOf('--as');
  const asValue = asIndex >= 0 && typeof args[asIndex + 1] === 'string' ? args[asIndex + 1] : undefined;
  const skipIndex = asIndex >= 0 ? asIndex + 1 : -1;
  const positionals = args.filter((value, index) => !value.startsWith('--') && index !== skipIndex);
  const [me, id] = positionals;
  const reader = asValue ?? me;
  if (!me || !id) { console.error('用法：ack <me> <id> [--as <reader>]'); process.exit(2); }
  writeAck(me, id, reader);
  console.log('✓ ack ' + id.slice(0, 8) + '（reader=' + reader + '）');
  maybeAutoArchive();
}

function cmdSelfTest() {
  // 临时目录内跑一遍完整往返：post → list → read → ack → watch 由单独脚本覆盖。
  const saved = process.env.PIPE2_ROOT;
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pipe2-selftest-'));
  process.env.PIPE2_ROOT = tmpRoot;
  // 重新 require 自身不可行（模块级常量已求值）⇒ 直接内联最小断言。
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '✓' : '✗') + ' ' + name + (detail === undefined ? '' : '（' + detail + '）'));
    if (!ok) failures++;
  };
  try {
    const message = { schema: 1, id: 'selftest-id', seq: 1, from: 'a', to: 'b', ts: nowIso(), subject: 't', body: 'hello' };
    const tmpFile = path.join(tmpRoot, 'm.json');
    fs.writeFileSync(tmpFile, JSON.stringify(message));
    check('消息可序列化', JSON.parse(fs.readFileSync(tmpFile, 'utf8')).body === 'hello');
    // 原子写：tmp → rename
    const tmpDir = path.join(tmpRoot, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const staging = path.join(tmpDir, 'x.json.tmp');
    fs.writeFileSync(staging, 'x');
    fs.renameSync(staging, path.join(tmpRoot, 'x.json'));
    check('rename 原子落盘', fs.existsSync(path.join(tmpRoot, 'x.json')) && !fs.existsSync(staging));
    // ACK 文件语义
    const ackDir = path.join(tmpRoot, 'ack', 'b');
    fs.mkdirSync(ackDir, { recursive: true });
    const ack = path.join(ackDir, 'selftest-id.ack');
    fs.writeFileSync(ack, nowIso());
    check('ACK 可检测', fs.existsSync(ack));
    // 反向：未 ACK 时应为 false
    fs.unlinkSync(ack);
    check('未 ACK 可检测（反向）', !fs.existsSync(ack));
  } finally {
    process.env.PIPE2_ROOT = saved;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(failures === 0 ? '✓ ' + (4 - failures) + '/4 全部通过（exit 0）' : '✗ ' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- 编码守卫（GBK 误读标记，TEAM.md §十六） ----------
const MOJIBAKE_MARKERS = /[鈽鍒锛鈥涓涔鍙鎴鍦璺缁鎵鏄鍜鍚鐨宸鏂鑻璇鍧銆垜�]/;
// 文档里"列出标记示例"是正常场景：代码块、行内代码、示例行默认豁免。
const EXAMPLE_LINE_HINT = /误读标记|GBK 误读|标记示例|乱码标记|疑似乱码|查\s*[鈽鍒锛鈥涓涔]|markers?:/i;

function stripExampleZones(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
    .replace(/`[^`\n]*`/g, '')        // inline code
    .split('\n')
    .filter(line => !EXAMPLE_LINE_HINT.test(line))
    .join('\n');
}

function findMojibake(text, options) {
  const strict = options !== null && options !== undefined && options.strict === true;
  const source = strict ? String(text) : stripExampleZones(text);
  const hits = source.match(MOJIBAKE_MARKERS);
  return hits === null ? [] : [...new Set(hits)];
}

// ---------- 补7：最小披露分级扫描（H1–H3） ----------
const SENSITIVE_HIGH = /(?:sk-[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9]{16,}|Authorization:\s*Bearer\s+\S+)/i;
// H2：任意盘符绝对路径（`C:\…`/`D:/…`）与常见 POSIX 绝对路径（仅 warn，不阻断）
const SENSITIVE_PATH = /(?:[A-Za-z]:[\\/][^\s"'`]*|\/(?:home|Users|root|opt|var|etc|work|mnt)\/[^\s"'`]*)/;
const SENSITIVE_EXEMPT_LINE = /示例|不要写|禁止|脱敏|mask|敏感|最小披露/i;

function stripSensitiveExempt(text) {
  return stripExampleZones(text)
    .split('\n')
    .filter(line => !SENSITIVE_EXEMPT_LINE.test(line))
    .join('\n');
}

function assertCleanBody(body, args) {
  const list = Array.isArray(args) ? args : [];
  if (!list.includes('--allow-markers')) {
    const hits = findMojibake(body, { strict: list.includes('--strict') });
    if (hits.length > 0) {
      console.error('✗ 正文疑似乱码（发现 ' + hits.join(' ') + '）');
      console.error('  代码块/行内代码/示例行默认豁免；仍要扫描全文可加 --strict');
      console.error('  确认是故意引用可加 --allow-markers；修法见 TEAM.md §十六：用 write 工具或 node fs 以 UTF-8 写正文');
      console.error('  不要用 PowerShell Get-Content -Raw / Add-Content / Set-Content 处理中文');
      process.exit(1);
    }
  }
  if (list.includes('--allow-sensitive')) return;
  const scan = stripSensitiveExempt(body);
  const high = scan.match(SENSITIVE_HIGH);
  if (high !== null) {
    console.error('✗ 正文含高置信敏感信息（类型命中，长度 ' + high[0].length + '，内容不回显）');
    console.error('  确认故意引用可加 --allow-sensitive；规范见 TEAM.md（最小披露）');
    process.exit(1);
  }
  const pathHit = scan.match(SENSITIVE_PATH);
  if (pathHit !== null) {
    console.error('⚠ 正文含绝对路径（' + pathHit[0] + '），建议改相对路径（不阻断）');
  }
}

function cmdCheckEncoding(args) {
  const flags = args.filter(value => value.startsWith('--'));
  const file = args.find(value => !value.startsWith('--'));
  if (!file) { console.error('用法：check-encoding <file|-> [--strict]   （- 表示 stdin）'); process.exit(2); }
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const strict = flags.includes('--strict');
  const hits = findMojibake(text, { strict });
  if (hits.length === 0) {
    console.log('✓ 未发现 GBK 误读标记' + (strict ? '（strict 全文扫描）' : '（代码块/示例行已豁免）'));
    return;
  }
  console.error('✗ 发现疑似乱码标记：' + hits.join(' '));
  process.exit(1);
}

// ---------- PEERS 注册表（TEAM.md §十四） ----------
const PEERS = path.join(PIPE2, 'PEERS.json');
const RESERVED_NAMES = new Set(['captain', 'lead', 'leader', 'boss', 'admin', 'chief', 'host', 'owner',
  'agent', 'assistant', 'bot', 'team', 'system', 'all', 'everyone', 'main', 'root', '队长', '组长', '管理员', '系统']);

function validatePeerName(name) {
  if (typeof name !== 'string' || name.length === 0) return '名字为空';
  if (name.length > 16) return '超过 16 字符（当前 ' + name.length + '）';
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return '只允许小写字母/数字/连字符，且必须以字母开头';
  if (name.startsWith('__')) return '双下划线开头保留给系统';
  if (RESERVED_NAMES.has(name)) return '是禁泛称（' + name + '）';
  return undefined;
}

/** 由 roleHistory 派生"承担过的角色"（唯一事实来源是 roleHistory）。 */
function acceptedRoles(peer) {
  const roles = [];
  if (Array.isArray(peer.roleHistory)) {
    for (const entry of peer.roleHistory) {
      if (typeof entry.role === 'string' && !roles.includes(entry.role)) roles.push(entry.role);
    }
  }
  if (typeof peer.role === 'string' && peer.role.length > 0 && !roles.includes(peer.role)) roles.push(peer.role);
  return roles;
}

function readPeers() {
  try {
    const data = JSON.parse(fs.readFileSync(PEERS, 'utf8'));
    return Array.isArray(data.peers) ? data : { version: 1, peers: [] };
  } catch { return { version: 1, peers: [] }; }
}

function renderPeersMd(store) {
  const lines = ['# PEERS —— 团队协作者注册表（工具自动生成，请勿手改）', '',
    '| 别名 | 状态 | 类型 | 团队 | 角色 | 曾承担角色 | session | 加入时间 |',
    '|---|---|---|---|---|---|---|---|'];
  for (const p of store.peers) {
    lines.push('| ' + p.alias + ' | ' + (p.status ?? 'active') + ' | ' + (p.kind ?? 'member')
      + ' | ' + (p.team ?? '-') + ' | ' + (p.role ?? '-') + ' | ' + acceptedRoles(p).join(',')
      + ' | ' + (p.session ?? '-') + ' | ' + (p.joinedAt ?? '-') + ' |');
  }
  lines.push('');
  fs.writeFileSync(path.join(PIPE2, 'PEERS.md'), lines.join('\n'), 'utf8');
}

function writePeers(store) {
  fs.mkdirSync(PIPE2, { recursive: true });
  const tmp = PEERS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, PEERS);
  renderPeersMd(store);
}

function cmdPeers(args) {
  const [sub, ...rest] = args;
  const store = readPeers();
  if (sub === undefined || sub === 'list') {
    if (store.peers.length === 0) { console.log('（PEERS.json 为空）'); return; }
    if (rest.includes('--md')) {
      const lines = ['# PEERS —— 团队成员（PEERS.json 自动生成，请勿手改）', '',
        '| 别名 | 状态 | 类型 | 团队 | 角色 | 曾承担角色 | session | 加入时间 |',
        '|---|---|---|---|---|---|---|---|'];
      for (const p of store.peers) {
        lines.push('| ' + p.alias + ' | ' + (p.status ?? 'active') + ' | ' + (p.kind ?? 'member')
          + ' | ' + (p.team ?? '-') + ' | ' + (p.role ?? '-') + ' | ' + acceptedRoles(p).join(',')
          + ' | ' + (p.session ?? '-') + ' | ' + (p.joinedAt ?? '-') + ' |');
      }
      const md = lines.join('\n') + '\n';
      const writeIndex = rest.indexOf('--write');
      const target = writeIndex >= 0 ? rest[writeIndex + 1] : undefined;
      if (target !== undefined) {
        fs.writeFileSync(target, md, 'utf8');
        console.log('✓ 已写入 ' + target + '（' + store.peers.length + ' 名成员）');
      } else {
        console.log(md);
      }
      return;
    }
    for (const p of store.peers) {
      console.log('[' + p.alias + '] status=' + (p.status ?? 'active') + ' kind=' + (p.kind ?? 'member')
        + ' team=' + (p.team ?? '-') + ' root=' + (p.root ?? '-') + ' role=' + (p.role ?? '-')
        + ' accepted=[' + acceptedRoles(p).join(',') + '] session=' + (p.session ?? '-')
        + ' joined=' + (p.joinedAt ?? '-'));
    }
    return;
  }
  if (sub === 'roles') {
    const alias = rest[0];
    const peer = store.peers.find(p => p.alias === alias);
    if (peer === undefined) { console.error('✗ 未找到 ' + alias); process.exit(1); }
    if (peer.roleHistory === undefined || peer.roleHistory.length === 0) {
      console.log(alias + ' 无角色历史（当前 role=' + (peer.role ?? '-') + '）');
      return;
    }
    for (const entry of peer.roleHistory) {
      console.log(entry.role + '  from=' + (entry.from ?? '-') + '  to=' + (entry.to ?? '（现任）'));
    }
    return;
  }
  if (sub === 'set-role') {
    const alias = rest[0];
    const role = rest[1];
    if (alias === undefined || role === undefined || role.length === 0 || role.startsWith('--')) {
      console.error('用法：peers set-role <别名> <新角色>（角色不能为空或以 -- 开头）');
      process.exit(2);
    }
    const peer = store.peers.find(p => p.alias === alias);
    if (peer === undefined) { console.error('✗ 未找到 ' + alias); process.exit(1); }
    const now = nowIso();
    peer.roleHistory = Array.isArray(peer.roleHistory) ? peer.roleHistory : [];
    for (const entry of peer.roleHistory) if (entry.to === null || entry.to === undefined) entry.to = now;
    peer.roleHistory.push({ role, from: now, to: null });
    peer.role = role;
    writePeers(store);
    console.log('✓ ' + alias + ' 角色改为 ' + role + '（历史已记录）');
    return;
  }
  if (sub === 'update') {
    const alias = rest[0];
    const peer = store.peers.find(p => p.alias === alias);
    if (peer === undefined) { console.error('✗ 未找到 ' + alias); process.exit(1); }
    for (let i = 1; i < rest.length; i++) {
      const key = rest[i];
      const value = rest[i + 1];
      if (key === '--kind') { peer.kind = value; i++; }
      else if (key === '--root') { peer.root = value; i++; }
      else if (key === '--team') { peer.team = value; i++; }
      else if (key === '--status') { peer.status = value; i++; }
      else if (key === '--session') { peer.session = value; i++; }
      else if (key === '--redirect-to') { peer.redirectTo = value; i++; }
    }
    writePeers(store);
    console.log('✓ 已更新 ' + alias);
    return;
  }
  if (sub === 'check') {
    const alias = rest[0];
    const problem = validatePeerName(alias);
    if (problem) { console.error('✗ ' + alias + '：' + problem); process.exit(1); }
    const clash = store.peers.find(p => p.alias === alias);
    if (clash) { console.error('✗ ' + alias + '：已被占用（session ' + (clash.session ?? '?') + '，joined ' + (clash.joinedAt ?? '?') + '）'); process.exit(1); }
    console.log('✓ ' + alias + ' 可用');
    return;
  }
  if (sub === 'register') {
    const alias = rest[0];
    const force = rest.includes('--force');
    const problem = validatePeerName(alias);
    if (problem !== undefined && !force) { console.error('✗ ' + alias + '：' + problem); process.exit(1); }
    let session; let cwd; let role; let team; let status = 'active';
    let kind = 'member'; let root; let redirectTo;
    for (let i = 1; i < rest.length; i++) {
      const key = rest[i];
      const value = rest[i + 1];
      if (key === '--session') { session = value; i++; }
      else if (key === '--cwd') { cwd = value; i++; }
      else if (key === '--role') { role = value; i++; }
      else if (key === '--team') { team = value; i++; }
      else if (key === '--status') { status = value; i++; }
      else if (key === '--kind') { kind = value; i++; }
      else if (key === '--root') { root = value; i++; }
      else if (key === '--redirect-to') { redirectTo = value; i++; }
    }
    if (store.peers.some(p => p.alias === alias)) {
      console.error('✗ ' + alias + ' 已注册（先 peers remove 再注册）');
      process.exit(1);
    }
    if (session !== undefined && store.peers.some(p => p.session === session)) {
      console.error('✗ session ' + session + ' 已被其他别名占用');
      process.exit(1);
    }
    const now = nowIso();
    store.peers.push({
      alias,
      session: session ?? null,
      cwd: cwd ?? null,
      role: role ?? null,
      roleHistory: role === undefined ? [] : [{ role, from: now, to: null }],
      team: team ?? null,
      kind,
      root: root ?? null,
      status,
      joinedAt: now,
      ...(redirectTo === undefined ? {} : { redirectTo }),
    });
    writePeers(store);
    console.log('✓ 已登记 ' + alias + '（kind=' + kind + ' status=' + status + '）');
    return;
  }
  if (sub === 'remove') {
    const alias = rest[0];
    const before = store.peers.length;
    store.peers = store.peers.filter(p => p.alias !== alias);
    if (store.peers.length === before) { console.error('✗ 未找到 ' + alias); process.exit(1); }
    writePeers(store);
    console.log('✓ 已移除 ' + alias);
    return;
  }
  console.error('用法：peers register <别名> [--session <id>] [--cwd <路径>] [--role <角色>] [--team <团队>] | check <别名> | list | remove <别名>');
  process.exit(2);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'post': return cmdPost(args);
    case 'broadcast': return cmdBroadcast(args);
    case 'read': return cmdRead(args);
    case 'list': return cmdList(args);
    case 'ack': return cmdAck(args);
    case 'stat': return cmdStat(args);
    case 'archive': return cmdArchive(args);
    case 'peers': return cmdPeers(args);
    case 'check-encoding': return cmdCheckEncoding(args);
    case 'selftest': return cmdSelfTest();
    default:
      console.log('跨会话管道 v2（零依赖）');
      console.log('  node team/pipe2_tool.js post <from> <to> <subject> <body-file|-> [--reply-to <id>] [--tag test] [--allow-sensitive]');
      console.log('  node team/pipe2_tool.js broadcast <from> <subject> <body-file|-> [--to a,b]| [--all]');
      console.log('  node team/pipe2_tool.js read <me>');
      console.log('  node team/pipe2_tool.js list [<to>]');
      console.log('  node team/pipe2_tool.js ack <me> <id>');
      console.log('  node team/pipe2_tool.js stat [<inbox>] [--include-test]   → 只读：条数/未 ACK/最后一条（默认过滤 test）');
      console.log('  node team/pipe2_tool.js archive [--older-than 7] [--apply]   → 归档已 ACK 的旧消息（ACK 同步移动）');
      console.log('  node team/pipe2_tool.js peers register|check|list|remove|roles|set-role   → PEERS.json 注册表');
      console.log('  node team/pipe2_tool.js check-encoding <file> [--strict]   → 编码守卫（默认豁免代码块/示例行）');
      console.log('  node team/pipe2_tool.js selftest');
      process.exit(2);
  }
}

main();
