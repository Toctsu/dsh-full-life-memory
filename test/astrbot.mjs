/**
 * AstrBot 的 Python 读取层与 Node CLI 的语义对拍。
 * 需要本机有 python；没有就跳过（不算失败）。
 * Run: node test/astrbot.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'flm.mjs')
const py = join(here, '..', 'astrbot', 'memory.py')
const dir = mkdtempSync(join(here, '.tmp-astrbot-'))
const db = join(dir, 'memory.db')

const runNode = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }))
const runPy = (...args) =>
  JSON.parse(
    execFileSync('python', [py, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }),
  )

function hasPython() {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

try {
  assert.equal(runNode('remember', '--keywords', '数据库,sqlite', '--seed', '全局：用 node:sqlite 存线索', '--db', db).ok, true)
  assert.equal(
    runNode('remember', '--keywords', '豆豆,猫', '--seed', '10001 的猫叫豆豆', '--user', '10001', '--scene', 'qqbot', '--db', db).ok,
    true,
  )

  if (!hasPython()) {
    console.log('astrbot: SKIP (python not found)')
    process.exit(0)
  }

  // 同一个库、同一个问题，两边结论一致
  const nodeHit = runNode('recall', '--text', '你还记得数据库吗', '--user', '10001', '--db', db)
  const pyHit = runPy('recall', '--text', '你还记得数据库吗', '--user', '10001', '--db', db, '--scene', 'qqbot')
  assert.equal(pyHit.found, nodeHit.found)
  assert.equal(pyHit.count, nodeHit.count)
  assert.match(pyHit.prompt, /数据库/)

  // 隔离：别人查不到 10001 的私有线索
  const pyOther = runPy('recall', '--text', '豆豆', '--user', '20002', '--db', db, '--scene', 'qqbot')
  assert.equal(pyOther.found, false, 'python path keeps private clues private')
  const pyMine = runPy('recall', '--text', '豆豆', '--user', '10001', '--db', db, '--scene', 'qqbot')
  assert.equal(pyMine.found, true)

  // 统计一致
  const nodeStats = runNode('stats', '--db', db)
  const pyStats = runPy('stats', '--db', db)
  assert.equal(pyStats.total, nodeStats.total)
  assert.equal(pyStats.users, nodeStats.users)

  // 泛词不再触发降级匹配：库里只有「感知数据」，问「数据库」不应命中
  const noiseDb = join(dir, 'noise.db')
  runNode('remember', '--keywords', '感知数据,MUD', '--seed', '文字 MUD 的感知数据', '--db', noiseDb)
  const noisy = runPy('recall', '--text', '数据库', '--db', noiseDb, '--user', '10001', '--scene', 'qqbot')
  assert.equal(noisy.found, false, '2-char fallback removed: 数据库 must not match 感知数据')
  const exact = runPy('recall', '--keyword', '数据', '--db', noiseDb, '--user', '10001', '--scene', 'qqbot')
  assert.equal(exact.found, true, 'exact keyword still works')

  // 摘要用的 items 字段
  assert.ok(Array.isArray(exact.items) && exact.items.length > 0)
  assert.ok(exact.items[0].date && exact.items[0].keywords)

  // 库不存在时：不创建文件，直接返回空
  const missing = join(dir, 'missing.db')
  const empty = runPy('recall', '--text', '数据库', '--db', missing)
  assert.equal(empty.found, false)
  assert.equal(empty.prompt.includes('没有留下可用的线索'), true)

  // 旧库（0.3.x 结构）：能读、不报错，并可以一键补列
  const legacy = join(dir, 'legacy.db')
  const { DatabaseSync } = await import('node:sqlite')
  const old = new DatabaseSync(legacy)
  old.exec(`
    CREATE TABLE memory_clues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      keywords TEXT NOT NULL,
      seed_tokens TEXT NOT NULL,
      summary TEXT
    )
  `)
  old.prepare('INSERT INTO memory_clues (session_id, created_at, keywords, seed_tokens) VALUES (?, ?, ?, ?)').run(
    'old',
    Date.now(),
    '旧线索',
    '旧片段',
  )
  old.close()

  const legacyHit = runPy('recall', '--text', '旧线索', '--db', legacy, '--user', '10001')
  assert.equal(legacyHit.found, true, 'legacy schema is readable')
  assert.equal(legacyHit.schema, 'legacy')

  const migrated = runPy('migrate', '--db', legacy)
  assert.equal(migrated.ok, true)
  assert.deepEqual(migrated.added, ['user_id', 'scene'])

  const afterMigrate = runPy('recall', '--text', '旧线索', '--db', legacy, '--user', '10001')
  assert.equal(afterMigrate.schema, 'v3')
  assert.equal(afterMigrate.found, true)

  console.log('astrbot: OK')
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL */ }
}
