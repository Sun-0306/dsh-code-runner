#!/usr/bin/env node
/**
 * dsh-code-runner — Host-half smoke test (self-contained, no dependencies).
 *
 * Imports ../index.js, builds a stub Cordis context whose `subprocess` service is
 * backed by node:child_process (faithful collect/readFrom byte-offset contract) and
 * whose `webServer` captures the registered prefix route + index transform, then
 * drives the real handler with fake req/res objects.
 *
 * Covers the v1 matrix (auth, env, buffer runs, output offsets, stop, retention,
 * origin rules, disposal) plus the v2 surface: file-mode runs, plot capture
 * (matplotlib + R png device), files/file-save/blob/artifacts endpoints.
 *
 * Run with: node tests/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildXlsx, DEFAULT_SHEETS } from './dataset-fixtures.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const TMP_ROOT = path.join(os.tmpdir(), 'dsh-code-runner')
// CONTRACT-V5: pack settings + installed capture helpers live under the DSH home
// by default; the smoke test isolates them so it never touches the real profile.
const SMOKE_STATE_DIR = path.join(os.tmpdir(), 'dsh-code-runner-smoke-state-' + process.pid)
process.env.DSH_CODE_RUNNER_STATE_DIR = SMOKE_STATE_DIR
try { fs.rmSync(SMOKE_STATE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
// Run directories a *live* installed plugin already retains in the shared temp
// root. This suite must never require those to disappear: the plugin's cleanup is
// a deliberately non-recursive rmdir so a parallel/reloaded instance's runs survive.
const FOREIGN_TMP_ENTRIES = new Set(fs.existsSync(TMP_ROOT) ? fs.readdirSync(TMP_ROOT) : [])
// Scratch space for the file/file-mode/blob cases; matplotlib gets a writable cache.
const SMOKE_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-code-runner-smoke-'))
process.env.MPLCONFIGDIR = path.join(SMOKE_ROOT, 'mpl-cache')
await fsp.mkdir(process.env.MPLCONFIGDIR, { recursive: true })

const ORIGIN = 'http://127.0.0.1:57598'
// 1×1 PNG used by the v6 export-placement cases.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const DEFAULT_HOST = '127.0.0.1:57598'

const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href)

/* ── Contract field-name sets (CONTRACT.md §1.4–1.9, V2 §1.2–1.10) ────────── */

const sorted = (values) => [...values].sort()
const ENV_KEYS = sorted(['ok', 'platform', 'defaultCwd', 'tmpRoot', 'limits', 'languages'])
const LIMIT_KEYS = sorted([
  'codeMaxBytes',
  'outputMaxBytes',
  'defaultTimeoutMs',
  'maxTimeoutMs',
  'fileMaxBytes',
  'blobMaxBytes',
  'artifactMax',
  'explainMaxChars',
])
const LANGUAGE_KEYS = sorted(['id', 'label', 'available', 'command', 'version', 'template', 'extensions'])
const RUN_KEYS = sorted([
  'ok',
  'runId',
  'language',
  'command',
  'scriptPath',
  'cwd',
  'startedAt',
  'timeoutMs',
  // v2 additions (CONTRACT-V2.md §1.4)
  'mode',
  'file',
  'capturePlots',
  'plotDir',
])
const OUTPUT_KEYS = sorted([
  'ok',
  'runId',
  'language',
  'command',
  'scriptPath',
  'cwd',
  'startedAt',
  'running',
  'exitCode',
  'signal',
  'durationMs',
  'timedOut',
  'stopped',
  'stdout',
  'stderr',
  // v2 additions (CONTRACT-V2.md §1.5)
  'mode',
  'file',
  'capturePlots',
  'plotDir',
])
const STREAM_KEYS = sorted(['text', 'nextOffset', 'lossy'])
const STOP_KEYS = sorted(['ok', 'runId', 'stopped', 'running'])
const ERROR_KEYS = sorted(['ok', 'error'])
const FILES_KEYS = sorted(['ok', 'dir', 'parent', 'entries', 'truncated'])
const FILE_ENTRY_KEYS = sorted(['name', 'path', 'isDir', 'size', 'mtimeMs', 'ext'])
const FILE_READ_KEYS = sorted(['ok', 'path', 'text', 'size', 'mtimeMs', 'ext', 'truncated', 'binary'])
const FILE_SAVE_KEYS = sorted(['ok', 'path', 'size', 'mtimeMs', 'ext'])
const ARTIFACTS_KEYS = sorted(['ok', 'runId', 'running', 'plotDir', 'plots', 'truncated'])
const ARTIFACT_ITEM_KEYS = sorted(['path', 'name', 'source', 'size', 'mtimeMs', 'ext'])
const CONFLICT_KEYS = sorted(['ok', 'error', 'currentMtimeMs', 'size'])

const LIMIT = Object.freeze({
  codeMaxBytes: 1048576,
  outputMaxBytes: 2097152,
  defaultTimeoutMs: 300000,
  maxTimeoutMs: 1800000,
  fileMaxBytes: 1048576,
  blobMaxBytes: 16777216,
  artifactMax: 40,
  explainMaxChars: 20000,
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Smallest valid 1x1 PNG, used by the cwd-artifact and blob cases.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// CONTRACT-V2.md §1.3.1: reference saver content, verbatim (the approved D1
// workaround is appended after this block by the Host).
const PYTHON_SITECUSTOMIZE_PREFIX = `# dsh-code-runner: save open matplotlib figures for the panel's Plots tab.
import atexit
import os


def _dsh_code_runner_save():
    try:
        import sys

        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is None:
            return
        out = os.environ.get("DSH_CODE_RUNNER_PLOTS_DIR")
        if not out:
            return
        numbers = list(pyplot.get_fignums())
        if not numbers:
            return
        os.makedirs(out, exist_ok=True)
        for index, number in enumerate(numbers, start=1):
            pyplot.figure(number).savefig(
                os.path.join(out, "plot-%03d.png" % index),
                dpi=144,
                bbox_inches="tight",
            )
    except Exception:
        pass


atexit.register(_dsh_code_runner_save)
`

// CONTRACT-V2.md §1.3.2: the R wrapper content is mandated byte-for-byte.
const R_PLOT_WRAPPER_EXPECTED = `# dsh-code-runner: open a png device so plots are captured for the panel.
script <- Sys.getenv("DSH_CODE_RUNNER_SCRIPT")
outdir <- Sys.getenv("DSH_CODE_RUNNER_PLOTS_DIR")
if (!nzchar(script) || !nzchar(outdir)) {
  stop("dsh-code-runner: missing runner environment")
}
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)
grDevices::png(filename = file.path(outdir, "plot-%03d.png"), width = 1400, height = 1000, res = 144)
on.exit(try(grDevices::dev.off(), silent = TRUE), add = TRUE)
source(script, echo = FALSE, print.eval = TRUE)
`

function writeFile(filePath, content, options) {
  return fsp.writeFile(filePath, content, options)
}

async function writeFiles(dirPath, count, prefix = 'f') {
  await fsp.mkdir(dirPath, { recursive: true })
  const width = String(count - 1).length
  const batch = 200
  for (let start = 0; start < count; start += batch) {
    const writes = []
    for (let index = start; index < Math.min(count, start + batch); index += 1) {
      const name = `${prefix}${String(index).padStart(width, '0')}.txt`
      writes.push(writeFile(path.join(dirPath, name), `content ${index}\n`))
    }
    await Promise.all(writes)
  }
}

/* ── Subprocess stub (node:child_process + collect readers) ────────────────── */

/**
 * Collect reader with the provider contract:
 *   collected.stdout.readFrom(fromByte) → { text, nextOffset, lossy }
 * Offsets are absolute byte positions; reads are non-consuming.
 */
function createCollector(mode) {
  const config = mode && typeof mode === 'object' ? mode : {}
  const maxBytes = Number.isFinite(config.maxBytes) ? config.maxBytes : Number.POSITIVE_INFINITY
  let retained = []
  let retainedBytes = 0
  let totalBytes = 0
  let lossy = false

  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      totalBytes += buffer.length
      if (retainedBytes >= maxBytes) {
        lossy = true
        return
      }
      const room = maxBytes - retainedBytes
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
      retained.push(Buffer.from(slice))
      retainedBytes += slice.length
      if (slice.length < buffer.length) lossy = true
    },
    readFrom(fromByte) {
      const from = Number.isInteger(fromByte) && fromByte >= 0 ? fromByte : 0
      if (from >= totalBytes) return { text: '', nextOffset: from, lossy }
      const all = Buffer.concat(retained)
      // This stub retains the first maxBytes bytes; that is enough for the smoke
      // test, and readFrom is still Buffer/byte based, never string-index based.
      const text = all.subarray(from, all.length).toString('utf8')
      return { text, nextOffset: totalBytes, lossy }
    },
  }
}

function createSubprocessStub(tracker) {
  async function resolveExecutable(command, env) {
    const pathValue = env && typeof env.PATH === 'string' ? env.PATH : (process.env.PATH ?? '')
    if (command.includes('/')) {
      fs.accessSync(command, fs.constants.X_OK)
      return command
    }
    for (const dir of String(pathValue).split(path.delimiter)) {
      if (!dir) continue
      const candidate = path.join(dir, command)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        /* next directory */
      }
    }
    throw new Error(`executable not found: ${command}`)
  }

  function spawn(options) {
    const { argv, cwd, stdio = {}, env = process.env, graceMs = 2000 } = options ?? {}
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('stub spawn: argv is required')
    const [file, ...args] = argv

    const stdinConfig = stdio.stdin ?? 'ignore'
    const stdoutConfig = stdio.stdout ?? 'inherit'
    const stderrConfig = stdio.stderr ?? 'inherit'
    const pipeMode = (config) => (config === 'inherit' || config === 'ignore' ? config : 'pipe')

    const child = spawnChild(file, args, {
      cwd,
      env,
      stdio: [stdinConfig === 'ignore' ? 'ignore' : 'pipe', pipeMode(stdoutConfig), pipeMode(stderrConfig)],
    })
    tracker.children.add(child)

    const stdoutCollector = pipeMode(stdoutConfig) === 'pipe' ? createCollector(stdoutConfig) : null
    const stderrCollector = pipeMode(stderrConfig) === 'pipe' ? createCollector(stderrConfig) : null
    if (child.stdout && stdoutCollector) child.stdout.on('data', (chunk) => stdoutCollector.append(chunk))
    if (child.stderr && stderrCollector) child.stderr.on('data', (chunk) => stderrCollector.append(chunk))

    if (stdinConfig && typeof stdinConfig === 'object' && typeof stdinConfig.data === 'string') {
      child.stdin?.on('error', () => {})
      child.stdin?.write(stdinConfig.data)
      child.stdin?.end()
    } else if (child.stdin) {
      child.stdin.on('error', () => {})
    }

    let graceTimer = null
    const done = new Promise((resolve) => {
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
        tracker.children.delete(child)
        resolve(result)
      }
      child.once('error', (error) => settle({ exitCode: null, signal: null, error }))
      child.once('close', (code, signal) =>
        settle({ exitCode: typeof code === 'number' ? code : null, signal: signal ?? null }),
      )
    })

    return {
      stdin: child.stdin ?? null,
      stdout: child.stdout ?? null,
      stderr: child.stderr ?? null,
      control: null,
      collected: {
        ...(stdoutCollector ? { stdout: stdoutCollector } : {}),
        ...(stderrCollector ? { stderr: stderrCollector } : {}),
      },
      done,
      terminate() {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        if (graceMs > 0) {
          graceTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
          }, graceMs)
          graceTimer.unref?.()
        }
      },
      waitForExit() {
        return done
      },
    }
  }

  return { resolveExecutable, spawn }
}

