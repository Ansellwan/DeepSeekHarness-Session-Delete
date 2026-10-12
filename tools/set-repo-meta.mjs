#!/usr/bin/env node
// One-shot: set repo description + topics for the dsh-plugin.org submission.
// Token comes from env GITHUB_TOKEN (read from Windows credential store by the caller, never printed).
import { readFileSync } from 'node:fs'
import https from 'node:https'
const TOKEN = process.env.GITHUB_TOKEN
const REPO = 'Ansellwan/DeepSeekHarness-Session-Delete'

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-session-clean',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data || ''),
      },
    }
    const req = https.request(opts, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => resolve({ status: r.statusCode, body: d }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

;(async () => {
  const p1 = await call('PATCH', `/repos/${REPO}`, {
    description:
      '为 DeepSeek Harness 侧栏会话补充官方缺失的「删除会话」：运行中置灰、二次确认、真卸载 + 注册表/磁盘清除，做不到时如实告知。 A DeepSeek Harness plugin adding the missing Delete-session action to the sidebar.',
  })
  console.log('PATCH 描述:', p1.status)
  const p2 = await call('PUT', `/repos/${REPO}/topics`, {
    names: ['dsh-plugin', 'deepseek-harness', 'session-management'],
  })
  console.log('PUT topics:', p2.status)
  const p3 = await call('GET', `/repos/${REPO}`)
  const j = JSON.parse(p3.body)
  console.log('最终 topics:', JSON.stringify(j.topics))
  console.log('最终描述:', j.description)
})().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
