# 干净 Profile 全模块召回测试计划（2026-11-17）

## 0. 精确事实（当前候选）

- 包：`dsh-util-plugs@2026.11.17-1`；11 rows（`cordis.patch.yml`）。
- 行：context-sentinel、message-bus、bulletin-board、agent-apartment、agent-memory、team-bus、agent-workflows、workbench-bundle、auto-backup、host-relaunch、plugin-console。
- Web：1 shared client（3 halves；Agent Hub / Restart / Plugin Console）。
- 数据源：apartment.sqlite、memory.sqlite、board.sqlite、bus.sqlite、network.db、file_backups、audit JSONL。
- Clean 流程：隔离 DSH_HOME + profile `e2e-recall`；`file:` 安装；删 node_modules/pnpm-lock 后重装；client sha256 比对；`node apps/cli/lib/bin.js e2e-recall --port 13088 --no-open`（不能用 `dsh web`）。

## 1. 检测项（覆盖矩阵）

| 模块 | 检测项 | 证据 |
|---|---|---|
| 安装/打包 | 11 rows、0 npm deps、client 3 halves、verify | SCAFFOLD/CLIENT |
| context-sentinel | context meter、team-hooks2 归档/记忆提醒、stateFile、role/write gate | package tests + live status |
| message-bus | send/queue/read/route/audit/pending reminder/strict | 88 tests + clean UI |
| bulletin-board | boards/tasks/CAS/digest/team-role metadata | 22 tests + clean UI |
| agent-apartment | agents/teams/memberships/task_roles/leases/experiences/bind/brief/candidates | 23 tests + clean brief |
| agent-memory | remember/search/list/quality/digest/scopes | 19 tests + fixture |
| team-bus | aliases/meetings/digest/stale/network | 181 tests + clean UI |
| agent-workflows | Coordinator/Prompt Studio/team role workflow | package tests |
| workbench | pointer/status | 10 tests + first-turn |
| auto-backup | backup/retention/verify/status | 76 tests |
| host-relaunch | status/step1/step2 refusals/session resume | 17 tests (不真实重启 clean) |
| plugin-console | cards/config/client bundle | package tests + clean UI |

## 2. 召回场景（重点）

| 场景 | 测试数据 | 断言 |
|---|---|---|
| 记忆召回 | 3 条有效 + 1 条旧格式 | search 命中；digest counts/quality；list 分页 |
| 多团队角色 | agent-alpha 在 team-one(lead)+team-two(builder) | brief teams=2/roles=2；不串团队 |
| TaskRole | 真实 bulletin task + agent/team/role | assign 成功；orphan 拒绝；brief taskRoles/taskTitle |
| 身份/别名 | agent-alpha 绑定 session + alias | brief routeResolvable；candidates 不含已绑定 |
| 任务召回 | task 指派 alpha alias | brief assignedTasks 命中；不可解析 alias 告警 |
| 未绑定 | session-x 无 binding | brief UNBOUND_SESSION；不自动注入 |
| 降级 | 无 network/bulletin DB | brief 返回 warnings/空，不崩 |
| 只读 | brief/binding_list/drift | data_version/hash 不变；不触发 lease reap |

## 3. 测试层次

1. **L0 静态**：SCAFFOLD/CLIENT、11 rows、client sha。
2. **L1 单元/契约**：各 package `node --test`，记录真实 counts。
3. **L2 召回夹具**：临时 DSH_HOME 的 Node 脚本，构造 memory/apartment/bulletin/network 数据，断言 brief/search/roles/candidates。
4. **L3 干净 Host**：全新 profile 安装、boot、Playwright 检查双入口、Agent Hub、Plugin Console、console error=0。
5. **L4 失败/降级**：未绑定、无 DB、非法 task/board、非 operator。
6. **L5 回归**：只读 live DB 不被测试污染。

## 4. 判定

- PASS：L0–L3 全过，L4 预期错误正确，L5 live 无写入。
- WARN：环境限制（不真实重启、无 clean LLM）但单测覆盖。
- FAIL：任何 P0/P1、数据损坏、权限绕过、面板不可用。
