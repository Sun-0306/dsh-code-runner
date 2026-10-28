#!/usr/bin/env node
/**
 * tests/client-smoke.mjs — headless smoke test for the dsh-code-runner browser half.
 *
 * Loads the real `client.js` in a `vm` sandbox with:
 *   · a miniature React implementation (createElement + hooks + class components +
 *     an error boundary + effect cleanups/unmount),
 *   · a fake Host implementing the CONTRACT-V2 §1 routes (JSON + raw blob),
 *   · fake slot/locale contexts and the optional `sidebarRightTabs` / `sidebarRight`
 *     services, plus the conversation-header utilities seat.
 *
 * Then it drives the real registrations and both surfaces (page + right-pane) end to
 * end: open/save/conflict/dirty-guard, file vs buffer runs, output polling, artifacts
 * → object URLs, lightbox, files navigation, locale parity, unmount/remount and
 * leaked-timer checks.
 *
 * Run: `node tests/client-smoke.mjs` — exits 0 when every check passes.
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

// ── Miniature React ─────────────────────────────────────────────────────────
const FRAGMENT = Symbol('mini-react.fragment')

function depsEqual(left, right) {
  if (!left || !right) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}

function createMiniReact() {
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch
      this.state = Object.assign({}, this.state, next)
      mini.dirty = true
    }
  }

  const mini = {
    dirty: false,
    tree: null,
    rootVNode: null,
    pathCounter: 0,
    componentCounts: {},
    stack: [],
    hookStores: new Map(),
    classInstances: new Map(),
    pendingEffects: [],
    cleanups: [],
    renderCount: 0,
    Fragment: FRAGMENT,
    Component,
    createElement(type, config) {
      const props = Object.assign({}, config)
      const children = Array.prototype.slice.call(arguments, 2)
      if (children.length === 1) props.children = children[0]
      else if (children.length > 1) props.children = children
      return { type, props }
    },
    useState(initial) {
      const store = mini.stack[mini.stack.length - 1]
      const index = store.cursor
      store.cursor += 1
      if (!(index in store.items)) {
        store.items[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const item = store.items[index]
      if (!('setter' in item)) {
        item.setter = function setState(next) {
          const resolved = typeof next === 'function' ? next(item.value) : next
          if (Object.is(resolved, item.value)) return
          item.value = resolved
          mini.dirty = true
        }
      }
      return [item.value, item.setter]
    },
    useRef(initial) {
      const store = mini.stack[mini.stack.length - 1]
      const index = store.cursor
      store.cursor += 1
      if (!(index in store.items)) store.items[index] = { value: { current: initial } }
      return store.items[index].value
    },
    useCallback(fn, deps) {
      const store = mini.stack[mini.stack.length - 1]
      const index = store.cursor
      store.cursor += 1
      const previous = store.items[index]
      if (!previous || !depsEqual(previous.deps, deps)) store.items[index] = { value: fn, deps }
      return store.items[index].value
    },
    useEffect(fn, deps) {
      const store = mini.stack[mini.stack.length - 1]
      const index = store.cursor
      store.cursor += 1
      const previous = store.items[index]
      if (!previous || !depsEqual(previous.deps, deps)) mini.pendingEffects.push({ fn, store, index })
      store.items[index] = { deps }
    },
  }

  function renderChildren(children) {
    if (children === null || children === undefined || children === false || children === true) return []
    if (Array.isArray(children)) {
      const output = []
      for (const child of children) {
        const rendered = renderVNode(child)
        if (Array.isArray(rendered)) output.push(...rendered)
        else if (rendered !== null) output.push(rendered)
      }
      return output
    }
    const rendered = renderVNode(children)
    return Array.isArray(rendered) ? rendered : (rendered === null ? [] : [rendered])
  }

  function renderVNode(vnode) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return null
    if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode)
    if (Array.isArray(vnode)) return renderChildren(vnode)
    if (vnode.type === FRAGMENT) return renderChildren(vnode.props.children)
    if (typeof vnode.type === 'function') {
      const typeName = (typeof vnode.type.name === 'string' && vnode.type.name !== '') ? vnode.type.name : 'anon'
      mini.componentCounts[typeName] = (mini.componentCounts[typeName] || 0) + 1
      const componentPath = 'c:' + typeName + ':' + mini.componentCounts[typeName]
      const prototype = vnode.type.prototype
      if (prototype && typeof prototype.render === 'function') {
        let instance = mini.classInstances.get(componentPath)
        if (!instance) {
          instance = new vnode.type(vnode.props)
          mini.classInstances.set(componentPath, instance)
        }
        instance.props = vnode.props
        try {
          return renderVNode(instance.render())
        } catch (error) {
          if (typeof vnode.type.getDerivedStateFromError !== 'function') throw error
          instance.state = Object.assign({}, instance.state, vnode.type.getDerivedStateFromError(error))
          if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, { componentStack: '' })
          return renderVNode(instance.render())
        }
      }
      let store = mini.hookStores.get(componentPath)
      if (!store) {
        store = { path: componentPath, cursor: 0, items: {} }
        mini.hookStores.set(componentPath, store)
      }
      store.cursor = 0
      mini.stack.push(store)
      let output
      try {
        output = vnode.type(vnode.props || {})
      } finally {
        mini.stack.pop()
      }
      return renderVNode(output)
    }
    if (typeof vnode.type !== 'string') {
      // Real React throws #130 ("Element type is invalid ... got: object") when
      // a caller passes an element object (e.g. h(SomeComponent())) instead of
      // the component. Enforce the same rule here so the harness can never be
      // laxer than the browser (a real crash slipped through this before).
      throw new Error(
        'invalid React element type (' + (vnode.type === null ? 'null' : typeof vnode.type) + '): '
        + 'pass the component itself, do not call it first (React error #130)',
      )
    }
    return {
      tag: vnode.type,
      props: vnode.props || {},
      children: renderChildren((vnode.props || {}).children),
    }
  }

  function runEffects() {
    const effects = mini.pendingEffects
    mini.pendingEffects = []
    for (const effect of effects) {
      if (typeof effect.fn !== 'function') continue
      const previous = effect.store.items[effect.index]
      const cleanup = effect.fn()
      if (typeof cleanup === 'function') mini.cleanups.push(cleanup)
      effect.store.items[effect.index] = { deps: previous ? previous.deps : undefined, cleanup }
    }
  }

  function flush() {
    for (let guard = 0; guard < 400; guard += 1) {
      if (!mini.dirty && mini.pendingEffects.length === 0) return
      mini.dirty = false
      mini.pathCounter = 0
      mini.componentCounts = {}
      mini.renderCount += 1
      mini.tree = renderVNode(mini.rootVNode)
      runEffects()
    }
    throw new Error('render loop did not settle')
  }

  function mount(element) {
    mini.rootVNode = element
    mini.dirty = true
    flush()
  }

  function unmount() {
    const cleanups = mini.cleanups.splice(0)
    for (const cleanup of cleanups) {
      try { cleanup() } catch (error) { /* ignore cleanup failures */ }
    }
    mini.tree = null
    mini.rootVNode = null
    mini.dirty = false
    mini.pendingEffects = []
    mini.hookStores.clear()
    mini.classInstances.clear()
  }

  return {
    React: mini,
    mount,
    unmount,
    flush,
    get tree() { return mini.tree },
    get renderCount() { return mini.renderCount },
  }
}

// ── Tree helpers ────────────────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string') return node
  return node.children.map(textOf).join('')
}

function findAll(node, predicate) {
  const found = []
  walk(node, function visit(candidate) {
    if (predicate(candidate)) found.push(candidate)
  })
  return found
}

function find(node, predicate) {
  const all = findAll(node, predicate)
  return all.length > 0 ? all[0] : null
}

function byTag(tag) {
  return function matchTag(node) { return node.tag === tag }
}

function buttonByText(node, label) {
  return find(node, function matchButton(candidate) {
    return candidate.tag === 'button' && textOf(candidate).trim() === label
  })
}

function buttonByAria(node, label) {
  return find(node, function matchButton(candidate) {
    return candidate.tag === 'button' && candidate.props['aria-label'] === label
  })
}

function textareaNode(node) {
  return find(node, byTag('textarea'))
}

// ── Fake Host world (CONTRACT-V2 §1) ────────────────────────────────────────
const DEFAULT_CWD = '/Users/sunchujun/Desktop/deepseek'

function extensionOf(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function basenameOf(filePath) {
  const parts = String(filePath || '').split(/[\\/]/)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function dirnameOf(filePath) {
  const normalized = String(filePath || '').replace(/[\\/]+$/, '')
  const slash = normalized.lastIndexOf('/')
  if (slash <= 0) return '/'
  return normalized.slice(0, slash)
}

function entryFor(filePath) {
  return {
    name: basenameOf(filePath),
    path: filePath,
    isDir: false,
    size: 16,
    mtimeMs: 1000,
    ext: extensionOf(filePath),
  }
}

function plotFor(filePath, source, name) {
  return {
    path: filePath,
    name: name || basenameOf(filePath),
    source: source || 'run',
    size: 2048,
    mtimeMs: 1730000000000,
    ext: extensionOf(filePath),
  }
}

function createWorld(options) {
  const opts = options || {}
  const cwd = opts.cwd || DEFAULT_CWD
  const scriptPath = cwd + '/script.py'
  const otherPath = cwd + '/other.R'
  const hiddenPath = cwd + '/.hidden.py'
  const notesPath = cwd + '/notes.txt'
  const dataDir = cwd + '/data'
  const nestedPath = dataDir + '/nested.py'
  const pngPath = cwd + '/existing-plot.png'

  const world = {
    cwd,
    scriptPath,
    otherPath,
    hiddenPath,
    notesPath,
    dataDir,
    nestedPath,
    pngPath,
    files: new Map(),
    dirs: new Map(),
    blobs: new Map(),
    saves: [],
    conflicts: new Set(),
    runRequests: [],
    runCount: 0,
    currentRun: null,
    outputPolls: 0,
    outputBuffer: '',
    finishPoll: opts.finishPoll || 6,
    outputChunks: opts.outputChunks || ['hello from python\n'],
    stopRequested: false,
    artifactPolls: 0,
    diagEvents: [],
    packToggles: [],
    packs: [
      { id: 'python', label: 'Python', builtin: true, enabled: true, detected: true, extensions: ['py'], capture: { kind: 'python', required: true, ready: true, installed: true, hint: null } },
      { id: 'r', label: 'R', builtin: true, enabled: true, detected: true, extensions: ['r'], capture: { kind: 'r', required: true, ready: true, installed: true, hint: null } },
      { id: 'c', label: 'C', builtin: false, enabled: false, detected: true, extensions: ['c'], capture: { kind: 'none', required: false, ready: false, installed: false, hint: null } },
      { id: 'julia', label: 'Julia', builtin: true, enabled: true, detected: false, extensions: ['jl'], capture: { kind: 'none', required: false, ready: false, installed: false, hint: null } },
    ],
    artifactsPlan: opts.artifactsPlan || null,
    tokenCalls: 0,
    envCalls: 0,
    explainRequests: [],
    exportRequests: [],
    savePlotsRequests: [],
    pendingRun: null,
    filesCalls: [],
    fileGetCalls: [],
    blobCalls: [],
    outputCalls: 0,
    stopCalls: 0,
    runCalls: 0,
    filesTruncated: false,
  }

  world.files.set(scriptPath, { text: 'print("hello")\n', mtimeMs: 1000, ext: 'py', binary: false, truncated: false, size: 15 })
  world.files.set(otherPath, { text: 'cat("other")\n', mtimeMs: 1000, ext: 'r', binary: false, truncated: false, size: 13 })
  world.files.set(hiddenPath, { text: 'print(".hidden")\n', mtimeMs: 1000, ext: 'py', binary: false, truncated: false, size: 17 })
  world.files.set(notesPath, { text: 'just notes\n', mtimeMs: 1000, ext: 'txt', binary: false, truncated: false, size: 11 })
  world.files.set(nestedPath, { text: 'print("nested")\n', mtimeMs: 1000, ext: 'py', binary: false, truncated: false, size: 17 })
  world.blobs.set(pngPath, { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), type: 'image/png' })

  world.dirs.set(cwd, [
    entryFor(scriptPath),
    entryFor(otherPath),
    entryFor(hiddenPath),
    entryFor(notesPath),
    { name: 'data', path: dataDir, isDir: true, size: null, mtimeMs: 1200, ext: '' },
    entryFor(pngPath),
  ])
  world.dirs.set(dataDir, [entryFor(nestedPath)])
  return world
}

const DEFAULT_ENV = {
  ok: true,
  platform: 'posix',
  defaultCwd: DEFAULT_CWD,
  tmpRoot: '/tmp/dsh-code-runner-test',
  limits: {
    codeMaxBytes: 1048576,
    outputMaxBytes: 2097152,
    defaultTimeoutMs: 300000,
    maxTimeoutMs: 1800000,
    fileMaxBytes: 1048576,
    blobMaxBytes: 16777216,
    artifactMax: 40,
  },
  languages: [
    { id: 'python', label: 'Python', available: true, command: '/usr/bin/python3', version: 'Python 3.13.9', template: 'print("Hello from Python", 1 + 1)\n', extensions: ['py', 'pyw'] },
    { id: 'r', label: 'R', available: true, command: '/usr/bin/Rscript', version: 'R version 4.4.1', template: 'cat("Hello from R\\n")\n', extensions: ['r'] },
    { id: 'matlab', label: 'MATLAB', available: true, command: '/Applications/MATLAB_R2024a.app/bin/matlab', version: null, template: "disp('Hello from MATLAB')\n", extensions: ['m'] },
    { id: 'node', label: 'Node.js', available: true, command: '/usr/bin/node', version: 'v22.0.0', template: 'console.log("Hello from Node.js")\n', extensions: ['mjs', 'cjs', 'js'] },
    { id: 'bash', label: 'Bash', available: false, command: null, version: null, template: 'echo "Hello from Bash"\n', extensions: ['sh'] },
  ],
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status < 400,
    headers: { get: function getHeader(name) { return name === 'content-type' ? 'application/json; charset=utf-8' : null } },
    text: function text() { return Promise.resolve(JSON.stringify(body)) },
  }
}