/* ── Stub Cordis context ───────────────────────────────────────────────────── */

function createStubContext() {
  const state = {
    registrations: [],
    transforms: [],
    disposers: [],
    spawnOptions: [],
    children: new Set(),
    disposed: false,
  }
  const subprocessStub = createSubprocessStub(state)

  const webServer = {
    register(options) {
      state.registrations.push(options)
      return () => {
        const index = state.registrations.indexOf(options)
        if (index >= 0) state.registrations.splice(index, 1)
      }
    },
    tapIndex(transform) {
      state.transforms.push(transform)
      return () => {
        const index = state.transforms.indexOf(transform)
        if (index >= 0) state.transforms.splice(index, 1)
      }
    },
    getOrigin() {
      return ORIGIN
    },
  }

  const subprocess = {
    resolveExecutable: subprocessStub.resolveExecutable,
    spawn(options) {
      state.spawnOptions.push(options)
      return subprocessStub.spawn(options)
    },
  }

  const ctx = {
    webServer,
    subprocess,
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return disposer
    },
    get() {
      return undefined
    },
    on() {},
    emit() {},
  }

  return {
    ctx,
    state,
    dispose() {
      if (state.disposed) return
      state.disposed = true
      for (const disposer of [...state.disposers].reverse()) disposer()
    },
  }
}

/* ── Fake HTTP req/res ─────────────────────────────────────────────────────── */

function makeReq({ method, url, headers = {}, body, remoteAddress = '127.0.0.1' }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  for (const [name, value] of Object.entries(headers)) req.headers[name.toLowerCase()] = value
  req.socket = { remoteAddress }
  if (body !== undefined) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    process.nextTick(() => {
      req.emit('data', buffer)
      req.emit('end')
    })
  } else {
    process.nextTick(() => req.emit('end'))
  }
  return req
}

function makeRes() {
  let resolveFinished
  const finished = new Promise((resolve) => {
    resolveFinished = resolve
  })
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    body: '',
    bodyBuffer: Buffer.alloc(0),
    headersSent: false,
    writableEnded: false,
    finished,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()]
    },
    removeHeader(name) {
      delete this.headers[String(name).toLowerCase()]
    },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [name, value] of Object.entries(headers)) {
        this.headers[String(name).toLowerCase()] = String(value)
      }
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.bodyBuffer = Buffer.concat(chunks)
      this.body = this.bodyBuffer.toString('utf8')
      this.writableEnded = true
      this.headersSent = true
      resolveFinished()
      return this
    },
  }
}

/* ── Test plumbing ─────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

async function runCase(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    const detail = String((error && error.stack) || error)
    console.log(`FAIL  ${name}\n      ${detail.split('\n').join('\n      ')}`)
  }
}

const stub = createStubContext()
plugin.apply(stub.ctx)

const route = stub.state.registrations.find((entry) => entry.kind === 'prefix')
const transform = stub.state.transforms[0]

let token = null
let envPayload = null
const scriptDirs = new Set()
const scriptDirsRunIds = new Set()

async function call({ method, path: urlPath, token: headerToken, origin, headers = {}, body, remoteAddress }) {
  assert.ok(route && typeof route.handler === 'function', 'prefix route was registered')
  const reqHeaders = { host: DEFAULT_HOST, ...headers }
  if (headerToken !== undefined && headerToken !== null) reqHeaders['x-dsh-code-runner-token'] = headerToken
  if (origin !== undefined) reqHeaders.origin = origin
  const req = makeReq({ method, url: urlPath, headers: reqHeaders, body, remoteAddress })
  const res = makeRes()
  let threw = null
  try {
    await route.handler(req, res)
  } catch (error) {
    threw = error
  }
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* plain body (raw blob) */
  }
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    bodyBuffer: res.bodyBuffer,
    json,
    threw,
  }
}

function assertErrorEnvelope(response, status, code, extraKeys = []) {
  assert.equal(response.threw, null, 'handler must never throw')
  assert.equal(response.status, status, `expected HTTP ${status}, got ${response.status}: ${response.body}`)
  assert.deepEqual(Object.keys(response.json ?? {}).sort(), sorted(['ok', 'error', ...extraKeys]))
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, code)
  assert.equal(typeof response.json.error.message, 'string')
}

async function startRun(requestBody) {
  const response = await call({ method: 'POST', path: '/dsh-code-runner/api/run', token, body: requestBody })
  assert.equal(response.threw, null, 'handler must never throw')
  assert.equal(response.status, 200, `run failed: ${response.status} ${response.body}`)
  const run = response.json
  assert.deepEqual(Object.keys(run).sort(), RUN_KEYS, 'CONTRACT-V2 §1.4 run response field names')
  assert.equal(run.ok, true)
  assert.ok(typeof run.runId === 'string' && run.runId.length > 0)
  assert.ok(path.isAbsolute(run.scriptPath))
  assert.ok(path.isAbsolute(run.plotDir))
  assert.equal(typeof run.capturePlots, 'boolean')
  assert.ok(run.mode === 'buffer' || run.mode === 'file')
  // The run directory always lives under the shared temp root (plots included).
  const runDir = path.dirname(run.plotDir)
  assert.equal(path.dirname(runDir), TMP_ROOT)
  assert.equal(run.plotDir, path.join(runDir, 'plots'))
  scriptDirs.add(runDir)
  scriptDirsRunIds.add(run.runId)
  return run
}

/**
 * Poll GET /api/output with the returned byte offsets until the run finishes.
 * Asserts the §1.8 JSON field names on every poll, like the browser half does.
 */
async function waitForRun(runId, { maxMs = 15000 } = {}) {
  let stdout = ''
  let stderr = ''
  let stdoutFrom = 0
  let stderrFrom = 0
  let last = null
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const response = await call({
      method: 'GET',
      path: `/dsh-code-runner/api/output?runId=${encodeURIComponent(runId)}&stdoutFrom=${stdoutFrom}&stderrFrom=${stderrFrom}`,
      token,
    })
    assert.equal(response.threw, null, 'handler must never throw')
    assert.equal(response.status, 200, response.body)
    const payload = response.json
    assert.deepEqual(Object.keys(payload).sort(), OUTPUT_KEYS, '§1.8 output response field names')
    assert.deepEqual(Object.keys(payload.stdout).sort(), STREAM_KEYS, 'stdout stream field names')
    assert.deepEqual(Object.keys(payload.stderr).sort(), STREAM_KEYS, 'stderr stream field names')
    assert.equal(payload.runId, runId)
    assert.equal(typeof payload.running, 'boolean')
    assert.equal(payload.timedOut, false)
    assert.equal(typeof payload.stopped, 'boolean')
    // v2 echoes (CONTRACT-V2.md §1.5)
    assert.ok(payload.mode === 'buffer' || payload.mode === 'file')
    assert.ok(payload.file === null || typeof payload.file === 'string')
    assert.ok(path.isAbsolute(payload.plotDir))
    assert.equal(typeof payload.capturePlots, 'boolean')
    assert.ok(Number.isInteger(payload.stdout.nextOffset))
    assert.ok(Number.isInteger(payload.stderr.nextOffset))
    stdout += payload.stdout.text
    stderr += payload.stderr.text
    stdoutFrom = payload.stdout.nextOffset
    stderrFrom = payload.stderr.nextOffset
    last = payload
    if (!payload.running) break
    await sleep(25)
  }
  assert.ok(last && last.running === false, `run ${runId} did not finish within ${maxMs}ms`)
  return { stdout, stderr, result: last, stdoutFrom, stderrFrom }
}

/* ── 1. Page injection + token extraction ──────────────────────────────────── */

await runCase('page injection: window.__DSH_CODE_RUNNER__ script injected before </head>', async () => {
  assert.ok(route, 'webServer.register({kind:"prefix"}) was called')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-code-runner')
  assert.equal(typeof transform, 'function', 'webServer.tapIndex was called')

  const samplePage =
    '<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body><div id="root"></div></body></html>'
  const output = transform(samplePage)
  const match =
    /<script>window\.__DSH_CODE_RUNNER__=(\{"token":"([0-9a-f]+)"\});<\/script>/.exec(output)
  assert.ok(match, `token script missing from injected page: ${output.slice(0, 240)}`)
  token = JSON.parse(match[1]).token
  assert.match(token, /^[0-9a-f]{48}$/, 'token is 24 random bytes as hex')
  assert.equal(output.replace(match[0], ''), samplePage, 'exactly one script was injected')
  assert.ok(output.indexOf(match[0]) < output.indexOf('</head>'), 'script sits before </head>')

  // No </head> → injected at the start of the document.
  const noHead = '<html><body>hello</body></html>'
  const injected = transform(noHead)
  assert.ok(injected.startsWith('<script>window.__DSH_CODE_RUNNER__='), 'prepended without a </head>')
  assert.ok(injected.endsWith(noHead), 'document body preserved')
})

/* ── 2. Token gate (existing routes) ───────────────────────────────────────── */

await runCase('auth: GET /api/env without token → 401 unauthorized', async () => {
  const response = await call({ method: 'GET', path: '/dsh-code-runner/api/env' })
  assertErrorEnvelope(response, 401, 'unauthorized')
  assert.equal(response.json.error.message, 'missing or invalid host token — reload the page')
})

await runCase('auth: wrong token header → 401 unauthorized', async () => {
  const response = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token: crypto.randomBytes(24).toString('hex'),
  })
  assertErrorEnvelope(response, 401, 'unauthorized')
})

await runCase('auth: POST /api/run without token → 401 unauthorized (no process spawned)', async () => {
  const spawnedBefore = stub.state.spawnOptions.length
  const response = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/run',
    body: { language: 'python', code: 'print(1)' },
  })
  assertErrorEnvelope(response, 401, 'unauthorized')
  assert.equal(stub.state.spawnOptions.length, spawnedBefore, 'the token gate runs before any spawn')
})

await runCase('auth: the injected token is accepted by the handler', async () => {
  assert.ok(token, 'token was extracted from the injected page')
  const response = await call({ method: 'GET', path: '/dsh-code-runner/api/env', token })
  assert.equal(response.threw, null)
  assert.equal(response.status, 200, response.body)
})

/* ── 3. §1.10 loopback token bootstrap ─────────────────────────────────────── */

await runCase('bootstrap §1.10: loopback client + loopback Host receives the same token', async () => {
  const variants = [
    { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:57598' } },
    { remoteAddress: '127.0.0.5', headers: { host: '127.0.0.1' } },
    { remoteAddress: '::1', headers: { host: '[::1]:57598' } },
    { remoteAddress: '::ffff:127.0.0.1', headers: { host: 'localhost:57598' } },
  ]
  for (const variant of variants) {
    const response = await call({ method: 'GET', path: '/dsh-code-runner/api/token', ...variant })
    assert.equal(response.threw, null)
    assert.equal(response.status, 200, `${JSON.stringify(variant)}: ${response.status} ${response.body}`)
    assert.deepEqual(Object.keys(response.json).sort(), ['ok', 'token'])
    assert.equal(response.json.ok, true)
    assert.equal(response.json.token, token, 'bootstrap returns the injected token')
  }
  // A loopback origin is accepted; it must still be loopback.
  const withOrigin = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/token',
    headers: { origin: 'http://127.0.0.1:57598' },
  })
  assert.equal(withOrigin.status, 200, withOrigin.body)
  assert.equal(withOrigin.json.token, token)
})

