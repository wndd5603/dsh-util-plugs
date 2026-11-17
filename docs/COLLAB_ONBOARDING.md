# 协作 onboarding：绑定候选与人工确认（2026-11-17）

> 适用范围：`packages/dsh-agent-apartment`。
> 工具：`apartment_binding_candidates`（只读）、`apartment_agent_bind`/`apartment_agent_unbind`、`alias_register`（session-network）、`apartment_collaboration_brief`、`apartment_bind_drift_check`。
> 原则：**先候选、后人工确认、再单条绑定**；不自动猜、不批量绑定、不把 cwd 当身份证据。

## 1. 三个写入口的边界

| 工具 | 作用 | 何时用 | 不做什么 |
|---|---|---|---|
| `apartment_binding_candidates` | 只读列出未绑定 live/idle session 与未绑定 agent 的候选匹配、置信度和理由 | 任何新 session/新 agent 需要接入公寓时，先看候选 | 不 bind、不写 alias/route、不改任何库 |
| `apartment_agent_bind` | 写 `agent_sessions`，建立 agent↔session 映射 | 人工已确认某个 `agentId` 与某个 `sessionId` 是同一身份 | 不写 alias、不写 session-network、不自动选候选 |
| `alias_register` | 写 session-network 的 alias/route | 需要可路由的别名，且身份证据已复核 | 不是 bind 的前置条件；禁止为“凑证据”而注册 alias |

`apartment_agent_bind` 的权限：绑定调用者自己的 session 不需要提权；绑定其他 session 需要 `danger-full-access`。session 必须能被 `agents.get(sessionId)` 解析（live），否则 `SESSION_NOT_FOUND`。

`alias_register` 属于 session-network，不属于 apartment。需要 alias 时先 `dryRun` 预览，再由人确认；不要批量注册 26 个 agent 的 alias。

## 2. 候选置信度语义

`apartment_binding_candidates` 返回：

```js
{
  ok, sessions: [{ sessionId, displayName, alias, cwd, status, candidates }],
  unboundAgents: [{ agentId, agentName, status, candidates }],
  counts, warnings, asOf
}
```

每个 candidate 为 `{ agentId, agentName, confidence, reason }`。

| confidence | 判据 | 处理建议 |
|---|---|---|
| `exact` | active network alias 或 header alias 与 agent id/name 完全相同；或 session `displayName` 与 agent id 完全相同 | 仍需人工确认，但优先核对 |
| `normalized` | alias 与 agent id/name，或 displayName 与 agent id 在“小写 + 去空格/连字符/下划线”后相等 | 核对命名差异来源后再确认 |
| `low` | 只有 `displayName` 与 `agent.name` 相等（含归一后相等；名字不唯一） | 不能单独作为绑定证据 |
| `ambiguous` | 基于 name 的匹配，且有多个 agent 同名 | 必须显式指定 `agentId`，不得自动选 |

不匹配的 session 不返回 candidate；没有候选时 `candidates: []`，不是错误。

`ambiguous` 只用于“基于名字”的命中；如果 active alias 精确等于 agent id（唯一键），即使另有同名 agent，也不会把该精确命中降级为 ambiguous。反之，只要命中依赖 name 且存在同名 agent，就必须由人显式选择 `agentId`。

**cwd 只作为上下文返回，不参与匹配。** 相同 cwd 不是同一身份的证据。`status` 来自 live agent/网络 session 状态（`active`/`running` 归一为 `live`），列表上限为 50（`counts.limit`），超出时 `counts.truncated=true`。

## 3. 禁止事项（P0）

- 禁止批量猜绑定：当前 25 个无 live session 的 agent 保持 unbound，不唤醒、不批量 bind。
- 禁止用 `displayName` 或 cwd 单独自动 bind；`low` 只作线索。
- 禁止在候选阶段写 `agent_sessions`、alias、route、task_roles、experiences。
- 禁止为“让候选看起来匹配”而改 agent name 或注册 alias；身份证据必须来自实际运行中的 session。
- 禁止用候选结果自动选 `ambiguous` 的任一个 agent。

## 4. Live 更新步骤（单条）

1. **看候选**：调用 `apartment_binding_candidates`，确认目标 session 出现在 `sessions` 中、目标 agent 出现在 `unboundAgents` 中。
2. **验 live**：确认 session 仍可解析（`apartment_agent_bind` 会再次校验；`SESSION_NOT_FOUND` 就停止）。
3. **人工确认**：把 `sessionId`、`agentId`、`confidence`、`reason` 一起给人看；`low`/`ambiguous` 必须显式选择。
4. **单条绑定**：`apartment_agent_bind({ agentId, sessionId?, isPrimary? })`。`sessionId` 省略时绑定调用者自己的 session；绑定他人 session 需 operator。
5. **需要路由名时**：另走 `alias_register`（先 `dryRun`，人工确认后正式写）。不要因为 bind 成功就自动注册 alias。
6. **验收**：
   - `apartment_collaboration_brief({ sessionId })`：`ok=true`、`agentId` 正确、alias `routeResolvable=true`、无未解释 warning。
   - `apartment_bind_drift_check()`：`issues` 为空；若出现 `SESSION_NOT_FOUND`/`ALIAS_UNRESOLVED`/`ALIAS_SESSION_MISSING`，停止继续写并排查。
   - 再次调用 `apartment_binding_candidates`：该 session 和该 agent 已从 unbound 列表消失，`counts.boundSessions`/`counts.boundAgents` 各 +1。
7. **回滚**：只解绑该条 `apartment_agent_unbind({ agentId, sessionId })`；不删除 alias/route、不删除历史 task_roles/experiences。

当前 live 基线（2026-11-17）：1 个 live session（`env-captain`）已绑定 `legacy-env-captain`；3 个 idle session 与 25 个无 session agent 保持 unbound；不拉起全部 agent。详见 `docs/publish/COLLAB_ONBOARDING_PLAN_20261117.md`。

## 5. 测试与验收

在本仓库运行：

```powershell
node --check packages/dsh-agent-apartment/index.js
node --check packages/dsh-agent-apartment/src/collab.js
Set-Location packages/dsh-agent-apartment
node --test
```

> 注意：Node 24 在仓库根执行 `node --test packages/dsh-agent-apartment` 只把目录当作一个条目；
> 必须进入包目录执行 `node --test`（或显式列出 test 文件）。

`test-collab-onboarding.mjs` 覆盖：

- `exact`：network alias→agent id、header alias→agent id、displayName→agent id；
- `normalized`：`Agent_Foo-Bar` ↔ `agent-foo-bar`（displayName 与 alias 两条路径）；
- `low`：仅 `displayName` 与 `agent.name` 同名；
- `ambiguous`：两个 agent 同名，均标 `ambiguous`，不自动选；
- unbound session：无匹配时返回空 candidates；
- 已绑定排除：bound session/agent 不出现在候选列表；
- 只读：`PRAGMA data_version` 与 apartment DB/WAL、network DB 的 sha256 前后不变，`agent_sessions`/alias 计数不变；
- 上限：51 个 session/agent 时各返回 50，`truncated=true`。

验收口径：候选调用只读；bind 只写 `agent_sessions`；alias 写入只经 `alias_register`；brief/drift 通过后才算 onboarding 完成。

## 6. 边界

- 本次只改 `packages/dsh-agent-apartment` 源码、测试与本文档；未 commit、未 vendor、未重启宿主。
- 源码测试通过不代表 live 已生效：需要宿主所有者按发布流程同步/重载后，再用真实 `apartment_binding_candidates` 复核。
- 默认不 tag、不 release。
