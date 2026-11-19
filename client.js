/**
 * dsh-plugin-updater client half — the bundle's card on the Plugins page.
 *
 * The card does three things, in the order they matter to someone looking at it:
 *
 *  1. shows what is installed and what is out of date (the facts a user opens
 *     this page to learn);
 *  2. exposes the check frequency and the two automation switches, which take
 *     effect immediately because the Host declares them as volatile settings;
 *  3. offers "check now" and "refresh local plugins", the two actions that are
 *     worth a button rather than a conversation.
 *
 * ## Where the data comes from, and why
 *
 * The config fields come from `ctx.configForms` — the same service every other
 * settings row uses, bound to this bundle's Host entry id. That is also what
 * makes the switches *persist*: the settings service owns the profile patch,
 * so the card never writes files itself.
 *
 * Versions, local directories and refresh results are NOT config, so they
 * cannot come through `configForms`. They come from the Host's own HTTP route
 * (`/api/dsh-plugin-updater/status`), served fresh on each read.
 *
 * ## Why there is no "install this update" button
 *
 * Installing changes the profile and replaces running code, so it stays behind
 * the plugin manager's own flow (and the `plugin_update` tool, which asks for
 * approval). This card reports; it does not silently mutate the profile. That
 * is a deliberate boundary, not an omission: a management card that installs
 * packages on a single click is how a profile gets broken by a mis-click.
 *
 * @module dsh-plugin-updater/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-updater',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = (function () { try { return require('react-dom') || null } catch (_) { return null } })()
    var el = React.createElement

    // Official primitives. A deployment without this package must still render
    // a usable card, so every control below has a plain-element fallback.
    var primitives = (function () {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') || {} } catch (_) { return {} }
    })()

    /** The Host loader entry id — also the settings namespace and the slot key. */
    var NAMESPACE = 'plugin-updater'
    var KEY = 'dsh-plugin-updater'
    var ROUTE = '/api/dsh-plugin-updater/status'
    var NS = 'pluginUpdater'
    var DICTS = {
      zh: {
        cardTitle: '插件更新',
        footerLabel: '插件更新状态',
        checkRegistry: '检查 npm 注册表',
        checkRegistryDesc: '查询每个从 npm 安装的插件是否存在新版本。仅进行网络查询，不会擅自安装。',
        checkFrequency: '检查频率',
        checkFrequencyDesc: '启动时执行一次，其后按指定间隔周期检查。设为 0 可停止自动周期检查（工具仍可按需调用）。',
        onlyEnabled: '仅检查并更新已启用的插件',
        onlyEnabledDesc: '仅检查并更新当前 profile 中启用的插件（dsh.profile.bundles）。已禁用的插件将被跳过。',
        autoUpdate: '自动安装可用更新',
        autoUpdateDesc: '默认关闭：更新将替换正在运行的代码，因此由您自主把控。registry 插件更新仍需重启加载。',
        watchLocal: '源码改动时热刷新本地插件',
        watchLocalDesc: '监听本地开发中的插件（link:/path），文件发生改动时立即在运行中的 Host 里热重载对应模块——免重启。',
        pendingRestartNotice: '插件已完成更新，待重启后正式生效',
        pendingPlugins: '待生效插件：{plugins}。',
        pendingRestartDesc: '当前运行中的会话、任务与工具均不受影响。您可以随时择时重启，或点击右侧按钮立即重启应用。',
        restartConfirm: '【DeepSeek Harness】确认立即重启应用以加载新版本插件？\n\n{plugins}应用将自动退出并重新启动。当前运行中的会话与未保存的任务可能中断。\n\n点击「确定」立即安全重启，点击「取消」可稍后手动重启。',
        restartCanceled: '已取消本次重启，插件更新将在下次启动应用时生效。',
        restartingNotice: '正在安全重启 DeepSeek Harness，应用将自动重新启动，请稍候…',
        restartFailed: '请求重启失败: {error}',
        restartNow: '立即重启',
        restarting: '重启中…',
        restartBtnTitle: '重启应用并激活新版本插件',
        installedPlugins: '已安装插件',
        checkRegistryTitle: '检查 npm 注册表是否有新版本',
        checking: '检查中…',
        checkNow: '立即检查',
        updateAll: '一键更新',
        updating: '更新中…',
        update: '更新',
        updateAllTitle: '一键更新所有可更新的插件',
        noUpdatesTitle: '暂无可更新的插件',
        readingProfile: '正在读取配置…',
        readStatusFailed: '无法读取状态: {error}',
        updatesAvailable: '{count} 个插件有更新可用',
        allUpToDate: '所有 registry 插件均为最新版本',
        lastChecked: ' · 上次检查于 {time}',
        nextCheckIn: ' · 下次检查于 {interval} 后',
        hotRefreshUnavailable: '热重载不可用: {reason}',
        noPluginsInstalled: '暂无安装的插件或配置文件不可读',
        updateToTitle: '更新 {name} 到 {version}',
        localDevelopment: '本地开发',
        localWorkingCopy: '{count} 个插件通过本地开发目录加载',
        watchingChanges: ' · 正在监听改动',
        watcherOff: ' · 监听未开启',
        startWatching: '开启监听',
        notAvailableInternals: '未开启 --expose-internals，暂不可用',
        updateHistory: '更新历史',
        noHistory: '暂无更新记录（仅记录从 npm registry 安装的插件）。',
        historyUpdated: '成功',
        historyFailed: '失败',
        updateHint: '点击上方“一键更新”或插件旁的“更新”按钮即可直接升级 registry 插件。新版本已安全写入，当前工作不受影响，您可以',
        updateHintStrong: ' 择时重启 ',
        updateHintEnd: 'DeepSeek Harness 激活新版本。',
        clickRestart: '点击重启',
        updatableBadge: '可更新 ({count})',
        updatedSuccess: '更新已完成！请重启应用以激活新版本。',
        updateFailed: '更新失败: {error}',
        closePopover: '关闭浮窗',
        updatesFoundPopover: '发现 {count} 个插件有更新',
        pendingRestartPopover: '插件待重启生效',
        pendingRestartPopoverDesc: '新版本已写入，当前对话不受影响。请随时择时重启 DeepSeek Harness 激活。',
        updatableList: '可更新列表：',
        restartLater: '稍后重启',
        openSettings: '打开设置',
        tooltipRestart: '插件已完成更新，待重启后生效。当前任务不受影响，请择时重启。点击查看详情。',
        tooltipUpdates: '发现 {count} 个插件有可用更新，点击快速更新。',
        never: '从未',
        justNow: '刚刚',
        ago: '前',
        off: '关闭',
        disabled: ' (已禁用)',
        kind_registry: 'npm',
        kind_link: '本地',
        kind_path: '本地',
        kind_file: '本地',
        kind_workspace: '本地',
        kind_tarball: '压缩包',
        kind_git: 'git'
      },
      en: {
        cardTitle: 'Plugin updates',
        footerLabel: 'Plugin update status',
        checkRegistry: 'Check the npm registry',
        checkRegistryDesc: 'Ask each registry-installed plugin whether a newer version exists. A network read only — nothing is installed.',
        checkFrequency: 'Check frequency',
        checkFrequencyDesc: 'One check runs at startup, then repeats on this interval. Set 0 to stop the repeating check (the tool still answers on demand).',
        onlyEnabled: 'Only check and update enabled plugins',
        onlyEnabledDesc: 'Only check for updates and update plugins that are enabled in this profile (dsh.profile.bundles). Disabled plugins are skipped.',
        autoUpdate: 'Install updates automatically',
        autoUpdateDesc: 'Off by default: an update replaces code that is currently running, so it stays your decision. A registry update still needs a restart to load.',
        watchLocal: 'Refresh local plugins on change',
        watchLocalDesc: 'Watch locally-developed plugins (link:/path) and reload their modules in the running Host the moment a file changes — no restart.',
        pendingRestartNotice: 'Plugin updates installed; restart required',
        pendingPlugins: 'Pending plugins: {plugins}. ',
        pendingRestartDesc: 'Active sessions, tasks, and tools remain unaffected. You can restart at your convenience, or click the button to restart now.',
        restartConfirm: '[DeepSeek Harness] Restart application now to activate plugin updates?\n\n{plugins}The application will exit and restart automatically. In-flight tasks may be interrupted.\n\nClick OK to restart safely now, or Cancel to restart later.',
        restartCanceled: 'Restart canceled. Updates will take effect on next launch.',
        restartingNotice: 'Restarting DeepSeek Harness safely, please wait…',
        restartFailed: 'Restart request failed: {error}',
        restartNow: 'Restart now',
        restarting: 'Restarting…',
        restartBtnTitle: 'Restart application and activate updated plugins',
        installedPlugins: 'Installed plugins',
        checkRegistryTitle: 'Check the npm registry for updates',
        checking: 'Checking…',
        checkNow: 'Check now',
        updateAll: 'Update all',
        updating: 'Updating…',
        update: 'Update',
        updateAllTitle: 'Update all plugins with available updates',
        noUpdatesTitle: 'No updates available',
        readingProfile: 'Reading profile…',
        readStatusFailed: 'Could not read status: {error}',
        updatesAvailable: '{count} update(s) available',
        allUpToDate: 'All registry plugins are up to date',
        lastChecked: ' · last checked {time}',
        nextCheckIn: ' · next check in {interval}',
        hotRefreshUnavailable: 'Hot refresh unavailable: {reason}',
        noPluginsInstalled: 'No plugins installed or profile unreadable',
        updateToTitle: 'Update {name} to {version}',
        localDevelopment: 'Local development',
        localWorkingCopy: '{count} plugin(s) loaded from a working copy',
        watchingChanges: ' · watching for changes',
        watcherOff: ' · watcher off',
        startWatching: 'Start watching',
        notAvailableInternals: 'Not available without --expose-internals',
        updateHistory: 'Update history',
        noHistory: 'No updates recorded yet (update history tracks packages installed from npm registries).',
        historyUpdated: 'updated',
        historyFailed: 'failed',
        updateHint: 'Click "Update all" or "Update" next to a plugin to upgrade registry packages. Updates are safely written without affecting current work. Restart at your convenience to activate.',
        updateHintStrong: ' restart ',
        updateHintEnd: 'DeepSeek Harness to activate new versions.',
        clickRestart: 'Restart',
        updatableBadge: 'Updates ({count})',
        updatedSuccess: 'Update complete! Please restart to activate new versions.',
        updateFailed: 'Update failed: {error}',
        closePopover: 'Close popover',
        updatesFoundPopover: '{count} plugin(s) have updates',
        pendingRestartPopover: 'Restart required',
        pendingRestartPopoverDesc: 'Updates are written. Active tasks remain unaffected. Restart DeepSeek Harness at your convenience.',
        updatableList: 'Available updates:',
        restartLater: 'Restart later',
        openSettings: 'Open Settings',
        tooltipRestart: 'Plugin updates installed; restart required. Active tasks remain unaffected. Click for details.',
        tooltipUpdates: '{count} plugin(s) have available updates. Click for details.',
        never: 'never',
        justNow: 'just now',
        ago: 'ago',
        off: 'off',
        disabled: ' (disabled)',
        kind_registry: 'npm',
        kind_link: 'local',
        kind_path: 'local',
        kind_file: 'local',
        kind_workspace: 'local',
        kind_tarball: 'tarball',
        kind_git: 'git'
      }
    }

    function useLocaleListener(ctx) {
      var locale = ctx && ctx.get ? ctx.get('locale') : null
      var state = React.useState(0)
      var setTick = state[1]
      React.useEffect(function () {
        if (!locale || typeof locale.subscribe !== 'function') return
        return locale.subscribe(function () {
          setTick(function (n) { return n + 1 })
        })
      }, [locale])
    }

    function createTranslator(ctx) {
      var locale = ctx && ctx.get ? ctx.get('locale') : null
      if (locale && typeof locale.bind === 'function') {
        return locale.bind(NS)
      }
      var active = (locale && locale.getSnapshot) ? locale.getSnapshot().active : 'zh'
      var dict = DICTS[active] || DICTS.en || DICTS.zh
      return function (key, params) {
        var val = dict[key] || DICTS.en[key] || DICTS.zh[key] || key
        if (params) {
          return val.replace(/\{(\w+)\}/g, function (m, k) { return k in params ? String(params[k]) : m })
        }
        return val
      }
    }


    // ── styles ───────────────────────────────────────────────────────────────
    // Only --dsw-alias-* theme tokens, so the card follows light/dark with no
    // literal colours. A renamed token degrades the look, never the render.
    var S = {
      row: {
        display: 'flex', alignItems: 'flex-start', gap: '12px',
        padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-subtle)',
      },
      grow: { flex: '1 1 auto', minWidth: 0 },
      title: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-text-primary)' },
      desc: { fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-text-secondary)', marginTop: '2px' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px', color: 'var(--dsw-alias-text-secondary)',
      },
      control: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '6px' },
      section: { marginTop: '14px' },
      sectionTitle: {
        fontSize: '11px', fontWeight: 600, letterSpacing: '.04em',
        textTransform: 'uppercase', color: 'var(--dsw-alias-text-secondary)',
      },
      list: { marginTop: '6px', display: 'flex', flexDirection: 'column' },
      item: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-subtle)',
      },
      name: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', color: 'var(--dsw-alias-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      version: { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-text-secondary)' },
      empty: { fontSize: '11px', color: 'var(--dsw-alias-text-secondary)', padding: '8px 0' },
      button: {
        fontSize: '11px', fontWeight: 500, padding: '4px 10px',
        borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-primary)',
      },
      buttonPrimary: {
        fontSize: '11px', fontWeight: 600, padding: '4px 10px',
        borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-accent, #3b82f6)',
        background: 'var(--dsw-alias-accent, #3b82f6)',
        color: '#ffffff',
      },
      buttonSmall: {
        fontSize: '10px', fontWeight: 500, padding: '2px 8px',
        borderRadius: '4px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-primary)',
      },
      buttonDisabled: {
        fontSize: '11px', fontWeight: 500, padding: '4px 10px',
        borderRadius: '6px', cursor: 'default', opacity: 0.55,
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-secondary)',
      },
    }

    function styles() {
      if (document.getElementById('dsh-plugin-updater-styles')) return
      var tag = document.createElement('style')
      tag.id = 'dsh-plugin-updater-styles'
      tag.textContent = ''
      document.head.appendChild(tag)
    }

    // ── bound settings form ──────────────────────────────────────────────────
    // Mirrors dsh-context / dsh-tool-gate: subscribe to the Host-served
    // namespace and expose {status, value, writable} plus a setter.
    function useForm(form) {
      var state = React.useState(function () {
        if (!form || typeof form.getSnapshot !== 'function') {
          return { status: 'idle', value: {}, writable: false, revision: 0 }
        }
        var snap = form.getSnapshot()
        return { status: snap.status, value: snap.value, writable: snap.writable, revision: snap.revision }
      })
      var setState = state[1]
      React.useEffect(function () {
        if (!form || typeof form.subscribe !== 'function') return
        return form.subscribe(function () {
          var snap = form.getSnapshot()
          setState({ status: snap.status, value: snap.value, writable: snap.writable, revision: snap.revision })
        })
      }, [form])
      var setField = React.useCallback(function (field, value) {
        if (!form || typeof form.set !== 'function') return Promise.resolve()
        return form.set(field, value).catch(function () { /* the snapshot surfaces the conflict */ })
      }, [form])
      return [state[0], setField]
    }

    // ── controls ─────────────────────────────────────────────────────────────
    function Switch(props) {
      if (typeof primitives.Switch === 'function') {
        return el(primitives.Switch, {
          checked: Boolean(props.checked),
          onChange: props.onChange,
          disabled: props.disabled,
          label: props.label,
        })
      }
      return el('input', {
        type: 'checkbox',
        checked: Boolean(props.checked),
        disabled: props.disabled,
        onChange: function (event) { props.onChange(event.target.checked) },
      })
    }

    function Button(props) {
      var defaultStyle = props.style || S.button
      var style = props.disabled ? Object.assign({}, defaultStyle, S.buttonDisabled) : defaultStyle
      return el('button', {
        type: 'button',
        disabled: Boolean(props.disabled),
        onClick: props.disabled ? undefined : props.onClick,
        style: style,
        title: props.title,
      }, props.children)
    }

    /** A numeric field with its unit, committing on blur/Enter only. */
    function NumberField(props) {
      var state = React.useState(String(props.value))
      var text = state[0]
      var setText = state[1]
      // Re-sync when the Host value changes underneath (another window, a reset).
      React.useEffect(function () { setText(String(props.value)) }, [props.value])
      var commit = function () {
        var parsed = Number(text)
        if (!Number.isFinite(parsed) || parsed < 0) {
          setText(String(props.value))
          return
        }
        if (parsed !== props.value) props.onCommit(parsed)
      }
      return el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        el('input', {
          type: 'number',
          min: 0,
          step: 1,
          value: text,
          disabled: props.disabled,
          onChange: function (event) { setText(event.target.value) },
          onBlur: commit,
          onKeyDown: function (event) { if (event.key === 'Enter') commit() },
          style: {
            width: '64px', fontSize: '12px', padding: '3px 6px', textAlign: 'right',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-default)',
            background: 'var(--dsw-alias-bg-elevated)',
            color: 'var(--dsw-alias-text-primary)',
          },
        }),
        el('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-text-secondary)' } }, props.unit))
    }

    function Row(props) {
      return el('div', { style: S.row },
        el('div', { style: S.grow },
          el('div', { style: S.title }, props.title),
          props.desc ? el('div', { style: S.desc }, props.desc) : null),
        el('div', { style: S.control }, props.control))
    }

    function triggerGlobalStatusReload() {
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('dsh-plugin-updater:status-reload'))
        } catch (_) {}
      }
    }

    // ── the live status channel ───────────────────────────────────────────────
    //
    // A status read is NOT a one-shot at mount. The Host keeps asking the
    // registry on its own schedule (every `checkIntervalMinutes`), so a page
    // that read the status before the first answer existed — or whose very
    // first read failed while the Host was still booting — would keep that
    // empty answer forever: the footer indicator renders nothing while it has
    // no payload, so the update hint would silently stay hidden for the whole
    // life of the page even though the Host knows about a newer version. Hence:
    //   * keep the last good payload instead of wiping it on a transient error;
    //   * retry the first read until something arrives;
    //   * re-read on a timer and whenever the window becomes visible again.
    // The re-read asks for the cached inventory only (no `check`), so it stays
    // cheap: it never goes to the network by itself.
    var STATUS_POLL_MS = 120000
    var STATUS_RETRY_MS = 4000
    var STATUS_RETRY_LIMIT = 5
    var STATUS_QUIET_MS = 5000
    var lastLoadAt = 0

    function useStatus() {
      var state = React.useState({ status: 'loading', data: null, error: null })
      var setState = state[1]
      var data = state[0].data
      var load = React.useCallback(function (options) {
        var isCheck = Boolean(options && options.check)
        // The card and the footer indicator both mount this hook; share one
        // request between them instead of firing two on every tick.
        var now = Date.now()
        if (!isCheck && now - lastLoadAt < STATUS_QUIET_MS) return Promise.resolve(null)
        lastLoadAt = now
        setState(function (previous) { return { status: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null } })
        return fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(isCheck ? { action: 'check', check: true } : {}),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (data) { setState({ status: 'ready', data: data, error: null }) })
          .catch(function (error) {
            var message = String(error && error.message || error)
            setState(function (previous) {
              return {
                status: previous.data ? 'ready' : 'error',
                data: previous.data,
                error: message,
              }
            })
          })
      }, [])
      React.useEffect(function () { load() }, [load])
      // Nothing arrived yet: retry a bounded number of times. This is what
      // recovers a page that loaded while the Host had no answer (boot, a
      // failed first request, or a route that came up a moment later).
      React.useEffect(function () {
        if (data) return
        var attempts = 0
        var timer = setInterval(function () {
          attempts += 1
          if (attempts > STATUS_RETRY_LIMIT) {
            clearInterval(timer)
            return
          }
          lastLoadAt = 0
          load()
        }, STATUS_RETRY_MS)
        return function () { clearInterval(timer) }
      }, [data, load])
      // Keep in step with the Host's own periodic checks.
      React.useEffect(function () {
        var timer = setInterval(function () { load() }, STATUS_POLL_MS)
        var onFocus = function () { load() }
        var onVisibility = function () {
          if (typeof document !== 'undefined' && document.hidden) return
          load()
        }
        if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return function () {
          clearInterval(timer)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])
      React.useEffect(function () {
        var onReload = function () { load({ check: true }) }
        if (typeof window !== 'undefined') {
          window.addEventListener('dsh-plugin-updater:status-reload', onReload)
          return function () { window.removeEventListener('dsh-plugin-updater:status-reload', onReload) }
        }
      }, [load])
      return [state[0], load, setState]
    }

    /** "6 h" / "30 min" / "off" — the interval in the unit that reads best. */
    function formatInterval(minutes, t) {
      if (!Number.isFinite(minutes) || minutes <= 0) return t ? t('off') : 'off'
      if (minutes < 60) return Math.round(minutes) + ' min'
      var hours = minutes / 60
      return (Number.isInteger(hours) ? hours : hours.toFixed(1)) + ' h'
    }

    function formatAgo(at, t) {
      if (!at) return t ? t('never') : 'never'
      var seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      var ago = t ? t('ago') : 'ago'
      if (seconds < 60) return seconds + 's ' + ago
      if (seconds < 3600) return Math.round(seconds / 60) + ' min ' + ago
      return Math.round(seconds / 3600) + ' h ' + ago
    }

    function getKindLabel(kind, t) {
      if (t) {
        var res = t('kind_' + kind)
        if (res !== 'kind_' + kind) return res
      }
      var fallback = {
        registry: 'npm',
        link: 'local',
        path: 'local',
        file: 'local',
        workspace: 'local',
        tarball: 'tarball',
        git: 'git',
        unknown: '?',
      }
      return fallback[kind] || kind
    }

    // ── the card ─────────────────────────────────────────────────────────────
    function Card(props) {
      useLocaleListener(props.ctx)
      var t = props.t || createTranslator(props.ctx)
      // Both hooks run unconditionally at the top of the component, as the
      // rules of hooks require — the previous revision called useForm() from
      // inside the registration callback, which is a conditional hook and
      // throws the moment React's dispatcher is absent or the order shifts.
      var pair = useForm(props.form)
      var formState = pair[0]
      var setField = pair[1]
      var value = formState.value || {}
      var writable = formState.writable !== false

      var statusPair = useStatus()
      var status = statusPair[0]
      var reload = statusPair[1]
      var setStatusState = statusPair[2]

      var updatingState = React.useState(null)
      var updatingTarget = updatingState[0]
      var setUpdatingTarget = updatingState[1]

      var messageState = React.useState(null)
      var updateMessage = messageState[0]
      var setUpdateMessage = messageState[1]

      var handleUpdate = React.useCallback(function (target) {
        var isAll = !target || target === 'all' || target === 'null' || target === 'undefined'
        setUpdatingTarget(isAll ? 'all' : target)
        setUpdateMessage(null)
        var body = { action: 'update' }
        if (!isAll && target) {
          body.target = target
        }
        return fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (data) {
            setUpdatingTarget(null)
            if (data) {
              setStatusState({ status: 'ready', data: data, error: null })
              triggerGlobalStatusReload()
              if (data.report) {
                setUpdateMessage({ type: 'success', text: data.report })
              }
            }
          })
          .catch(function (error) {
            setUpdatingTarget(null)
            var msg = String(error && error.message || error)
            setUpdateMessage({ type: 'error', text: 'Update failed: ' + msg })
          })
      }, [setStatusState])

      var data = status.data
      var plugins = (data && data.plugins) || []
      var onlyEnabled = value.onlyEnabled !== false
      var updatable = plugins.filter(function (p) { return p.updateAvailable && p.kind === 'registry' && (!onlyEnabled || p.enabled !== false) })
      var locals = plugins.filter(function (p) { return p.local })
      var pendingRestart = (data && data.pendingRestart) || []
      var needsRestart = Boolean(data && data.restartRequired && pendingRestart.length > 0)

      var interval = typeof value.checkIntervalMinutes === 'number' ? value.checkIntervalMinutes : 360
      var checkRegistry = value.checkRegistry !== false
      var watchLocal = value.watchLocal !== false
      var autoUpdate = value.autoUpdateRegistry === true

      var hot = data && data.hotReload
      var hotOk = !!(hot && hot.ok)

      return el('div', null,
        // ── automation ──────────────────────────────────────────────────────
        el(Row, {
          title: t('checkRegistry'),
          desc: t('checkRegistryDesc'),
          control: el(Switch, {
            checked: checkRegistry,
            disabled: !writable,
            label: t('checkRegistry'),
            onChange: function (next) { setField('checkRegistry', next) },
          }),
        }),

        el(Row, {
          title: t('checkFrequency'),
          desc: t('checkFrequencyDesc'),
          control: el(NumberField, {
            value: interval,
            unit: 'min',
            disabled: !writable || !checkRegistry,
            onCommit: function (next) { setField('checkIntervalMinutes', next) },
          }),
        }),

        el(Row, {
          title: t('onlyEnabled'),
          desc: t('onlyEnabledDesc'),
          control: el(Switch, {
            checked: onlyEnabled,
            disabled: !writable,
            label: t('onlyEnabled'),
            onChange: function (next) {
              setField('onlyEnabled', next)
              triggerGlobalStatusReload()
              reload({ check: true })
            },
          }),
        }),

        el(Row, {
          title: t('autoUpdate'),
          desc: t('autoUpdateDesc'),
          control: el(Switch, {
            checked: autoUpdate,
            disabled: !writable,
            label: t('autoUpdate'),
            onChange: function (next) { setField('autoUpdateRegistry', next) },
          }),
        }),

        el(Row, {
          title: t('watchLocal'),
          desc: t('watchLocalDesc'),
          control: el(Switch, {
            checked: watchLocal,
            disabled: !writable,
            label: t('watchLocal'),
            onChange: function (next) { setField('watchLocal', next) },
          }),
        }),

        // ── restart banner (entrance 1) ────────────────────────────────────
        needsRestart
          ? el('div', {
              style: {
                marginBottom: '14px',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: 1.5,
                border: '1px solid var(--dsw-alias-border-accent, #3b82f6)',
                background: 'var(--dsw-alias-bg-accent-subtle, rgba(59,130,246,0.08))',
                color: 'var(--dsw-alias-text-primary)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
              }
            },
              el('span', { style: { fontSize: '16px', flex: 'none', marginTop: '1px' } }, '🔄'),
              el('div', { style: { flex: '1 1 auto' } },
                el('div', { style: { fontWeight: 600, marginBottom: '2px', color: 'var(--dsw-alias-text-accent, #3b82f6)' } },
                  '插件已完成更新，待重启后正式生效'
                ),
                el('div', { style: { color: 'var(--dsw-alias-text-secondary)', fontSize: '11px' } },
                  (pendingRestart.length ? t('pendingPlugins', { plugins: pendingRestart.join('、') }) : '') + t('pendingRestartDesc')
                )
              ),
              el(Button, {
                onClick: function () {
                  var ok = window.confirm(
                    t('restartConfirm', {
                      plugins: pendingRestart.length ? (t('pendingPlugins', { plugins: pendingRestart.join('、') }) + '\n\n') : ''
                    })
                  );
                  if (!ok) {
                    setUpdateMessage({ type: 'info', text: t('restartCanceled') });
                    return;
                  }
                  setUpdateMessage({ type: 'info', text: t('restartingNotice') });
                  fetch(ROUTE, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'restart' }),
                  }).catch(function (err) {
                    setUpdateMessage({ type: 'error', text: t('restartFailed', { error: err.message || String(err) }) });
                  });
                },
                style: S.buttonPrimary,
                title: t('restartBtnTitle'),
              }, t('restartNow'))
            )
          : null,

        // ── status ──────────────────────────────────────────────────────────
        el('div', { style: S.section },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            el('div', { style: S.sectionTitle }, t('installedPlugins')),
            el('div', { style: { flex: '1 1 auto' } }),
            el(Button, {
              onClick: function () { reload({ check: true }) },
              disabled: status.status === 'refreshing' || updatingTarget !== null,
              title: t('checkRegistryTitle'),
            }, status.status === 'refreshing' ? t('checking') : t('checkNow')),
            el(Button, {
              onClick: function () { handleUpdate(null) },
              disabled: !updatable.length || updatingTarget !== null || status.status === 'refreshing',
              style: (updatable.length && updatingTarget === null) ? S.buttonPrimary : S.button,
              title: updatable.length ? t('updateAllTitle') : t('noUpdatesTitle'),
            }, updatingTarget === 'all'
                ? t('updating')
                : (t('updateAll') + (updatable.length ? ' (' + updatable.length + ')' : ''))
            )
          ),

          updateMessage
            ? el('div', {
                style: {
                  marginTop: '8px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  lineHeight: 1.5,
                  border: '1px solid ' + (updateMessage.type === 'error' ? 'var(--dsw-alias-border-danger, #ef4444)' : 'var(--dsw-alias-border-accent, #3b82f6)'),
                  background: updateMessage.type === 'error' ? 'var(--dsw-alias-bg-danger-subtle, rgba(239,68,68,0.08))' : 'var(--dsw-alias-bg-accent-subtle, rgba(59,130,246,0.08))',
                  color: 'var(--dsw-alias-text-primary)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                }
              },
                el('div', { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } }, updateMessage.text),
                el('button', {
                  type: 'button',
                  onClick: function () { setUpdateMessage(null) },
                  style: {
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: '12px', color: 'var(--dsw-alias-text-secondary)',
                    padding: '0 2px',
                  }
                }, '✕'))
            : null,

          status.status === 'loading' ? el('div', { style: S.empty }, t('readingProfile')) : null,
          status.status === 'error'
            ? el('div', { style: S.empty }, t('readStatusFailed', { error: status.error || 'unknown error' }))
            : null,

          data
            ? el('div', { style: S.desc },
                updatable.length
                  ? t('updatesAvailable', { count: updatable.length })
                  : t('allUpToDate'),
                ' · ' + formatAgo(data.checkedAt, t),
                ' · ' + formatInterval(data.intervalMinutes, t))
            : null,

          data && !hotOk
            ? el('div', { style: S.desc },
                t('hotRefreshUnavailable', { reason: ((hot && hot.reason) || 'unknown reason') }))
            : null,

          data
            ? (plugins.length === 0
                ? el('div', { style: S.empty }, t('noPluginsInstalled'))
                : el('div', { style: S.list },
                    plugins.map(function (plugin) {
                      var label = getKindLabel(plugin.kind, t)
                      var disabledTag = plugin.enabled === false ? t('disabled') : ''
                      var version = plugin.installedVersion || '—'
                      var isUpdatingThis = updatingTarget === plugin.name
                      var updateBtn = (plugin.updateAvailable && plugin.kind === 'registry' && (!onlyEnabled || plugin.enabled !== false))
                        ? el(Button, {
                            onClick: function () { handleUpdate(plugin.name) },
                            disabled: updatingTarget !== null || status.status === 'refreshing',
                            style: S.buttonSmall,
                            title: t('updateToTitle', { name: plugin.name, version: plugin.latestVersion || 'latest' }),
                          }, isUpdatingThis ? t('updating') : t('update'))
                        : null
                      var tail = (plugin.updateAvailable && (!onlyEnabled || plugin.enabled !== false))
                        ? el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                            el('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-text-accent)' } }, '→ ' + (plugin.latestVersion || '?')),
                            updateBtn
                          )
                        : null
                      var refresh = plugin.refresh && plugin.refresh.status === 'reloaded'
                        ? el('span', { style: S.mono, title: 'last hot refresh' }, '↻')
                        : null
                      return el('div', { key: plugin.name, style: S.item },
                        el('div', { style: S.name, title: plugin.localDir || plugin.name }, plugin.name),
                        el('span', { style: S.version }, label + disabledTag),
                        refresh,
                        el('span', { style: S.version }, version),
                        tail)
                    })))
            : null),

        // ── local refresh ───────────────────────────────────────────────────
        locals.length
          ? el('div', { style: S.section },
              el('div', { style: S.sectionTitle }, t('localDevelopment')),
              el('div', { style: S.desc },
                t('localWorkingCopy', { count: locals.length })
                + (data && data.watcher ? t('watchingChanges') : t('watcherOff'))),
              data && data.watcher
                ? null
                : el('div', { style: { marginTop: '6px' } },
                    el(Button, {
                      disabled: !hotOk,
                      onClick: function () {
                        // Turning the switch on is what starts the watcher: the
                        // Host re-reads the setting live, so no extra action is
                        // needed here beyond persisting it.
                        setField('watchLocal', true)
                      },
                      title: hotOk ? undefined : t('notAvailableInternals'),
                    }, t('startWatching'))))
          : null,

        // ── update history ──────────────────────────────────────────────────
        data
          ? el('div', { style: S.section },
              el('div', { style: S.sectionTitle }, t('updateHistory')),
              data.history && data.history.length
                ? el('div', { style: S.list },
                    data.history.map(function (item, idx) {
                      var isSuccess = item.status === 'success'
                      var statusColor = isSuccess ? 'var(--dsw-alias-text-accent, #10b981)' : 'var(--dsw-alias-text-danger, #ef4444)'
                      var statusText = isSuccess ? t('historyUpdated') : t('historyFailed')
                      var timeStr = formatAgo(item.timestamp, t)
                      var vFrom = item.fromVersion || '?'
                      var vTo = item.toVersion || '?'
                      return el('div', { key: idx, style: S.item },
                        el('div', { style: S.name, title: item.target }, item.target),
                        el('span', { style: S.version }, vFrom + ' → ' + vTo),
                        el('span', { style: { fontSize: '11px', color: statusColor, fontWeight: 500 } }, statusText),
                        el('span', { style: S.version }, timeStr)
                      )
                    }))
                : el('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary)', padding: '4px 0' } },
                    'No updates recorded yet (update history tracks packages installed from npm registries).'))
          : null,

        // ── hints ───────────────────────────────────────────────────────────
        el('div', { style: { marginTop: '12px', fontSize: '11px', lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)' } },
          t('updateHint'),
          el('strong', null, t('updateHintStrong')),
          t('updateHintEnd')),

        data && (data.warnings || []).length
          ? el('div', { style: { marginTop: '6px', fontSize: '11px', color: 'var(--dsw-alias-text-secondary)' } },
              data.warnings.join(' · '))
          : null)
    }

    // ── Entrance 2: Global Sidebar Foot Indicator (beside Account & Settings) ──
    function FooterUpdateIndicator(props) {
      useLocaleListener(props.ctx)
      var t = props.t || createTranslator(props.ctx)
      var wide = props.wide !== false
      var ctx = props.ctx
      var formPair = useForm(props.form)
      var formValue = (formPair[0] && formPair[0].value) || {}
      var statusPair = useStatus()
      var status = statusPair[0]
      var reload = statusPair[1]
      var data = status.data

      var popoverState = React.useState(false)
      var showPopover = popoverState[0]
      var setShowPopover = popoverState[1]

      var updatingState = React.useState(false)
      var isUpdating = updatingState[0]
      var setIsUpdating = updatingState[1]

      var updateMsgState = React.useState(null)
      var popoverMsg = updateMsgState[0]
      var setPopoverMsg = updateMsgState[1]

      var btnRef = React.useRef(null)
      var popoverRef = React.useRef(null)

      // Popover positioning coordinates
      var posState = React.useState({ bottom: 42, left: 10, width: 250 })
      var popoverPos = posState[0]
      var setPopoverPos = posState[1]

      var updatePosition = React.useCallback(function () {
        if (!btnRef.current) return
        var btnRect = btnRef.current.getBoundingClientRect()
        var bottom = Math.max(10, window.innerHeight - btnRect.top + 6)

        // Find triggerRow or sidebar foot container to align properly
        var row = btnRef.current.closest('div[class*="triggerRow"]') ||
                  btnRef.current.closest('div[class*="footArea"]') ||
                  (typeof document !== 'undefined' ? document.querySelector('div[class*="triggerRow"]') : null)
        var left = 10
        var width = 250
        if (row) {
          var rowRect = row.getBoundingClientRect()
          left = Math.max(8, rowRect.left)
          width = Math.min(265, Math.max(230, rowRect.width))
        } else {
          left = Math.max(8, Math.min(btnRect.left, (typeof window !== 'undefined' ? window.innerWidth : 300) - 265))
        }
        setPopoverPos({ bottom: bottom, left: left, width: width })
      }, [])

      React.useEffect(function () {
        if (showPopover) {
          updatePosition()
          window.addEventListener('resize', updatePosition)
          return function () { window.removeEventListener('resize', updatePosition) }
        }
      }, [showPopover, updatePosition])

      // Click outside and Escape key to close popover cleanly
      React.useEffect(function () {
        if (!showPopover) return
        var onPointerDown = function (e) {
          if (popoverRef.current && popoverRef.current.contains(e.target)) return
          if (btnRef.current && btnRef.current.contains(e.target)) return
          setShowPopover(false)
        }
        var onKeyDown = function (e) {
          if (e.key === 'Escape') setShowPopover(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [showPopover])

      var prevOnlyEnabledRef = React.useRef(formValue.onlyEnabled)
      React.useEffect(function () {
        if (prevOnlyEnabledRef.current !== formValue.onlyEnabled) {
          var hadPrev = typeof prevOnlyEnabledRef.current === 'boolean'
          prevOnlyEnabledRef.current = formValue.onlyEnabled
          if (hadPrev && typeof formValue.onlyEnabled === 'boolean') {
            reload({ check: true })
          }
        }
      }, [formValue.onlyEnabled, reload])

      if (!data) return null

      var plugins = data.plugins || []
      var onlyEnabled = typeof formValue.onlyEnabled === 'boolean'
        ? formValue.onlyEnabled
        : (data && typeof data.onlyEnabled === 'boolean' ? data.onlyEnabled : true)
      var updatable = plugins.filter(function (p) { return p.kind === 'registry' && p.updateAvailable && (!onlyEnabled || p.enabled !== false) })
      var pendingRestart = data.pendingRestart || []
      var needsRestart = Boolean(data && data.restartRequired && pendingRestart.length > 0)

      if (!needsRestart && updatable.length === 0) return null

      var openSettings = function () {
        setShowPopover(false)
        var launcher = document.querySelector('[data-slot="settings.launcher"] button, [class*="AccountMenu_module"] button, [class*="triggerRow"] > button, button[aria-label="Settings"], button[aria-label="设置"]')
        if (launcher) {
          launcher.click()
        } else if (ctx && ctx.shortcuts && typeof ctx.shortcuts.run === 'function') {
          ctx.shortcuts.run('settings.open')
        }
      }

      var handleQuickUpdate = function () {
        setIsUpdating(true)
        setPopoverMsg(null)
        fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'update' }),
        })
          .then(function (res) { return res.json() })
          .then(function (resData) {
            setIsUpdating(false)
            setPopoverMsg(t('updatedSuccess'))
            triggerGlobalStatusReload()
            reload({ check: true })
          })
          .catch(function (err) {
            setIsUpdating(false)
            setPopoverMsg(t('updateFailed', { error: err.message || String(err) }))
          })
      }

      var buttonText = needsRestart
        ? (wide ? t('clickRestart') : '')
        : (wide ? (updatable.length ? t('updatableBadge', { count: updatable.length }) : '') : '')
      var buttonIcon = needsRestart ? '🔄' : '🧩'

      var handleRestart = function () {
        var ok = window.confirm(
          t('restartConfirm', {
            plugins: pendingRestart.length ? (t('pendingPlugins', { plugins: pendingRestart.join('、') }) + '\n\n') : ''
          })
        );
        if (!ok) {
          setPopoverMsg(t('restartCanceled'));
          return;
        }
        setIsUpdating(true);
        setPopoverMsg(t('restartingNotice'));
        fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'restart' }),
        }).catch(function (err) {
          setIsUpdating(false);
          setPopoverMsg(t('restartFailed', { error: err.message || String(err) }));
        });
      };

      var popoverContent = showPopover
        ? el('div', {
            ref: popoverRef,
            style: {
              position: 'fixed',
              bottom: popoverPos.bottom + 'px',
              left: popoverPos.left + 'px',
              width: popoverPos.width + 'px',
              maxWidth: 'calc(100vw - 16px)',
              background: 'var(--dsw-alias-bg-elevated, #24252a)',
              border: '1px solid var(--dsw-alias-border-base, rgba(255,255,255,0.15))',
              borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              padding: '12px',
              zIndex: 99999,
              color: 'var(--dsw-alias-text-primary, #ffffff)',
              fontSize: '12px',
              lineHeight: 1.5,
              cursor: 'default',
            },
            onClick: function (e) { e.stopPropagation() },
          },
            el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
              el('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-text-accent, #3b82f6)', display: 'flex', alignItems: 'center', gap: '5px' } },
                buttonIcon, needsRestart ? t('pendingRestartPopover') : t('updatesFoundPopover', { count: updatable.length })
              ),
              el('button', {
                type: 'button',
                onClick: function () { setShowPopover(false) },
                style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dsw-alias-text-secondary)', padding: '0 2px', fontSize: '13px' },
                title: t('closePopover')
              }, '✕')
            ),
            needsRestart
              ? el('div', { style: { color: 'var(--dsw-alias-text-secondary)', fontSize: '11px', marginBottom: '10px' } },
                  (pendingRestart.length ? (t('pendingPlugins', { plugins: pendingRestart.join('、') }) + '\n') : '') +
                  t('pendingRestartPopoverDesc')
                )
              : el('div', { style: { marginBottom: '10px' } },
                  el('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-text-secondary)', marginBottom: '6px' } }, t('updatableList')),
                  el('div', { style: { maxHeight: '140px', overflowY: 'auto', paddingRight: '2px' } },
                    updatable.map(function (p) {
                      return el('div', { key: p.name, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', padding: '3px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.06))' } },
                        el('span', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }, title: p.name }, p.name),
                        el('span', { style: { color: 'var(--dsw-alias-text-accent, #3b82f6)', flex: 'none', marginLeft: '6px' } }, '→ ' + p.latestVersion)
                      )
                    })
                  )
                ),
            popoverMsg
              ? el('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-text-accent, #3b82f6)', marginBottom: '8px', wordBreak: 'break-all' } }, popoverMsg)
              : null,
            el('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '6px' } },
              needsRestart
                ? el('button', {
                    type: 'button',
                    disabled: isUpdating,
                    onClick: handleRestart,
                    style: {
                      background: 'var(--dsw-alias-bg-accent, #2563eb)',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      cursor: isUpdating ? 'default' : 'pointer',
                      fontWeight: 500,
                    }
                  }, isUpdating ? t('restarting') : t('restartNow'))
                : el('button', {
                    type: 'button',
                    disabled: isUpdating,
                    onClick: handleQuickUpdate,
                    style: {
                      background: 'var(--dsw-alias-bg-accent, #2563eb)',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      cursor: isUpdating ? 'default' : 'pointer',
                      fontWeight: 500,
                    }
                  }, isUpdating ? t('updating') : t('updateAll')),
              el('button', {
                type: 'button',
                onClick: needsRestart ? function () { setShowPopover(false) } : openSettings,
                style: {
                  background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))',
                  color: 'var(--dsw-alias-text-primary)',
                  border: '1px solid var(--dsw-alias-border-base, rgba(255,255,255,0.12))',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontSize: '11px',
                  cursor: 'pointer',
                }
              }, needsRestart ? t('restartLater') : t('openSettings'))
            )
          )
        : null

      var popoverNode = (popoverContent && ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined')
        ? ReactDOM.createPortal(popoverContent, document.body)
        : popoverContent

      var indicatorNode = el('div', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          flex: 'none',
          marginLeft: '4px',
        }
      },
        el('button', {
          ref: btnRef,
          type: 'button',
          onClick: function (e) {
            e.stopPropagation()
            setShowPopover(!showPopover)
          },
          title: needsRestart
            ? t('tooltipRestart')
            : t('tooltipUpdates', { count: updatable.length }),
          style: {
            boxSizing: 'border-box',
            height: '28px',
            padding: wide ? '0 8px' : '0 6px',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: needsRestart
              ? 'var(--dsw-alias-interactive-bg-accent, rgba(59,130,246,0.15))'
              : 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))',
            border: needsRestart
              ? '1px solid var(--dsw-alias-border-accent, #3b82f6)'
              : '1px solid var(--dsw-alias-border-base, rgba(255,255,255,0.15))',
            color: needsRestart
              ? 'var(--dsw-alias-text-accent, #3b82f6)'
              : 'var(--dsw-alias-text-primary)',
            fontSize: '11px',
            fontWeight: 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            whiteSpace: 'nowrap',
          }
        },
          el('span', { style: { fontSize: '13px' } }, buttonIcon),
          wide ? el('span', null, buttonText) : null,
          !wide ? el('span', {
            style: {
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: needsRestart ? '#3b82f6' : '#10b981',
              display: 'inline-block'
            }
          }) : null
        ),
        popoverNode
      )

      // Portal into triggerRow right beside the account name "仁者" (the red circle position)
      var targetRow = (typeof document !== 'undefined')
        ? (document.querySelector('div[class*="triggerRow"]') || document.querySelector('[class*="settingsArea"] [class*="triggerRow"]'))
        : null

      if (targetRow && ReactDOM && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(indicatorNode, targetRow)
      }

      return indicatorNode
    }

    // ── plugin definition ────────────────────────────────────────────────────
    exports.name = 'dsh-plugin-updater'
    exports.inject = ['slots', 'configForms', 'locale']

    exports.apply = function (ctx) {
      styles()
      var slots = ctx.get('slots')
      var configForms = ctx.get('configForms')
      var layout = ctx.get('layout')
      var locale = ctx.get('locale')
      if (!slots || typeof slots.inject !== 'function' ||
          !configForms || typeof configForms.get !== 'function' ||
          typeof configForms.whileServed !== 'function') return

      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, DICTS)
        }, 'plugin-updater: dictionaries')
      }

      // The Host-served controller for this bundle. Handed to <Card/> untouched:
      // Card owns the hooks, and the object identity is stable for the life of
      // the page, so useForm()'s subscribe effect never re-runs needlessly.
      var form = configForms.get(NAMESPACE)

      // ── Entrance 1: Plugins Settings Page Card ─────────────────────────────
      ctx.effect(function () {
        return configForms.whileServed([NAMESPACE], function () {
          return slots.inject('plugins.bundle.config', function () {
            return slots.register({
              name: 'plugins.bundle.config',
              key: KEY,
              locale: NS,
              label: function () { return createTranslator(ctx)('cardTitle') },
              priority: -10,
            }, function (props) {
              return el(Card, { form: form, ctx: ctx, t: (props && props.t) || createTranslator(ctx) })
            })
          })
        })
      }, 'plugin-updater: plugins-page card')

      // ── Entrance 2: Global Sidebar Foot Action (beside Account & Settings) ──
      ctx.effect(function () {
        return slots.inject('sidebar.footer.action', function () {
          return slots.register({
            name: 'sidebar.footer.action',
            id: 'plugin-updater-footer-status',
            order: 40,
            locale: NS,
            label: function () { return createTranslator(ctx)('footerLabel') },
          }, function (props) {
            return el(FooterUpdateIndicator, {
              wide: props ? props.wide : true,
              layout: layout,
              ctx: ctx,
              form: form,
              t: (props && props.t) || createTranslator(ctx)
            })
          })
        })
      }, 'plugin-updater: sidebar-footer indicator')
    }

    return module.exports
  },
})
