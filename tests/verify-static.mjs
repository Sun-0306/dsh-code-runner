#!/usr/bin/env node
/**
 * Independent static verification of the dsh-code-runner bundle.
 *
 * This file is owned by the verifier (not the implementers) and checks the
 * shipped artifacts against CONTRACT.md only. No dependencies, plain Node ESM.
 *
 *   node tests/verify-static.mjs
 *
 * Prints one [PASS]/[FAIL] line per assertion and exits 1 when anything fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ────────────────────────────── reporting ────────────────────────────────── */

const results = []
const pass = (id, detail = '') => {
  results.push({ status: 'PASS', id, detail })
  console.log(`[PASS] ${id}${detail ? ` — ${detail}` : ''}`)
}
const fail = (id, detail = '') => {
  results.push({ status: 'FAIL', id, detail })
  console.log(`[FAIL] ${id}${detail ? ` — ${detail}` : ''}`)
}
function check(id, fn) {
  try {
    const detail = fn()
    pass(id, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(id, error instanceof Error ? error.message : String(error))
  }
}
function assert(condition, message, extra) {
  if (!condition) throw new Error(`${message}${extra ? ` — ${extra}` : ''}`)
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`)
}
const truncate = (text, max = 220) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const readText = (rel) => {
  const file = path.join(ROOT, rel)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}
const readJson = (rel) => JSON.parse(readText(rel) ?? failMissing(rel))
function failMissing(rel) {
  throw new Error(`missing file ${rel}`)
}
function allMatches(text, regex) {
  const found = []
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    found.push({ index: match.index, text: match[0], groups: match.slice(1) })
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return found
}

/* ─────────────────────── source scanning toolkit ─────────────────────────── */
/*
 * `maskSource` returns a same-length copy of the source with comments and
 * string/template/regex-adjacent literals blanked out (newlines preserved).
 * Offsets therefore map 1:1 back onto the raw source, so structural scans can
 * run on the masked text while string values are read from the raw text.
 */
function maskSource(source) {
  const chars = source.split('')
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
    }
  }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (c === '/' && n === '/') {
      const start = i
      i += 2
      while (i < source.length && source[i] !== '\n') i += 1
      blank(start, i)
    } else if (c === '/' && n === '*') {
      const start = i
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i = Math.min(source.length, i + 2)
      blank(start, i)
    } else if (c === "'" || c === '"') {
      const quote = c
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      blank(start, i)
    } else if (c === '`') {
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '`') {
          i += 1
          break
        }
        i += 1
      }
      blank(start, i)
    } else {
      i += 1
    }
  }
  return chars.join('')
}

function findMatching(masked, openIndex, openChar, closeChar) {
  let depth = 0
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === openChar) depth += 1
    else if (masked[i] === closeChar) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function braceDepthAt(masked, position) {
  let depth = 0
  for (let i = 0; i < position; i += 1) {
    if (masked[i] === '{') depth += 1
    else if (masked[i] === '}') depth -= 1
  }
  return depth
}

/** Parse a JS string literal starting at `position`; returns { value, end }. */
function parseStringAt(raw, position) {
  const quote = raw[position]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let i = position + 1
  let value = ''
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\') {
      const next = raw[i + 1]
      if (next === 'n') value += '\n'
      else if (next === 't') value += '\t'
      else if (next === 'r') value += '\r'
      else if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        value += /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : ''
        i += 6
        continue
      } else value += next ?? ''
      i += 2
      continue
    }
    if (c === quote) return { value, end: i + 1 }
    value += c
    i += 1
  }
  return null
}

/** Locate `const|let|var <name> = { … }` and return the object-literal source. */
function extractConstObject(raw, masked, name) {
  const match = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).exec(masked)
  if (!match) return null
  const open = masked.indexOf('{', match.index)
  if (open < 0) return null
  const close = findMatching(masked, open, '{', '}')
  if (close < 0) return null
  return raw.slice(open, close + 1)
}

function flattenLocaleKeys(value, prefix = '', out = new Set()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flattenLocaleKeys(child, fullKey, out)
    } else {
      out.add(fullKey)
    }
  }
  return out
}

function flattenLocaleLeaves(value, prefix = '', out = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flattenLocaleLeaves(child, fullKey, out)
    } else {
      out.push({ key: fullKey, value: child })
    }
  }
  return out
}

/* ──────────────────────── 0. paths used everywhere ───────────────────────── */

const packagePath = path.join(ROOT, 'package.json')
const indexPath = path.join(ROOT, 'index.js')
const clientPath = path.join(ROOT, 'client.js')

console.log('dsh-code-runner — independent static verification')
console.log(`plugin root: ${ROOT}`)

/* ─────────────────────────── 1. package.json ─────────────────────────────── */

section('package.json (CONTRACT §0)')

let pkg = null
check('S01 package.json is valid JSON', () => {
  assert(existsSync(packagePath), 'package.json is missing')
  pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'package.json must hold a JSON object')
  return 'parsed'
})
if (!pkg) pkg = {}
const dsh = pkg.dsh ?? {}
const dshClient = dsh.client ?? {}

check('S02 package name is dsh-code-runner', () => {
  assert(pkg.name === 'dsh-code-runner', `name is ${JSON.stringify(pkg.name)}`)
  return pkg.name
})
check('S03 package type is module', () => {
  assert(pkg.type === 'module', `type is ${JSON.stringify(pkg.type)}`)
  return pkg.type
})

function exportTarget(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['import', 'module', 'default']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return null
}

check('S04 exports "." → ./index.js', () => {
  const target = exportTarget(pkg.exports?.['.'])
  assert(target === './index.js', `exports["."] resolves to ${JSON.stringify(target)}`)
  return target
})
check('S05 exports "./client" → ./client.js', () => {
  const target = exportTarget(pkg.exports?.['./client'])
  assert(target === './client.js', `exports["./client"] resolves to ${JSON.stringify(target)}`)
  return target
})
check('S06 exports "./locale/*.json" is exposed', () => {
  const target = exportTarget(pkg.exports?.['./locale/*.json'])
  assert(
    typeof target === 'string' && target.includes('locale') && target.includes('.json'),
    `exports["./locale/*.json"] is ${JSON.stringify(target)}`,
  )
  return target
})
check('S07 exports "./icon" → ./icon.svg', () => {
  const target = exportTarget(pkg.exports?.['./icon'])
  assert(
    typeof target === 'string' && target.endsWith('icon.svg'),
    `exports["./icon"] is ${JSON.stringify(target)}`,
  )
  return target
})
check('S08 files[] ships index.js, client.js, cordis.patch.yml, locale/*.json, icon.svg', () => {
  const files = Array.isArray(pkg.files) ? pkg.files : null
  assert(files, 'files is not an array')
  const required = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']
  const missing = required.filter((entry) => !files.includes(entry))
  assert(missing.length === 0, `files[] is missing ${missing.join(', ')}`, JSON.stringify(files))
  return required.join(', ')
})
check('S09 dsh.bundle.patch → ./cordis.patch.yml', () => {
  const patch = dsh.bundle?.patch
  assert(patch === './cordis.patch.yml', `dsh.bundle.patch is ${JSON.stringify(patch)}`)
  return patch
})
check('S10 dsh.client.platform is "web"', () => {
  assert(dshClient.platform === 'web', `dsh.client.platform is ${JSON.stringify(dshClient.platform)}`)
  return dshClient.platform
})
check('S11 dsh.client.immediately is true', () => {
  assert(dshClient.immediately === true, `dsh.client.immediately is ${JSON.stringify(dshClient.immediately)}`)
  return 'true'
})
check('S12 dsh.client.inject is a non-empty string array', () => {
  const inject = dshClient.inject
  assert(Array.isArray(inject) && inject.length > 0, `dsh.client.inject is ${JSON.stringify(inject)}`)
  assert(inject.every((entry) => typeof entry === 'string' && entry.length > 0), 'inject has non-string entries')
  return `${inject.length} entries`
})

/* ───────────────────────────── 2. locale files ───────────────────────────── */

section('locale metadata (CONTRACT §0 product metadata)')

const en = readJsonSafe('locale/en.json')
const zh = readJsonSafe('locale/zh.json')
function readJsonSafe(rel) {
  try {
    const raw = readText(rel)
    if (raw === null) return { __missing: true }
    return JSON.parse(raw)
  } catch (error) {
    return { __error: String(error.message ?? error) }
  }
}

check('S13 locale/en.json is valid JSON with non-empty meta.title + meta.description', () => {
  assert(!en.__missing, 'locale/en.json is missing')
  assert(!en.__error, `locale/en.json does not parse: ${en.__error}`)
  const title = en.meta?.title
  const description = en.meta?.description
  assert(typeof title === 'string' && title.trim().length > 0, 'meta.title is empty')
  assert(typeof description === 'string' && description.trim().length > 0, 'meta.description is empty')
  return `title=${JSON.stringify(title)}`
})
check('S14 locale/zh.json is valid JSON with non-empty meta.title + meta.description', () => {
  assert(!zh.__missing, 'locale/zh.json is missing')
  assert(!zh.__error, `locale/zh.json does not parse: ${zh.__error}`)
  const title = zh.meta?.title
  const description = zh.meta?.description
  assert(typeof title === 'string' && title.trim().length > 0, 'meta.title is empty')
  assert(typeof description === 'string' && description.trim().length > 0, 'meta.description is empty')
  return `title=${JSON.stringify(title)}`
})
check('S15 en/zh meta.title are actually translated (values differ)', () => {
  const enTitle = en.meta?.title
  const zhTitle = zh.meta?.title
  assert(typeof enTitle === 'string' && typeof zhTitle === 'string', 'one of the titles is missing')
  assert(enTitle.trim() !== zhTitle.trim(), `both titles are ${JSON.stringify(enTitle)}`)
  return `${JSON.stringify(enTitle)} ≠ ${JSON.stringify(zhTitle)}`
})

