/**
 * 把 package.json 的 version 同步到其它写死版本号的地方。
 *
 * 由 npm 的 `version` 生命周期调用：`npm version patch` 会先改 package.json，
 * 再跑这个脚本，最后提交并打 tag。
 *
 * 注意：npm 只自动暂存 package.json / package-lock.json，
 * 所以本脚本改完文件后会自己 `git add`，否则发布提交里会漏掉 client.js，
 * 出现「package.json 0.3.6、client.js 还写 0.3.5」的漂移。
 *
 * 手动执行：node scripts/sync-version.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: package.json version looks wrong: ${String(version)}`)
  process.exit(1)
}

const touched = []

function rewrite(relative, pattern, replacement) {
  const path = join(root, relative)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before) {
    console.warn(`sync-version: ${relative} already at ${version}`)
    return
  }
  writeFileSync(path, after)
  touched.push(relative)
  console.log(`sync-version: ${relative} → ${version}`)
}

// 浏览器半边里编译进包的“运行中版本”
rewrite('client.js', /const CURRENT_VERSION = '[^']*'/, `const CURRENT_VERSION = '${version}'`)
// README 顶部徽章
rewrite('README.md', /version-\d+\.\d+\.\d+-6d5efc/g, `version-${version}-6d5efc`)

// 让 `npm version` 的提交包含这些文件；不在 git 仓库里时静默跳过
if (touched.length > 0) {
  try {
    execFileSync('git', ['add', '--', ...touched], { cwd: root, stdio: 'ignore' })
    console.log(`sync-version: staged ${touched.join(', ')}`)
  } catch {
    console.warn('sync-version: not a git checkout, skipped staging')
  }
}
