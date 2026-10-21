#!/usr/bin/env node
// Read-only audit of the GitHub side: description, topics, releases, package.json version vs npm.
import { readFileSync } from 'node:fs'
import https from 'node:https'

const TOKEN = process.env.GITHUB_TOKEN
const REPO = 'Ansellwan/DeepSeekHarness-Session-Delete'
const local = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function call(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path,
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-session-clean',
      },
    }
    const req = https.get(opts, (r) => {
      let d = ''
      r.setEncoding('utf8')
      r.on('data', (c) => (d += c))
      r.on('end', () => resolve({ status: r.statusCode, body: d }))
    })
    req.on('error', reject)
  })
}

;(async () => {
  const repo = JSON.parse((await call(`/repos/${REPO}`)).body)
  console.log(`仓库描述: ${repo.description || '(空)'}`)
  console.log(`topics: [${(repo.topics || []).join(', ')}]`)
  console.log(`private: ${repo.private} | license: ${repo.license?.spdx_id} | homepage: ${repo.homepage || '(未设)'}`)

  const rel = JSON.parse((await call(`/repos/${REPO}/releases`)).body)
  console.log(`GitHub Releases: ${rel.length} 个${rel.length > 0 ? ' → ' + rel.map((r) => `${r.tag_name}(${r.draft ? 'draft' : r.prerelease ? 'pre' : 'published'})`).join(', ') : ''}`)

  const npmView = (path) =>
    new Promise((resolve, reject) => {
      const opts = { hostname: 'registry.npmjs.org', path, headers: { Accept: 'application/vnd.npm.install-v1+json', 'User-Agent': 'dsh-session-clean' } }
      const req = https.get(opts, (r) => {
        let d = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (d += c))
        r.on('end', () => resolve(JSON.parse(d)))
      })
      req.on('error', reject)
    })
  const doc = await npmView('/dsh-session-clean')
  console.log(`npm latest: ${doc['dist-tags']?.latest} | 仓库 package.json: ${local.version} | 一致: ${doc['dist-tags']?.latest === local.version}`)
})().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