/* ─────────────────────────────── 3. icon.svg ─────────────────────────────── */

section('icon.svg')

check('S16 icon.svg is a small, well-formed-looking SVG', () => {
  const iconPath = path.join(ROOT, 'icon.svg')
  assert(existsSync(iconPath), 'icon.svg is missing')
  const size = statSync(iconPath).size
  assert(size < 256 * 1024, `icon.svg is ${size} bytes (limit 262144)`)
  const raw = readFileSync(iconPath, 'utf8')
  const trimmed = raw.replace(/^\uFEFF/, '').trimStart()
  assert(trimmed.startsWith('<svg'), `icon.svg starts with ${JSON.stringify(trimmed.slice(0, 40))}`)
  assert(/xmlns\s*=\s*["']/.test(raw), 'icon.svg has no xmlns attribute')
  assert(/viewBox\s*=\s*["']/.test(raw), 'icon.svg has no viewBox attribute')
  assert(raw.trimEnd().endsWith('</svg>'), 'icon.svg is not closed with </svg>')
  return `${size} bytes, viewBox+</svg> present`
})

/* ─────────────────────────── 4. cordis.patch.yml ─────────────────────────── */

section('cordis.patch.yml (CONTRACT §0 loader row)')

const patchRaw = readText('cordis.patch.yml')
check('S17 patch inserts a row with id dsh-code-runner and name dsh-code-runner', () => {
  assert(patchRaw !== null, 'cordis.patch.yml is missing')
  assert(/^\s*-\s*insert\s*:/m.test(patchRaw), 'no `- insert:` list found')
  assert(
    /^\s*-\s*id\s*:\s*['"]?dsh-code-runner['"]?\s*$/m.test(patchRaw),
    'no `- id: dsh-code-runner` entry found',
  )
  assert(
    /^\s*name\s*:\s*['"]?dsh-code-runner['"]?\s*$/m.test(patchRaw),
    'no `name: dsh-code-runner` field found',
  )
  return 'insert { id: dsh-code-runner, name: dsh-code-runner }'
})

/* ───────────────────────────── 5. index.js ───────────────────────────────── */

section('index.js — host half (CONTRACT §1, §3)')

const indexExists = existsSync(indexPath)
const indexRaw = indexExists ? readFileSync(indexPath, 'utf8') : null
const indexMasked = indexExists ? maskSource(indexRaw) : ''

check('S18 index.js exists', () => {
  assert(indexExists, 'index.js is missing')
  return `${statSync(indexPath).size} bytes`
})
check('S19 index.js passes node --check (ESM, no syntax errors)', () => {
  assert(indexExists, 'index.js is missing')
  const result = spawnSync(process.execPath, ['--check', indexPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert(
    result.status === 0,
    `node --check failed (status ${result.status})`,
    truncate(result.stderr || result.stdout),
  )
  return 'node --check index.js: ok'
})

let indexProbe = null
let indexProbeError = ''
check('S20 index.js exports name/inject/apply (dynamic import probe)', () => {
  assert(indexExists, 'index.js is missing')
  const probeScript = `
    const mod = await import(${JSON.stringify(pathToFileURL(indexPath).href)})
    const summary = {
      name: typeof mod.name === 'string' ? mod.name : null,
      inject: Array.isArray(mod.inject) ? mod.inject : null,
      applyType: typeof mod.apply,
      configExported: Object.prototype.hasOwnProperty.call(mod, 'Config'),
    }
    console.log('DCR_PROBE:' + JSON.stringify(summary))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert(result.status === 0, `import failed (status ${result.status})`, truncate(result.stderr || result.stdout))
  const line = (result.stdout || '')
    .split('\n')
    .filter((entry) => entry.startsWith('DCR_PROBE:'))
    .pop()
  assert(line, 'import probe produced no summary line', truncate(result.stdout))
  indexProbe = JSON.parse(line.slice('DCR_PROBE:'.length))
  indexProbeError = ''
  return `name=${JSON.stringify(indexProbe.name)} inject=${JSON.stringify(indexProbe.inject)} apply=${indexProbe.applyType}`
})
if (!indexProbe) {
  try {
    check('S20b index.js import diagnostic', () => {
      throw new Error(indexProbeError || 'index.js import probe did not produce a summary')
    })
  } catch {
    indexProbeError = 'index.js import probe failed'
  }
}

check('S21 index.js exported name is dsh-code-runner', () => {
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  assert(indexProbe.name === 'dsh-code-runner', `exported name is ${JSON.stringify(indexProbe.name)}`)
  return indexProbe.name
})
check('S22 index.js inject includes webServer and subprocess', () => {
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  const inject = indexProbe.inject
  assert(Array.isArray(inject), 'inject is not an array')
  assert(inject.includes('webServer'), 'inject does not include webServer')
  assert(inject.includes('subprocess'), 'inject does not include subprocess')
  return JSON.stringify(inject)
})
check('S23 index.js exports apply as a function', () => {
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  assert(indexProbe.applyType === 'function', `apply is ${indexProbe.applyType}`)
  return 'function apply(ctx)'
})
check('S24 index.js exports no Config (CONTRACT §1.1)', () => {
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  assert(indexProbe.configExported === false, 'index.js exports Config')
  return 'no Config export'
})
check('S25 index.js imports only node: builtins', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const specifiers = allMatches(indexRaw, /\bfrom\s*(['"])([^'"]+)\1/g).map((entry) => entry.groups[1])
  const nonNode = specifiers.filter((specifier) => !specifier.startsWith('node:'))
  assert(nonNode.length === 0, `non-builtin imports: ${nonNode.join(', ')}`)
  return specifiers.length ? specifiers.join(', ') : 'no imports'
})
check('S26 index.js creates a random 24-byte hex token (CONTRACT §1.2)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/randomBytes\s*\(\s*24\s*\)/.test(indexMasked), 'no crypto.randomBytes(24) call found')
  assert(/toString\s*\(\s*(['"])hex\1\s*\)/.test(indexRaw), 'token is not converted with toString("hex")')
  return 'randomBytes(24).toString(hex)'
})
check('S27 index.js injects window.__DSH_CODE_RUNNER__ via tapIndex', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/__DSH_CODE_RUNNER__/.test(indexRaw), 'token global name __DSH_CODE_RUNNER__ not found')
  assert(/\.tapIndex\s*\(/.test(indexMasked), 'no webServer.tapIndex( ) call found')
  return 'tapIndex + __DSH_CODE_RUNNER__'
})
check('S28 index.js uses the x-dsh-code-runner-token header', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/x-dsh-code-runner-token/i.test(indexRaw), 'token header name not found')
  return 'x-dsh-code-runner-token'
})
check('S29 index.js registers the /dsh-code-runner prefix route', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(indexRaw.includes('/dsh-code-runner'), 'route prefix "/dsh-code-runner" not found')
  assert(/kind\s*:\s*(['"])prefix\1/.test(indexRaw), `kind: 'prefix' not found`)
  assert(/\.register\s*\(\s*\{/.test(indexMasked), 'no webServer.register({ ... }) call found')
  return "register({ kind: 'prefix', path: '/dsh-code-runner' })"
})
check('S30 index.js implements the /api/token loopback bootstrap (CONTRACT §1.10)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/\/api\/token/.test(indexRaw), 'no /api/token route string found')
  assert(/remoteAddress/.test(indexRaw), 'no req.socket.remoteAddress check (loopback rule 1) found')
  assert(/::1/.test(indexRaw), 'no ::1 loopback literal found')
  assert(/localhost/i.test(indexRaw), 'no localhost Host-header handling found')
  assert(
    /127\b/.test(indexRaw) || /isLoopback/.test(indexRaw),
    'no 127/8 loopback handling found'
  )
  return 'remoteAddress + Host + sec-fetch-site + origin loopback rules'
})
check('S31 all webServer registrations sit inside ctx.effect (CONTRACT §1.1)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const effectSpans = allMatches(indexMasked, /ctx\.effect\s*\(/g).map((entry) => {
    const open = indexMasked.indexOf('(', entry.index)
    const close = findMatching(indexMasked, open, '(', ')')
    return [open, close]
  })
  assert(effectSpans.length >= 2, `only ${effectSpans.length} ctx.effect() call(s) found`)
  const registrationCalls = [
    ...allMatches(indexMasked, /\.tapIndex\s*\(/g),
    ...allMatches(indexMasked, /\.register\s*\(/g),
  ]
  assert(registrationCalls.length >= 2, `only ${registrationCalls.length} registration call(s) found`)
  const outside = registrationCalls.filter(
    (entry) => !effectSpans.some(([open, close]) => open >= 0 && close > entry.index && entry.index > open),
  )
  assert(
    outside.length === 0,
    `registration(s) outside ctx.effect at line(s) ${outside.map((entry) => lineOf(indexRaw, entry.index)).join(', ')}`,
  )
  return `${registrationCalls.length} registration calls inside ${effectSpans.length} ctx.effect() blocks`
})
check('S32 no top-level await / setInterval / listener side effects (CONTRACT §1.1)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const problems = []
  for (const entry of allMatches(indexMasked, /\bawait\b/g)) {
    if (braceDepthAt(indexMasked, entry.index) === 0) {
      problems.push(`top-level await at line ${lineOf(indexRaw, entry.index)}`)
    }
  }
  for (const entry of allMatches(indexMasked, /\bsetInterval\b/g)) {
    if (braceDepthAt(indexMasked, entry.index) === 0) {
      problems.push(`top-level setInterval at line ${lineOf(indexRaw, entry.index)}`)
    }
  }
  for (const entry of allMatches(indexMasked, /(?<![\w$.])listen\s*\(/g)) {
    problems.push(`listen( at line ${lineOf(indexRaw, entry.index)} (the webServer service owns the listener)`)
  }
  assert(problems.length === 0, problems.slice(0, 6).join('; '))
  return 'no module-level event-loop side effects'
})
check('S33 index.js writes the script file with mode 0o600 (CONTRACT §1.7)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/0o600/.test(indexMasked), 'no 0o600 file mode literal found')
  return 'mode: 0o600'
})
check('S34 index.js talks to subprocess only through ctx.subprocess', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/ctx\.subprocess/.test(indexMasked), 'no ctx.subprocess usage found')
  assert(
    /\.resolveExecutable\s*\(/.test(indexMasked) || /resolveExecutable/.test(indexRaw),
    'no subprocess.resolveExecutable usage found (language detection, CONTRACT §1.5)',
  )
  assert(/\.spawn\s*\(/.test(indexMasked), 'no subprocess.spawn( ) usage found')
  return 'resolveExecutable + spawn'
})

/* ───────────────────────────── 6. client.js ──────────────────────────────── */

section('client.js — browser half (CONTRACT §2, §3)')

const clientExists = existsSync(clientPath)
const clientRaw = clientExists ? readFileSync(clientPath, 'utf8') : null
const clientMasked = clientExists ? maskSource(clientRaw) : ''

check('S35 client.js exists', () => {
  assert(clientExists, 'client.js is missing')
  return `${statSync(clientPath).size} bytes`
})
check('S36 client.js passes node --check (plain JS, no JSX/TS syntax)', () => {
  assert(clientExists, 'client.js is missing')
  const result = spawnSync(process.execPath, ['--check', clientPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert(
    result.status === 0,
    `node --check failed (status ${result.status})`,
    truncate(result.stderr || result.stdout),
  )
  return 'node --check client.js: ok'
})

function stripLeadingComments(source) {
  let rest = source.replace(/^\uFEFF/, '')
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '')
    if (trimmed.startsWith('//')) {
      const newline = trimmed.indexOf('\n')
      rest = newline < 0 ? '' : trimmed.slice(newline + 1)
      continue
    }
    if (trimmed.startsWith('/*')) {
      const close = trimmed.indexOf('*/')
      rest = close < 0 ? '' : trimmed.slice(close + 2)
      continue
    }
    return trimmed
  }
}

check('S37 client.js starts with window.__ModuleLoader__.load({ id: … })', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const head = stripLeadingComments(clientRaw)
  assert(
    head.startsWith('window.__ModuleLoader__.load('),
    `first statement is ${JSON.stringify(truncate(head, 80))}`,
  )
  const loadIndex = clientMasked.indexOf('__ModuleLoader__')
  const window = clientRaw.slice(loadIndex, loadIndex + 320)
  const idMatch = /id\s*:\s*(['"])([^'"]+)\1/.exec(window)
  assert(idMatch, 'no literal `id` field found in the __ModuleLoader__.load( ) object')
  assert(idMatch[2] === 'dsh-code-runner', `loader id is ${JSON.stringify(idMatch[2])}`)
  const loadCalls = allMatches(clientMasked, /__ModuleLoader__\s*\.\s*load\s*\(/g).length
  assert(loadCalls === 1, `${loadCalls} __ModuleLoader__.load() calls found`)
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(idMatch[2])}, factory(require) … })`
})
check('S38 client.js only requires react', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const calls = []
  for (const entry of allMatches(clientMasked, /(?<![\w$.])require\s*\(/g)) {
    const open = clientMasked.indexOf('(', entry.index)
    let position = open + 1
    while (position < clientRaw.length && /\s/.test(clientRaw[position])) position += 1
    const literal = parseStringAt(clientRaw, position)
    calls.push(literal ? literal.value : `<non-literal at line ${lineOf(clientRaw, position)}>`)
  }
  assert(calls.length > 0, 'no require() calls found — React must come from require("react")')
  const unexpected = calls.filter((specifier) => specifier !== 'react')
  assert(unexpected.length === 0, `unexpected require() specifier(s): ${unexpected.join(', ')}`)
  const harnessRequires = calls.filter((specifier) => specifier.startsWith('@deepseek-ai/'))
  assert(harnessRequires.length === 0, `Harness client package require(s): ${harnessRequires.join(', ')}`)
  return `require('react') × ${calls.length}`
})
check('S39 client.js has no import/export statements and no dynamic import', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const problems = []
  // Property keys named import/export are fine; only statement forms are defects.
  for (const entry of allMatches(clientMasked, /\bimport\s*(?:\(|[\w*{'"])/g)) {
    const previous = clientMasked[entry.index - 1]
    if (previous === '.' || previous === ':') continue
    problems.push(`import statement at line ${lineOf(clientRaw, entry.index)}`)
  }
  for (const entry of allMatches(clientMasked, /\bexport\s+(?:default|const|let|var|function|class|async|\{)/g)) {
    const previous = clientMasked[entry.index - 1]
    if (previous === '.' || previous === ':') continue
    problems.push(`export statement at line ${lineOf(clientRaw, entry.index)}`)
  }
  assert(problems.length === 0, problems.slice(0, 6).join('; '))
  return 'no import/export/dynamic import'
})
check('S40 client.js never touches document.body (CONTRACT §3)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const match = /document\s*\.\s*body/.exec(clientRaw)
  assert(!match, `document.body mutation at line ${lineOf(clientRaw, match?.index ?? 0)}`)
  return 'no document.body access'
})
check('S41 client.js has no literal palette colours in CSS/strings (CONTRACT §2.3)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const literals = collectStringLiterals(clientRaw)
  const findings = []
  for (const literal of literals) {
    const reported = (pattern, kind) => {
      const matches = allMatches(literal.content, pattern)
      for (const entry of matches.slice(0, 2)) {
        findings.push(`${kind} ${JSON.stringify(truncate(entry.text, 24))} at line ${literal.line}`)
      }
    }
    reported(/#[0-9a-fA-F]{3,8}\b/g, 'hex colour')
    reported(/\brgba?\s*\(/gi, 'rgb()')
    reported(/\bhsla?\s*\(/gi, 'hsl()')
  }
  assert(findings.length === 0, findings.slice(0, 6).join('; '))
  return `${literals.length} string literals scanned — only theme variables`
})
function collectStringLiterals(source) {
  const literals = []
  let line = 1
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '\n') {
      line += 1
      i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1
        i += 1
      }
      i = Math.min(source.length, i + 2)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      const startLine = line
      i += 1
      let content = ''
      while (i < source.length) {
        const inner = source[i]
        if (inner === '\\') {
          content += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (inner === quote) {
          i += 1
          break
        }
        if (inner === '\n') line += 1
        content += inner
        i += 1
      }
      literals.push({ content, line: startLine })
      continue
    }
    i += 1
  }
  return literals
}
check('S42 client.js uses --dsw-alias-* theme tokens for styling', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const tokens = new Set(allMatches(clientRaw, /--dsw-alias-[a-z0-9-]+/g).map((entry) => entry.text))
  assert(tokens.size >= 5, `only ${tokens.size} distinct --dsw-alias-* token(s) found`)
  return `${tokens.size} distinct theme tokens`
})

function buildConstMap(raw, masked) {
  const consts = new Map()
  if (!raw) return consts
  for (const entry of allMatches(masked, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = entry.groups[0]
    let position = entry.index + entry.text.length
    while (position < raw.length && /\s/.test(raw[position])) position += 1
    const literal = parseStringAt(raw, position)
    if (literal) {
      if (!consts.has(name)) consts.set(name, literal.value)
      continue
    }
    const numberMatch = /^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/.exec(raw.slice(position, position + 24))
    if (numberMatch) {
      const token = numberMatch[0]
      const numeric = /^0[xX]/.test(token) ? parseInt(token, 16) : Number(token)
      if (!consts.has(name)) consts.set(name, numeric)
    }
  }
  return consts
}
/** Resolve a literal / simple const identifier used as a call argument or property value. */
function resolveExpression(expression, consts) {
  const token = String(expression ?? '').trim()
  if (!token) return undefined
  const literal = parseStringAt(token, 0)
  if (literal && literal.end === token.length) return literal.value
  if (/^-?\d+$/.test(token)) return Number(token)
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return consts.get(token)
  return undefined
}
/** Read the first argument expression of the call starting at `occurrenceIndex` (masked offsets). */
function readFirstCallArgument(raw, masked, occurrenceIndex) {
  const open = masked.indexOf('(', occurrenceIndex)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) return undefined
    } else if (c === ',' && depth === 1) {
      return raw.slice(open + 1, i).trim()
    }
  }
  return undefined
}
function readPropertyExpression(span, property) {
  const match = new RegExp(`\\b${property}\\s*:\\s*([^,\\n}]+)`).exec(span)
  return match ? match[1].trim() : undefined
}
function readPropertyValue(span, property, consts) {
  return resolveExpression(readPropertyExpression(span, property), consts)
}

const clientConsts = buildConstMap(clientRaw, clientMasked)
const injectTargets = clientRaw
  ? allMatches(clientMasked, /slots\.inject\s*\(/g)
      .map((entry) => resolveExpression(readFirstCallArgument(clientRaw, clientMasked, entry.index), clientConsts))
      .filter((value) => typeof value === 'string')
  : []
const localeNamespaces = clientRaw
  ? allMatches(clientMasked, /locale\.register\s*\(/g)
      .map((entry) => resolveExpression(readFirstCallArgument(clientRaw, clientMasked, entry.index), clientConsts))
      .filter((value) => typeof value === 'string')
  : []
const slotRegisterSpans = (() => {
  if (clientMasked === '') return []
  const spans = []
  for (const entry of allMatches(clientMasked, /slots\.register\s*\(/g)) {
    const open = clientMasked.indexOf('(', entry.index)
    const close = findMatching(clientMasked, open, '(', ')')
    if (close > open) spans.push(clientRaw.slice(open, close + 1))
  }
  return spans
})()

check('S43 client.js registers locale namespace dsh-code-runner', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(
    localeNamespaces.includes('dsh-code-runner'),
    `locale.register namespaces: ${JSON.stringify(localeNamespaces)}`,
  )
  return 'locale.register("dsh-code-runner", …)'
})
check('S44 client.js injects children into sidebar.panellist and main', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(injectTargets.includes('sidebar.panellist'), `slots.inject targets: ${JSON.stringify(injectTargets)}`)
  assert(injectTargets.includes('main'), `slots.inject targets: ${JSON.stringify(injectTargets)}`)
  return JSON.stringify(injectTargets)
})
check('S45 sidebar row registered: name sidebar.panellist, id code-runner, order 30', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(slotRegisterSpans.length >= 2, `only ${slotRegisterSpans.length} ctx.slots.register( ) call(s) found`)
  const sidebar = slotRegisterSpans.find((span) => readPropertyValue(span, 'name', clientConsts) === 'sidebar.panellist')
  assert(sidebar, 'no slots.register({ name: "sidebar.panellist", … }) call found')
  assert(readPropertyValue(sidebar, 'id', clientConsts) === 'code-runner', 'sidebar row has no id "code-runner"')
  assert(readPropertyValue(sidebar, 'order', clientConsts) === 30, 'sidebar row has no order 30 (CONTRACT §0)')
  assert(/SidebarIcon/.test(sidebar), 'sidebar register does not pass a SidebarIcon component')
  return 'name=sidebar.panellist id=code-runner order=30, SidebarIcon component'
})
check('S46 main panel registered: name main, key code-runner', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const main = slotRegisterSpans.find((span) => readPropertyValue(span, 'name', clientConsts) === 'main')
  assert(main, 'no slots.register({ name: "main", … }) call found')
  assert(readPropertyValue(main, 'key', clientConsts) === 'code-runner', 'main panel has no key "code-runner"')
  assert(/,\s*[A-Z][A-Za-z0-9_]*\s*\)\s*$/.test(main), 'main register does not pass a component identifier')
  return 'name=main key=code-runner, Panel component'
})
check('S47 slot entries carry locale namespace dsh-code-runner', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const count = slotRegisterSpans.filter(
    (span) => readPropertyValue(span, 'locale', clientConsts) === 'dsh-code-runner',
  ).length
  assert(count >= 1, 'no slot entry declares locale "dsh-code-runner"')
  return `${count} slot entr${count === 1 ? 'y' : 'ies'} with locale namespace`
})

/** Find the dictionary identifiers handed to ctx.locale.register and evaluate them. */
function extractLocaleDictionaries(raw, masked) {
  const names = { zh: null, en: null }
  for (const entry of allMatches(masked, /locale\.register\s*\(/g)) {
    const open = masked.indexOf('(', entry.index)
    const close = findMatching(masked, open, '(', ')')
    if (close < 0) continue
    const span = raw.slice(open, close + 1)
    for (const language of ['zh', 'en']) {
      if (names[language]) continue
      const named = new RegExp(`\\b${language}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(span)
      if (named) names[language] = named[1]
      else if (new RegExp(`[{,]\\s*${language}\\s*[,}]`).test(span)) names[language] = language
    }
  }
  if (!names.zh || !names.en) {
    const objectConsts = allMatches(masked, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g).map(
      (entry) => entry.groups[0],
    )
    for (const language of ['zh', 'en']) {
      if (names[language]) continue
      const fallback = objectConsts.find((name) => name.toLowerCase().includes(language))
      if (fallback) names[language] = fallback
    }
  }
  const dictionaries = { zh: null, en: null, names }
  for (const language of ['zh', 'en']) {
    if (!names[language]) continue
    const literal = extractConstObject(raw, masked, names[language])
    if (!literal) continue
    try {
      dictionaries[language] = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1_000 })
    } catch {
      dictionaries[language] = null
    }
  }
  return dictionaries
}

const clientDictionaries = clientRaw ? extractLocaleDictionaries(clientRaw, clientMasked) : { zh: null, en: null }
let clientZh = clientDictionaries.zh
let clientEn = clientDictionaries.en
check('S48 client.js defines parseable locale dictionaries handed to ctx.locale.register', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(clientMasked !== '', 'client.js is empty')
  assert(
    clientDictionaries.names.zh,
    'no zh dictionary identifier found (expected ctx.locale.register(ns, { zh, en }))',
  )
  assert(
    clientDictionaries.names.en,
    'no en dictionary identifier found (expected ctx.locale.register(ns, { zh, en }))',
  )
  assert(clientZh, `zh dictionary ${JSON.stringify(clientDictionaries.names.zh)} did not evaluate`)
  assert(clientEn, `en dictionary ${JSON.stringify(clientDictionaries.names.en)} did not evaluate`)
  return `zh=${clientDictionaries.names.zh}, en=${clientDictionaries.names.en} evaluated`
})
if (!clientZh) clientZh = {}
if (!clientEn) clientEn = {}
const zhKeys = flattenLocaleKeys(clientZh)
const enKeys = flattenLocaleKeys(clientEn)
const zhLeaves = flattenLocaleLeaves(clientZh)
const enLeaves = flattenLocaleLeaves(clientEn)
const contractLocaleKeys = [
  'panel.label', 'panel.title', 'panel.subtitle',
  'status.ready', 'status.offline',
  'toolbar.language', 'toolbar.cwd', 'toolbar.pick', 'toolbar.rescan', 'toolbar.run',
  'toolbar.stop', 'toolbar.clear', 'toolbar.copy', 'toolbar.running',
  'hint.shortcut',
  'editor.placeholder',
  'output.title', 'output.idle', 'output.running', 'output.empty', 'output.truncated',
  'status.exit', 'status.signal', 'status.timeout', 'status.stopped', 'status.duration',
  'env.scanning', 'env.none',
  'error.noToken', 'error.host', 'error.unauthorized', 'error.forbidden', 'error.setup',
  'error.unknownRun', 'error.languageUnavailable', 'error.badCwd', 'error.emptyCode',
  'error.crashed', 'error.crashedHint', 'error.copyFailed',
  // CONTRACT-V2 §2.6 additions (identical key sets in zh + en)
  'panel.rightbarOpen', 'panel.rightbarClose',
  'toolbar.save', 'toolbar.saveAs', 'toolbar.file', 'toolbar.untitled', 'toolbar.dirty',
  'toolbar.runFile', 'toolbar.runBuffer', 'toolbar.newFile',
  'tabs.console', 'tabs.plots', 'tabs.files',
  'files.title', 'files.refresh', 'files.up', 'files.empty', 'files.loading', 'files.root',
  'files.openFailed', 'files.binary', 'files.tooLarge', 'files.dir',
  'plots.title', 'plots.refresh', 'plots.empty', 'plots.loading', 'plots.count',
  'plots.sourceRun', 'plots.sourceCwd', 'plots.close', 'plots.prev', 'plots.next',
  'plots.copyPath', 'plots.copied', 'plots.unsupported',
  'editor.saving', 'editor.saved', 'editor.dirty', 'editor.unsavedTitle', 'editor.unsavedBody',
  'editor.discard', 'editor.cancel', 'editor.conflictTitle', 'editor.conflictBody',
  'editor.overwrite', 'editor.saveFailed', 'editor.savedAndRan', 'editor.openFileTitle',
  'editor.saveAsTitle', 'editor.saveAsPlaceholder', 'editor.saveAsConfirm',
  'status.modeFile', 'status.modeBuffer', 'status.line', 'status.col',
  'error.badPath', 'error.fileNotFound', 'error.conflict', 'error.fileTooLarge',
  'error.unsupportedFile', 'error.saveFailed',
  // CONTRACT-V3 §2.6 additions (identical key sets in zh + en)
  'selection.run', 'selection.hint', 'selection.marker',
  'explain.open', 'explain.title', 'explain.loading', 'explain.summary', 'explain.insert',
  'explain.inserted', 'explain.undoInsert', 'explain.copy', 'explain.copied', 'explain.close',
  'explain.retry', 'explain.llmUnavailable', 'explain.failed', 'explain.truncated',
  'export.button', 'export.running', 'export.done', 'export.folder', 'export.copyPath',
  'export.copied', 'export.failed', 'export.empty',
  'plots.save', 'plots.saveAll', 'plots.saved', 'plots.saveFailed', 'plots.target', 'plots.size',
  'language.python', 'language.r', 'language.matlab', 'language.node', 'language.bash',
  'language.zsh', 'language.ruby', 'language.perl', 'language.julia', 'language.deno',
  'language.bun', 'language.php',
  'language.hint.python', 'language.hint.r', 'language.hint.matlab', 'language.hint.node',
  'language.hint.shell', 'language.hint.generic',
  'language.startingMatlab', 'language.consoleMatlab', 'language.consoleDefault',
]

check('S49 zh and en dictionaries have the exact same key set', () => {
  assert(clientZh, 'zh dictionary unavailable')
  assert(clientEn, 'en dictionary unavailable')
  assert(zhKeys.size > 0 && enKeys.size > 0, `dictionary sizes zh=${zhKeys.size} en=${enKeys.size}`)
  const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key))
  const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key))
  assert(
    onlyZh.length === 0 && onlyEn.length === 0,
    `asymmetric keys: zh-only=[${onlyZh.join(', ')}] en-only=[${onlyEn.join(', ')}]`,
  )
  return `${zhKeys.size} keys in both dictionaries`
})
check('S50 both dictionaries cover every CONTRACT §2.4 locale key', () => {
  assert(clientZh, 'zh dictionary unavailable')
  const missingZh = contractLocaleKeys.filter((key) => !zhKeys.has(key))
  const missingEn = contractLocaleKeys.filter((key) => !enKeys.has(key))
  assert(
    missingZh.length === 0 && missingEn.length === 0,
    `missing keys — zh: [${missingZh.join(', ')}] en: [${missingEn.join(', ')}]`,
  )
  return `${contractLocaleKeys.length} contract keys present in zh + en`
})
check('S51 every dictionary leaf is a non-empty string', () => {
  assert(clientZh, 'zh dictionary unavailable')
  const bad = [...zhLeaves, ...enLeaves].filter(
    (leaf) => typeof leaf.value !== 'string' || leaf.value.trim() === '',
  )
  assert(bad.length === 0, `empty/non-string leaves: ${bad.slice(0, 8).map((leaf) => leaf.key).join(', ')}`)
  return `${zhLeaves.length + enLeaves.length} localized strings`
})
check('S52 every t("…") / translate("…") key exists in both dictionaries', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(clientZh, 'zh dictionary unavailable')
  const keys = []
  const dynamic = []
  // `translate` is the local alias of the t() helper inside panel components.
  for (const entry of allMatches(clientMasked, /\b(?:t|translate|tr)\s*\(/g)) {
    const open = clientMasked.indexOf('(', entry.index)
    let position = open + 1
    while (position < clientRaw.length && /\s/.test(clientRaw[position])) position += 1
    const literal = parseStringAt(clientRaw, position)
    const isTemplate = clientRaw[position] === '`'
    if (!literal || isTemplate) {
      dynamic.push(lineOf(clientRaw, position))
      continue
    }
    keys.push({ key: literal.value, line: lineOf(clientRaw, position) })
  }
  assert(keys.length > 0, 'no t()/translate("literal") calls found')
  const unknown = keys.filter((entry) => !zhKeys.has(entry.key) || !enKeys.has(entry.key))
  assert(
    unknown.length === 0,
    `unknown translation key(s): ${unknown.slice(0, 8).map((entry) => `${entry.key} (line ${entry.line})`).join(', ')}`,
  )
  return `${keys.length} translation keys resolved${dynamic.length ? `; ${dynamic.length} dynamic call(s) ignored` : ''}`
})
check('S53 client.js resolves the token via bootstrap fallback and persists drafts/cwd', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/api\/token/.test(clientRaw), 'no dsh-code-runner/api/token bootstrap fallback found (CONTRACT §2.2)')
  assert(clientRaw.includes('dsh-code-runner.cwd'), 'localStorage cwd key "dsh-code-runner.cwd" not found')
  assert(clientRaw.includes('dsh-code-runner.draft.'), 'localStorage draft key prefix "dsh-code-runner.draft." not found')
  return 'api/token + dsh-code-runner.cwd + dsh-code-runner.draft.'
})
check('S54 client.js API URLs are document-relative (no leading slash)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const literals = collectStringLiterals(clientRaw)
  const absolute = literals.filter((literal) => literal.content.includes('/dsh-code-runner/api'))
  assert(
    absolute.length === 0,
    `absolute API path literal at line(s) ${absolute.map((literal) => literal.line).join(', ')} (CONTRACT §2.2)`,
  )
  assert(
    literals.some((literal) => literal.content.startsWith('dsh-code-runner/api/')),
    'no relative dsh-code-runner/api/ URL literal found',
  )
  return 'relative dsh-code-runner/api/* URLs'
})
check('S55 client.js wraps the panel in a React error boundary', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(
    /componentDidCatch|getDerivedStateFromError/.test(clientMasked) || /componentDidCatch/.test(clientRaw),
    'no class error boundary hook found (CONTRACT §2.1)',
  )
  return 'error boundary present'
})
check('S56 client.js uses the uiWorkspace picker hook when available', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/uiWorkspace/.test(clientRaw), "no ctx.get('uiWorkspace') picker hook found (CONTRACT §2.2)")
  return 'uiWorkspace optional service'
})
check('S57 client.js UI affordances (role=log, aria-label, focus-visible, tab-size, shortcut, Tab, buttons)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const requirements = [
    [/role\s*[:=]\s*(['"])log\1/, 'role="log" output'],
    [/aria-label/, 'aria-label'],
    [/focus-visible/, ':focus-visible'],
    [/tab-size\s*:/, 'tab-size'],
    [/ctrlKey/, 'Ctrl+Enter modifier (ctrlKey)'],
    [/metaKey/, '⌘+Enter modifier (metaKey)'],
    [/(['"])Tab\1/, "Tab key handler ('Tab')"],
    [/type\s*[:=]\s*(['"])button\1/, 'button type="button"'],
    [/dcr-/, 'dcr- class prefix'],
  ]
  const missing = requirements.filter(([pattern]) => !pattern.test(clientRaw)).map(([, label]) => label)
  assert(missing.length === 0, `missing: ${missing.join(', ')}`)
  return `${requirements.length} UI affordances checked`
})


check('S58 sidebar icon is a 16×16-viewBox currentColor terminal glyph', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const entry = allMatches(clientMasked, /function\s+SidebarIcon\s*\(/g)[0] ??
    allMatches(clientMasked, /(?:const|let|var)\s+SidebarIcon\s*=\s*(?:function)?\s*\(/g)[0]
  assert(entry, 'no SidebarIcon component found (CONTRACT §2.1)')
  let open = clientMasked.indexOf('(', entry.index)
  const paramsEnd = findMatching(clientMasked, open, '(', ')')
  assert(paramsEnd > open, 'could not parse SidebarIcon parameters')
  const bodyOpen = clientMasked.indexOf('{', paramsEnd)
  const bodyEnd = findMatching(clientMasked, bodyOpen, '{', '}')
  assert(bodyEnd > bodyOpen, 'could not parse SidebarIcon body')
  const body = clientRaw.slice(bodyOpen, bodyEnd + 1)
  assert(/viewBox\s*:\s*(['"])0 0 16 16\1/.test(body), 'SidebarIcon viewBox is not "0 0 16 16"')
  assert(/stroke\s*:\s*(['"])currentColor\1/.test(body), 'SidebarIcon does not use stroke="currentColor"')
  assert(/\.size\b/.test(body) && /\.active\b/.test(body), 'SidebarIcon does not read the size/active owner props')
  const paths = allMatches(body, /(['"])path\1/g).length
  assert(paths >= 2, `SidebarIcon has ${paths} path element(s); expected the >_ glyph (2 paths)`)
  return `viewBox 0 0 16 16, currentColor, size/active props, ${paths} paths`
})


/* ═════════════════════ CONTRACT-V2 additions (v2 verification) ══════════════ */

function readCallArgs(raw, masked, occurrenceIndex) {
  const open = masked.indexOf('(', occurrenceIndex)
  if (open < 0) return null
  const close = findMatching(masked, open, '(', ')')
  if (close < 0) return null
  return raw.slice(open, close + 1)
}

section('index.js — v2 host half (CONTRACT-V2 §1)')

check('S59 index.js keeps the v1 exports and adds no Config (v2 §1)', () => {
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  assert(indexProbe.name === 'dsh-code-runner', `exported name is ${JSON.stringify(indexProbe.name)}`)
  const inject = Array.isArray(indexProbe.inject) ? indexProbe.inject : []
  assert(inject.includes('webServer') && inject.includes('subprocess'), `inject is ${JSON.stringify(inject)}`)
  assert(indexProbe.applyType === 'function', 'apply is not a function')
  assert(indexProbe.configExported === false, 'index.js exports Config')
  return `name/inject/apply unchanged, no Config`
})

check('S60 index.js declares every v2 route path (CONTRACT-V2 §1.1)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const routes = [
    [/\/api\/env\b/, '/api/env'], [/\/api\/run\b/, '/api/run'], [/\/api\/output\b/, '/api/output'],
    [/\/api\/stop\b/, '/api/stop'], [/\/api\/token\b/, '/api/token'], [/\/api\/files\b/, '/api/files'],
    [/\/api\/file\b/, '/api/file'], [/\/api\/blob\b/, '/api/blob'], [/\/api\/artifacts\b/, '/api/artifacts'],
    [/\/api\/diag\b/, '/api/diag'],
  ]
  const missing = routes.filter(([regex]) => !regex.test(indexRaw)).map(([, label]) => label)
  assert(missing.length === 0, `missing route path(s): ${missing.join(', ')}`)
  return routes.map(([, label]) => label).join(', ')
})

check('S61 index.js wires python + R plot capture (behavioural markers, D1)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  // The sitecustomize BYTES are intentionally not asserted (approved deviation D1);
  // the observable contract is that a matplotlib figure is saved to the plots dir.
  const py = ['sitecustomize.py', 'DSH_CODE_RUNNER_PLOTS_DIR', 'savefig', 'get_fignums', 'atexit']
  const missingPy = py.filter((markerText) => !indexRaw.includes(markerText))
  assert(missingPy.length === 0, `missing python capture marker(s): ${missingPy.join(', ')}`)
  const r = ['plot-wrapper.R', 'DSH_CODE_RUNNER_SCRIPT', 'DSH_CODE_RUNNER_PLOTS_DIR', 'grDevices::png', 'dev.off', 'source(']
  const missingR = r.filter((markerText) => !indexRaw.includes(markerText))
  assert(missingR.length === 0, `missing R capture marker(s): ${missingR.join(', ')}`)
  assert(/PYTHONPATH/.test(indexRaw), 'no PYTHONPATH wiring for python plot capture')
  return 'sitecustomize + savefig/atexit wiring, plot-wrapper.R + grDevices::png wiring'
})

check('S62 index.js declares the v2 limits and new error codes (v2 §1.1, §1.2)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const limitKeys = ['fileMaxBytes', 'blobMaxBytes', 'artifactMax']
  const missingLimits = limitKeys.filter((key) => !indexRaw.includes(key))
  assert(missingLimits.length === 0, `missing limit key(s): ${missingLimits.join(', ')}`)
  const codes = ['bad-path', 'not-found', 'conflict', 'too-large', 'unsupported-file']
  const missingCodes = codes.filter((code) => !new RegExp(`(['"\`])${code}\\1`).test(indexRaw))
  assert(missingCodes.length === 0, `missing error code(s): ${missingCodes.join(', ')}`)
  return `${limitKeys.join(', ')}; ${codes.join(', ')}`
})

check('S63 index.js implements file mode + capturePlots fields (v2 §1.3, §1.4, §1.5)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const fields = ['capturePlots', 'plotDir', 'baseMtimeMs', 'mtimeMs']
  const missing = fields.filter((field) => !indexRaw.includes(field))
  assert(missing.length === 0, `missing field(s): ${missing.join(', ')}`)
  assert(/['"]file['"]/.test(indexRaw) && /['"]buffer['"]/.test(indexRaw), 'no buffer/file mode literals found')
  const extMarkers = ['pyw', 'cjs', 'jl', 'mjs']
  const missingExt = extMarkers.filter((ext) => !indexRaw.includes(ext))
  assert(missingExt.length === 0, `missing extension-map marker(s): ${missingExt.join(', ')}`)
  return 'mode/capturePlots/plotDir/baseMtimeMs + pyw/cjs/jl/mjs extension map'
})

check('S64 index.js blob route declares the image/pdf allowlist content types (v2 §1.9)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const contentTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif', 'application/pdf']
  const missing = contentTypes.filter((contentType) => !indexRaw.includes(contentType))
  assert(missing.length === 0, `missing blob content type(s): ${missing.join(', ')}`)
  assert(/content-length/i.test(indexRaw), 'blob route does not set content-length')
  assert(/no-store/i.test(indexRaw), 'blob route does not set cache-control: no-store')
  return `${contentTypes.length} content types + content-length + no-store`
})

check('S65 index.js gates every route with authorize() and keeps the /api/token bootstrap exception', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(/authorize\s*\(/.test(indexMasked), 'no authorize( ) gate found')
  assert(/authorizeTokenBootstrap|bootstrap\s*:/.test(indexRaw), 'no token-bootstrap special-case in dispatch')
  const routes = ['/api/files', '/api/file', '/api/blob', '/api/artifacts']
  for (const routePath of routes) {
    const index = indexRaw.indexOf(routePath)
    assert(index >= 0, `route ${routePath} is missing`)
  }
  return 'authorize gate + bootstrap exception for the v2 route table'
})

section('client.js — v2 right sidebar, files & plots (CONTRACT-V2 §2)')

const v2InjectTargets = clientRaw
  ? allMatches(clientMasked, /slots\.inject\s*\(/g)
      .map((entry) => resolveExpression(readFirstCallArgument(clientRaw, clientMasked, entry.index), clientConsts))
      .filter((value) => typeof value === 'string')
  : []

check('S66 client.js registers the right-sidebar tab type (id/kind/guide/keepMounted)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  // scoped service injection instead of a hard module inject
  const injectArrays = allMatches(clientMasked, /\.inject\s*\(\s*\[/g)
  assert(injectArrays.length > 0, 'no ctx.inject([ ... ], ...) scoped injection found (v2 §2.1)')
  const injectArgs = injectArrays
    .map((entry) => readCallArgs(clientRaw, clientMasked, entry.index) ?? '')
    .find((args) => /sidebarRightTabs/.test(args))
  assert(injectArgs, "no ctx.inject([... 'sidebarRightTabs' ...]) found")
  assert(/sidebarRight\b/.test(injectArgs), "ctx.inject([...]) does not request 'sidebarRight'")
  assert(/\.register\s*\(/.test(injectArgs), 'no register( ) call inside the scoped inject callback')
  // the registration object may live in a definition factory (`tabs.register(def())`)
  const keep = allMatches(clientMasked, /keepMounted\s*:\s*true/g)[0]
  assert(keep, 'no keepMounted: true in the right-tab registration')
  let definitionBody = null
  for (const match of allMatches(clientMasked, /function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g)) {
    const open = clientMasked.indexOf('{', match.index)
    const close = findMatching(clientMasked, open, '{', '}')
    if (close > keep.index) {
      definitionBody = clientRaw.slice(open, close + 1)
      break
    }
  }
  assert(definitionBody, 'could not locate the right-tab definition object')
  const id = readPropertyValue(definitionBody, 'id', clientConsts)
  const kind = readPropertyValue(definitionBody, 'kind', clientConsts)
  assert(id === 'dsh-code-runner', `right-tab id is ${JSON.stringify(id)} (expected "dsh-code-runner")`)
  assert(kind === 'code-runner', `right-tab kind is ${JSON.stringify(kind)} (expected "code-runner")`)
  const guide = /guide\s*:\s*\[([\s\S]*?)\]\s*,/.exec(definitionBody)
  assert(guide, 'right-tab registration lacks a guide array (v2 §2.1)')
  const guideId = /\bid\s*:\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/.exec(guide[1])
  assert(guideId, 'guide entry has no id')
  assert(
    resolveExpression(guideId[1], clientConsts) === 'dsh-code-runner',
    `guide entry id resolves to ${JSON.stringify(resolveExpression(guideId[1], clientConsts))}`,
  )
  return `id=${id} kind=${kind} keepMounted:true guide[{id:"dsh-code-runner"}]`
})

check('S67 sidebar.right.pane.tab body registered with key dsh-code-runner', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(
    v2InjectTargets.includes('sidebar.right.pane.tab'),
    `slots.inject targets: ${JSON.stringify(v2InjectTargets)}`,
  )
  const span = slotRegisterSpans.find(
    (entry) => readPropertyValue(entry, 'name', clientConsts) === 'sidebar.right.pane.tab',
  )
  assert(span, 'no slots.register({ name: "sidebar.right.pane.tab", … }) call found')
  assert(
    readPropertyValue(span, 'key', clientConsts) === 'dsh-code-runner',
    'sidebar.right.pane.tab registration key is not "dsh-code-runner"',
  )
  return 'slots.inject("sidebar.right.pane.tab") + register key "dsh-code-runner"'
})

check('S68 conversation-header toggle registered (id code-runner-toggle, order 5, locale NS)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(
    v2InjectTargets.includes('conversation.session.header.utilities'),
    `slots.inject targets: ${JSON.stringify(v2InjectTargets)}`,
  )
  const span = slotRegisterSpans.find(
    (entry) => readPropertyValue(entry, 'name', clientConsts) === 'conversation.session.header.utilities',
  )
  assert(span, 'no slots.register({ name: "conversation.session.header.utilities", … }) call found')
  assert(
    readPropertyValue(span, 'id', clientConsts) === 'code-runner-toggle',
    'header toggle id is not "code-runner-toggle"',
  )
  assert(readPropertyValue(span, 'order', clientConsts) === 5, 'header toggle order is not 5')
  assert(
    readPropertyValue(span, 'locale', clientConsts) === 'dsh-code-runner',
    'header toggle locale namespace is not "dsh-code-runner"',
  )
  return 'id=code-runner-toggle order=5 locale=dsh-code-runner'
})

check('S69 client.js never hard-injects sidebarRightTabs/sidebarRight in the module inject array (v2 §4)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const returned = /return\s*\{\s*name\s*:\s*(['"])dsh-code-runner\1[\s\S]{0,200}?inject\s*:\s*\[([^\]]*)\]/.exec(clientRaw)
  assert(returned, 'could not find the returned { name, inject, apply } plugin object')
  const injected = returned[2]
  assert(
    !/sidebarRightTabs|sidebarRight/.test(injected),
    `module inject array hard-injects right-sidebar services: [${injected.trim()}]`,
  )
  assert(/slots/.test(injected) && /locale/.test(injected), `module inject array is [${injected.trim()}]`)
  return `inject: [${injected.trim()}]; right-sidebar services via ctx.inject only`
})

check('S70 header toggle opens/closes the right sidebar with a v1 page fallback', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const required = [
    [/\.get\s*\(\s*(['"])sidebarRight\1/, 'ctx.get("sidebarRight")'],
    [/openTab/, 'right.openTab( ) call'],
    [/selectPanel/, 'layout.selectPanel( ) page fallback'],
  ]
  const missing = required.filter(([pattern]) => !pattern.test(clientRaw)).map(([, label]) => label)
  assert(missing.length === 0, `missing: ${missing.join(', ')}`)
  assert(/isExpanded|\.close\s*\(/.test(clientRaw), 'no isExpanded/close handling for the toggle')
  return 'ctx.get("sidebarRight") → openTab/close, layout.selectPanel fallback'
})

check('S71 client.js declares all v2 API paths, document-relative (v2 §2.2–2.4)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const literals = collectStringLiterals(clientRaw).map((literal) => literal.content)
  const apiLiterals = literals.filter((content) => content.startsWith('dsh-code-runner/api/'))
  const missing = ['files', 'file', 'blob', 'artifacts'].filter(
    (name) => !apiLiterals.some((content) => content === `dsh-code-runner/api/${name}` || content.startsWith(`dsh-code-runner/api/${name}?`)),
  )
  assert(missing.length === 0, `missing client API path(s): ${missing.map((name) => `dsh-code-runner/api/${name}`).join(', ')}`)
  const absolute = literals.filter((content) => content.includes('/dsh-code-runner/api'))
  assert(absolute.length === 0, `absolute API path literal(s): ${absolute.slice(0, 3).join(', ')}`)
  return apiLiterals.join(', ')
})

check('S72 every client API fetch carries the host token (no bare API fetch)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/x-dsh-code-runner-token/.test(clientRaw), 'client.js never sets the x-dsh-code-runner-token header')
  const bare = allMatches(clientRaw, /fetch\s*\(\s*(['"`])dsh-code-runner\/api\//g)
  assert(bare.length === 0, `bare fetch("dsh-code-runner/api/…") at line(s) ${bare.map((entry) => lineOf(clientRaw, entry.index)).join(', ')}`)
  const suspicious = []
  for (const entry of allMatches(clientRaw, /\bfetch\s*\(/g)) {
    const windowText = clientRaw.slice(entry.index, entry.index + 600)
    if (!/dsh-code-runner\/api|API\.(?:blob|artifacts|files|file)/.test(windowText)) continue
    if (/x-dsh-code-runner-token|token|headers/i.test(windowText)) continue
    suspicious.push(lineOf(clientRaw, entry.index))
  }
  assert(suspicious.length === 0, `fetch( ) without token/headers near line(s) ${suspicious.join(', ')}`)
  return 'token header set; no token-less API fetch found'
})

check('S73 client.js registers everything inside ctx.effect (v2 §2.1, v2 §2.4)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const effectSpans = allMatches(clientMasked, /ctx\.effect\s*\(/g).map((entry) => {
    const open = clientMasked.indexOf('(', entry.index)
    const close = findMatching(clientMasked, open, '(', ')')
    return [open, close]
  })
  assert(effectSpans.length >= 4, `only ${effectSpans.length} ctx.effect() call(s) found`)
  const registrations = [
    ...allMatches(clientMasked, /\.slots\.register\s*\(/g),
    ...allMatches(clientMasked, /\.slots\.inject\s*\(/g),
    ...allMatches(clientMasked, /\.locale\.register\s*\(/g),
    ...allMatches(clientMasked, /\.sidebarRightTabs\s*\.\s*register\s*\(/g),
  ]
  assert(registrations.length >= 6, `only ${registrations.length} registration call(s) found`)
  const outside = registrations.filter(
    (entry) => !effectSpans.some(([open, close]) => open >= 0 && close > entry.index && entry.index > open),
  )
  assert(
    outside.length === 0,
    `registration(s) outside ctx.effect at line(s) ${outside.map((entry) => lineOf(clientRaw, entry.index)).join(', ')}`,
  )
  return `${registrations.length} registrations inside ${effectSpans.length} ctx.effect() blocks`
})

check('S74 client.js v2 accessibility hints (tablist/dialog/aria/Esc/gutter/lightbox)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const requirements = [
    [/['"]tablist['"]/, 'role="tablist"'],
    [/aria-selected|aria-pressed/, 'aria-selected/aria-pressed'],
    [/['"]dialog['"]/, 'role="dialog" lightbox'],
    [/Escape|['"]Esc['"]/, 'Escape key handling'],
    [/gutter|lineNumber|line-number|dcr-lineNo/i, 'editor line-number gutter'],
    [/aria-label/, 'aria-label'],
    [/focus-visible/, ':focus-visible'],
  ]
  const missing = requirements.filter(([pattern]) => !pattern.test(clientRaw)).map(([, label]) => label)
  assert(missing.length === 0, `missing a11y hint(s): ${missing.join(', ')}`)
  return `${requirements.length} a11y hints present`
})

check('S75 client.js keeps v1 surfaces and adds the v2/v3 locale keys in both dictionaries', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(v2InjectTargets.includes('sidebar.panellist'), 'v1 sidebar.panellist registration is gone')
  assert(v2InjectTargets.includes('main'), 'v1 main panel registration is gone')
  const v2Keys = contractLocaleKeys.slice(40)
  const missingZh = v2Keys.filter((key) => !zhKeys.has(key))
  const missingEn = v2Keys.filter((key) => !enKeys.has(key))
  assert(
    missingZh.length === 0 && missingEn.length === 0,
    `missing v2 locale keys — zh: [${missingZh.join(', ')}] en: [${missingEn.join(', ')}]`,
  )
  return `${v2Keys.length} v2/v3 locale keys in both dictionaries`
})

check('S76 client.js keeps styles host-native (no palette literals, dcr- prefix, theme tokens)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/dcr-/.test(clientRaw), 'no dcr- class prefix found')
  const tokens = new Set(allMatches(clientRaw, /--dsw-alias-[a-z0-9-]+/g).map((entry) => entry.text))
  assert(tokens.size >= 8, `only ${tokens.size} distinct --dsw-alias-* tokens found`)
  assert(!/document\s*\.\s*body/.test(clientRaw), 'document.body access found')
  return `${tokens.size} theme tokens, dcr- prefix, no document.body`
})


/* ═════════════════════ CONTRACT-V3 additions (v3 verification) ══════════════ */

const MATLAB_WRAPPER_EXPECTED = [
        '% dsh-code-runner: run a MATLAB script and export its figures to PNG.',
      "dshPlotsDir = getenv('DSH_CODE_RUNNER_PLOTS_DIR');",
      "dshScriptPath = getenv('DSH_CODE_RUNNER_SCRIPT');",
      'if isempty(dshPlotsDir) || isempty(dshScriptPath)',
      "  disp('dsh-code-runner: missing DSH_CODE_RUNNER_SCRIPT / DSH_CODE_RUNNER_PLOTS_DIR');",
      '  exit(1);',
      'end',
      "if ~exist(dshPlotsDir, 'dir')",
      '  mkdir(dshPlotsDir);',
      'end',
      'try',
      '  run(dshScriptPath);',
      "  dshFigures = findall(0, 'Type', 'figure');",
      '  for dshIndex = 1:numel(dshFigures)',
      "    dshTarget = fullfile(dshPlotsDir, sprintf('plot-%03d.png', dshIndex));",
      '    try',
      "      exportgraphics(dshFigures(dshIndex), dshTarget, 'Resolution', 144);",
      '    catch',
      "      try, print(dshFigures(dshIndex), dshTarget, '-dpng', '-r144'); catch, end",
      '    end',
      '  end',
      'catch err',
      '  disp(getReport(err));',
      '  exit(1);',
      'end',
    ].join('\n')

section('index.js — v3 host half (CONTRACT-V3 §1)')

check('S77 index.js declares the v3 routes + the v2.12 diag route', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const routes = [
    [/\/api\/explain\b/, '/api/explain'],
    [/\/api\/export\b/, '/api/export'],
    [/\/api\/save-plots\b/, '/api/save-plots'],
    [/\/api\/diag\b/, '/api/diag'],
  ]
  const missing = routes.filter(([regex]) => !regex.test(indexRaw)).map(([, label]) => label)
  assert(missing.length === 0, `missing route(s): ${missing.join(', ')}`)
  return routes.map(([, label]) => label).join(', ')
})

check('S78 index.js adds explainMaxChars + per-language extensions + matlab (v3 §1.1, §1.5)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(indexRaw.includes('explainMaxChars'), 'missing explainMaxChars limit')
  assert(/\bexplainMaxChars\s*:\s*20_?000\b/.test(indexRaw), 'explainMaxChars is not 20000')
  assert(indexRaw.includes('extensions'), 'language entries have no extensions list')
  assert(/['"]?extensions['"]?\s*:/.test(indexRaw), 'no extensions property in the language table')
  assert(indexRaw.includes("'matlab'") || indexRaw.includes('"matlab"'), 'no matlab language id')
  assert(/['"]m['"]/.test(indexRaw), "no '.m' extension literal for the matlab mapping")
  return 'explainMaxChars=20000, extensions[], matlab + .m'
})

check('S79 index.js uses llm/agentDefaultModel through optional ctx.get lookups (v3 §1.2)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  assert(indexProbe, indexProbeError || 'module probe unavailable')
  const inject = Array.isArray(indexProbe.inject) ? indexProbe.inject : []
  assert(!inject.includes('llm'), 'inject array hard-injects llm (must stay optional)')
  assert(!inject.includes('agentDefaultModel'), 'inject array hard-injects agentDefaultModel')
  for (const markerText of ['agentDefaultModel', 'currentSelection', 'llm', '.stream(']) {
    assert(indexRaw.includes(markerText), `missing v3 llm wiring marker: ${markerText}`)
  }
  assert(
    /ctx\.get\s*\(\s*['"]llm['"]\s*\)/.test(indexRaw) || /getOptionalService\s*\(\s*['"]llm['"]\s*\)/.test(indexRaw),
    'no optional llm service lookup',
  )
  assert(
    /ctx\.get\s*\(\s*['"]agentDefaultModel['"]\s*\)/.test(indexRaw)
      || /getOptionalService\s*\(\s*['"]agentDefaultModel['"]\s*\)/.test(indexRaw),
    'no optional agentDefaultModel lookup',
  )
  return `inject stays ${JSON.stringify(inject)}; ctx.get("llm"/"agentDefaultModel")`
})

check('S80 index.js declares the v3 llm error codes (v3 §1.1)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const codes = ['llm-unavailable', 'llm-failed', 'llm-timeout']
  const missing = codes.filter((code) => !new RegExp(`(['"\`])${code}\\1`).test(indexRaw))
  assert(missing.length === 0, `missing error code(s): ${missing.join(', ')}`)
  assert(/60000|60_000/.test(indexRaw) || /60000/.test(indexRaw), 'no 60000-char stream cap marker')
  assert(/90_?000|AbortController/.test(indexRaw), 'no 90s timeout/abort wiring marker')
  return codes.join(', ')
})

check('S81 index.js implements the MATLAB language + exact dsh_plot_wrapper.m bytes (v3 §1.5)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const markers = [
    'skipVersionProbe', 'MATLAB_R', '/Applications', '/usr/local/MATLAB', 'dsh_plot_wrapper.m',
    '-batch', 'exportgraphics', 'DSH_CODE_RUNNER_SCRIPT', 'DSH_CODE_RUNNER_PLOTS_DIR', 'script.m',
  ]
  const missing = markers.filter((markerText) => !indexRaw.includes(markerText))
  assert(missing.length === 0, `missing MATLAB marker(s): ${missing.join(', ')}`)
  assert(indexRaw.includes('run("'), 'no run("<wrapper>") argv marker')
  const normalised = indexRaw.replace(/\\r\\n/g, '\\n')
  assert(
    normalised.includes(MATLAB_WRAPPER_EXPECTED),
    'dsh_plot_wrapper.m content does not match the CONTRACT-V3 §1.5 bytes',
  )
  return 'discovery hints, skipVersionProbe, -batch run("<wrapper>"), exact wrapper bytes'
})

check('S82 index.js exports md/html/docx reports with selectable sections (v3 §1.3 + v4)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  const markers = [
    'dsh-code-runner-reports', 'docx', 'buildDocxReport', '[Content_Types].xml', 'word/document.xml',
    'reportPath', 'htmlPath', 'docxPath', 'baseName', 'include', 'run.json', 'plots/',
    'prefers-color-scheme', '源代码：', '输出结果：', '统计图：', 'AI 解读：', '（已截断）',
  ]
  const missing = markers.filter((markerText) => !indexRaw.includes(markerText))
  assert(missing.length === 0, `missing export marker(s): ${missing.join(', ')}`)
  assert(/<!doctype html>/i.test(indexRaw), 'report.html template has no <!doctype html>')
  assert(
    /data:\$\{[^}]*contentType[^}]*\};base64/.test(indexRaw) || /data:image\//.test(indexRaw),
    'no data-URI writer for embedded plots',
  )
  assert(/实验报告/.test(indexRaw), 'no 实验报告 file-name rule')
  return `${markers.length} v4 export markers present (md/html/docx, sections, naming)`
})

check('S83 index.js implements save-plots (v3 §1.4)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  for (const markerText of ['save-plots', 'targetDir', 'saved']) {
    assert(indexRaw.includes(markerText), `missing save-plots marker: ${markerText}`)
  }
  return 'save-plots + targetDir + saved[]'
})

check('S84 index.js implements the browser-diagnostics ring buffer (CONTRACT-V2 §1.12)', () => {
  assert(indexRaw !== null, 'index.js is missing')
  for (const markerText of ['api/diag', 'accepted', 'receivedAt', 'seq']) {
    assert(indexRaw.includes(markerText), `missing diag marker: ${markerText}`)
  }
  assert(/\b100\b/.test(indexRaw), 'no 100-event ring-buffer size marker')
  return 'api/diag + accepted/receivedAt/seq + 100-event buffer'
})

section('client.js — v3 selection, explain, export, save-plots, profiles (CONTRACT-V3 §2)')

check('S85 client.js wires selection runs (origin:"selection" + shift shortcut)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/origin\s*:\s*(['"])selection\1/.test(clientRaw), 'no origin:"selection" run request field')
  assert(/shiftKey/.test(clientRaw), 'no Shift shortcut handling')
  assert(/ctrlKey/.test(clientRaw) && /metaKey/.test(clientRaw), 'no Ctrl/⌘ modifier handling')
  assert(/selectionStart|onSelect|['"]select['"]/.test(clientRaw), 'no textarea selection tracking marker')
  assert(/['"]buffer['"]/.test(clientRaw), 'no buffer-mode marker for selection runs')
  return 'origin:"selection", Shift+Ctrl/Meta shortcut, selection tracking'
})

check('S86 client.js calls explain/export/save-plots endpoints and maps llm errors (v3 §2.2–2.4)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  const literals = collectStringLiterals(clientRaw).map((literal) => literal.content)
  for (const endpoint of ['explain', 'export', 'save-plots']) {
    const apiLiteral = `dsh-code-runner/api/${endpoint}`
    assert(
      literals.some((content) => content === apiLiteral || content.startsWith(`${apiLiteral}?`)),
      `client.js never calls ${apiLiteral}`,
    )
  }
  for (const markerText of ['annotatedCode', 'truncatedInput', 'summary', 'llm-unavailable', 'llm-failed', 'llm-timeout']) {
    assert(clientRaw.includes(markerText), `missing explain/export client marker: ${markerText}`)
  }
  return 'api/explain + api/export + api/save-plots + llm error mapping'
})

check('S87 client.js defines LANGUAGE_PROFILES including matlab (v3 §2.5)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(clientRaw.includes('LANGUAGE_PROFILES'), 'no LANGUAGE_PROFILES map')
  for (const markerText of ['matlab', 'language.hint.matlab', 'language.startingMatlab', 'language.consoleMatlab']) {
    assert(clientRaw.includes(markerText), `missing language-profile marker: ${markerText}`)
  }
  return 'LANGUAGE_PROFILES incl matlab + matlab hints'
})

check('S88 client.js reports browser diagnostics fire-and-forget (CONTRACT-V2 §2.7)', () => {
  assert(clientRaw !== null, 'client.js is missing')
  assert(/reportDiag|diagReport/.test(clientRaw), 'no reportDiag helper')
  const literals = collectStringLiterals(clientRaw).map((literal) => literal.content)
  assert(
    literals.some((content) => content === 'dsh-code-runner/api/diag'),
    'client.js never posts to dsh-code-runner/api/diag',
  )
  const eventNames = ['apply', 'right-tab', 'surface-mount', 'surface-crash', 'artifacts']
  const missing = eventNames.filter((name) => !clientRaw.includes(`'${name}'`) && !clientRaw.includes(`"${name}"`))
  assert(missing.length === 0, `missing diag event name(s): ${missing.join(', ')}`)
  return 'reportDiag + api/diag + event names'
})

/* ─────────────────────────────── summary ─────────────────────────────────── */

console.log(`\n${'─'.repeat(66)}`)
const passed = results.filter((entry) => entry.status === 'PASS').length
const failed = results.filter((entry) => entry.status === 'FAIL')
console.log(`static verification: ${passed}/${results.length} checks passed, ${failed.length} failed`)
if (failed.length > 0) {
  console.log('\nFAILED checks:')
  for (const entry of failed) console.log(`  ✗ ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`)
}
process.exitCode = failed.length > 0 ? 1 : 0
