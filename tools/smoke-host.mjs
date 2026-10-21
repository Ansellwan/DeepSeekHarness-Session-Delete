// Smoke test: run the host half against a mock ctx seeded with a copy of the
// real workspace.json shape, and drive /status + /delete through the captured
// route. All file operations land in a throwaway temp dir, never the real DSH
// home.
//
// Five behaviours are pinned here, because they are the ones that were wrong
// before 1.1.0:
//   1. a resident session is unloaded through the framework's own detach
//      primitive, and the archived marker is NOT written for it;
//   2. when that primitive is unavailable the plugin degrades to hide +
//      report, instead of claiming a clean deletion;
//   3. the projection cache is deleted through its real domain table
//      (`sessions`, keyed by the full session id), not through guessed names;
//   4. a cold session touches neither the store nor the archive set;
//   5. the session's spill directory is removed by its exact backend naming
//      rules (session hash dir only — roots, siblings and foreign
//      `dsh-spill-*` shapes survive).
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HOME = join(tmpdir(), 'dsh-session-clean-smoke')
rmSync(FAKE_HOME, { recursive: true, force: true })
const TARGET = 'session-b37044e4-c5f2-4de2-b1fd-171e2778603d'
const COLD = 'session-33333333-3333-4333-8333-333333333333'
const LIVE = 'session-22222222-2222-4222-8222-222222222222'
const DEGRADED = 'session-44444444-4444-4444-8444-444444444444'

mkdirSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET, 'session_projcache'), { recursive: true })
mkdirSync(join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111'), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd'), 'keep')
mkdirSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET, 'session.v4.jsonl.zstd'), 'payload')
writeFileSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`), '{}')
process.env.DSH_SESSION_DELETE_HOME = FAKE_HOME

// Spill roots: the backend mints `dsh-spill-<6 chars>` under the OS temp dir and
// stores each session under `session-<sha256(id)[0..12]>`. Redirect the base and
// seed one root so the removal can be asserted without touching a real root.
const FAKE_TMP = join(FAKE_HOME, 'tmp')
process.env.DSH_SESSION_DELETE_TMP = FAKE_TMP
const spillDirName = (id) => `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
mkdirSync(join(FAKE_TMP, 'dsh-spill-abc123', spillDirName(TARGET)), { recursive: true })
writeFileSync(join(FAKE_TMP, 'dsh-spill-abc123', spillDirName(TARGET), 'result.txt'), 'spilled tool output')
mkdirSync(join(FAKE_TMP, 'dsh-spill-abc123', 'session-backup'), { recursive: true })
writeFileSync(join(FAKE_TMP, 'dsh-spill-abc123', 'session-backup', 'keep.txt'), 'not a session hash dir')
mkdirSync(join(FAKE_TMP, 'dsh-spill-test-fixture', spillDirName(TARGET)), { recursive: true })
writeFileSync(join(FAKE_TMP, 'dsh-spill-test-fixture', spillDirName(TARGET), 'keep.txt'), 'foreign root shape')

const real = JSON.parse(readFileSync(process.env.USERPROFILE + '/.dsh/storages/workspace.json', 'utf8'))

const globalState = JSON.parse(JSON.stringify(real.global))
const workspaces = new Map(Object.entries(JSON.parse(JSON.stringify(real.tables.workspaces))))

// ---- Storage domains -----------------------------------------------------
// `workspace` keeps the real registry shape; `session_projcache` pins the real
// table name (`sessions`) and key (the full session id) the cache service uses.
const projcacheRecords = new Map([
  [TARGET, { identity: {}, rows: {} }],
  [LIVE, { identity: {}, rows: {} }],
  [DEGRADED, { identity: {}, rows: {} }],
])
const projcacheDeletes = []

const storageDomain = {
  get(name) {
    if (name === 'workspace') {
      return {
        global: {
          get: () => globalState,
          async set(v) { Object.assign(globalState, v) },
        },
        table(t) {
          if (t !== 'workspaces') throw new Error('no table ' + t)
          return {
            entries: () => workspaces.entries(),
            keys: () => workspaces.keys(),
            get: (k) => workspaces.get(k),
            async update(k, fn) { workspaces.set(k, fn(workspaces.get(k))) },
            async delete(k) { return workspaces.delete(k) },
          }
        },
      }
    }
    if (name === 'session_projcache') {
      return {
        table(t) {
          if (t !== 'sessions') throw new Error('no table ' + t)
          return {
            get: (k) => projcacheRecords.get(k),
            async delete(k) {
              const had = projcacheRecords.has(k)
              projcacheRecords.delete(k)
              if (had) projcacheDeletes.push(k)
              return had
            },
          }
        },
      }
    }
    return undefined
  },
}

