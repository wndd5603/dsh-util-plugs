#!/usr/bin/env node
// team_member_audit.js —— 成员规范体检（零依赖）
// 用法：node tools/team_member_audit.js [--self-test]
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SECTIONS = ['你是谁', '写范围', '六项回报义务', '上下文纪律', '禁止事项', '文件夹权限']

function audit(root) {
  const membersDir = path.join(root, 'team', 'members')
  const problems = []
  const members = []
  if (!fs.existsSync(membersDir)) {
    problems.push('缺少 team/members/ 目录')
    return { members, problems }
  }
  for (const entry of fs.readdirSync(membersDir)) {
    const absolute = path.join(membersDir, entry)
    if (!fs.statSync(absolute).isDirectory()) continue
    members.push(entry)
    const agentsFile = path.join(absolute, 'AGENTS.md')
    if (!fs.existsSync(agentsFile)) {
      problems.push(entry + '：缺少 AGENTS.md')
      continue
    }
    const content = fs.readFileSync(agentsFile, 'utf8')
    for (const section of SECTIONS) {
      if (!content.includes(section)) problems.push(entry + '：AGENTS.md 缺少「' + section + '」')
    }
    if (!fs.existsSync(path.join(absolute, 'scratch'))) problems.push(entry + '：缺少 scratch/')
  }
  return { members, problems }
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-audit-'))
  const good = path.join(root, 'team', 'members', 'good')
  fs.mkdirSync(path.join(good, 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(good, 'AGENTS.md'), SECTIONS.map(s => '## ' + s).join('\n'))
  const goodResult = audit(root)
  console.log((goodResult.problems.length === 0 ? '✓' : '✗') + ' 正向：合规成员应通过')
  const bad = path.join(root, 'team', 'members', 'bad')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'AGENTS.md'), '## 你是谁')
  const badResult = audit(root)
  console.log((badResult.problems.length > 0 ? '✓' : '✗') + ' 反向：缺段应报错（' + badResult.problems.length + ' 项）')
  fs.rmSync(root, { recursive: true, force: true })
  const ok = goodResult.problems.length === 0 && badResult.problems.length > 0
  console.log(ok ? '✓ 自测全部通过（exit 0）' : '✗ 自测失败（exit 1）')
  process.exit(ok ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const result = audit(ROOT)
  if (result.problems.length > 0) {
    console.log('✗ ' + result.problems.length + ' 个问题（成员 ' + result.members.length + '）')
    for (const problem of result.problems) console.log('  - ' + problem)
    process.exit(1)
  }
  console.log('✓ 成员 ' + result.members.length + ' 个，规范全部通过（exit 0）')
}
