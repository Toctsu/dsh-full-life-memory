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

      React.useEffect(() => {
        if (!controller) return undefined
        setSnapshot(controller.read())
        return controller.subscribe(() => setSnapshot(controller.read()))
      }, [controller])

      const revision = snapshot && snapshot.revision

      React.useEffect(() => {
        setDraft(null)
      }, [revision])

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

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: color.muted } }, t('description')),
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
                inject: () => ({ controller }),
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
                inject: () => ({ controller }),
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
