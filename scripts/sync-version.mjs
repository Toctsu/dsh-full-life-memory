/**
 * 把 package.json 的 version 同步到其它写死版本号的地方。
 *
 * 由 npm 的 `version` 生命周期调用：`npm version patch` 会先改 package.json，
 * 再跑这个脚本，最后把改动一起提交并打 tag。这样就不会出现
 * 「package.json 0.3.3、client.js 还写 0.3.2」的漂移。
 *
 * 手动执行：node scripts/sync-version.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: package.json version looks wrong: ${String(version)}`)
  process.exit(1)
}

function rewrite(relative, pattern, replacement) {
  const path = join(root, relative)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before) {
    console.warn(`sync-version: ${relative} already at ${version}`)
    return
  }
  writeFileSync(path, after)
  console.log(`sync-version: ${relative} → ${version}`)
}

// 浏览器半边里编译进包的“运行中版本”
rewrite('client.js', /const CURRENT_VERSION = '[^']*'/, `const CURRENT_VERSION = '${version}'`)
// README 顶部徽章
rewrite('README.md', /version-\d+\.\d+\.\d+-6d5efc/g, `version-${version}-6d5efc`)
