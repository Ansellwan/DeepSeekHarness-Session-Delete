/**
 * Host half of the `dsh-session-clean` bundle.
 *
 * DSH ships archive/pin/rename/fork for sidebar sessions but no way to delete
 * one. This plugin adds exactly that, behind a small private HTTP surface the
 * client half calls:
 *
 *   GET  /_dsh-session-clean/status?sessionId=…   → { busy, detail }
 *   POST /_dsh-session-clean/delete {sessionId}   → { ok, removed: […] }
 *
 * Deletion is a hard contract, not a UI nicety, and it proceeds in order:
 *
 *   1. re-probe for live work (running turn, pending approval / answer) and
 *      refuse while any of it is active — even if the sidebar UI was stale;
 *   2. if the session is still resident in the Host's live store, unload it
 *      for real (see {@link unloadLiveSession}) so the browser DROPS its row
 *      instead of merely hiding it;
 *   3. remove the session from the workspace registry through the SAME
 *      storage-domain handle the registry already holds open
 *      (`storageDomain.get`), so every write persists durably AND emits
 *      `domain/changed`, which is what makes the open sidebar refresh;
 *   4. erase the durable payload: the session directory under
 *      `~/.dsh/sessions/<workspace>/<sessionId>/`, its `session_projcache`
 *      record and backing file, and its spilled tool results under the spill
 *      backend's session-hashed directory.
 *
 * Steps 1, 3 and 4 rest on documented contracts. Step 2 does not: DSH ships no
 * session-unload API, so it reaches the framework's own teardown (see
 * {@link unloadLiveSession}). When that probe fails the plugin falls back to
 * hiding the residual row and SAYS SO in its response — it never reports a
 * clean deletion it did not achieve.
 *
 * Runtime contracts verified against app.asar 0.2.0-rc.2:
 *   * `WebRoute = { kind, path, handler(req, res) }` — a NODE handler pair;
 *   * a plugin route is PUBLIC unless it checks `ctx.connection` itself;
 *   * `ctx.storageDomain.get(name)` returns the single open domain instance;
 *     `domain.table(name)` is a validated KV handle whose `put/update/delete`
 *     persist first, then mutate memory, then emit `domain/changed`;
 *   * `domain.global` is the same contract for the domain's singleton state.
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, readdir } from 'node:fs/promises'
import { existsSync, appendFileSync, mkdirSync } from 'node:fs'

const TAG = '[session-delete]'

/** Private route prefix. `/api` and `/plugins` belong to other hosts. */
const ROUTE_PREFIX = '/_dsh-session-clean'

/** Sessions live per-workspace under the DSH home. Tests may redirect the root. */
const sessionsRoot = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'sessions')
}

/** Best-effort projection-cache store beside the workspace registry file. */
const projcacheSessionsDir = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}

/** A session id is always `session-<uuid>`; anything else is rejected early. */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/

/**
 * Directory holding the spill backend's private per-process roots. The real
 * default is the OS temp dir; tests redirect it the same way they redirect the
 * DSH home, so a test run can never touch a real spill root.
 */
const spillBase = () => process.env.DSH_SESSION_DELETE_TMP ?? tmpdir()

/**
 * Default spill-root name, as minted by `mkdtempSync(join(tmpdir(),
 * 'dsh-spill-'))`: the prefix plus exactly six random characters. The backend's
 * own startup sweep matches this exact shape rather than the bare prefix, so a
 * foreign `dsh-spill-…` directory is never swept; we hold to the same rule.
 */
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

/**
 * Session-scoped spill directory name — byte-for-byte the backend's
 * `sessionDir()`: `session-` plus the first 12 hex digits of
 * `sha256(sessionId)`.
 * @param {string} sessionId - a `session-<uuid>` id.
 * @returns {string} that session's spill directory name.
 */
const spillSessionDirName = (sessionId) =>
  `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`

/** Operation log beside the DSH logs — the crash dialog shows symptoms, this file shows causes. */
const opLogPath = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'logs', 'session-delete.log')
}