function blobResponse(status, bytes, contentType) {
  return {
    status,
    ok: status < 400,
    headers: { get: function getHeader(name) { return name === 'content-type' ? contentType : null } },
    text: function text() { return Promise.resolve('') },
    blob: function blob() { return Promise.resolve({ bytes: bytes, type: contentType, size: bytes.length }) },
  }
}

function createTimerBag() {
  const active = new Map()
  let nextId = 1
  return {
    set(fn, delay) {
      const id = nextId
      nextId += 1
      const real = setTimeout(function onTimer() {
        active.delete(id)
        try { fn() } catch (error) { console.error('timer callback failed', error) }
      }, typeof delay === 'number' ? delay : 0)
      active.set(id, real)
      return id
    },
    clear(id) {
      const real = active.get(id)
      if (real !== undefined) {
        clearTimeout(real)
        active.delete(id)
      }
    },
    count() { return active.size },
    clearAll() {
      for (const real of active.values()) clearTimeout(real)
      active.clear()
    },
  }
}

function mediaQueryStub(options) {
  const opts = options || {}
  const listeners = new Set()
  return {
    matches: opts.narrow === true,
    media: '(max-width: 720px)',
    addEventListener(type, handler) { if (type === 'change') listeners.add(handler) },
    removeEventListener(type, handler) { if (type === 'change') listeners.delete(handler) },
    addListener(handler) { listeners.add(handler) },
    removeListener(handler) { listeners.delete(handler) },
    emit(matches) {
      this.matches = matches
      for (const handler of listeners) handler({ matches: matches })
    },
  }
}

