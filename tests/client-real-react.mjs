/**
 * Optional real-React regression harness for the browser half.
 *
 * `tests/client-smoke.mjs` renders the real `client.js` in a dependency-free
 * miniature React. That is enough for logic, but it cannot catch real React
 * invariants — a `h(Component())` typo (an element object passed as a type)
 * once shipped because the miniature accepted it, while real React threw
 * minified error #130 and the panel's error boundary showed "面板出错了".
 * This harness renders the same slot components with REAL React 18 in jsdom,
 * both modes plus StrictMode, and clicks through the main flows.
 *
 * The plugin itself stays dependency-free; this file needs react@18,
 * react-dom@18 and jsdom in a scratch directory:
 *
 *   mkdir -p /tmp/dcr-real-react && cd /tmp/dcr-real-react
 *   npm init -y
 *   npm i react@18.3.1 react-dom@18.3.1 jsdom@24.1.3
 *   cd /Users/sunchujun/Desktop/deepseek/dsh-code-runner
 *   DCR_REAL_REACT_DIR=/tmp/dcr-real-react node tests/client-real-react.mjs
 *
 * Without those dependencies it prints SKIP and exits 0 (so it can live in the
 * repo and in CI without adding a plugin dependency).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(PLUGIN_DIR, 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

function loadRealReact() {
  const anchors = []
  if (process.env.DCR_REAL_REACT_DIR) anchors.push(path.join(process.env.DCR_REAL_REACT_DIR, 'noop.js'))
  anchors.push(path.join(process.cwd(), 'noop.js'))
  anchors.push(path.join(PLUGIN_DIR, 'noop.js'))
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(anchor)
      const React = requireFrom('react')
      const { createRoot } = requireFrom('react-dom/client')
      const { act } = requireFrom('react-dom/test-utils')
      const { JSDOM } = requireFrom('jsdom')
      return { React, createRoot, act, JSDOM }
    } catch (error) {
      /* try the next anchor */
    }
  }
  return null
}

const deps = loadRealReact()
if (deps === null) {
  console.log('SKIP client-real-react: react/react-dom/jsdom are not resolvable.')
  console.log('  Install them in a scratch dir and point DCR_REAL_REACT_DIR at it, e.g.:')
  console.log('    mkdir -p /tmp/dcr-real-react && cd /tmp/dcr-real-react && npm init -y')
  console.log('    npm i react@18.3.1 react-dom@18.3.1 jsdom@24.1.3')
  console.log('    DCR_REAL_REACT_DIR=/tmp/dcr-real-react node tests/client-real-react.mjs')
  process.exit(0)
}
const { React, createRoot, act, JSDOM } = deps
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ── jsdom page + browser globals ────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body></body></html>', {
  url: 'http://127.0.0.1:57598/',
  pretendToBeVisual: true,
})
const w = dom.window
const media = { matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
w.matchMedia = () => media
w.__DSH_CODE_RUNNER__ = { token: 'harness-token' }
let objectUrls = 0
w.URL.createObjectURL = () => 'blob:harness-' + (++objectUrls)
w.URL.revokeObjectURL = () => {}
globalThis.window = w
globalThis.document = w.document
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true, writable: true })
globalThis.localStorage = w.localStorage
globalThis.HTMLElement = w.HTMLElement
globalThis.Event = w.Event
globalThis.KeyboardEvent = w.KeyboardEvent
globalThis.URL = w.URL
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const consoleErrors = []
const consoleWarn = console.warn
console.error = (...args) => {
  consoleErrors.push(args.map((value) => (value && value.stack ? value.stack : String(value))).join(' '))
}

