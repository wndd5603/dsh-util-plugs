# dsh-plugin-console — 插件控制台 / Plugin Console

A unified plugin console for the DeepSeek Harness Web client: one sidebar entry to inspect installed plugins, status, live configuration forms and extension contributions.

为 DeepSeek Harness Web 客户端提供统一插件控制台：一个左栏入口，集中查看已安装插件、状态、实时配置表单与插件扩展贡献。

> Status: independent client plugin; also included as the eighth plugin in the `dsh-util-plugs` package.

## English

### What it adds

- **One sidebar entry** —「插件控制台」/ Plugin Console (`sidebar.panellist`, id `plugin-console`) with a full-width main panel.
- **Plugin cards** — installed/enabled/disabled/installable groups, search and filters, a `NEW` badge for newly discovered plugins, pagination and a cached first paint.
- **Status & deep links** — enabled state, lifecycle phase, plugin error, read-only reason; open the native plugin manager page or a plugin detail directly.
- **Live config forms** — schema-driven forms for volatile settings; non-editable fields stay read-only and point to the native config page.
- **Plugin extensions** — a client-side `pluginConsoleContributions` registry lets other plugins add status, actions or custom panels to a detail tab; a throwing contribution is isolated.

Example: open the left sidebar, search for a plugin, open its detail, review **Config / Status / Plugin Extensions / About**, or use the deep link to the native plugin manager.

### Install (independent client plugin)

This package is also the eighth plugin (`plugin-console`) in `dsh-util-plugs`. Installing that package provides the console; this package can also be installed independently.

Local package (the pattern used for the current machine install):

```sh
dsh plugin --profile web add <path-to-packages/dsh-plugin-console>
```

From GitHub (once this package is published as an independent repository):

```sh
dsh plugin --profile web add github:wndd5603/dsh-plugin-console
```

After adding it, restart/refresh the DSH Web UI and look for the「插件控制台」entry in the left sidebar. Do not add the same client plugin twice.

**Current machine state:** the live web profile has this plugin installed as an independent client plugin; `dsh-util-plugs` 2026.11.5-7 also includes it as the eighth plugin.

### Configuration, permissions & privacy

- No required configuration; the console is read-only by default.
- It requires permission to read plugin bundles/inventory; without it the entry is not registered.
- Saving is available only when the host marks the setting writable; secret values are never displayed or edited.
- The first-paint cache is local (`localStorage`, key `dsh.plugin-console.cache.v1`) and stores only whitelisted namespaces — no secret descriptors and no credentials.
- Extension contributions render in a client-side trust boundary; a failure in one contribution shows an error row and does not break the page.

### Boundaries

- **Not an installer.** It never installs, uninstalls, updates or enables plugins; cards and buttons deep-link to the native plugin manager, which remains the only write path.
- **Client-only UI.** No host Remote or arbitrary command/script execution.
- **Also included in the package.** `dsh-util-plugs` includes this console as the eighth plugin; it can also be installed independently.

### Development

```sh
npm run build   # lib/client.js
npm test        # build + syntax check + unit tests
```

### Uninstall / rollback

Back up the profile first. Then remove the plugin and restart:

```sh
dsh plugin --profile web remove dsh-plugin-console
```

If the UI does not return to the previous state, restore the profile backup. Removing the console does not remove the eight-plugin package or other plugins.

### License

MIT (package metadata)

## 中文

### 为 DSH 带来什么

- **左栏入口**：「插件控制台」（`sidebar.panellist`，id `plugin-console`）与整宽主面板。
- **插件卡片**：已启用/已禁用/可安装分组、搜索与筛选、新插件 `NEW` 角标、分页与首屏缓存。
- **状态与深链**：启用状态、生命周期阶段、插件包错误、只读原因；可直达原生插件管理器或单个插件详情。
- **实时配置表单**：按 schema 生成 volatile 字段表单；不可编辑字段保持只读并提示前往原生配置页。
- **插件扩展**：客户端 `pluginConsoleContributions` registry，其他插件可在详情「插件扩展」tab 注册状态、操作或自定义面板；单个贡献抛错会隔离显示。

示例：打开左栏，搜索插件，进入详情查看 **配置 / 状态 / 插件扩展 / 关于**，或使用深链跳到原生插件管理器。

### 安装（独立客户端插件）

本包也是 `dsh-util-plugs` 的第 8 个插件项（`plugin-console`）：安装该安装包即可获得控制台，也可以独立安装本包。

本地包（当前机器采用的独立安装方式）：

```sh
dsh plugin --profile web add <path-to-packages/dsh-plugin-console>
```

从 GitHub 安装（本包作为独立仓库发布后）：

```sh
dsh plugin --profile web add github:wndd5603/dsh-plugin-console
```

加入后重启/刷新 DSH Web UI，在左栏查找「插件控制台」入口；不要重复添加同一个客户端插件。

**当前机器状态**：本机 web profile 已作为独立客户端插件安装；`dsh-util-plugs` 2026.11.5-7 也已将本插件作为第 8 个插件项收录。

### 配置、权限与隐私

- 无需必填配置；控制台默认只读。
- 需要读取插件包与清单的权限；无权限时整个入口不注册。
- 仅当宿主标记该配置可写时才允许保存；secret 值不显示、不编辑。
- 首屏缓存仅保存在本地（`localStorage`，key `dsh.plugin-console.cache.v1`），只存白名单 namespace，不存 secret 描述符/凭据。
- 插件扩展渲染在客户端信任边界内；单个贡献失败只显示错误行，不影响页面。

### 边界

- **不是安装器**：不执行安装/卸载/更新/启停；卡片与按钮深链到原生插件管理器，原生页面仍是唯一写入口。
- **仅在客户端运行**：不提供宿主服务，也不执行任意命令或脚本。
- **也包含在安装包中**：`dsh-util-plugs` 将本控制台作为第 8 个插件项，也可独立安装。

### 开发

```sh
npm run build   # lib/client.js
npm test        # 构建 + 语法检查 + 单元测试
```

### 卸载 / 回滚

先备份 profile，再移除并重启：

```sh
dsh plugin --profile web remove dsh-plugin-console
```

若 UI 未回到预期状态，恢复 profile 备份。移除控制台不会删除包含八个插件的整个安装包或其他插件。

### 许可证

MIT（package metadata）