await runCase('bootstrap §1.10: non-loopback peer / public Host / cross-site / public origin → 403', async () => {
  const denied = [
    { label: 'LAN peer', remoteAddress: '192.168.1.20' },
    { label: 'public Host header', headers: { host: 'example.com' } },
    { label: 'public Host with port', headers: { host: 'example.com:443' } },
    { label: '127.*-lookalike Host', headers: { host: '127.evil.com' } },
    { label: 'cross-site fetch metadata', headers: { 'sec-fetch-site': 'cross-site' } },
    { label: 'public Origin', headers: { origin: 'https://evil.example' } },
  ]
  for (const variant of denied) {
    const response = await call({ method: 'GET', path: '/dsh-code-runner/api/token', ...variant })
    assertErrorEnvelope(response, 403, 'forbidden')
  }
})

/* ── 4. §1.6 environment response ──────────────────────────────────────────── */

await runCase('env §1.6: field names, limits, and python + r detected with versions', async () => {
  const response = await call({ method: 'GET', path: '/dsh-code-runner/api/env', token })
  assert.equal(response.threw, null)
  assert.equal(response.status, 200, response.body)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  const env = response.json
  envPayload = env

  assert.deepEqual(Object.keys(env).sort(), ENV_KEYS, '§1.6 env response field names')
  assert.equal(env.ok, true)
  assert.equal(env.platform, 'posix')
  assert.equal(typeof env.defaultCwd, 'string')
  assert.ok(path.isAbsolute(env.defaultCwd), `defaultCwd is absolute: ${env.defaultCwd}`)
  assert.equal(env.tmpRoot, TMP_ROOT)
  assert.deepEqual(Object.keys(env.limits).sort(), LIMIT_KEYS)
  assert.deepEqual(env.limits, LIMIT, 'CONTRACT-V2 §1.2 limits additions')

  assert.ok(Array.isArray(env.languages))
  assert.deepEqual(
    env.languages.map((entry) => entry.id),
    ['python', 'r', 'matlab', 'node', 'bash', 'zsh', 'ruby', 'perl', 'julia', 'deno', 'bun', 'php'],
    'language table order',
  )
  for (const entry of env.languages) {
    assert.deepEqual(Object.keys(entry).sort(), LANGUAGE_KEYS, `language entry keys (${entry.id})`)
    assert.equal(typeof entry.label, 'string')
    assert.equal(typeof entry.available, 'boolean')
    assert.ok(typeof entry.template === 'string' && entry.template.length > 0, `template for ${entry.id}`)
    if (entry.available) {
      assert.equal(typeof entry.command, 'string')
      assert.ok(path.isAbsolute(entry.command), `command for ${entry.id} is absolute`)
      if (entry.id === 'matlab') {
        // MATLAB does not pay a full -batch startup just for a version probe.
        assert.equal(entry.version, null, 'matlab skips the slow -batch version probe')
      } else {
        assert.ok(typeof entry.version === 'string' && entry.version.length > 0, `version for ${entry.id}`)
        assert.ok(entry.version.length <= 80, `version for ${entry.id} is capped at 80 chars`)
      }
    } else {
      assert.equal(entry.command, null, `command is null for unavailable ${entry.id}`)
      assert.equal(entry.version, null, `version is null for unavailable ${entry.id}`)
    }
  }

  const python = env.languages.find((entry) => entry.id === 'python')
  const r = env.languages.find((entry) => entry.id === 'r')
  assert.equal(python.available, true, 'python is available on this machine')
  assert.match(python.version, /Python \d+\.\d+/)
  assert.equal(r.available, true, 'R is available on this machine')
  assert.match(r.version, /R/i)
  assert.equal(python.template, 'print("Hello from Python", 1 + 1)\n')

  // The env scan is cached (same payload) within the 10-minute TTL.
  const cached = await call({ method: 'GET', path: '/dsh-code-runner/api/env', token })
  assert.equal(cached.status, 200)
  assert.deepEqual(cached.json, env)
})

/* ── 5. Real Python run, offset polling, exit code ─────────────────────────── */

await runCase('run python: streams "hello 4", exitCode 0, script mode 0o600', async () => {
  const run = await startRun({ language: 'python', code: 'print("hello", 2+2)' })
  assert.equal(run.language, 'python')
  assert.match(run.command, /python/)
  assert.equal(path.basename(run.scriptPath), 'script.py')
  assert.ok(fs.existsSync(run.scriptPath), 'script file written')
  assert.equal(fs.statSync(run.scriptPath).mode & 0o777, 0o600, 'script file mode 0o600')
  assert.equal(run.timeoutMs, 300000, 'default timeout')
  assert.ok(Number.isInteger(run.startedAt))
  assert.ok(path.isAbsolute(run.cwd))

  // v2 run metadata (CONTRACT-V2.md §1.4): buffer mode, capture on by default.
  assert.equal(run.mode, 'buffer')
  assert.equal(run.file, null)
  assert.equal(run.capturePlots, true)
  const runDir = path.dirname(run.plotDir)
  assert.equal(run.plotDir, path.join(runDir, 'plots'))
  assert.ok(fs.existsSync(run.plotDir), 'plots dir created when capturePlots is true')

  // §1.7/§1.3.1 spawn payload: argv, cwd, collect-mode stdio, env knobs, graceMs.
  const pythonCommand = envPayload.languages.find((entry) => entry.id === 'python').command
  const spawnOptions = stub.state.spawnOptions.at(-1)
  assert.equal(spawnOptions.argv[0], pythonCommand)
  assert.deepEqual(spawnOptions.argv.slice(1), ['-u', run.scriptPath])
  assert.equal(spawnOptions.cwd, run.cwd)
  assert.equal(spawnOptions.graceMs, 2000)
  assert.deepEqual(spawnOptions.stdio.stdout, { maxBytes: 2097152, spill: { maxBytes: 16777216 } })
  assert.deepEqual(spawnOptions.stdio.stderr, { maxBytes: 2097152, spill: { maxBytes: 16777216 } })
  assert.equal(spawnOptions.stdio.stdin, 'ignore')
  for (const [name, expected] of Object.entries({
    TERM: 'dumb',
    NO_COLOR: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    MPLBACKEND: 'Agg',
  })) {
    assert.equal(spawnOptions.env[name], expected, `spawn env ${name}`)
  }
  // Python plot capture: prefer the installed pack helper (CONTRACT-V5 §1.2),
  // falling back to the per-run pysite copy.
  const installedPythonDir = path.join(SMOKE_STATE_DIR, 'packs', 'python')
  const pythonSiteDir = fs.existsSync(path.join(installedPythonDir, 'sitecustomize.py'))
    ? installedPythonDir
    : path.join(runDir, 'pysite')
  const expectedPythonPath = process.env.PYTHONPATH
    ? `${pythonSiteDir}${path.delimiter}${process.env.PYTHONPATH}`
    : pythonSiteDir
  assert.equal(spawnOptions.env.PYTHONPATH, expectedPythonPath, 'PYTHONPATH prepends pysite')
  assert.equal(spawnOptions.env.DSH_CODE_RUNNER_PLOTS_DIR, run.plotDir)
  assert.equal(fs.readFileSync(run.scriptPath, 'utf8'), 'print("hello", 2+2)')

  const siteCustomize = fs.readFileSync(path.join(pythonSiteDir, 'sitecustomize.py'), 'utf8')
  assert.ok(
    siteCustomize.startsWith(PYTHON_SITECUSTOMIZE_PREFIX),
    'reference sitecustomize saver content is verbatim',
  )
  assert.ok(siteCustomize.includes('Approved deviation D1'), 'D1 workaround is documented')
  assert.ok(siteCustomize.includes('_builtins.__import__ = _real_import'), 'D1 hook restores the importer')

  const { stdout, result, stdoutFrom, stderrFrom } = await waitForRun(run.runId)
  assert.ok(stdout.includes('hello 4'), `stdout was: ${JSON.stringify(stdout)}`)
  assert.equal(result.exitCode, 0)
  assert.equal(result.signal, null)
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0)
  assert.equal(result.language, 'python')
  assert.equal(result.command, run.command)
  assert.equal(result.scriptPath, run.scriptPath)
  assert.equal(result.cwd, run.cwd)
  assert.equal(result.startedAt, run.startedAt)
  assert.equal(result.mode, 'buffer')
  assert.equal(result.file, null)
  assert.equal(result.plotDir, run.plotDir)
  assert.equal(result.capturePlots, true)

  // The non-consuming readers have nothing left and offsets are stable.
  const drain = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/output?runId=${run.runId}&stdoutFrom=${stdoutFrom}&stderrFrom=${stderrFrom}`,
    token,
  })
  assert.equal(drain.status, 200)
  assert.equal(drain.json.running, false)
  assert.equal(drain.json.stdout.text, '')
  assert.equal(drain.json.stderr.text, '')
  assert.equal(drain.json.stdout.nextOffset, stdoutFrom)
  assert.equal(drain.json.stderr.nextOffset, stderrFrom)
})

/* ── 6. Real R run (buffer, capturePlots → png wrapper) ───────────────────── */

await runCase('run R: prints "hello R 4" and exits 0 through the png wrapper', async () => {
  const run = await startRun({ language: 'r', code: 'cat("hello R", 2+2, "\\n")' })
  assert.equal(run.language, 'r')
  assert.equal(run.mode, 'buffer')
  assert.equal(run.capturePlots, true)
  assert.match(run.command, /Rscript/)
  assert.equal(path.basename(run.scriptPath), 'script.R')

  // CONTRACT-V2.md §1.3.2: argv [Rscript, '--vanilla', wrapper], exact wrapper bytes,
  // env DSH_CODE_RUNNER_SCRIPT + DSH_CODE_RUNNER_PLOTS_DIR.
  const runDir = path.dirname(run.plotDir)
  const installedRWrapper = path.join(SMOKE_STATE_DIR, 'packs', 'r', 'plot-wrapper.R')
  const wrapperPath = fs.existsSync(installedRWrapper) ? installedRWrapper : path.join(runDir, 'plot-wrapper.R')
  const spawnOptions = stub.state.spawnOptions.at(-1)
  assert.equal(spawnOptions.argv[1], '--vanilla')
  assert.equal(spawnOptions.argv[2], wrapperPath)
  assert.equal(path.basename(spawnOptions.argv[0]), 'Rscript')
  assert.equal(spawnOptions.env.DSH_CODE_RUNNER_SCRIPT, run.scriptPath)
  assert.equal(spawnOptions.env.DSH_CODE_RUNNER_PLOTS_DIR, run.plotDir)
  assert.equal(
    fs.readFileSync(wrapperPath, 'utf8'),
    R_PLOT_WRAPPER_EXPECTED,
    'R wrapper content is exactly as specified',
  )

  const { stdout, result } = await waitForRun(run.runId)
  assert.ok(stdout.includes('hello R 4'), `stdout was: ${JSON.stringify(stdout)}`)
  assert.equal(result.exitCode, 0)
  assert.equal(result.signal, null)
})

await runCase('run R: ggplot2 drawn only by top-level auto-print is captured as a plot', async () => {
  // `Rscript script.R` auto-prints visible top-level values; the wrapper must keep
  // that behaviour (source(print.eval = TRUE)) or a bare ggplot() is never drawn.
  const run = await startRun({
    language: 'r',
    code: 'library(ggplot2)\nd <- data.frame(x = 1:10, y = (1:10)^2)\nggplot(d, aes(x, y)) + geom_line()\ncat("ggplot done\\n")\n',
  })
  const { stdout, result } = await waitForRun(run.runId)
  assert.equal(result.exitCode, 0)
  assert.ok(stdout.includes('ggplot done'), `stdout was: ${JSON.stringify(stdout)}`)
  const artifacts = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/artifacts?runId=' + encodeURIComponent(run.runId),
    token,
  })
  assert.equal(artifacts.threw, null)
  assert.equal(artifacts.status, 200)
  const runPlot = (artifacts.json.plots || []).find((item) => item.source === 'run' && /\.png$/.test(item.name))
  assert.ok(runPlot, 'ggplot2 top-level print must reach the png device: ' + JSON.stringify((artifacts.json.plots || []).map((item) => item.source + ':' + item.name)))
  assert.ok(runPlot.size > 5000, `ggplot png suspiciously small: ${runPlot.size} B`)
})

/* ── 7. stdin is forwarded to the child process ────────────────────────────── */

await runCase('run python with stdin: input reaches the process', async () => {
  const run = await startRun({
    language: 'python',
    code: 'import sys\ndata = sys.stdin.read()\nprint("stdin:" + data.strip())',
    stdin: 'hello stdin',
  })
  // A missing trailing newline is appended before feeding the child (§1.7).
  assert.deepEqual(stub.state.spawnOptions.at(-1).stdio.stdin, { data: 'hello stdin\n' })
  const { stdout } = await waitForRun(run.runId)
  assert.ok(stdout.includes('stdin:hello stdin'), `stdout was: ${JSON.stringify(stdout)}`)
})

/* ── 8. Stop a long-running process ────────────────────────────────────────── */

await runCase('stop: sleeping python run terminates quickly with stopped=true', async () => {
  const run = await startRun({ language: 'python', code: 'import time\ntime.sleep(30)' })
  await sleep(150) // let the interpreter start and block in sleep

  const stopStartedAt = Date.now()
  const stop = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/stop',
    token,
    body: { runId: run.runId },
  })
  assert.equal(stop.threw, null)
  assert.equal(stop.status, 200, stop.body)
  assert.deepEqual(Object.keys(stop.json).sort(), STOP_KEYS, '§1.9 stop response field names')
  assert.equal(stop.json.ok, true)
  assert.equal(stop.json.runId, run.runId)
  assert.equal(stop.json.stopped, true)

  const { result } = await waitForRun(run.runId, { maxMs: 5000 })
  const elapsed = Date.now() - stopStartedAt
  assert.equal(result.stopped, true, 'output reports the user stop')
  assert.equal(result.running, false)
  assert.ok(elapsed < 5000, `stop took too long: ${elapsed}ms`)

  // Stopping an already finished run is a no-op success.
  const again = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/stop',
    token,
    body: { runId: run.runId },
  })
  assert.equal(again.status, 200)
  assert.deepEqual(Object.keys(again.json).sort(), STOP_KEYS)
  assert.equal(again.json.stopped, false)
  assert.equal(again.json.running, false)
})

/* ── 9. Error envelope cases ───────────────────────────────────────────────── */

await runCase('errors: unknown runId → 404 unknown-run', async () => {
  const runId = crypto.randomUUID()
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/output?runId=${runId}`, token }),
    404,
    'unknown-run',
  )
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/stop', token, body: { runId } }),
    404,
    'unknown-run',
  )
})