// ── Harness: vm sandbox + fake ctx + optional sidebar-right services ───────
function createHarness(options) {
  const opts = options || {}
  const world = opts.world || createWorld(opts)
  const envPayload = opts.env || DEFAULT_ENV
  const timers = createTimerBag()
  const storage = new Map()
  const clipboardWrites = []
  const urlCreated = []
  const urlRevoked = []
  const consoleLog = []
  const windowListeners = new Map()
  const calls = []
  const media = mediaQueryStub(opts)

  class SandboxURL extends URL {
    static createObjectURL(blob) {
      const url = 'blob:mock/' + (urlCreated.length + 1)
      urlCreated.push({ url: url, blob: blob })
      return url
    }
    static revokeObjectURL(url) {
      urlRevoked.push(url)
    }
  }

  function safeJSON(text) {
    try { return JSON.parse(text) } catch (error) { return null }
  }

  function fakeFetch(input, init) {
    const requestPath = String(input)
    const method = (init && init.method) || 'GET'
    const headers = (init && typeof init.headers === 'object' && init.headers !== null) ? init.headers : {}
    const parsedBody = init && typeof init.body === 'string' && init.body !== '' ? safeJSON(init.body) : null
    const full = new URL(requestPath, 'http://127.0.0.1:57598/')
    const pathname = full.pathname
    const search = full.searchParams
    calls.push({ path: requestPath, pathname: pathname, method: method, headers: headers, body: parsedBody, search: search })

    // /api/token — loopback bootstrap, the only request without the token header.
    if (pathname === '/dsh-code-runner/api/token') {
      world.tokenCalls += 1
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return Promise.resolve(jsonResponse(opts.tokenStatus, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }))
      }
      return Promise.resolve(jsonResponse(200, { ok: true, token: opts.bootToken || 'boot-token' }))
    }

    // /api/env
    if (pathname === '/dsh-code-runner/api/env') {
      world.envCalls += 1
      if (opts.env401Once && world.envCalls === 1) {
        return Promise.resolve(jsonResponse(401, { ok: false, error: { code: 'unauthorized', message: 'missing or invalid host token — reload the page' } }))
      }
      return Promise.resolve(jsonResponse(200, envPayload))
    }

    // /api/run
    if (pathname === '/dsh-code-runner/api/run') {
      world.runCalls += 1
      world.runRequests.push(parsedBody)
      if (opts.runErrorOnce && world.runCalls === 1) {
        return Promise.resolve(jsonResponse(400, { ok: false, error: { code: 'bad-cwd', message: 'no such directory' } }))
      }
      const runId = 'run-' + world.runCount
      world.runCount += 1
      const mode = parsedBody && parsedBody.mode === 'file' ? 'file' : (parsedBody && parsedBody.mode === 'buffer' ? 'buffer' : (parsedBody && parsedBody.file ? 'file' : 'buffer'))
      const language = (parsedBody && parsedBody.language) || 'python'
      world.currentRun = { runId: runId, mode: mode, language: language, file: parsedBody && parsedBody.file ? parsedBody.file : null }
      world.outputPolls = 0
      world.outputBuffer = ''
      world.stopRequested = false
      const runPayload = {
        ok: true,
        runId: runId,
        language: language,
        mode: mode,
        file: world.currentRun.file,
        command: '/usr/bin/' + language + ' ' + (world.currentRun.file || '/tmp/' + runId + '/script.py'),
        scriptPath: world.currentRun.file || '/tmp/dsh-code-runner-test/' + runId + '/script.py',
        cwd: (parsedBody && parsedBody.cwd) || world.cwd,
        startedAt: 1730000000000,
        timeoutMs: 300000,
        capturePlots: true,
        plotDir: '/tmp/dsh-code-runner-test/' + runId + '/plots',
      }
      if (opts.runHold && world.pendingRun === null) {
        // v3 UX test: keep the run in the `starting` phase until the test releases it.
        return new Promise(function holdRun(resolve) {
          world.pendingRun = function releaseRun() {
            world.pendingRun = null
            resolve(jsonResponse(200, runPayload))
          }
        })
      }
      return Promise.resolve(jsonResponse(200, runPayload))
    }

    // /api/explain — AI explanation (v3 §1.2)
    if (pathname === '/dsh-code-runner/api/explain') {
      world.explainRequests.push(parsedBody)
      const mode = opts.explainMode || 'ok'
      if (mode === 'llm-unavailable') {
        return Promise.resolve(jsonResponse(503, { ok: false, error: { code: 'llm-unavailable', message: 'agentDefaultModel/llm services are not available' } }))
      }
      if (mode === 'llm-failed') {
        return Promise.resolve(jsonResponse(502, { ok: false, error: { code: 'llm-failed', message: 'the model stream failed' } }))
      }
      if (mode === 'llm-timeout') {
        return Promise.resolve(jsonResponse(504, { ok: false, error: { code: 'llm-timeout', message: 'the model did not answer in time' } }))
      }
      const summary = opts.explainSummary || '这段代码先打印 1 再打印 2。'
      const annotated = opts.explainAnnotated !== undefined
        ? opts.explainAnnotated
        : '# 注释版本\n' + String(parsedBody && parsedBody.code ? parsedBody.code : '')
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        summary: summary,
        annotatedCode: annotated,
        provider: 'test-provider',
        model: 'test-model',
        truncatedInput: opts.explainTruncated === true,
      }))
    }

    // /api/export — write the report folder (v3 §1.3)
    if (pathname === '/dsh-code-runner/api/export') {
      world.exportRequests.push(parsedBody)
      const mode = opts.exportMode || 'ok'
      if (mode === 'bad-cwd') {
        return Promise.resolve(jsonResponse(400, { ok: false, error: { code: 'bad-cwd', message: 'the base directory does not exist' } }))
      }
      if (mode === 'too-large') {
        return Promise.resolve(jsonResponse(413, { ok: false, error: { code: 'too-large', message: 'report is too large' } }))
      }
      const folder = (opts.exportFolder || '/Users/sunchujun/Desktop/deepseek/dsh-code-runner-reports/20261027-231500-python')
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        folder: folder,
        baseName: '未命名实验报告',
        format: (parsedBody && parsedBody.format) || 'docx',
        include: (parsedBody && parsedBody.include) || { code: true, output: true, plots: true, summary: true },
        docxPath: folder + '/未命名实验报告.docx',
        reportPath: folder + '/report.md',
        htmlPath: folder + '/report.html',
        plotFiles: ['plots/plot-001.png'],
        files: ['report.md', 'report.html', 'run.json', 'plots/plot-001.png'],
      }))
    }

    // /api/save-plots — copy plots next to the code (v3 §1.4)
    if (pathname === '/dsh-code-runner/api/save-plots') {
      world.savePlotsRequests.push(parsedBody)
      const mode = opts.savePlotsMode || 'ok'
      if (mode === 'unsupported-file') {
        return Promise.resolve(jsonResponse(415, { ok: false, error: { code: 'unsupported-file', message: 'not an image' } }))
      }
      const body = parsedBody || {}
      const targetDir = typeof body.targetDir === 'string' ? body.targetDir : ''
      const plots = Array.isArray(body.plots) ? body.plots : []
      const saved = plots.map(function toSaved(plot) {
        return { source: plot.path, path: targetDir + '/' + (plot.name || basenameOf(plot.path)) }
      })
      return Promise.resolve(jsonResponse(200, { ok: true, targetDir: targetDir, saved: saved }))
    }

    // /api/output
    if (pathname === '/dsh-code-runner/api/output') {
      world.outputCalls += 1
      world.outputPolls += 1
      if (world.outputPolls === 2 && world.outputChunks[0]) world.outputBuffer += world.outputChunks[0]
      if (world.outputPolls === 3 && world.outputChunks[1]) world.outputBuffer += world.outputChunks[1]
      const running = !world.stopRequested && world.outputPolls < world.finishPoll
      const from = Number(search.get('stdoutFrom') || '0')
      const stderrFrom = Number(search.get('stderrFrom') || '0')
      const run = world.currentRun || { runId: 'run-0', language: 'python', mode: 'buffer', file: null }
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        runId: run.runId,
        language: run.language,
        mode: run.mode,
        file: run.file,
        command: 'cmd',
        scriptPath: '/tmp/dsh-code-runner-test/' + run.runId + '/script.py',
        cwd: world.cwd,
        startedAt: 1730000000000,
        running: running,
        exitCode: running ? null : (world.stopRequested ? null : 0),
        signal: running ? null : (world.stopRequested ? 'SIGTERM' : null),
        durationMs: running ? null : 1500,
        timedOut: false,
        stopped: world.stopRequested,
        capturePlots: true,
        plotDir: '/tmp/dsh-code-runner-test/' + run.runId + '/plots',
        stdout: { text: world.outputBuffer.slice(from), nextOffset: world.outputBuffer.length, lossy: false },
        stderr: { text: '', nextOffset: stderrOffsetPlaceholder(stderrFrom), lossy: false },
      }))
    }

    // /api/stop
    if (pathname === '/dsh-code-runner/api/stop') {
      world.stopCalls += 1
      world.stopRequested = true
      return Promise.resolve(jsonResponse(200, { ok: true, runId: world.currentRun ? world.currentRun.runId : null, stopped: true, running: false }))
    }

    // /api/files
    if (pathname === '/dsh-code-runner/api/files') {
      const dir = search.get('dir') || ''
      world.filesCalls.push(dir)
      if (!world.dirs.has(dir)) {
        return Promise.resolve(jsonResponse(400, { ok: false, error: { code: 'bad-path', message: 'not an absolute existing directory: ' + dir } }))
      }
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        dir: dir,
        parent: dirnameOf(dir),
        entries: world.dirs.get(dir).slice(),
        truncated: world.filesTruncated === true,
      }))
    }

    // /api/file — GET read, POST save
    if (pathname === '/dsh-code-runner/api/file') {
      if (method === 'POST') {
        const body = parsedBody || {}
        world.saves.push(body)
        if (world.conflicts.has(body.path) && typeof body.baseMtimeMs === 'number') {
          world.conflicts.delete(body.path)
          return Promise.resolve(jsonResponse(409, {
            ok: false,
            error: { code: 'conflict', message: 'the file changed on disk' },
            currentMtimeMs: 999999,
            size: 42,
          }))
        }
        const previous = world.files.get(body.path)
        const record = {
          text: typeof body.text === 'string' ? body.text : '',
          mtimeMs: previous ? previous.mtimeMs + 10 : 1000,
          ext: extensionOf(body.path),
          binary: false,
          truncated: false,
          size: typeof body.text === 'string' ? body.text.length : 0,
        }
        world.files.set(body.path, record)
        const parent = dirnameOf(body.path)
        if (!world.dirs.has(parent)) world.dirs.set(parent, [])
        const entries = world.dirs.get(parent)
        if (!entries.some(function samePath(entry) { return entry.path === body.path })) entries.push(entryFor(body.path))
        return Promise.resolve(jsonResponse(200, {
          ok: true,
          path: body.path,
          size: record.size,
          mtimeMs: record.mtimeMs,
          ext: record.ext,
        }))
      }
      const filePath = search.get('path') || ''
      world.fileGetCalls.push(filePath)
      const record = world.files.get(filePath)
      if (!record) {
        return Promise.resolve(jsonResponse(404, { ok: false, error: { code: 'not-found', message: 'no such file: ' + filePath } }))
      }
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        path: filePath,
        text: record.binary ? '' : record.text,
        size: record.size,
        mtimeMs: record.mtimeMs,
        ext: record.ext,
        truncated: record.truncated === true,
        binary: record.binary === true,
      }))
    }

    // /api/blob — raw bytes
    if (pathname === '/dsh-code-runner/api/blob') {
      const blobPath = search.get('path') || ''
      world.blobCalls.push(blobPath)
      if (world.blobs.has(blobPath)) {
        const record = world.blobs.get(blobPath)
        return Promise.resolve(blobResponse(200, record.bytes, record.type))
      }
      const ext = extensionOf(blobPath)
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].indexOf(ext) >= 0) {
        return Promise.resolve(blobResponse(200, new Uint8Array([137, 80, 78, 71]), 'image/' + (ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext)))
      }
      if (ext === 'pdf') {
        return Promise.resolve(blobResponse(200, new Uint8Array([37, 80, 68, 70]), 'application/pdf'))
      }
      return Promise.resolve(jsonResponse(400, { ok: false, error: { code: 'unsupported-file', message: 'unsupported extension: ' + ext } }))
    }

    // /api/artifacts
    if (pathname === '/dsh-code-runner/api/artifacts') {
      world.artifactPolls += 1
      const runIdParam = search.get('runId') || ''
      const plots = world.artifactsPlan ? world.artifactsPlan(world.artifactPolls, world, runIdParam) : []
      const runRunning = world.currentRun !== null && !world.stopRequested && world.outputPolls < world.finishPoll
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        runId: runIdParam,
        running: runRunning,
        plotDir: '/tmp/dsh-code-runner-test/' + runIdParam + '/plots',
        plots: plots,
        truncated: false,
      }))
    }

    // /api/packs — v5 language packs (detect / enable / disable)
    if (pathname === '/dsh-code-runner/api/packs' || pathname === '/dsh-code-runner/api/packs/rescan') {
      if (pathname.endsWith('/rescan')) {
        return Promise.resolve(jsonResponse(200, { ok: true, stateDir: '/tmp/dsh-code-runner', packs: world.packs }))
      }
      if (method === 'POST') {
        world.packToggles.push(parsedBody)
        const id = parsedBody && parsedBody.id
        const enabled = parsedBody && parsedBody.enabled === true
        world.packs = world.packs.map(function applyToggle(pack) {
          return pack.id === id ? Object.assign({}, pack, { enabled: enabled }) : pack
        })
      }
      return Promise.resolve(jsonResponse(200, { ok: true, stateDir: '/tmp/dsh-code-runner', packs: world.packs }))
    }

    // /api/diag — browser diagnostics ring buffer (CONTRACT-V2.md §1.11)
    if (pathname === '/dsh-code-runner/api/diag') {
      world.diagEvents.push(parsedBody && parsedBody.event ? parsedBody.event : parsedBody)
      return Promise.resolve(jsonResponse(200, { ok: true, accepted: 1 }))
    }

    return Promise.resolve(jsonResponse(404, { ok: false, error: { code: 'unknown-route', message: 'unknown route: ' + pathname } }))
  }

  function stderrOffsetPlaceholder(from) { return from }

  const windowObject = {
    localStorage: {
      getItem: function getItem(key) { return storage.has(key) ? storage.get(key) : null },
      setItem: function setItem(key, value) { storage.set(key, String(value)) },
      removeItem: function removeItem(key) { storage.delete(key) },
    },
    matchMedia: function matchMedia() { return media },
    addEventListener: function addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type).add(handler)
    },
    removeEventListener: function removeEventListener(type, handler) {
      const handlers = windowListeners.get(type)
      if (handlers) handlers.delete(handler)
    },
  }
  if (opts.globalToken) windowObject.__DSH_CODE_RUNNER__ = { token: opts.globalToken }

  const sandbox = {
    window: windowObject,
    document: { documentElement: { lang: opts.lang || 'zh' } },
    navigator: {
      clipboard: {
        writeText: function writeText(value) {
          clipboardWrites.push(value)
          return Promise.resolve()
        },
      },
    },
    fetch: fakeFetch,
    setTimeout: function sandboxSetTimeout(fn, delay) { return timers.set(fn, delay) },
    clearTimeout: function sandboxClearTimeout(id) { timers.clear(id) },
    setInterval: function sandboxSetInterval(fn, delay) { return timers.set(fn, delay) },
    clearInterval: function sandboxClearInterval(id) { timers.clear(id) },
    AbortController: AbortController,
    URL: SandboxURL,
    console: {
      error: function error() { consoleLog.push(Array.prototype.map.call(arguments, String).join(' ')) },
      warn: function warn() { consoleLog.push(Array.prototype.map.call(arguments, String).join(' ')) },
      log: function log() { consoleLog.push(Array.prototype.map.call(arguments, String).join(' ')) },
    },
  }

  let loaderDefinition = null
  windowObject.__ModuleLoader__ = { load: function load(definition) { loaderDefinition = definition } }
  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: 'client.js' })
  if (!loaderDefinition) throw new Error('client.js did not call window.__ModuleLoader__.load')
  const mini = createMiniReact()
  const moduleExports = loaderDefinition.factory(function requireModule(id) {
    if (id === 'react') return mini.React
    throw new Error('unexpected require: ' + id)
  })

  // ── fake client services / context ──
  const registrations = []
  const injectedSlots = []
  const effectLabels = []
  const disposers = []
  const tabDefinitions = []
  const localeSubscribers = new Set()
  let localeDicts = null

  const sidebarRightState = { expanded: false, activeTab: null, opened: [], closed: [] }
  const sidebarRight = {
    openTab: function openTab(kind, openOptions) {
      sidebarRightState.opened.push({ kind: kind, options: openOptions || null })
      sidebarRightState.activeTab = { id: 'tab-1', kind: kind }
      sidebarRightState.expanded = true
    },
    close: function close(tabId) {
      sidebarRightState.closed.push(tabId)
      sidebarRightState.activeTab = null
      sidebarRightState.expanded = false
    },
    isExpanded: function isExpanded() { return sidebarRightState.expanded },
    active: function active() { return sidebarRightState.activeTab },
  }
  const sidebarRightTabs = {
    register: function register(definition) {
      tabDefinitions.push(definition)
      return function dispose() {}
    },
  }
  const layout = {
    selectedPanels: [],
    selectPanel: function selectPanel(id) { this.selectedPanels.push(id) },
  }
  const uiWorkspace = {
    pickResult: opts.pickResult || null,
    pickDirectory: function pickDirectory() { return Promise.resolve(opts.pickResult || null) },
  }
  const locale = {
    register: function registerLocale(namespace, dictionaries) {
      localeDicts = dictionaries
      return function dispose() {}
    },
    bind: function bind() {
      return function translate(key) {
        if (!localeDicts) return key
        const dictionary = (opts.lang === 'en') ? localeDicts.en : localeDicts.zh
        return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
      }
    },
    subscribe: function subscribeLocale(callback) {
      localeSubscribers.add(callback)
      return function unsubscribe() { localeSubscribers.delete(callback) }
    },
    getSnapshot: function getSnapshot() { return { active: opts.lang || 'zh' } },
  }
  const slots = {
    inject: function inject(name, callback) {
      injectedSlots.push(name)
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return typeof disposer === 'function' ? disposer : function noop() {}
    },
    register: function register(definition, component) {
      registrations.push({ definition: definition, component: component })
      return function dispose() {}
    },
  }
  const services = { slots: slots, locale: locale, layout: layout, uiWorkspace: uiWorkspace }
  if (opts.services !== 'absent') {
    services.sidebarRightTabs = sidebarRightTabs
    services.sidebarRight = sidebarRight
  }
  const ctx = {
    effect: function effect(callback, label) {
      effectLabels.push(label)
      const result = callback()
      if (typeof result === 'function') {
        disposers.push(result)
      } else if (result !== null && result !== undefined) {
        // Mirrors cordis: an effect body may only yield a disposer.
        throw new TypeError('Invalid effect from "' + label + '": ' + typeof result)
      }
    },
    get: function get(name) { return services[name] },
    inject: function inject(dependencies, callback) {
      const fiber = {
        disposed: false,
        loaded: false,
        effectDisposer: null,
        dispose: function dispose() {
          fiber.disposed = true
          const disposer = fiber.effectDisposer
          fiber.effectDisposer = null
          if (typeof disposer === 'function') return disposer()
          return undefined
        },
        then: function then(onFulfilled, onRejected) {
          return Promise.resolve(fiber).then(onFulfilled, onRejected)
        },
      }
      const available = dependencies.every(function hasService(name) { return services[name] !== undefined })
      if (!available) return fiber
      const scoped = Object.assign({}, ctx)
      for (const dependency of dependencies) scoped[dependency] = services[dependency]
      const disposer = callback(scoped)
      fiber.loaded = true
      fiber.effectDisposer = typeof disposer === 'function' ? disposer : null
      return fiber
    },
    slots: slots,
    locale: locale,
  }

  moduleExports.apply(ctx)

  const harness = {
    opts: opts,
    world: world,
    envPayload: envPayload,
    timers: timers,
    storage: storage,
    clipboardWrites: clipboardWrites,
    urlCreated: urlCreated,
    urlRevoked: urlRevoked,
    consoleLog: consoleLog,
    calls: calls,
    mini: mini,
    moduleExports: moduleExports,
    ctx: ctx,
    registrations: registrations,
    injectedSlots: injectedSlots,
    effectLabels: effectLabels,
    disposers: disposers,
    tabDefinitions: tabDefinitions,
    locale: locale,
    getLocaleDicts: function getLocaleDicts() { return localeDicts },
    sidebarRight: sidebarRight,
    sidebarRightState: sidebarRightState,
    layout: layout,
    uiWorkspace: uiWorkspace,
    media: media,
    text: function text() { return textOf(mini.tree) },
    flush: function flush() { mini.flush() },
    registrationNamed: function registrationNamed(name) {
      return registrations.find(function match(entry) { return entry.definition.name === name }) || null
    },
    pageElement: function pageElement() {
      const registration = harness.registrationNamed('main')
      if (!registration) throw new Error('main registration missing')
      const injected = typeof registration.definition.inject === 'function' ? registration.definition.inject() : {}
      return { type: registration.component, props: injected }
    },
    paneElement: function paneElement() {
      const registration = harness.registrationNamed('sidebar.right.pane.tab')
      if (!registration) throw new Error('sidebar.right.pane.tab registration missing')
      return { type: registration.component, props: {} }
    },
    headerToggleElement: function headerToggleElement() {
      const registration = harness.registrationNamed('conversation.session.header.utilities')
      if (!registration) throw new Error('header toggle registration missing')
      return { type: registration.component, props: {} }
    },
    dispatchWindow: function dispatchWindow(type, event) {
      const handlers = windowListeners.get(type)
      if (!handlers) return
      for (const handler of Array.from(handlers)) handler(event)
    },
    mountPage: function mountPage() { mini.mount(harness.pageElement()); return harness },
    mountPane: function mountPane() { mini.mount(harness.paneElement()); return harness },
    unmount: function unmount() { mini.unmount() },
    async settle(predicate, timeoutMs) {
      const limit = typeof timeoutMs === 'number' ? timeoutMs : 5000
      const start = Date.now()
      for (;;) {
        mini.flush()
        if (predicate && predicate()) return true
        if (Date.now() - start > limit) return predicate ? predicate() : true
        await new Promise(function waitTick(resolve) { setTimeout(resolve, 10) })
      }
    },
    async sleep(milliseconds) {
      await new Promise(function wait(resolve) { setTimeout(resolve, milliseconds) })
      mini.flush()
    },
    clickText(label) {
      const node = buttonByText(mini.tree, label)
      if (!node) throw new Error('button with text not found: ' + label)
      node.props.onClick({ preventDefault: function noop() {} })
      mini.flush()
    },
    clickAria(label) {
      const node = buttonByAria(mini.tree, label)
      if (!node) throw new Error('button with aria-label not found: ' + label)
      node.props.onClick({ preventDefault: function noop() {} })
      mini.flush()
    },
    clickTab(label) {
      const node = find(mini.tree, function matchTab(candidate) {
        return candidate.props && candidate.props.role === 'tab' && textOf(candidate).trim() === label
      })
      if (!node) throw new Error('tab not found: ' + label)
      node.props.onClick({ preventDefault: function noop() {} })
      mini.flush()
    },
    typeCode(value) {
      const node = textareaNode(mini.tree)
      if (!node) throw new Error('editor textarea not found')
      node.props.onChange({ target: { value: value } })
      mini.flush()
    },
    editorValue() {
      const node = textareaNode(mini.tree)
      return node ? node.props.value : null
    },
    hasText(fragment) { return harness.text().indexOf(fragment) !== -1 },
    countCalls(pathname) {
      return calls.filter(function match(call) { return call.pathname === pathname }).length
    },
    callsOf(pathname) {
      return calls.filter(function match(call) { return call.pathname === pathname })
    },
    lastCall(pathname) {
      const matched = harness.callsOf(pathname)
      return matched.length > 0 ? matched[matched.length - 1] : null
    },
    clearDom() { mini.unmount() },
  }
  harness.releaseRun = function releaseHeldRun() {
    if (typeof world.pendingRun === 'function') world.pendingRun()
  }
  return harness
}

