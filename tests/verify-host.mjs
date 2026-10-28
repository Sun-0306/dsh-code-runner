#!/usr/bin/env node
/**
 * Independent host-half verification for dsh-code-runner.
 *
 * This is the verifier's own minimal stub harness (it deliberately does not
 * reuse tests/host-smoke.mjs): it imports ../index.js, builds the two services
 * the plugin injects as contract-faithful fakes (`webServer`, `subprocess` over
 * node:child_process), captures the registered prefix handler + index transform
 * and drives real HTTP-shaped requests through them.
 *
 * The subprocess stub implements the Host `subprocess` service surface used by
 * the plugin: resolveExecutable(command, env), spawn(spec) →
 * { stdin, stdout, stderr, collected: { stdout?, stderr? } with
 *   readFrom(byteOffset) → {text,nextOffset,lossy}, done → {exitCode,signal},
 *   terminate(), waitForExit() }.
 *
 *   node tests/verify-host.mjs
 *
 * Prints [PASS]/[FAIL]/[SKIP] lines and exits 1 when any check fails.
 */
import { EventEmitter } from 'node:events'
import { spawn as nodeSpawn } from 'node:child_process'
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate as truncateFile,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// CONTRACT-V5: packs live under the DSH home by default; isolate them here.
const VERIFY_STATE_DIR = path.join(os.tmpdir(), 'dsh-code-runner-verify-state-' + process.pid)
process.env.DSH_CODE_RUNNER_STATE_DIR = VERIFY_STATE_DIR

/** Capture-wrapper path for a run: installed pack helper wins over the run-local copy. */
function captureWrapperPath(runDir, languageId, fileName) {
  const installed = path.join(VERIFY_STATE_DIR, 'packs', languageId, fileName)
  return existsSync(installed) ? installed : path.join(runDir, fileName)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const INDEX_PATH = path.join(ROOT, 'index.js')

const ORIGIN = 'http://127.0.0.1:57598'
const HOST_HEADER = '127.0.0.1:57598'

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
function assert(condition, message, extra) {
  if (!condition) throw new Error(`${message}${extra ? ` — ${extra}` : ''}`)
}
async function scenario(id, fn) {
  try {
    const detail = await fn()
    pass(id, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(id, error instanceof Error ? error.message : String(error))
  }
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`)
}
const truncate = (text, max = 240) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/* ─────────────────── subprocess stub (Host service contract) ─────────────── */

function createCollector(mode) {
  const chunks = []
  let length = 0
  let dropped = 0
  const maxBytes =
    mode && typeof mode === 'object' && Number.isFinite(Number(mode.maxBytes))
      ? Number(mode.maxBytes)
      : 8 * 1024 * 1024
  const push = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const room = maxBytes - length
    if (room <= 0) {
      dropped += buffer.length
      return
    }
    const take = buffer.length <= room ? buffer : buffer.subarray(0, room)
    chunks.push(Buffer.from(take))
    length += take.length
    if (buffer.length > room) dropped += buffer.length - room
  }
  const reader = {
    readFrom(fromByte) {
      const from = Number.isInteger(fromByte) && fromByte > 0 ? fromByte : 0
      const buffer = Buffer.concat(chunks)
      const start = Math.min(from, buffer.length)
      return {
        text: buffer.subarray(start).toString('utf8'),
        nextOffset: buffer.length,
        lossy: dropped > 0,
      }
    },
  }
  return { push, reader }
}

function createSubprocessStub() {
  const children = new Set()
  const spawnCalls = []

  async function resolveExecutable(command, env) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('resolveExecutable: command must be a non-empty string')
    }
    if (command.includes('/') || command.includes('\\')) {
      await access(command, fsConstants.X_OK)
      return command
    }
    const pathValue =
      (env && typeof env.PATH === 'string' ? env.PATH : process.env.PATH) ?? ''
    for (const directory of pathValue.split(path.delimiter)) {
      if (!directory) continue
      const candidate = path.join(directory, command)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        /* try the next PATH entry */
      }
    }
    throw new Error(`resolveExecutable: "${command}" not found on PATH`)
  }

  function spawn(spec) {
    spawnCalls.push(spec)
    if (!spec || typeof spec !== 'object') throw new Error('spawn: spec is required')
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) throw new Error('spawn: argv is required')
    const [executable, ...args] = spec.argv
    if (typeof executable !== 'string' || executable.length === 0) {
      throw new Error('spawn: argv[0] must be an executable path')
    }
    if (typeof spec.cwd !== 'string' || !existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) {
      throw new Error(`spawn: cwd is not an existing directory: ${String(spec.cwd)}`)
    }

    const stdio = spec.stdio ?? {}
    const stdinSpec = stdio.stdin ?? 'ignore'
    const childStdio = ['ignore', 'pipe', 'pipe']
    if (stdinSpec === 'pipe') childStdio[0] = 'pipe'
    else if (stdinSpec && typeof stdinSpec === 'object') childStdio[0] = 'pipe'

    const child = nodeSpawn(executable, args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: childStdio,
      windowsHide: true,
    })
    children.add(child)

    const stdoutCollector = createCollector(stdio.stdout)
    const stderrCollector = createCollector(stdio.stderr)
    child.stdout?.on('data', (chunk) => stdoutCollector.push(chunk))
    child.stderr?.on('data', (chunk) => stderrCollector.push(chunk))

    let settled = false
    let forceTimer = null
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    const settle = (exitCode, signal) => {
      if (settled) return
      settled = true
      if (forceTimer) {
        clearTimeout(forceTimer)
        forceTimer = null
      }
      children.delete(child)
      resolveDone({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === 'string' ? signal : null,
      })
    }
    child.on('close', (code, signal) => settle(code ?? null, signal ?? null))
    child.on('error', () => settle(null, null))

    if (stdinSpec && typeof stdinSpec === 'object') {
      if (child.stdin) {
        try {
          if (typeof stdinSpec.data === 'string') child.stdin.write(stdinSpec.data)
          child.stdin.end()
        } catch {
          /* the child may have exited already */
        }
      }
    }

    const terminate = () => {
      if (settled) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      if (forceTimer) return
      forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, Math.min(Math.max(Number(spec.graceMs) || 2000, 200), 2000))
      forceTimer.unref?.()
    }

    const waitForExit = (signal) =>
      new Promise((resolve) => {
        if (settled) {
          resolve(true)
          return
        }
        let finished = false
        const finish = (value) => {
          if (finished) return
          finished = true
          resolve(value)
        }
        done.then(() => finish(true))
        if (signal) {
          if (signal.aborted) {
            finish(false)
            return
          }
          signal.addEventListener('abort', () => finish(false), { once: true })
        }
      })

    return {
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      control: undefined,
      collected: { stdout: stdoutCollector.reader, stderr: stderrCollector.reader },
      done,
      terminate,
      waitForExit,
    }
  }

  return { service: { resolveExecutable, spawn }, children, spawnCalls }
}

/* ───────────────────────── fake HTTP req / res ───────────────────────────── */

class FakeRequest extends EventEmitter {
  constructor({ method, url, headers = {}, remoteAddress = '127.0.0.1', body }) {
    super()
    this.method = method
    this.url = url
    this.headers = {}
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value
    }
    this.httpVersion = '1.1'
    this.httpVersionMajor = 1
    this.httpVersionMinor = 1
    this.destroyed = false
    this.complete = false
    this.socket = { remoteAddress, remotePort: 54321, encrypted: false, localAddress: '127.0.0.1' }
    this.connection = this.socket
    const payload =
      body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    setImmediate(() => {
      if (payload && payload.length > 0) this.emit('data', payload)
      this.complete = true
      this.emit('end')
    })
  }
  resume() {}
  pause() {}
  setEncoding() {}
  destroy() {
    this.destroyed = true
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.statusMessage = ''
    this.headersSent = false
    this.writableEnded = false
    this.finished = false
    this.headers = {}
    this.body = ''
    this.rawChunks = []
    this.socket = { remoteAddress: '127.0.0.1' }
    this.done = new Promise((resolve) => {
      this._resolveDone = resolve
    })
  }
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value
    return this
  }
  getHeader(name) {
    return this.headers[String(name).toLowerCase()]
  }
  getHeaders() {
    return { ...this.headers }
  }
  hasHeader(name) {
    return Object.prototype.hasOwnProperty.call(this.headers, String(name).toLowerCase())
  }
  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()]
  }
  writeHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    this.statusCode = statusCode
    if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders
    const headers =
      statusMessageOrHeaders && typeof statusMessageOrHeaders === 'object'
        ? statusMessageOrHeaders
        : maybeHeaders
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.headers[key.toLowerCase()] = value
      }
    }
    this.headersSent = true
    return this
  }
  flushHeaders() {
    this.headersSent = true
  }
  write(chunk) {
    if (chunk !== undefined && chunk !== null) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      this.rawChunks.push(buffer)
      this.body += buffer.toString('utf8')
    }
    this.headersSent = true
    return true
  }
  get rawBody() {
    return Buffer.concat(this.rawChunks)
  }
  end(chunk) {
    if (this.writableEnded) return this
    if (chunk !== undefined && chunk !== null) this.write(chunk)
    this.writableEnded = true
    this.finished = true
    this.headersSent = true
    this._resolveDone(this)
    return this
  }
}

/* ─────────────────────────── plugin harness ──────────────────────────────── */

function createHarness() {
  const routes = []
  const taps = []
  const effects = []
  const subprocess = createSubprocessStub()

  const webServer = {
    getOrigin: () => ORIGIN,
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    tapIndex: (transform) => {
      taps.push(transform)
      return () => {
        const index = taps.indexOf(transform)
        if (index >= 0) taps.splice(index, 1)
      }
    },
  }

  const optionalServices = new Map()
  const ctx = {
    webServer,
    subprocess: subprocess.service,
    effect: (callback, label) => {
      const result = callback()
      effects.push({ result, label })
      return () => {}
    },
    get: (serviceName) => optionalServices.get(serviceName),
    on: () => () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
  }

  return {
    ctx,
    optionalServices,
    routes,
    taps,
    effects,
    children: subprocess.children,
    spawnCalls: subprocess.spawnCalls,
    handlerThrows: 0,
    requestCount: 0,
  }
}

async function disposeHarness(harness) {
  for (const entry of [...harness.effects].reverse()) {
    try {
      let disposer = entry.result
      if (disposer && typeof disposer.then === 'function') disposer = await disposer
      if (typeof disposer === 'function') await disposer()
      else if (Array.isArray(disposer)) {
        for (const fn of disposer) if (typeof fn === 'function') await fn()
      }
    } catch (error) {
      console.error(`[warn] disposer threw: ${error?.message ?? error}`)
    }
  }
  harness.effects.length = 0
}

const state = { token: undefined, tokenScriptFound: false }

async function callPluginApi(
  harness,
  {
    method = 'GET',
    pathname,
    query,
    body,
    rawBody,
    token = state.token,
    origin,
    secFetchSite,
    extraHeaders = {},
    remoteAddress = '127.0.0.1',
    hostHeader = HOST_HEADER,
    timeoutMs = 15_000,
  } = {},
) {
  const handler = harness.routes[0]?.handler
  assert(typeof handler === 'function', 'no prefix route handler registered')
  const search = query ? `?${new URLSearchParams(query).toString()}` : ''
  const headers = { host: hostHeader, ...extraHeaders }
  if (token !== null && token !== undefined) headers['x-dsh-code-runner-token'] = token
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  const payload =
    rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined
  const request = new FakeRequest({
    method,
    url: `${pathname}${search}`,
    headers,
    body: payload,
    remoteAddress,
  })
  const response = new FakeResponse()
  harness.requestCount += 1
  let thrown = null
  try {
    await handler(request, response)
  } catch (error) {
    thrown = error
    harness.handlerThrows += 1
  }
  assert(!thrown, `handler threw: ${thrown?.message ?? thrown}`)
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no response after ${timeoutMs} ms`)), timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([response.done, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  let json = null
  try {
    json = response.body ? JSON.parse(response.body) : null
  } catch {
    json = null
  }
  return {
    status: response.statusCode,
    headers: response.headers,
    text: response.body,
    rawBody: response.rawBody,
    json,
  }
}

function expectError(result, status, code) {
  assert(result.status === status, `expected HTTP ${status}, got ${result.status}`, truncate(result.text))
  assert(result.json, 'response body is not JSON', truncate(result.text))
  assert(result.json.ok === false, `ok is not false — ${truncate(result.text)}`)
  assert(result.json.error && typeof result.json.error === 'object', 'error envelope missing')
  assert(
    result.json.error.code === code,
    `expected error.code "${code}", got ${JSON.stringify(result.json.error.code)}`,
  )
  assert(
    typeof result.json.error.message === 'string' && result.json.error.message.length > 0,
    'error.message is empty',
  )
}

async function waitForRun(harness, runId, { maxMs = 20_000, intervalMs = 100 } = {}) {
  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutFrom = 0
  let stderrFrom = 0
  let last = null
  let polls = 0
  while (Date.now() - startedAt <= maxMs) {
    polls += 1
    const result = await callPluginApi(harness, {
      pathname: '/dsh-code-runner/api/output',
      query: { runId, stdoutFrom, stderrFrom },
    })
    assert(result.status === 200, `output poll returned HTTP ${result.status}`, truncate(result.text))
    assert(result.json?.ok === true, `output poll not ok — ${truncate(result.text)}`)
    last = result.json
    stdout += last.stdout?.text ?? ''
    stderr += last.stderr?.text ?? ''
    if (Number.isInteger(last.stdout?.nextOffset)) stdoutFrom = last.stdout.nextOffset
    if (Number.isInteger(last.stderr?.nextOffset)) stderrFrom = last.stderr.nextOffset
    if (last.running === false) return { stdout, stderr, last, polls }
    await sleep(intervalMs)
  }
  throw new Error(`run ${runId} still running after ${maxMs} ms`)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const tempDirs = []
async function makeTempDir(prefix = 'dcr-verify-host-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}
function expectRunReplyLoose(reply) {
  assert(reply.status === 200, `POST /api/run returned HTTP ${reply.status}`, truncate(reply.text))
  const json = reply.json
  assert(json?.ok === true, `run reply ok is not true — ${truncate(reply.text)}`)
  assert(typeof json.runId === 'string' && json.runId.length > 0, 'runId is missing')
  assert(typeof json.language === 'string' && json.language.length > 0, 'language is missing')
  assert(typeof json.command === 'string' && json.command.length > 0, 'command is missing')
  assert(Number.isInteger(json.startedAt) && json.startedAt > 0, 'startedAt is not a timestamp')
  return json
}
async function artifactsOf(harness, runId) {
  return callPluginApi(harness, { pathname: '/dsh-code-runner/api/artifacts', query: { runId } })
}
async function blobOf(harness, filePath) {
  return callPluginApi(harness, { pathname: '/dsh-code-runner/api/blob', query: { path: filePath } })
}
function assertPngArtifact(artifacts, source, label) {
  assert(artifacts.status === 200, `${label}: artifacts HTTP ${artifacts.status}`, truncate(artifacts.text))
  const json = artifacts.json
  assert(json?.ok === true, `${label}: artifacts ok is not true`)
  assert(Array.isArray(json.plots), `${label}: plots is not an array`)
  const plot = json.plots.find((entry) => entry.source === source)
  assert(plot, `${label}: no source:"${source}" plot in artifacts (${JSON.stringify(json.plots.map((entry) => entry.name))})`)
  assert(typeof plot.path === 'string' && path.isAbsolute(plot.path), `${label}: plot.path is not absolute`)
  assert(typeof plot.name === 'string' && /^plot-\d{3}\.png$/.test(plot.name), `${label}: plot.name is ${JSON.stringify(plot.name)}`)
  assert(plot.ext === 'png', `${label}: plot.ext is ${JSON.stringify(plot.ext)}`)
  assert(Number.isInteger(plot.size) && plot.size > 0, `${label}: plot.size is ${JSON.stringify(plot.size)}`)
  assert(Number.isFinite(plot.mtimeMs) && plot.mtimeMs > 0, `${label}: plot.mtimeMs is ${JSON.stringify(plot.mtimeMs)}`)
  return { json, plot }
}

function expectRunReply(reply, languageId) {
  assert(reply.status === 200, `POST /api/run returned HTTP ${reply.status}`, truncate(reply.text))
  const json = reply.json
  assert(json?.ok === true, `run reply ok is not true — ${truncate(reply.text)}`)
  assert(typeof json.runId === 'string' && json.runId.length > 0, 'runId is missing')
  assert(json.language === languageId, `language is ${JSON.stringify(json.language)}`)
  assert(typeof json.command === 'string' && json.command.length > 0, 'command is missing')
  assert(typeof json.scriptPath === 'string' && json.scriptPath.length > 0, 'scriptPath is missing')
  assert(typeof json.cwd === 'string' && path.isAbsolute(json.cwd), `cwd is ${JSON.stringify(json.cwd)}`)
  assert(Number.isInteger(json.startedAt) && json.startedAt > 0, 'startedAt is not a timestamp')
  assert(Number.isInteger(json.timeoutMs), 'timeoutMs is not an integer')
  return json
}

/* ───────────────── v3 fakes: llm + agentDefaultModel + matlab ─────────────── */

/**
 * Deterministic fake of the Host `llm` service (CONTRACT-V2 §1.2 / v3 §1.2).
 * `stream(options)` returns an AsyncIterable<StreamChunk>; the behaviour is
 * switchable per test and the last GenerateOptions are captured for assertions.
 */
function createFakeLlm() {
  const state = { behavior: null, lastOptions: null, calls: 0 }
  const service = {
    stream(options) {
      state.calls += 1
      state.lastOptions = options
      const behavior = state.behavior
      return (async function* fakeStream() {
        if (!behavior) throw new Error('fake llm: no behaviour configured')
        if (behavior.kind === 'text') {
          const text = String(behavior.text ?? '')
          yield { type: 'block-start', index: 0, blockType: 'text' }
          const size = Math.max(1, Number(behavior.chunkSize) || 16)
          for (let offset = 0; offset < text.length; offset += size) {
            yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + size) }
          }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (behavior.kind === 'finish-error') {
          yield { type: 'text-delta', index: 0, text: 'partial answer' }
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: behavior.message ?? 'fake provider failure', code: 'FAKE_FAILURE' },
            },
          }
          return
        }
        if (behavior.kind === 'throw') {
          throw new Error(behavior.message ?? 'fake stream threw')
        }
        if (behavior.kind === 'timeout') {
          yield { type: 'text-delta', index: 0, text: 'thinking…' }
          await new Promise((resolve) => {
            const signal = options?.signal
            if (signal?.aborted) {
              resolve()
              return
            }
            if (signal && typeof signal.addEventListener === 'function') {
              signal.addEventListener('abort', resolve, { once: true })
            }
            const timer = setTimeout(resolve, 120_000)
            timer.unref?.()
          })
          return
        }
        throw new Error(`fake llm: unknown behaviour ${String(behavior.kind)}`)
      })()
    },
  }
  return { service, state }
}

