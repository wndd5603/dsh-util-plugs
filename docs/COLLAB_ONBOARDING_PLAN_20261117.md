# 协作数据更新决策：是否需要拉起全部 Agent（2026-11-17）

## 结论

**不需要拉起全部 26 个 Agent，也不应批量更新。**

原因：新规则要求身份映射有证据（agent_id ↔ live session ↔ alias），而当前：

- live/joined session：**1**（`env-captain`，已绑定 `legacy-env-captain`）。
- apartment agents：26；其中 **25 个没有 live session 证据**。
- idle host sessions：3 个（`session-33a1...`、`session-33947951...`、`session-5f9f2b83...`），但 apartment 侧没有可判定的 agent 映射。
- 22+ 个 apartment agent 是 legacy/迁移导入；强制唤醒会产生“假绑定”。
- task_roles：仅 1 条孤儿测试行；没有真实任务角色可批量回填。
- experiences：3 条测试残留；不能当真实经验回填。
- aliases：仅 1 个 active route 与当前 agent 匹配；其余 25 个无路由证据。

因此，批量拉起 = 制造 25 份无证据身份，违反“确认事实”和“不伪造数据”。

## 何时需要更新

只有同时满足：

1. 存在 live/idle session；
2. 有可复核的映射证据（alias 精确、displayName 精确、或 agent_id 显式指定）；
3. 绑定/角色/经验写入有操作者或证据；
4. 写入后能通过 brief/drift 验证。

才执行单条更新；不满足则保持 unbound 并在 brief/drift 中显示。

## 能力规划

| 能力 | 作用 | 状态 |
|---|---|---|
| C1 `apartment_binding_candidates` | 只读列出未绑定 session/agent 的候选匹配与置信度，辅助人工确认 | 本轮实现 |
| C2 `apartment_agent_bind/unbind` | 显式绑定/解绑，禁止自动猜 | 已实现 |
| C3 `alias_register` | 路由权威写入；apartment 只读反查 | 已存在 |
| C4 `apartment_task_role_assign` | 真实任务角色绑定，校验 task/board/agent/team | 已实现 P1 |
| C5 `apartment_experience_record` | 必填 task/outcome；旧数据只告警 | 已实现 P1 |
| C6 brief/drift | 绑定后召回与漂移诊断 | 已实现 |
| C7 UI 绑定/角色列 | 人工可视化 | 后续 P2 |

## 执行计划

1. 部署/验证 C1（只读候选；不写库）。
2. 对当前 live 会话：已绑定 `legacy-env-captain`，brief 1 team/1 role/1 alias/3 tasks。
3. 对 3 个 idle session：不自动绑定；等它们下次运行且提供身份证据时再候选/绑定。
4. 对 25 个无 session agent：保持 unbound；等有 live session 或用户明确要求时处理。
5. 不批量回填 task_roles/experiences/aliases；不删除旧数据。
6. 验收：candidates 只读；brief/drift 0 未解释 issue；不 tag/release。

## 边界

- 不自动唤醒/拉起全部 agent。
- 不自动绑定、不自动改 alias/route、不批量写 task_roles/experience。
- 不 tag、不 release。