// ── Assertion collection ────────────────────────────────────────────────────
const failures = []
const passed = []

function check(name, fn) {
  try {
    fn()
    passed.push(name)
    console.log('ok   ' + name)
  } catch (error) {
    failures.push({ name: name, error: error })
    console.log('FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed.push(name)
    console.log('ok   ' + name)
  } catch (error) {
    failures.push({ name: name, error: error })
    console.log('FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

function scenario(name) {
  console.log('\n=== scenario: ' + name + ' ===')
}

// ── Scenario helpers ────────────────────────────────────────────────────────
function fileRowByText(harness, fragment) {
  return find(harness.mini.tree, function matchRow(node) {
    return node.tag === 'button' && node.props.className === 'dcr-fileRow' && textOf(node).indexOf(fragment) !== -1
  })
}

function tabByText(harness, label) {
  return find(harness.mini.tree, function matchTabNode(node) {
    return node.props && node.props.role === 'tab' && textOf(node).trim() === label
  })
}

function plotCards(harness) {
  return findAll(harness.mini.tree, function matchCard(node) {
    return node.tag === 'button' && node.props.className === 'dcr-plotCardOpen'
  })
}

function plotSaveButtons(harness) {
  return findAll(harness.mini.tree, function matchSave(node) {
    return node.tag === 'button' && node.props.className === 'dcr-btn dcr-btnSmall dcr-plotSave'
  })
}

function lightboxNode(harness) {
  return find(harness.mini.tree, function matchDialog(node) {
    return node.props && node.props.role === 'dialog' && node.props['aria-modal'] === 'true'
  })
}

function zhDictOf(harness) {
  const dicts = harness.getLocaleDicts()
  return dicts ? dicts.zh : {}
}

// ── Scenario: registrations + locale parity ────────────────────────────────
async function scenarioRegistrations() {
  scenario('registrations + locale')
  const harness = createHarness({ globalToken: 'global-token' })

  check('module shape is the CONTRACT §2.1 wrapper contract', () => {
    assert.equal(harness.moduleExports.name, 'dsh-code-runner')
    assert.equal(JSON.stringify(harness.moduleExports.inject), JSON.stringify(['slots', 'locale']))
    assert.equal(typeof harness.moduleExports.apply, 'function')
  })

  check('locale dictionaries are identical and cover every CONTRACT §2.6 key', () => {
    const dicts = harness.getLocaleDicts()
    assert.ok(dicts && dicts.zh && dicts.en, 'locale dictionaries not registered')
    const zhKeys = Object.keys(dicts.zh).sort()
    const enKeys = Object.keys(dicts.en).sort()
    assert.equal(JSON.stringify(zhKeys), JSON.stringify(enKeys))
    assert.ok(zhKeys.length >= 154, 'expected >=154 keys, got ' + zhKeys.length)
    const required = [
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
    ]
    for (const key of required) assert.ok(Object.prototype.hasOwnProperty.call(dicts.zh, key), 'zh missing ' + key)
    assert.equal(dicts.zh['panel.label'], '代码运行器')
    assert.equal(dicts.en['panel.title'], 'Code Runner')
  })

  check('v1 sidebar row and main page registrations are kept', () => {
    const row = harness.registrationNamed('sidebar.panellist')
    assert.ok(row, 'sidebar.panellist registration missing')
    assert.equal(row.definition.id, 'code-runner')
    assert.equal(row.definition.order, 30)
    assert.equal(row.definition.label(), '代码运行器')
    const page = harness.registrationNamed('main')
    assert.ok(page, 'main registration missing')
    assert.equal(page.definition.key, 'code-runner')
    assert.equal(page.definition.locale, 'dsh-code-runner')
  })

  check('right-sidebar tab type registration args', () => {
    assert.ok(harness.injectedSlots.indexOf('sidebar.right.pane.tab') !== -1)
    assert.equal(harness.tabDefinitions.length, 1)
    const definition = harness.tabDefinitions[0]
    assert.equal(definition.id, 'dsh-code-runner')
    assert.equal(definition.kind, 'code-runner')
    assert.equal(definition.keepMounted, true)
    assert.equal(typeof definition.title, 'function')
    assert.equal(definition.title('whatever'), '代码运行器')
    assert.ok(Array.isArray(definition.guide) && definition.guide.length === 1)
    const guide = definition.guide[0]
    assert.equal(guide.id, 'dsh-code-runner')
    assert.equal(typeof guide.title, 'function')
    assert.equal(guide.title(), '代码运行器')
    assert.equal(typeof guide.description, 'function')
    assert.equal(guide.description(), harness.getLocaleDicts().zh['panel.subtitle'])
  })

  await harness.sleep(10)
  check('browser diagnostics report apply/right-tab/header events (§1.11)', () => {
    const diagCalls = harness.callsOf('/dsh-code-runner/api/diag')
    assert.ok(diagCalls.length >= 3, 'expected >=3 diag posts, got ' + diagCalls.length)
    const events = diagCalls.map(function toEvent(call) {
      assert.ok(String(call.headers['x-dsh-code-runner-token'] || '') !== '', 'diag post must carry the token header')
      return call.body && call.body.event ? call.body.event : null
    })
    const names = events.map(function toName(event) { return event ? event.name : null })
    assert.ok(names.indexOf('apply') !== -1, 'apply event missing: ' + JSON.stringify(names))
    assert.ok(names.indexOf('right-tab') !== -1, 'right-tab event missing')
    assert.ok(names.indexOf('header-toggle') !== -1, 'header-toggle event missing')
    const applyEvent = events.find(function isApply(event) { return event && event.name === 'apply' })
    assert.equal(applyEvent.detail.version, '0.5.0')
    assert.equal(typeof applyEvent.detail.hasSidebarRight, 'boolean')
    const rightTab = events.find(function isRightTabEvent(event) { return event && event.name === 'right-tab' })
    assert.equal(typeof rightTab.detail.tabType, 'boolean')
    assert.equal(typeof rightTab.detail.body, 'boolean')
  })

  check('right-pane body registers under the definition id as key', () => {
    const registration = harness.registrationNamed('sidebar.right.pane.tab')
    assert.ok(registration, 'sidebar.right.pane.tab registration missing')
    assert.equal(registration.definition.key, 'dsh-code-runner')
    assert.equal(registration.definition.locale, 'dsh-code-runner')
  })

  check('conversation-header toggle registration id/order/label', () => {
    const registration = harness.registrationNamed('conversation.session.header.utilities')
    assert.ok(registration, 'header utilities registration missing')
    assert.equal(registration.definition.id, 'code-runner-toggle')
    assert.equal(registration.definition.order, 5)
    assert.equal(registration.definition.locale, 'dsh-code-runner')
    assert.equal(registration.definition.label(), '代码运行器')
  })

  check('registrations are all wrapped in ctx.effect labels', () => {
    const labels = harness.effectLabels.join('|')
    assert.ok(labels.indexOf('dsh-code-runner: locale') !== -1)
    assert.ok(labels.indexOf('dsh-code-runner: sidebar row') !== -1)
    assert.ok(labels.indexOf('dsh-code-runner: panel') !== -1)
    assert.ok(labels.indexOf('dsh-code-runner: right tab') !== -1)
    assert.ok(labels.indexOf('dsh-code-runner: header toggle') !== -1)
  })
}

// ── Scenario: header toggle behaviour + fallbacks ─────────────────────────
async function scenarioHeaderToggle() {
  scenario('conversation-header toggle')
  const harness = createHarness({ globalToken: 'global-token' })
  harness.mini.mount(harness.headerToggleElement())
  harness.flush()
  const button = find(harness.mini.tree, byTag('button'))
  check('header toggle is an accessible compact button', () => {
    assert.ok(button, 'toggle button missing')
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['aria-label'], '在右侧栏打开代码运行器')
    assert.equal(button.props['aria-pressed'], false)
  })
  button.props.onClick({ preventDefault: function noop() {} })
  harness.flush()
  check('clicking opens the code-runner tab through ctx.sidebarRight', () => {
    assert.equal(harness.sidebarRightState.opened.length, 1)
    assert.equal(harness.sidebarRightState.opened[0].kind, 'code-runner')
    assert.equal(harness.sidebarRightState.expanded, true)
  })
  harness.sidebarRightState.activeTab = { id: 'tab-1', kind: 'code-runner' }
  harness.sidebarRightState.expanded = true
  button.props.onClick({})
  harness.flush()
  check('clicking while our tab is active closes it', () => {
    assert.equal(harness.sidebarRightState.closed[0], 'tab-1')
    assert.equal(harness.sidebarRightState.expanded, false)
  })
  harness.sidebarRightState.activeTab = { id: 'tab-2', kind: 'file-preview' }
  harness.sidebarRightState.expanded = true
  button.props.onClick({})
  harness.flush()
  check('clicking while another tab is active focuses ours instead of closing', () => {
    assert.equal(harness.sidebarRightState.opened.length, 2)
  })
  harness.unmount()

  const fallback = createHarness({ services: 'absent', globalToken: 'global-token' })
  check('without the right-sidebar services the v1 page path still registers', () => {
    assert.equal(fallback.tabDefinitions.length, 0)
    assert.equal(fallback.registrationNamed('sidebar.right.pane.tab'), null)
    assert.ok(fallback.registrationNamed('main'))
    assert.ok(fallback.registrationNamed('sidebar.panellist'))
    assert.ok(fallback.registrationNamed('conversation.session.header.utilities'))
  })
  fallback.mini.mount(fallback.headerToggleElement())
  fallback.flush()
  const fallbackButton = find(fallback.mini.tree, byTag('button'))
  fallbackButton.props.onClick({})
  check('without sidebarRight the toggle falls back to layout.selectPanel', () => {
    assert.equal(JSON.stringify(fallback.layout.selectedPanels), JSON.stringify(['code-runner']))
  })

  const broken = createHarness({ globalToken: 'global-token' })
  broken.mini.mount(broken.headerToggleElement())
  broken.flush()
  broken.ctx.get = function throwOnGet() { throw new Error('service lookup exploded') }
  const brokenButton = find(broken.mini.tree, byTag('button'))
  check('toggle never throws out of the header button', () => {
    assert.doesNotThrow(function clickBroken() { brokenButton.props.onClick({}) })
  })
}

// ── Scenario: page mode end-to-end ─────────────────────────────────────────
async function scenarioPageWorkflow() {
  scenario('page mode: files, open, save, conflict, dirty guard, save-as, runs')
  const harness = createHarness({ globalToken: 'global-token' })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })

  check('page renders the RStudio-like layout', () => {
    assert.ok(find(harness.mini.tree, function root(node) { return node.props['data-dsh-code-runner-view'] === 'page' }))
    assert.ok(harness.hasText('代码运行器'))
    assert.equal(harness.countCalls('/dsh-code-runner/api/env'), 1)
    assert.equal(harness.callsOf('/dsh-code-runner/api/env')[0].headers['x-dsh-code-runner-token'], 'global-token')
    assert.ok(find(harness.mini.tree, byTag('textarea')), 'editor missing')
    assert.ok(find(harness.mini.tree, function log(node) { return node.props.role === 'log' }), 'console missing')
    assert.ok(harness.countCalls('/dsh-code-runner/api/files') >= 1)
    assert.ok(buttonByText(harness.mini.tree, '文件'))
    assert.ok(buttonByText(harness.mini.tree, '图表'))
    assert.ok(harness.hasText('缓冲区模式'))
  })

  await harness.settle(function filesLoaded() { return harness.hasText('script.py') })

  check('files list sorts directories first and dims dotfiles', () => {
    const rows = findAll(harness.mini.tree, function row(node) {
      return node.tag === 'button' && node.props.className === 'dcr-fileRow'
    })
    assert.ok(rows.length >= 5, 'file rows missing')
    assert.ok(textOf(rows[0]).indexOf('data/') !== -1, 'directories are not listed first')
    const hiddenRow = rows.find(function findHidden(row) { return textOf(row).indexOf('.hidden.py') !== -1 })
    assert.ok(hiddenRow, 'dotfile row missing')
    assert.equal(hiddenRow.props['data-dot'], 'true')
  })

  const scriptRow = fileRowByText(harness, 'script.py')
  scriptRow.props.onClick({})
  harness.flush()
  await harness.settle(function opened() { return harness.editorValue() === 'print("hello")\n' })

  check('opening a text file fills the editor and infers the language', () => {
    assert.equal(harness.editorValue(), 'print("hello")\n')
    assert.equal(harness.world.fileGetCalls[0], harness.world.scriptPath)
    const select = find(harness.mini.tree, byTag('select'))
    assert.equal(select.props.value, 'python')
    assert.ok(harness.hasText('script.py'))
    assert.ok(harness.hasText('文件模式'))
  })

  harness.typeCode('print("saved")\n')
  check('typing marks the file dirty', () => {
    assert.ok(harness.hasText('未保存的修改'))
  })
  harness.clickText('保存')
  await harness.settle(function saved() { return harness.world.saves.length >= 1 })

  check('save posts path/text/baseMtimeMs', () => {
    const save = harness.world.saves[0]
    assert.equal(save.path, harness.world.scriptPath)
    assert.equal(save.text, 'print("saved")\n')
    assert.equal(save.baseMtimeMs, 1000)
  })
  await harness.settle(function dirtyCleared() { return harness.hasText('未保存的修改') === false })

  harness.typeCode('print("again")\n')
  harness.world.conflicts.add(harness.world.scriptPath)
  harness.clickText('保存')
  await harness.settle(function conflictShown() { return harness.hasText('文件已被外部修改') })

  check('a 409 conflict shows the inline overwrite confirm', () => {
    assert.ok(harness.hasText('文件已被外部修改'))
    assert.ok(harness.hasText('仍然覆盖'))
    assert.equal(harness.world.saves.length, 2)
  })
  harness.clickText('仍然覆盖')
  await harness.settle(function overwritten() { return harness.world.saves.length >= 3 })
  check('overwrite retries the save without baseMtimeMs', () => {
    const overwrite = harness.world.saves[2]
    assert.equal(overwrite.path, harness.world.scriptPath)
    assert.equal(Object.prototype.hasOwnProperty.call(overwrite, 'baseMtimeMs'), false)
  })

  harness.typeCode('print("dirty guard")\n')
  const otherRow = fileRowByText(harness, 'other.R')
  otherRow.props.onClick({})
  harness.flush()
  await harness.settle(function guardShown() {
    const text = harness.text()
    return text.indexOf('放弃未保存的修改') !== -1 || text.indexOf('打开另一个文件') !== -1
  })

  check('dirty guard blocks replacing the open file', () => {
    const text = harness.text()
    assert.ok(text.indexOf('放弃未保存的修改') !== -1 || text.indexOf('打开另一个文件') !== -1)
    assert.equal(harness.world.fileGetCalls.filter(function isOther(pathValue) { return pathValue === harness.world.otherPath }).length, 0)
  })
  harness.clickText('取消')
  check('cancel keeps the current file and its edits', () => {
    assert.equal(harness.editorValue(), 'print("dirty guard")\n')
  })

  fileRowByText(harness, 'other.R').props.onClick({})
  harness.flush()
  await harness.settle(function guardAgain() {
    const text = harness.text()
    return text.indexOf('放弃未保存的修改') !== -1 || text.indexOf('打开另一个文件') !== -1
  })
  harness.clickText('放弃修改')
  await harness.settle(function otherOpened() { return harness.editorValue() === 'cat("other")\n' })
  check('discard opens the other file and infers R', () => {
    assert.equal(harness.editorValue(), 'cat("other")\n')
    assert.equal(find(harness.mini.tree, byTag('select')).props.value, 'r')
    assert.ok(harness.hasText('other.R'))
  })

  harness.clickText('新建')
  check('New resets to a scratch buffer', () => {
    assert.equal(harness.editorValue(), '')
    assert.ok(harness.hasText('未命名'))
    assert.ok(harness.hasText('缓冲区模式'))
  })
  harness.typeCode('print("scratch")\n')
  harness.clickText('保存')
  check('Save on a scratch buffer opens the inline Save-as dialog', () => {
    assert.ok(harness.hasText('另存为'))
  })
  const nameInput = find(harness.mini.tree, function findNameInput(node) {
    return node.tag === 'input' && node.props['aria-label'] === zhDictOf(harness)['editor.saveAsPlaceholder']
  })
  assert.ok(nameInput, 'save-as name input missing')
  nameInput.props.onChange({ target: { value: 'newscript.py' } })
  harness.flush()
  nameInput.props.onKeyDown({ key: 'Enter', preventDefault: function noop() {} })
  await harness.settle(function saveAsWritten() { return harness.world.saves.length >= 4 })

  check('Save-as writes under the cwd and adopts the new file', () => {
    const save = harness.world.saves[harness.world.saves.length - 1]
    assert.equal(save.path, harness.world.cwd + '/newscript.py')
    assert.equal(save.text, 'print("scratch")\n')
    assert.ok(harness.hasText('newscript.py'))
    assert.equal(find(harness.mini.tree, byTag('select')).props.value, 'python')
  })

  // File-mode run: dirty file is auto-saved first, then the file is run.
  harness.typeCode('print("file run")\n')
  harness.clickText('运行文件')
  await harness.settle(function runRequested() { return harness.world.runRequests.length >= 1 })
  check('file-mode run auto-saves the dirty file, then runs the path', () => {
    const runRequest = harness.world.runRequests[0]
    assert.equal(runRequest.mode, 'file')
    assert.equal(runRequest.file, harness.world.cwd + '/newscript.py')
    assert.equal(runRequest.language, 'python')
    assert.equal(runRequest.cwd, harness.world.cwd)
    assert.equal(runRequest.capturePlots, true)
    const saveCallIndex = harness.calls.findIndex(function findSave(call) { return call.pathname === '/dsh-code-runner/api/file' && call.method === 'POST' })
    const runCallIndex = harness.calls.findIndex(function findRun(call) { return call.pathname === '/dsh-code-runner/api/run' })
    assert.ok(saveCallIndex >= 0 && runCallIndex > saveCallIndex, 'save must precede the run')
  })
  await harness.settle(function ran() {
    const text = harness.text()
    return text.indexOf('hello from python') !== -1 && text.indexOf('退出码 0') !== -1
  }, 8000)
  check('console streams output and reports exit status + duration', () => {
    assert.ok(harness.hasText('hello from python'))
    assert.ok(harness.hasText('退出码 0'))
    assert.ok(harness.hasText('耗时 1.50 s'))
    assert.ok(harness.countCalls('/dsh-code-runner/api/output') >= 3)
  })

  // Stop flow: start a run and stop it immediately.
  harness.typeCode('while True: pass\n')
  harness.clickText('运行文件')
  await harness.settle(function secondRun() { return harness.world.runRequests.length >= 2 })
  harness.clickText('停止')
  await harness.settle(function stoppedShown() { return harness.hasText('已停止') }, 6000)
  check('Stop terminates the run and reports stopped + signal', () => {
    assert.ok(harness.world.stopCalls >= 1)
    assert.ok(harness.hasText('已停止'))
    assert.ok(harness.hasText('信号 SIGTERM'))
  })

  harness.clickText('清空输出')
  check('Clear resets the console output', () => {
    assert.equal(harness.hasText('hello from python'), false)
    assert.equal(harness.hasText('while True: pass'), false)
    assert.ok(harness.hasText('）') || harness.hasText('(no output)') || harness.hasText('运行脚本后'))
  })

  // Buffer-mode run from a fresh scratch buffer.
  harness.clickText('新建')
  harness.typeCode('print("buffer run")\n')
  harness.clickText('运行代码')
  await harness.settle(function bufferRun() { return harness.world.runRequests.length >= 3 })
  check('buffer-mode run posts mode/language/code/capturePlots', () => {
    const runRequest = harness.world.runRequests[harness.world.runRequests.length - 1]
    assert.equal(runRequest.mode, 'buffer')
    assert.equal(runRequest.language, 'python')
    assert.equal(runRequest.code, 'print("buffer run")\n')
    assert.equal(runRequest.cwd, harness.world.cwd)
    assert.equal(runRequest.capturePlots, true)
    assert.equal(Object.prototype.hasOwnProperty.call(runRequest, 'file'), false)
  })
  harness.unmount()
}

// ── Scenario: pane mode, files navigation, plots, lightbox ────────────────
async function scenarioPaneWorkflow() {
  scenario('pane mode: tabs, files navigation, plots gallery, lightbox')
  const plotOne = '/tmp/dsh-code-runner-test/run-1/plots/plot-001.png'
  const plotTwo = '{cwd}/existing-plot.png'
  const harness = createHarness({
    globalToken: 'global-token',
    finishPoll: 8,
    artifactsPlan: function plan(poll, world) {
      if (poll <= 1) return []
      return [plotFor(plotOne, 'run', 'plot-001.png'), plotFor(plotTwo.replace('{cwd}', world.cwd), 'cwd', 'existing-plot.png')]
    },
  })
  harness.mountPane()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })

  check('pane mode renders the compact workbench with tab strip + gutter', () => {
    assert.ok(find(harness.mini.tree, function root(node) { return node.props['data-dsh-code-runner-view'] === 'pane' }))
    const tabs = findAll(harness.mini.tree, function tabsOnly(node) { return node.props && node.props.role === 'tab' })
    assert.equal(JSON.stringify(tabs.map(function label(node) { return textOf(node).trim() })), JSON.stringify(['控制台', '图表', '文件']))
    assert.ok(find(harness.mini.tree, function gutter(node) { return node.tag === 'pre' && node.props.className === 'dcr-gutter' }))
    assert.ok(find(harness.mini.tree, byTag('textarea')))
    assert.ok(find(harness.mini.tree, function divider(node) { return node.props.role === 'separator' }))
  })

  harness.clickTab('文件')
  await harness.settle(function filesShown() { return harness.hasText('data/') })
  check('Files tab lists the workbench cwd', () => {
    assert.ok(harness.hasText('script.py'))
    assert.ok(harness.hasText('data/'))
  })

  fileRowByText(harness, 'data/').props.onClick({})
  harness.flush()
  await harness.settle(function navigated() {
    return harness.world.filesCalls.indexOf(harness.world.dataDir) !== -1 && harness.hasText('nested.py')
  })
  check('directory row navigates into the directory (GET /api/files?dir=…)', () => {
    assert.ok(harness.world.filesCalls.indexOf(harness.world.dataDir) !== -1)
    assert.ok(harness.hasText('nested.py'))
    assert.ok(harness.hasText('上一级'))
  })
  harness.clickText('上一级')
  await harness.settle(function backUp() {
    return harness.world.filesCalls.length >= 3 && harness.hasText('script.py')
  })
  check('Up returns to the parent directory', () => {
    assert.equal(harness.world.filesCalls[harness.world.filesCalls.length - 1], harness.world.cwd)
  })

  harness.clickTab('控制台')
  harness.typeCode('print("pane")\n')
  harness.clickText('运行代码')
  await harness.settle(function runStarted() { return harness.world.runRequests.length >= 1 }, 5000)
  await harness.settle(function autoSwitched() {
    const plotsTab = tabByText(harness, '图表')
    return plotsTab !== null && plotsTab.props['aria-selected'] === true
  }, 8000)
  check('new run plots auto-switch the bottom tab to Plots while running', () => {
    assert.equal(harness.world.runRequests[0].mode, 'buffer')
    assert.ok(harness.countCalls('/dsh-code-runner/api/output') >= 1)
    assert.equal(tabByText(harness, '图表').props['aria-selected'], true)
  })
  await harness.settle(function runFinished() { return harness.world.outputPolls > harness.world.finishPoll }, 8000)
  harness.clickTab('控制台')
  harness.flush()
  check('pane run polls output at offsets and shows the finish status', () => {
    const text = harness.text()
    assert.ok(text.indexOf('hello from python') !== -1, 'stdout missing after finish')
    assert.ok(text.indexOf('退出码 0') !== -1, 'exit status missing')
    assert.ok(harness.countCalls('/dsh-code-runner/api/output') >= 3)
    assert.equal(harness.world.runRequests[0].mode, 'buffer')
  })
  harness.clickTab('图表')
  await harness.settle(function urlsReady() { return harness.urlCreated.length >= 2 }, 8000)
  check('artifacts load and blob URLs feed the gallery thumbnails', () => {
    assert.ok(harness.world.artifactPolls >= 2)
    assert.ok(harness.urlCreated.length >= 2)
    assert.ok(harness.world.blobCalls.length >= 2)
    const images = findAll(harness.mini.tree, function img(node) {
      return node.tag === 'img' && String(node.props.src || '').indexOf('blob:mock/') === 0
    })
    assert.ok(images.length >= 2, 'plot thumbnails missing')
    assert.equal(tabByText(harness, '图表').props['aria-selected'], true)
    assert.ok(harness.hasText('运行产物') || harness.hasText('目录'))
  })

  harness.clickTab('图表')
  harness.flush()
  const cards = plotCards(harness)
  check('plots gallery renders caption + source badge cards', () => {
    assert.ok(cards.length >= 2)
    assert.ok(harness.hasText('plot-001.png'))
    assert.ok(harness.hasText('existing-plot.png'))
  })
  cards[0].props.onClick({})
  harness.flush()
  check('plot card opens the lightbox dialog', () => {
    const dialog = lightboxNode(harness)
    assert.ok(dialog, 'lightbox dialog missing')
    assert.ok(find(harness.mini.tree, function img(node) {
      return node.tag === 'img' && String(node.props.src || '').indexOf('blob:mock/') === 0
    }))
  })
  const firstName = textOf(find(harness.mini.tree, function name(node) { return node.props.className === 'dcr-lightboxName' }))
  harness.clickAria('下一张')
  harness.flush()
  check('lightbox next moves to the next plot', () => {
    const secondName = textOf(find(harness.mini.tree, function name(node) { return node.props.className === 'dcr-lightboxName' }))
    assert.notEqual(secondName, firstName)
    assert.ok(harness.hasText('2/2'))
  })
  harness.clickText('复制路径')
  harness.flush()
  check('lightbox Copy path writes the current path to the clipboard', () => {
    assert.ok(harness.clipboardWrites.length >= 1)
    assert.ok(String(harness.clipboardWrites[0]).indexOf('existing-plot.png') !== -1)
  })
  check('lightbox has prev/next and close affordances', () => {
    assert.ok(buttonByAria(harness.mini.tree, '上一张'))
    assert.ok(buttonByAria(harness.mini.tree, '下一张'))
    assert.ok(buttonByAria(harness.mini.tree, '关闭'))
  })
  harness.dispatchWindow('keydown', { key: 'Escape', preventDefault: function noop() {} })
  harness.flush()
  check('Esc closes the lightbox', () => {
    assert.equal(lightboxNode(harness), null)
  })

  const urlsBeforeRefresh = harness.urlCreated.length
  harness.clickAria('刷新图表')
  await harness.settle(function refreshed() {
    return harness.urlRevoked.length >= 1 && harness.urlCreated.length > urlsBeforeRefresh
  }, 8000)
  check('refresh revokes stale object URLs and creates new ones', () => {
    assert.ok(harness.urlRevoked.length >= 1)
    assert.ok(harness.urlCreated.length > urlsBeforeRefresh)
  })
  harness.unmount()
}

