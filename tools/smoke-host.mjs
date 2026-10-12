// Smoke test: run the host half against a mock ctx seeded with a copy of the
// real workspace.json shape, and drive /status + /delete through the captured
// route. All file operations land in a throwaway temp dir, never the real
// DSH home.
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HOME = join(tmpdir(), 'dsh-session-clean-smoke')
rmSync(FAKE_HOME, { recursive: true, force: true })
const TARGET = 'session-b37044e4-c5f2-4de2-b1fd-171e2778603d'
mkdirSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET, 'session_projcache'), { recursive: true })
mkdirSync(join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111'), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd'), 'keep')
mkdirSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET, 'session.v4.jsonl.zstd'), 'payload')
writeFileSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions', `${TARGET.slice('session-'.length)}.json`), '{}')
process.env.DSH_SESSION_DELETE_HOME = FAKE_HOME

const real = JSON.parse(readFileSync(process.env.USERPROFILE + '/.dsh/storages/workspace.json', 'utf8'))

const globalState = JSON.parse(JSON.stringify(real.global))
const workspaces = new Map(Object.entries(JSON.parse(JSON.stringify(real.tables.workspaces))))

const storageDomain = {
  get(name) {
    if (name !== 'workspace') return undefined
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
  },
}

const agents = { get: (id) => (id === TARGET ? undefined : undefined) }

let captured = null
const ctx = {
  get: (key) => ({ webServer: { register(route) { captured = route } }, connection: undefined, storageDomain, agents }[key]),
  storageDomain, agents,
}

await import('../index.js').then(async (mod) => {
  mod.apply(ctx)
})

function makeRes() {
  return new Promise((resolveRes) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) { resolveRes({ status: this.statusCode, body: body && JSON.parse(body) }) },
    }
    resolveRes.__res = res
  })
}

// Slight dance: handler calls res methods synchronously; wrap into promise.
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

const before = globalState.archivedSessionIds.length
const st = await call('GET', '/_dsh-session-clean/status?sessionId=' + TARGET)
console.log('status →', JSON.stringify(st.body))

const del = await call('POST', '/_dsh-session-clean/delete', { sessionId: TARGET })
console.log('delete →', JSON.stringify({ status: del.status, ok: del.body?.ok, removed: del.body?.removed }))

const stillInWorkspace = [...workspaces.values()].some((w) => w.sessionIds.includes(TARGET))
console.log('archived set:', before, '→', globalState.archivedSessionIds.length,
  '| still listed in a workspace:', stillInWorkspace,
  '| pinned untouched:', globalState.pinnedSessionIds.length)

const busy = await call('GET', '/_dsh-session-clean/status?sessionId=session-00000000-0000-4000-8000-000000000000')
console.log('status(unknown id) →', JSON.stringify(busy.body))

const bad = await call('POST', '/_dsh-session-clean/delete', { sessionId: 'rm -rf /' })
console.log('delete(bad id) →', bad.status)

// File assertions: the target's durable dir and cache entry are gone, the
// unrelated session in another workspace survives.
const targetGone =
  !existsSync(join(FAKE_HOME, 'sessions', 'ws-one', TARGET)) &&
  !existsSync(join(FAKE_HOME, 'storages', 'session_projcache', 'sessions', `${TARGET.slice('session-'.length)}.json`))
const survivorAlive = existsSync(
  join(FAKE_HOME, 'sessions', 'ws-two', 'session-11111111-1111-4111-8111-111111111111', 'session.v4.jsonl.zstd'),
)
console.log('target payload erased:', targetGone, '| unrelated session intact:', survivorAlive)

rmSync(FAKE_HOME, { recursive: true, force: true })
process.exitCode = 0
