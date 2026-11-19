# dsh-plugin-updater

> 让 dsh 的插件保持最新，并且**让本地开发的插件改完就能生效——不用重启 Harness**。

[![npm](https://img.shields.io/npm/v/dsh-plugin-updater.svg)](https://www.npmjs.com/package/dsh-plugin-updater)
[![license](https://img.shields.io/npm/l/dsh-plugin-updater.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-plugin-updater.svg)](./package.json)

让 dsh 的插件保持最新，并且**让本地开发的插件改完就能生效——不用重启 Harness**。

## 它解决的两个问题

### 1. npm 装的插件：装完就再也没人告诉你有没有新版

插件管理页回答的是「装了什么」，不是「有什么可装」。这个插件直接问 registry，
把「已装版本 vs 最新版本」摆出来。

因为**替换正在运行的代码**不该是后台替你做的决定，所以 `autoUpdateRegistry` 默认
**关闭**：默认只检查、只报告，装不装由你决定。打开它，才会在后台自动安装。

### 2. 本地开发的插件：改一行代码就得重启整个 Harness

本地开发时插件以 `link:` 依赖装进 profile，`node_modules` 指向你的工作目录。
**但没有任何东西在盯着那个目录**：profile 里 `hmr` 那一行的配置是 `root: []`，
模块文件根本没被监听，只有 `cordis.patch.yml` 和 `package.json` 被监听。

原因是 Node 的 ESM 模块缓存**按 URL 缓存，永不重读文件**。`ctx.loader` 走的也是同一套缓存，
所以「改完重新 import 一次」拿到的是**旧的模块对象**——这就是为什么以前只有重启才可靠。

这个插件补上这一段：监听 profile 已经指向的那些目录，一有改动就

1. 把这些插件在**运行中的 Node 模块缓存**里逐条删掉（`Map.prototype.delete.call(loadCache, url)`，
   Node 24+ 的 `LoadCache` 自带的 `delete` 只清类型槽位，不能删干净）；
2. 顺带清掉 CJS 那一份 `require.cache`；
3. 重新 `import()` —— 这一次会真的从磁盘读；
4. 停掉旧 fiber，用**原样的 config** 激活新模块，再把新 fiber 放回 loader 期望的位置。

同一进程、同一 profile、拿到新代码。插件的配置不会丢，loader 里的身份也不会丢。

**改坏了也能救回来**：如果新代码抛错，旧模块图会被恢复、旧插件对象会被重新激活，
Host 保持改动前的样子——一次坏编辑不会把插件弄挂。

## 怎么用

装好之后有一个工具 `plugin_update`：

| action | 做什么 |
|---|---|
| `status` | 列出每个插件的类型（registry / 本地开发 / tarball / git）、已装版本、有没有新版、本地插件上次刷新结果 |
| `check` | 立刻重新问 registry（**只读网络，不动磁盘**） |
| `refresh` | 现在就就地刷新本地插件；`target` 可给包名或绝对目录，不给就是全部 |
| `update` | 安装有更新的 registry 版本（**会改 profile**，默认 `dryRun: true` 只报告） |
| `watch` / `unwatch` | 打开/关闭「改完自动刷新」 |

日常最常见的用法，就是什么都不用做：`watchLocal` 默认开着，改完保存，插件自己刷新。

## 设置页 UI

装好后在**设置 → 插件**里，`Plugin Updates` 这张卡片可以：

| 区域 | 内容 |
|---|---|
| 开关 | 检查 npm registry / 只检查并更新已启用的插件 / 本地插件改完自动刷新 / 自动安装更新 |
| 检查频率 | 数字框，单位分钟，回车或失焦生效。**改完立刻生效，不用重启** |
| 已装插件 | 每个插件的类型（npm / local / tarball / git）、已装版本，有新版时显示 `→ 新版本` |
| Check now | 立刻重新检查一次（会走网络） |
| 本地开发 | 列出从工作副本加载的插件，以及 watcher 是否在跑 |

频率和三个开关是 schemastery 的 **`.volatile()` 字段**：设置服务把改动直接写进运行中
fiber 的 config，而不是重启插件，所以改动是对下一次排期/下一次检查直接生效的。
为此 `lib/index.js` 里的每个运行时决策都通过 `currentConfig()` **惰性读配置**——
如果沿用激活时捕获的那份快照，设置页改了也不会生效。

UI 里的数据（版本号、本地目录、上次刷新结果）不属于 config，`configForms` 带不出来，
所以 Host 用一条自有 HTTP 路由 `/api/dsh-plugin-updater/status` 现取现给——这也是
新装的插件不用刷新页面就能出现在列表里的原因。

**这条状态是持续订阅的，不是一次性快照。** 卡片和侧栏那个 `可更新 (N)` 提示都挂在同一个
`useStatus()` 上：首读失败会在 20 秒内重试 5 次，之后每 2 分钟重读一次 Host 的缓存清单
（只读缓存，不额外查 registry），窗口重新可见或重新获得焦点时也会重读；瞬时错误不再清空
已经拿到的那份数据。**在此之前这里只读一次**：如果页面加载时 Host 还没查到新版本，
侧栏提示就一直不出现——Host 后来每 6 小时查到的更新，UI 永远不会知道（见下方「踩坑」表）。

**为什么卡片上没有「安装这个更新」按钮**：安装会改 profile 并替换正在运行的代码，
所以它留在插件管理器自己的流程（和 `plugin_update` 工具，带审批）里。这张卡片只报告，
不偷偷改你的 profile——一次误点就弄坏 profile 的管理卡片，不值得做。

## 配置（在 profile 的 `cordis.patch.yml` 里覆盖 id 为 `plugin-updater` 的那一行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后不监听、不定时、不注册工具 |
| `checkRegistry` | `true` | 是否去 registry 查最新版 |
| `checkIntervalMinutes` | `360` | **重复**检查的周期（分钟）：启动时先查一次，之后每 6 小时一次；`0` 完全关闭定时检查（工具仍可手动查） |
| `autoUpdateRegistry` | **`false`** | 是否自动安装；默认只报告 |
| `onlyEnabled` | **`true`** | 是否只检查并更新已启用的插件（`dsh.profile.bundles` 中的插件）；关闭时检查所有已安装插件 |
| `registries` | `[]` | 优先使用的 registry，留空用 profile 自己配置的 |
| `includePrerelease` | `false` | 预发布版算不算「最新」 |
| `timeoutMs` | `20000` | 单次 registry 查询超时 |
| `watchLocal` | `true` | **本地插件改完自动刷新** |
| `debounceMs` | `400` | 改动后的静默期，避免「全部保存」时读到写了一半的文件 |
| `extraWatchDirs` | `[]` | 额外监听的绝对路径（profile 没通过 `link:` 指向的目录） |
| `ignored` | `.git` `.cache` `coverage` `dist` `build` | 任何层级都跳过的目录名；`node_modules` 永远跳过 |
| `watchExtensions` | `.js` `.mjs` `.cjs` `.json` `.ts` `.tsx` `.css` | 只有这些后缀的改动才触发刷新；空数组表示全部 |
| `log` | `true` | 每次刷新/检查打一行日志 |

## 边界（有意为之）

- **registry 装的插件无法就地刷新。** `update` 之后需要重启 dsh 才会加载新的 JS 代码——
  这一点和 `dsh` 自己的插件管理页一致，本插件不承诺相反的事。
- **本插件不会刷新它自己。** 正在执行刷新回调的就是它自己的 fiber，把自己 dispose 掉
  会让回调当场消失。改本插件自己的源码时会在日志里明确提示需要重启。
- **只动目录内的模块。** 失效范围严格限制在目标插件目录内（外加它自己 import 的目录内文件），
  不会去清 `node:` 内置模块或无关的 `node_modules`。
- **需要 `--expose-internals`。** Desktop 版 Host 自带该参数。没有它时
  `reloadPlugin` 返回 `status: "unsupported"` 而不是抛错，`status` 会如实说明热刷新不可用。
- **目录里没有插件在跑时返回 `unchanged`，不做驱逐。** 只清缓存而不重启 fiber 并不会改变
  「已经在跑的那份代码」——既然没有 fiber 需要重启，就没有东西可刷新。下次 import 该目录时会
  自然读到新文件，这正是 `unchanged` 的含义。
- **入口名由自定义 resolver 解析到目录之外的插件不在范围内。** 只会重新 import 解析落在
  该目录内的 loader entry。
- **写坏的文件会被安全地拒绝。** 存盘写了一半、或新代码抛错时，刷新报 `failed` 并**完整回滚**：
  旧模块图恢复、旧插件重新激活，fiber 仍然是 active 状态，插件继续跑改动前的代码。不会出现
  「插件被刷挂」这种局面。这也是为什么刷新前会先等文件内容稳定（指纹连读两次一致）再 import。

## 实现中踩到的坑（都已修复，供后续维护参考）

这些都是验证阶段实测才暴露、并且**在真实 Host 里会让功能静默失效**的问题：

| 坑 | 后果 | 处理 |
|---|---|---|
| `loadCache` 自带的 `delete()` 在 Node 24+ 只清类型槽位 | 缓存看起来删了，重新 import 仍是旧模块 | 一律用 `Map.prototype.delete.call(loadCache, url)` |
| Cordis 的 `baseUrl` 是 **URL 对象**，不是字符串 | `typeof === "string"` 判断恒假，entry 匹配不到，永远 `unchanged` | 接受 `string \| URL \| {href}` |
| `registry.fibers` 是 `DisposableList`，`fibers[0]` 为 `undefined` | 按下标取 fiber 会静默漏掉 | 用迭代器遍历 |
| macOS 冷启动的 fsevents 会重放一帧「幽灵 rename」 | 启动瞬间误判为有改动 | 只吞掉每个根的首帧（下一宏任务解除 + 200ms 硬上限），不做时间窗 |
| 文件事件可能早于字节可见 | 正确刷新却读到旧的半截内容 | re-import 前用 stat+内容指纹连读确认稳定 |
| 客户端状态只在组件挂载时读一次 | 页面加载那一刻若还没有新版本（或首读失败），侧栏「可更新」提示会**永久**不出现；Host 后来查到的更新 UI 完全不知道，用户看到的就是「更新提示没了」 | `useStatus()` 改为持续轮询：首读失败重试、每 2 分钟重读缓存、窗口可见/获焦时重读；瞬时错误保留旧数据而不是清空 |
| `setTimeout(...).unref()` 的 sleep 在空循环里永不 resolve | 调试脚本挂死 | sleep 的定时器不 unref |

## 测试

```bash
./test/run.sh            # 全量：74 个测试 + 真实运行时「不重启就换代码」的证明
```

`--expose-internals` 必须显式传给 node，且要加 `--test-isolation=none`：
`node --test` 默认给每个测试文件开 worker 进程，而 worker **不继承** `--expose-internals`
（本环境下 `NODE_OPTIONS` 会被剥离，也无法代传）。少了这两个参数，热刷新用例会
「优雅跳过」，测试全绿但实际上什么都没证明——`run.sh` 已经处理好了。

`npm test` 走的就是 `run.sh`，CI 因此也跑的是同一套带证明的用例。

## 许可证

[MIT](./LICENSE) © 2026 Keycap AI & Rentong Zhang
