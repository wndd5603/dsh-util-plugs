# dsh-workbench-bundle — 一体化工作台

One-install starter bundle for the DeepSeek Harness agent workbench: context awareness, workflow presets and team collaboration with a read-only status overview.

DeepSeek Harness 智能体工作台的一体化起步插件包：上下文感知、工作流预设与团队协作，并提供只读状态总览。

> Version: 2026.11.4-1 · Not yet published on npm; install from GitHub.

## English

### What's included

- Context awareness and a context-discipline preset.
- Workflow presets for team coordination and prompt iteration.
- Team collaboration: session network and a local message bus.
- `workbench_status()` — one read-only overview of versions, health and enabled features, plus a first-turn capability pointer.

Example:

```text
workbench_status()
→ versions, feature switches, health and next steps in one call
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

The bundle adds eight plugins; enable `workbench-bundle`. Do not install the individual component bundles alongside it. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-workbench-bundle`.

### Usage

Call `workbench_status()` after restart to see the installed components and their health. The first-turn pointer explains the available capabilities once.

### Configuration

Toggle the status tool and the first-turn pointer; component features keep their own conservative defaults.

### Permissions, compatibility & privacy

- Reads local profile metadata only; no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Local-first; uninstall removes the plugin entries but leaves local data.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 包含内容

- 上下文感知与上下文纪律预设。
- 面向团队协作与提示词优化的工作流预设。
- 团队协作：会话网络与本地消息总线。
- `workbench_status()`：一次只读调用查看版本、健康状态与已启用功能，并提供首轮能力指引。

示例：

```text
workbench_status()
→ 一次返回版本、功能开关、健康状态与下一步
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

安装包会加入 8 个插件项；启用 `workbench-bundle`。不要与组件包同时安装。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-workbench-bundle`。

### 使用

重启后调用 `workbench_status()` 查看已安装组件与健康状态；首轮能力指引只出现一次。

### 配置

可开关状态工具与首轮能力指引；各组件保留自己的保守默认值。

### 权限、兼容与隐私

- 仅读取本地 profile 元数据；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 本地优先；卸载会移除这些插件项，但保留本地数据。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
