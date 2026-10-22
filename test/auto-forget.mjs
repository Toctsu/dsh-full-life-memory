/**
 * Phase 2 (auto-forget) test.
 * Uses a fake Session that mimics the DSH surface contract:
 *   surface.nodes / snapshotEvents() / eventAt() / deriveEventMessage() / append(type,data,{surfaceOp,sourceEventSeqs})
 * Run: node test/auto-forget.mjs
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? new URL('../index.js', import.meta.url).href
const mod = await import(target)

const dir = mkdtempSync(join(here, '.tmp-auto-'))
const dbPath = join(dir, 'memory.db')

const SYSTEM = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }], source: { kind: 'system-prompt' } }

/**
 * Build a session log. Each turn: user → assistant(tool-call) → tool/result → turn/end.
 * `brokenTurn` makes that turn's assistant message call two tools but only answer one.
 */
function buildSession({ turns, toolPairs = 1, brokenTurn = -1, compactionOpen = false }) {
  const log = []
  const nodes = []
  const push = (type, data, extra) => {
    const event = { type, seq: log.length, time: 0, data, ...(extra ?? {}) }
    log.push(event)
    return event
  }
  const surface = (type) => type === 'user/message' || type === 'assistant/message' || type === 'tool/result' || type === 'system/message'

  push('system/message', { turn: 0, step: 0, message: SYSTEM })
  nodes.push(0)
  if (compactionOpen) push('compaction/start', {})

  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    const user = push('user/message', {
      id: `u${turn}`,
      role: 'user',
      content: [{
        type: 'text',
        text: `第${turn}轮：帮我改 E:/Fishwork/app.ts 的 recall_from_clues 逻辑，别用向量库`,
      }],
      source: { kind: 'user' },
    })
    nodes.push(user.seq)

    const broken = turn === brokenTurn
    const calls = broken ? 2 : toolPairs
    const blocks = [{ type: 'text', text: '先读文件再改。' }]
    for (let i = 0; i < calls; i += 1) blocks.push({ type: 'tool-call', id: `c${turn}-${i}`, name: 'read', arguments: '{}' })
    const assistant = push('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: { id: `a${turn}`, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' } },
    })
    nodes.push(assistant.seq)

    const answers = broken ? 1 : calls
    for (let i = 0; i < answers; i += 1) {
      const result = push('tool/result', {
        turn,
        step: 1,
        message: {
          id: `t${turn}-${i}`,
          role: 'tool',
          toolCallId: `c${turn}-${i}`,
          content: [{ type: 'text', text: `第${turn}轮结论：把 ${turn} 号线索写进 memory_clues` }],
          source: { kind: 'tool', callId: `c${turn}-${i}` },
        },
      })
      nodes.push(result.seq)
    }
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  const session = {
    id: 'sess-1',
    get surface() { return { nodes: [...nodes] } },
    snapshotEvents() { return log },
    eventAt(seq) { return log[seq] },
    deriveEventMessage(event) {
      if (!event) return null
      if (event.type === 'user/message') return event.data
      if (event.type === 'system/message') return event.data.message
      if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message
      return null
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: 0, data, ...(opts ?? {}) }
      log.push(event)
      if (!surface(type)) return event
      const op = opts?.surfaceOp
      if (op && typeof op === 'object' && op.op === 'replace') {
        const startIdx = nodes.indexOf(op.startSeq)
        const endIdx = nodes.indexOf(op.endSeq)
        assert.notEqual(startIdx, -1, 'replace startSeq must be on the surface')
        assert.notEqual(endIdx, -1, 'replace endSeq must be on the surface')
        assert.ok(startIdx <= endIdx, 'replace range must not be reversed')
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
      } else {
        nodes.push(event.seq)
      }
      return event
    },
  }
  return session
}

const disposers = []

function fakeCtx(tokens) {
  const handlers = new Map()
  const tools = []
  const warnings = []
  return {
    ctx: {
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      effect: (setup) => { const dispose = setup(); disposers.push(dispose); return dispose },
      on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
      get: (name) => (name === 'tokenMeter'
        ? { measure: () => ({ totalTokens: tokens }) }
        : undefined),
      logger: { info() {}, warn: (message) => warnings.push(message) },
    },
    handlers,
    tools,
    warnings,
  }
}

function rows(database) {
  if (!existsSync(database)) return []
  const db = new DatabaseSync(database)
  try {
    return db.prepare('select id, session_id, keywords, seed_tokens, summary from memory_clues order by id').all()
  } finally {
    db.close()
  }
}

const next = async () => ({ kind: 'enter', messages: [] })
const run = (handlers, payload) => handlers.get('agent/pre-step')(payload, next)