// ── Scenario: token bootstrap, failure banner, 401 retry ──────────────────
async function scenarioTokenHandling() {
  scenario('token bootstrap + 401 retry + failure banner')

  const bootstrap = createHarness({ globalToken: null })
  bootstrap.mountPane()
  await bootstrap.settle(function ready() {
    return bootstrap.countCalls('/dsh-code-runner/api/env') === 1 && bootstrap.hasText('宿主已就绪')
  })
  check('missing page global bootstraps the token without a refresh banner', () => {
    assert.equal(bootstrap.world.tokenCalls, 1)
    const tokenCall = bootstrap.callsOf('/dsh-code-runner/api/token')[0]
    assert.equal(tokenCall.headers['x-dsh-code-runner-token'], undefined)
    const envCall = bootstrap.callsOf('/dsh-code-runner/api/env')[0]
    assert.equal(envCall.headers['x-dsh-code-runner-token'], 'boot-token')
    assert.equal(bootstrap.hasText('页面还没拿到宿主令牌'), false)
  })
  bootstrap.unmount()

  const failing = createHarness({ globalToken: null, tokenStatus: 403 })
  failing.mountPane()
  await failing.settle(function banner() { return failing.hasText('页面还没拿到宿主令牌') })
  check('both token paths failing shows the refresh banner and skips env', () => {
    assert.ok(failing.hasText('页面还没拿到宿主令牌'))
    assert.equal(failing.countCalls('/dsh-code-runner/api/env'), 0)
    assert.equal(find(failing.mini.tree, byTag('select')).props.disabled, true)
  })
  failing.unmount()

  const retry = createHarness({ globalToken: 'stale-token', env401Once: true })
  retry.mountPane()
  await retry.settle(function envReady() { return retry.hasText('宿主已就绪') })
  check('401 clears the cached token, re-bootstraps once and re-issues the request', () => {
    assert.equal(retry.world.tokenCalls, 1)
    const envCalls = retry.callsOf('/dsh-code-runner/api/env')
    assert.equal(envCalls.length, 2)
    assert.equal(envCalls[0].headers['x-dsh-code-runner-token'], 'stale-token')
    assert.equal(envCalls[1].headers['x-dsh-code-runner-token'], 'boot-token')
    assert.equal(retry.hasText('登录状态已失效'), false)
  })
  retry.unmount()
}