// ---- Host session store mock --------------------------------------------
// `resident` models ctx.sessions — the live in-memory store the sidebar list
// unions into. `unloadSupported=false` models a DSH build without the internal
// detach primitive, so the degraded path can be exercised.
const resident = new Map()
const unloadCalls = []
let unloadSupported = true
const sessions = {
  get: (id) => resident.get(id),
  list: () => [...resident.values()],
  liveEntryFor(session) {
    for (const [id, s] of resident) if (s === session) return { id, session }
    throw new Error(`session "${session?.id}" is not live in this store`)
  },
  detachEntered(entry) {
    resident.delete(entry.id)
    unloadCalls.push(entry.id)
  },
}
const strippedSessions = { get: sessions.get, list: sessions.list }

// A session the Host still holds idle (live but not running) exercises the
// unload path; everything else behaves as "no live agent".
const idleSnapshot = { running: false, pendingInteraction: null }
/** Extra agents registered by later sections (busy batch members). */
const extraAgents = new Map()
const agents = {
  get: (id) => {
    if (extraAgents.has(id)) return extraAgents.get(id)
    return id === LIVE || id === DEGRADED ? { session: { getSnapshot: () => idleSnapshot } } : undefined
  },
}

let captured = null
const ctx = {
  get: (key) => ({
    webServer: { register(route) { captured = route } },
    connection: undefined,
    storageDomain,
    agents,
    sessions: unloadSupported ? sessions : strippedSessions,
  }[key]),
  storageDomain,
  agents,
}

await import('../index.js').then(async (mod) => {
  mod.apply(ctx)
})

// `apply` fires the startup self-heal without awaiting it, and that self-heal
// legitimately drops archived/pinned ids whose session directory does not
// exist — this fake home only holds a few. Let it settle so every snapshot
// below is stable.
await new Promise((resolve) => setTimeout(resolve, 50))

function call(method, url, bodyObj) {
  return new Promise(async (resolveRes) => {
    const chunks = bodyObj ? [Buffer.from(JSON.stringify(bodyObj))] : []
    const req = { method, url, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) { resolveRes({ status: this.statusCode, body: body ? JSON.parse(body) : null }) },
    }
    await captured.handler(req, res)
  })
}

const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
}

/** Registry writes replace the record object, so always re-read from the map. */
const attachToWorkspace = (id, index = 0) => {
  const row = [...workspaces.values()][index]
  row.sessionIds = [...row.sessionIds, id]
}

// ---- 1. cold session: no store, no archive marker ------------------------
const before = globalState.archivedSessionIds.length
const st = await call('GET', '/_dsh-session-clean/status?sessionId=' + TARGET)
check('status reports busy=false and resident=false', st.body?.busy === false && st.body?.resident === false, JSON.stringify(st.body))

const del = await call('POST', '/_dsh-session-clean/delete', { sessionId: TARGET })
check('cold delete succeeds', del.status === 200 && del.body?.ok === true, `status=${del.status}`)
check('cold delete is not "live" and not "unloaded"', del.body?.live === false && del.body?.unloaded === false)
check('cold delete drops the id from the archive set and adds nothing',
  !globalState.archivedSessionIds.includes(TARGET) && globalState.archivedSessionIds.length <= before,
  `${before}→${globalState.archivedSessionIds.length}`)
