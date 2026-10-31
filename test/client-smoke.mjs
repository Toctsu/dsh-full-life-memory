/**
 * Client half smoke test: loads client.js with a stubbed module loader, React,
 * slots and configForms, then renders the settings card once in each view.
 * Run: node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const VERSION = pkg.version

// 版本号只能在 package.json 维护；client.js 由 scripts/sync-version.mjs 同步
assert.match(
  source,
  new RegExp(`const CURRENT_VERSION = '${VERSION.replace(/\./g, '\\.')}'`),
  'client.js CURRENT_VERSION must match package.json (run npm run sync-version)',
)

let captured
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
new Function(source)()

assert.ok(captured, 'client.js registers a module')
assert.equal(captured.id, '@tuhengyu/dsh-full-life-memory')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
}

const scope = {
  getSnapshot: () => ({
    value: { forgetThresholdTokens: 12000, forgetTurns: 3, keepCompletedTurns: 5, autoForget: true },
    revision: 7,
    writable: true,
  }),
  subscribe: () => () => {},
  mutate: async () => {},
}

const registrations = []
const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  configForms: { get: (ns) => (ns === 'full-life-memory' ? scope : undefined) },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect: (setup) => setup(),
}

const mod = captured.factory((name) => {
  assert.equal(name, 'react')
  return React
})

assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
mod.apply(ctx)

assert.equal(registrations.length, 2, 'settings section + bundle config page registered')
const section = registrations.find((entry) => entry.options.name === 'settings.section')
const bundle = registrations.find((entry) => entry.options.name === 'plugins.bundle.config')
assert.ok(section, 'registers a settings section')
assert.ok(bundle, 'registers the bundle config page')
assert.equal(section.options.id, 'full-life-memory')
assert.equal(section.options.locale, 'full-life-memory')
assert.equal(bundle.options.key, '@tuhengyu/dsh-full-life-memory')
assert.equal(bundle.options.locale, 'full-life-memory')

const page = bundle.component({ view: 'page', t: (key) => key, ...bundle.options.inject() })
assert.ok(page && page.type === 'div', 'page renders a container')

const sectionPage = section.component({ t: (key) => key, ...section.options.inject() })
assert.ok(sectionPage && sectionPage.type === 'div', 'settings section renders the same form')

const flatten = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node.type === 'function') {
    const child = node.children.length === 1 ? node.children[0] : node.children
    return flatten(node.type({ ...node.props, children: child }))
  }
  return flatten(node.children)
}

const collect = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (typeof node.type === 'function') {
    const child = node.children.length === 1 ? node.children[0] : node.children
    collect(node.type({ ...node.props, children: child }), out)
  } else {
    collect(node.children, out)
  }
  return out
}

const text = flatten(page)
assert.match(text, /threshold/, 'renders the threshold row')
assert.match(text, /autoForget/, 'renders the auto-fold switch')
assert.match(text, /checkUpdate/, 'renders the update check button')
assert.match(text, new RegExp(`v${VERSION.replace(/\./g, '\\.')}`), 'renders the running version')
assert.match(text, /tabGlobal/, 'renders the global tab')
assert.match(text, /tabScenes/, 'renders the scenes tab')

const buttons = collect(page).filter((node) => node.type === 'button')
assert.ok(buttons.some((node) => node.children.includes('checkUpdate')), 'update check is clickable')
assert.ok(buttons.some((node) => node.children.includes('save')), 'save button stays')

const inputs = collect(page).filter((node) => node.type === 'input')
assert.ok(inputs.length >= 3, 'renders one input per number field')
assert.equal(inputs[0].props.value, '12000', 'shows the live threshold value')
assert.equal(inputs[1].props.value, '3', 'shows the live folded-turn count')
assert.equal(inputs[2].props.value, '5', 'shows the live kept-turn count')

// 检查更新走 registry 的 /latest；按钮回调应当请求正确地址
let requested = ''
globalThis.fetch = async (url) => {
  requested = String(url)
  return { ok: true, json: async () => ({ version: '9.9.9' }) }
}
const checkButton = buttons.find((node) => node.children.includes('checkUpdate'))
await checkButton.props.onClick()
assert.equal(requested, 'https://registry.npmjs.org/@tuhengyu%2Fdsh-full-life-memory/latest')

// registry 失败不应该抛到渲染层
globalThis.fetch = async () => ({ ok: false, status: 503 })
await checkButton.props.onClick()

// 场景标签页：用 initialTab 直接渲染场景面板，校验列表与开关文案
scope.getSnapshot = () => ({
  value: {
    forgetThresholdTokens: 12000,
    forgetTurns: 3,
    keepCompletedTurns: 5,
    autoForget: true,
    sceneOverrides: {
      qqbot: { enabled: true, forgetThresholdTokens: 4000, keepCompletedTurns: 1 },
      wechat: { enabled: false },
    },
  },
  revision: 8,
  writable: true,
})
const scenesPage = bundle.component({ view: 'page', initialTab: 'scenes', t: (key) => key, ...bundle.options.inject() })
const scenesText = flatten(scenesPage)
assert.match(scenesText, /qqbot/, 'lists the qqbot scene')
assert.match(scenesText, /wechat/, 'lists the wechat scene')
assert.match(scenesText, /sceneAdd/, 'offers the add-scene control')
assert.match(scenesText, /sceneEnabled/, 'offers the per-scene enable switch')

const summary = bundle.component({ view: 'summary', t: (key) => key })
assert.ok(summary && typeof summary === 'string', 'summary view renders a one-liner')

console.log('client-smoke: OK')