// ── Fake Host implementing the CONTRACT-V2 wire format ──────────────────────
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const envPayload = {
  ok: true,
  platform: 'posix',
  defaultCwd: '/tmp/harness-cwd',
  tmpRoot: '/tmp/harness-tmp',
  limits: {
    codeMaxBytes: 1048576, outputMaxBytes: 2097152, defaultTimeoutMs: 300000, maxTimeoutMs: 1800000,
    fileMaxBytes: 1048576, blobMaxBytes: 16777216, artifactMax: 40,
  },
  languages: [
    { id: 'python', label: 'Python', available: true, command: '/usr/bin/python3', version: 'Python 3.13', template: 'print("hi")\n' },
    { id: 'r', label: 'R', available: true, command: '/usr/local/bin/Rscript', version: 'R 4.6', template: 'cat("hi\\n")\n' },
  ],
}
const filesPayload = {
  ok: true, dir: '/tmp/harness-cwd', parent: '/tmp', truncated: false,
  entries: [
    { name: 'sub', path: '/tmp/harness-cwd/sub', isDir: true, size: null, mtimeMs: 1730000000000, ext: '' },
    { name: 'script.py', path: '/tmp/harness-cwd/script.py', isDir: false, size: 9, mtimeMs: 1730000000000, ext: 'py' },
    { name: 'notes.txt', path: '/tmp/harness-cwd/notes.txt', isDir: false, size: 5, mtimeMs: 1730000000000, ext: 'txt' },
  ],
}
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])
const fetchLog = []
const diagEvents = []
let outputPolls = 0
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const method = String((init && init.method) || 'GET').toUpperCase()
  fetchLog.push(method + ' ' + url)
  const parsedBody = () => {
    try { return JSON.parse(init.body || '{}') } catch (error) { return {} }
  }
  if (url.indexOf('/api/env') !== -1) return json(envPayload)
  if (url.indexOf('/api/diag') !== -1) {
    const body = parsedBody()
    if (body.event) diagEvents.push(body.event)
    return json({ ok: true, accepted: 1 })
  }
  if (url.indexOf('/api/files') !== -1) return json(filesPayload)
  if (url.indexOf('/api/file') !== -1 && method === 'GET') {
    return json({ ok: true, path: '/tmp/harness-cwd/script.py', text: 'print(1)\n', size: 9, mtimeMs: 1730000000000, ext: 'py', truncated: false, binary: false })
  }
  if (url.indexOf('/api/file') !== -1 && method === 'POST') {
    const body = parsedBody()
    return json({ ok: true, path: body.path, size: String(body.text || '').length, mtimeMs: 1730000000009, ext: 'py' })
  }
  if (url.indexOf('/api/run') !== -1 && method === 'POST') {
    return json({
      ok: true, runId: 'run-1', language: 'python', mode: 'buffer', file: null,
      command: 'python -u script.py', scriptPath: '/tmp/harness/script.py', cwd: '/tmp/harness-cwd',
      startedAt: Date.now(), timeoutMs: 300000, capturePlots: true, plotDir: '/tmp/harness/plots',
    })
  }
  if (url.indexOf('/api/output') !== -1) {
    outputPolls += 1
    const done = outputPolls > 2
    return json({
      ok: true, runId: 'run-1', language: 'python', mode: 'buffer', file: null,
      command: 'python -u script.py', scriptPath: '/tmp/harness/script.py', cwd: '/tmp/harness-cwd',
      startedAt: 1, running: !done, exitCode: done ? 0 : null, signal: null,
      durationMs: done ? 42 : null, timedOut: false, stopped: false,
      capturePlots: true, plotDir: '/tmp/harness/plots',
      stdout: { text: done ? 'hello 4\n' : '', nextOffset: done ? 9 : 0, lossy: false },
      stderr: { text: '', nextOffset: 0, lossy: false },
    })
  }
  if (url.indexOf('/api/artifacts') !== -1) {
    return json({
      ok: true, runId: 'run-1', running: false, plotDir: '/tmp/harness/plots', truncated: false,
      plots: [{ path: '/tmp/harness/plots/plot-001.png', name: 'plot-001.png', source: 'run', size: pngBytes.length, mtimeMs: 1730000000000, ext: 'png' }],
    })
  }
  if (url.indexOf('/api/blob') !== -1) return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
  if (url.indexOf('/api/token') !== -1) return json({ ok: true, token: 'harness-token' })
  if (url.indexOf('/api/stop') !== -1) return json({ ok: true })
  return json({ ok: false, error: { code: 'unknown-route', message: url } }, 404)
}
w.fetch = globalThis.fetch