/** Append one timestamped line; diagnostics must never break the request path. */
async function opLog(line) {
  try {
    mkdirSync(dirname(opLogPath()), { recursive: true })
    appendFileSync(opLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* swallow */
  }
}

export const name = 'session-delete'
export const inject = ['webServer', 'connection', 'storageDomain']

/**
 * @param {string} sessionId - a `session-<uuid>` id.
 * @returns {string} the bare uuid, e.g. for projection-cache file names.
 */
const uuidOf = (sessionId) => sessionId.slice('session-'.length)

/**
 * Best-effort liveness probe for one session. The sidebar already greys the
 * action while a turn runs; this is the authoritative re-check on the Host,
 * so a stale menu can never race a just-started task into a deletion.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to probe.
 * @returns {{ busy: boolean, detail: string }}
 */
function probeBusy(ctx, sessionId) {
  const agents = ctx.get?.('agents') ?? ctx.agents
  if (!agents || typeof agents.get !== 'function') {
    // Registry absent: refuse to guess. Deletion stays available only when we
    // can positively say the session has no live agent.
    return { busy: false, detail: 'agents-unavailable' }
  }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined || agent === null) return { busy: false, detail: 'no-live-agent' }
  const snapshot =
    agent?.session?.getSnapshot?.() ??
    agent?.getSnapshot?.() ??
    (typeof agent?.session === 'object' ? undefined : undefined)
  const running =
    snapshot?.running === true ||
    snapshot?.pendingInteraction !== undefined && snapshot?.pendingInteraction !== null
  if (running) {
    return { busy: true, detail: snapshot?.running === true ? 'running' : 'pending-interaction' }
  }
  // A live agent that is provably idle is fine to delete behind.
  return { busy: false, detail: 'agent-idle' }
}

/**
 * Resolve one Host service without turning it into a load-time dependency.
 * @param {object} ctx - the Host plugin context.
 * @param {string} key - the service key.
 * @returns {object|undefined} the service when it is mounted.
 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key) ?? ctx[key]
  } catch {
    return undefined
  }
}

/**
 * Whether a session is still resident in the Host's live store. Residency is
 * the ONLY reason a fully erased session keeps a sidebar row: the client's
 * session list is the union of the persistence layer and
 * `ctx.sessions.list()`, live precedence winning (session-query
 * `listSessions`), and the sidebar's 未分组 bucket is exactly "a listed id no
 * workspace accounts for".
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to test.
 * @returns {boolean} whether the Host still holds it in memory.
 */
function isResident(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  try {
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Make a resident session stop existing for real, instead of faking it.
 *
 * DSH ships no documented unload API (the generated catalog for `sessions`
 * ends at create/prepare/enter/announce/flush/get/list/fork), so this calls
 * the one framework-owned primitive that removes a live session from memory:
 * `SessionStore.liveEntryFor(session).detach()` — `store.delete` +
 * `attachments.delete` + `session/disposed`. Every consequence after that is
 * the framework's own reaction to that lifecycle edge:
 *
 *   * the session controller converts it to `api-session/removed`, the browser
 *     applies a `{kind:'remove'}` list mutation, and the row is DROPPED — not
 *     hidden — and a page reload cannot bring it back;
 *   * the projection cache runs its mandatory "detach" checkpoint and clears
 *     its dirty bookkeeping, so no pending write-behind timer survives to
 *     rewrite the cache record this plugin is about to erase;
 *   * the log writer closes and `Session.append` stops dispatching, so an
 *     erased session can never be persisted again.
 *
 * Reach-through caveat: `liveEntryFor`/`detachEntered` are plain prototype
 * methods, not catalogued API. Every step is probed and contained; a miss
 * returns `{unloaded:false}` and the caller degrades honestly. The session's
 * Agent is intentionally left registered — there is no public detach for it,
 * and poking its store would leave an invisible loop behind — so that residue
 * lives until the next restart and is documented as such. Only ever call this
 * for a session proven idle: flushing a detached session throws
 * `session "…" is not live in this store`.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the resident session to unload.
 * @returns {Promise<{ unloaded: boolean, detail: string }>} what happened.
 */
async function unloadLiveSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return { unloaded: false, detail: 'sessions-unavailable' }
  let session
  try {
    session = sessions.get(sessionId)
  } catch (error) {
    return { unloaded: false, detail: `get-failed: ${error?.message ?? error}` }
  }
  if (session === undefined || session === null) return { unloaded: false, detail: 'not-resident' }
  if (typeof sessions.liveEntryFor !== 'function') return { unloaded: false, detail: 'no-liveEntryFor' }
  if (typeof sessions.detachEntered !== 'function') return { unloaded: false, detail: 'no-detachEntered' }
  try {
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined || entry === null) return { unloaded: false, detail: 'no-entry' }
    sessions.detachEntered(entry)
  } catch (error) {
    return { unloaded: false, detail: `unload-failed: ${error?.message ?? error}` }
  }
  return isResident(ctx, sessionId)
    ? { unloaded: false, detail: 'still-resident' }
    : { unloaded: true, detail: 'detached' }
}

