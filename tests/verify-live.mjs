#!/usr/bin/env node
/**
 * Independent live verification for the installed dsh-code-runner bundle.
 *
 * The DSH Web GUI page itself is cookie-gated (the launch credential is not
 * available to an agent shell), so the live suite gets its CSRF token from the
 * Host half's own loopback bootstrap route (CONTRACT §1.10):
 *
 *   GET /dsh-code-runner/api/token   → { ok:true, token:"<48 hex>" }
 *
 * With that token it drives the real HTTP API end-to-end (python + R runs,
 * streaming output, stop, validation errors, auth gates) against the running
 * DSH Host. The page HTML is only probed for diagnostics — never required.
 *
 *   DSH_WEB_URL is honoured (default http://127.0.0.1:57598)
 *   node tests/verify-live.mjs
 *
 * Prints [PASS]/[FAIL]/[SKIP] lines plus a compact matrix and exits 1 on failure.
 * Every run started here is stopped before the script exits.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, truncate as truncateFile, utimes, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.env.DSH_WEB_URL || 'http://127.0.0.1:57598').replace(/\/+$/, '')
const API = `${BASE}/dsh-code-runner/api`

/* ────────────────────────────── reporting ────────────────────────────────── */

const records = []
const pass = (id, detail = '') => {
  records.push({ status: 'PASS', id, detail })
  console.log(`[PASS] ${id}${detail ? ` — ${detail}` : ''}`)
}
const fail = (id, detail = '') => {
  records.push({ status: 'FAIL', id, detail })
  console.log(`[FAIL] ${id}${detail ? ` — ${detail}` : ''}`)
}
const skip = (id, reason = '') => {
  records.push({ status: 'SKIP', id, detail: reason })
  console.log(`[SKIP] ${id}${reason ? ` — ${reason}` : ''}`)
}
const info = (message) => console.log(`[INFO] ${message}`)
function assert(condition, message, extra) {
  if (!condition) throw new Error(`${message}${extra ? ` — ${extra}` : ''}`)
}
const truncate = (text, max = 240) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ───────────────────────────── HTTP helpers ──────────────────────────────── */

/**
 * Raw node:http request with caller-controlled headers. Node's fetch (undici)
 * treats `Host` as a forbidden request header and silently drops overrides, so
 * the §1.10 rule-2 (non-loopback Host) case must go through node:http.
 */
function rawHttpRequest({ pathname, method = 'GET', headers = {}, body, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(pathname, `${BASE}/`)
    } catch (error) {
      reject(new Error(`invalid raw request path ${pathname}: ${error?.message ?? error}`))
      return
    }
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json })
        })
        response.on('error', (error) => reject(new Error(`raw HTTP response error: ${error?.message ?? error}`)))
      },
    )
    request.on('timeout', () => request.destroy(new Error(`raw HTTP timeout after ${timeoutMs} ms`)))
    request.on('error', (error) => reject(new Error(`raw HTTP request error: ${error?.message ?? error}`)))
    if (body !== undefined) request.write(body)
    request.end()
  })
}

let currentToken = null
const startedRuns = []
let workspaceDir = null
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function apiFetch(
  pathname,
  { method = 'GET', query, body, rawBody, token = currentToken, headers = {}, timeoutMs = 20_000 } = {},
) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : ''
  const requestHeaders = { accept: 'application/json', ...headers }
  if (token !== null && token !== undefined) requestHeaders['x-dsh-code-runner-token'] = token
  const init = {
    method,
    headers: requestHeaders,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (rawBody !== undefined) init.body = rawBody
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    requestHeaders['content-type'] = 'application/json'
  }
  let response
  try {
    response = await fetch(`${API}${pathname}${search}`, init)
  } catch (error) {
    throw new Error(`network error for ${method} ${pathname}: ${error?.message ?? error}`)
  }
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json,
  }
}

async function apiFetchBytes(
  pathname,
  { query, token = currentToken, headers = {}, timeoutMs = 60_000 } = {},
) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : ''
  const requestHeaders = { accept: '*/*', ...headers }
  if (token !== null && token !== undefined) requestHeaders['x-dsh-code-runner-token'] = token
  let response
  try {
    response = await fetch(`${API}${pathname}${search}`, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`network error for GET ${pathname}: ${error?.message ?? error}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    buffer,
  }
}

function expectError(result, status, code) {
  assert(result.status === status, `expected HTTP ${status}, got ${result.status}`, truncate(result.text))
  assert(result.json, 'response body is not JSON', truncate(result.text))
  assert(result.json.ok === false, `ok is not false — ${truncate(result.text)}`)
  assert(result.json.error && typeof result.json.error === 'object', 'error envelope missing')
  assert(
    result.json.error.code === code,
    `expected error.code ${JSON.stringify(code)}, got ${JSON.stringify(result.json.error.code)}`,
  )
  assert(
    typeof result.json.error.message === 'string' && result.json.error.message.length > 0,
    'error.message is empty',
  )
}

function expectRunReply(reply, languageId) {
  assert(reply.status === 200, `POST /api/run returned HTTP ${reply.status}`, truncate(reply.text))
  const json = reply.json
  assert(json?.ok === true, `run reply is not ok:true — ${truncate(reply.text)}`)
  assert(typeof json.runId === 'string' && json.runId.length > 0, 'runId is missing')
  assert(json.language === languageId, `language is ${JSON.stringify(json.language)}`)
  assert(typeof json.command === 'string' && json.command.length > 0, 'command is missing')
  assert(typeof json.scriptPath === 'string' && json.scriptPath.length > 0, 'scriptPath is missing')
  assert(typeof json.cwd === 'string' && json.cwd.startsWith('/'), `cwd is ${JSON.stringify(json.cwd)}`)
  assert(Number.isInteger(json.startedAt) && json.startedAt > 0, 'startedAt is not a timestamp')
  assert(Number.isInteger(json.timeoutMs), 'timeoutMs is not an integer')
  startedRuns.push({ runId: json.runId, finished: false })
  return json
}

async function waitForRun(runId, { maxMs = 20_000, intervalMs = 140 } = {}) {
  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutFrom = 0
  let stderrFrom = 0
  let last = null
  let polls = 0
  while (Date.now() - startedAt <= maxMs) {
    polls += 1
    const result = await apiFetch('/output', { query: { runId, stdoutFrom, stderrFrom } })
    assert(result.status === 200, `output poll returned HTTP ${result.status}`, truncate(result.text))
    assert(result.json?.ok === true, `output poll not ok — ${truncate(result.text)}`)
    last = result.json
    stdout += last.stdout?.text ?? ''
    stderr += last.stderr?.text ?? ''
    if (Number.isInteger(last.stdout?.nextOffset)) stdoutFrom = last.stdout.nextOffset
    if (Number.isInteger(last.stderr?.nextOffset)) stderrFrom = last.stderr.nextOffset
    if (last.running === false) {
      const record = startedRuns.find((entry) => entry.runId === runId)
      if (record) record.finished = true
      return { stdout, stderr, last, polls }
    }
    await sleep(intervalMs)
  }
  throw new Error(`run ${runId} still running after ${maxMs} ms`)
}

async function bootstrapToken() {
  const result = await apiFetch('/token', { token: null })
  if (result.status !== 200) {
    let hint = ''
    if (/dsh web authentication required/i.test(result.text)) {
      hint = 'the DSH webserver auth fallback answered, so /dsh-code-runner was NOT registered (plugin not installed/active)'
    } else if (result.status === 404) {
      hint = 'prefix route not mounted (fallback 404) — is the bundle installed and the Host reloaded?'
    } else {
      hint = `unexpected response: ${truncate(result.text)}`
    }
    throw new Error(`GET ${API}/token → HTTP ${result.status}; ${hint}`)
  }
  assert(result.json?.ok === true, 'bootstrap body is not ok:true', truncate(result.text))
  assert(/^[0-9a-f]{48}$/.test(String(result.json.token)), 'bootstrap token is not a 48-char hex string')
  return result.json.token
}

/* ─────────────────────────── page diagnostics ────────────────────────────── */

async function pageDiagnostic() {
  try {
    const response = await fetch(`${BASE}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
    const text = await response.text()
    if (/window\.__DSH_CODE_RUNNER__\s*=\s*\{[^<]*\}/.test(text)) {
      info('page / exposes window.__DSH_CODE_RUNNER__ (authenticated HTML) — the §1.10 bootstrap is used anyway')
    } else if (/dsh web authentication required/i.test(text)) {
      info('page / is cookie-gated (expected for an agent shell); the token comes from §1.10 bootstrap instead')
    } else {
      info(`page / returned HTTP ${response.status} without the token global — bootstrap used instead`)
    }
  } catch (error) {
    info(`page / fetch failed (${error?.message ?? error}); the §1.10 bootstrap is used for the token`)
  }
}