// ── Load the real client module ─────────────────────────────────────────────
let moduleDefinition = null
w.__ModuleLoader__ = { load(definition) { moduleDefinition = definition } }
const runSource = new Function('window', 'document', 'navigator', 'localStorage', 'fetch', 'React', 'require', SOURCE)
runSource(w, w.document, w.navigator, w.localStorage, globalThis.fetch, React, (name) => {
  if (name === 'react') return React
  throw new Error('client.js requested an unexpected module: ' + name)
})
if (!moduleDefinition || moduleDefinition.id !== 'dsh-code-runner') throw new Error('client.js did not register the module')

// ── Fake Cordis client context ──────────────────────────────────────────────
const registrations = []
const tabDefinitions = []
const localeDict = {}
const services = {
  sidebarRightTabs: { register(definition) { tabDefinitions.push(definition); return () => {} } },
  sidebarRight: { openTab() {}, close() {}, active() { return null }, isExpanded() { return false }, toggleExpanded() {} },
  layout: { selectPanel() {}, openRightbar() {}, closeRightbar() {} },
  uiWorkspace: { pickDirectory: async () => '/tmp/harness-cwd' },
}
const slots = {
  inject(key, callback) {
    const known = ['sidebar.panellist', 'main', 'sidebar.right.pane.tab', 'conversation.session.header.utilities']
    if (known.indexOf(key) === -1) return () => {}
    const off = callback()
    return typeof off === 'function' ? off : () => {}
  },
  register(definition, Component) {
    registrations.push({ definition, Component })
    return () => {}
  },
  registerFactory() { return () => {} },
}
const locale = {
  register(ns, dictionaries) {
    if (dictionaries && dictionaries.zh) Object.assign(localeDict, dictionaries.zh)
    return () => {}
  },
  bind() { return (key) => (key in localeDict ? localeDict[key] : key) },
  getSnapshot() { return { id: 'zh', languages: ['zh'] } },
  getLocale() { return { id: 'zh' } },
  subscribe() { return () => {} },
}
const ctx = {
  slots,
  locale,
  effect(callback) {
    const off = callback()
    return typeof off === 'function' ? off : () => {}
  },
  inject(names, callback) {
    callback({
      slots,
      locale,
      sidebarRight: services.sidebarRight,
      sidebarRightTabs: services.sidebarRightTabs,
      get: (name) => services[name],
    })
    return { dispose() {} }
  },
  get(name) { return services[name] },
  on() { return () => {} },
  provide() { return () => {} },
}
const plugin = moduleDefinition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
plugin.apply(ctx)

const paneRegistration = registrations.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
const pageRegistration = registrations.find((entry) => entry.definition.name === 'main')
if (!paneRegistration || !pageRegistration) throw new Error('workbench registrations missing')

// ── Checks ──────────────────────────────────────────────────────────────────
const results = []
function check(name, ok, extra) {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
}
function all(selector) { return Array.from(w.document.querySelectorAll(selector)) }

async function renderWithRealReact(Component, label, wrap) {
  const host = w.document.createElement('div')
  w.document.body.appendChild(host)
  const root = createRoot(host)
  const element = wrap ? wrap(Component) : React.createElement(Component)
  try {
    await act(async () => { root.render(element) })
    for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
  } catch (error) {
    check(label + ': renders without throwing', false, String(error && error.message))
    try { root.unmount() } catch (ignored) { /* ignore */ }
    host.remove()
    return null
  }
  const crashDetail = host.querySelector('.dcr-crashDetail')
  check(label + ': renders a real surface', Boolean(host.querySelector('.dcr-surface')))
  check(label + ': no error-boundary crash block', !host.querySelector('.dcr-crash'), crashDetail ? crashDetail.textContent : '')
  return { host, root }
}

