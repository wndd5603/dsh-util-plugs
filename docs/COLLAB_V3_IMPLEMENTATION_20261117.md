# 协作系统 v3 实施与验收（2026-11-17）

## 1. 交付

dev 提交：`4704aa4 feat: add agent-session identity and collaboration brief`
（在 `c451178` 之后；只推 dev，未 tag/release）

### P0
- `agent_sessions(agent_id, session_id, is_primary)`，UNIQUE session_id + partial unique primary。
- 工具：`apartment_agent_bind` / `apartment_agent_unbind` / `apartment_binding_list` / `apartment_bind_drift_check` / `apartment_collaboration_brief`。
- brief 只读：不触发 lease reap；home basename；teams/roles/aliases/tasks/leases/experiences 限额；asOf/warnings/text；aliases 实时反查 session-network，不做可写副本。
- pre-step：仅已绑定 session 注入 1 行；未绑定跳过；读失败显式 unavailable；每 session 一次（同时检查 first.messages 历史，V6 已修）。

### P1
- `task_roles` 增加 `board_id`、`verified`（ALTER 兼容）；assign 校验 agent/team/task，operator 门禁，board 不一致 -> TASK_BOARD_MISMATCH；task 库不可用 -> TASK_STORE_UNAVAILABLE（allowUnverified 显式降级）。
- `apartment_team_task_list` 从 task_roles 派生，不建 team_tasks 冗余表。
- membership add/remove 校验 ghost；remove changes 不再谎报。
- experience 新写入必填 taskId/outcome；旧 3 条保留但 brief 标 INVALID_EXPERIENCE。
- brief 增加 taskTitle/boardId、ORPHAN_TASK_ROLE、TASK_UNVERIFIED、aliases cap 20。

## 2. 验证

- apartment：`node --test` **19/19 pass**；`node --check` 9/9。
- 独立复核（`COLLAB_V3_P0P1_VERIFY.md`）：V6 修复有效；只读 data_version/WAL/bulletin/network hash 不变；最终修复 D1/E1/D2/E2/T1。
- live：
  - bind `session-3efe...` → `legacy-env-captain`，is_primary=1；
  - brief：1 team (`legacy-team`, role `legacy-member`)、1 alias (`env-captain`, routeResolvable=true)、3 assigned tasks、0 leases、0 experiences、0 warnings；
  - binding_list / drift：1 binding / 26 agents / 1 session / 1 alias，0 issue；
  - 自动注入出现 `[collab] agent=legacy-env-captain teams=1 ...`。
  - live schema：agent_sessions 1 行；task_roles 有 board_id/verified；旧 task-1 保留。

## 3. 保留/未做（明确）

- 只绑定当前会话，**未批量绑定 26 agents**（无证据，不猜）。
- 旧 `task-1` 孤儿 task_role、3 条 invalid experience 保留；brief 告警，不删除。
- 未建 team_tasks；团队任务由 task_roles 派生（无法表达“团队认领但未指派 agent”）。
- 未自动写 alias/route；alias 权威仍是 session-network；brief 只读诊断。
- 未提供 task role/team 的 UI 详情列；API/brief 已可用。
- 未实现 lease fencing/heartbeat、Workspace 多映射、SkillPack。

## 4. 结论

- 原始规则中“Agent↔Session/Alias 身份映射”从 0/26 提升到可显式绑定、可只读召回；不再靠名字猜。
- TaskRole 从孤儿旁路变为可校验/可查询/有 board 一致性；旧数据不伪造清理。
- 召回从“只有摘要”增加 “Collaboration Brief 实体层”；绑定后自动注入 1 行，任务开始可显式调用。
- 剩余为 P2/后续：UI、team_tasks 语义、fencing、历史数据治理。
