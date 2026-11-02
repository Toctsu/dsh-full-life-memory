#!/usr/bin/env node
/**
 * flm —— 给 DSH 之外的程序用的记忆命令行。
 *
 * AstrBot（NapCat/QQ）这类桥接没有 DSH 的 agent 循环，所以把同一套 SQLite 读写
 * 暴露成 CLI：Python 插件用子进程调用，JSON 进 JSON 出。
 *
 *   flm recall --text "你还记得上次那个数据库吗" --user 10001 --scene qqbot
 *   flm recall --keyword 数据库 --user 10001
 *   flm remember --keywords "数据库,sqlite" --seed "用 node:sqlite 存线索" --user 10001 --scene qqbot
 *   flm stats
 *
 * 退出码：0 成功，2 用法错误，1 运行错误。输出始终是 JSON。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb, searchClues, storeClue, buildRecallPrompt } from '../index.js'

const EMPTY_PROMPT = (keyword) =>
  [
    `关于「${keyword}」，我的记忆里没有留下可用的线索。`,
    '可以再给我一个更具体的关键词（人名、项目名、文件名、当时的原话）。',
  ].join('\n')

function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        index += 1
      }
    } else {
      out._.push(token)
    }
  }
  return out
}

function fail(message, code = 2) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exit(code)
}

/**
 * 中文没有空格，用户问句往往是一整串。
 * 这里按标点/空白切段，再枚举 2–6 字的子串当候选关键词，长的优先。
 * 都是本地 LIKE 查询，几毫秒级。
 */
function candidatesFromText(text) {
  const runs = String(text)
    .replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’…—\s]+/g, ' ')
    .split(/\s+/)
    .filter((run) => run.length >= 2)

  const seen = new Set()
  const candidates = []
  const push = (value) => {
    const word = value.trim()
    if (word.length < 2 || word.length > 24 || seen.has(word)) return
    seen.add(word)
    candidates.push(word)
  }

  for (const run of runs) {
    push(run)
    for (let size = Math.min(6, run.length); size >= 2; size -= 1) {
      for (let start = 0; start + size <= run.length; start += 1) push(run.slice(start, start + size))
    }
  }
  return candidates.sort((left, right) => right.length - left.length).slice(0, 48)
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'recall'
const dbPath = String(args.db ?? process.env.FLM_DB ?? join(homedir(), '.dsh', 'full-life-memory', 'memory.db'))
const scene = args.scene === undefined || args.scene === true ? undefined : String(args.scene)
const userId = args.user === undefined || args.user === true ? undefined : String(args.user)
const isolationScope = args.isolation === 'user+scene' ? 'user+scene' : 'user'
const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 5
const scope = args.scope === 'user' || args.scope === 'global' ? args.scope : 'auto'

try {
  if (command === 'stats') {
    const db = openDb(dbPath)
    const row = db
      .prepare(
        `SELECT count(*) AS total,
                count(DISTINCT user_id) AS users,
                count(DISTINCT scene) AS scenes
           FROM memory_clues`,
      )
      .get()
    process.stdout.write(`${JSON.stringify({ ok: true, dbPath, ...row })}\n`)
    process.exit(0)
  }

  if (command === 'remember') {
    const keywords = args.keywords ?? args._[1]
    const seed = args.seed ?? args['seed-tokens']
    if (typeof keywords !== 'string' || keywords.trim() === '') fail('remember 需要 --keywords')
    if (typeof seed !== 'string' || seed.trim() === '') fail('remember 需要 --seed')
    const db = openDb(dbPath)
    const id = storeClue(db, {
      keywords,
      seedTokens: seed,
      summary: typeof args.summary === 'string' ? args.summary : undefined,
      userId: userId ?? null,
      scene: scene ?? null,
      sessionId: typeof args.session === 'string' ? args.session : null,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, id })}\n`)
    process.exit(0)
  }

  if (command !== 'recall') fail(`未知命令：${command}`, 2)

  let keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
  const text = typeof args.text === 'string' ? args.text : ''

  const db = openDb(dbPath)
  let clues = []
  if (keyword !== '') {
    clues = searchClues(db, keyword, limit, { userId, scope, scene, isolationScope })
  } else if (text !== '') {
    for (const candidate of candidatesFromText(text)) {
      const hits = searchClues(db, candidate, limit, { userId, scope, scene, isolationScope })
      if (hits.length > 0) {
        keyword = candidate
        clues = hits
        break
      }
    }
    if (keyword === '') keyword = text.slice(0, 24)
  } else {
    fail('recall 需要 --keyword 或 --text')
  }

  const prompt =
    clues.length > 0
      ? buildRecallPrompt(keyword, clues, Number(args['max-chars']) || 1800)
      : EMPTY_PROMPT(keyword)

  process.stdout.write(
    `${JSON.stringify({ ok: true, found: clues.length > 0, keyword, count: clues.length, prompt })}\n`,
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1)
}