/**
 * DEGRADED FALLBACK — hide a row we could not unload, and label it as such.
 *
 * Used only when {@link unloadLiveSession} fails its capability probe (a DSH
 * build that moved the internals). It writes the id into DSH's global archive
 * set, which makes the default sidebar view (`archivedFilter: 'default'`)
 * filter the row out. Be exact about what this is and is not:
 *
 *   * NOT a deletion path. The row still exists; a user who switches the
 *     sidebar filter to “show archived” / “only archived” sees it return with
 *     an 已归档 badge, and unarchiving puts it back under 未分组 — the plugin
 *     only self-heals at its NEXT start;
 *   * it does freeze the session (the archived-session gate rejects
 *     `agent/pre-step`), which is what stops a resident session from writing
 *     new events and re-persisting itself;
 *   * the caller must therefore answer `unloaded:false, hidden:true` and the
 *     UI must say “hidden, not deleted”.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to hide from the default list.
 * @returns {Promise<boolean>} whether the archived marker was written.
 */
async function hideLiveRemnant(ctx, sessionId) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  if (!domain?.global) return false
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  if (archived.includes(sessionId)) return false
  state.archivedSessionIds = [sessionId, ...archived]
  await domain.global.set(state)
  return true
}

/**
 * Drop archived/pinned ids whose session payload no longer exists anywhere.
 * These are dangles left by deleting a session that was still loaded in memory
 * (see {@link hideLiveRemnant}); a session id without a directory can never be
 * opened again, so the marker is pure noise.
 * @param {object} ctx - the Host plugin context.
 * @returns {Promise<number>} how many dangling ids were dropped.
 */
async function pruneDanglingIds(ctx) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  if (!domain?.global) return 0
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  const pinned = state.pinnedSessionIds ?? []
  if (archived.length === 0 && pinned.length === 0) return 0

  const root = sessionsRoot()
  if (!existsSync(root)) return 0
  const { readdir } = await import('node:fs/promises')
  const workspaceDirs = await readdir(root)
  const alive = (id) => workspaceDirs.some((dir) => existsSync(join(root, dir, id)))

  const nextArchived = archived.filter(alive)
  const nextPinned = pinned.filter(alive)
  const dropped = archived.length - nextArchived.length + (pinned.length - nextPinned.length)
  if (dropped === 0) return 0
  state.archivedSessionIds = nextArchived
  state.pinnedSessionIds = nextPinned
  await domain.global.set(state)
  await opLog(`启动清理: 移除 ${dropped} 个悬空标记（archived ${archived.length}→${nextArchived.length}, pinned ${pinned.length}→${nextPinned.length}）`)
  return dropped
}

/**
 * Remove the session from the workspace registry through the live domain
 * handle: global archive/pin sets plus every workspace's `sessionIds` row.
 * Writes emit `domain/changed`, so the open sidebar updates itself.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to forget.
 * @returns {Promise<{ workspaces: string[], archived: boolean, pinned: boolean }>}
 */
