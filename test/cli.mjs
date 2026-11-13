/**
 * flm CLI 测试：AstrBot 插件靠这个 JSON 契约工作。
 * Run: node test/cli.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'flm.mjs')
const dir = mkdtempSync(join(here, '.tmp-cli-'))
const db = join(dir, 'memory.db')

const run = (...args) => {
  const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

const runFailing = (...args) => {
  try {
    execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? '') }
  }
  throw new Error('expected failure')
}

try {
  // 全局共享线索
  const shared = run('remember', '--keywords', '数据库,sqlite', '--seed', '用 node:sqlite 存线索', '--db', db)
  assert.equal(shared.ok, true)
  assert.ok(shared.id > 0)

  // 10001 的私有线索
  const mine = run(
    'remember',
    '--keywords',
    '豆豆,猫',
    '--seed',
    '我的猫叫豆豆',
    '--user',
    '10001',
    '--scene',
    'qqbot',
    '--db',
    db,
  )
  assert.equal(mine.ok, true)

  // 自然语言问句：CLI 自己从文本里挑关键词
  const hit = run('recall', '--text', '你还记得上次那个数据库吗', '--user', '10001', '--db', db)
  assert.equal(hit.ok, true)
  assert.equal(hit.found, true)
  assert.ok(hit.prompt.includes('线索词：'))
  assert.match(hit.prompt, /数据库|sqlite/)

  // 别人查不到 10001 的私有线索，但仍能看到共享线索
  const other = run('recall', '--text', '豆豆', '--user', '20002', '--db', db)
  assert.equal(other.found, false, 'private clue is not visible to another user')
  const otherShared = run('recall', '--text', '数据库', '--user', '20002', '--db', db)
  assert.equal(otherShared.found, true, 'shared clue stays visible')

  // 关键词直查
  const exact = run('recall', '--keyword', '豆豆', '--user', '10001', '--db', db)
  assert.equal(exact.found, true)
  assert.equal(exact.keyword, '豆豆')

  // 统计
  const stats = run('stats', '--db', db)
  assert.equal(stats.ok, true)
  assert.equal(stats.total, 2)
  assert.equal(stats.users, 1)

  // 时间线：按 --seq 排，不按写入顺序
  run('remember', '--keywords', '时间线 第三', '--seed', '最后的事', '--seq', '30', '--turn', '3', '--db', db)
  run('remember', '--keywords', '时间线 第一', '--seed', '最早的事', '--seq', '10', '--turn', '1', '--db', db)
  run('remember', '--keywords', '时间线 第二', '--seed', '中间的事', '--seq', '20', '--turn', '2', '--db', db)
  const timeline = run('recall', '--keyword', '时间线', '--db', db)
  assert.equal(timeline.found, true)
  const order = ['最早的事', '中间的事', '最后的事'].map((text) => timeline.prompt.indexOf(text))
  assert.ok(order[0] < order[1] && order[1] < order[2], 'clues are ordered by session_seq')
  assert.ok(timeline.prompt.includes('第1轮'), 'turn numbers are rendered')
  assert.deepEqual(timeline.items.map((item) => item.turn), [1, 2, 3], 'items carry turns in timeline order')

  // 用法错误：非 0 退出 + JSON 错误
  const bad = runFailing('recall', '--db', db)
  assert.equal(bad.code, 2)
  assert.match(bad.stdout, /"ok":false/)

  console.log('cli: OK')
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL still held */ }
}