/** Mask random identities so two runs can be compared field by field. */
function shape(events) {
  return events.map((event) => {
    if (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') {
      return {
        type: event.type,
        surfaceOp: event.surfaceOp,
        sourceEventSeqs: event.sourceEventSeqs,
        role: event.data.role,
        sourceKind: event.data.source.kind,
        text: event.data.content[0].text,
      }
    }
    if (event.type === 'compaction/summary') {
      return {
        type: event.type,
        summary: event.data.summary,
        shadowedRange: event.data.shadowedRange,
        shadowedSeqs: event.data.shadowedSeqs,
        shadowedTokenCount: event.data.shadowedTokenCount,
        provider: event.data.provider,
        model: event.data.model,
      }
    }
    if (event.type === 'compaction/start' || event.type === 'compaction/end') {
      return { type: event.type, turn: event.data.turn }
    }
    return { type: event.type }
  })
}

function compactionOpenAfter(events) {
  let active = false
  for (const event of events) {
    if (event.type === 'compaction/start') active = true
    else if (event.type === 'compaction/end') active = false
  }
  return active
}

try {
  // ---------------------------------------------------------------- 阈值以下
  {
    const session = buildSession({ turns: 7 })
    const before = session.surface.nodes.length
    const logBefore = session.snapshotEvents().length
    const { ctx, handlers } = fakeCtx(1000)
    mod.apply(ctx, { dbPath, autoForget: true, forgetThresholdTokens: 8000 })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, before, 'below threshold: nothing is cut')
    assert.equal(session.snapshotEvents().length, logBefore, 'below threshold: no events appended')
    assert.equal(rows(dbPath).length, 0, 'below threshold: nothing is stored')
  }

  // ------------------------------------------------------------ 到达阈值：切
  {
    const session = buildSession({ turns: 7, toolPairs: 1 })
    const before = session.surface.nodes.length
    const logBefore = session.snapshotEvents().length
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath, autoForget: true, forgetThresholdTokens: 8000, forgetTurns: 2, keepCompletedTurns: 4 })

    const result = await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.deepEqual(result, { kind: 'enter', messages: [] }, 'hook always continues the step')

    // 每轮 3 个 surface 节点（user / assistant / tool-result）；切 2 轮 = 6 个节点换 1 个
    assert.equal(session.surface.nodes.length, before - 6 + 1, 'two turns replaced by one node')
    assert.equal(compactionOpenAfter(session.snapshotEvents()), false, 'the compaction transaction is closed')

    // 追加事件：start → summary → 替换消息 → end，和 DSH compaction 同一套词汇
    const appended = session.snapshotEvents().slice(logBefore)
    assert.deepEqual(appended.map((event) => event.type), [
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    const [start, summary, message, end] = appended
    assert.equal(typeof start.data.compactionId, 'string')
    assert.equal(start.data.turn, 7)
    assert.equal(summary.data.compactionId, start.data.compactionId)
    assert.equal(end.data.compactionId, start.data.compactionId)
    assert.equal(end.data.turn, 7)
    assert.deepEqual(summary.data.shadowedRange, { start: 2, end: 9 })
    assert.deepEqual(summary.data.shadowedSeqs, [2, 3, 4, 7, 8, 9])
    assert.ok(summary.data.shadowedTokenCount > 0, 'a token figure is reported for the folded span')
    assert.equal(summary.data.summary[0].type, 'text')
    assert.match(summary.data.summary[0].text, /🧠 记忆已折叠/)
    assert.match(summary.data.summary[0].text, /2 轮/)
    assert.equal(message.data.source.kind, 'compact-checkpoint')
    assert.equal(message.data.source.compactionId, start.data.compactionId)
    assert.equal(message.data.content[0].text, summary.data.summary[0].text, 'UI and model see the same sentence')

    // replace 是就地替换：新节点落在被切区间的起始位置
    const noticeSeq = session.surface.nodes[1]
    const notice = session.eventAt(noticeSeq)
    assert.equal(notice.type, 'user/message')
    assert.deepEqual(notice.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 9 }, 'replace op addresses the exact span')

    // 系统提示仍是 surface 头节点，第 1、2 轮已从面上消失
    const head = session.eventAt(session.surface.nodes[0])
    assert.equal(head.type, 'system/message')
    const survivingUserTurns = session.surface.nodes
      .map((seq) => session.eventAt(seq))
      .filter((event) => event.type === 'user/message' && event.data.id !== notice.data.id)
      .map((event) => Number(event.data.id.slice(1)))
    assert.ok(!survivingUserTurns.includes(1) && !survivingUserTurns.includes(2), 'turns 1-2 left the surface')
    assert.ok(survivingUserTurns.includes(3) && survivingUserTurns.includes(7), 'later turns are intact')

    // 线索落库：关键词里有文件名与英文标识符，seed 片段非空
    const stored = rows(dbPath)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].session_id, 'sess-1')
    assert.match(stored[0].keywords, /app\.ts/)
    assert.match(stored[0].keywords, /recall_from_clues/)
    assert.ok(stored[0].seed_tokens.length > 0)
    assert.ok(stored[0].summary.length > 0)

    // 同一轮再触发：不再切（每轮最多一次）
    const afterFirst = session.surface.nodes.length
    const logAfterFirst = session.snapshotEvents().length
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 2, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, afterFirst, 'at most one cut per turn')
    assert.equal(session.snapshotEvents().length, logAfterFirst, 'no second transaction')
    assert.equal(rows(dbPath).length, 1)

    // 下一轮：只剩 5 个完成轮 < 6（keep 4 + forget 2），因此不再切
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 8, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, afterFirst, 'recent tail is protected')
    assert.equal(rows(dbPath).length, 1)
  }

  // -------------------------------------------------- 与 compaction 的锁互斥
  {
    const session = buildSession({ turns: 7, compactionOpen: true })
    const before = session.surface.nodes.length
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: dbPath + '.lock', autoForget: true, forgetThresholdTokens: 8000 })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, before, 'an open compaction/start blocks the cut')
  }

  // ------------------------------------------------------ 不平衡区间不切
  {
    const session = buildSession({ turns: 7, brokenTurn: 2 })
    const before = session.surface.nodes.length
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: dbPath + '.broken', autoForget: true, forgetThresholdTokens: 8000 })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, before, 'a span splitting a tool pair is refused')
  }

  // ------------------------------------------------ 落库失败不留半截事务
  {
    const session = buildSession({ turns: 7 })
    const before = session.surface.nodes.length
    const logBefore = session.snapshotEvents().length
    const { ctx, handlers, warnings } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: 'Z:/definitely-missing-drive/memory.db', autoForget: true, forgetThresholdTokens: 8000 })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, before, 'a storage failure leaves the surface untouched')
    assert.equal(session.snapshotEvents().length, logBefore, 'a storage failure opens no compaction transaction')
    assert.ok(warnings.some((line) => /forget skipped/.test(line)), 'the failure is reported through the logger')
  }

  // --------------------------------------------------- selectForgettableSpan
  {
    const session = buildSession({ turns: 7 })
    const span = mod.selectForgettableSpan(session, { forgetTurns: 2, keepCompletedTurns: 4 })
    assert.deepEqual(span.turns, [1, 2])
    assert.deepEqual(span.shadowedSeqs, [2, 3, 4, 7, 8, 9])
    assert.equal(span.startSeq, 2)
    assert.equal(span.endSeq, 9)
    assert.equal(mod.selectForgettableSpan(session, { forgetTurns: 4, keepCompletedTurns: 4 }), null, 'not enough completed turns')
  }

  // ------------------------------------------------------------- 蒸馏可读性
  {
    const clue = mod.extractClue([
      '第1轮：帮我改 E:/Fishwork/app.ts 的 recall_from_clues 逻辑，别用向量库',
      '结论：用 node:sqlite，windows 下注意 WAL',
    ])
    assert.ok(clue.keywords.some((word) => word.endsWith('app.ts')), 'file path survives as a clue')
    assert.ok(clue.keywords.some((word) => /recall_from_clues/.test(word)))
    assert.ok(clue.keywords.length <= 8)
    assert.ok(clue.seedTokens.length >= 1 && clue.seedTokens.length <= 4)
    assert.ok(clue.summary.length <= 60)
  }

  // --------------------------------------------- index.ts / index.js 行为对拍
  if (target.endsWith('index.js')) {
    const ts = await import(new URL('../index.ts', import.meta.url).href)

    const once = async (api, suffix) => {
      const session = buildSession({ turns: 7 })
      const { ctx, handlers } = fakeCtx(9000)
      const database = `${dbPath}.${suffix}.db`
      api.apply(ctx, { dbPath: database, autoForget: true, forgetThresholdTokens: 8000 })
      const logBefore = session.snapshotEvents().length
      await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
      return {
        events: shape(session.snapshotEvents().slice(logBefore)),
        nodes: session.surface.nodes,
        clues: rows(database).map((row) => ({ session_id: row.session_id, keywords: row.keywords, seed_tokens: row.seed_tokens, summary: row.summary })),
      }
    }

    const compiled = await once(mod, 'js')
    const source = await once(ts, 'ts')
    assert.deepEqual(source.events, compiled.events, 'index.ts and index.js emit identical events')
    assert.deepEqual(source.nodes, compiled.nodes, 'index.ts and index.js cut the same surface span')
    assert.deepEqual(source.clues, compiled.clues, 'index.ts and index.js store the same clue')
    console.log('index.ts parity: OK')
  }

  console.log('auto-forget: OK', target)
} finally {
  for (const dispose of disposers.splice(0)) {
    try { dispose() } catch { /* already released */ }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL still held on Windows */ }
}