function fakeAgentDefaultModel() {
  return {
    currentSelection() {
      return { provider: 'fake-provider', model: 'fake-model' }
    },
  }
}

/* ─────────────────────────────── main flow ───────────────────────────────── */

async function main() {
  console.log('dsh-code-runner — independent host-half verification (verifier stub harness)')
  console.log(`plugin root: ${ROOT}`)
  console.log(`stub origin: ${ORIGIN}`)

  assert(existsSync(INDEX_PATH), `index.js is missing at ${INDEX_PATH}`)

  // A fake `matlab` executable early on PATH lets the independent stub harness
  // exercise the v3 MATLAB discovery/spawn contract without launching the real
  // MATLAB app (the live suite attempts the real one and SKIPs if the
  // environment refuses a headless start).
  const fakeBinDir = await makeTempDir('dcr-verify-host-bin-')
  const fakeMatlabPath = path.join(fakeBinDir, 'matlab')
  await writeFile(fakeMatlabPath, '#!/bin/sh\necho "fake-matlab $@"\nexit 0\n')
  await chmod(fakeMatlabPath, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`

  const fakeLlm = createFakeLlm()
  const harness = createHarness()
  harness.optionalServices.set('llm', fakeLlm.service)
  harness.optionalServices.set('agentDefaultModel', fakeAgentDefaultModel())
  let disposalDone = false
  const runScriptPaths = []
  const trackedPlotDirs = []
  const userFilePaths = []

  try {
    const mod = await import(pathToFileURL(INDEX_PATH).href)
    await mod.apply(harness.ctx)

    /* ── registration shape ─────────────────────────────────────────────── */

    section('registration (CONTRACT §1.1–§1.3)')

    let transform = null
    await scenario('H01 apply() registers exactly one prefix route at /dsh-code-runner', () => {
      assert(harness.routes.length === 1, `${harness.routes.length} routes registered`)
      const route = harness.routes[0]
      assert(route.kind === 'prefix', `route kind is ${JSON.stringify(route.kind)}`)
      assert(route.path === '/dsh-code-runner', `route path is ${JSON.stringify(route.path)}`)
      assert(typeof route.handler === 'function', 'route has no handler function')
      return `{ kind: 'prefix', path: '${route.path}' }`
    })
    await scenario('H02 apply() registers one index transform via webServer.tapIndex', () => {
      assert(harness.taps.length === 1, `${harness.taps.length} tapIndex transforms registered`)
      assert(typeof harness.taps[0] === 'function', 'tapIndex entry is not a function')
      transform = harness.taps[0]
      return '1 transform'
    })

    /* ── token injection ─────────────────────────────────────────────────── */

    section('token injection (CONTRACT §1.2)')

    const sampleHtml =
      '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id="app"></div></body></html>'
    let tokenScript = null
    await scenario('H03 transform injects the token script immediately before </head>', () => {
      assert(typeof transform === 'function', 'no transform captured')
      const output = transform(sampleHtml)
      assert(typeof output === 'string', 'transform did not return a string')
      const headIndex = sampleHtml.indexOf('</head>')
      const match = /<script>window\.__DSH_CODE_RUNNER__=(\{"token":"([0-9a-f]{48})"\});<\/script>/.exec(
        output,
      )
      assert(match, 'injected script does not match the CONTRACT §1.2 shape', truncate(output, 320))
      tokenScript = match[0]
      const expected = sampleHtml.slice(0, headIndex) + tokenScript + sampleHtml.slice(headIndex)
      assert(output === expected, 'script is not placed immediately before </head>')
      state.token = match[2]
      return `script placed before </head>, token is 48 hex chars`
    })
    await scenario('H04 transform fallback prepends the script when there is no </head>', () => {
      assert(typeof transform === 'function', 'no transform captured')
      const bare = '<!doctype html><html><body>hi</body></html>'
      const output = transform(bare)
      assert(
        /^<script>window\.__DSH_CODE_RUNNER__=\{"token":"[0-9a-f]{48}"\};<\/script>/.test(output),
        'document without </head> did not get the script at the start',
        truncate(output, 200),
      )
      return 'prepended at document start'
    })
    await scenario('H05 injected token is a 48-char lowercase hex string', () => {
      assert(typeof state.token === 'string', 'token was not extracted from the injected script')
      assert(/^[0-9a-f]{48}$/.test(state.token), `token is ${JSON.stringify(state.token)}`)
      return `${state.token.length} hex chars`
    })

    /* ── token bootstrap (§1.10) ─────────────────────────────────────────── */

    section('token bootstrap (CONTRACT §1.10)')

    let bootstrapToken = null
    await scenario('H06 GET /api/token returns {ok:true, token} to a loopback request', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json?.ok === true, 'ok is not true', truncate(result.text))
      assert(/^[0-9a-f]{48}$/.test(String(result.json.token)), 'token is not 48 hex chars')
      bootstrapToken = result.json.token
      assert(
        bootstrapToken === state.token,
        'bootstrap token differs from the token injected into the page',
      )
      return 'bootstrap token === injected token'
    })
    await scenario('H07 bootstrap refuses a non-loopback remoteAddress (127/8 or ::1 only)', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        remoteAddress: '192.168.1.9',
      })
      expectError(result, 403, 'forbidden')
      return '192.168.1.9 → 403'
    })
    await scenario('H08 bootstrap refuses a non-loopback Host header', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        hostHeader: 'evil.example:57598',
      })
      expectError(result, 403, 'forbidden')
      return 'Host: evil.example → 403'
    })
    await scenario('H09 bootstrap refuses sec-fetch-site: cross-site', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        secFetchSite: 'cross-site',
      })
      expectError(result, 403, 'forbidden')
      return 'cross-site → 403'
    })
    await scenario('H10 bootstrap refuses a cross-site Origin', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        origin: 'http://evil.example',
      })
      expectError(result, 403, 'forbidden')
      return 'Origin: http://evil.example → 403'
    })
    await scenario('H11 bootstrap accepts a loopback Origin and bracketed IPv6 loopback', async () => {
      const sameOrigin = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        origin: ORIGIN,
      })
      assert(sameOrigin.status === 200, `loopback http Origin → HTTP ${sameOrigin.status}`)
      const ipv6 = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        remoteAddress: '::1',
        hostHeader: '[::1]:57598',
      })
      assert(ipv6.status === 200, `[::1] loopback → HTTP ${ipv6.status}`, truncate(ipv6.text))
      const mapped = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/token',
        token: null,
        remoteAddress: '::ffff:127.0.0.1',
      })
      assert(mapped.status === 200, `::ffff:127.0.0.1 → HTTP ${mapped.status}`)
      return 'http://127.0.0.1 + [::1] + ::ffff:127.0.0.1 accepted'
    })

    /* ── authorization gates (§1.3) ─────────────────────────────────────── */

    section('authorization (CONTRACT §1.3)')

    await scenario('H12 GET /api/env without a token → 401 unauthorized', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/env',
        token: null,
      })
      expectError(result, 401, 'unauthorized')
      assert(
        /application\/json/.test(String(result.headers['content-type'] ?? '')),
        `content-type is ${JSON.stringify(result.headers['content-type'])}`,
      )
      return '401 + JSON unauthorized envelope'
    })
    await scenario('H13 GET /api/env with a wrong token → 401 unauthorized', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/env',
        token: 'f'.repeat(48),
      })
      expectError(result, 401, 'unauthorized')
      return 'wrong token → 401'
    })
    await scenario('H14 valid token + Origin: http://evil.example → 403 forbidden', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print(1)' },
        origin: 'http://evil.example',
      })
      expectError(result, 403, 'forbidden')
      return 'cross-origin → 403'
    })
    await scenario('H15 valid token + sec-fetch-site: cross-site → 403 forbidden', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/env',
        secFetchSite: 'cross-site',
      })
      expectError(result, 403, 'forbidden')
      return 'cross-site → 403'
    })
    await scenario('H16 valid token + same-origin / same-authority proxy Origin is accepted', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/env',
        origin: ORIGIN,
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json?.ok === true, 'ok is not true')
      // CONTRACT §1.3: hostname[:port] may match the Host header with a different
      // scheme behind a reverse proxy.
      const proxied = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/env',
        origin: ORIGIN.replace('http:', 'https:'),
      })
      assert(proxied.status === 200, `same-authority proxy origin → HTTP ${proxied.status}`, truncate(proxied.text))
      return 'same-origin + same-authority https proxy origin allowed'
    })
    await scenario('H17 OPTIONS and mismatched methods → 405 method-not-allowed, no CORS', () => {
      return (async () => {
        const options = await callPluginApi(harness, {
          method: 'OPTIONS',
          pathname: '/dsh-code-runner/api/env',
          token: null,
        })
        expectError(options, 405, 'method-not-allowed')
        assert(
          !options.headers['access-control-allow-origin'] &&
            !options.headers['access-control-allow-methods'],
          'CORS headers leaked',
        )
        const mismatch = await callPluginApi(harness, {
          method: 'POST',
          pathname: '/dsh-code-runner/api/env',
        })
        expectError(mismatch, 405, 'method-not-allowed')
        return 'OPTIONS + POST /api/env → 405, CORS headers absent'
      })()
    })
    await scenario('H18 unknown route → 404 unknown-route', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/nope',
      })
      expectError(result, 404, 'unknown-route')
      return '404 unknown-route'
    })
    await scenario('H19 unknown run → 404 unknown-run', async () => {
      const output = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: { runId: 'does-not-exist' },
      })
      expectError(output, 404, 'unknown-run')
      const stop = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/stop',
        body: { runId: 'does-not-exist' },
      })
      expectError(stop, 404, 'unknown-run')
      return 'output + stop → 404 unknown-run'
    })
    await scenario('H20 GET /api/output without runId → 400 bad-request', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
      })
      expectError(result, 400, 'bad-request')
      return '400 bad-request'
    })

    /* ── /api/env (§1.6) ────────────────────────────────────────────────── */

    section('/api/env (CONTRACT §1.6)')

    let env = null
    await scenario('H21 GET /api/env → 200 JSON envelope with platform posix', async () => {
      const result = await callPluginApi(harness, { pathname: '/dsh-code-runner/api/env' })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(
        /application\/json/.test(String(result.headers['content-type'] ?? '')),
        `content-type is ${JSON.stringify(result.headers['content-type'])}`,
      )
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(json.platform === 'posix', `platform is ${JSON.stringify(json.platform)}`)
      env = json
      return '200 application/json, ok:true, platform:posix'
    })
    await scenario('H22 env.defaultCwd is the absolute default cwd', () => {
      assert(env, 'env unavailable')
      assert(typeof env.defaultCwd === 'string' && path.isAbsolute(env.defaultCwd), `defaultCwd=${JSON.stringify(env.defaultCwd)}`)
      assert(env.defaultCwd === process.cwd(), `defaultCwd ${env.defaultCwd} !== process.cwd() ${process.cwd()}`)
      return env.defaultCwd
    })
    await scenario('H23 env.tmpRoot is an absolute path', () => {
      assert(env, 'env unavailable')
      assert(typeof env.tmpRoot === 'string' && path.isAbsolute(env.tmpRoot), `tmpRoot=${JSON.stringify(env.tmpRoot)}`)
      return env.tmpRoot
    })
    await scenario('H24 env.limits match CONTRACT-V2 §1.2 exactly', () => {
      assert(env, 'env unavailable')
      const expected = {
        codeMaxBytes: 1_048_576,
        outputMaxBytes: 2_097_152,
        defaultTimeoutMs: 300_000,
        maxTimeoutMs: 1_800_000,
        fileMaxBytes: 1_048_576,
        blobMaxBytes: 16_777_216,
        artifactMax: 40,
        explainMaxChars: 20_000,
      }
      const actual = env.limits ?? {}
      const wrong = Object.entries(expected).filter(([key, value]) => actual[key] !== value)
      assert(wrong.length === 0, `wrong limit(s): ${wrong.map(([key]) => `${key}=${JSON.stringify(actual[key])} (expected ${expected[key]})`).join(', ')}`)
      const extras = Object.keys(actual).filter((key) => !(key in expected))
      assert(extras.length === 0, `unexpected limit key(s): ${extras.join(', ')}`)
      return JSON.stringify(actual)
    })
    await scenario('H25 env.languages lists all 12 languages in the v3 language order', () => {
      assert(env, 'env unavailable')
      const expectedOrder = [
        'python', 'r', 'matlab', 'node', 'bash', 'zsh', 'ruby', 'perl', 'julia', 'deno', 'bun', 'php',
      ]
      const actual = Array.isArray(env.languages) ? env.languages.map((entry) => entry.id) : null
      assert(actual, 'languages is not an array')
      assert(
        JSON.stringify(actual) === JSON.stringify(expectedOrder),
        `language ids/order are ${JSON.stringify(actual)}`,
      )
      return actual.join(', ')
    })
    await scenario('H26 every language entry has id/label/available/command/version/template', () => {
      assert(env, 'env unavailable')
      for (const entry of env.languages) {
        assert(typeof entry.id === 'string' && entry.id, `bad id on ${JSON.stringify(entry)}`)
        assert(typeof entry.label === 'string' && entry.label, `bad label on ${entry.id}`)
        assert(typeof entry.available === 'boolean', `bad available on ${entry.id}`)
        assert(
          entry.command === null || typeof entry.command === 'string',
          `bad command on ${entry.id}`,
        )
        assert(entry.version === null || typeof entry.version === 'string', `bad version on ${entry.id}`)
        assert(
          typeof entry.template === 'string' && entry.template.trim().length > 0,
          `empty template on ${entry.id}`,
        )
        assert(Array.isArray(entry.extensions), `${entry.id} has no extensions array`)
        assert(entry.extensions.length > 0, `${entry.id} has an empty extensions array`)
        assert(
          entry.extensions.every((ext) => typeof ext === 'string' && ext.length > 0 && ext === ext.toLowerCase()),
          `${entry.id} extensions are not lowercase strings: ${JSON.stringify(entry.extensions)}`,
        )
        if (entry.available) {
          assert(typeof entry.command === 'string' && entry.command.length > 0, `${entry.id} available without command`)
          if (entry.id === 'matlab') {
            assert(entry.version === null, `matlab version should stay null (skipVersionProbe), got ${JSON.stringify(entry.version)}`)
          } else {
            assert(typeof entry.version === 'string' && entry.version.length > 0, `${entry.id} available without version`)
          }
        }
      }
      return 'all 12 entries well-shaped (extensions[], matlab version null)'
    })
    await scenario('H27 python is available with a resolved command and version', () => {
      assert(env, 'env unavailable')
      const python = env.languages.find((entry) => entry.id === 'python')
      assert(python?.available === true, 'python is not available on this machine')
      assert(path.isAbsolute(python.command), `python command is ${JSON.stringify(python.command)}`)
      assert(typeof python.version === 'string' && python.version.length > 0, 'python version is empty')
      return `${python.command} · ${python.version}`
    })
    await scenario('H28 r is available with a resolved command and version', () => {
      assert(env, 'env unavailable')
      const r = env.languages.find((entry) => entry.id === 'r')
      assert(r?.available === true, 'R is not available on this machine')
      assert(path.isAbsolute(r.command), `R command is ${JSON.stringify(r.command)}`)
      assert(typeof r.version === 'string' && r.version.length > 0, 'R version is empty')
      return `${r.command} · ${r.version}`
    })

    /* ── python run round-trip (§1.7, §1.8) ─────────────────────────────── */

    section('python run round-trip (CONTRACT §1.7, §1.8)')

    let pythonRun = null
    await scenario('H29 POST /api/run (python) replies immediately with the §1.7 shape', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print("hello", 2+2)' },
      })
      pythonRun = expectRunReply(reply, 'python')
      runScriptPaths.push(pythonRun.scriptPath)
      assert(pythonRun.timeoutMs === 300_000, `default timeoutMs is ${pythonRun.timeoutMs}`)
      return `runId=${pythonRun.runId} command=${truncate(pythonRun.command, 120)}`
    })
    await scenario('H30 script file exists with mode 0o600 and the exact submitted code', () => {
      assert(pythonRun, 'no python run started')
      assert(existsSync(pythonRun.scriptPath), `script file ${pythonRun.scriptPath} does not exist`)
      const mode = statSync(pythonRun.scriptPath).mode & 0o777
      assert(mode === 0o600, `script mode is 0o${mode.toString(8)} (expected 0o600)`)
      const content = readFileSync(pythonRun.scriptPath, 'utf8')
      assert(content === 'print("hello", 2+2)', `script content is ${JSON.stringify(content)}`)
      return 'mode 0o600, exact code'
    })
    await scenario('H31 python stdout contains "hello 4", exitCode 0, running false', async () => {
      assert(pythonRun, 'no python run started')
      const result = await waitForRun(harness, pythonRun.runId)
      assert(result.stdout.includes('hello 4'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
      assert(result.last.exitCode === 0, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
      assert(result.last.running === false, 'running is not false')
      assert(Number.isInteger(result.last.durationMs) && result.last.durationMs >= 0, 'durationMs is not a number')
      assert(result.last.signal === null, `signal is ${JSON.stringify(result.last.signal)}`)
      assert(result.last.timedOut === false && result.last.stopped === false, 'timedOut/stopped should be false')
      return `stdout=${JSON.stringify(truncate(result.stdout, 60))} exit=${result.last.exitCode} ${result.last.durationMs}ms (${result.polls} polls)`
    })
    await scenario('H32 output reply carries the exact §1.8 field names', async () => {
      assert(pythonRun, 'no python run started')
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: { runId: pythonRun.runId, stdoutFrom: 0, stderrFrom: 0 },
      })
      assert(result.status === 200, `HTTP ${result.status}`)
      const json = result.json
      const required = [
        'ok', 'runId', 'language', 'command', 'scriptPath', 'cwd', 'startedAt', 'running',
        'exitCode', 'signal', 'durationMs', 'timedOut', 'stopped', 'stdout', 'stderr',
      ]
      const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(json, key))
      assert(missing.length === 0, `missing field(s): ${missing.join(', ')}`)
      for (const stream of ['stdout', 'stderr']) {
        const value = json[stream]
        assert(value && typeof value === 'object', `${stream} is not an object`)
        const streamMissing = ['text', 'nextOffset', 'lossy'].filter(
          (key) => !Object.prototype.hasOwnProperty.call(value, key),
        )
        assert(streamMissing.length === 0, `${stream} missing ${streamMissing.join(', ')}`)
        assert(typeof value.text === 'string', `${stream}.text is not a string`)
        assert(Number.isInteger(value.nextOffset), `${stream}.nextOffset is not an integer`)
        assert(typeof value.lossy === 'boolean', `${stream}.lossy is not a boolean`)
      }
      return 'all §1.8 fields present'
    })
    await scenario('H33 byte offsets are non-consuming (re-read from nextOffset yields "")', async () => {
      assert(pythonRun, 'no python run started')
      const first = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: { runId: pythonRun.runId },
      })
      assert(first.status === 200, `first read HTTP ${first.status}`)
      assert(first.json.stdout.text.length > 0, 'first read returned no stdout')
      const second = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: {
          runId: pythonRun.runId,
          stdoutFrom: first.json.stdout.nextOffset,
          stderrFrom: first.json.stderr.nextOffset,
        },
      })
      assert(second.status === 200, `second read HTTP ${second.status}`)
      assert(second.json.stdout.text === '', `re-read stdout is ${JSON.stringify(second.json.stdout.text)}`)
      assert(second.json.stdout.nextOffset === first.json.stdout.nextOffset, 'nextOffset moved without new output')
      return `offsets stable (${first.json.stdout.nextOffset} bytes)`
    })

    /* ── R round-trip ───────────────────────────────────────────────────── */

    section('R run round-trip (CONTRACT §1.7)')

    await scenario('H34 POST /api/run (R) prints "hello R 4" with exitCode 0', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'r', code: 'cat("hello R", 2+2, "\\n")' },
      })
      const run = expectRunReply(reply, 'r')
      runScriptPaths.push(run.scriptPath)
      assert(
        path.basename(run.scriptPath) === 'script.R',
        `R script file is ${path.basename(run.scriptPath)}`,
      )
      const result = await waitForRun(harness, run.runId)
      assert(result.stdout.includes('hello R 4'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
      assert(result.last.exitCode === 0, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
      return `stdout=${JSON.stringify(truncate(result.stdout, 60))} exit=0`
    })

    /* ── error / exit-code propagation ──────────────────────────────────── */

    section('process outcomes (CONTRACT §1.7)')

    await scenario('H35 python runtime error → nonzero exitCode + non-empty stderr', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'raise RuntimeError("verify-boom")' },
      })
      const run = expectRunReply(reply, 'python')
      runScriptPaths.push(run.scriptPath)
      const result = await waitForRun(harness, run.runId)
      assert(Number.isInteger(result.last.exitCode) && result.last.exitCode !== 0, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
      assert(result.stderr.trim().length > 0, 'stderr is empty')
      assert(result.stderr.includes('verify-boom'), `stderr lacks the exception text: ${truncate(result.stderr, 120)}`)
      return `exit=${result.last.exitCode}, stderr=${truncate(result.stderr, 60)}`
    })
    await scenario('H36 python SystemExit(3) propagates exitCode 3', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'raise SystemExit(3)' },
      })
      const run = expectRunReply(reply, 'python')
      runScriptPaths.push(run.scriptPath)
      const result = await waitForRun(harness, run.runId)
      assert(result.last.exitCode === 3, `exitCode is ${JSON.stringify(result.last.exitCode)}`)
      return 'exitCode 3'
    })
    await scenario('H37 stdin is piped as {data: stdin+"\\n"} and readable by the script', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: {
          language: 'python',
          code: 'import sys\ndata = sys.stdin.read()\nprint("stdin:" + data.strip())',
          stdin: 'ping',
        },
      })
      const run = expectRunReply(reply, 'python')
      runScriptPaths.push(run.scriptPath)
      const result = await waitForRun(harness, run.runId)
      assert(result.stdout.includes('stdin:ping'), `stdout was ${JSON.stringify(truncate(result.stdout))}`)
      const spawnSpec = harness.spawnCalls.find((spec) => spec.argv?.includes(run.scriptPath))
      assert(spawnSpec, 'run spawn spec not captured')
      assert(
        spawnSpec.stdio?.stdin && typeof spawnSpec.stdio.stdin === 'object' && spawnSpec.stdio.stdin.data === 'ping\n',
        `stdio.stdin was ${JSON.stringify(spawnSpec.stdio?.stdin)}`,
      )
      return 'stdin:"ping\\n" piped, stdout=stdin:ping'
    })

    /* ── stop / timeout ─────────────────────────────────────────────────── */

    section('stop + timeout (CONTRACT §1.7, §1.9)')

    await scenario('H38 POST /api/stop terminates a long run and reports stopped:true', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'import time\ntime.sleep(30)' },
      })
      const run = expectRunReply(reply, 'python')
      runScriptPaths.push(run.scriptPath)
      await sleep(1_000)
      const runningPoll = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: { runId: run.runId },
      })
      assert(runningPoll.json?.running === true, 'run was not running before the stop request')
      const stopped = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/stop',
        body: { runId: run.runId },
      })
      assert(stopped.status === 200, `stop returned HTTP ${stopped.status}`, truncate(stopped.text))
      assert(stopped.json?.ok === true, 'stop ok is not true')
      assert(stopped.json.stopped === true, `stop replied stopped=${JSON.stringify(stopped.json.stopped)}`)
      assert(stopped.json.runId === run.runId, 'stop runId mismatch')
      const result = await waitForRun(harness, run.runId, { maxMs: 5_000 })
      assert(result.last.running === false, 'run is still running after stop')
      assert(result.last.stopped === true, 'stopped flag is not true on the finished run')
      assert(result.last.signal === 'SIGTERM' || result.last.signal === 'SIGKILL', `signal is ${JSON.stringify(result.last.signal)}`)
      return `stopped after ~1s, poll finished in ${result.polls} poll(s), signal ${result.last.signal}`
    })
    await scenario('H39 timeoutMs clamps to 1000 (min) and 1800000 (max)', async () => {
      const minReply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print("clamp")', timeoutMs: 1 },
      })
      const minRun = expectRunReply(minReply, 'python')
      runScriptPaths.push(minRun.scriptPath)
      assert(minRun.timeoutMs === 1_000, `min clamp gave timeoutMs=${minRun.timeoutMs}`)
      await waitForRun(harness, minRun.runId)
      const maxReply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print("clamp")', timeoutMs: 99_999_999 },
      })
      const maxRun = expectRunReply(maxReply, 'python')
      runScriptPaths.push(maxRun.scriptPath)
      assert(maxRun.timeoutMs === 1_800_000, `max clamp gave timeoutMs=${maxRun.timeoutMs}`)
      await waitForRun(harness, maxRun.runId)
      return '1000 … 1800000 clamped'
    })
    await scenario('H40 run timeout sets timedOut:true and terminates the process', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'import time\ntime.sleep(10)', timeoutMs: 1_000 },
      })
      const run = expectRunReply(reply, 'python')
      runScriptPaths.push(run.scriptPath)
      assert(run.timeoutMs === 1_000, 'timeoutMs was not applied')
      const result = await waitForRun(harness, run.runId, { maxMs: 8_000 })
      assert(result.last.timedOut === true, 'timedOut is not true after the timeout')
      assert(result.last.running === false, 'run still running after timeout')
      assert(
        result.last.signal === 'SIGTERM' || result.last.signal === 'SIGKILL',
        `signal is ${JSON.stringify(result.last.signal)}`,
      )
      return `timed out after 1s, signal ${result.last.signal}`
    })

    /* ── request validation (§1.3, §1.7) ────────────────────────────────── */

    section('request validation (CONTRACT §1.3, §1.7)')

    await scenario('H41 unsupported language → 400 unsupported-language', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'nope', code: 'print(1)' },
      })
      expectError(result, 400, 'unsupported-language')
      return '400 unsupported-language'
    })
    await scenario('H42 missing cwd → 400 bad-cwd', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print(1)', cwd: '/does/not/exist' },
      })
      expectError(result, 400, 'bad-cwd')
      return '400 bad-cwd'
    })
    await scenario('H43 relative cwd → 400 bad-cwd', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'print(1)', cwd: 'relative/path' },
      })
      expectError(result, 400, 'bad-cwd')
      return '400 bad-cwd (relative)'
    })
    await scenario('H44 empty/non-string code → 400 bad-request', async () => {
      const empty = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: '' },
      })
      expectError(empty, 400, 'bad-request')
      const nonString = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 42 },
      })
      expectError(nonString, 400, 'bad-request')
      return '400 bad-request (empty + non-string)'
    })
    await scenario('H45 malformed JSON body → 400 bad-json', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        rawBody: '{bad',
      })
      expectError(result, 400, 'bad-json')
      return '400 bad-json'
    })
    await scenario('H46 code over 1 MiB → 413 code-too-large', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'python', code: 'x'.repeat(1_048_576 + 1) },
      })
      expectError(result, 413, 'code-too-large')
      return '413 code-too-large'
    })
    await scenario('H47 request body over 2 MiB → 413 body-too-large', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        rawBody: JSON.stringify({ language: 'python', code: 'x'.repeat(2 * 1_048_576 + 1024) }),
      })
      expectError(result, 413, 'body-too-large')
      return '413 body-too-large'
    })
    await scenario('H48 language-unavailable for a detected-but-missing interpreter', async () => {
      assert(env, 'env unavailable')
      const unavailable = env.languages.find((entry) => entry.id !== 'python' && entry.available === false)
      if (!unavailable) {
        skip('H48 language-unavailable for a detected-but-missing interpreter', 'every language is installed on this machine')
        return 'checked separately'
      }
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: unavailable.id, code: 'print(1)' },
      })
      expectError(result, 400, 'language-unavailable')
      return `${unavailable.id} → 400 language-unavailable`
    })
    await scenario('H49 run spawn spec matches CONTRACT §1.7', async () => {
      const runSpecs = harness.spawnCalls.filter(
        (spec) => Array.isArray(spec.argv) && spec.argv.some((argument) => /script\.[A-Za-z]+$/.test(String(argument))),
      )
      assert(runSpecs.length > 0, 'no run spawn specs captured')
      const spec = runSpecs[0]
      assert(spec.graceMs === 2_000, `graceMs is ${JSON.stringify(spec.graceMs)}`)
      assert(
        JSON.stringify(spec.stdio.stdout) === JSON.stringify({ maxBytes: 2_097_152, spill: { maxBytes: 16_777_216 } }),
        `stdout collect mode is ${JSON.stringify(spec.stdio.stdout)}`,
      )
      assert(
        JSON.stringify(spec.stdio.stderr) === JSON.stringify({ maxBytes: 2_097_152, spill: { maxBytes: 16_777_216 } }),
        `stderr collect mode is ${JSON.stringify(spec.stdio.stderr)}`,
      )
      assert(spec.env?.TERM === 'dumb', `env.TERM is ${JSON.stringify(spec.env?.TERM)}`)
      assert(spec.env?.NO_COLOR === '1', `env.NO_COLOR is ${JSON.stringify(spec.env?.NO_COLOR)}`)
      assert(spec.env?.PYTHONUNBUFFERED === '1', `env.PYTHONUNBUFFERED is ${JSON.stringify(spec.env?.PYTHONUNBUFFERED)}`)
      assert(spec.env?.PYTHONIOENCODING === 'utf-8', `env.PYTHONIOENCODING is ${JSON.stringify(spec.env?.PYTHONIOENCODING)}`)
      assert(spec.env?.MPLBACKEND === 'Agg', `env.MPLBACKEND is ${JSON.stringify(spec.env?.MPLBACKEND)}`)
      return 'argv/cwd/stdio/env/graceMs per contract'
    })
    await scenario('H50 version probes use collect mode maxBytes 4096 with 3s timeout', () => {
      const probeSpecs = harness.spawnCalls.filter(
        (spec) => Array.isArray(spec.argv) && spec.argv.length === 2 && spec.argv[1] === '--version',
      )
      assert(probeSpecs.length > 0, 'no version probe spawn specs captured')
      for (const spec of probeSpecs) {
        assert(spec.graceMs === 1_000, `probe graceMs is ${JSON.stringify(spec.graceMs)}`)
        assert(
          spec.stdio?.stdout?.maxBytes === 4_096 && spec.stdio?.stderr?.maxBytes === 4_096,
          `probe collect maxBytes is ${JSON.stringify(spec.stdio?.stdout)}`,
        )
      }
      return `${probeSpecs.length} probes with maxBytes 4096`
    })
    await scenario('H51 handler never threw across every request', () => {
      assert(harness.handlerThrows === 0, `${harness.handlerThrows} throw(s) out of ${harness.requestCount} requests`)
      return `${harness.requestCount} requests, 0 throws`
    })


    /* ═══════════ CONTRACT-V2: files API (§1.6–§1.8) ══════════════════════ */

    section('v2 files API (CONTRACT-V2 §1.6–§1.8)')

    const filesDir = await makeTempDir()
    await mkdir(path.join(filesDir, 'zeta'), { recursive: true })
    await writeFile(path.join(filesDir, 'a.txt'), 'alpha\n')
    await writeFile(path.join(filesDir, 'B.txt'), 'beta\n')
    await writeFile(path.join(filesDir, '.hidden'), 'dot\n')
    await writeFile(path.join(filesDir, 'shot.png'), PNG_1PX)
    try {
      await symlink(path.join(filesDir, 'missing-target'), path.join(filesDir, 'broken-link'))
    } catch {
      /* symlinks may be unavailable in the temp filesystem */
    }

    await scenario('H54 GET /api/files lists directories first with the v2 entry shape (v2 §1.6)', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/files',
        query: { dir: filesDir },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(json.dir === filesDir, `dir is ${JSON.stringify(json.dir)}`)
      assert(json.parent === path.dirname(filesDir), `parent is ${JSON.stringify(json.parent)}`)
      assert(Array.isArray(json.entries), 'entries is not an array')
      assert(json.truncated === false, 'truncated should be false')
      const names = json.entries.map((entry) => entry.name)
      for (const expectedName of ['zeta', 'a.txt', 'B.txt', '.hidden', 'shot.png']) {
        assert(names.includes(expectedName), `${expectedName} missing from the listing`)
      }
      const dirIndex = names.indexOf('zeta')
      assert(json.entries[dirIndex].isDir === true, 'zeta is not classified as a directory')
      assert(
        json.entries.slice(0, dirIndex).every((entry) => entry.isDir),
        'directories are not listed before files',
      )
      assert(names.indexOf('a.txt') < names.indexOf('B.txt'), 'files are not sorted case-insensitively')
      const fileEntry = json.entries.find((entry) => entry.name === 'B.txt')
      assert(fileEntry.path === path.join(filesDir, 'B.txt'), 'entry.path mismatch')
      assert(fileEntry.isDir === false && fileEntry.size === 5, `bad file entry ${JSON.stringify(fileEntry)}`)
      assert(Number.isFinite(fileEntry.mtimeMs) && fileEntry.mtimeMs > 0, `entry mtimeMs is ${JSON.stringify(fileEntry.mtimeMs)}`)
      assert(fileEntry.ext === 'txt', `ext is ${JSON.stringify(fileEntry.ext)} (expected lowercase "txt")`)
      const broken = json.entries.find((entry) => entry.name === 'broken-link')
      if (broken) {
        assert(broken.isDir === false, 'broken symlink should classify as a file')
        assert(broken.size === null && broken.mtimeMs === null, 'broken symlink should carry null size/mtimeMs')
      }
      return `${json.entries.length} entries: dirs-first, case-insensitive sort, lowercase ext`
    })

    await scenario('H55 GET /api/files caps at 2000 entries and flags truncated (v2 §1.6)', async () => {
      const bigDir = await makeTempDir('dcr-verify-host-big-')
      for (let start = 0; start < 2001; start += 100) {
        const batch = []
        for (let index = start; index < Math.min(2001, start + 100); index += 1) {
          batch.push(writeFile(path.join(bigDir, `f${String(index).padStart(4, '0')}.txt`), 'x'))
        }
        await Promise.all(batch)
      }
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/files',
        query: { dir: bigDir },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.entries.length === 2000, `entries length is ${result.json.entries.length}`)
      assert(result.json.truncated === true, 'truncated is not true for 2001 entries')
      return '2001 entries → 2000 entries + truncated:true'
    })

    await scenario('H56 GET /api/files rejects relative/missing dirs with 400 bad-path (v2 §1.6)', async () => {
      const relative = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/files',
        query: { dir: 'relative/dir' },
      })
      expectError(relative, 400, 'bad-path')
      const missing = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/files',
        query: { dir: '/does/not/exist/dcr-verify' },
      })
      expectError(missing, 400, 'bad-path')
      const absent = await callPluginApi(harness, { pathname: '/dsh-code-runner/api/files' })
      expectError(absent, 400, 'bad-path')
      return 'relative + missing + absent dir → 400 bad-path'
    })

    const readDir = await makeTempDir()
    const readPath = path.join(readDir, 'hello.txt')
    await writeFile(readPath, 'line1\nline2\n')

    await scenario('H57 GET /api/file returns the v2 text shape (v2 §1.7)', async () => {
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: readPath },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(json.path === readPath, `path is ${JSON.stringify(json.path)}`)
      assert(json.text === 'line1\nline2\n', `text is ${JSON.stringify(json.text)}`)
      assert(json.size === 12, `size is ${JSON.stringify(json.size)}`)
      assert(Number.isFinite(json.mtimeMs) && json.mtimeMs > 0, `mtimeMs is ${JSON.stringify(json.mtimeMs)}`)
      assert(json.ext === 'txt', `ext is ${JSON.stringify(json.ext)}`)
      assert(json.truncated === false && json.binary === false, 'truncated/binary should be false')
      return 'text/size/mtimeMs/ext/truncated/binary shape ok'
    })

    await scenario('H58 GET /api/file truncates text above fileMaxBytes (v2 §1.7)', async () => {
      const bigTextPath = path.join(readDir, 'big.txt')
      await writeFile(bigTextPath, Buffer.alloc(1_048_576 + 100, 0x61))
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: bigTextPath },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.truncated === true, 'truncated is not true for a >1 MiB file')
      assert(result.json.size === 1_048_676, `size is ${result.json.size}`)
      assert(result.json.text.length <= 1_048_576, `text length is ${result.json.text.length}`)
      assert(result.json.binary === false, 'text file classified as binary')
      return `size=${result.json.size}, text head ${result.json.text.length} chars, truncated:true`
    })

    await scenario('H59 GET /api/file detects binary content (NUL byte) (v2 §1.7)', async () => {
      const binaryPath = path.join(readDir, 'binary.bin')
      await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]))
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: binaryPath },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.binary === true, 'binary is not true for a NUL-byte file')
      assert(result.json.text === '', 'binary read returned text')
      assert(result.json.truncated === false, 'binary read set truncated')
      assert(result.json.size === 5, `size is ${result.json.size}`)
      return 'binary:true, text:"", size=5'
    })

    await scenario('H60 GET /api/file errors: not-found / bad-path (v2 §1.7)', async () => {
      const missing = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: path.join(readDir, 'nope.txt') },
      })
      expectError(missing, 404, 'not-found')
      const directory = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: readDir },
      })
      expectError(directory, 400, 'bad-path')
      const relative = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/file',
        query: { path: 'relative.txt' },
      })
      expectError(relative, 400, 'bad-path')
      return '404 not-found, 400 bad-path (directory + relative)'
    })

    const saveDir = await makeTempDir()
    const savePath = path.join(saveDir, 'saved.py')

    await scenario('H61 POST /api/file creates a missing file with the v2 reply shape (v2 §1.8)', async () => {
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: savePath, text: 'print("saved")\n' },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(json.path === savePath, 'path mismatch')
      assert(json.size === 15, `size is ${json.size}`)
      assert(Number.isFinite(json.mtimeMs) && json.mtimeMs > 0, `mtimeMs is ${JSON.stringify(json.mtimeMs)}`)
      assert(json.ext === 'py', `ext is ${JSON.stringify(json.ext)}`)
      assert((await readFile(savePath, 'utf8')) === 'print("saved")\n', 'written content mismatch')
      const mode = (await stat(savePath)).mode & 0o777
      assert(mode === 0o644, `created file mode is 0o${mode.toString(8)} (expected 0o644)`)
      return 'created mode 0o644, reply path/size/mtimeMs/ext ok'
    })

    await scenario('H62 POST /api/file conflict 409 + force overwrite (v2 §1.8)', async () => {
      const before = await stat(savePath)
      await writeFile(savePath, 'external change\n')
      await utimes(savePath, new Date(), new Date(before.mtimeMs + 5_000))
      const stale = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: savePath, text: 'ours\n', baseMtimeMs: before.mtimeMs },
      })
      assert(stale.status === 409, `expected HTTP 409, got ${stale.status}`, truncate(stale.text))
      assert(stale.json?.ok === false, 'conflict response ok is not false')
      assert(stale.json.error?.code === 'conflict', `error.code is ${JSON.stringify(stale.json.error?.code)}`)
      assert(Number.isFinite(stale.json.currentMtimeMs) && stale.json.currentMtimeMs > 0, 'conflict payload lacks a numeric currentMtimeMs')
      assert(Number.isInteger(stale.json.size), 'conflict payload lacks size')
      const forced = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: savePath, text: 'forced\n' },
      })
      assert(forced.status === 200 && forced.json?.ok === true, `force save HTTP ${forced.status}`)
      assert((await readFile(savePath, 'utf8')) === 'forced\n', 'force save did not overwrite')
      return '409 conflict {currentMtimeMs,size}; force (no baseMtimeMs) overwrote'
    })

    await scenario('H63 POST /api/file validation: bad-request / too-large / bad-path (v2 §1.8)', async () => {
      const nonString = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: savePath, text: 42 },
      })
      expectError(nonString, 400, 'bad-request')
      const tooLarge = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: savePath, text: 'x'.repeat(1_048_577) },
      })
      expectError(tooLarge, 413, 'too-large')
      const missingParent = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: path.join(saveDir, 'no-such-dir', 'x.txt'), text: 'x' },
      })
      expectError(missingParent, 400, 'bad-path')
      const directory = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: saveDir, text: 'x' },
      })
      expectError(directory, 400, 'bad-path')
      const relative = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/file',
        body: { path: 'relative.txt', text: 'x' },
      })
      expectError(relative, 400, 'bad-path')
      return '400 bad-request, 413 too-large, 400 bad-path (parent/directory/relative)'
    })

    /* ═══════════ CONTRACT-V2: blob + artifacts (§1.9–§1.10) ══════════════ */

    section('v2 blob + artifacts (CONTRACT-V2 §1.9–§1.10)')

    const blobDir = await makeTempDir()
    const pngPath = path.join(blobDir, 'image.png')
    await writeFile(pngPath, PNG_1PX)

    await scenario('H64 GET /api/blob returns raw PNG bytes with headers (v2 §1.9)', async () => {
      const result = await blobOf(harness, pngPath)
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(
        String(result.headers['content-type'] ?? '').startsWith('image/png'),
        `content-type is ${JSON.stringify(result.headers['content-type'])}`,
      )
      assert(
        Number(result.headers['content-length']) === PNG_1PX.length,
        `content-length is ${JSON.stringify(result.headers['content-length'])}`,
      )
      assert(
        String(result.headers['cache-control'] ?? '').includes('no-store'),
        `cache-control is ${JSON.stringify(result.headers['cache-control'])}`,
      )
      assert(isPng(result.rawBody), 'blob body does not start with the PNG signature')
      assert(result.rawBody.length === PNG_1PX.length, `blob body length is ${result.rawBody.length}`)
      return `${result.rawBody.length}-byte PNG, image/png, content-length, no-store`
    })

    await scenario('H65 GET /api/blob maps the allowlist content types (v2 §1.9)', async () => {
      const pdfPath = path.join(blobDir, 'doc.pdf')
      await writeFile(pdfPath, '%PDF-1.4\n% fake\n')
      const pdf = await blobOf(harness, pdfPath)
      assert(pdf.status === 200, `pdf HTTP ${pdf.status}`, truncate(pdf.text))
      assert(String(pdf.headers['content-type']).startsWith('application/pdf'), `pdf content-type is ${pdf.headers['content-type']}`)
      const svgPath = path.join(blobDir, 'pic.svg')
      await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
      const svg = await blobOf(harness, svgPath)
      assert(svg.status === 200, `svg HTTP ${svg.status}`)
      assert(String(svg.headers['content-type']).startsWith('image/svg+xml'), `svg content-type is ${svg.headers['content-type']}`)
      const jpegPath = path.join(blobDir, 'photo.jpg')
      await writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
      const jpeg = await blobOf(harness, jpegPath)
      assert(jpeg.status === 200, `jpg HTTP ${jpeg.status}`)
      assert(String(jpeg.headers['content-type']).startsWith('image/jpeg'), `jpg content-type is ${jpeg.headers['content-type']}`)
      const txtPath = path.join(blobDir, 'notes.txt')
      await writeFile(txtPath, 'plain text\n')
      const txt = await blobOf(harness, txtPath)
      expectError(txt, 415, 'unsupported-file')
      return 'pdf/svg/jpeg mapped; .txt → 415 unsupported-file'
    })

    await scenario('H66 GET /api/blob errors: bad-path / not-found / too-large (v2 §1.9)', async () => {
      const relative = await blobOf(harness, 'relative.png')
      expectError(relative, 400, 'bad-path')
      const missing = await blobOf(harness, path.join(blobDir, 'missing.png'))
      expectError(missing, 404, 'not-found')
      const hugePath = path.join(blobDir, 'huge.png')
      await writeFile(hugePath, PNG_1PX)
      await truncateFile(hugePath, 16_777_216 + 1)
      const huge = await blobOf(harness, hugePath)
      expectError(huge, 413, 'too-large')
      return '400 bad-path, 404 not-found, 413 too-large'
    })

    await scenario('H67 every v2 route is token-gated — anonymous → 401 unauthorized (v2 §1)', async () => {
      const anonymousCalls = [
        { method: 'GET', pathname: '/dsh-code-runner/api/files', query: { dir: filesDir } },
        { method: 'GET', pathname: '/dsh-code-runner/api/file', query: { path: readPath } },
        { method: 'GET', pathname: '/dsh-code-runner/api/blob', query: { path: pngPath } },
        { method: 'GET', pathname: '/dsh-code-runner/api/artifacts', query: { runId: 'anonymous-probe' } },
        { method: 'POST', pathname: '/dsh-code-runner/api/file', body: { path: savePath, text: 'x' } },
      ]
      for (const anonymousCall of anonymousCalls) {
        const result = await callPluginApi(harness, { ...anonymousCall, token: null })
        expectError(result, 401, 'unauthorized')
      }
      return `${anonymousCalls.length} new routes → 401 unauthorized without the token`
    })

    /* ═══════════ CONTRACT-V2: file-mode runs + plot capture (§1.3) ════════ */

    section('v2 file-mode runs + plot capture (CONTRACT-V2 §1.3–§1.5)')

    const fileModeDir = await makeTempDir()
    const fileModeScript = path.join(fileModeDir, 'filemode.py')
    await writeFile(fileModeScript, 'print("file-mode-py")\n')
    userFilePaths.push(fileModeScript)

    await scenario('H68 file mode runs the on-disk python file without copying (v2 §1.3, §1.4)', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: fileModeScript, cwd: fileModeDir },
      })
      const json = expectRunReplyLoose(reply)
      assert(json.mode === 'file', `mode is ${JSON.stringify(json.mode)}`)
      assert(json.file === fileModeScript, `file is ${JSON.stringify(json.file)}`)
      assert(json.scriptPath === fileModeScript, `scriptPath is ${JSON.stringify(json.scriptPath)} (expected the on-disk path)`)
      assert(json.language === 'python', `language is ${JSON.stringify(json.language)} (extension-inferred)`)
      assert(json.cwd === fileModeDir, `cwd is ${JSON.stringify(json.cwd)}`)
      assert(json.capturePlots === true, 'capturePlots should default to true')
      assert(typeof json.plotDir === 'string' && path.isAbsolute(json.plotDir), 'plotDir is not absolute')
      assert(json.command.includes(fileModeScript), `command does not reference the on-disk file: ${json.command}`)
      const output = await waitForRun(harness, json.runId)
      assert(output.stdout.includes('file-mode-py'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
      assert(output.last.exitCode === 0, `exitCode is ${JSON.stringify(output.last.exitCode)}`)
      assert(existsSync(fileModeScript), 'file-mode run removed the user script from disk')
      assert((await readFile(fileModeScript, 'utf8')) === 'print("file-mode-py")\n', 'file-mode run modified the user script')
      return `mode=file, language=python (inferred), scriptPath=on-disk path, exit 0`
    })

    await scenario('H69 file mode infers language from the extension / rejects unknown (v2 §1.3)', async () => {
      const rScript = path.join(fileModeDir, 'infer.R')
      await writeFile(rScript, 'cat("infer-r\\n")\n')
      userFilePaths.push(rScript)
      const rReply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: rScript, cwd: fileModeDir, capturePlots: false },
      })
      const rRun = expectRunReplyLoose(rReply)
      assert(rRun.language === 'r', `.R file inferred as ${JSON.stringify(rRun.language)}`)
      const rOutput = await waitForRun(harness, rRun.runId)
      assert(rOutput.stdout.includes('infer-r'), `R stdout was ${JSON.stringify(truncate(rOutput.stdout))}`)
      assert(rOutput.last.exitCode === 0, `R exitCode is ${JSON.stringify(rOutput.last.exitCode)}`)
      const txtScript = path.join(fileModeDir, 'notes.txt')
      await writeFile(txtScript, 'print("x")\n')
      const txtReply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: txtScript, cwd: fileModeDir },
      })
      expectError(txtReply, 400, 'unsupported-language')
      return '.R → r on-disk run ok; .txt → 400 unsupported-language'
    })

    await scenario('H70 file mode errors: bad-path / not-found (v2 §1.3)', async () => {
      const relative = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: 'relative/script.py' },
      })
      expectError(relative, 400, 'bad-path')
      const directory = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: fileModeDir },
      })
      expectError(directory, 400, 'bad-path')
      const missing = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: path.join(fileModeDir, 'missing-file.py') },
      })
      const code = missing.json?.error?.code
      assert(
        (missing.status === 404 && code === 'not-found') || (missing.status === 400 && code === 'bad-path'),
        `missing file gave HTTP ${missing.status} ${JSON.stringify(code)} (expected 404 not-found or 400 bad-path)`,
        truncate(missing.text),
      )
      return 'relative/directory → 400 bad-path; missing → 404 not-found or 400 bad-path'
    })

    let bufferRun = null
    await scenario('H71 explicit buffer mode still works and returns v2 fields (v2 §1.3, §1.4)', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'buffer', language: 'python', code: 'print("buffer-v2")' },
      })
      bufferRun = expectRunReply(reply, 'python')
      assert(bufferRun.mode === 'buffer', `mode is ${JSON.stringify(bufferRun.mode)}`)
      assert(bufferRun.file === null, `file is ${JSON.stringify(bufferRun.file)} (expected null)`)
      assert(bufferRun.capturePlots === true, 'capturePlots should default to true')
      assert(typeof bufferRun.plotDir === 'string' && path.isAbsolute(bufferRun.plotDir), 'plotDir is not absolute')
      const output = await waitForRun(harness, bufferRun.runId)
      assert(output.stdout.includes('buffer-v2'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
      assert(output.last.exitCode === 0, 'buffer run failed')
      return 'mode=buffer, file=null, capturePlots/plotDir present, exit 0'
    })

    await scenario('H72 /api/output carries mode/file/plotDir/capturePlots verbatim (v2 §1.5)', async () => {
      assert(bufferRun, 'no buffer run available')
      const result = await callPluginApi(harness, {
        pathname: '/dsh-code-runner/api/output',
        query: { runId: bufferRun.runId },
      })
      assert(result.status === 200, `HTTP ${result.status}`)
      const json = result.json
      assert(json.mode === bufferRun.mode, `output mode is ${JSON.stringify(json.mode)}`)
      assert(json.file === null, 'output file should be null in buffer mode')
      assert(json.plotDir === bufferRun.plotDir, `output plotDir is ${JSON.stringify(json.plotDir)}`)
      assert(json.capturePlots === bufferRun.capturePlots, 'output capturePlots mismatch')
      return 'mode/file/plotDir/capturePlots present on every poll'
    })

    await scenario('H73 python matplotlib figure captured without savefig → run PNG artifact (v2 §1.3.1)', async () => {
      const plotCwd = await makeTempDir()
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: {
          mode: 'buffer',
          language: 'python',
          code: 'import matplotlib.pyplot as plt\nprint("plot-py")\nplt.plot([1, 2, 3, 4])\n',
          cwd: plotCwd,
        },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.language === 'python', 'language mismatch')
      trackedPlotDirs.push(run.plotDir)
      const output = await waitForRun(harness, run.runId, { maxMs: 45_000 })
      assert(output.stdout.includes('plot-py'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
      assert(output.last.exitCode === 0, `exitCode is ${JSON.stringify(output.last.exitCode)}`)
      const artifacts = await artifactsOf(harness, run.runId)
      const { json, plot } = assertPngArtifact(artifacts, 'run', 'python plot capture')
      assert(plot.path.startsWith(json.plotDir), 'artifact path is outside plotDir')
      const blob = await blobOf(harness, plot.path)
      assert(blob.status === 200, `artifact blob HTTP ${blob.status}`, truncate(blob.text))
      assert(String(blob.headers['content-type']).startsWith('image/png'), `artifact blob content-type is ${blob.headers['content-type']}`)
      assert(isPng(blob.rawBody), 'artifact blob is not a PNG')
      return `source:run ${plot.name} (${plot.size} B) + blob image/png with PNG signature`
    })

    await scenario('H74 R plot(1:10) captured → run PNG artifact (v2 §1.3.2)', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: {
          mode: 'buffer',
          language: 'r',
          code: 'plot(1:10)\ncat("plot-r\\n")\n',
          cwd: await makeTempDir(),
        },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.language === 'r', `language is ${JSON.stringify(run.language)}`)
      trackedPlotDirs.push(run.plotDir)
      const output = await waitForRun(harness, run.runId, { maxMs: 30_000 })
      assert(output.stdout.includes('plot-r'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
      assert(output.last.exitCode === 0, `exitCode is ${JSON.stringify(output.last.exitCode)}`)
      const artifacts = await artifactsOf(harness, run.runId)
      const { plot } = assertPngArtifact(artifacts, 'run', 'R plot capture')
      const blob = await blobOf(harness, plot.path)
      assert(blob.status === 200, `R artifact blob HTTP ${blob.status}`)
      assert(isPng(blob.rawBody), 'R artifact blob is not a PNG')
      return `R source:run ${plot.name} (${plot.size} B) + blob PNG`
    })

    await scenario('H75 cwd images become source:cwd artifacts; capturePlots:false skips run capture (v2 §1.10)', async () => {
      const cwdScanDir = await makeTempDir()
      const cwdImage = path.join(cwdScanDir, 'shot.png')
      await writeFile(cwdImage, PNG_1PX)
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'buffer', language: 'python', code: 'print("cwd-scan")', cwd: cwdScanDir, capturePlots: false },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.capturePlots === false, 'capturePlots should be false')
      const output = await waitForRun(harness, run.runId)
      assert(output.last.exitCode === 0, 'run failed')
      assert(!existsSync(run.plotDir), `plotDir was created despite capturePlots:false (${run.plotDir})`)
      const artifacts = await artifactsOf(harness, run.runId)
      assert(artifacts.status === 200, `artifacts HTTP ${artifacts.status}`)
      const json = artifacts.json
      assert(Array.isArray(json.plots), 'plots is not an array')
      assert(!json.plots.some((entry) => entry.source === 'run'), 'run-source plot exists despite capturePlots:false')
      const cwdItem = json.plots.find((entry) => entry.source === 'cwd' && entry.name === 'shot.png')
      assert(cwdItem, `no source:cwd shot.png artifact (${JSON.stringify(json.plots.map((entry) => entry.name))})`)
      assert(cwdItem.path === cwdImage, `cwd artifact path is ${JSON.stringify(cwdItem.path)}`)
      return 'capturePlots:false → no run plots/plotDir; cwd shot.png listed as source:cwd'
    })

    await scenario('H76 artifact list is deduped and capped at artifactMax=40 (v2 §1.10)', async () => {
      const capDir = await makeTempDir('dcr-verify-host-cap-')
      const writes = []
      for (let index = 0; index < 41; index += 1) {
        writes.push(writeFile(path.join(capDir, `cap-${String(index).padStart(2, '0')}.png`), PNG_1PX))
      }
      await Promise.all(writes)
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'buffer', language: 'python', code: 'print("cap")', cwd: capDir, capturePlots: false },
      })
      const run = expectRunReplyLoose(reply)
      await waitForRun(harness, run.runId)
      const artifacts = await artifactsOf(harness, run.runId)
      assert(artifacts.status === 200, `artifacts HTTP ${artifacts.status}`)
      const json = artifacts.json
      assert(json.plots.length === 40, `plots length is ${json.plots.length} (expected the 40-item cap)`)
      assert(json.truncated === true, 'truncated is not true when the cap cut items')
      const paths = json.plots.map((entry) => entry.path)
      assert(json.plots.every((entry) => entry.source === 'cwd'), 'unexpected non-cwd artifact source')
      assert(new Set(paths).size === paths.length, 'artifact paths are not de-duplicated')
      return '41 cwd images → 40 unique artifacts, truncated:true'
    })

    await scenario('H77 GET /api/artifacts errors: unknown-run / bad-request (v2 §1.10)', async () => {
      const unknown = await artifactsOf(harness, 'no-such-run-id')
      expectError(unknown, 404, 'unknown-run')
      const absent = await callPluginApi(harness, { pathname: '/dsh-code-runner/api/artifacts' })
      expectError(absent, 400, 'bad-request')
      return '404 unknown-run, 400 bad-request'
    })

    await scenario('H78 file-mode matplotlib figure captured → run PNG artifact (v2 §1.3)', async () => {
      const filePlotDir = await makeTempDir()
      const filePlotScript = path.join(filePlotDir, 'plotfile.py')
      await writeFile(filePlotScript, 'import matplotlib.pyplot as plt\nprint("file-plot")\nplt.figure()\nplt.plot([3, 2, 1])\n')
      userFilePaths.push(filePlotScript)
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: filePlotScript, cwd: filePlotDir },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.mode === 'file', 'mode mismatch')
      trackedPlotDirs.push(run.plotDir)
      const output = await waitForRun(harness, run.runId, { maxMs: 45_000 })
      assert(output.stdout.includes('file-plot'), `stdout was ${JSON.stringify(truncate(output.stdout))}`)
      assert(output.last.exitCode === 0, 'file-mode plot run failed')
      const artifacts = await artifactsOf(harness, run.runId)
      const { plot } = assertPngArtifact(artifacts, 'run', 'file-mode plot capture')
      const blob = await blobOf(harness, plot.path)
      assert(blob.status === 200, `file-mode artifact blob HTTP ${blob.status}`)
      assert(isPng(blob.rawBody), 'file-mode artifact blob is not a PNG')
      return `file mode source:run ${plot.name} + PNG blob`
    })

    /* ═══════════ CONTRACT-V3: explain / export / save-plots / MATLAB / diag ═══ */

    section('v3 explain (CONTRACT-V3 §1.2)')

    const explainJsonText = JSON.stringify({
      summary: '这段代码打印一句话。',
      annotatedCode: '# annotated\nprint(1)',
    })

    await scenario('H79 POST /api/explain returns summary + annotatedCode from llm JSON (v3 §1.2)', async () => {
      fakeLlm.state.behavior = { kind: 'text', text: explainJsonText, chunkSize: 7 }
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'python', code: 'print(1)', fileName: null },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(json.summary === '这段代码打印一句话。', `summary is ${JSON.stringify(json.summary)}`)
      assert(json.annotatedCode === '# annotated\nprint(1)', `annotatedCode is ${JSON.stringify(json.annotatedCode)}`)
      assert(json.provider === 'fake-provider', `provider is ${JSON.stringify(json.provider)}`)
      assert(json.model === 'fake-model', `model is ${JSON.stringify(json.model)}`)
      assert(json.truncatedInput === false, 'truncatedInput should be false')
      const options = fakeLlm.state.lastOptions
      assert(options?.provider === 'fake-provider' && options?.model === 'fake-model', 'llm.stream provider/model wiring mismatch')
      assert(typeof options?.system === 'string' && /JSON/i.test(options.system), 'system prompt does not ask for JSON')
      const message = options?.messages?.[0]
      assert(message?.role === 'user', 'llm.stream message role is not user')
      const block = Array.isArray(message?.content) ? message.content[0] : null
      assert(block?.type === 'text' && typeof block.text === 'string', 'llm.stream message content is not a text block')
      assert(block.text.includes('print(1)'), 'user prompt does not carry the code')
      return '200, summary+annotatedCode parsed, provider/model forwarded, prompt wiring ok'
    })

    await scenario('H80 explain tolerates Markdown fences around the JSON (v3 §1.2)', async () => {
      fakeLlm.state.behavior = {
        kind: 'text',
        text: '```json\n' + JSON.stringify({ summary: 'fenced summary', annotatedCode: '# fenced' }) + '\n```',
      }
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'r', code: 'x <- 1', fileName: '/tmp/x.R' },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.summary === 'fenced summary', `summary is ${JSON.stringify(result.json.summary)}`)
      assert(result.json.annotatedCode === '# fenced', `annotatedCode is ${JSON.stringify(result.json.annotatedCode)}`)
      return 'fenced JSON parsed'
    })

    await scenario('H81 explain falls back to raw text when the reply is not JSON (v3 §1.2)', async () => {
      fakeLlm.state.behavior = { kind: 'text', text: 'plain prose answer, not json at all' }
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'python', code: 'print(2)' },
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.ok === true, 'ok is not true')
      assert(result.json.annotatedCode === '', `annotatedCode is ${JSON.stringify(result.json.annotatedCode)}`)
      assert(
        typeof result.json.summary === 'string' && result.json.summary.includes('plain prose'),
        `summary is ${JSON.stringify(result.json.summary)}`,
      )
      return 'invalid JSON → raw summary, empty annotatedCode'
    })

    await scenario('H82 explain truncates input over explainMaxChars (v3 §1.2)', async () => {
      fakeLlm.state.behavior = { kind: 'text', text: explainJsonText }
      const longCode = 'x'.repeat(20_005)
      const result = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'python', code: longCode },
        timeoutMs: 30_000,
      })
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      assert(result.json.truncatedInput === true, 'truncatedInput is not true for a 20005-char code')
      const promptText = fakeLlm.state.lastOptions?.messages?.[0]?.content?.[0]?.text ?? ''
      assert(promptText.length < 20_005 + 2_000, `prompt was not truncated (length ${promptText.length})`)
      return `truncatedInput:true, prompt length ${promptText.length}`
    })

    await scenario('H83 explain → 503 llm-unavailable without the optional services (v3 §1.2)', async () => {
      const llmService = harness.optionalServices.get('llm')
      const modelService = harness.optionalServices.get('agentDefaultModel')
      harness.optionalServices.delete('llm')
      harness.optionalServices.delete('agentDefaultModel')
      try {
        const both = await callPluginApi(harness, {
          method: 'POST',
          pathname: '/dsh-code-runner/api/explain',
          body: { language: 'python', code: 'print(1)' },
        })
        expectError(both, 503, 'llm-unavailable')
        harness.optionalServices.set('agentDefaultModel', modelService)
        const noLlm = await callPluginApi(harness, {
          method: 'POST',
          pathname: '/dsh-code-runner/api/explain',
          body: { language: 'python', code: 'print(1)' },
        })
        expectError(noLlm, 503, 'llm-unavailable')
      } finally {
        harness.optionalServices.set('llm', llmService)
        harness.optionalServices.set('agentDefaultModel', modelService)
      }
      return '503 llm-unavailable (both missing and llm-only missing)'
    })

    await scenario('H84 explain → 504 llm-timeout when the stream stalls (v3 §1.2, 90 s)', async () => {
      fakeLlm.state.behavior = { kind: 'timeout' }
      const startedAt = Date.now()
      // The Host arms its 90 s explain deadline with an unref'ed timer (an HTTP
      // request provides the live handle in production). A stub harness has no
      // such handle, so keep one alive here or Node exits before the timer fires.
      const keepAlive = setInterval(() => {}, 1_000)
      let result = null
      try {
        result = await callPluginApi(harness, {
          method: 'POST',
          pathname: '/dsh-code-runner/api/explain',
          body: { language: 'python', code: 'print(1)' },
          timeoutMs: 120_000,
        })
      } finally {
        clearInterval(keepAlive)
      }
      const elapsed = Date.now() - startedAt
      expectError(result, 504, 'llm-timeout')
      assert(elapsed >= 85_000, `timeout fired after only ${elapsed} ms (expected ~90 s)`)
      assert(elapsed <= 120_000, `timeout fired after ${elapsed} ms (over the bounded wait)`)
      return `504 llm-timeout after ${Math.round(elapsed / 1000)} s`
    })

    await scenario('H85 explain → 502 llm-failed on stream failure (v3 §1.2)', async () => {
      fakeLlm.state.behavior = { kind: 'finish-error', message: 'provider exploded' }
      const finishError = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'python', code: 'print(1)' },
      })
      expectError(finishError, 502, 'llm-failed')
      fakeLlm.state.behavior = { kind: 'throw', message: 'stream threw' }
      const thrown = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/explain',
        body: { language: 'python', code: 'print(1)' },
      })
      expectError(thrown, 502, 'llm-failed')
      return 'finish.error and thrown streams → 502 llm-failed'
    })

    /* ── export (§1.3) ──────────────────────────────────────────────────── */

    section('v3 export report (CONTRACT-V3 §1.3)')

    const exportBase = await makeTempDir()
    const exportPlotSrc = await makeTempDir()
    const exportPngA = path.join(exportPlotSrc, 'plot-001.png')
    const exportPngB = path.join(exportPlotSrc, 'plot-002.png')
    await writeFile(exportPngA, PNG_1PX)
    await writeFile(exportPngB, PNG_1PX)
    const exportCode = 'print("<script>alert(1)</script>")\nplot(1:10)\n'
    const exportBody = {
      language: 'r',
      mode: 'buffer',
      file: null,
      cwd: exportBase,
      command: 'Rscript --vanilla /tmp/fake/plot-wrapper.R',
      code: exportCode,
      stdout: 'hello out\n',
      stderr: 'warn err\n',
      exitCode: 0,
      durationMs: 1234,
      startedAt: Date.now() - 5_000,
      summary: 'AI 摘要：画了一张图。',
      plots: [
        { path: exportPngA, name: 'plot-001.png', source: 'run' },
        { path: exportPngB, name: 'plot-002.png', source: 'cwd' },
      ],
      format: 'all',
      include: { code: true, output: true, plots: true, summary: true },
      name: 'chart',
    }
    const reportsRoot = path.join(exportBase, 'dsh-code-runner-reports')
    const postExport = (body) =>
      callPluginApi(harness, { method: 'POST', pathname: '/dsh-code-runner/api/export', body })

    let firstExport = null
    await scenario('H86 POST /api/export writes a fresh report folder (v3 §1.3)', async () => {
      const result = await postExport(exportBody)
      assert(result.status === 200, `HTTP ${result.status}`, truncate(result.text))
      const json = result.json
      assert(json?.ok === true, 'ok is not true')
      assert(typeof json.folder === 'string' && path.isAbsolute(json.folder), 'folder is not absolute')
      assert(json.folder.startsWith(reportsRoot + path.sep), `folder is not under ${reportsRoot}: ${json.folder}`)
      assert(/^\d{8}-\d{6}-r$/.test(path.basename(json.folder)), `folder name is ${path.basename(json.folder)}`)
      assert(json.baseName === 'chart实验报告', `baseName is ${JSON.stringify(json.baseName)}`)
      assert(json.reportPath === path.join(json.folder, 'chart实验报告.md'), 'reportPath mismatch')
      assert(json.htmlPath === path.join(json.folder, 'chart实验报告.html'), 'htmlPath mismatch')
      assert(json.docxPath === path.join(json.folder, 'chart实验报告.docx'), 'docxPath mismatch')
      assert(existsSync(json.reportPath) && existsSync(json.htmlPath), 'md/html were not written')
      assert(existsSync(json.docxPath), 'docx was not written')
      const docxBytes = await readFile(json.docxPath)
      assert(docxBytes.length > 1000 && docxBytes[0] === 0x50 && docxBytes[1] === 0x4b, 'docx is not a PK zip')
      assert(existsSync(path.join(json.folder, 'run.json')), 'run.json was not written')
      assert(json.plotFiles.includes('plots/plot-001.png'), `plotFiles lacks plots/plot-001.png: ${JSON.stringify(json.plotFiles)}`)
      assert(json.plotFiles.includes('plots/plot-002.png'), 'plotFiles lacks plots/plot-002.png')
      for (const entryName of ['chart实验报告.md', 'chart实验报告.html', 'chart实验报告.docx', 'run.json', 'plots/plot-001.png', 'plots/plot-002.png']) {
        assert(json.files.includes(entryName), `files[] lacks ${entryName}: ${JSON.stringify(json.files)}`)
        assert(existsSync(path.join(json.folder, entryName)), `missing exported file ${entryName}`)
      }
      assert(
        (await readFile(path.join(json.folder, 'plots/plot-001.png'))).equals(PNG_1PX),
        'copied plot bytes differ from the source',
      )
      const reportMarkdown = await readFile(json.reportPath, 'utf8')
      for (const expected of [
        '# chart实验报告', '## 源代码：', '## 输出结果：', '## 统计图：', '## AI 解读：',
        'plot(1:10)', 'hello out', 'warn err', '(plots/plot-001.png)', '(plots/plot-002.png)', 'AI 摘要',
      ]) {
        assert(reportMarkdown.includes(expected), `report.md lacks ${JSON.stringify(expected)}`)
      }
      const reportHtml = await readFile(json.htmlPath, 'utf8')
      assert(/^<!doctype html>/i.test(reportHtml), 'report.html does not start with <!doctype html>')
      assert(reportHtml.includes('data:image/png;base64,'), 'report.html has no inlined data:image')
      assert(reportHtml.includes('&lt;script&gt;'), 'report.html does not escape the <script> test input')
      assert(!reportHtml.includes('<script>alert(1)</script>'), 'report.html contains an unescaped <script> block')
      assert(reportHtml.includes('plot(1:10)'), 'report.html does not carry the code text')
      assert(/prefers-color-scheme/.test(reportHtml), 'report.html lacks prefers-color-scheme')
      const runJson = JSON.parse(await readFile(path.join(json.folder, 'run.json'), 'utf8'))
      assert(runJson.language === 'r', `run.json language is ${JSON.stringify(runJson.language)}`)
      for (const bodyKey of ['code', 'stdout', 'stderr']) {
        assert(!Object.prototype.hasOwnProperty.call(runJson, bodyKey), `run.json must not contain the ${bodyKey} body`)
      }
      firstExport = json
      return `${path.basename(json.folder)}: md/html/docx + 源代码/输出结果/统计图 sections + escaped HTML + data:image`
    })

    await scenario('H87 export never reuses a folder; same-second collision gets -2 (v3 §1.3)', async () => {
      assert(firstExport, 'first export missing')
      const folders = [firstExport.folder]
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await postExport(exportBody)
        assert(result.status === 200, `extra export HTTP ${result.status}`, truncate(result.text))
        folders.push(result.json.folder)
        assert(existsSync(result.json.folder), `export folder missing: ${result.json.folder}`)
      }
      const baseOf = (folder) => path.basename(folder).replace(/-\d+$/, '')
      const collision = folders.find(
        (folder, index) => index > 0 && folders.slice(0, index).some((previous) => baseOf(previous) === baseOf(folder)),
      )
      assert(collision, `no same-second collision across ${folders.length} rapid exports: ${folders.map((f) => path.basename(f)).join(', ')}`)
      const sameBase = folders.filter((folder) => baseOf(folder) === baseOf(collision))
      assert(new Set(folders).size === folders.length, 'export reused an existing folder path')
      assert(
        sameBase.some((folder) => /-\d+$/.test(path.basename(folder))),
        'collision folder lacks the -2/-3 suffix',
      )
      return `fresh folders, collision suffix: ${sameBase.map((f) => path.basename(f)).join(' / ')}`
    })

    await scenario('H88 export validation errors + missing plot skipped (v3 §1.3)', async () => {
      const badCwd = await postExport({ ...exportBody, cwd: '/does/not/exist', plots: [] })
      expectError(badCwd, 400, 'bad-cwd')
      const relativeFile = await postExport({ ...exportBody, file: 'relative.R', plots: [] })
      expectError(relativeFile, 400, 'bad-path')
      const notesPath = path.join(exportPlotSrc, 'notes.txt')
      await writeFile(notesPath, 'plain\n')
      const unsupported = await postExport({
        ...exportBody,
        plots: [{ path: notesPath, name: 'notes.txt', source: 'run' }],
      })
      expectError(unsupported, 415, 'unsupported-file')
      const missingPlot = await postExport({
        ...exportBody,
        plots: [{ path: path.join(exportPlotSrc, 'missing.png'), name: 'missing.png', source: 'run' }],
      })
      assert(missingPlot.status === 200, `missing-plot export HTTP ${missingPlot.status}`, truncate(missingPlot.text))
      assert(missingPlot.json.plotFiles.length === 0, `missing plot was copied: ${JSON.stringify(missingPlot.json.plotFiles)}`)
      return 'bad-cwd / bad-path / unsupported-file; missing plot skipped'
    })

    /* ── save-plots (§1.4) ──────────────────────────────────────────────── */

    section('v3 save-plots (CONTRACT-V3 §1.4)')

    const savePlotsTarget = path.join(exportBase, 'nested', 'saved-plots')
    const savePlotsBody = {
      plots: [
        { path: exportPngA, name: 'plot-001.png' },
        { path: exportPngB, name: 'plot-002.png' },
      ],
      targetDir: savePlotsTarget,
    }
    const postSavePlots = (body) =>
      callPluginApi(harness, { method: 'POST', pathname: '/dsh-code-runner/api/save-plots', body })

    await scenario('H89 POST /api/save-plots copies + dedupes into the target dir (v3 §1.4)', async () => {
      const first = await postSavePlots(savePlotsBody)
      assert(first.status === 200, `HTTP ${first.status}`, truncate(first.text))
      assert(first.json?.ok === true, 'ok is not true')
      assert(first.json.targetDir === savePlotsTarget, 'targetDir mismatch')
      assert(Array.isArray(first.json.saved) && first.json.saved.length === 2, `saved length is ${first.json.saved?.length}`)
      for (const entry of first.json.saved) {
        assert(typeof entry.source === 'string' && typeof entry.path === 'string', 'saved entry shape bad')
        assert(existsSync(entry.path), `saved file missing: ${entry.path}`)
        assert((await readFile(entry.path)).equals(PNG_1PX), 'saved bytes differ from the source plot')
      }
      const second = await postSavePlots(savePlotsBody)
      assert(second.status === 200, `second call HTTP ${second.status}`)
      assert(second.json.saved.length === 2, 'second save-plots call lost entries')
      const firstPaths = first.json.saved.map((entry) => entry.path)
      const secondPaths = second.json.saved.map((entry) => entry.path)
      assert(
        secondPaths.every((entryPath) => !firstPaths.includes(entryPath)),
        `save-plots overwrote an existing file: ${JSON.stringify(secondPaths)}`,
      )
      assert(secondPaths.every((entryPath) => existsSync(entryPath)), 'deduped copies are missing on disk')
      const sourceBytesStillThere = (await readFile(exportPngA)).equals(PNG_1PX)
      assert(sourceBytesStillThere, 'save-plots modified the source plot')
      const unsupported = await postSavePlots({
        plots: [{ path: path.join(exportPlotSrc, 'notes.txt'), name: 'notes.txt' }],
        targetDir: savePlotsTarget,
      })
      expectError(unsupported, 415, 'unsupported-file')
      const missing = await postSavePlots({
        plots: [{ path: path.join(exportPlotSrc, 'missing.png'), name: 'missing.png' }],
        targetDir: savePlotsTarget,
      })
      expectError(missing, 404, 'not-found')
      const relativeTarget = await postSavePlots({ ...savePlotsBody, targetDir: 'relative/target' })
      expectError(relativeTarget, 400, 'bad-path')
      const hugePlot = path.join(exportPlotSrc, 'huge.png')
      await writeFile(hugePlot, PNG_1PX)
      await truncateFile(hugePlot, 16_777_216 + 1)
      const tooLarge = await postSavePlots({ plots: [{ path: hugePlot, name: 'huge.png' }], targetDir: savePlotsTarget })
      expectError(tooLarge, 413, 'too-large')
      const tooMany = await postSavePlots({
        plots: Array.from({ length: 41 }, (_, index) => ({ path: exportPngA, name: `p${index}.png` })),
        targetDir: savePlotsTarget,
      })
      expectError(tooMany, 400, 'bad-request')
      return 'copy + dedupe + unsupported/not-found/bad-path/too-large/too-many'
    })

    /* ── MATLAB (§1.5) ──────────────────────────────────────────────────── */

    section('v3 MATLAB language (CONTRACT-V3 §1.5)')

    const MATLAB_WRAPPER = [
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

    await scenario('H90 /api/env detects matlab with skipVersionProbe (v3 §1.5)', async () => {
      assert(env, 'env unavailable')
      const matlab = env.languages.find((entry) => entry.id === 'matlab')
      assert(matlab, 'matlab is missing from /api/env languages')
      assert(matlab.available === true, 'matlab should be available via the fake PATH executable')
      assert(matlab.command === fakeMatlabPath, `matlab command is ${JSON.stringify(matlab.command)}`)
      assert(matlab.version === null, `matlab version should be null, got ${JSON.stringify(matlab.version)}`)
      assert(Array.isArray(matlab.extensions) && matlab.extensions.includes('m'), `matlab extensions are ${JSON.stringify(matlab.extensions)}`)
      const probes = harness.spawnCalls.filter(
        (spec) => spec.argv?.[0] === fakeMatlabPath && spec.argv?.includes('--version'),
      )
      assert(probes.length === 0, `matlab was version-probed ${probes.length} time(s) despite skipVersionProbe`)
      return `available, command=${fakeMatlabPath}, version=null, extensions include m, no version probe`
    })

    const matlabRunDir = (reply) => (reply.file ? path.dirname(path.dirname(reply.plotDir)) : path.dirname(reply.scriptPath))

    await scenario('H91 matlab buffer run uses the wrapper + capture env (v3 §1.5)', async () => {
      const code = "figure; plot(1:10)\ndisp('matlab-ok')"
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'matlab', code },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.language === 'matlab', `language is ${JSON.stringify(run.language)}`)
      assert(run.mode === 'buffer', `mode is ${JSON.stringify(run.mode)}`)
      assert(run.capturePlots === true, 'capturePlots should default to true')
      const scriptPath = run.scriptPath
      assert(path.basename(scriptPath) === 'script.m', `buffer-mode script is ${path.basename(scriptPath)}`)
      const runDir = path.dirname(scriptPath)
      const wrapperPath = captureWrapperPath(runDir, 'matlab', 'dsh_plot_wrapper.m')
      assert(existsSync(wrapperPath), 'dsh_plot_wrapper.m was not written')
      const wrapper = await readFile(wrapperPath, 'utf8')
      assert(
        wrapper.replace(/\n+$/, '') === MATLAB_WRAPPER,
        `dsh_plot_wrapper.m bytes do not match CONTRACT-V3 §1.5 (got ${wrapper.length} bytes)`,
      )
      assert((await readFile(scriptPath, 'utf8')) === code, 'script.m content mismatch')
      const spec = harness.spawnCalls.filter((entry) => entry.argv?.[0] === fakeMatlabPath).pop()
      assert(spec, 'no matlab spawn spec captured')
      assert(spec.argv.length === 3 && spec.argv[1] === '-batch', `matlab argv is ${JSON.stringify(spec.argv)}`)
      assert(
        spec.argv[2] === `run("${wrapperPath}")`,
        `matlab wrapper argv is ${JSON.stringify(spec.argv[2])} (expected run("${wrapperPath}"))`,
      )
      assert(spec.env?.DSH_CODE_RUNNER_SCRIPT === scriptPath, 'env DSH_CODE_RUNNER_SCRIPT mismatch')
      assert(spec.env?.DSH_CODE_RUNNER_PLOTS_DIR === run.plotDir, 'env DSH_CODE_RUNNER_PLOTS_DIR mismatch')
      const output = await waitForRun(harness, run.runId)
      assert(output.last.exitCode === 0, `matlab run exitCode is ${JSON.stringify(output.last.exitCode)}`)
      return 'wrapper bytes exact, -batch run("<wrapper>"), capture env, exit 0'
    })

    await scenario('H92 matlab capturePlots:false runs the script directly (v3 §1.5)', async () => {
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { language: 'matlab', code: "disp('direct')", capturePlots: false },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.capturePlots === false, 'capturePlots should be false')
      const spec = harness.spawnCalls.filter((entry) => entry.argv?.[0] === fakeMatlabPath).pop()
      assert(spec.argv.length === 3 && spec.argv[1] === '-batch', `matlab argv is ${JSON.stringify(spec.argv)}`)
      assert(
        spec.argv[2] === `run("${run.scriptPath}")`,
        `direct-run argv is ${JSON.stringify(spec.argv[2])}`,
      )
      assert(!spec.env?.DSH_CODE_RUNNER_PLOTS_DIR, 'capture env leaked into capturePlots:false run')
      assert(!existsSync(path.join(path.dirname(run.scriptPath), 'dsh_plot_wrapper.m')), 'wrapper written for capturePlots:false')
      const output = await waitForRun(harness, run.runId)
      assert(output.last.exitCode === 0, `matlab direct run exitCode is ${JSON.stringify(output.last.exitCode)}`)
      return 'argv run("<script>") without wrapper/capture env'
    })

    await scenario('H93 file mode infers matlab from a .m file (v3 §1.5)', async () => {
      const mDir = await makeTempDir()
      const mFile = path.join(mDir, 'infer.m')
      await writeFile(mFile, "disp('infer-m')\n")
      userFilePaths.push(mFile)
      const reply = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/run',
        body: { mode: 'file', file: mFile, cwd: mDir },
      })
      const run = expectRunReplyLoose(reply)
      assert(run.language === 'matlab', `language is ${JSON.stringify(run.language)}`)
      assert(run.file === mFile, 'file field mismatch')
      const spec = harness.spawnCalls.filter((entry) => entry.argv?.[0] === fakeMatlabPath).pop()
      assert(spec.env?.DSH_CODE_RUNNER_SCRIPT === mFile, 'env DSH_CODE_RUNNER_SCRIPT is not the on-disk .m file')
      const expectedWrapper = captureWrapperPath(path.dirname(run.plotDir), 'matlab', 'dsh_plot_wrapper.m')
      assert(spec.argv[2] === `run("${expectedWrapper}")`, 'wrapper argv mismatch for .m file')
      const output = await waitForRun(harness, run.runId)
      assert(output.last.exitCode === 0, 'matlab .m run failed')
      return '.m file-mode → matlab, on-disk script, wrapper run'
    })

    /* ── auth + diagnostics (v2 §1.12) ──────────────────────────────────── */

    section('v3 route auth + browser diagnostics (CONTRACT-V2 §1.12)')

    await scenario('H94 the 3 new routes are token-gated → 401 anonymous (v3 §1.1)', async () => {
      const anonymousCalls = [
        { method: 'POST', pathname: '/dsh-code-runner/api/explain', body: { language: 'python', code: 'print(1)' } },
        { method: 'POST', pathname: '/dsh-code-runner/api/export', body: { language: 'r', cwd: exportBase, plots: [] } },
        { method: 'POST', pathname: '/dsh-code-runner/api/save-plots', body: { plots: [], targetDir: savePlotsTarget } },
      ]
      for (const anonymousCall of anonymousCalls) {
        const result = await callPluginApi(harness, { ...anonymousCall, token: null })
        expectError(result, 401, 'unauthorized')
      }
      return 'explain/export/save-plots → 401 unauthorized'
    })

    await scenario('H95 POST+GET /api/diag records sanitized events (CONTRACT-V2 §1.12)', async () => {
      const post = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/diag',
        body: {
          event: {
            name: 'surface-mount',
            at: Date.now(),
            detail: {
              mode: 'pane',
              width: 1440,
              'bad key!': 'must be dropped',
              long: 'x'.repeat(700),
              deep: { a: { b: { c: { d: 'too deep' } } } },
            },
          },
        },
      })
      assert(post.status === 200, `POST diag HTTP ${post.status}`, truncate(post.text))
      assert(post.json?.ok === true && post.json.accepted === 1, `diag accepted=${JSON.stringify(post.json?.accepted)}`)
      const batch = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/diag',
        body: {
          events: [
            { name: 'apply', at: 1, detail: { client: 'v3' } },
            { name: 'right-tab', at: 2, detail: { ok: true } },
            { name: 'header-toggle', at: 3, detail: { mounted: true } },
          ],
        },
      })
      assert(batch.status === 200 && batch.json.accepted === 3, `batch diag accepted=${JSON.stringify(batch.json?.accepted)}`)
      const empty = await callPluginApi(harness, {
        method: 'POST',
        pathname: '/dsh-code-runner/api/diag',
        body: {},
      })
      expectError(empty, 400, 'bad-request')
      const listing = await callPluginApi(harness, { pathname: '/dsh-code-runner/api/diag' })
      assert(listing.status === 200, `GET diag HTTP ${listing.status}`, truncate(listing.text))
      const json = listing.json
      assert(json?.ok === true, 'diag ok is not true')
      assert(json.plugin === 'dsh-code-runner', `diag plugin is ${JSON.stringify(json.plugin)}`)
      assert(json.route === '/dsh-code-runner', `diag route is ${JSON.stringify(json.route)}`)
      assert(Array.isArray(json.events) && json.events.length >= 4, `diag events length is ${json.events?.length}`)
      for (const entry of json.events) {
        assert(Number.isInteger(entry.seq), `diag seq is ${JSON.stringify(entry.seq)}`)
        assert(Number.isFinite(entry.receivedAt) && entry.receivedAt > 0, 'diag receivedAt is not a timestamp')
        assert(entry.event && typeof entry.event.name === 'string', 'diag event.name missing')
      }
      const mounted = json.events.filter((entry) => entry.event.name === 'surface-mount').pop()
      assert(mounted, 'posted surface-mount event not found')
      const detail = mounted.event.detail ?? {}
      assert(detail.mode === 'pane', `diag detail.mode is ${JSON.stringify(detail.mode)}`)
      assert(!Object.prototype.hasOwnProperty.call(detail, 'bad key!'), 'unsafe detail key was not dropped')
      if (typeof detail.long === 'string') {
        // CONTRACT-V2 §1.12 caps strings at 600 characters; the implementation
        // may keep a trailing truncation ellipsis, so allow 600 + 1 marker char.
        assert(
          detail.long.length <= 601 && (detail.long.length <= 600 || detail.long.endsWith('…')),
          `detail.long length is ${detail.long.length}`,
        )
      }
      return `accepted 1+3, rejected empty body, GET returned ${json.events.length} sanitized events`
    })

    await scenario('H96 /api/diag keeps the newest 100 events (ring buffer)', async () => {
      for (let batchIndex = 0; batchIndex < 6; batchIndex += 1) {
        const events = Array.from({ length: batchIndex === 5 ? 5 : 20 }, (_, index) => ({
          name: 'ring',
          at: Date.now(),
          detail: { index: batchIndex * 20 + index },
        }))
        const result = await callPluginApi(harness, {
          method: 'POST',
          pathname: '/dsh-code-runner/api/diag',
          body: { events },
        })
        assert(result.status === 200, `ring batch ${batchIndex} HTTP ${result.status}`, truncate(result.text))
      }
      const listing = await callPluginApi(harness, { pathname: '/dsh-code-runner/api/diag' })
      assert(listing.status === 200, `GET diag HTTP ${listing.status}`)
      const events = listing.json.events
      assert(events.length === 100, `ring buffer length is ${events.length} (expected 100)`)
      assert(events[0].seq < events[events.length - 1].seq, 'diag seq is not monotonic')
      return '105 more events → newest 100 retained, seq monotonic'
    })

    /* ── disposal (§1.7) ────────────────────────────────────────────────── */

    section('disposal (CONTRACT §1.7)')

    await scenario('H97 disposal removes the route + transform and terminates every run', async () => {
      assert(harness.routes.length === 1 && harness.taps.length === 1, 'registrations missing before disposal')
      await disposeHarness(harness)
      disposalDone = true
      assert(harness.routes.length === 0, `${harness.routes.length} route(s) survived disposal`)
      assert(harness.taps.length === 0, `${harness.taps.length} transform(s) survived disposal`)
      const deadline = Date.now() + 3_000
      while (harness.children.size > 0 && Date.now() < deadline) {
        for (const child of [...harness.children]) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
        await sleep(50)
      }
      assert(harness.children.size === 0, `${harness.children.size} child process(es) still alive after disposal`)
      return 'route+transform disposed, 0 live children'
    })
    await scenario('H98 disposal removes every retained run directory (incl. plot dirs) and keeps user files', async () => {
      assert(env?.tmpRoot, 'env unavailable')
      const runDirs = [
        ...new Set(
          runScriptPaths
            .map((scriptPath) => path.dirname(scriptPath))
            .filter((dir) => dir.startsWith(env.tmpRoot)),
        ),
      ]
      const plotDirs = [...new Set(trackedPlotDirs)]
      assert(runDirs.length + plotDirs.length > 0, 'no run directories recorded')
      const pending = () => [
        ...runDirs.filter((dir) => existsSync(dir)),
        ...plotDirs.filter((dir) => existsSync(dir)),
      ]
      const deadline = Date.now() + 3_000
      let remaining = pending()
      while (remaining.length > 0 && Date.now() < deadline) {
        await sleep(100)
        remaining = pending()
      }
      assert(
        remaining.length === 0,
        `${remaining.length}/${runDirs.length + plotDirs.length} run/plot dir(s) still exist (e.g. ${remaining[0]})`,
      )
      const missingUserFiles = userFilePaths.filter((filePath) => !existsSync(filePath))
      assert(
        missingUserFiles.length === 0,
        `disposal deleted file-mode user file(s): ${missingUserFiles.join(', ')}`,
      )
      return `${runDirs.length} run dir(s) + ${plotDirs.length} plot dir(s) removed; ${userFilePaths.length} user file(s) kept`
    })
  } finally {
    if (!disposalDone) {
      try {
        await disposeHarness(harness)
      } catch {
        /* ignore */
      }
    }
    for (const child of [...harness.children]) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    try {
      await sleep(50)
    } catch {
      /* ignore */
    }
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fakeLlm.state.behavior = null
    for (const dir of tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* best effort cleanup of the verifier's own temp dirs */
      }
    }
  }

  /* ─────────────────────────────── summary ─────────────────────────────── */

  console.log(`\n${'─'.repeat(66)}`)
  const passed = records.filter((entry) => entry.status === 'PASS').length
  const failed = records.filter((entry) => entry.status === 'FAIL')
  const skipped = records.filter((entry) => entry.status === 'SKIP')
  console.log(
    `host verification: ${passed}/${records.length - skipped.length} checks passed, ${failed.length} failed, ${skipped.length} skipped`,
  )
  if (failed.length > 0) {
    console.log('\nFAILED checks:')
    for (const entry of failed) console.log(`  ✗ ${entry.id}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('\n[FATAL] host verification harness crashed:')
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 2
})
