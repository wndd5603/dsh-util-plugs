#!/usr/bin/env node
// team_structure_check.js —— 团队目录结构守卫（零依赖）
// 用法：
//   node tools/team_structure_check.js --snapshot   # 记录当前目录树为基线
//   node tools/team_structure_check.js --check      # 比对基线，有增删目录则报错
//   node tools/team_structure_check.js --self-test  # 双向自测
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TEAM = path.join(ROOT, 'team')
const BASELINE = path.join(TEAM, '.structure_baseline.json')

function directoryTree(root) {
  const out = []
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir)) {
      const absolute = path.join(dir, entry)
      if (!fs.statSync(absolute).isDirectory()) continue
      const relative = prefix ? prefix + '/' + entry : entry
      out.push(relative)
      walk(absolute, relative)
    }
  }
  walk(root, '')
  return out.sort()
}

function runSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-check-'))
  fs.mkdirSync(path.join(root, 'team', 'members', 'a'), { recursive: true })
  const baseline = directoryTree(path.join(root, 'team'))
  fs.mkdirSync(path.join(root, 'team', 'members', 'b'), { recursive: true })
  const afterAdd = directoryTree(path.join(root, 'team'))
  const added = afterAdd.filter(dir => !baseline.includes(dir))
  const okAdd = added.length === 1 && added[0] === 'members/b'
  fs.rmSync(path.join(root, 'team', 'members', 'b'), { recursive: true, force: true })
  // Remove a directory that IS in the baseline so the reverse direction is real.
  fs.rmSync(path.join(root, 'team', 'members', 'a'), { recursive: true, force: true })
  const afterRemove = directoryTree(path.join(root, 'team'))
  const removed = baseline.filter(dir => !afterRemove.includes(dir))
  const okRemove = removed.length === 1 && removed[0] === 'members/a'
  fs.rmSync(root, { recursive: true, force: true })
  console.log((okAdd ? '✓' : '✗') + ' 正向：新增目录应检测到')
  console.log((okRemove ? '✓' : '✗') + ' 反向：删除目录应检测到')
  const ok = okAdd && okRemove
  console.log(ok ? '✓ 自测全部通过（exit 0）' : '✗ 自测失败（exit 1）')
  process.exit(ok ? 0 : 1)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return runSelfTest()
  const current = directoryTree(TEAM)
  if (args.includes('--snapshot')) {
    fs.mkdirSync(TEAM, { recursive: true })
    fs.writeFileSync(BASELINE, JSON.stringify({ dirs: current }, null, 2))
    console.log('✓ 已记录基线（' + current.length + ' 个目录）')
    return
  }
  if (!fs.existsSync(BASELINE)) {
    console.log('✗ 没有基线：先运行 node tools/team_structure_check.js --snapshot')
    process.exit(1)
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).dirs || []
  const added = current.filter(dir => !baseline.includes(dir))
  const removed = baseline.filter(dir => !current.includes(dir))
  if (added.length === 0 && removed.length === 0) {
    console.log('✓ 目录结构与基线一致（exit 0）')
    return
  }
  console.log('✗ 目录结构变更（需报备）')
  for (const dir of added) console.log('  + ' + dir)
  for (const dir of removed) console.log('  - ' + dir)
  process.exit(1)
}

main()