const pane = await renderWithRealReact(paneRegistration.Component, 'pane mode')
const page = await renderWithRealReact(pageRegistration.Component, 'page mode', (Component) => React.createElement(Component, { t: (key) => key }))
const strict = await renderWithRealReact(paneRegistration.Component, 'pane mode (StrictMode)', (Component) => React.createElement(React.StrictMode, null, React.createElement(Component)))

// Interaction pass on the pane surface.
const host = pane.host
function byText(selector, text) {
  return all(selector).find((node) => (node.textContent || '').indexOf(text) !== -1)
}
async function click(node) {
  if (!node) return false
  await act(async () => { node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })) })
  return true
}
async function settle(milliseconds) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds || 80)) })
}

await click(byText('.dcr-tab', '文件'))
await settle(120)
check('files tab lists the working directory', all('.dcr-fileRow').length >= 3, 'rows=' + all('.dcr-fileRow').length)
const scriptRow = all('.dcr-fileRow').find((node) => (node.textContent || '').indexOf('script.py') !== -1)
await click(scriptRow)
await settle(200)
check('opening a file fills the editor + file chip', (host.querySelector('.dcr-textarea') || {}).value === 'print(1)\n' && (host.querySelector('.dcr-fileChip') || {}).textContent.indexOf('script.py') !== -1)

await click(byText('.dcr-btn', '运行文件'))
for (let index = 0; index < 8; index += 1) await settle(150)
check('run reaches the Host (/api/run posted)', fetchLog.some((line) => line.indexOf('/api/run') !== -1))
check('plots auto-switch renders a captured plot card', all('.dcr-plotCard').length >= 1, 'cards=' + all('.dcr-plotCard').length)
check('plot thumbnail is a blob object URL', Boolean((host.querySelector('.dcr-plotCard img') || {}).src && String(host.querySelector('.dcr-plotCard img').src).indexOf('blob:') === 0))

await click(byText('.dcr-tab', '控制台'))
for (let index = 0; index < 4; index += 1) await settle(120)
check('console shows the streamed output', ((host.querySelector('.dcr-outPre') || {}).textContent || '').indexOf('hello 4') !== -1, JSON.stringify((host.querySelector('.dcr-outPre') || {}).textContent))

await click(byText('.dcr-tab', '图表'))
for (let index = 0; index < 3; index += 1) await settle(120)
await click(host.querySelector('.dcr-plotCardOpen'))
await settle(120)
check('clicking a plot opens the lightbox', Boolean(host.querySelector('.dcr-lightbox')))
await act(async () => { w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
await settle(120)
check('Escape closes the lightbox', !host.querySelector('.dcr-lightbox'))
check('no crash block after interactions', !host.querySelector('.dcr-crash'))

check('diagnostics report apply/right-tab/surface-mount', diagEvents.some((event) => event.name === 'apply') && diagEvents.some((event) => event.name === 'right-tab') && diagEvents.some((event) => event.name === 'surface-mount'))
const reactErrors = consoleErrors.filter((line) => /Error|Uncaught|Warning: React/.test(line))
check('no real-React errors or warnings', reactErrors.length === 0, reactErrors.slice(0, 2).join(' | '))

for (const rendered of [pane, page, strict]) {
  if (!rendered) continue
  try { await act(async () => { rendered.root.unmount() }) } catch (error) { /* ignore */ }
  rendered.host.remove()
}
console.error = consoleWarn

const failed = results.filter((result) => !result.ok)
console.log('\n=== summary ===')
console.log('checks passed: ' + (results.length - failed.length) + ', failed: ' + failed.length)
if (failed.length > 0) {
  for (const failure of failed) console.log(' - ' + failure.name)
  process.exitCode = 1
} else {
  console.log('ALL REAL-REACT CHECKS PASSED')
}
