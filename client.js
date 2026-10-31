/**
 * @tuhengyu/dsh-full-life-memory — 设置页（浏览器半边）
 *
 * 注册到 Plugins 页的 `plugins.bundle.config`（key = 本包名），
 * 通过 `ctx.configForms` 读写 Host 侧 volatile 配置：
 * 触发阈值、每次折叠轮数、最近保留轮数、自动折叠开关。
 *
 * 只依赖 React 与宿主主题变量，不 import 任何 @deepseek-ai 客户端包。
 */
window.__ModuleLoader__.load({
  id: '@tuhengyu/dsh-full-life-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'full-life-memory'
    const PKG = '@tuhengyu/dsh-full-life-memory'

    const zh = {
      title: '终身记忆',
      summary: '达到阈值后把最旧的几轮折成线索并从历史切除。',
      description:
        '上下文快满时，自动把最旧的几轮对话蒸馏成线索（关键词 + 残留片段）并从历史里物理切除；需要时再顺着线索回忆。',
      threshold: '触发阈值（tokens）',
      thresholdHint: '会话估算 token 超过这个值就开始折叠。调低会更早遗忘，调高会保留更多原文。',
      forgetTurns: '每次折叠轮数',
      forgetTurnsHint: '一次切掉最旧的几轮「已完成」对话。',
      keepTurns: '最近保留轮数',
      keepTurnsHint: '无论压力多大，最近这么多轮永远不动。',
      autoForget: '自动折叠',
      autoForgetHint: '关闭后历史不再被切除，只保留手动回忆。',
      condition: '什么时候会触发',
      planText: '达到 {threshold} tokens 时，折叠最旧的 {forget} 轮，最近 {keep} 轮保留。',
      conditionText: '至少需要 {n} 个已完成轮次（折叠 {f} 轮 + 保留 {k} 轮）才会动手；在此之前只观察不处理。',
      scopeText: '改动只影响之后的新轮次；已经折叠的内容不会恢复。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，下一步生效',
      cancel: '取消',
      unavailable: '插件当前未加载，配置暂时不可用。',
      readOnly: '本部署的设置是只读的。',
      checkUpdate: '检查更新',
      checking: '检查中…',
      installNow: '立即更新',
      updating: '下载中…',
      upToDate: '当前已是最新版本',
      restartTitle: '更新已下载',
      restartBody: '新版本 v{v} 已下载完成，请重启 DSH 以应用新版本。',
      restartNeeded: '已下载，重启后生效',
      ok: '知道了',
    }

    const en = {
      title: 'Full-Life Memory',
      summary: 'Folds the oldest turns into clues once the threshold is reached.',
      description:
        'When the context is nearly full, the oldest turns are distilled into clues (keywords + leftover fragments) and physically removed from history. Recall rebuilds the scene later.',
      threshold: 'Trigger threshold (tokens)',
      thresholdHint: 'Start folding once the estimated session size passes this value.',
      forgetTurns: 'Turns folded per run',
      forgetTurnsHint: 'How many completed turns are cut at once.',
      keepTurns: 'Recent turns kept',
      keepTurnsHint: 'The most recent turns are never touched, whatever the pressure.',
      autoForget: 'Fold automatically',
      autoForgetHint: 'Turn off to keep history intact and use manual recall only.',
      condition: 'When it runs',
      planText: 'At {threshold} tokens, fold the oldest {forget} turns and keep the last {keep}.',
      conditionText:
        'At least {n} completed turns are required (fold {f} + keep {k}); until then it only observes.',
      scopeText: 'Changes apply to upcoming turns; already folded history stays folded.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved — applies to the next step',
      cancel: 'Cancel',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      checkUpdate: 'Check for updates',
      checking: 'Checking…',
      installNow: 'Update now',
      updating: 'Downloading…',
      upToDate: 'You are on the latest version',
      restartTitle: 'Update downloaded',
      restartBody: 'Version v{v} has been downloaded. Restart DSH to apply it.',
      restartNeeded: 'Downloaded — applies after restart',
      ok: 'Got it',
    }

    const NUMBERS = [
      { key: 'forgetThresholdTokens', min: 500, max: 200000, step: 500, label: 'threshold', hint: 'thresholdHint' },
      { key: 'forgetTurns', min: 1, max: 10, step: 1, label: 'forgetTurns', hint: 'forgetTurnsHint' },
      { key: 'keepCompletedTurns', min: 0, max: 50, step: 1, label: 'keepTurns', hint: 'keepTurnsHint' },
    ]

    const color = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.42))',
      surface: 'var(--dsw-alias-bg-base, #ffffff)',
      panel: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
      accent: 'var(--dsw-alias-brand-primary, #4f46e5)',
      danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      height: 34,
      padding: '0 10px',
      borderRadius: 8,
      border: `1px solid ${color.border}`,
      background: color.surface,
      color: color.text,
      fontSize: 13,
      outline: 'none',
      fontVariantNumeric: 'tabular-nums',
    }

    function buttonStyle(primary, disabled) {
      return {
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: primary ? '1px solid transparent' : `1px solid ${color.border}`,
        background: primary ? color.accent : 'transparent',
        color: primary ? '#ffffff' : color.text,
        fontSize: 13,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }
    }

    function unwrap(state) {
      if (!state || typeof state !== 'object') return state
      if (typeof state.getSnapshot === 'function') {
        try {
          return state.getSnapshot()
        } catch {
          return undefined
        }
      }
      return state
    }

    /**
     * 把 `ctx.configForms.get(ns)` 或页面给的 `form` 统一成
     * { read, subscribe, write } 三个动作，组件只认这三个。
     */
    function toController(source) {
      if (!source || typeof source !== 'object') return undefined
      const read = () => unwrap(source.state) || unwrap(source)
      const subscribe =
        typeof source.subscribe === 'function'
          ? (fn) => {
              try {
                const dispose = source.subscribe(fn)
                return typeof dispose === 'function' ? dispose : () => {}
              } catch {
                return () => {}
              }
            }
          : (typeof source.state === 'object' && source.state && typeof source.state.subscribe === 'function'
              ? (fn) => {
                  try {
                    const dispose = source.state.subscribe(fn)
                    return typeof dispose === 'function' ? dispose : () => {}
                  } catch {
                    return () => {}
                  }
                }
              : () => () => {})
      const write = (ops, revision) => {
        if (typeof source.mutate === 'function') return source.mutate(ops, revision)
        if (typeof source.write === 'function') return source.write(ops, revision)
        let chain = Promise.resolve()
        for (const op of ops) {
          chain = chain.then(() => (op.op === 'unset' ? source.unset(op.path) : source.set(op.path, op.value)))
        }
        return chain
      }
      return { read, subscribe, write }
    }

    function valuesOf(snapshot) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value : {}
    }

    function numberOr(value, fallback) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    /** 当前正在运行的版本（编译进浏览器模块；升级后需重启才会变）。 */
    const CURRENT_VERSION = '0.3.1'
    const REGISTRY_URL = `https://registry.npmjs.org/${PKG.replace('/', '%2F')}/latest`

    function compareVersions(a, b) {
      const parse = (value) =>
        String(value || '')
          .replace(/^v/i, '')
          .split('+')[0]
          .split('-')[0]
          .split('.')
          .map((part) => Number(part) || 0)
      const left = parse(a)
      const right = parse(b)
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const x = left[index] || 0
        const y = right[index] || 0
        if (x !== y) return x > y ? 1 : -1
      }
      return 0
    }

    /** Remote 调用返回 { ok, value } / { ok:false, error }；这里统一抛错或取值。 */
    function remoteValue(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok) {
          const error = result.error
          const message = error && (error.message || error.code) ? error.message || error.code : 'Remote 调用失败'
          throw new Error(message)
        }
        return result.value
      }
      return result
    }

    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: { fontSize: 13, fontWeight: 500, color: color.text } }, props.label),
        props.children,
        h('span', { style: { fontSize: 12, lineHeight: 1.5, color: color.muted } }, props.hint),
      )
    }

    function Card(props) {
      const t = props.t || ((key) => zh[key] || key)
      const controller = props.controller

      const [snapshot, setSnapshot] = React.useState(() => (controller ? controller.read() : undefined))
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [update, setUpdate] = React.useState({ status: 'idle' })

      React.useEffect(() => {
        if (!controller) return undefined
        setSnapshot(controller.read())
        return controller.subscribe(() => setSnapshot(controller.read()))
      }, [controller])

      const revision = snapshot && snapshot.revision

      React.useEffect(() => {
        setDraft(null)
      }, [revision])

      // “已是最新版本”的轻提示自动消失
      React.useEffect(() => {
        if (update.status !== 'latest') return undefined
        const timer = setTimeout(() => setUpdate({ status: 'idle' }), 2600)
        return () => clearTimeout(timer)
      }, [update.status])

      if (props.view === 'summary') return t('summary')

      if (!controller || !snapshot) {
        return h('div', { style: { fontSize: 13, color: color.muted, padding: '4px 0' } }, t('unavailable'))
      }

      const value = valuesOf(snapshot)
      const writable = snapshot.writable !== false
      const base = {
        forgetThresholdTokens: numberOr(value.forgetThresholdTokens, 8000),
        forgetTurns: numberOr(value.forgetTurns, 2),
        keepCompletedTurns: numberOr(value.keepCompletedTurns, 4),
        autoForget: value.autoForget !== false,
      }
      const current = draft || base
      const minimum = current.forgetTurns + current.keepCompletedTurns
      const changed =
        current.forgetThresholdTokens !== base.forgetThresholdTokens ||
        current.forgetTurns !== base.forgetTurns ||
        current.keepCompletedTurns !== base.keepCompletedTurns ||
        current.autoForget !== base.autoForget

      const edit = (key, next) => setDraft({ ...current, [key]: next })

      const remote = () => (typeof props.remote === 'function' ? props.remote() : props.remote)

      const checkUpdate = async () => {
        setUpdate({ status: 'checking' })
        try {
          let latest = ''
          try {
            const response = await fetch(REGISTRY_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
            const payload = await response.json()
            latest = payload && payload.version ? String(payload.version) : ''
            if (latest === '') throw new Error('registry 未返回 version')
          } catch (directError) {
            // 浏览器被 CORS / CSP 拦住时，用 Host 的 pluginManager 代查
            latest = await inspectLatest(directError)
          }
          setUpdate(
            compareVersions(latest, CURRENT_VERSION) > 0
              ? { status: 'available', latest }
              : { status: 'latest', latest },
          )
        } catch (error) {
          setUpdate({ status: 'error', message: error && error.message ? error.message : String(error) })
        }
      }

      const inspectLatest = async (directError) => {
        const remotes = remote()
        const manager = remotes && remotes.pluginManager
        if (!manager || typeof manager.inspect !== 'function') throw directError
        const value = remoteValue(await manager.inspect(PKG))
        if (value && value.status === 'accepted' && value.version) return String(value.version)
        throw directError
      }

      const installUpdate = async () => {
        const latest = update.latest || ''
        setUpdate({ status: 'updating', latest })
        try {
          const remotes = remote()
          const manager = remotes && remotes.pluginManager
          if (!manager || typeof manager.installBundle !== 'function') {
            throw new Error('当前 DSH 未开放 pluginManager，请在终端执行 pnpm add')
          }
          const result = remoteValue(await manager.installBundle(PKG, { registry: null }))
          if (result && result.error) throw new Error(result.error.diagnostic || result.error.code || '安装失败')
          if (result && result.application === 'failed') {
            throw new Error((result.packageResult && result.packageResult.output) || '安装失败')
          }
          setUpdate({ status: 'restart', latest: (result && result.version) || latest })
        } catch (error) {
          setUpdate({ status: 'error', message: error && error.message ? error.message : String(error) })
        }
      }

      const commit = async () => {
        setBusy(true)
        setNote(null)
        try {
          const ops = []
          for (const field of NUMBERS) {
            if (current[field.key] !== base[field.key]) {
              ops.push({ op: 'set', path: [field.key], value: current[field.key] })
            }
          }
          if (current.autoForget !== base.autoForget) {
            ops.push({ op: 'set', path: ['autoForget'], value: current.autoForget })
          }
          if (ops.length > 0) await controller.write(ops, revision)
          setDraft(null)
          setNote({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setNote({ kind: 'error', text: error && error.message ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const rows = NUMBERS.map((field) =>
        h(
          Field,
          { key: field.key, label: t(field.label), hint: t(field.hint) },
          h('input', {
            type: 'number',
            inputMode: 'numeric',
            min: field.min,
            max: field.max,
            step: field.step,
            value: String(current[field.key]),
            disabled: busy || !writable,
            onChange: (event) => {
              const parsed = Number(event.target.value)
              edit(field.key, Number.isFinite(parsed) ? parsed : 0)
            },
            style: inputStyle,
          }),
        ),
      )

      const switchRow = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('span', { style: { fontSize: 13, fontWeight: 500, color: color.text } }, t('autoForget')),
          h(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': current.autoForget ? 'true' : 'false',
              disabled: busy || !writable,
              onClick: () => edit('autoForget', !current.autoForget),
              style: {
                width: 40,
                height: 22,
                borderRadius: 999,
                border: `1px solid ${current.autoForget ? 'transparent' : color.borderStrong}`,
                background: current.autoForget ? color.accent : 'transparent',
                cursor: busy || !writable ? 'default' : 'pointer',
                padding: 0,
                position: 'relative',
                transition: 'background .15s ease',
              },
            },
            h('span', {
              style: {
                position: 'absolute',
                top: 2,
                left: current.autoForget ? 20 : 2,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: current.autoForget ? '#ffffff' : color.muted,
                transition: 'left .15s ease',
              },
            }),
          ),
        ),
        h('span', { style: { fontSize: 12, lineHeight: 1.5, color: color.muted } }, t('autoForgetHint')),
      )

      const facts = h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            borderRadius: 10,
            background: color.panel,
            border: `1px solid ${color.border}`,
          },
        },
        h(
          'div',
          { style: { fontSize: 12, fontWeight: 600, letterSpacing: '.02em', color: color.muted } },
          t('condition'),
        ),
        h(
          'div',
          { style: { fontSize: 13, lineHeight: 1.6, color: color.text } },
          t('planText')
            .replace('{threshold}', String(current.forgetThresholdTokens))
            .replace('{forget}', String(current.forgetTurns))
            .replace('{keep}', String(current.keepCompletedTurns)),
        ),
        h(
          'div',
          { style: { fontSize: 12, lineHeight: 1.6, color: color.muted } },
          t('conditionText')
            .replace('{n}', String(minimum))
            .replace('{f}', String(current.forgetTurns))
            .replace('{k}', String(current.keepCompletedTurns)),
        ),
      )

      const canCheck = update.status !== 'checking' && update.status !== 'updating'

      const versionPanel = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${color.border}`,
            fontSize: 12,
            color: color.muted,
          },
        },
        h('span', null, `v${CURRENT_VERSION}`),
        update.status === 'available' && update.latest
          ? h('span', { style: { color: color.text } }, `→ v${update.latest}`)
          : null,
        update.status === 'restart' && update.latest
          ? h('span', { style: { color: color.success } }, `→ v${update.latest}`)
          : null,
        h(
          'button',
          { type: 'button', disabled: !canCheck, onClick: checkUpdate, style: buttonStyle(false, !canCheck) },
          update.status === 'checking' ? t('checking') : t('checkUpdate'),
        ),
        update.status === 'available'
          ? h(
              'button',
              { type: 'button', onClick: installUpdate, style: buttonStyle(true, false) },
              t('installNow'),
            )
          : null,
        update.status === 'updating' ? h('span', null, t('updating')) : null,
        update.status === 'restart' ? h('span', { style: { color: color.success } }, t('restartNeeded')) : null,
        update.status === 'error' && update.message
          ? h('span', { style: { color: color.danger, overflow: 'hidden', textOverflow: 'ellipsis' } }, update.message)
          : null,
      )

      const toast =
        update.status === 'latest'
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  top: 24,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 1000,
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: color.text,
                  color: color.surface,
                  fontSize: 12,
                  boxShadow: '0 8px 28px rgba(0,0,0,.22)',
                },
              },
              t('upToDate'),
            )
          : null

      const modal =
        update.status === 'restart'
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1001,
                  background: 'rgba(0,0,0,.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                },
              },
              h(
                'div',
                {
                  style: {
                    width: 440,
                    maxWidth: '100%',
                    borderRadius: 14,
                    background: color.surface,
                    color: color.text,
                    border: `1px solid ${color.border}`,
                    boxShadow: '0 24px 64px rgba(0,0,0,.32)',
                    padding: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  },
                },
                h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('restartTitle')),
                h(
                  'div',
                  { style: { fontSize: 13, lineHeight: 1.7, color: color.muted } },
                  t('restartBody').replace('{v}', String(update.latest || '')),
                ),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end' } },
                  h(
                    'button',
                    { type: 'button', onClick: () => setUpdate({ status: 'idle' }), style: buttonStyle(true, false) },
                    t('ok'),
                  ),
                ),
              ),
            )
          : null

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: color.muted } }, t('description')),
        versionPanel,
        facts,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, ...rows, switchRow),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy || !writable || !changed,
              onClick: commit,
              style: buttonStyle(true, busy || !writable || !changed),
            },
            busy ? t('saving') : t('save'),
          ),
          changed
            ? h(
                'button',
                { type: 'button', disabled: busy, onClick: () => setDraft(null), style: buttonStyle(false, busy) },
                t('cancel'),
              )
            : null,
          note
            ? h(
                'span',
                {
                  style: {
                    fontSize: 12,
                    color: note.kind === 'error' ? color.danger : color.success,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                note.text,
              )
            : null,
        ),
        h('div', { style: { fontSize: 12, lineHeight: 1.5, color: color.muted } }, t('scopeText')),
        toast,
        modal,
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'full-life-memory: dictionaries')

      let controller
      try {
        controller = toController(ctx.configForms.get(NS))
      } catch {
        controller = undefined
      }

      const page = (props) => Card({ ...props, t: props.t || t })

      // 1) Settings 面板里的独立页面
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'full-life-memory',
                order: 25,
                label: () => t('title'),
                locale: NS,
                inject: () => ({ controller, remote: () => ctx.remote }),
              },
              page,
            ),
          ),
        'full-life-memory: settings section',
      )

      // 2) Plugins 页里本插件详情页上的配置区（DSH 的插件配置约定位置）
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: PKG,
                locale: NS,
                inject: () => ({ controller, remote: () => ctx.remote }),
              },
              page,
            ),
          ),
        'full-life-memory: settings page',
      )
    }

    return { inject: ['slots', 'locale', 'configForms'], apply }
  },
})
