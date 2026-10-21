#!/usr/bin/env node
// Read-only: repo description integrity, releases vs tags vs npm, README install lines.
import { readFileSync } from 'node:fs'
import https from 'node:https'

const TOKEN = process.env.GITHUB_TOKEN
const REPO = 'Ansellwan/DeepSeekHarness-Session-Delete'

function call(path) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: 'api.github.com',
          path,
          headers: {
            Authorization: `token ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'dsh-session-clean',
          },
        },
        (r) => {
          let d = ''
          r.setEncoding('utf8')
          r.on('data', (c) => (d += c))
          r.on('end', () => {
            try {
              resolve(JSON.parse(d))
            } catch {
              reject(new Error(`bad JSON from ${path}: ${d.slice(0, 200)}`))
            }
          })
        },
      )
      .on('error', reject)
  })
}

const repo = await call(`/repos/${REPO}`)
const desc = repo.description || ''
const bad = [...desc]
  .map((ch, i) => ({ ch, i, cp: ch.codePointAt(0) }))
  .filter((x) => x.cp === 0xfffd || x.cp < 32)
console.log('== 仓库描述 ==')
console.log(`长度 ${desc.length} | 含替换符U+FFFD: ${desc.includes('\uFFFD')}`)
if (bad.length) console.log('可疑字符:', bad.map((x) => `idx=${x.i} cp=U+${x.cp.toString(16).toUpperCase()}`).join(' | '))
console.log('原文:', desc)
console.log(`topics: [${(repo.topics || []).join(', ')}]`)
console.log(`homepage: ${repo.homepage || '(未设)'} | license: ${repo.license?.spdx_id} | default_branch: ${repo.default_branch}`)

const releases = await call(`/repos/${REPO}/releases`)
const tags = await call(`/repos/${REPO}/tags?per_page=100`)
const local = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

console.log('\n== Releases vs Tags vs npm ==')
console.log(`本地 package.json: ${local.version}`)
console.log(`git tags(API): ${tags.map((t) => t.name).join(', ') || '(none)'}`)
if (!releases.length) console.log('GitHub Releases: (none)')
for (const r of releases) {
  console.log(
    `github release: ${r.tag_name} | draft=${r.draft} prerelease=${r.prerelease} | published=${r.published_at} | bodyLen=${(r.body || '').length} | assets=${r.assets?.length ?? 0}`,
  )
}
const relTags = new Set(releases.map((r) => r.tag_name))
const published = releases.filter((r) => !r.draft && !r.prerelease)
const tagNames = tags.map((t) => t.name)
for (const t of tagNames) {
  if (!relTags.has(t)) console.log(`⚠ tag ${t} 没有对应 GitHub Release`)
}
for (const r of releases) {
  if (r.draft) console.log(`⚠ release ${r.tag_name} 仍是 draft（对外不可见，抓不到版本信息）`)
  if (!tagNames.includes(r.tag_name)) console.log(`⚠ release ${r.tag_name} 没有对应 git tag`)
}
if (published.length) console.log(`已发布 release 最新: ${published[0].tag_name}`)
else console.log('已发布 release: 0 个')

const npmDoc = await new Promise((resolve, reject) => {
  https
    .get(
      { hostname: 'registry.npmjs.org', path: '/dsh-session-clean', headers: { Accept: 'application/json', 'User-Agent': 'dsh-session-clean' } },
      (r) => {
        let d = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve(JSON.parse(d)))
      },
    )
    .on('error', reject)
})
const latest = npmDoc['dist-tags']?.latest
console.log(`npm latest: ${latest} | 仓库一致: ${latest === local.version}`)
const pub = npmDoc.versions?.[latest] || {}
console.log(`npm ${latest} README: ${npmDoc.versions?.[latest]?.readme ? '有' : '(取自 dist)'} | repository: ${pub.repository?.url || '(无)'} | license: ${pub.license}`)

console.log('\n== README 关键元素 ==')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const checks = [
  ['安装命令 dsh plugin … add 包名', /dsh plugin\b[^\n]*\badd\s+dsh-session-clean/.test(readme)],
  ['npm 包名', /dsh-session-clean/.test(readme)],
  ['桌面端已实测声明', /(tested|已实测)/i.test(readme)],
  ['Web 端未实测声明', /(untested|未(单独)?实测)/i.test(readme)],
  ['许可证小节', /^##\s*License/im.test(readme)],
  ['截图引用（含 raw 相对路径均可）', /!\[[^\]]*\]\([^)]*docs\/[\w-]+\.png/.test(readme)],
  ['README 未硬编码当前版本号', !/1\.\d+\.\d+/.test(readme)],
]
for (const [label, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${label}`)
const verHits = [...readme.matchAll(/1\.\d+\.\d+/g)].map((m) => m[0])
if (verHits.length) console.log('README 中出现的版本号:', [...new Set(verHits)].join(', '))
