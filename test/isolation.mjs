/**
 * Phase 3：群聊按发送者隔离记忆。
 * 覆盖：发送者识别、折叠分组、召回过滤、旧库迁移、识别失败降级。
 * Run: node test/isolation.mjs
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const target = new URL('../index.js', import.meta.url).href
const mod = await import(target)

const dir = mkdtempSync(join(here, '.tmp-iso-'))
const dbPath = join(dir, 'memory.db')
const disposers = []

const SYSTEM = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYSTEM' }], source: { kind: 'system-prompt' } }

/** 每轮：user(text) → assistant(reply) → tool/result → turn/end。 */
function buildSession({ turns, header = { agentPreset: 'qqbot' }, textFor = (turn) => `[User: 10001] 第${turn}轮` }) {
  const log = []
  const nodes = []
  const push = (type, data) => {
    const event = { type, seq: log.length, time: 0, data }
    log.push(event)
    return event
  }
  const surface = (type) => type === 'user/message' || type === 'assistant/message' || type === 'tool/result' || type === 'system/message'

  push('system/message', { turn: 0, step: 0, message: SYSTEM })
  nodes.push(0)

  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    const user = push('user/message', {
      id: `u${turn}`,
      role: 'user',
      content: [{ type: 'text', text: textFor(turn) }],
      source: { kind: 'user' },
    })
    nodes.push(user.seq)

    const assistant = push('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: {
        id: `a${turn}`,
        role: 'assistant',
        content: [
          { type: 'text', text: `第${turn}轮回复` },
          { type: 'tool-call', id: `c${turn}`, name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    })
    nodes.push(assistant.seq)

    const result = push('tool/result', {
      turn,
      step: 1,
      message: {
        id: `t${turn}`,
        role: 'tool',
        toolCallId: `c${turn}`,
        content: [{ type: 'text', text: `第${turn}轮工具结果` }],
        source: { kind: 'tool', callId: `c${turn}` },
      },
    })
    nodes.push(result.seq)
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return {
    id: header?.id ?? 'sess-1',
    header,
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
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
      } else {
        nodes.push(event.seq)
      }
      return event
    },
  }
}

function fakeCtx(tokens) {
  const handlers = new Map()
  const tools = []
  return {
    ctx: {
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      effect: (setup) => { const dispose = setup(); disposers.push(dispose); return dispose },
      on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
      get: (name) => (name === 'tokenMeter' ? { measure: () => ({ totalTokens: tokens }) } : undefined),
      logger: { info() {}, warn() {} },
    },
    handlers,
    tools,
  }
}

const next = async () => ({ kind: 'enter', messages: [] })
const run = (handlers, payload) => handlers.get('agent/pre-step')(payload, next)

function rows(database) {
  if (!existsSync(database)) return []
  const db = new DatabaseSync(database)
  try {
    return db.prepare('select id, session_id, user_id, scene, keywords, seed_tokens from memory_clues order by id').all()
  } finally {
    db.close()
  }
}

const A = '[User: 10001]'
const B = '[User: 20002]'