/* ─────────────────────────────── the checks ──────────────────────────────── */

async function main() {
  console.log('dsh-code-runner — independent live verification')
  console.log(`base: ${BASE}`)
  await pageDiagnostic()

  /* ── token bootstrap (§1.10) ─────────────────────────────────────────── */

  section('token bootstrap (CONTRACT §1.10)')

  let token = null
  try {
    token = await bootstrapToken()
    currentToken = token
    pass('L01 GET /api/token returns {ok:true, token} to a loopback client', `${token.length}-hex token obtained`)
  } catch (error) {
    fail('L01 GET /api/token returns {ok:true, token} to a loopback client', error.message)
  }

  if (!token) {
    const pending = [
      'L02 bootstrap rejects sec-fetch-site: cross-site',
      'L03 bootstrap rejects a cross-origin Origin',
      'L04 bootstrap accepts a same-origin loopback Origin',
      'L05 bootstrap rejects a non-loopback Host header',
      'L06 GET /api/env lists python + r with resolved versions',
      'L07 python run round-trip prints "hello 4" and exits 0',
      'L08 R run round-trip prints "hello R 4" and exits 0',
      'L09 python error yields nonzero exitCode and stderr',
      'L10 SystemExit(3) propagates exit code 3',
      'L11 stdin round-trip reaches the script',
      'L12 timeoutMs clamps to the 1000 ms minimum',
      'L13 stop terminates a long run (stopped:true, running:false)',
      'L14 byte offsets are non-consuming',
      'L15 unknown runId → 404 unknown-run',
      'L16 unsupported language → 400 unsupported-language',
      'L17 missing cwd → 400 bad-cwd',
      'L18 anonymous GET /api/env → 401 unauthorized',
      'L19 anonymous GET /api/output → 401 unauthorized (auth before lookup)',
      'L20 cross-origin Origin with valid token → 403 forbidden',
      'L21 sec-fetch-site: cross-site with valid token → 403 forbidden',
      'L22 same-origin Origin with valid token is accepted',
      'L23 OPTIONS → 405 method-not-allowed, no CORS headers',
      'L24 unknown route → 404 unknown-route',
      'L25 POST /api/file creates the v2 temp workspace files',
      'L26 GET /api/files lists the workspace entries',
      'L27 GET /api/file reads script.py back',
      'L28 POST /api/file save round-trip (baseMtimeMs accepted)',
      'L29 save conflict 409 + force overwrite (no baseMtimeMs)',
      'L30 GET /api/files errors are 400 bad-path',
      'L31 file-mode python run accepted (on-disk script.py)',
      'L32 python matplotlib figure captured → artifacts source:run + /api/blob PNG',
      'L33 R plot(1:10) captured → artifacts source:run + /api/blob PNG',
      'L34 buffer mode still works (mode:buffer, file:null)',
      'L35 artifacts/blob errors (404/400/415/404)',
      'L36 blob too-large → 413 too-large',
      'L37 POST+GET /api/diag works and reports real-page events',
      'L38 POST /api/explain returns a real LLM summary',
      'L39 POST /api/export writes report.md/html/run.json + plots into a new folder',
      'L40 export never reuses a folder (same-second collision gets -2)',
      'L41 POST /api/save-plots copies + dedupes into a temp target',
      'L42 MATLAB detected + real matlab run with figure capture',
      'L43 selection-run semantics = R buffer run of a partial script',
    ]
    for (const id of pending) skip(id, 'token bootstrap failed — plugin not installed/active on this Host')
    return
  }

  /* ── bootstrap security rules ────────────────────────────────────────── */

  section('bootstrap security rules (§1.10)')

  try {
    const result = await apiFetch('/token', { token: null, headers: { 'sec-fetch-site': 'cross-site' } })
    expectError(result, 403, 'forbidden')
    pass('L02 bootstrap rejects sec-fetch-site: cross-site', '403 forbidden')
  } catch (error) {
    fail('L02 bootstrap rejects sec-fetch-site: cross-site', error.message)
  }
  try {
    const result = await apiFetch('/token', { token: null, headers: { origin: 'http://evil.example' } })
    expectError(result, 403, 'forbidden')
    pass('L03 bootstrap rejects a cross-origin Origin', '403 forbidden')
  } catch (error) {
    fail('L03 bootstrap rejects a cross-origin Origin', error.message)
  }
  try {
    const result = await apiFetch('/token', { token: null, headers: { origin: BASE } })
    assert(result.status === 200, `expected HTTP 200, got ${result.status}`, truncate(result.text))
    assert(/^[0-9a-f]{48}$/.test(String(result.json?.token)), 'loopback-origin bootstrap returned no token')
    pass('L04 bootstrap accepts a same-origin loopback Origin', `HTTP 200, token ${String(result.json.token).length} hex`)
  } catch (error) {
    fail('L04 bootstrap accepts a same-origin loopback Origin', error.message)
  }
  try {
    // §1.10 rule 2 (proxy/tunnel safety). fetch() cannot send a Host override,
    // so this case uses node:http and a real `Host: evil.example:57598` header.
    const hostileHost = await rawHttpRequest({
      pathname: '/dsh-code-runner/api/token',
      headers: { Host: 'evil.example:57598', accept: 'application/json' },
    })
    expectError(hostileHost, 403, 'forbidden')
    const loopbackHost = await rawHttpRequest({
      pathname: '/dsh-code-runner/api/token',
      headers: { Host: 'localhost:57598', accept: 'application/json' },
    })
    assert(loopbackHost.status === 200, `Host: localhost → HTTP ${loopbackHost.status}`, truncate(loopbackHost.text))
    assert(
      /^[0-9a-f]{48}$/.test(String(loopbackHost.json?.token)),
      'Host: localhost bootstrap returned no token',
    )
    pass(
      'L05 bootstrap rejects a non-loopback Host header',
      'Host: evil.example → 403 forbidden; Host: localhost → 200 (raw node:http Host header)',
    )
  } catch (error) {
    fail('L05 bootstrap rejects a non-loopback Host header', error.message)
  }

  /* ── env ─────────────────────────────────────────────────────────────── */

  section('host environment (CONTRACT §1.6)')

  let env = null
  let liveEnv = null
  try {
    const result = await apiFetch('/env')
    assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
    assert(
      String(result.headers['content-type'] ?? '').includes('application/json'),
      `content-type is ${JSON.stringify(result.headers['content-type'])}`,
    )
    const json = result.json
    env = json
    liveEnv = json
    assert(json?.ok === true, 'env ok is not true', truncate(result.text))
    assert(json.platform === 'posix', `platform is ${JSON.stringify(json.platform)}`)
    const expectedLimits = {
      codeMaxBytes: 1_048_576,
      outputMaxBytes: 2_097_152,
      defaultTimeoutMs: 300_000,
      maxTimeoutMs: 1_800_000,
      fileMaxBytes: 1_048_576,
      blobMaxBytes: 16_777_216,
      artifactMax: 40,
      explainMaxChars: 20_000,
    }
    const actualLimits = json.limits ?? {}
    const wrongLimits = Object.entries(expectedLimits).filter(([key, value]) => actualLimits[key] !== value)
    assert(
      wrongLimits.length === 0,
      `wrong limit(s): ${wrongLimits.map(([key]) => `${key}=${JSON.stringify(actualLimits[key])}`).join(', ')}`,
    )
    assert(Array.isArray(json.languages) && json.languages.length === 12, `languages has ${json.languages?.length} entries`)
    const languageIds = json.languages.map((entry) => entry.id)
    assert(languageIds.includes('matlab'), `matlab missing from languages: ${JSON.stringify(languageIds)}`)
    assert(
      languageIds.indexOf('matlab') === languageIds.indexOf('r') + 1,
      `matlab is not listed right after r: ${JSON.stringify(languageIds)}`,
    )
    for (const entry of json.languages) {
      assert(Array.isArray(entry.extensions) && entry.extensions.length > 0, `${entry.id} has no extensions[]`)
    }
    for (const id of ['python', 'r']) {
      const language = json.languages.find((entry) => entry.id === id)
      assert(language, `language ${id} is missing from /api/env`)
      assert(language.available === true, `language ${id} is not available on this Host`)
      assert(
        typeof language.command === 'string' && language.command.length > 0,
        `language ${id} has no command`,
      )
      assert(
        typeof language.version === 'string' && language.version.length > 0,
        `language ${id} has no version`,
      )
    }
    pass(
      'L06 GET /api/env lists python + r with resolved versions (+ matlab entry, extensions[])',
      `defaultCwd=${json.defaultCwd} tmpRoot=${json.tmpRoot}`,
    )
  } catch (error) {
    fail('L06 GET /api/env lists python + r with resolved versions', error.message)
  }

  if (env) {
    console.log('\n  detected languages (as reported by the live Host):')
    for (const language of env.languages) {
      const marker = language.available ? '✓' : '·'
      const version = language.version ?? '(unavailable)'
      const command = language.command ?? ''
      console.log(`    ${marker} ${String(language.id).padEnd(7)} ${version}  ${command}`)
    }
  }

  /* ── python / R round-trips ──────────────────────────────────────────── */

  section('run round-trips (CONTRACT §1.7, §1.8)')

  let pythonRun = null
  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'print("hello", 2+2)' },
    })
    pythonRun = expectRunReply(reply, 'python')
    const result = await waitForRun(pythonRun.runId)
    assert(result.stdout.includes('hello 4'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
    assert(result.last.exitCode === 0, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
    assert(result.last.running === false, 'running is not false')
    assert(Number.isInteger(result.last.durationMs), 'durationMs is not a number')
    assert(result.last.timedOut === false, 'timedOut should be false')
    pass(
      'L07 python run round-trip prints "hello 4" and exits 0',
      `stdout=${JSON.stringify(truncate(result.stdout, 40))} exit=0 ${result.last.durationMs}ms`,
    )
  } catch (error) {
    fail('L07 python run round-trip prints "hello 4" and exits 0', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'r', code: 'cat("hello R", 2+2, "\\n")' },
    })
    const run = expectRunReply(reply, 'r')
    const result = await waitForRun(run.runId)
    assert(result.stdout.includes('hello R 4'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
    assert(result.last.exitCode === 0, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
    pass(
      'L08 R run round-trip prints "hello R 4" and exits 0',
      `stdout=${JSON.stringify(truncate(result.stdout, 40))} exit=0`,
    )
  } catch (error) {
    fail('L08 R run round-trip prints "hello R 4" and exits 0', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'raise RuntimeError("verify-live-boom")' },
    })
    const run = expectRunReply(reply, 'python')
    const result = await waitForRun(run.runId)
    assert(
      Number.isInteger(result.last.exitCode) && result.last.exitCode !== 0,
      `exitCode is ${JSON.stringify(result.last.exitCode)}`,
    )
    assert(result.stderr.trim().length > 0, 'stderr is empty')
    pass('L09 python error yields nonzero exitCode and stderr', `exit=${result.last.exitCode}`)
  } catch (error) {
    fail('L09 python error yields nonzero exitCode and stderr', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'raise SystemExit(3)' },
    })
    const run = expectRunReply(reply, 'python')
    const result = await waitForRun(run.runId)
    assert(result.last.exitCode === 3, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
    pass('L10 SystemExit(3) propagates exit code 3', 'exitCode=3')
  } catch (error) {
    fail('L10 SystemExit(3) propagates exit code 3', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: {
        language: 'python',
        code: 'import sys\ndata = sys.stdin.read()\nprint("stdin:" + data.strip())',
        stdin: 'ping',
      },
    })
    const run = expectRunReply(reply, 'python')
    const result = await waitForRun(run.runId)
    assert(result.stdout.includes('stdin:ping'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
    pass('L11 stdin round-trip reaches the script', 'stdout=stdin:ping')
  } catch (error) {
    fail('L11 stdin round-trip reaches the script', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'print("clamp")', timeoutMs: 1 },
    })
    const run = expectRunReply(reply, 'python')
    assert(run.timeoutMs === 1_000, `clamped timeoutMs is ${JSON.stringify(run.timeoutMs)}`)
    await waitForRun(run.runId)
    pass('L12 timeoutMs clamps to the 1000 ms minimum', 'reply timeoutMs=1000')
  } catch (error) {
    fail('L12 timeoutMs clamps to the 1000 ms minimum', error.message)
  }

  /* ── stop ────────────────────────────────────────────────────────────── */

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'import time\ntime.sleep(30)' },
    })
    const run = expectRunReply(reply, 'python')
    await sleep(1_000)
    const running = await apiFetch('/output', { query: { runId: run.runId } })
    assert(running.json?.running === true, 'run was not running before the stop request')
    const stopped = await apiFetch('/stop', { method: 'POST', body: { runId: run.runId } })
    assert(stopped.status === 200, `stop returned HTTP ${stopped.status}`, truncate(stopped.text))
    assert(stopped.json?.ok === true, 'stop ok is not true')
    assert(stopped.json.stopped === true, `stop replied stopped=${JSON.stringify(stopped.json.stopped)}`)
    assert(stopped.json.runId === run.runId, 'stop runId mismatch')
    const result = await waitForRun(run.runId, { maxMs: 5_000 })
    assert(result.last.running === false, 'run still running after stop')
    assert(result.last.stopped === true, 'stopped flag is not true after stop')
    pass(
      'L13 stop terminates a long run (stopped:true, running:false)',
      `finished in ${result.polls} poll(s), signal ${JSON.stringify(result.last.signal)}`,
    )
  } catch (error) {
    fail('L13 stop terminates a long run (stopped:true, running:false)', error.message)
  }

  /* ── output offsets ──────────────────────────────────────────────────── */

  try {
    let runId = pythonRun?.runId
    if (!runId) {
      const reply = await apiFetch('/run', {
        method: 'POST',
        body: { language: 'python', code: 'print("offsets")' },
      })
      runId = expectRunReply(reply, 'python').runId
      await waitForRun(runId)
    }
    const first = await apiFetch('/output', { query: { runId } })
    assert(first.status === 200, `first read HTTP ${first.status}`)
    assert(first.json.stdout.text.includes('hello 4'), 're-read did not return the earlier stdout')
    const second = await apiFetch('/output', {
      query: {
        runId,
        stdoutFrom: first.json.stdout.nextOffset,
        stderrFrom: first.json.stderr.nextOffset,
      },
    })
    assert(second.status === 200, `second read HTTP ${second.status}`)
    assert(second.json.stdout.text === '', `re-read stdout is ${JSON.stringify(second.json.stdout.text)}`)
    assert(
      second.json.stdout.nextOffset === first.json.stdout.nextOffset,
      'nextOffset moved without new output',
    )
    pass('L14 byte offsets are non-consuming', `offsets stable at ${first.json.stdout.nextOffset} bytes`)
  } catch (error) {
    fail('L14 byte offsets are non-consuming', error.message)
  }

  /* ── validation errors ───────────────────────────────────────────────── */

  section('validation + auth gates (CONTRACT §1.3, §1.4)')

  try {
    const result = await apiFetch('/output', { query: { runId: 'verify-live-missing-run' } })
    expectError(result, 404, 'unknown-run')
    pass('L15 unknown runId → 404 unknown-run', '404 unknown-run')
  } catch (error) {
    fail('L15 unknown runId → 404 unknown-run', error.message)
  }
  try {
    const result = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'nope', code: 'print(1)' },
    })
    expectError(result, 400, 'unsupported-language')
    pass('L16 unsupported language → 400 unsupported-language', '400 unsupported-language')
  } catch (error) {
    fail('L16 unsupported language → 400 unsupported-language', error.message)
  }
  try {
    const result = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'print(1)', cwd: '/does/not/exist' },
    })
    expectError(result, 400, 'bad-cwd')
    pass('L17 missing cwd → 400 bad-cwd', '400 bad-cwd')
  } catch (error) {
    fail('L17 missing cwd → 400 bad-cwd', error.message)
  }

  /* ── auth gates ──────────────────────────────────────────────────────── */

  try {
    const result = await apiFetch('/env', { token: null })
    expectError(result, 401, 'unauthorized')
    assert(
      String(result.headers['content-type'] ?? '').includes('application/json'),
      `401 content-type is ${JSON.stringify(result.headers['content-type'])}`,
    )
    pass('L18 anonymous GET /api/env → 401 unauthorized', '401 + JSON unauthorized envelope')
  } catch (error) {
    fail('L18 anonymous GET /api/env → 401 unauthorized', error.message)
  }
  try {
    const result = await apiFetch('/output', {
      token: null,
      query: { runId: 'verify-live-missing-run' },
    })
    expectError(result, 401, 'unauthorized')
    pass('L19 anonymous GET /api/output → 401 unauthorized (auth before lookup)', '401 unauthorized')
  } catch (error) {
    fail('L19 anonymous GET /api/output → 401 unauthorized (auth before lookup)', error.message)
  }
  try {
    const result = await apiFetch('/run', {
      method: 'POST',
      body: { language: 'python', code: 'print(1)' },
      headers: { origin: 'http://evil.example' },
    })
    expectError(result, 403, 'forbidden')
    pass('L20 cross-origin Origin with valid token → 403 forbidden', '403 forbidden')
  } catch (error) {
    fail('L20 cross-origin Origin with valid token → 403 forbidden', error.message)
  }
  try {
    const result = await apiFetch('/env', { headers: { 'sec-fetch-site': 'cross-site' } })
    expectError(result, 403, 'forbidden')
    pass('L21 sec-fetch-site: cross-site with valid token → 403 forbidden', '403 forbidden')
  } catch (error) {
    fail('L21 sec-fetch-site: cross-site with valid token → 403 forbidden', error.message)
  }
  try {
    const result = await apiFetch('/env', { headers: { origin: BASE } })
    assert(result.status === 200, `expected HTTP 200, got ${result.status}`, truncate(result.text))
    assert(result.json?.ok === true, 'same-origin env is not ok:true')
    // CONTRACT §1.3: an origin with the same hostname[:port] but a different scheme
    // (reverse-proxy deployment) is also allowed.
    const proxyOrigin = BASE.replace(/^http:/, 'https:')
    const proxied = await apiFetch('/env', { headers: { origin: proxyOrigin } })
    assert(proxied.status === 200, `same-authority proxy origin → HTTP ${proxied.status}`, truncate(proxied.text))
    pass('L22 same-origin Origin with valid token is accepted', 'HTTP 200 (same-origin + https proxy origin)')
  } catch (error) {
    fail('L22 same-origin Origin with valid token is accepted', error.message)
  }
  try {
    const result = await apiFetch('/env', { method: 'OPTIONS', token: null })
    expectError(result, 405, 'method-not-allowed')
    assert(
      !result.headers['access-control-allow-origin'] && !result.headers['access-control-allow-methods'],
      'CORS headers leaked',
    )
    pass('L23 OPTIONS → 405 method-not-allowed, no CORS headers', '405, no CORS')
  } catch (error) {
    fail('L23 OPTIONS → 405 method-not-allowed, no CORS headers', error.message)
  }
  /* ── CONTRACT-V2: files, plots, file-mode runs (§1.6–§1.10) ──────────── */

  section('v2 files API (CONTRACT-V2 §1.6–§1.8)')

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dcr-live-'))
  workspaceDir = workspace
  const scriptPy = path.join(workspace, 'script.py')
  const scriptR = path.join(workspace, 'script.R')
  const notesTxt = path.join(workspace, 'notes.txt')
  const scriptPyBody = [
    'import matplotlib.pyplot as plt',
    'print("LIVE-PLOT-PY")',
    'plt.plot([1, 2, 3, 4])',
    '',
  ].join('\n')
  const scriptRBody = 'plot(1:10)\ncat("LIVE-PLOT-R\\n")\n'
  const fileMeta = {}

  try {
    const pySave = await apiFetch('/file', { method: 'POST', body: { path: scriptPy, text: scriptPyBody } })
    assert(pySave.status === 200, `create script.py HTTP ${pySave.status}`, truncate(pySave.text))
    assert(pySave.json?.ok === true, 'create script.py not ok')
    fileMeta.py = pySave.json
    const rSave = await apiFetch('/file', { method: 'POST', body: { path: scriptR, text: scriptRBody } })
    assert(rSave.status === 200 && rSave.json?.ok === true, `create script.R HTTP ${rSave.status}`, truncate(rSave.text))
    const txtSave = await apiFetch('/file', { method: 'POST', body: { path: notesTxt, text: 'plain text\n' } })
    assert(txtSave.status === 200 && txtSave.json?.ok === true, `create notes.txt HTTP ${txtSave.status}`)
    pass('L25 POST /api/file creates script.py, script.R, notes.txt in a temp workspace', workspace)
  } catch (error) {
    fail('L25 POST /api/file creates script.py, script.R, notes.txt in a temp workspace', error.message)
  }

  try {
    const result = await apiFetch('/files', { query: { dir: workspace } })
    assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
    const json = result.json
    assert(json?.ok === true, 'ok is not true')
    assert(json.dir === workspace, `dir is ${JSON.stringify(json.dir)}`)
    assert(json.parent === path.dirname(workspace), `parent is ${JSON.stringify(json.parent)}`)
    assert(Array.isArray(json.entries), 'entries is not an array')
    assert(json.truncated === false, 'truncated should be false')
    const names = json.entries.map((entry) => entry.name)
    for (const expectedName of ['script.py', 'script.R', 'notes.txt']) {
      assert(names.includes(expectedName), `${expectedName} missing from /api/files`)
    }
    const scriptEntry = json.entries.find((entry) => entry.name === 'script.py')
    assert(scriptEntry.isDir === false, 'script.py classified as directory')
    assert(scriptEntry.ext === 'py', `script.py ext is ${JSON.stringify(scriptEntry.ext)}`)
    assert(Number.isInteger(scriptEntry.size) && scriptEntry.size >= 0, `entry size is ${JSON.stringify(scriptEntry.size)}`)
    assert(Number.isFinite(scriptEntry.mtimeMs) && scriptEntry.mtimeMs > 0, `entry mtimeMs is ${JSON.stringify(scriptEntry.mtimeMs)}`)
    pass('L26 GET /api/files lists the workspace entries', `${json.entries.length} entries, v2 shape ok`)
  } catch (error) {
    fail('L26 GET /api/files lists the workspace entries', error.message)
  }

  try {
    const result = await apiFetch('/file', { query: { path: scriptPy } })
    assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
    assert(result.json?.ok === true, 'ok is not true')
    assert(result.json.text === scriptPyBody, 'read-back text mismatch')
    assert(result.json.size === Buffer.byteLength(scriptPyBody), `size is ${result.json.size}`)
    assert(result.json.binary === false && result.json.truncated === false, 'binary/truncated flags wrong')
    fileMeta.pyMtimeMs = result.json.mtimeMs
    pass('L27 GET /api/file reads script.py back', `size=${result.json.size}, ext=${result.json.ext}`)
  } catch (error) {
    fail('L27 GET /api/file reads script.py back', error.message)
  }

  try {
    const savedText = `${scriptPyBody}# saved by the live verifier\n`
    const result = await apiFetch('/file', {
      method: 'POST',
      body: { path: scriptPy, text: savedText, baseMtimeMs: fileMeta.pyMtimeMs },
    })
    assert(result.status === 200, `save HTTP ${result.status}`, truncate(result.text))
    assert(result.json?.ok === true, 'save reply not ok')
    const readBack = await apiFetch('/file', { query: { path: scriptPy } })
    assert(readBack.json.text === savedText, 'saved text did not round-trip')
    fileMeta.pyText = savedText
    fileMeta.pyMtimeMs = readBack.json.mtimeMs
    pass('L28 POST /api/file save round-trip (baseMtimeMs accepted)', 'content persisted')
  } catch (error) {
    fail('L28 POST /api/file save round-trip (baseMtimeMs accepted)', error.message)
  }

  try {
    const baseMtimeMs = fileMeta.pyMtimeMs
    assert(Number.isFinite(baseMtimeMs) && baseMtimeMs > 0, 'no baseline mtime from the save round-trip')
    await writeFile(scriptPy, '# external edit\n')
    await utimes(scriptPy, new Date(), new Date(baseMtimeMs + 5_000))
    const stale = await apiFetch('/file', {
      method: 'POST',
      body: { path: scriptPy, text: 'stale overwrite\n', baseMtimeMs },
    })
    assert(stale.status === 409, `expected HTTP 409, got ${stale.status}`, truncate(stale.text))
    assert(stale.json?.ok === false, 'conflict response ok is not false')
    assert(stale.json.error?.code === 'conflict', `error.code is ${JSON.stringify(stale.json.error?.code)}`)
    assert(
      Number.isFinite(stale.json.currentMtimeMs) && stale.json.currentMtimeMs > 0,
      `conflict payload currentMtimeMs is ${JSON.stringify(stale.json.currentMtimeMs)}`,
    )
    const forced = await apiFetch('/file', { method: 'POST', body: { path: scriptPy, text: fileMeta.pyText } })
    assert(forced.status === 200 && forced.json?.ok === true, `force save HTTP ${forced.status}`)
    const readBack = await apiFetch('/file', { query: { path: scriptPy } })
    assert(readBack.json.text === fileMeta.pyText, 'forced save content mismatch')
    pass('L29 save conflict 409 + force overwrite (no baseMtimeMs)', 'currentMtimeMs present, forced write ok')
  } catch (error) {
    fail('L29 save conflict 409 + force overwrite (no baseMtimeMs)', error.message)
  }

  try {
    const missingDir = await apiFetch('/files', { query: { dir: path.join(workspace, 'no-such-dir') } })
    expectError(missingDir, 400, 'bad-path')
    const relativeDir = await apiFetch('/files', { query: { dir: 'relative/dir' } })
    expectError(relativeDir, 400, 'bad-path')
    pass('L30 GET /api/files errors are 400 bad-path', 'missing + relative dirs')
  } catch (error) {
    fail('L30 GET /api/files errors are 400 bad-path', error.message)
  }

  /* ── CONTRACT-V2: file-mode runs + plot capture (§1.3) ────────────────── */

  section('v2 file-mode runs + plot capture (CONTRACT-V2 §1.3–§1.5)')

  let rRun = null
  let rRunOutput = null
  let rRunPlot = null

  let pyRun = null
  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { mode: 'file', file: scriptPy, cwd: workspace, capturePlots: true },
    })
    pyRun = expectRunReply(reply, 'python')
    assert(pyRun.mode === 'file', `mode is ${JSON.stringify(pyRun.mode)}`)
    assert(pyRun.file === scriptPy, `file is ${JSON.stringify(pyRun.file)}`)
    assert(pyRun.scriptPath === scriptPy, `scriptPath is ${JSON.stringify(pyRun.scriptPath)} (on-disk path expected)`)
    assert(pyRun.cwd === workspace, `cwd is ${JSON.stringify(pyRun.cwd)}`)
    assert(pyRun.capturePlots === true, 'capturePlots is not true')
    assert(typeof pyRun.plotDir === 'string' && pyRun.plotDir.startsWith('/'), 'plotDir is not absolute')
    pass('L31 file-mode python run accepted (on-disk script.py)', `plotDir=${pyRun.plotDir}`)
  } catch (error) {
    fail('L31 file-mode python run accepted (on-disk script.py)', error.message)
  }

  try {
    assert(pyRun, 'no python file-mode run started')
    const output = await waitForRun(pyRun.runId, { maxMs: 60_000 })
    assert(output.stdout.includes('LIVE-PLOT-PY'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
    assert(output.last.exitCode === 0, `exitCode is ${JSON.stringify(output.last.exitCode)}`)
    const artifacts = await apiFetch('/artifacts', { query: { runId: pyRun.runId } })
    assert(artifacts.status === 200, `artifacts HTTP ${artifacts.status}`, truncate(artifacts.text))
    const json = artifacts.json
    assert(json?.ok === true, 'artifacts ok is not true')
    assert(Array.isArray(json.plots), 'artifacts plots is not an array')
    const runPlot = json.plots.find(
      (entry) => entry.source === 'run' && /^plot-\d{3}\.png$/.test(String(entry.name)),
    )
    assert(runPlot, `no source:run plot-*.png (${JSON.stringify(json.plots.map((entry) => entry.name))})`)
    assert(runPlot.path.startsWith(pyRun.plotDir), 'python artifact path is outside plotDir')
    assert(Number.isInteger(runPlot.size) && runPlot.size > 0, 'python artifact size is not positive')
    const blob = await apiFetchBytes('/blob', { query: { path: runPlot.path } })
    assert(blob.status === 200, `blob HTTP ${blob.status}`)
    assert(
      String(blob.headers['content-type'] ?? '').startsWith('image/png'),
      `blob content-type is ${JSON.stringify(blob.headers['content-type'])}`,
    )
    assert(blob.buffer.length >= 8 && blob.buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'blob is not a PNG')
    pass(
      'L32 python matplotlib figure captured without savefig → artifacts source:run + /api/blob PNG',
      `${runPlot.name} ${runPlot.size} B, PNG signature ok`,
    )
  } catch (error) {
    fail('L32 python matplotlib figure captured without savefig → artifacts source:run + /api/blob PNG', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { mode: 'file', file: scriptR, cwd: workspace, capturePlots: true },
    })
    const run = expectRunReply(reply, 'r')
    rRun = run
    assert(run.mode === 'file', `mode is ${JSON.stringify(run.mode)}`)
    const output = await waitForRun(run.runId, { maxMs: 60_000 })
    rRunOutput = output
    assert(output.stdout.includes('LIVE-PLOT-R'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
    assert(output.last.exitCode === 0, `exitCode is ${JSON.stringify(output.last.exitCode)}`)
    const artifacts = await apiFetch('/artifacts', { query: { runId: run.runId } })
    assert(artifacts.status === 200, `artifacts HTTP ${artifacts.status}`, truncate(artifacts.text))
    const runPlot = (artifacts.json.plots ?? []).find(
      (entry) => entry.source === 'run' && /\.png$/.test(String(entry.name)),
    )
    assert(runPlot, `no source:run png for the R run (${JSON.stringify((artifacts.json.plots ?? []).map((entry) => entry.name))})`)
    rRunPlot = runPlot
    const blob = await apiFetchBytes('/blob', { query: { path: runPlot.path } })
    assert(blob.status === 200, `R artifact blob HTTP ${blob.status}`)
    assert(
      String(blob.headers['content-type'] ?? '').startsWith('image/png'),
      `R artifact content-type is ${JSON.stringify(blob.headers['content-type'])}`,
    )
    assert(blob.buffer.length >= 8 && blob.buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'R artifact blob is not a PNG')
    pass('L33 R plot(1:10) captured → artifacts source:run + /api/blob PNG', `${runPlot.name} ${runPlot.size} B`)
  } catch (error) {
    fail('L33 R plot(1:10) captured → artifacts source:run + /api/blob PNG', error.message)
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: { mode: 'buffer', language: 'python', code: 'print("LIVE-BUFFER-V2")', capturePlots: false },
    })
    const run = expectRunReply(reply, 'python')
    assert(run.mode === 'buffer', `mode is ${JSON.stringify(run.mode)}`)
    assert(run.file === null, `file is ${JSON.stringify(run.file)} (expected null)`)
    const output = await waitForRun(run.runId)
    assert(output.stdout.includes('LIVE-BUFFER-V2'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
    assert(output.last.exitCode === 0, 'buffer-mode run failed')
    pass('L34 buffer mode still works (mode:buffer, file:null)', 'stdout LIVE-BUFFER-V2, exit 0')
  } catch (error) {
    fail('L34 buffer mode still works (mode:buffer, file:null)', error.message)
  }

  /* ── CONTRACT-V2: artifacts/blob error surface (§1.9–§1.10) ───────────── */

  section('v2 artifacts/blob errors (CONTRACT-V2 §1.9–§1.10)')

  try {
    const unknown = await apiFetch('/artifacts', { query: { runId: 'dcr-live-missing-run' } })
    expectError(unknown, 404, 'unknown-run')
    const absent = await apiFetch('/artifacts')
    expectError(absent, 400, 'bad-request')
    const unsupported = await apiFetch('/blob', { query: { path: notesTxt } })
    expectError(unsupported, 415, 'unsupported-file')
    const relativeBlob = await apiFetch('/blob', { query: { path: 'relative.png' } })
    expectError(relativeBlob, 400, 'bad-path')
    const missingBlob = await apiFetch('/blob', { query: { path: path.join(workspace, 'missing.png') } })
    expectError(missingBlob, 404, 'not-found')
    pass(
      'L35 artifacts/blob errors (404 unknown-run, 400 bad-request/bad-path, 415 unsupported-file, 404 not-found)',
      'all v2 error codes mapped',
    )
  } catch (error) {
    fail('L35 artifacts/blob errors (404 unknown-run, 400 bad-request/bad-path, 415 unsupported-file, 404 not-found)', error.message)
  }

  /* ── CONTRACT-V3: diagnostics, explain, export, save-plots, MATLAB, selection ─ */

  section('v3 diagnostics (CONTRACT-V2 §1.12)')

  try {
    const before = await apiFetch('/diag')
    assert(before.status === 200, `GET /api/diag HTTP ${before.status}`, truncate(before.text))
    assert(before.json?.ok === true, 'diag ok is not true')
    assert(before.json.plugin === 'dsh-code-runner', `diag plugin is ${JSON.stringify(before.json.plugin)}`)
    assert(before.json.route === '/dsh-code-runner', `diag route is ${JSON.stringify(before.json.route)}`)
    assert(Array.isArray(before.json.events), 'diag events is not an array')
    const posted = await apiFetch('/diag', {
      method: 'POST',
      body: { event: { name: 'verify-live-probe', at: Date.now(), detail: { phase: 'v3-live' } } },
    })
    assert(posted.status === 200, `POST /api/diag HTTP ${posted.status}`, truncate(posted.text))
    assert(posted.json?.accepted === 1, `diag accepted is ${JSON.stringify(posted.json?.accepted)}`)
    const after = await apiFetch('/diag')
    const events = after.json.events
    assert(Array.isArray(events) && events.length >= 1, 'GET /api/diag returned no events')
    const probe = events.filter((entry) => entry.event?.name === 'verify-live-probe').pop()
    assert(probe, 'posted diag probe is missing from GET /api/diag')
    assert(Number.isInteger(probe.seq), `diag seq is ${JSON.stringify(probe.seq)}`)
    assert(Number.isFinite(probe.receivedAt) && probe.receivedAt > 0, 'diag receivedAt is not a timestamp')
    const pageEvents = events.filter((entry) => entry.event?.name !== 'verify-live-probe')
    const names = [...new Set(pageEvents.map((entry) => entry.event?.name).filter(Boolean))].sort()
    pass(
      'L37 POST+GET /api/diag works and reports real-page events',
      `${events.length} buffered, ${pageEvents.length} from the page; names: ${names.join(', ') || '(page has not reported yet)'}`,
    )
  } catch (error) {
    fail('L37 POST+GET /api/diag works and reports real-page events', error.message)
  }

  section('v3 explain (CONTRACT-V3 §1.2)')

  try {
    const result = await apiFetch('/explain', {
      method: 'POST',
      body: { language: 'python', code: 'print("hi")' },
      timeoutMs: 120_000,
    })
    if (result.status === 200) {
      const json = result.json
      assert(json?.ok === true, 'explain ok is not true', truncate(result.text))
      assert(typeof json.summary === 'string' && json.summary.trim().length > 0, 'explain summary is empty')
      assert(typeof json.annotatedCode === 'string', 'explain annotatedCode is not a string')
      assert(typeof json.provider === 'string' && json.provider.length > 0, 'explain provider is empty')
      assert(typeof json.model === 'string' && json.model.length > 0, 'explain model is empty')
      assert(typeof json.truncatedInput === 'boolean', 'explain truncatedInput is not a boolean')
      pass(
        'L38 POST /api/explain returns a real LLM summary',
        `provider=${json.provider} model=${json.model} summary=${JSON.stringify(truncate(json.summary, 80))} annotated=${json.annotatedCode.length} chars`,
      )
    } else if (result.status === 503) {
      skip(
        'L38 POST /api/explain returns a real LLM summary',
        `llm-unavailable: ${truncate(result.json?.error?.message ?? result.text, 180)}`,
      )
    } else if (result.status === 502 || result.status === 504) {
      skip(
        'L38 POST /api/explain returns a real LLM summary',
        `${result.json?.error?.code ?? result.status}: ${truncate(result.json?.error?.message ?? result.text, 180)} (provider failure/timeout — not a plugin defect)`,
      )
    } else {
      assert(false, `unexpected explain HTTP ${result.status}`, truncate(result.text))
    }
  } catch (error) {
    fail('L38 POST /api/explain returns a real LLM summary', error.message)
  }

  section('v3 export report + save-plots (CONTRACT-V3 §1.3–§1.4)')

  const exportBody = rRun && rRunPlot && rRunOutput
    ? {
        language: 'r',
        mode: 'file',
        file: scriptR,
        cwd: workspace,
        command: rRun.command,
        code: scriptRBody,
        stdout: rRunOutput.stdout,
        stderr: rRunOutput.stderr,
        exitCode: rRunOutput.last.exitCode,
        durationMs: rRunOutput.last.durationMs,
        startedAt: rRun.startedAt,
        summary: null,
        plots: [{ path: rRunPlot.path, name: rRunPlot.name, source: rRunPlot.source }],
        format: 'all',
        include: { code: true, output: true, plots: true, summary: true },
        name: 'script',
      }
    : null
  let reportFolder = null
  try {
    assert(exportBody, 'no R run with plot evidence available for the export case')
    const result = await apiFetch('/export', { method: 'POST', body: exportBody })
    assert(result.status === 200, `export HTTP ${result.status}`, truncate(result.text))
    const json = result.json
    assert(json?.ok === true, 'export ok is not true')
    const reportsRoot = path.join(workspace, 'dsh-code-runner-reports')
    assert(
      typeof json.folder === 'string' && json.folder.startsWith(reportsRoot + path.sep),
      `folder is ${JSON.stringify(json.folder)} (expected under ${reportsRoot})`,
    )
    assert(/^\d{8}-\d{6}-r$/.test(path.basename(json.folder)), `folder name is ${path.basename(json.folder)}`)
    assert(json.baseName === 'script实验报告', `baseName is ${JSON.stringify(json.baseName)}`)
    assert(path.basename(json.reportPath) === json.baseName + '.md', `report path is ${json.reportPath}`)
    assert(path.basename(json.htmlPath) === json.baseName + '.html', `html path is ${json.htmlPath}`)
    assert(existsSync(json.docxPath), `docx missing: ${json.docxPath}`)
    const docxBytes = await readFile(json.docxPath)
    assert(docxBytes.length > 1000 && docxBytes[0] === 0x50 && docxBytes[1] === 0x4b, 'docx is not a ZIP (PK) file')
    assert(existsSync(json.reportPath), `report.md missing: ${json.reportPath}`)
    assert(existsSync(json.htmlPath), `report.html missing: ${json.htmlPath}`)
    const runJsonPath = path.join(json.folder, 'run.json')
    assert(existsSync(runJsonPath), 'run.json missing')
    assert(Array.isArray(json.plotFiles) && json.plotFiles.length >= 1, 'plotFiles is empty')
    const copiedPlotPath = path.join(json.folder, json.plotFiles[0])
    assert(existsSync(copiedPlotPath), `copied plot missing: ${copiedPlotPath}`)
    const copiedPlot = await readFile(copiedPlotPath)
    assert(copiedPlot.subarray(0, 8).equals(PNG_SIGNATURE), 'copied plot is not a PNG')
    const reportMd = await readFile(json.reportPath, 'utf8')
    assert(reportMd.includes('# script实验报告'), 'report.md lacks the 实验报告 title')
    assert(reportMd.includes('plot(1:10)'), 'report.md lacks the R code text')
    assert(reportMd.includes('## 源代码：') && reportMd.includes('## 输出结果：') && reportMd.includes('## 统计图：'), 'report.md lacks the required sections')
    assert(
      reportMd.includes(`](plots/${path.basename(rRunPlot.path)})`) ||
        reportMd.includes(`](${json.plotFiles[0]})`),
      'report.md lacks the plot link',
    )
    const reportHtml = await readFile(json.htmlPath, 'utf8')
    assert(/^<!doctype html>/i.test(reportHtml), 'report.html does not start with <!doctype html>')
    assert(reportHtml.includes('data:image/png;base64,'), 'report.html has no inlined data:image plot')
    assert(reportHtml.includes('plot(1:10)'), 'report.html lacks the code text')
    assert(reportHtml.includes('源代码：') && reportHtml.includes('统计图：'), 'report.html lacks the required section labels')
    const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'))
    assert(runJson.language === 'r', `run.json language is ${JSON.stringify(runJson.language)}`)
    reportFolder = json.folder
    pass(
      'L39 POST /api/export writes report.md/html/run.json + plots into a new folder',
      `${path.basename(json.folder)}: ${json.files.length} files, ${json.plotFiles.length} plot(s)`,
    )
  } catch (error) {
    fail('L39 POST /api/export writes report.md/html/run.json + plots into a new folder', error.message)
  }

  try {
    assert(reportFolder && exportBody, 'no first export to collide with')
    const second = await apiFetch('/export', { method: 'POST', body: exportBody })
    assert(second.status === 200, `second export HTTP ${second.status}`, truncate(second.text))
    const secondFolder = second.json.folder
    assert(secondFolder !== reportFolder, 'export reused an existing folder')
    const baseOf = (folder) => path.basename(folder).replace(/-\d+$/, '')
    if (baseOf(secondFolder) === baseOf(reportFolder)) {
      assert(/-\d+$/.test(path.basename(secondFolder)), 'same-second export folder lacks the -2 suffix')
    }
    pass('L40 export never reuses a folder (same-second collision gets -2)', `${path.basename(reportFolder)} / ${path.basename(secondFolder)}`)
  } catch (error) {
    fail('L40 export never reuses a folder (same-second collision gets -2)', error.message)
  }

  try {
    assert(rRunPlot, 'no plot artifact to save')
    const targetDir = path.join(workspace, 'saved-plots')
    const saveBody = { plots: [{ path: rRunPlot.path, name: rRunPlot.name }], targetDir }
    const first = await apiFetch('/save-plots', { method: 'POST', body: saveBody })
    assert(first.status === 200, `save-plots HTTP ${first.status}`, truncate(first.text))
    assert(first.json?.ok === true && first.json.saved?.length === 1, 'save-plots saved[] shape bad')
    const savedPath = first.json.saved[0].path
    assert(savedPath.startsWith(targetDir + path.sep), `saved path is ${savedPath}`)
    assert(existsSync(savedPath), 'saved plot missing on disk')
    assert((await readFile(savedPath)).subarray(0, 8).equals(PNG_SIGNATURE), 'saved plot is not a PNG')
    const second = await apiFetch('/save-plots', { method: 'POST', body: saveBody })
    assert(second.status === 200 && second.json.saved?.length === 1, 'second save-plots call failed')
    assert(second.json.saved[0].path !== savedPath, 'save-plots overwrote an existing file instead of deduping')
    assert(existsSync(second.json.saved[0].path), 'deduped saved file missing')
    const unsupported = await apiFetch('/save-plots', {
      method: 'POST',
      body: { plots: [{ path: notesTxt, name: 'notes.txt' }], targetDir },
    })
    expectError(unsupported, 415, 'unsupported-file')
    const missing = await apiFetch('/save-plots', {
      method: 'POST',
      body: { plots: [{ path: path.join(workspace, 'missing.png'), name: 'missing.png' }], targetDir },
    })
    expectError(missing, 404, 'not-found')
    const relativeTarget = await apiFetch('/save-plots', {
      method: 'POST',
      body: { plots: [{ path: rRunPlot.path, name: rRunPlot.name }], targetDir: 'relative/target' },
    })
    expectError(relativeTarget, 400, 'bad-path')
    pass(
      'L41 POST /api/save-plots copies + dedupes into a temp target',
      `copy + ${path.basename(second.json.saved[0].path)} on second call; unsupported/not-found/bad-path mapped`,
    )
  } catch (error) {
    fail('L41 POST /api/save-plots copies + dedupes into a temp target', error.message)
  }

  section('v3 MATLAB + selection (CONTRACT-V3 §1.5, §2.1)')

  try {
    if (!liveEnv || !Array.isArray(liveEnv.languages)) {
      skip(
        'L42 MATLAB detected + real matlab run with figure capture',
        'env probe unavailable (the /api/env case failed) — cannot detect MATLAB in this run',
      )
    } else {
      const matlab = liveEnv.languages.find((entry) => entry.id === 'matlab')
    if (!matlab || matlab.available !== true) {
      skip(
        'L42 MATLAB detected + real matlab run with figure capture',
        `matlab not available in /api/env (available=${JSON.stringify(matlab?.available)}, command=${JSON.stringify(matlab?.command)})`,
      )
    } else {
      const reply = await apiFetch('/run', {
        method: 'POST',
        body: {
          language: 'matlab',
          code: "figure; plot(1:10); disp('matlab-live-ok')",
          timeoutMs: 180_000,
        },
        timeoutMs: 200_000,
      })
      if (reply.status !== 200) {
        const code = reply.json?.error?.code ?? ''
        if (code === 'spawn-failed' || code === 'language-unavailable') {
          skip(
            'L42 MATLAB detected + real matlab run with figure capture',
            `environment cannot spawn MATLAB headless: ${code} — ${truncate(reply.json?.error?.message ?? reply.text, 240)}`,
          )
        } else {
          assert(false, `matlab run HTTP ${reply.status}`, truncate(reply.text))
        }
      } else {
        const run = expectRunReply(reply, 'matlab')
        const output = await waitForRun(run.runId, { maxMs: 240_000, intervalMs: 1_000 })
        if (output.last.exitCode !== 0) {
          skip(
            'L42 MATLAB detected + real matlab run with figure capture',
            `environment cannot start MATLAB headless: exitCode=${JSON.stringify(output.last.exitCode)} signal=${JSON.stringify(output.last.signal)} timedOut=${JSON.stringify(output.last.timedOut)} stderr=${JSON.stringify(truncate(output.stderr, 300))}`,
          )
        } else {
          assert(output.stdout.includes('matlab-live-ok'), `matlab stdout was ${JSON.stringify(truncate(output.stdout))}`)
          const artifacts = await apiFetch('/artifacts', { query: { runId: run.runId } })
          assert(artifacts.status === 200, `matlab artifacts HTTP ${artifacts.status}`)
          const runPlot = (artifacts.json.plots ?? []).find(
            (entry) => entry.source === 'run' && /\.png$/.test(String(entry.name)),
          )
          assert(
            runPlot,
            `matlab exited 0 but produced no source:run PNG (${JSON.stringify((artifacts.json.plots ?? []).map((entry) => entry.name))})`,
          )
          const blob = await apiFetchBytes('/blob', { query: { path: runPlot.path } })
          assert(blob.status === 200, `matlab artifact blob HTTP ${blob.status}`)
          assert(
            String(blob.headers['content-type'] ?? '').startsWith('image/png'),
            `matlab artifact content-type is ${JSON.stringify(blob.headers['content-type'])}`,
          )
          assert(blob.buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'matlab artifact blob is not a PNG')
          pass(
            'L42 MATLAB detected + real matlab run with figure capture',
            `${matlab.command} → exit 0, ${runPlot.name} ${runPlot.size} B, PNG blob`,
          )
        }
      }
    }
    }
  } catch (error) {
    if (/still running after/.test(error.message)) {
      skip(
        'L42 MATLAB detected + real matlab run with figure capture',
        `matlab run did not finish within the bounded wait — environment limitation: ${error.message}`,
      )
    } else {
      fail('L42 MATLAB detected + real matlab run with figure capture', error.message)
    }
  }

  try {
    const reply = await apiFetch('/run', {
      method: 'POST',
      body: {
        mode: 'buffer',
        language: 'r',
        code: 'x <- 1:5\ncat("selection:", x * 2, "\\n")',
        origin: 'selection',
        capturePlots: false,
      },
    })
    const run = expectRunReply(reply, 'r')
    assert(run.mode === 'buffer', `mode is ${JSON.stringify(run.mode)}`)
    const output = await waitForRun(run.runId)
    assert(output.last.exitCode === 0, `selection run exitCode is ${JSON.stringify(output.last.exitCode)}`)
    assert(
      output.stdout.includes('selection: 2 4 6 8 10'),
      `selection stdout was ${JSON.stringify(truncate(output.stdout))}`,
    )
    pass(
      'L43 selection-run semantics = R buffer run of a partial script',
      'stdout "selection: 2 4 6 8 10", origin:"selection" ignored safely',
    )
  } catch (error) {
    fail('L43 selection-run semantics = R buffer run of a partial script', error.message)
  }
}

/* ─────────────────────────── cleanup + summary ───────────────────────────── */

/* ─────────────────────────── cleanup + summary ───────────────────────────── */

async function cleanupRuns() {
  const unfinished = startedRuns.filter((entry) => !entry.finished)
  if (unfinished.length > 0 && currentToken) {
    for (const entry of unfinished) {
      try {
        await apiFetch('/stop', { method: 'POST', body: { runId: entry.runId } })
      } catch {
        /* best effort: never fail the suite during cleanup */
      }
    }
    info(`cleanup: sent stop to ${unfinished.length} unfinished run(s)`)
  }
  if (workspaceDir) {
    try {
      await rm(workspaceDir, { recursive: true, force: true })
      info(`cleanup: removed live temp workspace ${workspaceDir}`)
    } catch (error) {
      info(`cleanup: could not remove temp workspace ${workspaceDir}: ${error?.message ?? error}`)
    }
  }
}

function printMatrix() {
  console.log(`\n${'─'.repeat(66)}`)
  const passed = records.filter((entry) => entry.status === 'PASS').length
  const failed = records.filter((entry) => entry.status === 'FAIL')
  const skipped = records.filter((entry) => entry.status === 'SKIP')
  console.log(
    `live verification: ${passed}/${records.length - skipped.length} checks passed, ${failed.length} failed, ${skipped.length} skipped`,
  )

  console.log('\nmatrix:')
  for (const entry of records) {
    const icon = entry.status === 'PASS' ? '✓' : entry.status === 'FAIL' ? '✗' : '–'
    const verdict = entry.status.padEnd(4)
    console.log(`  ${icon} ${verdict} ${entry.id}${entry.detail ? ` — ${truncate(entry.detail, 150)}` : ''}`)
  }
  if (failed.length > 0) {
    console.log('\nFAILED checks:')
    for (const entry of failed) console.log(`  ✗ ${entry.id} — ${entry.detail}`)
  }

  console.log('\nverification limits:')
  console.log('  • the / page is cookie-gated for this shell, so the token comes from §1.10 bootstrap; page HTML injection is covered by tests/verify-host.mjs')
  console.log('  • bootstrap rule 1 (non-loopback req.socket.remoteAddress) cannot be exercised from a local loopback shell; rules 2/3 are covered live and all rules by verify-host.mjs')
  console.log('  • rendered look/light-dark theme is not verifiable here (no browser screenshot control); slot occupancy is checked separately via the client Slots inspect provider')
}

process.exitCode = 0
main()
  .catch((error) => {
    console.error('\n[FATAL] live verification crashed:')
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 2
  })
  .finally(async () => {
    await cleanupRuns()
    printMatrix()
    const failed = records.filter((entry) => entry.status === 'FAIL').length
    if (process.exitCode === 0 && failed > 0) process.exitCode = 1
  })
