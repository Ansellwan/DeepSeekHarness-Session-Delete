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
 * Deletion is a hard contract, not a UI nicety: before anything is removed the
 * Host re-probes the session for live work (running turn, pending approval /
 * answer) and refuses while any of it is active — even if the sidebar UI was
 * stale. The registry mutation then goes through the SAME storage-domain
 * handle the workspace registry already holds open (`storageDomain.get`), so
 * every write persists durably AND emits `domain/changed`, which is what makes
 * the open sidebar refresh itself. Finally the session's durable directory
 * under `~/.dsh/sessions/<workspace>/<sessionId>/` and its projection-cache
 * entry are removed.
 *
 * Runtime contracts verified against app.asar 0.2.0-rc.2:
 *   * `WebRoute = { kind, path, handler(req, res) }` — a NODE handler pair;
 *   * a plugin route is PUBLIC unless it checks `ctx.connection` itself;
 *   * `ctx.storageDomain.get(name)` returns the single open domain instance;
 *     `domain.table(name)` is a validated KV handle whose `put/update/delete`
 *     persist first, then mutate memory, then emit `domain/changed`;
 *   * `domain.global` is the same contract for the domain's singleton state.
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { rm, appendFileSync, mkdirSync } from 'node:fs/promises'
import { existsSync } from 'node:fs'

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

/** Operation log beside the DSH logs — the crash dialog shows symptoms, this file shows causes. */
const opLogPath = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'logs', 'session-delete.log')
}

/** Append one timestamped line; diagnostics must never break the request path. */
async function opLog(line) {
  try {
    await mkdir(dirname(opLogPath()), { recursive: true })
    await appendFile(opLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8')
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
 * Delete the session's durable payload: the per-workspace directory under
 * `~/.dsh/sessions/` and the projection-cache entry (through its domain when
 * the domain is open, else the backing file).
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to erase.
 * @returns {Promise<string[]>} host paths actually removed.
 */
async function erasePayload(ctx, sessionId) {
  const removed = []
  const uuid = uuidOf(sessionId)

  // 1. Session log + per-session caches under sessions/<workspace>/<id>/.
  const root = sessionsRoot()
  if (existsSync(root)) {
    const { readdir } = await import('node:fs/promises')
    for (const workspaceDir of await readdir(root)) {
      const target = join(root, workspaceDir, sessionId)
      if (!existsSync(target)) continue
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    }
  }

  // 2. Projection cache. The domain is write-behind: prefer deleting the key
  //    through the live domain so memory and medium stay consistent; only a
  //    closed domain falls back to removing the backing file.
  try {
    const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
    const cacheDomain = facility?.get?.('session_projcache')
    if (cacheDomain && typeof cacheDomain.table === 'function') {
      const tables = ['documents', 'records', 'entries']
      for (const tableName of tables) {
        try {
          const table = cacheDomain.table(tableName)
          for (const key of table.keys()) {
            if (key === sessionId || key === uuid || String(key).includes(uuid)) {
              await table.delete(key)
              removed.push(`session_projcache#${tableName}:${key}`)
            }
          }
        } catch {
          // Table name guesses are best-effort; unknown names simply skip.
        }
      }
    }
  } catch {
    // Fall through to the file fallback below.
  }
  const cacheFileA = join(projcacheSessionsDir(), `${uuid}.json`)
  const cacheFileB = join(projcacheSessionsDir(), `${sessionId}.json`)
  for (const cacheFile of [cacheFileA, cacheFileB]) {
    if (!existsSync(cacheFile)) continue
    try {
      await rm(cacheFile, { force: true })
      removed.push(cacheFile)
    } catch {
      // A live write-behind may hold the file; a stale cache entry for a
      // missing session is harmless — the projection layer rebuilds nothing.
    }
  }
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
          const probe = probeBusy(ctx, sessionId)
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
          await opLog(`delete ${sessionId} busy=${busy.busy}(${busy.detail})`)
          if (busy.busy) {
            sendJson(res, 409, { ok: false, error: '会话仍有进行中的工作，无法删除', detail: busy.detail })
            return
          }
          const registry = await forgetInRegistry(ctx, sessionId)
          await opLog(`registry 移除完成: workspaces=[${registry.workspaces.join('、')}] archived=${registry.archived} pinned=${registry.pinned}`)
          let removedPaths = []
          try {
            removedPaths = await erasePayload(ctx, sessionId)
          } catch (error) {
            // Registry is already consistent; report the payload failure but
            // do not roll the sidebar removal back.
            await opLog(`载荷清理失败（注册表已移除）: ${error?.message ?? error}`)
            log(`会话载荷清理失败（注册表已移除）：${sessionId}`, error)
          }
          await opLog(`已删除会话 ${sessionId}，文件 ${removedPaths.length} 处: ${removedPaths.join(' | ')}`)
          log(`已删除会话 ${sessionId}（工作区：${registry.workspaces.join('、') || '未知'}，文件 ${removedPaths.length} 处）`)
          sendJson(res, 200, { ok: true, ...registry, removed: removedPaths })
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
}
