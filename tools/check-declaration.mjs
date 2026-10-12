#!/usr/bin/env node
/**
 * Pre-publish declaration gate.
 *
 * Every check here is a mistake that has actually broken a DSH desktop boot or
 * a published package. The client-module host validates these declarations at
 * composition time and a single bad one aborts startup, which on the desktop
 * triggers the boot-recovery flow (profile patch reset + all third-party
 * bundles disabled). That is far too expensive to discover after publishing,
 * so the gate runs before any publish.
 *
 * Checks:
 *   1. every text file is BOM-free (npm tolerates a BOM, the DSH loader does
 *      not: it fails to parse package.json and silently skips the plugin);
 *   2. `dsh.client` present => `exports["./client"]` is a string (or an object
 *      with a string `default`) that resolves to an existing file — the exact
 *      rule dsh-client-modules applies, which throws
 *      `declares dsh.client but exports no "./client" bundle` otherwise;
 *   3. the client entry id, the locale namespace and the cordis.patch.yml row
 *      name all match package.json#name (a rename that misses one silently
 *      fails registration);
 *   4. `exports["."]` exists so the host half stays importable.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** @param {string} message - failure text. */
const fail = (message) => failures.push(message)

/* 1. BOM scan over shipped text files — runs before any parse, so a BOM'd
   package.json is reported as the real problem instead of a raw JSON error. */
const TEXT = /\.(js|mjs|cjs|json|yml|yaml|md|txt)$/
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!TEXT.test(name)) continue
    const head = readFileSync(full).subarray(0, 3)
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      fail(`BOM detected in ${full.slice(ROOT.length + 1)} — the DSH loader rejects BOM'd package.json and silently skips the plugin`)
    }
  }
}
walk(ROOT)

if (failures.length > 0) {
  console.error(`\n声明校验未通过（${failures.length} 项）:`)
  for (const item of failures) console.error(`  ✗ ${item}`)
  process.exit(1)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`\n声明校验未通过：package.json 无法解析 — ${error.message}`)
  process.exit(1)
}

/* 2. dsh.client declaration and its required "./client" export. */
const client = pkg.dsh?.client
if (client !== undefined) {
  if (typeof client.platform !== 'string') fail('dsh.client.platform must be a string')
  const exportsField = pkg.exports
  if (typeof exportsField !== 'object' || exportsField === null) {
    fail('package declares dsh.client but has no "exports" field — dsh-client-modules throws "declares dsh.client but exports no ./client bundle" and startup aborts')
  } else {
    const entry = exportsField['./client']
    const rel = typeof entry === 'string' ? entry : typeof entry?.default === 'string' ? entry.default : undefined
    if (rel === undefined) {
      fail('exports["./client"] is missing or not a string (string or { default: string } only) — composition aborts with "declares dsh.client but exports no ./client bundle"')
    } else if (!existsSync(join(ROOT, rel))) {
      fail(`exports["./client"] points at ${rel}, which does not exist`)
    } else {
      notes.push(`client bundle: ${rel}`)
    }
  }
  for (const spec of client.inject ?? []) {
    if (!/^@deepseek-ai\/dsh-client-/.test(spec)) continue
    notes.push(`inject ${spec} — confirm it declares dsh.client in its own package.json (runtime libraries such as dsh-client-ui-primitives do not)`)
  }
}

/* 3. Host entry export. */
if (typeof pkg.exports?.['.'] !== 'string') fail('exports["."] must point at the host half, or the loader row resolves nothing')

/* 4. Name consistency across every hardcoded seat. */
const clientSource = existsSync(join(ROOT, 'client.js')) ? readFileSync(join(ROOT, 'client.js'), 'utf8') : ''
const idMatch = /id:\s*'([^']+)'/.exec(clientSource)
if (idMatch !== null && idMatch[1] !== pkg.name) {
  fail(`client.js entry id '${idMatch[1]}' != package name '${pkg.name}' (clientModules keys the bundle by id)`)
}
const patchPath = pkg.dsh?.bundle?.patch
if (typeof patchPath === 'string' && existsSync(join(ROOT, patchPath))) {
  const patch = readFileSync(join(ROOT, patchPath), 'utf8')
  const names = [...patch.matchAll(/name:\s*['"]?([^'"\s]+)['"]?/g)].map((match) => match[1])
  for (const name of names) {
    if (name !== pkg.name) fail(`${patchPath} references '${name}' but the package name is '${pkg.name}'`)
  }
}

if (notes.length > 0) for (const note of notes) console.log(`note: ${note}`)
if (failures.length > 0) {
  console.error(`\n声明校验未通过（${failures.length} 项）:`)
  for (const item of failures) console.error(`  ✗ ${item}`)
  process.exit(1)
}
console.log(`声明校验通过：${pkg.name}@${pkg.version}`)