// ── Scenario: English locale ───────────────────────────────────────────────
async function scenarioEnglish() {
  scenario('english locale')
  const harness = createHarness({ globalToken: 'global-token', lang: 'en' })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('Host ready') })
  check('english dictionaries drive both surfaces and registrations', () => {
    assert.equal(harness.registrationNamed('sidebar.panellist').definition.label(), 'Code Runner')
    assert.ok(harness.hasText('Code Runner'))
    assert.ok(harness.hasText('Save'))
    assert.ok(harness.hasText('Run code'))
    assert.ok(harness.hasText('Console'))
    assert.ok(harness.hasText('Explain / annotate'))
    assert.ok(harness.hasText('Export report'))
    assert.ok(harness.hasText('Files'))
  })
  harness.unmount()
}

// ── Scenario: shared store, unmount/remount, no leaked timers ─────────────
async function scenarioUnmountRemount() {
  scenario('shared store + unmount/remount + no leaked timers')
  const plotOne = '/tmp/dsh-code-runner-test/run-1/plots/plot-001.png'
  const harness = createHarness({
    globalToken: 'global-token',
    artifactsPlan: function plan(poll) { return poll >= 1 ? [plotFor(plotOne, 'run', 'plot-001.png')] : [] },
  })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  await harness.settle(function filesLoaded() { return harness.hasText('script.py') })
  fileRowByText(harness, 'script.py').props.onClick({})
  harness.flush()
  await harness.settle(function opened() { return harness.editorValue() === 'print("hello")\n' })
  harness.typeCode('print("persist me")\n')
  harness.clickText('运行文件')
  await harness.settle(function finished() {
    const text = harness.text()
    return text.indexOf('退出码 0') !== -1 && harness.urlCreated.length >= 1
  }, 8000)

  const outputCallsBefore = harness.countCalls('/dsh-code-runner/api/output')
  const createdBefore = harness.urlCreated.length
  harness.unmount()

  check('unmount clears every timer owned by the store', () => {
    assert.equal(harness.timers.count(), 0, 'leaked timers: ' + harness.timers.count())
  })
  check('unmount revokes every plot object URL', () => {
    assert.ok(createdBefore >= 1)
    assert.ok(harness.urlRevoked.length >= createdBefore)
  })
  await harness.sleep(600)
  check('polling stops after unmount (no leaked requests)', () => {
    assert.equal(harness.countCalls('/dsh-code-runner/api/output'), outputCallsBefore)
    assert.equal(harness.timers.count(), 0)
  })

  harness.mountPage()
  await harness.settle(function remounted() { return harness.hasText('宿主已就绪') })
  check('remount shares the store: code, open file and finish status survive', () => {
    assert.equal(harness.editorValue(), 'print("persist me")\n')
    assert.ok(harness.hasText('script.py'))
    assert.ok(harness.hasText('退出码 0'))
    assert.ok(harness.hasText('文件模式'))
  })
  await harness.settle(function urlsRestored() { return harness.urlCreated.length > createdBefore }, 8000)
  check('remount rehydrates plot thumbnails from /api/blob', () => {
    assert.ok(harness.urlCreated.length > createdBefore)
  })
  harness.unmount()
  check('second unmount also leaves no timers behind', () => {
    assert.equal(harness.timers.count(), 0)
  })
}

// ── Scenario: error boundary around a surface ─────────────────────────────
async function scenarioErrorBoundary() {
  scenario('error boundary')
  const harness = createHarness({ globalToken: 'global-token' })
  harness.mountPane()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  const originalUseState = harness.mini.React.useState
  let armed = true
  let calls = 0
  harness.mini.React.useState = function patchedUseState() {
    calls += 1
    if (armed && calls === 2) {
      armed = false
      throw new Error('boom-for-boundary')
    }
    return originalUseState.apply(harness.mini.React, arguments)
  }
  harness.clickText('重新扫描')
  harness.flush()
  harness.mini.React.useState = originalUseState
  check('a crashing pane body renders the localized refresh block, not a blank slot', () => {
    assert.ok(harness.hasText('面板出错了'), 'crash title missing')
    assert.ok(harness.hasText('刷新页面重新加载'), 'crash hint missing')
    assert.ok(harness.consoleLog.some(function logged(line) { return line.indexOf('slot entry crashed') !== -1 }), 'componentDidCatch log missing')
    assert.ok(find(harness.mini.tree, byTag('style')), 'surface styles should survive the crash')
  })
  harness.unmount()
}