await runCase('errors: cwd "/does/not/exist" → 400 bad-cwd', async () => {
  const response = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/run',
    token,
    body: { language: 'python', code: 'print(1)', cwd: '/does/not/exist' },
  })
  assertErrorEnvelope(response, 400, 'bad-cwd')
})

await runCase('errors: unknown language → 400 unsupported-language', async () => {
  const response = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/run',
    token,
    body: { language: 'cobol', code: 'DISPLAY "hi".' },
  })
  assertErrorEnvelope(response, 400, 'unsupported-language')
})

await runCase('errors: known but missing language → 400 language-unavailable', async () => {
  const missing = envPayload?.languages?.find((entry) => !entry.available)
  if (!missing) {
    console.log('      (all listed languages are installed here — nothing to assert)')
    return
  }
  const response = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/run',
    token,
    body: { language: missing.id, code: 'print(1)' },
  })
  assertErrorEnvelope(response, 400, 'language-unavailable')
  assert.ok(response.json.error.message.includes(missing.id), 'message names the language')
})

await runCase('errors: route/method/body protocol errors', async () => {
  // Unknown route under the prefix.
  assertErrorEnvelope(
    await call({ method: 'GET', path: '/dsh-code-runner/api/nope', token }),
    404,
    'unknown-route',
  )
  // Wrong method on a known route.
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/env', token, body: {} }),
    405,
    'method-not-allowed',
  )
  assertErrorEnvelope(
    await call({ method: 'OPTIONS', path: '/dsh-code-runner/api/run', token }),
    405,
    'method-not-allowed',
  )
  // Malformed JSON body.
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/run', token, body: '{not json' }),
    400,
    'bad-json',
  )
  // Missing runId.
  assertErrorEnvelope(
    await call({ method: 'GET', path: '/dsh-code-runner/api/output', token }),
    400,
    'bad-request',
  )
  // The bootstrap route never requires a token but does dislike other methods.
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/token', body: {} }),
    405,
    'method-not-allowed',
  )
  // No CORS headers are ever emitted on any response above.
  const response = await call({ method: 'GET', path: '/dsh-code-runner/api/env' })
  assert.equal(response.headers['access-control-allow-origin'], undefined)
})

/* ── 9b. v2: file-mode runs (CONTRACT-V2.md §1.3 / §1.4) ───────────────────── */

/** GET /api/artifacts with the full §1.10 field/envelope assertions. */
async function artifactsFor(runId) {
  const response = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/artifacts?runId=${encodeURIComponent(runId)}`,
    token,
  })
  assert.equal(response.threw, null)
  assert.equal(response.status, 200, response.body)
  const payload = response.json
  assert.deepEqual(Object.keys(payload).sort(), ARTIFACTS_KEYS, '§1.10 artifacts field names')
  assert.equal(payload.ok, true)
  assert.equal(payload.runId, runId)
  assert.equal(typeof payload.running, 'boolean')
  assert.ok(path.isAbsolute(payload.plotDir))
  assert.ok(Array.isArray(payload.plots))
  assert.equal(typeof payload.truncated, 'boolean')
  for (const item of payload.plots) {
    assert.deepEqual(Object.keys(item).sort(), ARTIFACT_ITEM_KEYS, '§1.10 artifact item field names')
    assert.ok(path.isAbsolute(item.path))
    assert.ok(item.source === 'run' || item.source === 'cwd')
    assert.equal(typeof item.name, 'string')
    assert.equal(typeof item.size, 'number')
    assert.equal(typeof item.mtimeMs, 'number')
    assert.equal(typeof item.ext, 'string')
  }
  const paths = payload.plots.map((item) => item.path)
  assert.equal(new Set(paths).size, paths.length, 'artifacts are de-duplicated by path')
  return payload
}

await runCase('v2 run file mode: executes the on-disk python file, no temp copy', async () => {
  const workDir = path.join(SMOKE_ROOT, 'file-mode')
  await fsp.mkdir(workDir, { recursive: true })
  const filePath = path.join(workDir, 'on_disk.py')
  await writeFile(filePath, 'print("from file mode", 2 + 3)\n')

  const run = await startRun({ mode: 'file', file: filePath, cwd: workDir })
  assert.equal(run.mode, 'file')
  assert.equal(run.file, filePath)
  assert.equal(run.language, 'python')
  assert.equal(run.scriptPath, filePath, 'scriptPath is the on-disk file')
  assert.equal(run.cwd, workDir)
  assert.equal(run.capturePlots, true)
  const runDir = path.dirname(run.plotDir)
  assert.equal(fs.existsSync(path.join(runDir, 'script.py')), false, 'no temp copy of the user file')

  const spawnOptions = stub.state.spawnOptions.at(-1)
  assert.deepEqual(spawnOptions.argv.slice(1), ['-u', filePath])
  assert.equal(spawnOptions.cwd, workDir)

  const { stdout, result } = await waitForRun(run.runId)
  assert.ok(stdout.includes('from file mode 5'), `stdout: ${JSON.stringify(stdout)}`)
  assert.equal(result.exitCode, 0)
  assert.equal(result.mode, 'file')
  assert.equal(result.file, filePath)
})

await runCase('v2 language inference from extension: .R → r, .ts → node', async () => {
  const workDir = path.join(SMOKE_ROOT, 'inference')
  await fsp.mkdir(workDir, { recursive: true })

  const rFile = path.join(workDir, 'plotfile.R')
  await writeFile(rFile, 'cat("from R file\\n")\n')
  const rRun = await startRun({ file: rFile, cwd: workDir }) // no mode → defaults to file
  assert.equal(rRun.mode, 'file')
  assert.equal(rRun.language, 'r')
  const rSpawn = stub.state.spawnOptions.at(-1)
  assert.equal(rSpawn.argv[1], '--vanilla')
  assert.equal(rSpawn.env.DSH_CODE_RUNNER_SCRIPT, rFile, 'wrapper sources the on-disk file')
  const rResult = await waitForRun(rRun.runId)
  assert.ok(rResult.stdout.includes('from R file'), `stdout: ${JSON.stringify(rResult.stdout)}`)
  assert.equal(rResult.result.exitCode, 0)

  const tsFile = path.join(workDir, 'prog.ts')
  await writeFile(tsFile, 'const value: number = 40\nconsole.log("from ts file", value + 2)\n')
  const tsRun = await startRun({ file: tsFile, cwd: workDir })
  assert.equal(tsRun.language, 'node', 'ts → first available of deno/bun/node')
  const tsResult = await waitForRun(tsRun.runId)
  assert.ok(tsResult.stdout.includes('from ts file 42'), `stdout: ${JSON.stringify(tsResult.stdout)}`)
  assert.equal(tsResult.result.exitCode, 0)
})

await runCase('v2 capturePlots:false: no helper files, plotDir absent, plain argv', async () => {
  const run = await startRun({ language: 'python', code: 'print("no capture")', capturePlots: false })
  assert.equal(run.capturePlots, false)
  const runDir = path.dirname(run.plotDir)
  assert.equal(fs.existsSync(run.plotDir), false, 'plotDir only exists when capturePlots is true')
  assert.equal(fs.existsSync(path.join(runDir, 'pysite')), false, 'no pysite helper')
  const spawnOptions = stub.state.spawnOptions.at(-1)
  assert.equal(spawnOptions.env.DSH_CODE_RUNNER_PLOTS_DIR, undefined)
  assert.deepEqual(spawnOptions.argv.slice(1), ['-u', run.scriptPath])
  const { stdout } = await waitForRun(run.runId)
  assert.ok(stdout.includes('no capture'))

  // R without capture runs the script directly (no wrapper).
  const rRun = await startRun({ language: 'r', code: 'cat("r plain\\n")', capturePlots: false })
  const rSpawn = stub.state.spawnOptions.at(-1)
  assert.equal(path.basename(rSpawn.argv[2]), 'script.R', 'R runs the script, not the wrapper')
  assert.equal(rSpawn.env.DSH_CODE_RUNNER_SCRIPT, undefined)
  const rResult = await waitForRun(rRun.runId)
  assert.ok(rResult.stdout.includes('r plain'))
})

/* ── 9c. v2 plot capture (CONTRACT-V2.md §1.3.1 / §1.3.2 / §1.10) ─────────── */

await runCase('v2 python matplotlib capture: source:run PNG without savefig + blob preview', async () => {
  const workDir = path.join(SMOKE_ROOT, 'py-plot')
  await fsp.mkdir(workDir, { recursive: true })
  const code = [
    'import matplotlib',
    'matplotlib.use("Agg")',
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots()',
    'ax.plot([1, 2, 3], [1, 4, 9])',
    'print("matplotlib figure ready")',
  ].join('\n')
  const run = await startRun({ language: 'python', code, cwd: workDir })
  const { stdout } = await waitForRun(run.runId, { maxMs: 60000 })
  assert.ok(stdout.includes('matplotlib figure ready'), `stdout: ${JSON.stringify(stdout)}`)

  const artifacts = await artifactsFor(run.runId)
  assert.equal(artifacts.running, false)
  assert.equal(artifacts.plotDir, run.plotDir)
  const runPlots = artifacts.plots.filter((item) => item.source === 'run')
  assert.ok(runPlots.length >= 1, `expected a captured run plot, got ${JSON.stringify(artifacts.plots)}`)
  const plot = runPlots[0]
  assert.equal(plot.ext, 'png')
  assert.match(plot.name, /^plot-\d{3}\.png$/)
  assert.equal(path.dirname(plot.path), run.plotDir)
  assert.ok(plot.size > 0)
  const bytes = fs.readFileSync(plot.path)
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, 'captured matplotlib figure is a real PNG')

  // GET /api/blob returns the same bytes raw (the only non-JSON route).
  const blob = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(plot.path)}`,
    token,
  })
  assert.equal(blob.threw, null)
  assert.equal(blob.status, 200, blob.body)
  assert.equal(blob.json, null, 'blob is not JSON')
  assert.equal(blob.headers['content-type'], 'image/png')
  assert.equal(blob.headers['content-length'], String(plot.size))
  assert.equal(blob.headers['cache-control'], 'no-store')
  assert.deepEqual(blob.bodyBuffer.subarray(0, 8), PNG_SIGNATURE)
  assert.equal(blob.bodyBuffer.length, plot.size)
})

