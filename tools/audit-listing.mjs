#!/usr/bin/env node
// Confirm what feeds catalog "vr": probe plugin detail page + submit rules page.
import https from 'node:https'

function get(hostname, path, accept = 'text/html,application/json') {
  return new Promise((resolve, reject) => {
    https
      .get({ hostname, path, headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 dsh-session-clean' } }, (r) => {
        let d = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve({ status: r.statusCode, ct: r.headers['content-type'], body: d }))
      })
      .on('error', reject)
  })
}

const SLUG = 'ansellwan/deepseekharness-session-delete'

// 1) detail page: find the version + updated text rendered
const page = await get('dsh-plugin.org', `/plugins/${SLUG}`)
console.log('detail page:', page.status, page.body.length)
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
const text = strip(page.body)
for (const kw of ['版本', '更新', 'Version', 'Updated']) {
  const i = text.indexOf(kw)
  if (i >= 0) console.log(`  「${kw}」上下文: ...${text.slice(Math.max(0, i - 90), i + 140)}...`)
}
// embedded json
const jm = page.body.match(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g) || []
console.log('  next_f chunks:', jm.length)
const allJsonText = page.body
for (const k of ['"vr"', 'latestVersion', '"version"', 'releaseTag']) {
  const i = allJsonText.indexOf(k)
  if (i >= 0) console.log(`  找到键 ${k}: ...${allJsonText.slice(i, i + 120).replace(/\\/g, '')}...`)
}

// 2) submit page rules
const sub = await get('dsh-plugin.org', '/zh/submit')
console.log('\nsubmit page:', sub.status, sub.body.length)
const st = strip(sub.body)
const keys = ['release', 'Release', 'tag', 'README', 'topic', 'license', '版本', '发行', '要求', '收录']
for (const k of keys) {
  let idx = 0
  let shown = 0
  while ((idx = st.indexOf(k, idx)) >= 0 && shown < 2) {
    console.log(`  「${k}」: ...${st.slice(Math.max(0, idx - 100), idx + 160)}...`)
    idx += k.length
    shown += 1
  }
}

// 3) about.json
const about = await get('api.dsh-plugin.org', '/about.json', 'application/json')
console.log('\nabout.json:', about.status, about.body.slice(0, 1200))