try {
  // ------------------------------------------------------------ 发送者识别
  {
    assert.equal(mod.extractSenderId(`${A} 我的猫叫豆豆`), '10001')
    assert.equal(mod.extractSenderId('[用户: 998877] 在吗'), '998877')
    assert.equal(mod.extractSenderId('小明(123456): 你好'), '123456')
    assert.equal(mod.extractSenderId('qq: 10002 在吗'), '10002')
    // AstrBot 常见的「昵称: 内容」
    assert.equal(mod.extractSenderId('小明: 我的猫叫豆豆'), '小明')
    assert.equal(mod.extractSenderId('[小红]: 在吗'), '小红')
    // 常见词不当成昵称，时间不当成昵称
    assert.equal(mod.extractSenderId('注意: 明天开会'), undefined)
    assert.equal(mod.extractSenderId('12:30 开会'), undefined)
    assert.equal(mod.extractSenderId('没有前缀的普通消息'), undefined)
    assert.equal(mod.extractSenderId(''), undefined)
    // 写坏的正则不会让插件崩，直接跳过
    assert.equal(mod.extractSenderId(`${A} hi`, ['([', '\\[User:\\s*(\\d+)\\]']), '10001')
  }

  // ------------------------------------------- 合并消息逐行归属 + 前缀清洗
  {
    const merged = '小明: 我的猫叫豆豆\n小红: 我的狗叫旺财'
    const segments = mod.splitBySender(merged)
    assert.deepEqual(segments.map((segment) => segment.sender), ['小明', '小红'])
    assert.deepEqual(segments.map((segment) => segment.text), ['小明: 我的猫叫豆豆', '小红: 我的狗叫旺财'])
  }

  // ------------------------------------------------- 前缀 / CQ 码不进线索词
  {
    const cleaned = mod.cleanForClues('[CQ:at,qq=999] [User: 10001] 我的猫叫豆豆')
    assert.ok(!cleaned.includes('CQ'), 'CQ codes are stripped')
    assert.ok(!cleaned.includes('10001'), 'sender prefix is stripped')
    assert.match(cleaned, /豆豆/)
  }

  // -------------------------------------------------------- 折叠按人分组
  {
    const session = buildSession({
      turns: 7,
      textFor: (turn) => (turn % 2 === 1 ? `${A} 第${turn}轮 我的猫叫豆豆` : `${B} 第${turn}轮 我的狗叫旺财`),
    })
    const before = session.surface.nodes.length
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath, autoForget: true, forgetThresholdTokens: 8000, isolateByUser: true })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(session.surface.nodes.length, before - 6 + 1, 'two turns folded')

    // 最后一轮是 A（turn 7），折叠的是 turn 1(A) 和 turn 2(B)
    const stored = rows(dbPath)
    assert.equal(stored.length, 2, 'one row per speaker group')
    const mine = stored.find((row) => row.user_id === '10001')
    const shared = stored.find((row) => row.user_id === null)
    assert.ok(mine, 'current speaker gets a private row')
    assert.ok(shared, 'other speaker lands in the shared row')
    assert.match(mine.keywords, /豆豆/)
    assert.doesNotMatch(mine.keywords, /旺财/)
    assert.match(shared.keywords, /旺财/)
    assert.doesNotMatch(shared.keywords, /豆豆/)
  }

  // -------------------------------------- 合并消息：逐行归属，不整条算给第一个人
  {
    const session = buildSession({
      turns: 7,
      textFor: (turn) => {
        if (turn === 1) return '小明: 我的猫叫豆豆\n小红: 我的狗叫旺财'
        if (turn === 7) return '小红: 在吗'
        return turn % 2 === 1 ? `${A} 第${turn}轮` : `${B} 第${turn}轮`
      },
    })
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: dbPath + '.merged', autoForget: true, forgetThresholdTokens: 8000, isolateByUser: true })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })

    const stored = rows(dbPath + '.merged')
    const mine = stored.find((row) => row.user_id === '小红')
    const shared = stored.find((row) => row.user_id === null)
    assert.ok(mine, 'last line of a merged message is the current speaker')
    assert.match(mine.keywords, /旺财/)
    assert.doesNotMatch(mine.keywords, /豆豆/)
    assert.ok(shared)
    assert.match(shared.keywords, /豆豆/)
  }

  // ------------------------------- 多会话互不吞折叠（lastCutTurn 按会话记录）
  {
    const first = buildSession({ turns: 7, header: { agentPreset: 'qqbot' } })
    const second = buildSession({ turns: 7, header: { agentPreset: 'qqbot' } })
    const firstBefore = first.surface.nodes.length
    const secondBefore = second.surface.nodes.length
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: dbPath + '.multi', autoForget: true, forgetThresholdTokens: 8000 })
    await run(handlers, { agent: { id: 's1', session: first }, turn: 7, step: 1, signal: { aborted: false } })
    await run(handlers, { agent: { id: 's2', session: second }, turn: 7, step: 1, signal: { aborted: false } })
    assert.equal(first.surface.nodes.length, firstBefore - 6 + 1, 'first session folds')
    assert.equal(second.surface.nodes.length, secondBefore - 6 + 1, 'second session folds at the same turn number')
  }

  // ------------------------------------------- othersAsGlobal=false 直接跳过
  {
    const session = buildSession({
      turns: 7,
      textFor: (turn) => (turn % 2 === 1 ? `${A} 第${turn}轮 豆豆` : `${B} 第${turn}轮 旺财`),
    })
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, {
      dbPath: dbPath + '.skip',
      autoForget: true,
      forgetThresholdTokens: 8000,
      isolateByUser: true,
      othersAsGlobal: false,
    })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    const stored = rows(dbPath + '.skip')
    assert.equal(stored.length, 1, 'only the current speaker is stored')
    assert.equal(stored[0].user_id, '10001')
  }

  // ------------------------------------------------------ 召回按人过滤
  {
    const asUser = (prefix) => buildSession({ turns: 1, textFor: () => `${prefix} 我是谁` })
    const recallCtx = fakeCtx(0)
    mod.apply(recallCtx.ctx, { dbPath, autoForget: true, forgetThresholdTokens: 8000, isolateByUser: true })
    const recall = recallCtx.tools[0]

    const mine = await recall.execute({ keyword: '豆豆' }, { agent: { session: asUser(A) } })
    assert.equal(mine.found, true, 'A can recall A memory')

    const other = await recall.execute({ keyword: '豆豆' }, { agent: { session: asUser(B) } })
    assert.equal(other.found, false, 'B cannot recall A private memory')

    const shared = await recall.execute({ keyword: '旺财' }, { agent: { session: asUser(B) } })
    assert.equal(shared.found, true, 'B can recall the shared memory')

    const globalOnly = await recall.execute({ keyword: '旺财', scope: 'global' }, { agent: { session: asUser(A) } })
    assert.equal(globalOnly.found, true, 'scope=global searches shared rows')

    const globalMiss = await recall.execute({ keyword: '豆豆', scope: 'global' }, { agent: { session: asUser(A) } })
    assert.equal(globalMiss.found, false, 'scope=global skips private rows')

    // 识别不出发送者 → 退化为全局查询，不报错
    const anonymous = buildSession({ turns: 1, textFor: () => '没有前缀' })
    const fallback = await recall.execute({ keyword: '豆豆' }, { agent: { session: anonymous } })
    assert.equal(fallback.found, true, 'unknown sender falls back to global search')
  }

  // ------------------------------------------------------ 场景映射兜底
  {
    const session = buildSession({ turns: 7, header: { id: 'qq-7788' } })
    // 没有 agentPreset，但会话 id 带了平台前缀
    assert.equal(mod.sceneOf(session, {}), 'default')
    assert.equal(mod.sceneOf(session, { '^qq-': 'qqbot' }), 'qqbot')

    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, {
      dbPath: dbPath + '.map',
      autoForget: true,
      forgetThresholdTokens: 8000,
      sceneMap: { '^qq-': 'qqbot' },
      sceneOverrides: { qqbot: { forgetThresholdTokens: 5000 } },
    })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })
    assert.ok(rows(dbPath + '.map').length > 0, 'sceneMap maps the session and the override applies')
    assert.equal(rows(dbPath + '.map')[0].scene, 'qqbot', 'rows carry the resolved scene')
  }

  // ------------------------------------------- isolationScope: user+scene
  {
    const qq = buildSession({ turns: 7, header: { agentPreset: 'qqbot' }, textFor: () => `${A} 我的猫叫豆豆` })
    const applyCtx = fakeCtx(9000)
    mod.apply(applyCtx.ctx, {
      dbPath: dbPath + '.scope',
      autoForget: true,
      forgetThresholdTokens: 8000,
      isolateByUser: true,
      isolationScope: 'user+scene',
    })
    await run(applyCtx.handlers, { agent: { id: 's1', session: qq }, turn: 7, step: 1, signal: { aborted: false } })

    const recallCtx = fakeCtx(0)
    mod.apply(recallCtx.ctx, {
      dbPath: dbPath + '.scope',
      autoForget: true,
      isolateByUser: true,
      isolationScope: 'user+scene',
    })
    const recall = recallCtx.tools[0]

    const sameScene = buildSession({ turns: 1, header: { agentPreset: 'qqbot' }, textFor: () => `${A} 我是谁` })
    const otherScene = buildSession({ turns: 1, header: { agentPreset: 'wechat' }, textFor: () => `${A} 我是谁` })
    assert.equal((await recall.execute({ keyword: '豆豆' }, { agent: { session: sameScene } })).found, true)
    assert.equal(
      (await recall.execute({ keyword: '豆豆' }, { agent: { session: otherScene } })).found,
      false,
      'user+scene keeps scenes apart',
    )

    // 默认的 user 粒度则跨场景可见
    const looseCtx = fakeCtx(0)
    mod.apply(looseCtx.ctx, {
      dbPath: dbPath + '.scope',
      autoForget: true,
      isolateByUser: true,
    })
    const loose = looseCtx.tools[0]
    assert.equal(
      (await loose.execute({ keyword: '豆豆' }, { agent: { session: otherScene } })).found,
      true,
      'default user scope shares across scenes',
    )
  }

  // ---------------------------------------------------------- 旧库迁移
  {
    const legacyPath = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`
      CREATE TABLE memory_clues (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT,
        created_at  INTEGER NOT NULL,
        keywords    TEXT NOT NULL,
        seed_tokens TEXT NOT NULL,
        summary     TEXT
      )
    `)
    legacy
      .prepare('INSERT INTO memory_clues (session_id, created_at, keywords, seed_tokens) VALUES (?, ?, ?, ?)')
      .run('old', Date.now(), '旧线索', '旧片段')
    legacy.close()

    const session = buildSession({ turns: 7, textFor: (turn) => `${A} 第${turn}轮 豆豆` })
    const { ctx, handlers } = fakeCtx(9000)
    mod.apply(ctx, { dbPath: legacyPath, autoForget: true, forgetThresholdTokens: 8000, isolateByUser: true })
    await run(handlers, { agent: { id: 'sess-1', session }, turn: 7, step: 1, signal: { aborted: false } })

    const migrated = rows(legacyPath)
    assert.ok(migrated.some((row) => row.keywords === '旧线索' && row.user_id === null), 'legacy row kept as shared')
    assert.ok(migrated.some((row) => row.user_id === '10001'), 'new row is isolated')

    const columns = (() => {
      const db = new DatabaseSync(legacyPath)
      try {
        return db.prepare('PRAGMA table_info(memory_clues)').all().map((column) => column.name)
      } finally {
        db.close()
      }
    })()
    assert.ok(columns.includes('user_id'), 'ALTER TABLE added user_id')
  }

  console.log('isolation: OK', target)
} finally {
  for (const dispose of disposers.splice(0)) {
    try { dispose() } catch { /* already released */ }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL still held on Windows */ }
}
