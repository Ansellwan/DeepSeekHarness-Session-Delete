#!/usr/bin/env node
// Read-only: dsh-plugin-hub 收录规则 + 我的 issue #170 状态 + 注册表条目现状
import https from 'node:https'
const TOKEN = process.env.GITHUB_TOKEN

function call(path) {
  return new Promise((resolve, reject) => {
    https
      .get(
        { hostname: 'api.github.com', path, headers: { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-session-clean' } },
        (r) => {
          let d = ''
          r.setEncoding('utf8')
          r.on('data', (c) => (d += c))
          r.on('end', () => {
            try { resolve({ status: r.statusCode, j: JSON.parse(d) }) } catch { resolve({ status: r.statusCode, raw: d }) }
          })
        },
      )
      .on('error', reject)
  })
}

const HUB = 'dshplugin/dsh-plugin-hub'

console.log('== Issue #170 ==')
const issue = await call(`/repos/${HUB}/issues/170`)
if (issue.j) {
  console.log(`title: ${issue.j.title}`)
  console.log(`state: ${issue.j.state} | created: ${issue.j.created_at} | updated: ${issue.j.updated_at} | comments: ${issue.j.comments}`)
  console.log(`labels: ${(issue.j.labels || []).map((l) => l.name).join(', ') || '(none)'}`)
} else console.log(issue.status, (issue.raw || '').slice(0, 200))

const cm = await call(`/repos/${HUB}/issues/170/comments?per_page=100`)
if (Array.isArray(cm.j)) {
  console.log(`\n-- comments (${cm.j.length}) --`)
  for (const c of cm.j) {
    const mine = c.user?.login === 'Ansellwan'
    console.log(`[${c.created_at}] ${c.user?.login}${mine ? ' (me)' : ''}: ${(c.body || '').replace(/\s+/g, ' ').slice(0, 160)}`)
  }
}

console.log('\n== hub 根目录文件 ==')
const root = await call(`/repos/${HUB}/contents/`)
if (Array.isArray(root.j)) console.log(root.j.map((f) => `${f.name}${f.type === 'dir' ? '/' : ''}`).join(', '))

for (const name of ['README.md', 'CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '.github/CONTRIBUTING.md']) {
  const f = await call(`/repos/${HUB}/contents/${name}`)
  if (f.j?.content) {
    const text = Buffer.from(f.j.content, 'base64').toString('utf8')
    const hits = text
      .split('\n')
      .filter((l) => /release|tag|README|license|npm|version|require|必须|要求|规范/i.test(l))
    console.log(`\n== ${name} 关键行 (${text.length} chars) ==`)
    console.log(hits.slice(0, 40).join('\n'))
  }
}