await runCase('v2 R plot capture: plot(1:10) → source:run PNG', async () => {
  const workDir = path.join(SMOKE_ROOT, 'r-plot')
  await fsp.mkdir(workDir, { recursive: true })
  const run = await startRun({ language: 'r', code: 'plot(1:10)', cwd: workDir })
  const { stdout } = await waitForRun(run.runId, { maxMs: 30000 })
  assert.equal(stdout.trim(), '')
  const artifacts = await artifactsFor(run.runId)
  const runPlots = artifacts.plots.filter((item) => item.source === 'run')
  assert.ok(runPlots.length >= 1, `expected an R run plot, got ${JSON.stringify(artifacts.plots)}`)
  const plot = runPlots[0]
  assert.equal(plot.ext, 'png')
  assert.match(plot.name, /^plot-\d{3}\.png$/)
  const bytes = fs.readFileSync(plot.path)
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, 'R png-device output is a real PNG')
})

await runCase('v2 artifacts: cwd image scan (source:cwd), stale images excluded', async () => {
  const workDir = path.join(SMOKE_ROOT, 'cwd-artifacts')
  await fsp.mkdir(workDir, { recursive: true })
  const stalePath = path.join(workDir, 'stale.png')
  await writeFile(stalePath, TINY_PNG)
  const old = new Date(Date.now() - 60_000)
  await fsp.utimes(stalePath, old, old)
  await writeFile(path.join(workDir, 'notes.txt'), 'not an image\n')

  const code = [
    'import base64',
    `open("fresh.png", "wb").write(base64.b64decode("${TINY_PNG.toString('base64')}"))`,
    'print("wrote fresh.png")',
  ].join('\n')
  const run = await startRun({ language: 'python', code, cwd: workDir })
  const { stdout } = await waitForRun(run.runId)
  assert.ok(stdout.includes('wrote fresh.png'))

  const artifacts = await artifactsFor(run.runId)
  const cwdPlots = artifacts.plots.filter((item) => item.source === 'cwd')
  const fresh = cwdPlots.find((item) => item.name === 'fresh.png')
  assert.ok(fresh, `fresh.png missing from ${JSON.stringify(artifacts.plots)}`)
  assert.equal(fresh.ext, 'png')
  assert.equal(fresh.path, path.join(workDir, 'fresh.png'))
  assert.equal(cwdPlots.some((item) => item.name === 'stale.png'), false, 'stale cwd image outside mtime window')
  assert.equal(artifacts.plots.some((item) => item.name === 'notes.txt'), false, 'non-image excluded')
  assert.equal(
    artifacts.plots.filter((item) => item.source === 'run').length,
    0,
    'plain script produces no run plots',
  )
})

await runCase('v2 artifacts: cap 40, mtime-desc order, unknown-run 404', async () => {
  const workDir = path.join(SMOKE_ROOT, 'many-images')
  await fsp.mkdir(workDir, { recursive: true })
  const writes = []
  for (let index = 0; index < 45; index += 1) {
    writes.push(writeFile(path.join(workDir, `img-${String(index).padStart(2, '0')}.png`), TINY_PNG))
  }
  await Promise.all(writes)
  const run = await startRun({ language: 'bash', code: 'echo many-images', cwd: workDir, capturePlots: false })
  await waitForRun(run.runId)

  const artifacts = await artifactsFor(run.runId)
  assert.equal(artifacts.plots.length, LIMIT.artifactMax, 'cap is 40')
  assert.equal(artifacts.truncated, true, 'truncated when the cap cuts items')
  assert.equal(artifacts.plots.every((item) => item.source === 'cwd'), true)
  for (let index = 1; index < artifacts.plots.length; index += 1) {
    assert.ok(
      artifacts.plots[index - 1].mtimeMs >= artifacts.plots[index].mtimeMs,
      'cwd plots sorted by mtime desc',
    )
  }

  assertErrorEnvelope(
    await call({ method: 'GET', path: '/dsh-code-runner/api/artifacts', token }),
    400,
    'bad-request',
  )
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/artifacts?runId=${crypto.randomUUID()}`, token }),
    404,
    'unknown-run',
  )
})

/* ── 9d. v2 files / file / file-save / blob (CONTRACT-V2.md §1.6–§1.9) ────── */

await runCase('v2 files list: dirs first, base-sorted names, dotfiles, symlinks, fields', async () => {
  const listDir = path.join(SMOKE_ROOT, 'listing')
  await fsp.mkdir(path.join(listDir, 'adir'), { recursive: true })
  await fsp.mkdir(path.join(listDir, 'zdir'), { recursive: true })
  await writeFile(path.join(listDir, 'alpha.txt'), 'alpha\n')
  await writeFile(path.join(listDir, 'Bravo.md'), '# bravo\n')
  await writeFile(path.join(listDir, 'charlie.json'), '{}\n')
  await writeFile(path.join(listDir, '.hidden'), 'dot\n')
  await fsp.symlink(path.join(listDir, 'alpha.txt'), path.join(listDir, 'link-to-file'))
  await fsp.symlink(path.join(listDir, 'adir'), path.join(listDir, 'link-to-dir'))
  await fsp.symlink(path.join(listDir, 'missing-target'), path.join(listDir, 'broken-link'))

  const response = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/files?dir=${encodeURIComponent(listDir)}`,
    token,
  })
  assert.equal(response.threw, null)
  assert.equal(response.status, 200, response.body)
  const payload = response.json
  assert.deepEqual(Object.keys(payload).sort(), FILES_KEYS, '§1.6 files field names')
  assert.equal(payload.ok, true)
  assert.equal(payload.dir, listDir)
  assert.equal(payload.parent, SMOKE_ROOT)
  assert.equal(payload.truncated, false)
  assert.ok(Array.isArray(payload.entries))
  for (const entry of payload.entries) {
    assert.deepEqual(Object.keys(entry).sort(), FILE_ENTRY_KEYS, '§1.6 entry field names')
    assert.ok(path.isAbsolute(entry.path))
  }

  const names = payload.entries.map((entry) => entry.name)
  assert.deepEqual(names.slice(0, 3), ['adir', 'link-to-dir', 'zdir'], 'directories first, base-sorted')
  assert.equal(payload.entries[0].isDir, true)
  assert.equal(payload.entries[0].size, null, 'directory size is null')
  assert.equal(payload.entries[0].ext, '')
  assert.ok(names.includes('.hidden'), 'dotfiles are listed')

  const nonHiddenFiles = payload.entries
    .filter((entry) => !entry.isDir && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  assert.deepEqual(nonHiddenFiles, ['alpha.txt', 'Bravo.md', 'broken-link', 'charlie.json', 'link-to-file'])

  const byName = new Map(payload.entries.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('alpha.txt').ext, 'txt')
  assert.equal(byName.get('alpha.txt').size, 6)
  assert.equal(typeof byName.get('alpha.txt').mtimeMs, 'number')
  assert.equal(byName.get('link-to-file').isDir, false)
  assert.equal(typeof byName.get('link-to-file').size, 'number')
  assert.equal(byName.get('link-to-dir').isDir, true)
  assert.equal(byName.get('broken-link').isDir, false)
  assert.equal(byName.get('broken-link').size, null, 'broken symlink size is null')
  assert.equal(byName.get('broken-link').mtimeMs, null, 'broken symlink mtime is null')
})

