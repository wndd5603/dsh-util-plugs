# Clean Profile 全模块召回测试结果（2026-11-17）

## 环境

- `DSH_HOME=E:/work/tests/clean-recall-20261117/home`
- profile `e2e-recall`，从 shipped `web` 模板重建
- host `http://127.0.0.1:13088`，隔离 workspace
- 包版本 `2026.11.17-1`；client sha256 与 release 一致
  `6B7854B7D4823281A4C6C6DF352688B3C3A2CB34C5ADACDC55CCC4AE1132DC26`
- clean 安装副本 11 rows；boot entries 73，含 `dsh-util-plugs`

## 结果

| 层 | 检测 | 结果 |
|---|---|---|
| L0 静态 | client hash / 11 rows / SCAFFOLD / CLIENT | PASS |
| L1 单测 | memory 16、apartment 23、bulletin 22、message 88、team-bus 192、auto-backup 76、restart 17、workbench 10、plugin-console 14、team-hooks2 selftest 17 | PASS |
| L2 clean UI 注册 | 两入口可见、boot entries、console error=0 | PASS |
| L2 clean UI 数据 | 有 board fixture 时 Agent Hub 仍显示 0 boards | **WARN**（未确认是否因 clean 无 live 会话） |
| L2 clean agent 工具 | 让 clean agent 调 bind/brief/memory | **WARN/ENV**：`MISSING_CREDENTIAL`，clean profile 无 LLM key |
| L3 clean DB 召回 | 直接调用包模块 + clean DB：brief 2 teams/2 roles/1 alias/1 task/1 task role/1 exp/warnings 0；memory 3 合规 + 1 旧格式 8 issues | **PASS** |
| L4 降级 | 未绑定/无 network/bulletin、非法 board/task、operator 拒绝 | PASS（单测 + 复核） |
| L5 live 隔离 | 测试只写 clean HSH_HOME；未写 live DB | PASS |

## 关键证据

- clean UI：
  ```text
  boot.entries=73
  hasPlug=true
  collab=1
  pluginConsole=1
  errors=[]
  ```
- fixture brief：
  ```text
  agent=agent-alpha
  teams=2 (team-one/lead, team-two/builder)
  roles=2
  aliases=1 (alpha-test, routeResolvable=true)
  tasks=1 (task-fixture-1)
  taskRoles=1 (task-fixture-1/team-one/lead)
  experiences=1 (PASS)
  warnings=0
  ```
- memory：`recall/project/team-policy`、`agent/alpha/role`、`team/one/charter` 合规；`legacy-note` 8 issues（预期旧格式告警）。

## 结论

- 安装、11 行、client、双入口、包级记忆/角色/团队/任务/经验召回均通过。
- **未发现 P0/P1 产品缺陷。**
- 两个 WARN 是测试环境/待确认：
  1. clean profile 无 LLM credential，无法通过 agent 实际调用工具；
  2. 有 board fixture 时 Agent Hub 仍显示空数据，需在有 live 会话/凭据的 clean profile 复验，不能据此判定产品 bug。
- 未修改产品源码；未 tag/release。

## 下一步（若继续）

- 用本地模型或临时 credential 让 clean agent 真实调用 `apartment_collaboration_brief`/`memory_search`。
- 若空数据在真实 clean 会话下复现，再按“面板无会话数据加载”缺陷分派修复。
