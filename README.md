# DeepSeekHarness Session Delete / DSH 删除会话

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/ansellwan/deepseekharness-session-delete)
[![npm](https://img.shields.io/npm/v/dsh-session-clean?label=npm)](https://www.npmjs.com/package/dsh-session-clean)
[![downloads](https://img.shields.io/npm/dm/dsh-session-clean?label=downloads)](https://www.npmjs.com/package/dsh-session-clean)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**English** | [简体中文](#简体中文)

---

## English

DeepSeek Harness has archive, rename and fork — but no way to **delete** a conversation. This plugin adds the missing red **Delete session** row to every session's `⋯` menu, with a confirmation dialog in front of it. It deletes for real: no hidden leftovers that quietly come back.

![Delete session in the session menu](docs/demo.png) ![Confirmation dialog](docs/demo-confirm.png) ![Greyed out while the session is busy](docs/demo-busy.png)

### Install

**Primary tested target: the DeepSeek Harness desktop app.** The browser-form web profile (`dsh web`) is expected to work — the plugin uses only web-surface APIs and has no desktop-only calls — but it has **not been separately tested**; web users try it at their own risk and are welcome to report back.

```bash
# From npm (recommended) — desktop app, the tested target
dsh plugin --profile desktop add dsh-session-clean

# Browser-form profile (dsh web) — expected to work, NOT separately tested
dsh plugin --profile web     add dsh-session-clean

# From GitHub (desktop)
dsh plugin --profile desktop add github:Ansellwan/DeepSeekHarness-Session-Delete
```

Restart DSH afterwards (the software build has no hot reload; for a `dsh web` server, restart the process).

**Upgrade** (add does not upgrade by itself):

```bash
dsh plugin --profile desktop add dsh-session-clean@<version>
```

**Uninstall**:

```bash
dsh plugin --profile desktop remove dsh-session-clean
```

### What you get

- A red **Delete session** item in every session's `⋯` menu, after pin / rename / fork / archive.
- It greys out by itself while that session is busy (replying, or waiting for your approval or answer).
- Archived sessions can be deleted too — clearing the archive out is the main reason people install this.
- One confirmation dialog, then it is done.
- A **Clean workspace** action at the sidebar foot: pick a workspace, see how many sessions it holds, confirm once, and every session in it is deleted in one go.

### Cleaning a whole workspace

Clearing out an old project usually means deleting every conversation in that group, one by one. The sidebar-foot **Clean workspace** button does it in one step:

1. It lists every workspace that still holds sessions, **plus an "Ungrouped" row** for sessions no workspace owns (the ones a deleted group leaves behind, or sessions started without picking a workspace).
2. Counts match what you can actually see: a row says "2 sessions · 3 hidden" when its group also holds archived (or subagent) entries — you are told they exist and that a clean takes them too, instead of a number you cannot reconcile with the sidebar.
3. Cleaning one asks for one confirmation that names the exact count ("permanently delete the N sessions in …"), and that dialog offers **Clean** (keep the group) or **Clean and remove group** (unregister it too).
4. **Any running session refuses the whole batch.** The same rule as the single-session action, applied to a group: if one member is replying or waiting for approval/answer, nothing is deleted and you are told how many are busy — the plugin never silently skips a member.
5. A progress line reports `deleting i/N`, then a summary ("deleted N", or "deleted N, M failed").
6. If the conversation on screen was among the deleted ones, the view leaves it: you land in a **fresh session of that same workspace** (for the Ungrouped row, in the first remaining workspace).

The workspace group itself is kept (DSH treats a workspace as a registered folder, not a session container); it simply becomes an empty group you can start new sessions in, or remove with the shipped **Delete workspace** action.

### Two ways to get rid of a workspace — deliberately different

The shipped **Delete workspace** action and this plugin's panel do different things, and this plugin never second-guesses the official one:

| What you do | Sessions | The group |
|---|---|---|
| Shipped **Delete workspace** | kept — they move to Ungrouped | unregistered |
| Panel → **Clean** | deleted | kept, as an empty group you can start sessions in |
| Panel → **Clean and remove group** | deleted | unregistered |

"Get rid of this whole project" is therefore one panel action: pick the group, choose **Clean and remove group**, confirm once (the confirmation still names the exact session count). If you only want the conversations gone but the folder kept for future work, choose **Clean**.

### What deleting actually does

1. **The data is gone for good.** Unlike archive, there is no undo and no recycle bin.
2. **Sessions that are open right now can be deleted too.** The row disappears from the sidebar immediately — no restart, and refreshing the page does not bring it back. If it was the conversation you were looking at, the view moves on to a fresh session in the same workspace, so you are not left staring at a deleted transcript.
3. **If a full delete is not possible**, the plugin only hides the session for now and tells you so. It never pretends to have deleted something it could not.

### What is deleted, and what is left alone

| | |
|---|---|
| ✅ Deleted | The conversation itself, its cached title / outline / token stats, oversized tool output spilled to disk, and its entries in the sidebar bookkeeping (grouping, pin, archive) |
| ❌ Left alone | Attachments under `~/.dsh/attachments/` — they are stored by content hash and can be shared by several conversations, so deleting one session's copy could damage another conversation |
| ❌ Left alone | This plugin's own log (`~/.dsh/logs/session-delete.log`) — it records what was deleted |
| ❌ Left alone | Copies that other plugins make into their own databases |

Until the DSH process exits, an empty session object stays in memory — DSH offers no official way to clear it. It no longer shows up in any list, and it is gone after a restart.

### FAQ

- **Can I get a deleted session back?** No. There is no undo.
- **Can I delete a session that is replying right now?** No — the action is blocked until it stops, and it tells you why.
- **It said "hidden for now" — what does that mean?** That DSH build does not allow a full removal, so the plugin hid the session instead of lying to you. The row disappears for good after you restart DSH.
- **What if I delete the session I am looking at?** It works; the window is simply empty until you open another session.
- **Can it damage another conversation?** No. Only files belonging to that one session are touched.
- **Do I have to restart after deleting?** No.
- **Does it talk to the internet?** No network calls, no telemetry.

### Permissions & privacy

- Opens one **local-only** HTTP route inside your own DSH process, behind DSH's own connection trust check — outside connections cannot reach it.
- Deletes only that one session's own files: `~/.dsh/sessions/…`, `~/.dsh/storages/session_projcache/…`, and its spilled-output folder inside the temp directory.
- No network calls, no telemetry, no external services.

### Compatibility

| | |
|---|---|
| DeepSeek Harness | desktop `0.2.0-rc.2` — the tested target |
| Profile | **desktop: tested and supported.** Web-surface profiles (browser-form `dsh web`): expected to work (only web-surface APIs are used, no desktop-only calls) but **not separately tested — try at your own risk and report back** |
| Node | ≥ 18 (ships with the DSH runtime) |
| Capability class | 界面与体验 (UI & experience) |

### Technical notes (safe to skip)

- **Client half** (`client.js`): one `order: 500` row in the official `sidebar.workspaces.session.menu.item` slot list, the same extension point the built-in rows use; busy state comes from the host-injected `useSessionStatus` snapshot; the dialog lives in the frame-wide `shell.overlay` slot so closing the menu cannot kill it.
- **Host half** (`index.js`): a private `/_dsh-session-clean` route re-probes the session, then deletes in one order — unload the session from the Host's live store, remove it from the workspace registry, erase the durable files (log directory, `session_projcache` record, spill directory). The registry is written through the same open storage-domain handle the registry itself holds, so the sidebar refreshes from the change event.
- **Unloading a resident session** uses the framework's own teardown primitive, `SessionStore.liveEntryFor(session).detach()` — the same `store.delete` + `session/disposed` an owner's unload performs. That event is what the session controller turns into `api-session/removed`, which makes the browser drop the row for real and closes the session's log writer, so the transcript cannot be re-persisted. `liveEntryFor` / `detachEntered` are internal (absent from the generated API catalog), so each step is capability-probed; any failure falls back to a reported hide instead of a silent lie.
- **The projection cache needs its own handling**: it is a self-healing write-behind cache whose real domain table is `sessions`, keyed by the full session id. Removing the key through the live domain — not just the backing file — is what stops the next checkpoint from recreating the document.
- No `app.asar` patching and no overriding of official loader rows, so DSH upgrades are safe.

---

## 简体中文

DSH 有归档、重命名、分叉，却**没有删除会话**。这个插件在侧栏每个会话的 `⋯` 菜单里补上一项红色「删除会话」，点之前先弹确认框。删就是真删：不会给你留个"看起来删了、过两天又冒出来"的尾巴。

![会话菜单中的「删除会话」](docs/demo.png) ![删除确认框](docs/demo-confirm.png) ![会话运行中，删除自动置灰](docs/demo-busy.png)

### 安装

**主测试目标是 DeepSeek Harness 桌面版。** 浏览器形态的 web profile（`dsh web`）按设计应当可用——插件只用到 Web 面 API，没有任何桌面端专属调用——但**未单独实测**；Web 端用户请自行尝试，欢迎反馈结果。

```bash
# 从 npm 安装（推荐）—— 桌面版，已实测的主目标
dsh plugin --profile desktop add dsh-session-clean

# 浏览器形态 profile（dsh web）—— 按设计可用，但未单独实测
dsh plugin --profile web     add dsh-session-clean

# 从 GitHub 安装（桌面版）
dsh plugin --profile desktop add github:Ansellwan/DeepSeekHarness-Session-Delete
```

安装后**重启 DSH**（软件形态没有热刷新；`dsh web` 服务重启进程即可）。

**升级**（add 不会自动升版，须显式版本号）：

```bash
dsh plugin --profile desktop add dsh-session-clean@<新版本号>
```

**卸载**：

```bash
dsh plugin --profile desktop remove dsh-session-clean
```

### 它能做什么

- 每个会话的 `⋯` 菜单里多一项红色「**删除会话**」（排在置顶 / 重命名 / 分叉 / 归档之后）
- 会话正在干活时（回复中，或等你审批 / 回答）**自动变灰**，点不动
- **已归档的会话一样能删**——清库存最好用
- 删除前弹一次确认框，确认后才动手
- 侧栏底部多一个「**清理分组**」入口：选一个分组、看清会话数量、确认一次，整组会话一次删完

### 清理整个分组

清理一个旧项目，往往要把整组对话一条条删掉。侧栏底部的「清理分组」按钮替你一次做完：

1. 列出所有还有会话的分组，**外加一行「未分组」**——它装的是不属于任何分组的会话（删掉分组后遗留下来的、或者新建时没选分组的）
2. 数字与侧栏看到的一致：若该分组还藏着已归档 / 子代理条目，会显示成"2 个会话 · 3 个不在列表"，明确告诉你它们存在、清空时也会一并删除，而不是给你一个对不上号的总数
3. 点「清空」后只弹一次确认，确认框里写明确切数量（"永久删除该分组下的 N 个会话"），并同时提供「清空」（保留分组）与「清空并移除分组」（连分组一起注销）两个选择
4. **组内只要有会话在运行，整批拒绝**——和单会话同一条铁律：只要有一个在回复或等审批/回答，一条都不删，并告诉你几个在忙；绝不偷偷跳过某个成员
5. 执行时显示 `正在删除 i/N`，结束后汇总（"已删除 N 个"或"已删除 N 个，失败 M 个"）
6. 如果主视图正在看的会话也在被删之列，界面会离开它：**切到同一个分组里的新会话**（清的是「未分组」时，切到第一个还存在的分组）

分组本身会保留（DSH 把分组定义为"注册过的文件夹"，不是会话容器）：它会变成一个空分组，可以在里面新建会话，或用官方的「删除工作区」把分组移除。

### 两条“删分组”的路，故意分开

官方「删除工作区」与本插件的面板做的是不同的事，本插件**从不替官方动作做决定**：

| 你做的操作 | 会话 | 分组 |
|---|---|---|
| 官方 **删除工作区** | 保留——下沉到「未分组」 | 注销 |
| 面板 → **清空** | 删除 | 保留，变成一个可以新建会话的空分组 |
| 面板 → **清空并移除分组** | 删除 | 注销 |

所以“把这个项目彻底清掉”是面板里的一个动作：选中分组 → 选「清空并移除分组」→ 确认一次（确认框仍会写明会话数量）。如果只想清掉对话、留着文件夹以后继续用，就选「清空」。

### 删除到底做了什么

1. **数据真的没了，删了找不回来**（和「归档」不一样：归档只是收起来）
2. **正开着的会话也能删**：删完侧栏里立刻就没有它了，不用重启，刷新页面也不会回来；如果删的正是你正在看的那个会话，界面会自动切到同工作区的新会话，不会停在一个已被删除的对话上
3. **万一这次删不彻底**，插件只会先把它藏起来，并且**直接告诉你**——不会假装已经删干净

### 会删掉什么，不会删什么

| | |
|---|---|
| ✅ 会删 | 这段对话本身，它的标题 / 大纲 / token 统计等缓存，工具输出过长时落盘的溢出文件，以及它在侧栏里的各种登记（分组、置顶、归档） |
| ❌ 不动 | `~/.dsh/attachments/` 里的附件原件——它们按内容存一份，多个会话可能共用同一份，按会话删会连累别的对话 |
| ❌ 不动 | 本插件自己的日志（`~/.dsh/logs/session-delete.log`，记录删过谁、删了哪些文件） |
| ❌ 不动 | 其他插件自己抄到各自数据库里的副本 |

另外，DSH 进程退出前，内存里还会留一个空的会话对象（官方没提供清理它的接口）。它不会再出现在任何列表里，重启后彻底消失。

### 常见问题

- **删了还能恢复吗？** 不能。没有回收站，也没有撤销。
- **正在回复的会话能删吗？** 不能，会被拦下并提示原因；等它停下来再删。
- **提示"先藏起来"是什么意思？** 说明当前 DSH 版本不支持彻底移除，插件只能先把它隐藏，并如实告诉你；这一行会在**重启 DSH 后彻底消失**。插件宁可说清楚，也不会假装删成功。
- **删的时候正在看这个会话怎么办？** 能删，但删完窗口会空着，点开别的会话即可。
- **会误删别的会话吗？** 不会。只动这一个会话自己的文件。
- **删完要不要重启才生效？** 不用。
- **会联网吗？** 不会，没有任何网络请求、没有遥测。

### 权限与隐私

- 只在你自己的 DSH 进程里开一个**仅本机**可用的接口，并走 DSH 官方同一道连接信任检查，外部连不进来
- 只删这一个会话自己的文件：`~/.dsh/sessions/…`、`~/.dsh/storages/session_projcache/…`，以及临时目录里属于它的溢出文件目录
- 无网络请求、无遥测、无外部服务

### 兼容性

| | |
|---|---|
| DeepSeek Harness | 桌面版 `0.2.0-rc.2` —— 已实测的主目标 |
| Profile | **desktop：已实测、正式支持。** Web 形态 profile（`dsh web` 浏览器形态）：按设计可用（只用到 Web 面 API，无桌面端专属调用），但**未单独实测——请自行尝试并反馈遇到的问题** |
| Node | ≥ 18（DSH 运行时自带） |
| 能力分类 | 界面与体验 |

### 技术说明（普通用户可跳过）

- **客户端半** `client.js`：向官方 slot 列表 `sidebar.workspaces.session.menu.item` 注册 `order: 500` 的菜单行（与内置 pin=100 / rename=200 / fork=300 / archive=400 同一列表，官方支持的扩展点）；忙碌状态来自宿主注入的 `useSessionStatus` 快照；确认弹窗挂在框架级 `shell.overlay` 槽位，菜单关闭不会连带销毁。
- **宿主半** `index.js`：注册私有路由 `/_dsh-session-clean`，先重探会话活动，再按固定顺序删除——① 把仍驻留内存的会话从宿主活动存储中卸载 → ② 从工作区注册表移除（全局归档 / 置顶集 + 各工作区会话列表）→ ③ 清理落盘数据（会话目录、`session_projcache` 投影缓存记录、spill 溢出目录）。注册表写入走它自己已打开的同一个存储域句柄，写即持久化并发变更事件，侧栏据此刷新。
- **卸载活会话**用的是框架自己的拆除原语 `SessionStore.liveEntryFor(session).detach()`（即属主卸载时执行的同一段 `store.delete` + `session/disposed`）。该事件被会话控制器转成 `api-session/removed`，客户端据此**真的把那一行删掉**，同时关闭该会话的日志写入器，因此对话记录不会被重新落盘。`liveEntryFor` / `detachEntered` 属于内部成员（不在生成的 API catalog 里），所以每一步都先做能力探测，失败就退化为「如实汇报的隐藏」，不做无声的假删除。
- **投影缓存为什么必须单独处理**：它是「写回型自愈缓存」，且该域真正的表名是 `sessions`、键是完整会话 id。必须通过活动域删键（而不是只删文件），否则域内存里的那行还在，下一次检查点就会把文件重新写出来。
- 不修改 `app.asar`，不 patch 任何官方装载行，升级 DSH 不受影响。

---

## License / 许可证

MIT