await runCase('v2 files list: caps at 2000 entries and reports truncated', async () => {
  const manyDir = path.join(SMOKE_ROOT, 'many-files')
  await writeFiles(manyDir, 2001, 'f')
  const response = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/files?dir=${encodeURIComponent(manyDir)}`,
    token,
  })
  assert.equal(response.status, 200, response.body)
  assert.equal(response.json.truncated, true)
  assert.equal(response.json.entries.length, 2000)
  assert.equal(response.json.entries[0].name, 'f0000.txt')
  assert.equal(response.json.entries.at(-1).name, 'f1999.txt')
})

await runCase('v2 file read: text, binary detection, 1 MiB truncation, path errors', async () => {
  const readDir = path.join(SMOKE_ROOT, 'read')
  await fsp.mkdir(readDir, { recursive: true })

  const textPath = path.join(readDir, 'hello.py')
  await writeFile(textPath, 'print("hello file")\n')
  const textResponse = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/file?path=${encodeURIComponent(textPath)}`,
    token,
  })
  assert.equal(textResponse.threw, null)
  assert.equal(textResponse.status, 200, textResponse.body)
  const textPayload = textResponse.json
  assert.deepEqual(Object.keys(textPayload).sort(), FILE_READ_KEYS, '§1.7 file-read field names')
  assert.equal(textPayload.text, 'print("hello file")\n')
  assert.equal(textPayload.size, 20)
  assert.equal(textPayload.ext, 'py')
  assert.equal(typeof textPayload.mtimeMs, 'number')
  assert.equal(textPayload.truncated, false)
  assert.equal(textPayload.binary, false)

  const binaryPath = path.join(readDir, 'data.bin')
  await writeFile(binaryPath, Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  const binaryResponse = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/file?path=${encodeURIComponent(binaryPath)}`,
    token,
  })
  assert.equal(binaryResponse.status, 200)
  assert.equal(binaryResponse.json.binary, true)
  assert.equal(binaryResponse.json.text, '')
  assert.equal(binaryResponse.json.truncated, false)
  assert.equal(binaryResponse.json.size, 6)

  const bigPath = path.join(readDir, 'big.txt')
  const bigText = 'a'.repeat(LIMIT.fileMaxBytes + 100)
  await writeFile(bigPath, bigText)
  const bigResponse = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/file?path=${encodeURIComponent(bigPath)}`,
    token,
  })
  assert.equal(bigResponse.status, 200)
  assert.equal(bigResponse.json.truncated, true)
  assert.equal(bigResponse.json.size, bigText.length)
  assert.equal(Buffer.byteLength(bigResponse.json.text, 'utf8'), LIMIT.fileMaxBytes, 'head capped at 1 MiB')
  assert.equal(bigResponse.json.binary, false)

  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/file?path=${encodeURIComponent(readDir)}`, token }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({ method: 'GET', path: '/dsh-code-runner/api/file?path=/does/not/exist.txt', token }),
    404,
    'not-found',
  )
  assertErrorEnvelope(
    await call({
      method: 'GET',
      path: `/dsh-code-runner/api/file?path=${encodeURIComponent('relative.txt')}`,
      token,
    }),
    400,
    'bad-path',
  )
})

await runCase('v2 file save: create, conflict 409, force overwrite, mode, path errors', async () => {
  const saveDir = path.join(SMOKE_ROOT, 'save')
  await fsp.mkdir(saveDir, { recursive: true })
  const savePath = path.join(saveDir, 'note.txt')

  const created = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/file',
    token,
    body: { path: savePath, text: 'v1' },
  })
  assert.equal(created.threw, null)
  assert.equal(created.status, 200, created.body)
  assert.deepEqual(Object.keys(created.json).sort(), FILE_SAVE_KEYS, '§1.8 save field names')
  assert.equal(created.json.path, savePath)
  assert.equal(created.json.size, 2)
  assert.equal(created.json.ext, 'txt')
  assert.equal(typeof created.json.mtimeMs, 'number')
  assert.equal(fs.readFileSync(savePath, 'utf8'), 'v1')
  assert.equal(fs.statSync(savePath).mode & 0o777, 0o644, 'new files are 0o644')

  // External modification changes the mtime; a stale baseMtimeMs must conflict.
  const baseMtimeMs = created.json.mtimeMs
  await writeFile(savePath, 'external-change')
  const bumped = new Date(Date.now() + 5_000)
  await fsp.utimes(savePath, bumped, bumped)
  const conflicted = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/file',
    token,
    body: { path: savePath, text: 'v2', baseMtimeMs },
  })
  assert.equal(conflicted.status, 409, conflicted.body)
  assert.deepEqual(Object.keys(conflicted.json).sort(), CONFLICT_KEYS, '§1.8 conflict payload fields')
  assert.equal(conflicted.json.error.code, 'conflict')
  assert.notEqual(conflicted.json.currentMtimeMs, baseMtimeMs)
  assert.equal(conflicted.json.size, 'external-change'.length)
  assert.equal(fs.readFileSync(savePath, 'utf8'), 'external-change', 'conflict did not write')

  // Omitting baseMtimeMs forces the overwrite (client's explicit "overwrite").
  const forced = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/file',
    token,
    body: { path: savePath, text: 'v2' },
  })
  assert.equal(forced.status, 200, forced.body)
  assert.deepEqual(Object.keys(forced.json).sort(), FILE_SAVE_KEYS)
  assert.equal(fs.readFileSync(savePath, 'utf8'), 'v2')

  // Existing file mode is preserved (writeFile does not chmod an existing inode).
  await fsp.chmod(savePath, 0o600)
  await call({ method: 'POST', path: '/dsh-code-runner/api/file', token, body: { path: savePath, text: 'v3' } })
  assert.equal(fs.statSync(savePath).mode & 0o777, 0o600, 'existing file mode preserved')

  // Parent must exist (no mkdir); directories and relative paths are bad-path.
  const missingParentPath = path.join(SMOKE_ROOT, 'missing-parent', 'x.txt')
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/file', token, body: { path: missingParentPath, text: 'x' } }),
    400,
    'bad-path',
  )
  assert.equal(fs.existsSync(path.dirname(missingParentPath)), false, 'save does not create parent dirs')
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/file', token, body: { path: SMOKE_ROOT, text: 'x' } }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/file', token, body: { path: 'relative.txt', text: 'x' } }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/file', token, body: { path: savePath, text: 42 } }),
    400,
    'bad-request',
  )
  assertErrorEnvelope(
    await call({
      method: 'POST',
      path: '/dsh-code-runner/api/file',
      token,
      body: { path: savePath, text: 'a'.repeat(LIMIT.fileMaxBytes + 1) },
    }),
    413,
    'too-large',
  )
})

await runCase('v2 blob: allowlist content types, raw bytes, 16 MiB cap, path errors', async () => {
  const blobDir = path.join(SMOKE_ROOT, 'blob')
  await fsp.mkdir(blobDir, { recursive: true })
  const pngPath = path.join(blobDir, 'pixel.png')
  const svgPath = path.join(blobDir, 'vector.svg')
  const pdfPath = path.join(blobDir, 'doc.pdf')
  const txtPath = path.join(blobDir, 'note.txt')
  await writeFile(pngPath, TINY_PNG)
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  await writeFile(pdfPath, '%PDF-1.4\n% smoke\n')
  await writeFile(txtPath, 'plain text\n')

  const png = await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(pngPath)}`, token })
  assert.equal(png.threw, null)
  assert.equal(png.status, 200, png.body)
  assert.equal(png.json, null)
  assert.equal(png.headers['content-type'], 'image/png')
  assert.equal(png.headers['content-length'], String(TINY_PNG.length))
  assert.equal(png.headers['cache-control'], 'no-store')
  assert.equal(png.headers['access-control-allow-origin'], undefined, 'no CORS headers ever')
  assert.deepEqual(png.bodyBuffer, TINY_PNG)

  const svg = await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(svgPath)}`, token })
  assert.equal(svg.status, 200)
  assert.equal(svg.headers['content-type'], 'image/svg+xml')
  assert.equal(svg.bodyBuffer.toString('utf8'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

  const pdf = await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(pdfPath)}`, token })
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers['content-type'], 'application/pdf')
  assert.equal(pdf.bodyBuffer.subarray(0, 4).toString('utf8'), '%PDF')

  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(txtPath)}`, token }),
    415,
    'unsupported-file',
  )
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(path.join(blobDir, 'none.png'))}`, token }),
    404,
    'not-found',
  )
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent('relative.png')}`, token }),
    400,
    'bad-path',
  )
  const dirPng = path.join(blobDir, 'dir.png')
  await fsp.mkdir(dirPng)
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(dirPng)}`, token }),
    400,
    'bad-path',
  )

  // Cap: a sparse file above blobMaxBytes is rejected before any read.
  const hugePath = path.join(blobDir, 'huge.png')
  await writeFile(hugePath, '')
  await fsp.truncate(hugePath, LIMIT.blobMaxBytes + 1)
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/blob?path=${encodeURIComponent(hugePath)}`, token }),
    413,
    'too-large',
  )
})

/* ── 9e. v2 route auth + request validation ────────────────────────────────── */

await runCase('v2 routes require the token header (401 unauthorized)', async () => {
  const routes = [
    `/dsh-code-runner/api/files?dir=${encodeURIComponent(SMOKE_ROOT)}`,
    `/dsh-code-runner/api/file?path=${encodeURIComponent(path.join(SMOKE_ROOT, 'x'))}`,
    `/dsh-code-runner/api/blob?path=${encodeURIComponent(path.join(SMOKE_ROOT, 'x.png'))}`,
    `/dsh-code-runner/api/artifacts?runId=${crypto.randomUUID()}`,
  ]
  for (const routePath of routes) {
    assertErrorEnvelope(await call({ method: 'GET', path: routePath }), 401, 'unauthorized')
  }
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/file', body: { path: '/tmp/x.txt', text: 'x' } }),
    401,
    'unauthorized',
  )
})

await runCase('v2 run request validation: file mode + mode/capturePlots errors', async () => {
  const workDir = path.join(SMOKE_ROOT, 'validation')
  await fsp.mkdir(workDir, { recursive: true })
  const validFile = path.join(workDir, 'valid.py')
  await writeFile(validFile, 'print("ok")\n')
  const unknownExt = path.join(workDir, 'mystery.xyz')
  await writeFile(unknownExt, 'unknown\n')

  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/run', token, body: { mode: 'file', file: 'relative.py' } }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({
      method: 'POST',
      path: '/dsh-code-runner/api/run',
      token,
      body: { mode: 'file', file: path.join(workDir, 'missing.py') },
    }),
    404,
    'not-found',
  )
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/run', token, body: { mode: 'file', file: workDir } }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({ method: 'POST', path: '/dsh-code-runner/api/run', token, body: { mode: 'file', file: unknownExt } }),
    400,
    'unsupported-language',
  )
  assertErrorEnvelope(
    await call({
      method: 'POST',
      path: '/dsh-code-runner/api/run',
      token,
      body: { mode: 'file', file: validFile, language: 'cobol' },
    }),
    400,
    'unsupported-language',
  )
  assertErrorEnvelope(
    await call({
      method: 'POST',
      path: '/dsh-code-runner/api/run',
      token,
      body: { mode: 'ram', language: 'python', code: 'print(1)' },
    }),
    400,
    'bad-request',
  )
  assertErrorEnvelope(
    await call({
      method: 'POST',
      path: '/dsh-code-runner/api/run',
      token,
      body: { language: 'python', code: 'print(1)', capturePlots: 'yes' },
    }),
    400,
    'bad-request',
  )
  // Listing/reading errors share the new bad-path family.
  assertErrorEnvelope(await call({ method: 'GET', path: '/dsh-code-runner/api/files', token }), 400, 'bad-path')
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/files?dir=${encodeURIComponent('relative')}`, token }),
    400,
    'bad-path',
  )
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/files?dir=${encodeURIComponent('/does/not/exist')}`, token }),
    400,
    'bad-path',
  )
})

/* ── 9f. v2 browser diagnostics (CONTRACT-V2.md §1.11) ─────────────────────── */

await runCase('diag §1.11: GET/POST require the host token', async () => {
  const anonGet = await call({ method: 'GET', path: '/dsh-code-runner/api/diag' })
  assertErrorEnvelope(anonGet, 401, 'unauthorized')
  const anonPost = await call({ method: 'POST', path: '/dsh-code-runner/api/diag', body: { event: { name: 'x' } } })
  assertErrorEnvelope(anonPost, 401, 'unauthorized')
})

await runCase('diag §1.11: POST records events and GET returns them with seq/receivedAt', async () => {
  const posted = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/diag',
    token,
    body: {
      event: {
        name: 'surface-mount',
        at: 1730000000000,
        detail: { mode: 'pane', width: 1440, 'bad key!': 'dropped', deep: { a: { b: { c: { d: 'too deep' } } } } },
      },
    },
  })
  assert.equal(posted.threw, null)
  assert.equal(posted.status, 200)
  assert.deepEqual(Object.keys(posted.json).sort(), sorted(['ok', 'accepted']))
  assert.equal(posted.json.ok, true)
  assert.equal(posted.json.accepted, 1)
  const readBack = await call({ method: 'GET', path: '/dsh-code-runner/api/diag', token })
  assert.equal(readBack.threw, null)
  assert.equal(readBack.status, 200)
  assert.equal(readBack.json.ok, true)
  assert.equal(readBack.json.plugin, 'dsh-code-runner')
  assert.ok(Array.isArray(readBack.json.events))
  const recorded = readBack.json.events[readBack.json.events.length - 1]
  assert.ok(Number.isInteger(recorded.seq) && recorded.seq > 0, 'seq is missing')
  assert.ok(Number.isFinite(recorded.receivedAt), 'receivedAt is missing')
  assert.equal(recorded.event.name, 'surface-mount')
  assert.equal(recorded.event.detail.mode, 'pane')
  assert.equal(recorded.event.detail.width, 1440)
  assert.equal(Object.prototype.hasOwnProperty.call(recorded.event.detail, 'bad key!'), false, 'unsafe keys dropped')
  // Depth beyond 3 collapses to undefined, so the too-deep leaf is gone.
  assert.equal(JSON.stringify(recorded.event.detail.deep).includes('too deep'), false, 'depth cap applied')
})

await runCase('diag §1.11: batches accepted, long strings capped, empty payload → 400', async () => {
  const long = 'x'.repeat(5000)
  const batch = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/diag',
    token,
    body: { events: [{ name: 'a' }, { name: 'b', detail: { long } }, { name: 'c' }] },
  })
  assert.equal(batch.threw, null)
  assert.equal(batch.status, 200)
  assert.equal(batch.json.accepted, 3)
  const readBack = await call({ method: 'GET', path: '/dsh-code-runner/api/diag', token })
  const tail = readBack.json.events.slice(-3)
  assert.deepEqual(tail.map((entry) => entry.event.name), ['a', 'b', 'c'])
  const capped = tail[1].event.detail.long
  assert.ok(typeof capped === 'string' && capped.length <= 601, 'long diagnostic string must be capped')
  const empty = await call({ method: 'POST', path: '/dsh-code-runner/api/diag', token, body: {} })
  assertErrorEnvelope(empty, 400, 'bad-request')
})

await runCase('diag §1.11: ring buffer keeps only the newest 100 events', async () => {
  const events = []
  for (let index = 0; index < 120; index += 1) events.push({ name: 'event-' + index })
  for (let index = 0; index < 120; index += 6) {
    const posted = await call({ method: 'POST', path: '/dsh-code-runner/api/diag', token, body: { events: events.slice(index, index + 6) } })
    assert.equal(posted.threw, null)
    assert.equal(posted.status, 200)
  }
  const readBack = await call({ method: 'GET', path: '/dsh-code-runner/api/diag', token })
  assert.equal(readBack.json.events.length, 100, 'ring buffer should hold exactly 100 events')
  const names = readBack.json.events.map((entry) => entry.event.name)
  assert.equal(names[names.length - 1], 'event-119')
  assert.equal(names.includes('event-0'), false, 'oldest event must be evicted')
})

/* ── 9g. v5 language packs (CONTRACT-V5 §1.1–§1.4) ─────────────────────────── */

await runCase('v5 packs: detection reports status and auto-installs detected capture helpers', async () => {
  const response = await call({ method: 'GET', path: '/dsh-code-runner/api/packs', token })
  assert.equal(response.threw, null)
  assert.equal(response.status, 200, response.body)
  assert.equal(response.json.ok, true)
  assert.ok(Array.isArray(response.json.packs))
  const byId = Object.fromEntries(response.json.packs.map((pack) => [pack.id, pack]))
  assert.ok(byId.r && byId.r.detected === true, 'R should be detected')
  assert.equal(byId.r.builtin, true)
  assert.equal(byId.r.enabled, true)
  assert.equal(byId.r.capture.kind, 'r')
  assert.equal(byId.r.capture.ready, true)
  assert.equal(byId.r.capture.installed, true, 'R capture helper should be auto-installed')
  assert.ok(fs.existsSync(path.join(SMOKE_STATE_DIR, 'packs', 'r', 'plot-wrapper.R')))
  assert.ok(byId.python.capture.installed === true, 'Python capture helper should be auto-installed')
  assert.ok(fs.existsSync(path.join(SMOKE_STATE_DIR, 'packs', 'python', 'sitecustomize.py')))
  assert.equal(byId.c.builtin, false, 'C is an opt-in pack')
  assert.equal(byId.c.enabled, false, 'C is disabled by default')
})

await runCase('v5 packs: one-click enable adds a language and runs it; disable removes it again', async () => {
  const enable = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/packs',
    token,
    body: { id: 'c', enabled: true },
  })
  assert.equal(enable.threw, null)
  if (enable.status !== 200) {
    console.log('  note: C toolchain unavailable here — enable case skipped (' + enable.body + ')')
    return
  }
  const envAfter = await call({ method: 'GET', path: '/dsh-code-runner/api/env', token })
  const entry = envAfter.json.languages.find((language) => language.id === 'c')
  assert.ok(entry && entry.available, 'enabled C pack must appear in /api/env')
  assert.ok(entry.extensions.includes('c'), 'C extensions exposed')

  const run = await startRun({
    language: 'c',
    code: '#include <stdio.h>\nint main(void) { printf("hello c\\n"); return 0; }\n',
  })
  const { stdout, result } = await waitForRun(run.runId)
  assert.ok(stdout.includes('hello c'), `compiled C stdout was ${JSON.stringify(stdout)}`)
  assert.equal(result.exitCode, 0)

  const disable = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/packs',
    token,
    body: { id: 'c', enabled: false },
  })
  assert.equal(disable.status, 200)
  const envBack = await call({ method: 'GET', path: '/dsh-code-runner/api/env', token })
  assert.equal(envBack.json.languages.some((language) => language.id === 'c'), false, 'disabled pack leaves /api/env')
})

await runCase('v5 packs: endpoint is token-gated and validates ids', async () => {
  const anonymous = await call({ method: 'GET', path: '/dsh-code-runner/api/packs' })
  assertErrorEnvelope(anonymous, 401, 'unauthorized')
  const unknown = await call({ method: 'POST', path: '/dsh-code-runner/api/packs', token, body: { id: 'nope', enabled: true } })
  assertErrorEnvelope(unknown, 400, 'unsupported-language')
  const badBody = await call({ method: 'POST', path: '/dsh-code-runner/api/packs', token, body: { id: 'c' } })
  assertErrorEnvelope(badBody, 400, 'bad-request')
})

/* ── 9h. v6 report chart placement (CONTRACT-V6 §1.2) ──────────────────────── */

const reportBase = path.join(SMOKE_ROOT, 'report-base')
const reportPlotSrc = path.join(SMOKE_ROOT, 'report-plots')
await fsp.mkdir(reportBase, { recursive: true })
await fsp.mkdir(reportPlotSrc, { recursive: true })
const reportPng = path.join(reportPlotSrc, 'plot-001.png')
await fsp.writeFile(reportPng, PNG_1PX)
const reportBody = {
  language: 'bash',
  mode: 'buffer',
  file: null,
  cwd: reportBase,
  command: 'bash /tmp/run.sh',
  code: 'echo chart\n',
  stdout: 'out\n',
  stderr: '',
  exitCode: 0,
  durationMs: 10,
  startedAt: Date.now(),
  summary: null,
  plots: [{ path: reportPng, name: 'plot-001.png', source: 'run' }],
  format: 'md',
  include: { code: true, output: true, plots: true, summary: false },
  name: 'smoke-chart',
}
const postReport = (body) =>
  call({ method: 'POST', path: '/dsh-code-runner/api/export', token, body })

await runCase('v6 export: under-code nests 统计图 between the code and the output', async () => {
  const response = await postReport({ ...reportBody, plotPlacement: 'under-code' })
  assert.equal(response.status, 200, `export HTTP ${response.status}: ${response.text}`)
  assert.equal(response.json.plotPlacement, 'under-code', 'plotPlacement was not honoured')
  const md = fs.readFileSync(response.json.reportPath, 'utf8')
  const code = md.indexOf('## 源代码：')
  const plots = md.indexOf('## 统计图：')
  const output = md.indexOf('## 输出结果：')
  assert.ok(code >= 0 && plots >= 0 && output >= 0, 'report.md lacks a section')
  assert.ok(code < plots && plots < output, `report.md order is code=${code} plots=${plots} output=${output}`)
  assert.ok(md.indexOf('](plots/plot-001.png)') > plots, 'report.md lacks the plot link')
})

await runCase('v6 export: omitted plotPlacement keeps the standalone 统计图 section', async () => {
  const response = await postReport(reportBody)
  assert.equal(response.status, 200, `export HTTP ${response.status}: ${response.text}`)
  assert.equal(response.json.plotPlacement, 'section', 'default plotPlacement is not section')
  const md = fs.readFileSync(response.json.reportPath, 'utf8')
  const code = md.indexOf('## 源代码：')
  const output = md.indexOf('## 输出结果：')
  const plots = md.indexOf('## 统计图：')
  assert.ok(code >= 0 && output >= 0 && plots >= 0, 'report.md lacks a section')
  assert.ok(code < output && output < plots, `default report.md order is code=${code} output=${output} plots=${plots}`)
})

await runCase('v6 export: unknown placement → 400 and under-code falls back without a code section', async () => {
  const invalid = await postReport({ ...reportBody, plotPlacement: 'inline' })
  assertErrorEnvelope(invalid, 400, 'bad-request')
  const noCode = await postReport({
    ...reportBody,
    include: { code: false, output: true, plots: true, summary: false },
    plotPlacement: 'under-code',
  })
  assert.equal(noCode.status, 200, `no-code export HTTP ${noCode.status}: ${noCode.text}`)
  assert.equal(noCode.json.plotPlacement, 'section', 'charts stayed nested without a source section')
  const md = fs.readFileSync(noCode.json.reportPath, 'utf8')
  assert.ok(md.indexOf('## 统计图：') > md.indexOf('## 输出结果：'), 'orphan charts have no standalone section')
})

/* ── 9i. v7 dataset preview + import code (CONTRACT-V7 §1) ─────────────────── */

const datasetDir = path.join(SMOKE_ROOT, 'datasets')
await fsp.mkdir(datasetDir, { recursive: true })
const datasetXlsx = path.join(datasetDir, 'students.xlsx')
const datasetCsv = path.join(datasetDir, 'scores.csv')
await fsp.writeFile(datasetXlsx, buildXlsx(DEFAULT_SHEETS))
await fsp.writeFile(
  datasetCsv,
  '姓名,分数,备注\n"张三",92,"a ""quote"", ok"\n李四,88,\n',
  'utf8',
)
const postDataset = (body) =>
  call({ method: 'POST', path: '/dsh-code-runner/api/dataset/preview', token, body })

await runCase('v7 dataset: xlsx preview exposes sheets, typed columns and import snippets', async () => {
  const response = await postDataset({ path: datasetXlsx, language: 'r' })
  assert.equal(response.status, 200, `preview HTTP ${response.status}: ${response.text}`)
  const payload = response.json
  assert.equal(payload.ok, true, 'preview ok is not true')
  assert.deepEqual(payload.sheets, ['成绩', '教师'], `sheets are ${JSON.stringify(payload.sheets)}`)
  assert.equal(payload.sheet, '成绩', 'first sheet was not selected')
  assert.equal(payload.header, true, 'header row was not detected')
  assert.deepEqual(
    payload.columns.map((column) => column.name),
    ['姓名', '班级', '数学', '英语', '入学日期'],
  )
  assert.deepEqual(
    payload.columns.map((column) => column.type),
    ['string', 'string', 'number', 'number', 'date'],
  )
  assert.deepEqual(payload.rows[0], ['张三', 'A班', '92', '88', '2026-09-01'])
  assert.equal(payload.totalRows, 3, `totalRows is ${payload.totalRows}`)
  assert.equal(payload.variable, 'students', `variable is ${payload.variable}`)
  assert.ok(payload.snippets.r.includes('read_excel'), 'R snippet lacks read_excel')
  assert.ok(payload.snippets.python.includes('pd.read_excel'), 'python snippet lacks pd.read_excel')
  assert.ok(payload.snippets.matlab.includes('readtable'), 'matlab snippet lacks readtable')
  assert.equal(payload.import.language, 'r', 'import language is not r')
  assert.ok(payload.import.code.includes('library(readxl)'), 'R import code lacks library(readxl)')
  const second = await postDataset({ path: datasetXlsx, sheet: '教师', language: 'matlab' })
  assert.equal(second.status, 200, `sheet preview HTTP ${second.status}: ${second.text}`)
  assert.equal(second.json.sheet, '教师', 'requested sheet was not selected')
  assert.equal(second.json.rows[0][0], 'Wang', `sheet row is ${JSON.stringify(second.json.rows[0])}`)
  assert.ok(second.json.import.code.includes("'Sheet'"), 'matlab import code lacks the Sheet argument')
})

await runCase('v7 dataset: csv preview handles quotes, UTF-8 and the header toggle', async () => {
  const response = await postDataset({ path: datasetCsv, language: 'python' })
  assert.equal(response.status, 200, `csv preview HTTP ${response.status}: ${response.text}`)
  const payload = response.json
  assert.equal(payload.kind, 'csv', `kind is ${payload.kind}`)
  assert.equal(payload.delimiter, ',', 'comma delimiter was not detected')
  assert.equal(payload.encoding, 'utf-8', `encoding is ${payload.encoding}`)
  assert.equal(payload.header, true, 'csv header row was not detected')
  assert.deepEqual(payload.rows[0], ['张三', '92', 'a "quote", ok'])
  assert.equal(payload.totalRows, 2, `csv totalRows is ${payload.totalRows}`)
  assert.ok(payload.import.code.includes('pd.read_csv'), 'python import code lacks pd.read_csv')
  const noHeader = await postDataset({ path: datasetCsv, header: false })
  assert.equal(noHeader.status, 200, `header:false preview HTTP ${noHeader.status}`)
  assert.equal(noHeader.json.header, false, 'header:false was ignored')
  assert.deepEqual(
    noHeader.json.columns.map((column) => column.name),
    ['V1', 'V2', 'V3'],
  )
  assert.equal(noHeader.json.totalRows, 3, 'header:false totalRows should include the title row')
})

await runCase('v7 dataset: preview validation rejects bad paths, types and delimiters', async () => {
  const relative = await postDataset({ path: 'students.xlsx' })
  assertErrorEnvelope(relative, 400, 'bad-path')
  const missing = await postDataset({ path: path.join(datasetDir, 'missing.xlsx') })
  assertErrorEnvelope(missing, 404, 'not-found')
  const workbook = path.join(datasetDir, 'notes.docx')
  await fsp.writeFile(workbook, 'not a dataset')
  const unsupported = await postDataset({ path: workbook })
  assertErrorEnvelope(unsupported, 415, 'unsupported-file')
  const legacy = path.join(datasetDir, 'legacy.xls')
  await fsp.writeFile(legacy, 'old binary')
  const legacyResponse = await postDataset({ path: legacy })
  assertErrorEnvelope(legacyResponse, 415, 'unsupported-file')
  const badDelimiter = await postDataset({ path: datasetCsv, delimiter: '::' })
  assertErrorEnvelope(badDelimiter, 400, 'bad-request')
})

await runCase('v7 dataset: endpoint is token-gated', async () => {
  const anonymous = await call({
    method: 'POST',
    path: '/dsh-code-runner/api/dataset/preview',
    body: { path: datasetXlsx },
  })
  assertErrorEnvelope(anonymous, 401, 'unauthorized')
})

/* ── 10. Retention: at most 25 runs (§1.7) ─────────────────────────────────── */

await runCase('retention: at most 25 runs are kept; the oldest is evicted with its temp dir', async () => {
  const runIds = []
  let oldestScriptDir = ''
  for (let index = 0; index < 26; index += 1) {
    const run = await startRun({ language: 'bash', code: 'echo hi' })
    runIds.push(run.runId)
    if (index === 0) oldestScriptDir = path.dirname(run.scriptPath)
    await waitForRun(run.runId)
  }

  // The 26th insertion evicts the oldest retained run.
  assertErrorEnvelope(
    await call({ method: 'GET', path: `/dsh-code-runner/api/output?runId=${runIds[0]}`, token }),
    404,
    'unknown-run',
  )
  // Its temp directory is deleted (async, best effort).
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && fs.existsSync(oldestScriptDir)) await sleep(25)
  assert.equal(fs.existsSync(oldestScriptDir), false, 'evicted run temp dir was removed')

  // The most recent run is still retained and readable.
  const latest = await call({
    method: 'GET',
    path: `/dsh-code-runner/api/output?runId=${runIds.at(-1)}&stdoutFrom=0&stderrFrom=0`,
    token,
  })
  assert.equal(latest.status, 200, latest.body)
  assert.ok(latest.json.stdout.text.includes('hi'))
})

/* ── 11. Origin rules (CONTRACT §1.3 + Lead's hosted-proxy clarification) ─── */

await runCase('origin: configured origin accepted, same-authority proxy origin accepted', async () => {
  const configured = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token,
    origin: ORIGIN,
  })
  assert.equal(configured.status, 200, configured.body)

  // Reverse proxy: page origin is public, ctx.webServer.getOrigin() is loopback,
  // but the origin authority equals the request Host header → accepted.
  const proxied = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token,
    origin: 'https://public.example:8443',
    headers: { host: 'public.example:8443' },
  })
  assert.equal(proxied.status, 200, proxied.body)

  // Default ports normalize: http://host vs Host: host:80 is the same authority.
  const defaultPort = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token,
    origin: 'http://public.example',
    headers: { host: 'public.example:80' },
  })
  assert.equal(defaultPort.status, 200, defaultPort.body)
})

await runCase('origin: evil.example Origin with valid token → 403 forbidden', async () => {
  const response = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token,
    origin: 'http://evil.example',
  })
  assertErrorEnvelope(response, 403, 'forbidden')
})

await runCase('origin: sec-fetch-site cross-site with valid token → 403 forbidden', async () => {
  const response = await call({
    method: 'GET',
    path: '/dsh-code-runner/api/env',
    token,
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assertErrorEnvelope(response, 403, 'forbidden')
})

/* ── 12. Disposal: processes, timers, temp dirs, idempotency ───────────────── */

await runCase('dispose: terminates live runs, unregisters, removes temp dirs, idempotent', async () => {
  // Start one long run that is still alive when the plugin unloads.
  const liveRun = await startRun({ language: 'python', code: 'import time\ntime.sleep(30)' })

  const savedDisposers = [...stub.state.disposers]
  assert.ok(savedDisposers.length >= 3, 'cleanup + tapIndex + route effects registered')

  stub.dispose()
  assert.equal(stub.state.registrations.length, 0, 'prefix route unregistered on dispose')
  assert.equal(stub.state.transforms.length, 0, 'tapIndex transform removed on dispose')
  assert.equal(stub.state.disposed, true)

  // Every disposer is idempotent and never throws when called a second time.
  for (const disposer of savedDisposers) disposer()

  // 1. No child process survives the plugin.
  const processDeadline = Date.now() + 5000
  while (stub.state.children.size > 0 && Date.now() < processDeadline) await sleep(25)
  assert.equal(stub.state.children.size, 0, 'no lingering child processes after dispose')

  // 2. The live run was terminated by disposal (all children are gone).
  assert.ok(path.isAbsolute(liveRun.scriptPath))

  // 3. Temp run directories are removed (async, best effort).
  const dirDeadline = Date.now() + 3000
  let remaining = []
  while (Date.now() < dirDeadline) {
    remaining = [...scriptDirs].filter((dir) => fs.existsSync(dir))
    if (remaining.length === 0) break
    await sleep(25)
  }
  assert.deepEqual(remaining, [], `temp dirs not removed: ${remaining.join(', ')}`)

  // 3b. The shared temp root is shared with the live installed plugin (and its
  // concurrent runs), so it must not be required to be empty. Our own run dirs are
  // the ones %TEMPDIR%/dsh-code-runner/<uuid> entries recorded in `scriptDirs`,
  // already checked above; report the shared state for transparency instead.
  if (fs.existsSync(TMP_ROOT)) {
    const currentEntries = fs.readdirSync(TMP_ROOT)
    const foreignLeft = currentEntries.filter((name) => FOREIGN_TMP_ENTRIES.has(name))
    if (foreignLeft.length > 0) {
      console.log(
        `  note: shared temp root kept ${foreignLeft.length} foreign run dir(s) from the live plugin`,
      )
    }
    assert.equal(
      currentEntries.some((name) => scriptDirsRunIds.has(name)),
      false,
      'none of the suite own run dirs are left in the shared temp root',
    )
  }

  // 4. No plugin timers are left behind (run timeout + probe timers cleared).
  if (typeof process.getActiveResourcesInfo === 'function') {
    const timeouts = process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
    assert.equal(timeouts.length, 0, `lingering Timeout resources: ${timeouts.length}`)
  }
})

/* ── Cleanup of this suite's scratch space (user files / mpl cache) ─────────── */

await fsp.rm(SMOKE_ROOT, { recursive: true, force: true }).catch(() => {})

/* ── Summary ───────────────────────────────────────────────────────────────── */

const failures = results.filter((result) => !result.ok)
console.log('')
console.log(`${results.length - failures.length}/${results.length} smoke cases passed`)
if (failures.length > 0) {
  console.error(`FAILED: ${failures.map((failure) => failure.name).join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('dsh-code-runner host-smoke: PASS')
}
