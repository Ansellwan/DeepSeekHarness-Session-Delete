#!/usr/bin/env node
// Show the stale draft release body so it can be reused/replaced.
import https from 'node:https'
const TOKEN = process.env.GITHUB_TOKEN
const get = (p) =>
  new Promise((res, rej) => {
    https
      .get({ hostname: 'api.github.com', path: p, headers: { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'x' } }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })
const rel = await get('/repos/Ansellwan/DeepSeekHarness-Session-Delete/releases')
for (const r of rel) {
  console.log(`id=${r.id} tag=${r.tag_name} draft=${r.draft} name=${JSON.stringify(r.name)}`)
  console.log('--- body ---')
  console.log(r.body)
  console.log('--- /body ---')
}