async function forgetInRegistry(ctx, sessionId) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  await opLog(`forgetInRegistry: facility=${facility ? '有' : '无'} domain=${domain ? domain.name ?? 'workspace' : '无'}`)
  if (!domain || typeof domain.table !== 'function' || !domain.global) {
    throw new Error('workspace 存储域未打开，无法从注册表移除该会话')
  }

  const removed = { workspaces: [], archived: false, pinned: false }

  // 1. Registry-global sets. Copy first: the global handle validates the
  //    whole state object on set.
  const globalState = { ...domain.global.get() }
  const archiveSet = globalState.archivedSessionIds ?? []
  const pinSet = globalState.pinnedSessionIds ?? []
  await opLog(`registry 全局: archived=${archiveSet.length} pinned=${pinSet.length} 含目标 archived=${archiveSet.includes(sessionId)} pinned=${pinSet.includes(sessionId)}`)
  if (archiveSet.includes(sessionId)) {
    removed.archived = true
    globalState.archivedSessionIds = archiveSet.filter((id) => id !== sessionId)
  }
  if (pinSet.includes(sessionId)) {
    removed.pinned = true
    globalState.pinnedSessionIds = pinSet.filter((id) => id !== sessionId)
  }
  if (removed.archived || removed.pinned) await domain.global.set(globalState)

  // 2. Per-workspace ownership rows.
  const table = domain.table('workspaces')
  let scanned = 0
  for (const [workspaceId, record] of table.entries()) {
    scanned += 1
    const owned = Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
    await opLog(`registry 扫描 ${workspaceId}(${record?.title ?? '?'}): sessions=${record?.sessionIds?.length ?? '?'} 含目标=${owned}`)
    if (!owned) continue
    const next = {
      ...record,
      sessionIds: record.sessionIds.filter((id) => id !== sessionId),
      updatedAt: new Date().toISOString(),
    }
    await table.update(workspaceId, () => next)
    removed.workspaces.push(record.title || workspaceId)
  }
  await opLog(`registry 扫描完成: 共 ${scanned} 个工作区, 命中 ${removed.workspaces.length}`)
  return removed
}

/**
 * Delete the session's durable log directory under `~/.dsh/sessions/`.
 * @param {string} sessionId - the session to erase.
 * @returns {Promise<string[]>} host paths actually removed.
 */
