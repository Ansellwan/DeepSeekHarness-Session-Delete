# 上游需求：公开的「卸载 / 删除会话」API

> 起草于 2026-10-13，基于对桌面版 `0.2.0-rc.2` 的 `app.asar` 逐行复读。
> 本文件是给 DSH 官方提需求的底稿（GitHub Issue / PR / 论坛帖均可直接使用）。
> 目的：让第三方插件不必再伸手进内部字段，就能把「删除会话」做干净。

## 一句话

DSH 目前**没有任何公开途径**让一个会话从宿主内存里消失；而侧栏列表是「持久层 ∪ `ctx.sessions.list()`」，所以只删磁盘永远留一行幽灵。请补一个公开 API。

## 现状（已核实的公开面）

| 面 | 现有方法 | 缺口 |
|---|---|---|
| 宿主 `ctx.sessions`（`SessionStore`） | `registerMessageProjection` / `create` / `prepare` / `enter` / `announce` / `flush` / `get` / `list` / `fork` | 无 remove / delete / unload / close / evict |
| 宿主 `ctx.agents`（`AgentRegistry`） | `currentInitiator` / `requireInitiator` / `withInitiator` / `withoutInitiator` / `setFactory` / `create` / `resume` / `register` / `enter` / `announce` / `get` / `list` / `roots` | 无按 id 拆除 |
| 客户端 `sessionController` | `list` / `search` / `create` / `rename` / `fork` / `prompt` / `attachment` / `cancel` / `page` / `follow` / `control` | `control` 是只读帧流，无动作 |
| 客户端 `uiWorkspace` | archive / unarchive / pin / unpin | 无 delete |
| `sessionPersistence` | 打开 / 追加 / flush / close | **无 delete**：第三方只能用文件系统删目录 |

`cordis` 也不允许插件覆盖已注册服务（`service "…" has been registered`），因此没有「装一个过滤层」的迂回空间；会话列表也没有 waterfall 扩展点。

## 为什么必须由宿主提供

- 「删除」在用户认知里包含两件事：**数据不可恢复** + **不再出现**。前者第三方可以自己做（代价是绕过持久化层直接动文件），后者**只能宿主做**，因为列表由宿主内存会话列表并集决定。
- 现有的唯一替代手段是把 id 塞进 `archivedSessionIds`——这是一种**伪装**：用户在「显示已归档 / 仅显示已归档」筛选下会看到幽灵行，点「取消归档」还会让它回到未分组。第三方插件不该被逼着欺骗用户。
- 破坏性操作需要有序拆除。框架自己的顺序（`dsh-agent-loop` 的 lifecycle `dispose`）是：
  `machine.cancel({kind:'disposed'})` → `await machine.whenIdle()` → `await machine.scope.dispose()` → `await handle.close()` → `detachAgent()` → `detachSession()`。
  第三方只能拿到最后两步里的 `detachSession` 等价物，前面的有序步骤一概拿不到，等于把一个已卸载的会话连同活着的机器一起留在内存里。

## 建议的 API 形状（供参考，不限定实现）

1. **宿主**：`ctx.sessions.unload(id)`（或 `delete(id)` / `close(id)`）
   - 返回 `{ unloaded: boolean, wasLive: boolean, detail }` 之类的可判定结果；
   - 内部执行上面那条**有序**拆除链（取消 → 等待空闲 → 作用域销毁 → handle.close → 两个 detach），而不是只做 `store.delete`；
   - 对「仍有进行中工作」的会话返回明确的拒绝原因（或提供 `force` 选项），让调用方不必自己猜；
   - 触发既有 `session/disposed`，从而复用现成的 `api-session/removed` → 客户端 `{kind:'remove'}` 链路（这条链路目前已经完整可用）。
2. **持久层**：`ctx.sessionPersistence.delete(id)`（或让 `unload` 负责）
   - 删会话目录、投影缓存记录与其备份、以及 `spill` 的 `session-<hash>` 目录；
   - 由宿主统一处理，才能保证「域内存行 + 介质」一致（投影缓存是写回型缓存，只删文件会被下一次检查点复活——这正是当前第三方实现踩到的坑）。
3. **可选**：给会话列表加一个 waterfall `session/list-filter`，让插件能在列表层面隐藏 id；但这只是权宜，不应替代 1。

## 兼容性诉求

- 即使只先补一个**最小**的 `sessions.unload(id)`（不做有序拆除、不做持久层删除），也已经比现状好得多：第三方可以「先 unload 再自己删文件」，并且不再需要伪装。
- 请把该 API 编入生成的 API catalog（`dsh-tool-cordis` 的 api-catalog），这样插件可以做能力探测与版本降级，而不是靠 `liveEntryFor` / `detachEntered` 这类不在契约里的原型方法。

## 第三方插件当前的临时做法（可作对照）

`dsh-session-clean@1.1.2`（首个真卸载实现为 1.1.0）在探测到 `ctx.sessions.liveEntryFor(session).detach()` 这类原型方法存在时调用它（即框架自己的 `store.delete` + `attachments.delete` + `emit session/disposed`），从而让侧栏那一行被真正摘掉；删投影缓存时走域的真表名 `sessions`（键为完整会话 id）而不是只删文件；并删除 spill 目录。任一步探测失败时，它会退化为「冻结 + 隐藏」并把 `unloaded:false` 如实返回给界面。

**只要官方提供上述 API，这些内部伸手与降级文案都可以立即删除。**