check('cold delete calls no unload', unloadCalls.length === 0)
check('projcache domain row deleted by full session id', projcacheDeletes.includes(TARGET), `deletes=[${projcacheDeletes.join(',')}]`)
check('projcache backing file removed',
  !existsSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`)))
check('session payload directory removed', !existsSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET)))
check('session spill directory removed', !existsSync(join(FAKE_TMP, 'dsh-spill-abc123', spillDirName(TARGET))))
check('spill root and non-session siblings survive',
  existsSync(join(FAKE_TMP, 'dsh-spill-abc123', 'session-backup', 'keep.txt')))
check('foreign dsh-spill-* shapes are never swept',
  existsSync(join(FAKE_TMP, 'dsh-spill-test-fixture', spillDirName(TARGET), 'keep.txt')))
check('unrelated session untouched',
  existsSync(join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd')))
check('workspace row cleaned', ![...workspaces.values()].some((w) => w.sessionIds.includes(TARGET)))

// ---- 2. resident session with the unload primitive: REAL unload -----------
resident.set(LIVE, { id: LIVE, getSnapshot: () => idleSnapshot })
attachToWorkspace(LIVE)
mkdirSync(join(FAKE_HOME, 'sessions', 'ws-two', LIVE), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-two', LIVE, 'session.v4.jsonl.zstd'), 'live')
const beforeLive = globalState.archivedSessionIds.length

const liveDel = await call('POST', '/_dsh-session-clean/delete', { sessionId: LIVE })
check('resident delete reports unloaded=true', liveDel.body?.unloaded === true, `detail=${liveDel.body?.unloadDetail}`)
check('resident delete reports live=false after unloading', liveDel.body?.live === false)
check('resident delete writes NO archive marker', !globalState.archivedSessionIds.includes(LIVE) && globalState.archivedSessionIds.length === beforeLive)
check('unload went through the framework detach primitive', unloadCalls.includes(LIVE))
check('store no longer holds the session', resident.has(LIVE) === false)
check('resident payload + cache erased',
  !existsSync(join(FAKE_HOME, 'sessions', 'ws-two', LIVE)) && projcacheDeletes.includes(LIVE))

// ---- 3. resident session WITHOUT the primitive: honest degradation --------
unloadSupported = false
resident.set(DEGRADED, { id: DEGRADED, getSnapshot: () => idleSnapshot })
attachToWorkspace(DEGRADED)
mkdirSync(join(FAKE_HOME, 'sessions', 'ws-two', DEGRADED), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-two', DEGRADED, 'session.v4.jsonl.zstd'), 'degraded')
const beforeDegraded = globalState.archivedSessionIds.length

const degDel = await call('POST', '/_dsh-session-clean/delete', { sessionId: DEGRADED })
check('degraded delete reports unloaded=false', degDel.body?.unloaded === false, `detail=${degDel.body?.unloadDetail}`)
check('degraded delete reports live=true and hidden=true', degDel.body?.live === true && degDel.body?.hidden === true)
check('degraded delete writes the archive marker as its last resort',
  globalState.archivedSessionIds.includes(DEGRADED) && globalState.archivedSessionIds.length === beforeDegraded + 1)
check('degraded delete still erases payload + cache',
  !existsSync(join(FAKE_HOME, 'sessions', 'ws-two', DEGRADED)) && projcacheDeletes.includes(DEGRADED))

// ---- 4. guards -----------------------------------------------------------
const busy = await call('GET', '/_dsh-session-clean/status?sessionId=session-00000000-0000-4000-8000-000000000000')
check('unknown id probes clean', busy.body?.busy === false, JSON.stringify(busy.body))
const bad = await call('POST', '/_dsh-session-clean/delete', { sessionId: 'rm -rf /' })
check('malformed id rejected with 400', bad.status === 400, `status=${bad.status}`)

// ---- 5. bulk pre-flight (group cleanup) -----------------------------------
// The batch gate is the single-session iron rule applied to a group: any busy
// member refuses the WHOLE batch instead of silently skipping it.
const BULK_IDLE = 'session-11111111-1111-4111-8111-111111111111'
const BULK_RUNNING = 'session-22222222-2222-4222-8222-222222222222'
const BULK_WAITING = 'session-33333333-3333-4333-8333-333333333333'

const idlePre = await call('GET', `/_dsh-session-clean/precheck?sessionIds=${BULK_IDLE}`)
check('precheck of an idle batch is ok', idlePre.body?.ok === true && idlePre.body?.total === 1,
  JSON.stringify(idlePre.body))

extraAgents.set(BULK_RUNNING, {
  session: { getSnapshot: () => ({ sessionId: BULK_RUNNING, running: true, pendingInteraction: null }) },
})
extraAgents.set(BULK_WAITING, {
  session: {
    getSnapshot: () => ({ sessionId: BULK_WAITING, running: false, pendingInteraction: { kind: 'approval' } }),
  },
})
const busyPre = await call(
  'GET',
  `/_dsh-session-clean/precheck?sessionIds=${BULK_IDLE},${BULK_RUNNING},${BULK_WAITING}`,
)
check('precheck refuses a batch holding a running member', busyPre.body?.ok === false)
check('precheck reports exactly the two busy members', busyPre.body?.busy?.length === 2,
  JSON.stringify(busyPre.body?.busy?.map((entry) => entry.sessionId)))
check('precheck keeps every member in the report', busyPre.body?.sessions?.length === 3)

const emptyPre = await call('GET', '/_dsh-session-clean/precheck?sessionIds=')
check('precheck rejects an empty batch with 400', emptyPre.status === 400, `status=${emptyPre.status}`)
const malformedPre = await call('GET', '/_dsh-session-clean/precheck?sessionIds=not-a-session')
check('precheck rejects a malformed id with 400', malformedPre.status === 400, `status=${malformedPre.status}`)
const tooMany = await call(
  'GET',
  `/_dsh-session-clean/precheck?sessionIds=${Array.from({ length: 201 }, (_, index) =>
    `session-${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`).join(',')}`,
)
check('precheck rejects an over-limit batch with 400', tooMany.status === 400, `status=${tooMany.status}`)

rmSync(FAKE_HOME, { recursive: true, force: true })
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