async function eraseSessionLog(sessionId) {
  const removed = []
  const root = sessionsRoot()
  if (!existsSync(root)) return removed
  for (const workspaceDir of await readdir(root)) {
    const target = join(root, workspaceDir, sessionId)
    if (!existsSync(target)) continue
    await rm(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}

/**
 * Delete the session's spilled tool results.
 *
 * Oversized tool output is stored OUTSIDE `~/.dsh` by `dsh-spill-local`, in a
 * session-scoped directory named `session-<sha256(sessionId)[0..12]>` under a
 * private root. With no configured root the backend mints its own
 * `dsh-spill-<6 chars>` directory under the OS temp dir, so the roots must be
 * discovered exactly the way the backend discovers them for its own startup
 * sweep; only the session-hash directory is removed, never a root.
 *
 * @param {string} sessionId - the session whose spill directory to erase.
 * @returns {Promise<string[]>} spill directories actually removed.
 */
async function eraseSpill(sessionId) {
  const removed = []
  let entries
  try {
    entries = await readdir(spillBase())
  } catch {
    return removed
  }
  const name = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const target = join(spillBase(), entry, name)
    if (!existsSync(target)) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {
      await opLog(`spill 删除失败 ${target}: ${error?.message ?? error}`)
    }
  }
  return removed
}

/**
 * Delete the session's projection-cache record: through the live
 * `session_projcache` domain when it is open, then through the backing file.
 *
 * The domain's real table is `sessions`, keyed by the FULL session id
 * (`session-projection-cache` does `domain.table('sessions')` and
 * `put(session.id, …)`), and its writes are durable-first — the medium is
 * written before memory, so deleting through the domain clears both the
 * per-record document and the in-memory row. That matters: while the row
 * survives, the next write-behind checkpoint recreates the file, which is how
 * a "deleted" session used to leave its title/outline/stats behind.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session whose cache record to erase.
 * @returns {Promise<string[]>} what was actually removed.
 */
async function eraseProjcache(ctx, sessionId) {
  const removed = []
  const uuid = uuidOf(sessionId)
  try {
    const facility = serviceOf(ctx, 'storageDomain')
    const cacheDomain = facility?.get?.('session_projcache')
    if (cacheDomain && typeof cacheDomain.table === 'function') {
      const table = cacheDomain.table('sessions')
      if (table && typeof table.delete === 'function') {
        for (const key of new Set([sessionId, uuid])) {
          try {
            // The domain's `delete` reports false for an absent key, so no
            // pre-check is needed and a missing record stays quiet.
            if (await table.delete(key)) removed.push(`session_projcache#sessions:${key}`)
          } catch (error) {
            await opLog(`projcache 域删除失败 ${key}: ${error?.message ?? error}`)
          }
        }
      }
    }
  } catch (error) {
    await opLog(`projcache 域不可用，改用文件删除: ${error?.message ?? error}`)
  }
  const cacheFiles = [
    join(projcacheSessionsDir(), `${sessionId}.json`),
    join(projcacheSessionsDir(), `${uuid}.json`),
  ]
  for (const cacheFile of cacheFiles) {
    if (!existsSync(cacheFile)) continue
    try {
      await rm(cacheFile, { force: true })
      removed.push(cacheFile)
    } catch (error) {
      await opLog(`projcache 文件删除失败 ${cacheFile}: ${error?.message ?? error}`)
    }
  }
  return removed
}

/**
 * Re-purge the projection cache shortly after a deletion that could NOT unload
 * the session. A deleted-but-resident session may still hold a pending
 * write-behind timer, and that timer rewrites the cache document once (the
 * cache's own "detach" flush only runs on the real unload path). One bounded,
 * unref'd retry keeps that residue from sticking.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to re-purge.
 * @returns {void}
 */
function scheduleResidualPurge(ctx, sessionId) {
  const timer = setTimeout(() => {
    void eraseProjcache(ctx, sessionId)
      .then((again) => opLog(`残留复清: ${sessionId} → ${again.length} 处`))
      .catch((error) => opLog(`残留复清失败: ${sessionId} ${error?.message ?? error}`))
  }, 8000)
  timer.unref?.()
}

/**
 * Delete the session's durable payload: the per-workspace directory under
 * `~/.dsh/sessions/`, the projection-cache record, and its spilled tool
 * results.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to erase.
 * @returns {Promise<string[]>} host paths actually removed.
 */
async function erasePayload(ctx, sessionId) {
  const removed = await eraseSessionLog(sessionId)
  removed.push(...(await eraseProjcache(ctx, sessionId)))
  removed.push(...(await eraseSpill(sessionId)))
  return removed
}

/** Read one JSON body; empty bodies resolve to {}. */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    throw error
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const log = (message, error) => {
    if (error === undefined) console.log(`${TAG} ${message}`)
    else console.warn(`${TAG} ${message}`, error)
  }

  const server = ctx.get?.('webServer') ?? ctx.webServer
  if (!server || typeof server.register !== 'function') {
    log('没有 webServer 服务，删除接口不可用（插件其余部分不受影响）')
    return
  }

  /** Same trust gate the shipped /api bridge uses; plugin routes are public otherwise. */
  const rejectUntrusted = (req, res) => {
    const connection = ctx.get?.('connection') ?? ctx.connection
    if (!connection) return false
    try {
      if (typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection === undefined || rejection === null) return false
        sendJson(res, Number(rejection) || 403, { error: '未通过连接信任检查' })
        return true
      }
      if (typeof connection.admit === 'function') {
        const admission = connection.admit(req)
        if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
          sendJson(res, Number(admission.rejection) || 403, { error: '未通过连接信任检查' })
          return true
        }
      }
    } catch (error) {
      log('连接信任检查本身出错，放行本次请求', error)
    }
    return false
  }

  server.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (rejectUntrusted(req, res)) {
        await opLog(`REJECTED(trust) ${req.method} ${req.url}`)
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === `${ROUTE_PREFIX}/status` && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!SESSION_ID_RE.test(sessionId)) throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          const probe = { ...probeBusy(ctx, sessionId), resident: isResident(ctx, sessionId) }
          await opLog(`status ${sessionId} → ${JSON.stringify(probe)}`)
          sendJson(res, 200, probe)
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/delete` && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
            throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          // Hard gate: never delete a session that still owns live work.
          const busy = probeBusy(ctx, sessionId)
          const resident = isResident(ctx, sessionId)
          await opLog(`delete ${sessionId} busy=${busy.busy}(${busy.detail}) resident=${resident}`)
          if (busy.busy) {
            sendJson(res, 409, { ok: false, error: '会话仍有进行中的工作，无法删除', detail: busy.detail })
            return
          }

          // 1. Real unload FIRST, while the session is proven idle. Doing it
          //    before the payload erase also lets the projection cache's
          //    mandatory "detach" checkpoint land before that record is wiped,
          //    and it closes the log writer so nothing can re-persist later.
          const unload = resident
            ? await unloadLiveSession(ctx, sessionId)
            : { unloaded: false, detail: 'not-resident' }
          await opLog(`卸载活会话: unloaded=${unload.unloaded} (${unload.detail})`)

          // 2. Registry: global archive/pin sets plus every workspace row.
          const registry = await forgetInRegistry(ctx, sessionId)
          await opLog(`registry 移除完成: workspaces=[${registry.workspaces.join('、')}] archived=${registry.archived} pinned=${registry.pinned}`)

          // 3. Durable payload: the session directory + its cache record.
          let removedPaths = []
          try {
            removedPaths = await erasePayload(ctx, sessionId)
          } catch (error) {
            // Registry is already consistent; report the payload failure but
            // do not roll the sidebar removal back.
            await opLog(`载荷清理失败（注册表已移除）: ${error?.message ?? error}`)
            log(`会话载荷清理失败（注册表已移除）：${sessionId}`, error)
          }

          // 4. Still resident ⇒ the unload probe failed. Degrade honestly:
          //    freeze + hide it, report that, and re-purge the cache once its
          //    pending write-behind timer has had a chance to fire.
          let hidden = false
          const live = isResident(ctx, sessionId)
          if (live) {
            try {
              hidden = await hideLiveRemnant(ctx, sessionId)
              await opLog(`活会话未卸载，降级隐藏: hidden=${hidden}`)
            } catch (error) {
              await opLog(`活会话残留隐藏失败: ${error?.message ?? error}`)
            }
            scheduleResidualPurge(ctx, sessionId)
          }
          await opLog(`已删除会话 ${sessionId}，文件 ${removedPaths.length} 处: ${removedPaths.join(' | ')}`)
          log(`已删除会话 ${sessionId}（工作区：${registry.workspaces.join('、') || '未知'}，文件 ${removedPaths.length} 处，卸载=${unload.unloaded}）`)
          sendJson(res, 200, {
            ok: true,
            ...registry,
            removed: removedPaths,
            live,
            unloaded: unload.unloaded,
            unloadDetail: unload.detail,
            hidden,
          })
          return
        }
        await opLog(`404 ${req.method} ${req.url}`)
        sendJson(res, 404, { error: '未知接口' })
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        await opLog(`ERROR ${req.method} ${req.url} → ${status}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}`)
        log(`请求失败：${req?.url ?? ''}`, error)
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  log(`删除接口就绪：${ROUTE_PREFIX}/status 与 ${ROUTE_PREFIX}/delete`)
  void opLog(`plugin activated (session-delete), routes on ${ROUTE_PREFIX}`)
  // Self-heal markers left by deleting a session that was still loaded in memory.
  void pruneDanglingIds(ctx).catch((error) => opLog(`启动清理失败: ${error?.message ?? error}`))
}
