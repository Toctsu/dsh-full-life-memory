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

const inputs = collect(page).filter((node) => node.type === 'input')
assert.ok(inputs.length >= 3, 'renders one input per number field')
assert.equal(inputs[0].props.value, '12000', 'shows the live threshold value')
assert.equal(inputs[1].props.value, '3', 'shows the live folded-turn count')
assert.equal(inputs[2].props.value, '5', 'shows the live kept-turn count')

const summary = bundle.component({ view: 'summary', t: (key) => key })
assert.ok(summary && typeof summary === 'string', 'summary view renders a one-liner')

console.log('client-smoke: OK')
