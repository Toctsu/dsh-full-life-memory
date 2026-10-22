/**
 * Smoke test for @tuhengyu/dsh-full-life-memory.
 * Run: node test/smoke.mjs [path-to-module]
 * Exercises the real node:sqlite path, the fake ctx contract, and both index.js / index.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const target = process.argv[2] ?? new URL('../index.js', import.meta.url).href
const mod = await import(target)

assert.equal(mod.name, 'full-life-memory')
assert.deepEqual(mod.inject, ['tools'])
assert.equal(typeof mod.apply, 'function')

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(here, '.tmp-flm-'))
const dbPath = join(dir, 'nested', 'memory.db')
const disposers = []
const allDisposers = []

function fakeCtx() {
  let definition
  return {
    ctx: {
      tools: { register: (def) => { definition = def; return () => { definition = undefined } } },
      effect: (setup) => { const dispose = setup(); disposers.push(dispose); allDisposers.push(dispose); return dispose },
      on: () => () => {},
      get: () => undefined,
      logger: { info() {}, warn() {} },
    },
    get definition() { return definition },
  }
}

try {
  // --- path A: index.js -----------------------------------------------------
  const a = fakeCtx()
  mod.apply(a.ctx, { dbPath, limit: 5 })
  const tool = a.definition
  assert.ok(tool, 'tool was registered')
  assert.equal(tool.name, 'recall_from_clues')

  // model-facing schema is real JSON Schema, not the authoring DSL
  assert.deepEqual(tool.parameters.required, ['keyword'])
  assert.equal(tool.parameters.properties.keyword.type, 'string')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(typeof tool.output.render, 'function')

  // miss
  const miss = await tool.execute({ keyword: 'sqlite' })
  assert.equal(miss.found, false)
  assert.equal(miss.count, 0)
  assert.ok(miss.prompt.includes('sqlite'))
  assert.equal(tool.output.render({ keyword: 'sqlite' }, miss)[0].type, 'text')

  // seed 8 clues, one is a different topic
  for (let i = 0; i < 8; i++) {
    mod.rememberClue(dbPath, {
      keywords: i === 7 ? 'rust 生命周期' : `sqlite 线索 ${i}`,
      seedTokens: i === 7 ? '借用检查器' : `第 ${i} 次聊到 token 线索重建`,
      summary: i === 3 ? '决定不做向量库' : undefined,
      createdAt: Date.UTC(2026, 0, 1 + i),
    })
  }

  const hit = await tool.execute({ keyword: 'sqlite' })
  assert.equal(hit.found, true)
  assert.equal(hit.count, 5, 'limit is honored')
  assert.ok(hit.prompt.startsWith('我们之前聊过关于「sqlite」的事。'))
  assert.ok(hit.prompt.includes('线索词：'))
  assert.ok(hit.prompt.includes('残留片段：'))
  assert.ok(!hit.prompt.includes('session_id'), 'raw columns never reach the model')
  assert.deepEqual(Object.keys(hit).sort(), ['count', 'found', 'keyword', 'prompt'])

  // rendered text IS the prompt (this is what the model receives)
  const rendered = tool.output.render({ keyword: 'sqlite' }, hit)
  assert.deepEqual(rendered, [{ type: 'text', text: hit.prompt }])

  // LIKE wildcards are escaped: '%' must not match everything
  const wildcard = await tool.execute({ keyword: '%' })
  assert.equal(wildcard.found, false, 'unescaped LIKE wildcard would match every row')

  // empty keyword rejects
  await assert.rejects(() => tool.execute({ keyword: '   ' }), /non-empty keyword/)

  // summary is searchable and shown as "只记得大概"
  const bySummary = await tool.execute({ keyword: '向量库' })
  assert.equal(bySummary.found, true)
  assert.ok(bySummary.prompt.includes('只记得大概：决定不做向量库'))

  // disposer closes the connection; the next call reopens it
  for (const dispose of disposers.splice(0)) dispose()
  const reopened = await tool.execute({ keyword: 'sqlite' })
  assert.equal(reopened.found, true, 'connection recovers after effect disposal')

  // truncation marker appears when the clue set is longer than the budget
  const b = fakeCtx()
  mod.apply(b.ctx, { dbPath, maxPromptChars: 200 })
  for (let i = 0; i < 5; i++) {
    mod.rememberClue(dbPath, { keywords: `truncation ${i}`, seedTokens: 'x'.repeat(120) })
  }
  const long = await b.definition.execute({ keyword: 'truncation' })
  assert.ok(long.prompt.includes('更早的线索已淡忘'), 'over-budget clues are truncated')

  // --- path B: index.ts (Node type stripping) -------------------------------
  if (target.endsWith('index.js')) {
    const ts = await import(new URL('../index.ts', import.meta.url).href)
    const c = fakeCtx()
    ts.apply(c.ctx, { dbPath, limit: 5 })
    const tsHit = await c.definition.execute({ keyword: 'sqlite' })
    assert.equal(tsHit.count, 5)
    assert.deepEqual(tsHit, (await tool.execute({ keyword: 'sqlite' })))
    console.log('index.ts parity: OK')
  }

  console.log('smoke: OK', target)
} finally {
  // 关闭过程中可能被重新打开的连接，再删临时库
  for (const dispose of allDisposers) {
    try { dispose() } catch { /* already released */ }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL still held on Windows */ }
}
