#!/usr/bin/env node
// Post a clarification comment on the dsh-plugin.org listing issue (dshplugin/dsh-plugin-hub#170).
import https from 'node:https'
const TOKEN = process.env.GITHUB_TOKEN

const body = [
  '补充说明（测试覆盖范围口径）：',
  '',
  '- **主测试目标：DeepSeek Harness 桌面版 `0.2.0-rc.2`** —— 菜单注入、运行中置灰、二次确认、冷/热会话删除、降级路径、卸载清理均已在桌面版实测（仓库自带 25 项冒烟检查）。',
  '- **Web 形态（浏览器形态 profile，`dsh web`）**：README 已提供 `dsh plugin --profile web add dsh-session-clean` 安装命令；插件仅使用 Web 面 API（官方 slot 注入 + 私有宿主路由 + 存储域句柄），**没有桌面端专属调用**，因此按设计通用；但**尚未在 web 形态单独实测**，已在 README 安装段与兼容性表中明确标注“未单独实测，请自行尝试并反馈”。',
  '- 当前 npm latest：`dsh-session-clean@1.1.2`。',
  '',
  '如审核需要，我可以补充 web 形态的实测结果。',
].join('\n')

const payload = JSON.stringify({ body })
const opts = {
  hostname: 'api.github.com',
  path: '/repos/dshplugin/dsh-plugin-hub/issues/170/comments',
  method: 'POST',
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-session-clean',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
}

const req = https.request(opts, (res) => {
  let data = ''
  res.on('data', (chunk) => (data += chunk))
  res.on('end', () => {
    console.log('status:', res.statusCode)
    try {
      const j = JSON.parse(data)
      if (j.html_url) console.log('comment:', j.html_url)
      else console.log(data.slice(0, 300))
    } catch {
      console.log(data.slice(0, 300))
    }
  })
})
req.on('error', (error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
req.write(payload)
req.end()
