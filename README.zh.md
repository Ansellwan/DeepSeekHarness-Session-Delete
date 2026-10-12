# DeepSeekHarness Session Delete（删除会话）

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/Ansellwan/DeepSeekHarness-Session-Delete)
[![npm](https://img.shields.io/npm/v/dsh-session-clean?label=npm)](https://www.npmjs.com/package/dsh-session-clean)
[![downloads](https://img.shields.io/npm/dm/dsh-session-clean?label=downloads)](https://www.npmjs.com/package/dsh-session-clean)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

为 DeepSeek Harness 侧栏会话补充官方缺失的**「删除会话」**能力：红色菜单项 + 二次确认 + 真删除——把会话从宿主活动存储中真正卸载、移出工作区注册表、并从磁盘清除；窗口里打开着的会话同样是**行被摘掉**，而不是被糊上一层假象。

![会话菜单中的「删除会话」](docs/demo.png) ![删除确认框](docs/demo-confirm.png)

## 安装

前提：已安装 DeepSeek Harness 桌面版。

```bash
# 从 npm 安装（推荐）
dsh plugin --profile desktop add dsh-session-clean

# 从 GitHub 安装
dsh plugin --profile desktop add github:Ansellwan/DeepSeekHarness-Session-Delete
```

安装后**重启 DSH**（软件形态没有热刷新）。

**升级**（add 不会自动升版，须显式版本号）：

```bash
dsh plugin --profile desktop add dsh-session-clean@<新版本号>
```

**卸载**：

```bash
dsh plugin --profile desktop remove dsh-session-clean
```

## 功能

- 在每个会话的 `⋯` 菜单（置顶 / 重命名 / 分叉 / 归档之后）加入**红色「删除会话」**项
- **会话运行中自动置灰**（含等待审批 / 等待回答），悬停提示「会话运行中，无法删除」
- **已归档会话同样可删除**——清理存量归档正是本插件的常用场景
- 点击后弹**二次确认**，明确警示「永久删除、不可撤销」，并说明「当前窗口里打开着的会话」会怎样处理
- 宿主侧二次校验：即使界面状态过期，只要会话仍有进行中的工作，删除会被拒绝（HTTP 409）
- 删除按固定顺序执行：先让宿主**真正卸载**该会话（于是侧栏那一行是被**摘掉**、而不是被隐藏——窗口里打开着的会话也一样），再从工作区注册表（归档集 / 置顶集 / 工作区会话列表）移除，最后删除 `~/.dsh/sessions/<工作区>/<sessionId>/` 落盘数据、`session_projcache` 投影缓存记录、以及承载超长工具结果的 spill 文件
- 走 DSH 存储域的变更事件通道刷新侧栏；卸载本身走框架自己的 `session/disposed` → `api-session/removed` 链路，**无需重启**，刷新页面也不会把该行带回来
- **如实汇报**：若某个 DSH 版本移除了这里依赖的内部卸载原语，响应会写明 `unloaded:false`，界面改口说「已隐藏，未删除」，插件退化为「冻结 + 隐藏」而不会谎称已彻底删除

## 权限与隐私

- 只在你自己的 DSH 进程内注册一个**仅本机**的 HTTP 路由（`/_dsh-session-clean`），受 DSH 连接信任检查保护（与官方 `/api` 桥同一道门），非信任连接返回 401/403
- 只删除**目标会话自己的产物**：`~/.dsh/sessions/…`、`~/.dsh/storages/session_projcache/…`，以及 spill 后端私有临时根（`%TEMP%/dsh-spill-*`）里属于该会话的 `session-<hash>` 目录（按后端自己的根名 / 会话名规则匹配，绝不删除根目录本身）
- 无任何网络请求、无遥测、无外部服务

## 兼容性

| | |
|---|---|
| DeepSeek Harness | 桌面版 `0.2.0-rc.2` 实测 |
| Profile | desktop（其他单一 profile 理论通用） |
| Node | ≥ 18（DSH 运行时自带） |
| 能力分类 | 界面与体验 |

## 边界与说明

- 删除**不可撤销**（这是它与「归档」的本质区别）。确认框会再次警示。
- 删除**当前窗口里打开的**会话在运行中即可生效：插件会让宿主把它从活动会话存储中真正卸载，那一行是被摘掉的。该步骤不是 DSH 的公开 API（见「工作原理」），因此调用前会做能力探测。
- **会删除**：对话日志、投影缓存（标题 / 大纲 / token 统计）、承载超长工具结果的 spill 文件、以及该 id 的所有注册表条目。
- **故意不动**（以及原因）：`~/.dsh/attachments/` 下按内容哈希寻址的附件块（多个会话可能共用同一哈希，按会话删会损伤别的对话）、本插件自己的操作日志、以及自行复制会话正文的第三方存储。插件不会声称自己清掉了这些。
- 该会话的 **Agent 对象保持注册**：DSH 没有公开的卸载入口，而直接改动它的注册表会留下一个不可见的循环。这部分残留会一直存在到 DSH 进程退出。
- 删除**当前正在查看**的会话在技术上可行，但删完窗口会暂时无内容可显示，切换到别的会话即可。
- 若启用了 `@deepseek-ai/dsh-session-query-sqlite`，其出厂配置是 `path: ':memory:'`，磁盘上没有索引需要清理。
- 删除后对话记录**不会被重新落盘**：卸载会关闭日志写入器，而仅追加的写入路径不会自建目录。投影缓存则天生会自愈，所以「未能卸载」的会话会在它挂起的写回定时器（默认 5 秒）触发后**再补清一次**。

## 工作原理

- **客户端半** `client.js`：向官方 slot 列表 `sidebar.workspaces.session.menu.item`
  注册 `order: 500` 的菜单行（与内置 pin=100 / rename=200 / fork=300 / archive=400
  同一列表，官方支持的扩展点）；运行状态来自宿主注入的 `useSessionStatus` 快照；
  确认弹窗挂在框架级 `shell.overlay` 槽位，菜单关闭不会连带销毁。
- **宿主半** `index.js`：注册私有路由 `/_dsh-session-clean`，删除前重探会话活动；
  对仍驻留内存的会话，走**框架自己的拆除原语**
  `SessionStore.liveEntryFor(session).detach()`（即属主卸载时执行的同一段
  `store.delete` + `session/disposed`）完成真卸载；再通过
  `storageDomain.get('workspace')` 拿到工作区注册表**已打开的同一个域句柄**
  写入，写即持久化并发 `domain/changed` 事件驱动侧栏刷新；最后删除会话目录、
  投影缓存记录与 spill 目录。`liveEntryFor` / `detachEntered` 属于内部成员
  （不在生成的 API catalog 里），因此每一步都先做能力探测，失败就退化为
  「如实汇报的隐藏」，不做无声的假删除。
- **为什么投影缓存要单独修**：投影缓存的写入是「先落盘、后改内存」，且该域真正的
  表名是 `sessions`、键是完整会话 id。必须通过活动域删键（而不是只删文件），
  否则域内存里的那行还在，下一次检查点就会把文件重新写出来。

不修改 `app.asar`，不 patch 任何官方装载行，升级 DSH 不受影响。

## 许可证

MIT