// ── Scenario: element types (real-React parity) ────────────────────────────
// Regression guard for the v2 crash where the toolbar rendered `h(FileGlyph())`
// (an element object) instead of `h(FileGlyph)`: real React throws minified
// error #130 ("Element type is invalid ... got: object") and the panel's error
// boundary shows up. The miniature React here used to accept any `type`, so the
// bug shipped; both halves of this scenario keep that gap closed.
async function scenarioElementTypes() {
  scenario('element types (real-React parity)')
  check('client.js never passes a called component as an element type', function noCalledComponentTypes() {
    const suspicious = SOURCE.match(/\bh\(\s*[A-Z][A-Za-z0-9_]*\(\s*\)/g) || []
    assert.deepEqual(suspicious, [], 'found h(Component()) pattern: ' + suspicious.join(', '))
  })
  check('mini React rejects an invalid element type like React #130', function rejectsInvalidElementType() {
    const maker = createMiniReact()
    function pretendComponent() {
      return maker.React.createElement('svg', null)
    }
    const invalid = maker.React.createElement(pretendComponent())
    assert.throws(function renderInvalidElement() {
      maker.mount(invalid)
    }, /invalid React element type/)
    maker.unmount()
  })
}

// ── v3 helpers ──────────────────────────────────────────────────────────────
function selectEditor(harness, start, end) {
  const node = textareaNode(harness.mini.tree)
  assert.ok(node, 'editor textarea not found')
  node.props.onSelect({ currentTarget: { selectionStart: start, selectionEnd: end } })
  harness.flush()
}

function dialogByRole(harness, role) {
  return find(harness.mini.tree, function match(node) {
    return node.props && node.props.role === role
  })
}

function buttonByTextStarts(harness, prefix) {
  return find(harness.mini.tree, function match(node) {
    return node.tag === 'button' && textOf(node).trim().indexOf(prefix) === 0
  })
}

function explainDialogNode(harness) {
  return find(harness.mini.tree, function match(node) {
    return node.props && node.props.role === 'dialog' && node.props['data-status'] !== undefined
  })
}

// ── Scenario: run selection (CONTRACT-V3 §2.1) ─────────────────────────────
async function scenarioSelectionRuns() {
  scenario('selection runs (v3 §2.1)')
  const harness = createHarness({ globalToken: 'global-token' })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  harness.typeCode('print(1)\nprint(2)\n')

  const selectionButton = function findSelectionButton() {
    return buttonByText(harness.mini.tree, '运行选中')
  }
  check('run-selection button exists and is disabled without a selection', () => {
    const button = selectionButton()
    assert.ok(button, 'run-selection button missing')
    assert.equal(button.props.disabled, true)
  })

  selectEditor(harness, 0, 8) // "print(1)"
  check('tracking the textarea selection enables 运行选中', () => {
    assert.equal(selectionButton().props.disabled, false)
    assert.equal(harness.editorValue(), 'print(1)\nprint(2)\n')
  })
  selectionButton().props.onClick({})
  await harness.settle(function selectionRunSent() { return harness.world.runRequests.length >= 1 })
  check('selection run posts a buffer request with origin=selection and leaves the editor untouched', () => {
    const body = harness.world.runRequests[0]
    assert.equal(body.mode, 'buffer')
    assert.equal(body.code, 'print(1)')
    assert.equal(body.origin, 'selection')
    assert.equal(body.language, 'python')
    assert.equal(body.cwd, harness.world.cwd)
    assert.equal(body.capturePlots, true)
    assert.equal(harness.editorValue(), 'print(1)\nprint(2)\n')
  })
  await harness.settle(function markerShown() { return harness.hasText('选中运行') })
  check('console/status shows the localized selection marker', () => {
    assert.ok(harness.hasText('选中运行'))
  })
  await harness.settle(function firstRunDone() { return harness.hasText('退出码 0') }, 8000)

  selectEditor(harness, 9, 17) // "print(2)"
  textareaNode(harness.mini.tree).props.onKeyDown({
    key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: true,
    preventDefault: function noop() {},
    currentTarget: { selectionStart: 9, selectionEnd: 17 },
  })
  harness.flush()
  await harness.settle(function shortcutRunSent() { return harness.world.runRequests.length >= 2 })
  check('⌘/Ctrl+Shift+Enter runs the selection as a buffer run', () => {
    const body = harness.world.runRequests[1]
    assert.equal(body.mode, 'buffer')
    assert.equal(body.code, 'print(2)')
    assert.equal(body.origin, 'selection')
    assert.equal(harness.editorValue(), 'print(1)\nprint(2)\n')
  })
  await harness.settle(function secondRunDone() {
    return harness.world.runRequests.length >= 2 && harness.world.outputPolls > harness.world.finishPoll
  }, 8000)
  selectEditor(harness, 8, 9) // only the newline
  check('whitespace-only selection keeps 运行选中 disabled', () => {
    assert.equal(selectionButton().props.disabled, true)
  })
  harness.unmount()
}

// ── Scenario: AI explain dialog (CONTRACT-V3 §2.2) ────────────────────────
async function scenarioExplain() {
  scenario('AI explain dialog (v3 §2.2)')
  const harness = createHarness({ globalToken: 'global-token', explainSummary: '先打印 1 再打印 2。' })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  harness.typeCode('print(1)\nprint(2)\n')
  harness.clickText('理解 / 注释代码')
  check('explain dialog opens with the loading state', () => {
    assert.ok(explainDialogNode(harness), 'explain dialog missing')
    assert.ok(harness.hasText('正在请求模型…'))
  })
  await harness.settle(function summaryShown() { return harness.hasText('先打印 1 再打印 2。') })
  check('explain request carries language/code/fileName and renders the summary', () => {
    const body = harness.world.explainRequests[0]
    assert.equal(body.language, 'python')
    assert.equal(body.code, 'print(1)\nprint(2)\n')
    assert.equal(body.fileName, null)
    assert.ok(harness.hasText('先打印 1 再打印 2。'))
    assert.ok(buttonByText(harness.mini.tree, '插入注释版本到编辑器'))
  })
  harness.clickText('复制解释')
  harness.flush()
  check('copy explanation writes the summary to the clipboard', () => {
    assert.equal(harness.clipboardWrites[harness.clipboardWrites.length - 1], '先打印 1 再打印 2。')
  })
  harness.clickText('插入注释版本到编辑器')
  harness.flush()
  check('insert replaces the editor with the annotated code', () => {
    assert.equal(harness.editorValue(), '# 注释版本\nprint(1)\nprint(2)\n')
    assert.ok(harness.hasText('注释版本已插入编辑器'))
    assert.ok(buttonByText(harness.mini.tree, '撤销插入'))
  })
  harness.clickText('撤销插入')
  harness.flush()
  check('undo insert restores the previous code (one step)', () => {
    assert.equal(harness.editorValue(), 'print(1)\nprint(2)\n')
    assert.equal(buttonByText(harness.mini.tree, '撤销插入'), null)
  })
  harness.clickText('关闭')
  harness.flush()
  check('close dismisses the explain dialog', () => {
    assert.equal(explainDialogNode(harness), null)
  })
  harness.unmount()

  // File mode: fileName is sent and a successful insert marks the file dirty.
  const fileHarness = createHarness({ globalToken: 'global-token' })
  fileHarness.mountPage()
  await fileHarness.settle(function ready() { return fileHarness.hasText('宿主已就绪') })
  await fileHarness.settle(function filesLoaded() { return fileHarness.hasText('script.py') })
  fileRowByText(fileHarness, 'script.py').props.onClick({})
  fileHarness.flush()
  await fileHarness.settle(function opened() { return fileHarness.editorValue() === 'print("hello")\n' })
  fileHarness.clickText('理解 / 注释代码')
  await fileHarness.settle(function fileSummary() { return fileHarness.hasText('# 注释版本') })
  check('explaining an open file sends its path and inserting marks it dirty', () => {
    assert.equal(fileHarness.world.explainRequests[0].fileName, fileHarness.world.scriptPath)
    fileHarness.clickText('插入注释版本到编辑器')
    fileHarness.flush()
    assert.ok(fileHarness.hasText('未保存的修改'))
    assert.equal(fileHarness.editorValue(), '# 注释版本\nprint("hello")\n')
  })
  fileHarness.unmount()

  // Error mapping: unavailable / failed / timeout + retry.
  const unavailable = createHarness({ globalToken: 'global-token', explainMode: 'llm-unavailable' })
  unavailable.mountPage()
  await unavailable.settle(function ready() { return unavailable.hasText('宿主已就绪') })
  unavailable.typeCode('print(1)\n')
  unavailable.clickText('理解 / 注释代码')
  await unavailable.settle(function unavailableShown() { return unavailable.hasText('DSH 设置') })
  check('llm-unavailable explains how to configure a model', () => {
    assert.ok(unavailable.hasText('DSH 设置'))
    assert.equal(buttonByText(unavailable.mini.tree, '重试'), null)
  })
  unavailable.unmount()

  const failed = createHarness({ globalToken: 'global-token', explainMode: 'llm-failed' })
  failed.mountPage()
  await failed.settle(function ready() { return failed.hasText('宿主已就绪') })
  failed.typeCode('print(1)\n')
  failed.clickText('理解 / 注释代码')
  await failed.settle(function failedShown() { return failed.hasText('AI 请求失败') })
  await checkAsync('llm-failed shows the failure and retries successfully', async () => {
    assert.ok(failed.hasText('AI 请求失败'))
    assert.ok(buttonByText(failed.mini.tree, '重试'))
    failed.opts.explainMode = 'ok'
    failed.opts.explainSummary = '重试后的解释。'
    failed.clickText('重试')
    await failed.settle(function retried() { return failed.hasText('重试后的解释。') })
    assert.ok(failed.hasText('重试后的解释。'))
    assert.equal(failed.world.explainRequests.length, 2)
  })
  failed.unmount()

  const timeout = createHarness({ globalToken: 'global-token', explainMode: 'llm-timeout' })
  timeout.mountPage()
  await timeout.settle(function ready() { return timeout.hasText('宿主已就绪') })
  timeout.typeCode('print(1)\n')
  timeout.clickText('理解 / 注释代码')
  await timeout.settle(function timeoutShown() { return timeout.hasText('AI 请求失败') && timeout.hasText('超时') })
  check('llm-timeout shows the timeout copy', () => {
    assert.ok(timeout.hasText('超时'))
  })
  timeout.unmount()
}

// ── Scenario: export report (CONTRACT-V3 §2.3) ────────────────────────────
async function scenarioExport() {
  scenario('export report (v3 §2.3)')
  const plotOne = '/tmp/dsh-code-runner-test/run-1/plots/plot-001.png'
  const harness = createHarness({
    globalToken: 'global-token',
    explainSummary: '导出测试总结。',
    artifactsPlan: function plan(poll) {
      return poll >= 1 ? [plotFor(plotOne, 'run', 'plot-001.png')] : []
    },
  })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  harness.typeCode('print("export")\n')
  harness.clickText('理解 / 注释代码')
  await harness.settle(function summary() { return harness.hasText('导出测试总结。') })
  harness.clickText('关闭')
  harness.flush()
  harness.clickText('运行代码')
  await harness.settle(function ran() { return harness.hasText('退出码 0') && harness.urlCreated.length >= 1 }, 8000)
  harness.clickText('导出报告')
  harness.flush()
  check('export dialog offers format + include choices and the target name', () => {
    assert.ok(harness.hasText('导出实验报告'), 'dialog title missing')
    assert.ok(harness.hasText('Word 文档'), 'format options missing')
    assert.ok(harness.hasText('源代码') && harness.hasText('输出结果') && harness.hasText('统计图'), 'include options missing')
    assert.ok(harness.hasText('未命名实验报告.docx'), 'file-name preview missing')
  })
  harness.clickText('开始导出')
  await harness.settle(function exportSent() { return harness.world.exportRequests.length >= 1 })
  await harness.settle(function exportDone() { return harness.hasText('报告已生成') })
  check('export posts the run report body (code/output/run/plots/summary)', () => {
    const body = harness.world.exportRequests[0]
    assert.equal(body.language, 'python')
    assert.equal(body.mode, 'buffer')
    assert.equal(body.file, null)
    assert.equal(body.cwd, harness.world.cwd)
    assert.equal(typeof body.command, 'string')
    assert.equal(body.code, 'print("export")\n')
    assert.equal(body.exitCode, 0)
    assert.equal(body.durationMs, 1500)
    assert.equal(typeof body.startedAt, 'number')
    assert.equal(body.summary, '导出测试总结。')
    assert.ok(Array.isArray(body.plots) && body.plots.length === 1)
    assert.equal(body.plots[0].path, plotOne)
    assert.equal(body.plots[0].name, 'plot-001.png')
    assert.equal(body.plots[0].source, 'run')
    assert.equal(body.format, 'docx')
    assert.deepEqual(body.include, { code: true, output: true, plots: true, summary: true })
    assert.equal(body.name, '未命名')
  })
  check('export success notice shows the folder and a copy-path action', () => {
    assert.ok(harness.hasText('报告已生成'))
    assert.ok(buttonByText(harness.mini.tree, '复制路径'))
  })
  harness.clickText('复制路径')
  harness.flush()
  check('copy-path copies the report folder', () => {
    const copied = String(harness.clipboardWrites[harness.clipboardWrites.length - 1])
    assert.ok(copied.indexOf('dsh-code-runner-reports') !== -1, 'copied: ' + copied)
  })
  harness.clickAria('关闭')
  harness.flush()
  check('the export stays reachable from the status bar', () => {
    assert.equal(harness.hasText('报告已生成'), false)
    const chip = buttonByTextStarts(harness, '报告目录:')
    assert.ok(chip, 'status-bar export chip missing')
    chip.props.onClick({})
    harness.flush()
    assert.ok(harness.hasText('报告已生成'))
  })
  harness.unmount()

  const failing = createHarness({ globalToken: 'global-token', exportMode: 'bad-cwd' })
  failing.mountPage()
  await failing.settle(function ready() { return failing.hasText('宿主已就绪') })
  failing.typeCode('print(1)\n')
  failing.clickText('导出报告')
  failing.flush()
  failing.clickText('开始导出')
  await failing.settle(function mapped() { return failing.hasText('工作目录无效') })
  check('export failure maps bad-cwd to the localized path error', () => {
    assert.ok(failing.hasText('工作目录无效'))
  })
  failing.unmount()
}

// ── Scenario: plot saving (CONTRACT-V3 §2.4) ──────────────────────────────
async function scenarioPlotSaving() {
  scenario('plot saving (v3 §2.4)')
  const plotOne = '/tmp/dsh-code-runner-test/run-1/plots/plot-001.png'
  const harness = createHarness({
    globalToken: 'global-token',
    artifactsPlan: function plan(poll, world) {
      if (poll < 1) return []
      return [
        plotFor(plotOne, 'run', 'plot-001.png'),
        plotFor(world.cwd + '/existing-plot.png', 'cwd', 'existing-plot.png'),
      ]
    },
  })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  await harness.settle(function filesLoaded() { return harness.hasText('script.py') })
  fileRowByText(harness, 'script.py').props.onClick({})
  harness.flush()
  await harness.settle(function opened() { return harness.editorValue() === 'print("hello")\n' })
  harness.clickText('运行文件')
  await harness.settle(function runStarted() { return harness.world.runRequests.length >= 1 }, 10000)
  harness.clickTab('图表')
  await harness.settle(function plotsReady() {
    return plotCards(harness).length >= 2 && plotSaveButtons(harness).length >= 2
  }, 10000)

  check('plot cards expose a save action and a human size', () => {
    assert.ok(plotSaveButtons(harness).length >= 2)
    assert.ok(harness.hasText('运行产物'))
    assert.ok(harness.hasText('KB') || harness.hasText('B'))
  })
  plotSaveButtons(harness)[0].props.onClick({})
  await harness.settle(function firstSaved() { return harness.world.savePlotsRequests.length >= 1 })
  check('per-plot save posts the plot and the file-folder target', () => {
    const body = harness.world.savePlotsRequests[0]
    assert.equal(body.targetDir, harness.world.cwd) // script.py lives in the cwd
    assert.ok(Array.isArray(body.plots) && body.plots.length === 1)
    assert.equal(body.plots[0].path, plotOne)
    assert.equal(body.plots[0].name, 'plot-001.png')
  })
  harness.clickAria('全部保存')
  await harness.settle(function allSaved() { return harness.world.savePlotsRequests.length >= 2 })
  check('Save all posts the visible plot list', () => {
    const body = harness.world.savePlotsRequests[1]
    assert.equal(body.plots.length, 2)
    assert.equal(body.plots[1].name, 'existing-plot.png')
  })
  plotCards(harness)[0].props.onClick({})
  harness.flush()
  check('lightbox footer offers Save image', () => {
    const dialog = lightboxNode(harness)
    assert.ok(dialog, 'lightbox missing')
    const saveButton = find(dialog, function match(node) {
      return node.tag === 'button' && node.props['aria-label'] === '保存'
    })
    assert.ok(saveButton, 'lightbox save button missing')
    saveButton.props.onClick({})
  })
  await harness.settle(function lightboxSaved() { return harness.world.savePlotsRequests.length >= 3 })
  check('lightbox save posts the currently shown plot', () => {
    const body = harness.world.savePlotsRequests[2]
    assert.equal(body.plots.length, 1)
    assert.equal(body.plots[0].path, plotOne)
  })
  harness.opts.savePlotsMode = 'unsupported-file'
  harness.clickAria('全部保存')
  await harness.settle(function saveFailed() { return harness.hasText('不支持的文件类型') })
  check('plot save failure maps unsupported-file', () => {
    assert.ok(harness.hasText('不支持的文件类型'))
  })
  harness.unmount()
}

// ── Scenario: language profiles + MATLAB (CONTRACT-V3 §2.5) ───────────────
async function scenarioLanguageProfiles() {
  scenario('language profiles + MATLAB (v3 §2.5)')
  const harness = createHarness({ globalToken: 'global-token', runHold: true })
  harness.mountPane()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  check('only available languages are listed (MATLAB detected, Bash not)', () => {
    const select = find(harness.mini.tree, byTag('select'))
    assert.ok(select, 'language select missing')
    const labels = findAll(select, byTag('option')).map(function label(node) { return textOf(node).trim() })
    assert.ok(labels.indexOf('MATLAB') !== -1, 'MATLAB option missing: ' + labels.join(','))
    assert.equal(labels.indexOf('Bash'), -1, 'unavailable Bash must not be listed')
  })
  find(harness.mini.tree, byTag('select')).props.onChange({ target: { value: 'matlab' } })
  harness.flush()
  check('the MATLAB profile updates the hint strip, console label and status name', () => {
    assert.ok(harness.hasText('figure 自动导出到图表页'))
    assert.ok(harness.hasText('命令窗口'))
    assert.ok(harness.hasText('MATLAB'))
    const hintStrip = find(harness.mini.tree, function hint(node) { return node.props && node.props.className === 'dcr-hintStrip' })
    assert.ok(hintStrip)
    assert.equal(hintStrip.props['data-language'], 'matlab')
  })
  harness.clickText('另存为…')
  harness.flush()
  check('save-as pre-fills the MATLAB profile extension', () => {
    const nameInput = find(harness.mini.tree, function findNameInput(node) {
      return node.tag === 'input' && node.props['aria-label'] === zhDictOf(harness)['editor.saveAsPlaceholder']
    })
    assert.ok(nameInput, 'save-as input missing')
    assert.equal(nameInput.props.value, 'script.m')
  })
  harness.clickText('取消')
  harness.flush()
  harness.typeCode("disp('hi')\n")
  harness.clickText('运行代码')
  await harness.settle(function runSent() { return harness.world.runRequests.length >= 1 })
  check('a starting MATLAB run shows 正在启动 MATLAB…', () => {
    assert.ok(harness.hasText('正在启动 MATLAB…'))
  })
  harness.releaseRun()
  await harness.settle(function matlabFinished() { return harness.hasText('退出码 0') }, 10000)
  check('MATLAB finishing clears the starting marker', () => {
    assert.equal(harness.hasText('正在启动 MATLAB…'), false)
  })
  find(harness.mini.tree, byTag('select')).props.onChange({ target: { value: 'python' } })
  harness.flush()
  check('switching back to Python updates the hint strip and console label', () => {
    assert.ok(harness.hasText('matplotlib 图形自动进图表页'))
    assert.ok(harness.hasText('控制台'))
  })
  harness.unmount()
}

// ── Scenario: language packs dialog (CONTRACT-V5) ─────────────────────────
async function scenarioLanguagePacks() {
  scenario('language packs dialog (v5)')
  const harness = createHarness({ globalToken: 'global-token' })
  harness.mountPage()
  await harness.settle(function ready() { return harness.hasText('宿主已就绪') })
  harness.clickText('语言与功能')
  await harness.settle(function packsLoaded() { return harness.hasText('R · r') })
  check('packs dialog lists detected/local language packs with capture status', () => {
    assert.ok(harness.hasText('语言与功能（按需安装）'))
    assert.ok(harness.hasText('已检测'))
    assert.ok(harness.hasText('未安装'))
    assert.ok(harness.hasText('自动捕获图形'))
    assert.ok(harness.hasText('无图形捕获'))
  })
  check('only detected packs offer the enable action', () => {
    const juliaRow = find(harness.mini.tree, function matchJulia(node) {
      return node.tag === 'div' && node.props.className === 'dcr-packRow' && textOf(node).indexOf('Julia · julia') !== -1
    })
    assert.ok(juliaRow, 'Julia row missing')
    const juliaText = textOf(juliaRow)
    assert.ok(juliaText.indexOf('未检测到') !== -1, 'missing pack should show 未检测到')
    assert.ok(juliaText.indexOf('一键启用') === -1, 'missing pack must not offer the enable action')
  })
  const cRow = find(harness.mini.tree, function matchC(node) {
    return node.tag === 'div' && node.props.className === 'dcr-packRow' && textOf(node).indexOf('C · c') !== -1
  })
  assert.ok(cRow, 'C pack row missing')
  const enableButton = find(cRow, function matchEnable(node) {
    return node.tag === 'button' && textOf(node).trim() === '一键启用'
  })
  assert.ok(enableButton, 'C enable button missing')
  enableButton.props.onClick({})
  await harness.settle(function toggled() { return harness.world.packToggles.length >= 1 })
  check('one-click enable posts {id, enabled:true}', () => {
    const body = harness.world.packToggles[0]
    assert.equal(body.id, 'c')
    assert.equal(body.enabled, true)
  })
  harness.clickText('关闭')
  harness.flush()
  check('closing the packs dialog works', () => {
    assert.equal(harness.hasText('语言与功能（按需安装）'), false)
  })
  harness.unmount()
}

// ── Runner ──────────────────────────────────────────────────────────────────
const SCENARIOS = [
  ['language packs dialog', scenarioLanguagePacks],
  ['element types', scenarioElementTypes],
  ['registrations + locale', scenarioRegistrations],
  ['conversation-header toggle', scenarioHeaderToggle],
  ['page mode', scenarioPageWorkflow],
  ['pane mode', scenarioPaneWorkflow],
  ['token handling', scenarioTokenHandling],
  ['english locale', scenarioEnglish],
  ['shared store + unmount/remount', scenarioUnmountRemount],
  ['error boundary', scenarioErrorBoundary],
  ['selection runs', scenarioSelectionRuns],
  ['AI explain dialog', scenarioExplain],
  ['export report', scenarioExport],
  ['plot saving', scenarioPlotSaving],
  ['language profiles + MATLAB', scenarioLanguageProfiles],
]

for (const entry of SCENARIOS) {
  const name = entry[0]
  const run = entry[1]
  try {
    await run()
  } catch (error) {
    failures.push({ name: name, error: error })
    console.log('SCENARIO ERROR ' + name + ' :: ' + (error && error.stack ? error.stack : String(error)))
  }
}

console.log('\n=== summary ===')
console.log('checks passed: ' + passed.length + ', failed: ' + failures.length)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(' - ' + failure.name + ': ' + (failure.error && failure.error.message ? failure.error.message : String(failure.error)))
  }
  process.exitCode = 1
} else {
  console.log('ALL CLIENT SMOKE CHECKS PASSED')
}
