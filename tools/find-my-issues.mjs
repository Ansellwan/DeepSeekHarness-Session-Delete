#!/usr/bin/env node
// Find the user's submitted listing issue across GitHub (read-only search).
import https from 'node:https'
const TOKEN = process.env.GITHUB_TOKEN
const q = encodeURIComponent('author:Ansellwan type:issue dsh-session-clean')
const opts = {
  hostname: 'api.github.com',
  path: `/search/issues?q=${q}&per_page=20`,
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-session-clean',
  },
}
https
  .get(opts, (r) => {
    let d = ''
    r.on('data', (c) => (d += c))
    r.on('end', () => {
      const j = JSON.parse(d)
      if (!j.items) {
        console.log('响应:', d.slice(0, 300))
        return
      }
      console.log(`共 ${j.total_count} 条:`)
      for (const it of j.items) {
        console.log(`\n[${it.state}] ${it.title}`)
        console.log(`  ${it.html_url}`)
        console.log(`  仓库: ${it.repository_url.replace('https://api.github.com/repos/', '')} | 创建: ${it.created_at} | 评论: ${it.comments}`)
      }
    })
  })
  .on('error', (e) => console.log('ERR', e.message))
