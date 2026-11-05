#!/usr/bin/env node
// team_minutes_new.js —— 会议纪要骨架生成（零依赖）
// 用法：
//   node tools/team_minutes_new.js --topic "<议题>" [--type decision|standup]
//        [--members a,b] [--start "YYYY-MM-DD HH:MM"] [--self-test]
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function pad(n) { return String(n).padStart(2, '0') }
function stamp(date) {
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '_'
    + pad(date.getHours()) + pad(date.getMinutes())
}

function skeleton(topic, type, members, start) {
  return '# 会议纪要：' + topic + '\n\n'
    + '- 时间：' + start + ' → （未结束）\n'
    + '- 类型：' + (type === 'decision' ? '决策会' : '立会') + '\n'
    + '- 参与：' + members.join('、') + '\n\n'
    + '## 一、结论\n\n1. （待填）\n\n'
    + '## 二、分歧与未决\n\n| 项 | 状态 | 责任人 | 截止 |\n|---|---|---|---|\n\n'
    + '## 三、行动项\n\n| # | 动作 | 负责人 | 验收 |\n|---|---|---|---|\n\n'
    + '## 四、证据\n\n（命令 / 链接 / 行号）\n'
}

function parseArgs(args) {
  const options = { topic: '', type: 'standup', members: [], start: '', selfTest: args.includes('--self-test') }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--topic') { options.topic = args[index + 1] || ''; index += 1 }
    else if (args[index] === '--type') { options.type = args[index + 1] || 'standup'; index += 1 }
    else if (args[index] === '--members') { options.members = (args[index + 1] || '').split(',').filter(Boolean); index += 1 }
    else if (args[index] === '--start') { options.start = args[index + 1] || ''; index += 1 }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-new-'))
    const file = path.join(dir, 'MINUTES.md')
    fs.writeFileSync(file, skeleton('自测议题', 'decision', ['captain', 'builder'], '2026-01-01 10:00'))
    const text = fs.readFileSync(file, 'utf8')
    const ok = text.includes('自测议题') && text.includes('决策会') && text.includes('## 三、行动项')
    fs.rmSync(dir, { recursive: true, force: true })
    console.log((ok ? '✓' : '✗') + ' 正向：骨架含议题/类型/行动项')
    const okMissing = !skeleton('', 'standup', [], '').includes('undefined')
    console.log((okMissing ? '✓' : '✗') + ' 反向：缺参数不应出现 undefined')
    const pass = ok && okMissing
    console.log(pass ? '✓ 自测全部通过（exit 0）' : '✗ 自测失败（exit 1）')
    process.exit(pass ? 0 : 1)
  }
  if (!options.topic) {
    console.error('用法：node tools/team_minutes_new.js --topic "<议题>" [--type decision] [--members a,b] [--start "YYYY-MM-DD HH:MM"]')
    process.exit(2)
  }
  const now = new Date()
  const start = options.start || now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
  const folder = path.join(ROOT, 'team', 'meetings', stamp(now))
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, 'MINUTES.md')
  fs.writeFileSync(file, skeleton(options.topic, options.type, options.members, start))
  console.log('✓ 已生成 ' + path.relative(ROOT, file))
}
