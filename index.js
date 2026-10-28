/**
 * dsh-code-runner — Host half of the plugin (v3).
 *
 * Registers the token-gated `/dsh-code-runner/api/*` HTTP surface on the DSH Host
 * web server, detects the interpreters installed on this machine, and runs user
 * scripts through the Host `subprocess` service while streaming their output back
 * with non-consuming, byte-offset based readers. v2 added file-mode runs, automatic
 * plot capture and the files/blob/artifacts endpoints; v3 adds LLM code explanation,
 * report export, plot saving and the MATLAB adapter.
 *
 * Plain ESM, Node builtins only, no build step. CONTRACT.md (v1) plus
 * CONTRACT-V2.md and CONTRACT-V3.md are the wire-format spec; JSON field names
 * below are load-bearing for the browser half.
 */
import { constants as FS_CONSTANTS } from 'node:fs'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'dsh-code-runner'
export const inject = ['webServer', 'subprocess']

/* ── Fixed identifiers (CONTRACT.md §0 + CONTRACT-V2.md §0) ────────────────── */

const ROUTE_PREFIX = '/dsh-code-runner'
const API_ENV = `${ROUTE_PREFIX}/api/env`
const API_RUN = `${ROUTE_PREFIX}/api/run`
const API_OUTPUT = `${ROUTE_PREFIX}/api/output`
const API_STOP = `${ROUTE_PREFIX}/api/stop`
const API_TOKEN = `${ROUTE_PREFIX}/api/token`
const API_FILES = `${ROUTE_PREFIX}/api/files`
const API_FILE = `${ROUTE_PREFIX}/api/file`
const API_BLOB = `${ROUTE_PREFIX}/api/blob`
const API_ARTIFACTS = `${ROUTE_PREFIX}/api/artifacts`
const API_DIAG = `${ROUTE_PREFIX}/api/diag`
const API_PACKS = `${ROUTE_PREFIX}/api/packs`
const API_PACKS_RESCAN = `${ROUTE_PREFIX}/api/packs/rescan`
const API_EXPLAIN = `${ROUTE_PREFIX}/api/explain`
const API_EXPORT = `${ROUTE_PREFIX}/api/export`
const API_SAVE_PLOTS = `${ROUTE_PREFIX}/api/save-plots`
const TOKEN_HEADER = 'x-dsh-code-runner-token'
const TOKEN_GLOBAL = '__DSH_CODE_RUNNER__'

/* ── Limits and tunables (documented in README.md) ─────────────────────────── */

const LIMITS = Object.freeze({
  codeMaxBytes: 1024 * 1024,
  outputMaxBytes: 2 * 1024 * 1024,
  spillMaxBytes: 16 * 1024 * 1024,
  bodyMaxBytes: 2 * 1024 * 1024,
  stdinMaxBytes: 1024 * 1024,
  defaultTimeoutMs: 300_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 1_800_000,
  maxRuns: 25,
  envCacheTtlMs: 10 * 60 * 1000,
  probeTimeoutMs: 3_000,
  probeMaxBytes: 4_096,
  stopWaitMs: 500,
  // v2 file / artifact limits (CONTRACT-V2.md §1.2, §1.6, §1.9, §1.10)
  fileMaxBytes: 1024 * 1024,
  blobMaxBytes: 16 * 1024 * 1024,
  artifactMax: 40,
  fileListMaxEntries: 2_000,
  binaryProbeBytes: 8_192,
  artifactCwdWindowMs: 2_000,
  // v2 client diagnostics ring buffer (CONTRACT-V2.md §1.12)
  diagMaxEvents: 100,
  // v3 explain / export / save-plots (CONTRACT-V3.md §1.2–§1.5)
  explainMaxChars: 20_000,
  explainTimeoutMs: 90_000,
  explainOutputMaxChars: 60_000,
  explainFallbackChars: 4_000,
  reportInlineImageBudgetBytes: 32 * 1024 * 1024,
  savePlotsMax: 40,
})

const TMP_ROOT = path.join(os.tmpdir(), 'dsh-code-runner')
const DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443 })

// Spawn environment for every run: deterministic terminal + buffered-stdio knobs.
const RUN_BASE_ENV = Object.freeze({
  TERM: 'dumb',
  NO_COLOR: '1',
  PYTHONUNBUFFERED: '1',
  PYTHONIOENCODING: 'utf-8',
  MPLBACKEND: 'Agg',
})

/* ── v2: extension → language inference (CONTRACT-V2.md §1.3) ──────────────── */

const EXT_LANGUAGE_MAP = Object.freeze({
  py: 'python',
  pyw: 'python',
  r: 'r',
  m: 'matlab',
  mjs: 'node',
  cjs: 'node',
  js: 'node',
  sh: 'bash',
  zsh: 'zsh',
  rb: 'ruby',
  pl: 'perl',
  jl: 'julia',
  php: 'php',
})

// `ts` is resolved at request time to the first *available* language of these.
const TS_LANGUAGE_ORDER = Object.freeze(['deno', 'bun', 'node'])

/* ── v2: image / preview classification (CONTRACT-V2.md §1.9, §1.10) ───────── */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

const BLOB_CONTENT_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
})

/** Marker for the one non-JSON response (GET /api/blob raw bytes). */
const RAW_RESPONSE = Symbol('dsh-code-runner.raw-response')

/* ── v2: plot-capture helper files (CONTRACT-V2.md §1.3.1 / §1.3.2) ────────── */

// Python: reference saver verbatim, then the approved deviation D1 hook. The
// saver is registered once below; matplotlib registers _pylab_helpers.Gcf.destroy_all
// with atexit later (when pyplot is imported), and LIFO would run that cleanup
// BEFORE the saver, closing every figure. The hook restores the real importer the
// first time pyplot has been imported and re-registers the saver so it runs first.
// It never alters user imports: the real importer is restored unconditionally and
// every error is swallowed.
const PYTHON_SITECUSTOMIZE = `# dsh-code-runner: save open matplotlib figures for the panel's Plots tab.
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

# Approved deviation D1 (CONTRACT-V2.md §1.3.1): matplotlib.pyplot registers
# _pylab_helpers.Gcf.destroy_all with atexit when it is imported, i.e. AFTER this
# module. atexit is LIFO, so the figures would be destroyed before the saver above
# runs. Re-register the saver once pyplot has landed, then restore the real importer
# unconditionally; every error is swallowed so user imports are never altered.
import sys as _sys
import builtins as _builtins

_real_import = _builtins.__import__


def _dsh_code_runner_import_hook(name, globals=None, locals=None, fromlist=(), level=0):
    module = _real_import(name, globals, locals, fromlist, level)
    try:
        wants_pyplot = name == "matplotlib.pyplot" or (
            name == "matplotlib" and fromlist and "pyplot" in fromlist
        )
        if wants_pyplot and "matplotlib.pyplot" in _sys.modules:
            _builtins.__import__ = _real_import
            atexit.unregister(_dsh_code_runner_save)
            atexit.register(_dsh_code_runner_save)
    except Exception:
        pass
    return module


_builtins.__import__ = _dsh_code_runner_import_hook
`

// R: opens a png device, then source()s the user script (CONTRACT-V2.md §1.3.2).
const R_PLOT_WRAPPER = `# dsh-code-runner: open a png device so plots are captured for the panel.
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

/* ── v3: MATLAB plot-capture wrapper (CONTRACT-V3.md §1.5) ─────────────────── */

const MATLAB_PLOT_WRAPPER = `% dsh-code-runner: run a MATLAB script and export its figures to PNG.
dshPlotsDir = getenv('DSH_CODE_RUNNER_PLOTS_DIR');
dshScriptPath = getenv('DSH_CODE_RUNNER_SCRIPT');
if isempty(dshPlotsDir) || isempty(dshScriptPath)
  disp('dsh-code-runner: missing DSH_CODE_RUNNER_SCRIPT / DSH_CODE_RUNNER_PLOTS_DIR');
  exit(1);
end
if ~exist(dshPlotsDir, 'dir')
  mkdir(dshPlotsDir);
end
try
  run(dshScriptPath);
  dshFigures = findall(0, 'Type', 'figure');
  for dshIndex = 1:numel(dshFigures)
    dshTarget = fullfile(dshPlotsDir, sprintf('plot-%03d.png', dshIndex));
    try
      exportgraphics(dshFigures(dshIndex), dshTarget, 'Resolution', 144);
    catch
      try, print(dshFigures(dshIndex), dshTarget, '-dpng', '-r144'); catch, end
    end
  end
catch err
  disp(getReport(err));
  exit(1);
end
`

/** MATLAB `-batch` argument: run("path") with embedded double quotes doubled. */
function matlabRunArgument(targetPath) {
  return `run("${String(targetPath ?? '').replace(/"/g, '""')}")`
}

/** Existing executable MATLAB launchers, in CONTRACT-V3 §1.5 discovery order. */
async function discoverMatlabCandidates() {
  const isExecutableFile = async (candidate) => {
    try {
      const candidateStat = await fsp.stat(candidate)
      if (!candidateStat.isFile()) return false
      await fsp.access(candidate, FS_CONSTANTS.X_OK)
      return true
    } catch {
      return false
    }
  }
  const candidates = []
  try {
    const entries = await fsp.readdir('/Applications')
    const matches = entries.filter((name) => /^MATLAB_R.*\.app$/.test(name)).sort().reverse()
    for (const name of matches) {
      const candidate = path.join('/Applications', name, 'bin', 'matlab')
      if (await isExecutableFile(candidate)) candidates.push(candidate)
    }
  } catch {
    /* not macOS / no /Applications */
  }
  try {
    const versions = await fsp.readdir('/usr/local/MATLAB')
    for (const name of versions.sort()) {
      const candidate = path.join('/usr/local/MATLAB', name, 'bin', 'matlab')
      if (await isExecutableFile(candidate)) candidates.push(candidate)
    }
  } catch {
    /* no /usr/local/MATLAB */
  }
  return candidates
}

/* ── v3: explain prompt/parsing helpers (CONTRACT-V3.md §1.2) ──────────────── */

const EXPLAIN_SYSTEM_PROMPT = [
  'You explain and annotate source code for a desktop code-runner panel.',
  'Reply with STRICT JSON only — no code fences, no prose, no extra keys:',
  '{"summary": "<中文、3-8 句，说明这段代码的目的、输入、关键步骤、输出>", "annotatedCode": "<与原代码语义完全一致、只增加注释（Python/R 用 #，MATLAB 用 %）的版本>"}',
  'annotatedCode must stay semantically identical to the original code: add comments only.',
].join('\n')

const FENCE_LANGUAGES = Object.freeze({ node: 'js', deno: 'ts', bun: 'ts', matlab: 'matlab' })

function languageFence(languageId) {
  const id = typeof languageId === 'string' && languageId !== '' ? languageId : 'text'
  return FENCE_LANGUAGES[id] ?? id
}

function buildExplainUserPrompt(languageId, fileName, code) {
  const lines = [`Language: ${languageId}`]
  if (typeof fileName === 'string' && fileName !== '') lines.push(`File: ${fileName}`)
  lines.push('Code:', `\`\`\`${languageFence(languageId)}`, code, '```')
  return lines.join('\n')
}

/** Remove Markdown fence lines so a fenced JSON object can still be parsed. */
function stripMarkdownFences(text) {
  return String(text ?? '').replace(/```[A-Za-z0-9_-]*[ \t]*\r?\n?/g, '')
}

/** First balanced {...} object in a text, honouring JSON strings/escapes. */
function extractBalancedJsonObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

/** Parse the model reply into {summary, annotatedCode} with a raw-text fallback. */
function parseExplainText(rawText) {
  const raw = String(rawText ?? '')
  const candidate = extractBalancedJsonObject(stripMarkdownFences(raw))
  if (candidate) {
    try {
      const payload = JSON.parse(candidate)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
        const annotatedCode = typeof payload.annotatedCode === 'string' ? payload.annotatedCode : ''
        if (summary !== '' || annotatedCode.trim() !== '') return { summary, annotatedCode }
      }
    } catch {
      /* fall through to the raw-text fallback */
    }
  }
  return { summary: raw.trim().slice(0, LIMITS.explainFallbackChars), annotatedCode: '' }
}

/* ── v3: report formatting helpers (CONTRACT-V3.md §1.3) ───────────────────── */

const REPORT_DIR_NAME = 'dsh-code-runner-reports'
const REPORT_TRUNCATED_MARKER = '…（已截断）'

function padTwo(value) {
  return String(value).padStart(2, '0')
}

/** Local `YYYYMMDD-HHmmss` folder stamp. */
function formatTimestamp(date) {
  return (
    `${date.getFullYear()}${padTwo(date.getMonth() + 1)}${padTwo(date.getDate())}` +
    `-${padTwo(date.getHours())}${padTwo(date.getMinutes())}${padTwo(date.getSeconds())}`
  )
}

/** Local `YYYY-MM-DD HH:mm:ss` display time. */
function formatLocalTime(date) {
  return (
    `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())} ` +
    `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`
  )
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** Fenced code block whose fence is longer than any backtick run in the body. */
function fencedBlock(body, info = '') {
  const text = String(body ?? '')
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
}

/** UTF-8 safe truncation to a byte budget. */
function truncateUtf8(text, maxBytes) {
  const value = typeof text === 'string' ? text : ''
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { text: value, truncated: false }
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** `name-1.ext`, `name-2.ext`, … used when a target file already exists. */
function appendNameSuffix(name, attempt) {
  const ext = path.extname(name)
  const base = ext === '' ? name : name.slice(0, name.length - ext.length)
  return `${base}-${attempt}${ext}`
}

/** Safe display name for a copied plot (never a path). */
function plotDisplayName(requestedName, sourcePath) {
  const raw = typeof requestedName === 'string' && requestedName.trim() !== '' ? requestedName : sourcePath
  const base = path.basename(String(raw ?? '')).replace(/[\\/]/g, '_').trim()
  return base === '' ? 'plot' : base
}

/* ── Language table (order is part of the contract: CONTRACT.md §1.5) ──────── */

const LANGUAGES = [
  {
    id: 'python',
    label: 'Python',
    candidates: [
      'python3',
      'python',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/opt/anaconda3/bin/python3',
      '/opt/anaconda3/bin/python',
      '/usr/bin/python3',
    ],
    scriptFile: 'script.py',
    args: ['-u'],
    template: 'print("Hello from Python", 1 + 1)\n',
    extensions: ['py', 'pyw'],
  },
  {
    id: 'r',
    label: 'R',
    candidates: [
      'Rscript',
      '/opt/homebrew/bin/Rscript',
      '/usr/local/bin/Rscript',
      '/Library/Frameworks/R.framework/Resources/bin/Rscript',
      '/usr/bin/Rscript',
    ],
    scriptFile: 'script.R',
    args: ['--vanilla'],
    template: 'cat("Hello from R\\n")\n',
    extensions: ['r'],
  },
  {
    id: 'matlab',
    label: 'MATLAB',
    candidates: ['matlab'],
    scriptFile: 'script.m',
    args: [],
    skipVersionProbe: true,
    extensions: ['m'],
    template: '% MATLAB\nfprintf("Hello from MATLAB\\n");\n',
  },
  {
    id: 'node',
    label: 'Node.js',
    candidates: ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node'],
    scriptFile: 'script.mjs',
    args: [],
    template: 'console.log("Hello from Node.js", process.version)\n',
    extensions: ['mjs', 'cjs', 'js'],
  },
  {
    id: 'bash',
    label: 'Bash',
    candidates: ['bash', '/bin/bash'],
    scriptFile: 'script.sh',
    args: [],
    template: 'echo "Hello from Bash"\n',
    extensions: ['sh'],
  },
  {
    id: 'zsh',
    label: 'Zsh',
    candidates: ['zsh', '/bin/zsh'],
    scriptFile: 'script.zsh',
    args: [],
    template: '# zsh\necho "Hello from Zsh"\n',
    extensions: ['zsh'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    candidates: ['ruby', '/usr/bin/ruby'],
    scriptFile: 'script.rb',
    args: [],
    template: '# ruby\nputs "Hello from Ruby"\n',
    extensions: ['rb'],
  },
  {
    id: 'perl',
    label: 'Perl',
    candidates: ['perl', '/usr/bin/perl'],
    scriptFile: 'script.pl',
    args: [],
    template: '# perl\nprint "Hello from Perl\\n";\n',
    extensions: ['pl'],
  },
  {
    id: 'julia',
    label: 'Julia',
    candidates: ['julia'],
    scriptFile: 'script.jl',
    args: [],
    template: '# julia\nprintln("Hello from Julia")\n',
    extensions: ['jl'],
  },
  {
    id: 'deno',
    label: 'Deno',
    candidates: ['deno'],
    scriptFile: 'script.ts',
    args: ['run', '--allow-all'],
    template: '// deno\nconsole.log("Hello from Deno")\n',
    extensions: ['ts'],
  },
  {
    id: 'bun',
    label: 'Bun',
    candidates: ['bun'],
    scriptFile: 'script.ts',
    args: ['run'],
    template: '// bun\nconsole.log("Hello from Bun")\n',
    extensions: ['ts'],
  },
  {
    id: 'php',
    label: 'PHP',
    candidates: ['php'],
    scriptFile: 'script.php',
    args: [],
    template: '<?php\necho "Hello from PHP\\n";\n',
    extensions: ['php'],
  },
]

/* ── v5: opt-in language packs (detected → auto-installed capture config) ── */

/**
 * Extra language packs that are NOT enabled by default. They are listed by
 * /api/packs and become real languages in /api/env only after the user enables
 * (one-click "install") them AND the toolchain is detected on this machine.
 */
const EXTRA_LANGUAGE_PACKS = [
  {
    id: 'c',
    label: 'C',
    candidates: ['clang', 'gcc', '/usr/bin/clang', '/usr/bin/gcc'],
    scriptFile: 'main.c',
    args: [],
    template: '#include <stdio.h>\n\nint main(void) {\n  printf("Hello from C\\n");\n  return 0;\n}\n',
    extensions: ['c'],
    skipVersionProbe: true,
    builtin: false,
    captureKind: 'none',
    compile: {
      candidates: ['clang', 'gcc', '/usr/bin/clang', '/usr/bin/gcc'],
      args: (scriptPath, outputPath) => ['-O2', '-o', outputPath, scriptPath],
      outputFile: 'program',
    },
  },
  {
    id: 'cpp',
    label: 'C++',
    candidates: ['clang++', 'g++', '/usr/bin/clang++', '/usr/bin/g++'],
    scriptFile: 'main.cpp',
    args: [],
    template: '#include <iostream>\n\nint main() {\n  std::cout << "Hello from C++" << std::endl;\n  return 0;\n}\n',
    extensions: ['cpp', 'cc', 'cxx'],
    skipVersionProbe: true,
    builtin: false,
    captureKind: 'none',
    compile: {
      candidates: ['clang++', 'g++', '/usr/bin/clang++', '/usr/bin/g++'],
      args: (scriptPath, outputPath) => ['-O2', '-std=c++17', '-o', outputPath, scriptPath],
      outputFile: 'program',
    },
  },
  {
    id: 'swift',
    label: 'Swift',
    candidates: ['swift', '/usr/bin/swift'],
    scriptFile: 'main.swift',
    args: [],
    template: 'print("Hello from Swift")\n',
    extensions: ['swift'],
    skipVersionProbe: true,
    builtin: false,
    captureKind: 'none',
  },
]

/** Built-in capture adapter kind per language id (CONTRACT-V5 §1.2). */
const BUILTIN_CAPTURE_KIND = Object.freeze({ python: 'python', r: 'r', matlab: 'matlab' })

/** All known packs (built-ins first, opt-in extras last). */
function allLanguagePacks() {
  return [...LANGUAGES, ...EXTRA_LANGUAGE_PACKS]
}

function findLanguagePack(id) {
  return allLanguagePacks().find((entry) => entry.id === id) || null
}

/** Capture adapter metadata for a pack. */
function captureKindOf(pack) {
  if (pack.captureKind !== undefined) return pack.captureKind
  return BUILTIN_CAPTURE_KIND[pack.id] || 'none'
}

/** Directory holding pack settings + installed capture helpers. */
function packStateDir() {
  const override = process.env.DSH_CODE_RUNNER_STATE_DIR
  if (typeof override === 'string' && override !== '') return override
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-code-runner')
}

const PACK_HELPER_FILES = Object.freeze({
  python: 'sitecustomize.py',
  r: 'plot-wrapper.R',
  matlab: 'dsh_plot_wrapper.m',
})

const PACK_HELPER_CONTENT = Object.freeze({
  python: PYTHON_SITECUSTOMIZE,
  r: R_PLOT_WRAPPER,
  matlab: MATLAB_PLOT_WRAPPER,
})

let packSettingsCache = null
let capturingDependencyCache = new Map()

/** Settings schema: { disabledBuiltins: string[], enabledExtras: string[], installed: string[] }. */
async function loadPackSettings() {
  if (packSettingsCache !== null) return packSettingsCache
  const empty = { disabledBuiltins: [], enabledExtras: [], installed: [] }
  try {
    const raw = await fsp.readFile(path.join(packStateDir(), 'packs.json'), 'utf8')
    const parsed = JSON.parse(raw)
    packSettingsCache = {
      disabledBuiltins: Array.isArray(parsed.disabledBuiltins) ? parsed.disabledBuiltins.filter((v) => typeof v === 'string') : [],
      enabledExtras: Array.isArray(parsed.enabledExtras) ? parsed.enabledExtras.filter((v) => typeof v === 'string') : [],
      installed: Array.isArray(parsed.installed) ? parsed.installed.filter((v) => typeof v === 'string') : [],
    }
  } catch {
    packSettingsCache = empty
  }
  return packSettingsCache
}

async function savePackSettings(next) {
  packSettingsCache = next
  try {
    const dir = packStateDir()
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const target = path.join(dir, 'packs.json')
    const temporary = target + '.tmp'
    await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temporary, target)
  } catch {
    /* best effort: the in-memory setting still applies for this process */
  }
}

/** A pack's capture helper directory (`<state>/packs/<id>`). */
function packInstallDir(id) {
  return path.join(packStateDir(), 'packs', id)
}

/** Write the capture helper for a pack (idempotent). Returns the installed path or null. */
async function installPackAssets(id) {
  const pack = findLanguagePack(id)
  if (!pack) return null
  const kind = captureKindOf(pack)
  if (kind === 'none') return null
  const fileName = PACK_HELPER_FILES[kind]
  const content = PACK_HELPER_CONTENT[kind]
  if (!fileName || typeof content !== 'string') return null
  const dir = packInstallDir(id)
  const target = path.join(dir, fileName)
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.writeFile(target, content, { mode: 0o600 })
  } catch {
    return null
  }
  const settings = await loadPackSettings()
  if (settings.installed.indexOf(id) < 0) {
    await savePackSettings({ ...settings, installed: [...settings.installed, id] })
  }
  return target
}

/** Whether the installed capture helper for a pack exists on disk. */
async function isPackInstalled(id) {
  const kind = captureKindOf(findLanguagePack(id) || { id })
  const fileName = PACK_HELPER_FILES[kind]
  if (!fileName) return false
  try {
    const stat = await fsp.stat(path.join(packInstallDir(id), fileName))
    return stat.isFile()
  } catch {
    return false
  }
}

/** Installed helper file path for a capture kind (null when not installed). */
async function installedHelperPath(kind) {
  const ids = Object.keys(PACK_HELPER_FILES).filter((key) => PACK_HELPER_FILES[key] === PACK_HELPER_FILES[kind])
  for (const id of ids) {
    const candidate = path.join(packInstallDir(id), PACK_HELPER_FILES[kind])
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Runtime readiness of a pack's capture adapter:
 * python needs matplotlib importable; r/matlab ship their graphics device.
 */
async function probeCaptureReadiness(pack, detected) {
  const kind = captureKindOf(pack)
  if (kind === 'none') return { kind, ready: false, hint: null, required: false }
  if (!detected) return { kind, ready: false, hint: '语言未安装', required: true }
  if (kind === 'r' || kind === 'matlab') {
    return { kind, ready: true, hint: null, required: true }
  }
  const command = detected.command
  const cacheKey = `${pack.id}:${command}`
  const now = Date.now()
  const cached = capturingDependencyCache.get(cacheKey)
  if (cached && now - cached.at < 10 * 60 * 1000) return cached.value
  let value = { kind, ready: false, hint: '需要 matplotlib：pip install matplotlib', required: true }
  try {
    const probe = await withTimeout(Promise.resolve().then(async () => {
      const handle = ctxRef?.subprocess?.spawn
        ? ctxRef.subprocess.spawn({
            argv: [command, '-c', 'import matplotlib'],
            cwd: os.tmpdir(),
            stdio: { stdin: 'ignore', stdout: { maxBytes: 2048 }, stderr: { maxBytes: 2048 } },
            env: { PATH: process.env.PATH ?? '', MPLCONFIGDIR: path.join(os.tmpdir(), 'dsh-code-runner-mpl') },
            graceMs: 500,
          })
        : null
      if (!handle) return false
      const outcome = await handle.done
      try { handle.terminate?.() } catch {}
      return outcome && outcome.exitCode === 0
    }), 8000)
    if (probe === true) value = { kind, ready: true, hint: null, required: true }
  } catch {
    /* keep the hint */
  }
  capturingDependencyCache.set(cacheKey, { at: now, value })
  return value
}

let ctxRef = null

/* ── Small pure helpers ────────────────────────────────────────────────────── */

/** HTTP error that the request handler turns into a stable JSON failure envelope. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code stable error code (CONTRACT-V2.md §1.1)
   * @param {string} message
   * @param {object} [extra] additional top-level fields (e.g. 409 currentMtimeMs)
   */
  constructor(status, code, message, extra) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.extra = extra || null
  }
}

function failurePayload(code, message) {
  return { ok: false, error: { code, message: String(message) } }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body, 'utf8'))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** The one non-JSON response: raw bytes for GET /api/blob (CONTRACT-V2.md §1.9). */
function sendRaw(res, status, body, contentType) {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', body.length)
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Lowercase extension of a path without the dot ("" when there is none). */
function pathExtension(filePath) {
  const ext = path.extname(String(filePath ?? ''))
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ''
}

/** True when `candidate` lives inside directory `parent` (path-normalised). */
function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Required absolute-path query parameter for the v2 file routes (§1.6–§1.9). */
function requireAbsoluteQueryPath(url, name) {
  const value = url.searchParams.get(name)
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) {
    throw new HttpError(400, 'bad-path', `${name} must be an absolute path`)
  }
  return value
}

/** Case-insensitive header lookup that tolerates plain objects as well as Node's. */
function getHeader(req, name) {
  const headers = req && typeof req === 'object' ? req.headers : undefined
  if (!headers || typeof headers !== 'object') return undefined
  const direct = headers[name]
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : String(direct)
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue
    const value = headers[key]
    if (value === undefined) return undefined
    return Array.isArray(value) ? value[0] : String(value)
  }
  return undefined
}

/** Constant-time-ish string comparison (length differences are still compared). */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    try {
      crypto.timingSafeEqual(a, Buffer.alloc(a.length))
    } catch {
      /* ignore */
    }
    return false
  }
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Strip IPv6 brackets and lowercase a hostname. */
function normalizeHostname(hostname) {
  let value = String(hostname ?? '').trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value.endsWith('.')) value = value.slice(0, -1)
  return value
}

/**
 * Parse a Host header into `{ hostname, port }`.
 * Handles `host:port`, bracketed IPv6 (`[::1]:57598`) and bare IPv6 (`::1`).
 */
function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return null
  const raw = hostHeader.trim()
  if (!raw) return null
  let hostname = raw
  let port = ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close < 0) return null
    hostname = raw.slice(0, close + 1)
    const rest = raw.slice(close + 1)
    if (rest.startsWith(':')) port = rest.slice(1)
    else if (rest !== '') return null
  } else {
    const first = raw.indexOf(':')
    if (first >= 0) {
      if (raw.indexOf(':', first + 1) >= 0) {
        // Bare (unbracketed) IPv6 literal — no port component.
        hostname = raw
        port = ''
      } else {
        hostname = raw.slice(0, first)
        port = raw.slice(first + 1)
      }
    }
  }
  if (port !== '' && !/^\d{1,5}$/.test(port)) return null
  return { hostname: normalizeHostname(hostname), port }
}

/** Parse an absolute Origin header; only http(s) origins are meaningful here. */
function parseOrigin(originHeader) {
  if (typeof originHeader !== 'string' || !originHeader) return null
  let url
  try {
    url = new URL(originHeader)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { hostname: normalizeHostname(url.hostname), port: url.port || '', protocol: url.protocol }
}

function isLoopbackIPv4(value) {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackHostname(hostname) {
  const value = normalizeHostname(hostname)
  return value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1' || isLoopbackIPv4(value)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  let value = address.trim().toLowerCase()
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  return isLoopbackIPv4(value)
}

/**
 * Same-authority origin check (CONTRACT.md §1.3): explicitly configured origin,
 * or origin host[:port] equal to the request Host header (scheme may differ behind
 * a reverse proxy; default ports normalized).
 */
function originMatchesHost(originHeader, hostHeader) {
  const origin = parseOrigin(originHeader)
  const host = parseHostHeader(hostHeader)
  if (!origin || !host || origin.hostname !== host.hostname) return false
  const originPort = origin.port || String(DEFAULT_PORTS[origin.protocol] ?? '')
  const hostPort = host.port || String(DEFAULT_PORTS[origin.protocol] ?? '')
  return originPort !== '' && originPort === hostPort
}

/** Read the request body with `on('data'|'end'|'error')`, capped at maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve('')
      return
    }
    const chunks = []
    let size = 0
    let settled = false

    const finish = (error, text) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      if (!error) {
        resolve(text)
        return
      }
      // Swallow any late transport error and drain the rest of the body.
      try {
        req.on('error', () => {})
      } catch {
        /* ignore */
      }
      try {
        req.resume?.()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    const onData = (chunk) => {
      if (settled) return
      let buffer
      if (Buffer.isBuffer(chunk)) buffer = chunk
      else if (typeof chunk === 'string') buffer = Buffer.from(chunk)
      else buffer = Buffer.from(String(chunk))
      size += buffer.length
      if (size > maxBytes) {
        finish(new HttpError(413, 'body-too-large', `request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) =>
      finish(
        new HttpError(400, 'bad-request', `could not read request body: ${error?.message ?? error}`),
      )

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** Parse an optional JSON request body (empty body → `{}`). */
function parseJsonBody(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new HttpError(400, 'bad-json', `request body is not valid JSON: ${error?.message ?? error}`)
  }
}

function requireObjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object')
  }
  return body
}

/** Parse a byte offset query parameter; anything invalid falls back to 0 (§1.8). */
function parseOffset(value) {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return 0
  return parsed
}

/** Non-consuming read from a provider collect reader; tolerant of missing readers. */
function readCollected(handle, streamName, fromByte) {
  const fallback = { text: '', nextOffset: fromByte, lossy: false }
  try {
    const reader = handle && handle.collected ? handle.collected[streamName] : undefined
    if (!reader || typeof reader.readFrom !== 'function') return fallback
    const result = reader.readFrom(fromByte) || {}
    return {
      text: typeof result.text === 'string' ? result.text : '',
      nextOffset: Number.isInteger(result.nextOffset) ? result.nextOffset : fromByte,
      lossy: Boolean(result.lossy),
    }
  } catch {
    return fallback
  }
}

function firstNonEmptyLine(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, 80)
  }
  return null
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Bounded wait for a run to settle; clears its own timer as soon as it fires. */
function waitForRunExit(run, ms) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    Promise.resolve(run.donePromise).then(finish, finish)
  })
}

/* ── Plugin ────────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  ctxRef = ctx
  const token = crypto.randomBytes(24).toString('hex')
  const tokenScript = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify({ token })};</script>`

  /** @type {Map<string, object>} */
  const runs = new Map()
  /** @type {Set<object>} */
  const activeProbes = new Set()
  /** In-memory ring buffer of browser-side diagnostics (CONTRACT-V2.md §1.11). */
  const diagEvents = []
  let diagSeq = 0
  let envCache = null
  let envCacheAt = 0
  let envCachePromise = null
  let disposed = false

  /* ── Environment (default cwd) ───────────────────────────────────────────── */

  function defaultCwd() {
    try {
      const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      const directory =
        workingDirectory && typeof workingDirectory.defaultDirectory === 'string'
          ? workingDirectory.defaultDirectory
          : ''
      if (directory) return directory
    } catch {
      /* optional service — ignore */
    }
    try {
      const cwd = process.cwd()
      if (cwd) return cwd
    } catch {
      /* cwd may have been deleted */
    }
    return os.tmpdir()
  }

  /* ── Authorization (CONTRACT.md §1.3) ────────────────────────────────────── */

  function authorize(req) {
    const supplied = getHeader(req, TOKEN_HEADER)
    if (!safeEqual(supplied, token)) {
      throw new HttpError(401, 'unauthorized', 'missing or invalid host token — reload the page')
    }
    const origin = getHeader(req, 'origin')
    if (origin !== undefined && origin !== '') {
      let expectedOrigin = null
      try {
        expectedOrigin = ctx.webServer.getOrigin()
      } catch {
        expectedOrigin = null
      }
      const matchesConfiguredOrigin =
        typeof expectedOrigin === 'string' && expectedOrigin !== '' && origin === expectedOrigin
      if (!matchesConfiguredOrigin && !originMatchesHost(origin, getHeader(req, 'host'))) {
        throw new HttpError(403, 'forbidden', 'request origin is not allowed')
      }
    }
    const site = getHeader(req, 'sec-fetch-site')
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'forbidden', 'cross-site requests are not allowed')
    }
  }

  /* ── Token bootstrap (CONTRACT.md §1.10) ─────────────────────────────────── */

  function authorizeTokenBootstrap(req) {
    const remoteAddress = req && req.socket ? req.socket.remoteAddress : undefined
    if (!isLoopbackAddress(remoteAddress)) {
      throw new HttpError(403, 'forbidden', 'token bootstrap is only available to loopback clients')
    }
    const host = parseHostHeader(getHeader(req, 'host'))
    if (!host || !isLoopbackHostname(host.hostname)) {
      throw new HttpError(403, 'forbidden', 'token bootstrap requires a loopback Host header')
    }
    const site = getHeader(req, 'sec-fetch-site')
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
      throw new HttpError(403, 'forbidden', 'cross-site requests are not allowed')
    }
    const origin = getHeader(req, 'origin')
    if (origin !== undefined && origin !== '') {
      const parsed = parseOrigin(origin)
      if (!parsed || !isLoopbackHostname(parsed.hostname)) {
        throw new HttpError(403, 'forbidden', 'token bootstrap requires a loopback origin')
      }
    }
  }

  /* ── Language detection + version probing (CONTRACT.md §1.5) ─────────────── */

  async function resolveCommand(language) {
    const resolve = ctx.subprocess && ctx.subprocess.resolveExecutable
    if (typeof resolve !== 'function') return null
    for (const candidate of language.candidates) {
      try {
        const resolved = await resolve.call(ctx.subprocess, candidate)
        if (typeof resolved === 'string' && resolved.trim() !== '') return resolved
      } catch {
        /* try the next candidate */
      }
    }
    // Second pass for bare names with an explicit PATH in case the host provider
    // scrubbed the environment during the plain lookup.
    for (const candidate of language.candidates) {
      if (candidate.includes('/') || candidate.includes('\\')) continue
      try {
        const resolved = await resolve.call(ctx.subprocess, candidate, {
          PATH: process.env.PATH ?? '',
        })
        if (typeof resolved === 'string' && resolved.trim() !== '') return resolved
      } catch {
        /* give up on this candidate */
      }
    }
    // v3 MATLAB discovery (CONTRACT-V3.md §1.5): launchers installed as macOS app
    // bundles / under /usr/local/MATLAB are not necessarily on PATH.
    if (language.id === 'matlab') {
      for (const candidate of await discoverMatlabCandidates()) {
        try {
          const resolved = await resolve.call(ctx.subprocess, candidate)
          if (typeof resolved === 'string' && resolved.trim() !== '') return resolved
        } catch {
          /* try the next discovered launcher */
        }
      }
    }
    return null
  }

  async function probeVersion(command) {
    let handle = null
    try {
      handle = ctx.subprocess.spawn({
        argv: [command, '--version'],
        cwd: os.tmpdir(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: LIMITS.probeMaxBytes },
          stderr: { maxBytes: LIMITS.probeMaxBytes },
        },
        graceMs: 1_000,
      })
      activeProbes.add(handle)
      await withTimeout(Promise.resolve(handle.done), LIMITS.probeTimeoutMs)
      const stdoutText = readCollected(handle, 'stdout', 0).text
      const stderrText = readCollected(handle, 'stderr', 0).text
      return firstNonEmptyLine(stdoutText) ?? firstNonEmptyLine(stderrText) ?? null
    } catch {
      try {
        handle?.terminate?.()
      } catch {
        /* probing must never break /api/env */
      }
      return null
    } finally {
      if (handle) activeProbes.delete(handle)
    }
  }

  /** Packs the user currently wants in the language picker (CONTRACT-V5 §1.1). */
  async function activeLanguagePacks() {
    const settings = await loadPackSettings()
    return allLanguagePacks().filter((pack) => {
      const builtin = pack.builtin !== false
      if (builtin) return settings.disabledBuiltins.indexOf(pack.id) < 0
      return settings.enabledExtras.indexOf(pack.id) >= 0
    })
  }

  async function buildEnv() {
    try {
      const languages = await Promise.all(
        (await activeLanguagePacks()).map(async (language) => {
          const command = await resolveCommand(language)
          const version = command && !language.skipVersionProbe ? await probeVersion(command) : null
          return {
            id: language.id,
            label: language.label,
            available: Boolean(command),
            command: command ?? null,
            version: version ?? null,
            template: language.template,
            extensions: [...language.extensions],
          }
        }),
      )
      // CONTRACT-V5 §1.2: detection installs the language's capture helper once,
      // so a machine that only has R never gets Python/MATLAB helper files.
      for (const entry of languages) {
        if (!entry.available) continue
        const pack = findLanguagePack(entry.id)
        if (!pack) continue
        const kind = captureKindOf(pack)
        if (kind === 'none') continue
        if (!(await isPackInstalled(pack.id))) await installPackAssets(pack.id)
      }
      return {
        ok: true,
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        defaultCwd: defaultCwd(),
        tmpRoot: TMP_ROOT,
        limits: {
          codeMaxBytes: LIMITS.codeMaxBytes,
          outputMaxBytes: LIMITS.outputMaxBytes,
          defaultTimeoutMs: LIMITS.defaultTimeoutMs,
          maxTimeoutMs: LIMITS.maxTimeoutMs,
          fileMaxBytes: LIMITS.fileMaxBytes,
          blobMaxBytes: LIMITS.blobMaxBytes,
          artifactMax: LIMITS.artifactMax,
          explainMaxChars: LIMITS.explainMaxChars,
        },
        languages,
      }
    } catch {
      // /api/env must never fail: degrade to "nothing detected".
      return {
        ok: true,
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        defaultCwd: defaultCwd(),
        tmpRoot: TMP_ROOT,
        limits: {
          codeMaxBytes: LIMITS.codeMaxBytes,
          outputMaxBytes: LIMITS.outputMaxBytes,
          defaultTimeoutMs: LIMITS.defaultTimeoutMs,
          maxTimeoutMs: LIMITS.maxTimeoutMs,
          fileMaxBytes: LIMITS.fileMaxBytes,
          blobMaxBytes: LIMITS.blobMaxBytes,
          artifactMax: LIMITS.artifactMax,
          explainMaxChars: LIMITS.explainMaxChars,
        },
        languages: allLanguagePacks().map((language) => ({
          id: language.id,
          label: language.label,
          available: false,
          command: null,
          version: null,
          template: language.template,
          extensions: [...language.extensions],
        })),
      }
    }
  }

  async function getEnv(options = {}) {
    const now = Date.now()
    if (!options.refresh && envCache && now - envCacheAt < LIMITS.envCacheTtlMs) return envCache
    if (!options.refresh && envCachePromise) return envCachePromise
    const promise = buildEnv().then(
      (env) => {
        envCache = env
        envCacheAt = Date.now()
        if (envCachePromise === promise) envCachePromise = null
        return env
      },
      (error) => {
        if (envCachePromise === promise) envCachePromise = null
        throw error
      },
    )
    envCachePromise = promise
    return promise
  }

  /* ── Run lifecycle ───────────────────────────────────────────────────────── */

  function finishRun(run, exitCode, signal, error) {
    if (run.finishedAt !== null) return
    run.exitCode = Number.isInteger(exitCode) ? exitCode : null
    run.signal = typeof signal === 'string' ? signal : null
    if (error) run.error = String(error?.message ?? error)
    run.finishedAt = Date.now()
    run.durationMs = run.finishedAt - run.startedAt
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
  }

  function removeRunDirectory(run) {
    if (!run || !run.dir) return Promise.resolve()
    try {
      return fsp.rm(run.dir, { recursive: true, force: true }).catch(() => {})
    } catch {
      return Promise.resolve()
    }
  }

  function terminateRun(run) {
    if (!run) return
    if (run.finishedAt !== null) return
    try {
      run.handle?.terminate?.()
    } catch {
      /* grace failures must never crash the plugin */
    }
  }

  function evictOldRuns() {
    while (runs.size > LIMITS.maxRuns) {
      const oldest = runs.values().next().value
      if (!oldest) break
      runs.delete(oldest.runId)
      terminateRun(oldest)
      if (oldest.timer) {
        clearTimeout(oldest.timer)
        oldest.timer = null
      }
      removeRunDirectory(oldest)
    }
  }

  async function resolveRunCwd(requested) {
    if (requested !== undefined && requested !== null) {
      if (typeof requested !== 'string' || !path.isAbsolute(requested)) {
        throw new HttpError(400, 'bad-cwd', 'cwd must be an absolute path')
      }
      let stat
      try {
        stat = await fsp.stat(requested)
      } catch {
        throw new HttpError(400, 'bad-cwd', `cwd is not an existing directory: ${requested}`)
      }
      if (!stat.isDirectory()) {
        throw new HttpError(400, 'bad-cwd', `cwd is not a directory: ${requested}`)
      }
      return requested
    }
    const fallback = defaultCwd()
    try {
      const stat = await fsp.stat(fallback)
      if (stat.isDirectory()) return fallback
    } catch {
      /* fall through to the temp directory */
    }
    return os.tmpdir()
  }

  function resolveTimeout(value) {
    if (value === undefined || value === null) return LIMITS.defaultTimeoutMs
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new HttpError(400, 'bad-request', 'timeoutMs must be a finite number')
    }
    const clamped = Math.min(LIMITS.maxTimeoutMs, Math.max(LIMITS.minTimeoutMs, Math.trunc(value)))
    return clamped
  }

  function resolveStdin(value) {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') {
      throw new HttpError(400, 'bad-request', 'stdin must be a string')
    }
    if (Buffer.byteLength(value, 'utf8') > LIMITS.stdinMaxBytes) {
      throw new HttpError(413, 'body-too-large', `stdin exceeds ${LIMITS.stdinMaxBytes} bytes`)
    }
    return value
  }

  /* ── v2: file-mode + plot capture helpers (CONTRACT-V2.md §1.3) ───────────── */

  function inferLanguageId(filePath, env) {
    const ext = pathExtension(filePath)
    if (ext === 'ts') {
      for (const id of TS_LANGUAGE_ORDER) {
        const entry = env.languages.find((language) => language.id === id)
        if (entry && entry.available && entry.command) return id
      }
      return null
    }
    const mapped = EXT_LANGUAGE_MAP[ext]
    if (mapped !== undefined && mapped !== null) return mapped
    for (const pack of allLanguagePacks()) {
      if (Array.isArray(pack.extensions) && pack.extensions.indexOf(ext) >= 0) return pack.id
    }
    return null
  }

  async function resolveRunFile(requestedFile) {
    if (typeof requestedFile !== 'string' || !path.isAbsolute(requestedFile)) {
      throw new HttpError(400, 'bad-path', 'file must be an absolute path')
    }
    let fileStat
    try {
      fileStat = await fsp.stat(requestedFile)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new HttpError(404, 'not-found', `file not found: ${requestedFile}`)
      }
      throw new HttpError(400, 'bad-path', `could not stat file: ${requestedFile}`)
    }
    if (!fileStat.isFile()) {
      throw new HttpError(400, 'bad-path', `not a regular file: ${requestedFile}`)
    }
    return requestedFile
  }

  /**
   * Create <runDir>/plots plus the language-specific capture helper (§1.3.1/§1.3.2).
   * Returns the helper paths so the caller can wire argv/env.
   */
  async function preparePlotCapture(language, dir, plotDir) {
    const result = { pythonSiteDir: null, plotWrapperPath: null }
    const kind = captureKindOf(language)
    if (kind === 'none') return result
    await fsp.mkdir(plotDir, { recursive: true, mode: 0o700 })
    // Prefer the helper installed for this language (CONTRACT-V5 §1.2); fall
    // back to a per-run copy so a first run before installation still works.
    const installed = await installedHelperPath(kind)
    if (kind === 'python') {
      if (installed !== null) {
        result.pythonSiteDir = path.dirname(installed)
      } else {
        const pythonSiteDir = path.join(dir, 'pysite')
        await fsp.mkdir(pythonSiteDir, { recursive: true, mode: 0o700 })
        await fsp.writeFile(path.join(pythonSiteDir, 'sitecustomize.py'), PYTHON_SITECUSTOMIZE, {
          mode: 0o600,
        })
        result.pythonSiteDir = pythonSiteDir
      }
    } else if (kind === 'r' || kind === 'matlab') {
      const fileName = PACK_HELPER_FILES[kind]
      if (installed !== null) {
        result.plotWrapperPath = installed
      } else {
        const plotWrapperPath = path.join(dir, fileName)
        await fsp.writeFile(plotWrapperPath, PACK_HELPER_CONTENT[kind], { mode: 0o600 })
        result.plotWrapperPath = plotWrapperPath
      }
    }
    return result
  }

  async function startRun(body) {
    const request = requireObjectBody(body)
    let mode = request.mode
    if (mode === undefined || mode === null || mode === '') {
      mode = request.file !== undefined && request.file !== null ? 'file' : 'buffer'
    }
    if (mode !== 'buffer' && mode !== 'file') {
      throw new HttpError(400, 'bad-request', 'mode must be "buffer" or "file"')
    }
    let capturePlots = true
    if (request.capturePlots !== undefined && request.capturePlots !== null) {
      if (typeof request.capturePlots !== 'boolean') {
        throw new HttpError(400, 'bad-request', 'capturePlots must be a boolean')
      }
      capturePlots = request.capturePlots
    }

    const env = await getEnv()
    let language = null
    let code = null
    let file = null
    let scriptPath = null

    if (mode === 'file') {
      file = await resolveRunFile(request.file)
      if (request.language !== undefined && request.language !== null) {
        language = findLanguagePack(request.language) || null
        if (!language) {
          throw new HttpError(
            400,
            'unsupported-language',
            `unknown language: ${String(request.language)}`,
          )
        }
      } else {
        const inferredId = inferLanguageId(file, env)
        language = inferredId ? findLanguagePack(inferredId) : null
        if (!language) {
          throw new HttpError(
            400,
            'unsupported-language',
            `could not infer a language from the file extension: ${path.basename(file)}`,
          )
        }
      }
      scriptPath = file
    } else {
      language = findLanguagePack(request.language) || null
      if (!language) {
        throw new HttpError(400, 'unsupported-language', `unknown language: ${String(request.language)}`)
      }
      code = request.code
      if (typeof code !== 'string' || code.length === 0) {
        throw new HttpError(400, 'bad-request', 'code must be a non-empty string')
      }
      if (Buffer.byteLength(code, 'utf8') > LIMITS.codeMaxBytes) {
        throw new HttpError(413, 'code-too-large', `code exceeds ${LIMITS.codeMaxBytes} bytes`)
      }
    }

    const detected = env.languages.find((entry) => entry.id === language.id)
    if (!detected || !detected.available || !detected.command) {
      throw new HttpError(
        400,
        'language-unavailable',
        `no executable found for "${language.id}" (tried: ${language.candidates.join(', ')})`,
      )
    }

    const cwd = await resolveRunCwd(request.cwd)
    const timeoutMs = resolveTimeout(request.timeoutMs)
    const stdin = resolveStdin(request.stdin)

    const runId = crypto.randomUUID()
    const dir = path.join(TMP_ROOT, runId)
    const plotDir = path.join(dir, 'plots')
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      if (mode === 'buffer') {
        scriptPath = path.join(dir, language.scriptFile)
        await fsp.writeFile(scriptPath, code, { mode: 0o600 })
      }
    } catch (error) {
      removeRunDirectory({ dir })
      throw new HttpError(
        500,
        'internal',
        `could not prepare the run directory: ${error?.message ?? error}`,
      )
    }

    let pythonSiteDir = null
    let plotWrapperPath = null
    if (capturePlots) {
      try {
        const plotCapture = await preparePlotCapture(language, dir, plotDir)
        pythonSiteDir = plotCapture.pythonSiteDir
        plotWrapperPath = plotCapture.plotWrapperPath
      } catch (error) {
        removeRunDirectory({ dir })
        throw new HttpError(
          500,
          'internal',
          `could not prepare plot capture: ${error?.message ?? error}`,
        )
      }
    }

    const spawnEnvironment = { ...process.env, ...RUN_BASE_ENV }
    if (pythonSiteDir) {
      spawnEnvironment.PYTHONPATH = process.env.PYTHONPATH
        ? `${pythonSiteDir}${path.delimiter}${process.env.PYTHONPATH}`
        : pythonSiteDir
      spawnEnvironment.DSH_CODE_RUNNER_PLOTS_DIR = plotDir
    }
    if (plotWrapperPath) {
      spawnEnvironment.DSH_CODE_RUNNER_SCRIPT = scriptPath
      spawnEnvironment.DSH_CODE_RUNNER_PLOTS_DIR = plotDir
    }

    const spawnOptionsFor = (spawnArgv) => ({
      argv: spawnArgv,
      cwd,
      stdio: {
        stdin: stdin === null ? 'ignore' : { data: stdin.endsWith('\n') ? stdin : `${stdin}\n` },
        stdout: { maxBytes: LIMITS.outputMaxBytes, spill: { maxBytes: LIMITS.spillMaxBytes } },
        stderr: { maxBytes: LIMITS.outputMaxBytes, spill: { maxBytes: LIMITS.spillMaxBytes } },
      },
      env: spawnEnvironment,
      graceMs: 2_000,
    })
    const spawnHandle = (spawnArgv, label) => {
      let spawned
      try {
        spawned = ctx.subprocess.spawn(spawnOptionsFor(spawnArgv))
        if (!spawned || typeof spawned.done?.then !== 'function') {
          throw new Error('subprocess provider returned an invalid handle')
        }
      } catch (error) {
        throw new HttpError(500, 'spawn-failed', `could not start ${label}: ${error?.message ?? error}`)
      }
      return spawned
    }

    let argv
    if (language.id === 'matlab') {
      // CONTRACT-V3.md §1.5: `-batch` with run("…"); the wrapper sources the script.
      argv = [detected.command, '-batch', matlabRunArgument(plotWrapperPath ?? scriptPath)]
    } else {
      argv = [detected.command, ...language.args, plotWrapperPath ?? scriptPath]
    }
    let command = argv.join(' ')
    let handle = null
    let startedAt = 0
    if (language.compile) {
      // CONTRACT-V5 §1.4: compile first; a failed compile becomes this run's
      // output (its own process handle), a successful one runs the binary.
      const outputPath = path.join(dir, language.compile.outputFile)
      const compileArgv = [detected.command, ...language.compile.args(scriptPath, outputPath)]
      const compileHandle = spawnHandle(compileArgv, `${language.id} compiler`)
      const compileOutcome = await Promise.resolve(compileHandle.done).catch(() => null)
      if (!compileOutcome || compileOutcome.exitCode !== 0) {
        handle = compileHandle
        command = compileArgv.join(' ')
        startedAt = Date.now() - 1
      } else {
        argv = [outputPath]
        command = outputPath
      }
    }
    if (handle === null) {
      try {
        handle = spawnHandle(argv, language.id)
      } catch (error) {
        removeRunDirectory({ dir })
        throw error
      }
    }
    if (startedAt === 0) startedAt = Date.now()

    const run = {
      runId,
      language: language.id,
      mode,
      file: mode === 'file' ? file : null,
      command,
      scriptPath,
      cwd,
      startedAt,
      timeoutMs,
      capturePlots,
      plotDir,
      handle,
      dir,
      finishedAt: null,
      exitCode: null,
      signal: null,
      durationMs: null,
      timedOut: false,
      stopped: false,
      timer: null,
      donePromise: null,
    }

    // Timeout: flag, then terminate (grace handling is the provider's job).
    run.timer = setTimeout(() => {
      if (run.finishedAt !== null) return
      run.timedOut = true
      terminateRun(run)
    }, timeoutMs)
    run.timer.unref?.()

    run.donePromise = Promise.resolve(handle.done).then(
      (result) => finishRun(run, result?.exitCode ?? null, result?.signal ?? null),
      (error) => finishRun(run, null, null, error),
    )

    runs.set(runId, run)
    evictOldRuns()

    if (disposed) {
      // The plugin was unloaded while the run was being prepared.
      runs.delete(runId)
      terminateRun(run)
      if (run.timer) {
        clearTimeout(run.timer)
        run.timer = null
      }
      removeRunDirectory(run)
      throw new HttpError(500, 'internal', 'plugin is disposed')
    }

    return {
      ok: true,
      runId,
      language: language.id,
      mode,
      file: mode === 'file' ? file : null,
      command,
      scriptPath,
      cwd,
      startedAt,
      timeoutMs,
      capturePlots,
      plotDir,
    }
  }

  /* ── Route handlers ──────────────────────────────────────────────────────── */

  async function handleEnv({ url }) {
    const refresh = url.searchParams.get('refresh') !== null
    return getEnv({ refresh })
  }

  async function handleToken() {
    return { ok: true, token }
  }

  async function handleRun({ body }) {
    return startRun(requireObjectBody(body))
  }

  async function handleOutput({ url }) {
    const runId = url.searchParams.get('runId')
    if (typeof runId !== 'string' || runId === '') {
      throw new HttpError(400, 'bad-request', 'runId is required')
    }
    const run = runs.get(runId)
    if (!run) throw new HttpError(404, 'unknown-run', `unknown run: ${runId}`)

    const stdoutFrom = parseOffset(url.searchParams.get('stdoutFrom'))
    const stderrFrom = parseOffset(url.searchParams.get('stderrFrom'))
    const running = run.finishedAt === null
    return {
      ok: true,
      runId: run.runId,
      language: run.language,
      mode: run.mode,
      file: run.file,
      plotDir: run.plotDir,
      capturePlots: run.capturePlots,
      command: run.command,
      scriptPath: run.scriptPath,
      cwd: run.cwd,
      startedAt: run.startedAt,
      running,
      exitCode: running ? null : run.exitCode,
      signal: running ? null : run.signal,
      durationMs: running ? null : (run.durationMs ?? run.finishedAt - run.startedAt),
      timedOut: Boolean(run.timedOut),
      stopped: Boolean(run.stopped),
      stdout: readCollected(run.handle, 'stdout', stdoutFrom),
      stderr: readCollected(run.handle, 'stderr', stderrFrom),
    }
  }

  async function handleStop({ body }) {
    const request = requireObjectBody(body)
    const runId = request.runId
    if (typeof runId !== 'string' || runId === '') {
      throw new HttpError(400, 'bad-request', 'runId is required')
    }
    const run = runs.get(runId)
    if (!run) throw new HttpError(404, 'unknown-run', `unknown run: ${runId}`)

    const wasRunning = run.finishedAt === null
    if (wasRunning) {
      run.stopped = true
      terminateRun(run)
      // Bounded wait: the common case answers with running:false, but a process
      // that ignores SIGTERM must not hold the HTTP request open.
      await waitForRunExit(run, LIMITS.stopWaitMs)
    }
    return { ok: true, runId, stopped: wasRunning, running: run.finishedAt === null }
  }

  /* ── v2: files / file / blob / artifacts (CONTRACT-V2.md §1.6–§1.10) ─────── */

  async function handleFiles({ url }) {
    const dir = requireAbsoluteQueryPath(url, 'dir')
    let dirStat
    try {
      dirStat = await fsp.stat(dir)
    } catch {
      throw new HttpError(400, 'bad-path', `directory does not exist: ${dir}`)
    }
    if (!dirStat.isDirectory()) {
      throw new HttpError(400, 'bad-path', `not a directory: ${dir}`)
    }
    let dirents
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      throw new HttpError(400, 'bad-path', `could not read directory: ${dir}`)
    }

    const entries = []
    for (const dirent of dirents) {
      const entryPath = path.join(dir, dirent.name)
      // Classification only here (symlinks resolve via stat); size/mtime are read
      // after the cap below, so huge directories are not stat-ed past 2000 entries.
      let isDir = dirent.isDirectory()
      if (dirent.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(entryPath)).isDirectory()
        } catch {
          isDir = false // broken symlink
        }
      }
      entries.push({
        name: dirent.name,
        path: entryPath,
        isDir,
        size: null,
        mtimeMs: null,
        ext: pathExtension(dirent.name),
      })
    }
    entries.sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
      const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      if (byName !== 0) return byName
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    const truncated = entries.length > LIMITS.fileListMaxEntries
    const listed = truncated ? entries.slice(0, LIMITS.fileListMaxEntries) : entries
    for (const entry of listed) {
      try {
        const entryStat = await fsp.stat(entry.path) // follows symlinks
        entry.mtimeMs = entryStat.mtimeMs
        entry.isDir = entryStat.isDirectory()
        entry.size = entry.isDir ? null : entryStat.size
      } catch {
        /* broken symlink / unreadable target: keep name/isDir with null metadata */
      }
    }
    return {
      ok: true,
      dir,
      parent: path.dirname(dir),
      entries: listed,
      truncated,
    }
  }

  async function handleFileRead({ url }) {
    const filePath = requireAbsoluteQueryPath(url, 'path')
    let fileStat
    try {
      fileStat = await fsp.stat(filePath)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new HttpError(404, 'not-found', `file not found: ${filePath}`)
      }
      throw new HttpError(400, 'bad-path', `could not stat file: ${filePath}`)
    }
    if (!fileStat.isFile()) {
      throw new HttpError(400, 'bad-path', `not a regular file: ${filePath}`)
    }
    const ext = pathExtension(filePath)
    const base = {
      ok: true,
      path: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ext,
    }

    const readLimit = Math.min(fileStat.size, LIMITS.fileMaxBytes)
    let buffer = Buffer.alloc(0)
    let handle = null
    try {
      handle = await fsp.open(filePath, 'r')
      if (readLimit > 0) {
        buffer = Buffer.alloc(readLimit)
        const { bytesRead } = await handle.read(buffer, 0, readLimit, 0)
        buffer = buffer.subarray(0, bytesRead)
      }
    } catch {
      throw new HttpError(400, 'bad-path', `could not read file: ${filePath}`)
    } finally {
      try {
        await handle?.close()
      } catch {
        /* ignore */
      }
    }

    const probeLength = Math.min(buffer.length, LIMITS.binaryProbeBytes)
    if (buffer.subarray(0, probeLength).includes(0)) {
      return { ...base, text: '', truncated: false, binary: true }
    }
    return {
      ...base,
      text: buffer.toString('utf8'),
      truncated: fileStat.size > LIMITS.fileMaxBytes,
      binary: false,
    }
  }

  async function handleFileSave({ body }) {
    const request = requireObjectBody(body)
    const filePath = request.path
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new HttpError(400, 'bad-path', 'path must be an absolute path')
    }

    let existing = null
    try {
      existing = await fsp.stat(filePath)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw new HttpError(400, 'bad-path', `could not stat path: ${filePath}`)
      }
    }
    if (existing && !existing.isFile()) {
      throw new HttpError(400, 'bad-path', `path is not a regular file: ${filePath}`)
    }

    const parent = path.dirname(filePath)
    let parentStat
    try {
      parentStat = await fsp.stat(parent)
    } catch {
      throw new HttpError(400, 'bad-path', `parent directory does not exist: ${parent}`)
    }
    if (!parentStat.isDirectory()) {
      throw new HttpError(400, 'bad-path', `parent is not a directory: ${parent}`)
    }

    const text = request.text
    if (typeof text !== 'string') {
      throw new HttpError(400, 'bad-request', 'text must be a string')
    }
    if (Buffer.byteLength(text, 'utf8') > LIMITS.fileMaxBytes) {
      throw new HttpError(413, 'too-large', `text exceeds ${LIMITS.fileMaxBytes} bytes`)
    }

    if (
      existing &&
      typeof request.baseMtimeMs === 'number' &&
      Number.isFinite(request.baseMtimeMs) &&
      existing.mtimeMs !== request.baseMtimeMs
    ) {
      throw new HttpError(409, 'conflict', 'file changed on disk since it was opened', {
        currentMtimeMs: existing.mtimeMs,
        size: existing.size,
      })
    }

    try {
      if (existing) {
        // writeFile keeps the existing inode's mode; only a new file gets 0o644.
        await fsp.writeFile(filePath, text)
      } else {
        await fsp.writeFile(filePath, text, { mode: 0o644 })
      }
    } catch (error) {
      throw new HttpError(500, 'internal', `could not write file: ${error?.message ?? error}`)
    }
    const written = await fsp.stat(filePath)
    return {
      ok: true,
      path: filePath,
      size: written.size,
      mtimeMs: written.mtimeMs,
      ext: pathExtension(filePath),
    }
  }

  async function handleBlob({ url }) {
    const filePath = requireAbsoluteQueryPath(url, 'path')
    const ext = pathExtension(filePath)
    const contentType = BLOB_CONTENT_TYPES[ext]
    if (!contentType) {
      throw new HttpError(415, 'unsupported-file', `unsupported preview type: .${ext || '(none)'}`)
    }
    let fileStat
    try {
      fileStat = await fsp.stat(filePath)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new HttpError(404, 'not-found', `file not found: ${filePath}`)
      }
      throw new HttpError(400, 'bad-path', `could not stat file: ${filePath}`)
    }
    if (!fileStat.isFile()) {
      throw new HttpError(400, 'bad-path', `not a regular file: ${filePath}`)
    }
    if (fileStat.size > LIMITS.blobMaxBytes) {
      throw new HttpError(413, 'too-large', `file exceeds ${LIMITS.blobMaxBytes} bytes`)
    }
    let body
    try {
      body = await fsp.readFile(filePath)
    } catch {
      throw new HttpError(400, 'bad-path', `could not read file: ${filePath}`)
    }
    return { [RAW_RESPONSE]: true, body, contentType }
  }

  async function listRunPlots(plotDir) {
    const items = []
    let dirents
    try {
      dirents = await fsp.readdir(plotDir, { withFileTypes: true })
    } catch {
      return items
    }
    for (const dirent of dirents) {
      const ext = pathExtension(dirent.name)
      if (!IMAGE_EXTENSIONS.has(ext)) continue
      const entryPath = path.join(plotDir, dirent.name)
      try {
        const entryStat = await fsp.stat(entryPath)
        if (!entryStat.isFile()) continue
        items.push({
          path: entryPath,
          name: dirent.name,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs,
          ext,
        })
      } catch {
        /* vanished / unreadable → skip */
      }
    }
    items.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    return items
  }

  async function listCwdImages(run) {
    const items = []
    let dirents
    try {
      dirents = await fsp.readdir(run.cwd, { withFileTypes: true })
    } catch {
      return items
    }
    const cutoff = run.startedAt - LIMITS.artifactCwdWindowMs
    for (const dirent of dirents) {
      const ext = pathExtension(dirent.name)
      if (!IMAGE_EXTENSIONS.has(ext)) continue
      const entryPath = path.join(run.cwd, dirent.name)
      if (isPathInside(run.dir, entryPath)) continue
      try {
        const entryStat = await fsp.stat(entryPath)
        if (!entryStat.isFile()) continue
        if (entryStat.size < 1 || entryStat.size > LIMITS.blobMaxBytes) continue
        if (entryStat.mtimeMs < cutoff) continue
        items.push({
          path: entryPath,
          name: dirent.name,
          size: entryStat.size,
          mtimeMs: entryStat.mtimeMs,
          ext,
        })
      } catch {
        /* vanished / unreadable → skip */
      }
    }
    items.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return items
  }

  async function handleArtifacts({ url }) {
    const runId = url.searchParams.get('runId')
    if (typeof runId !== 'string' || runId === '') {
      throw new HttpError(400, 'bad-request', 'runId is required')
    }
    const run = runs.get(runId)
    if (!run) throw new HttpError(404, 'unknown-run', `unknown run: ${runId}`)

    const seen = new Set()
    const plots = []
    for (const item of await listRunPlots(run.plotDir)) {
      if (seen.has(item.path)) continue
      seen.add(item.path)
      plots.push({ ...item, source: 'run' })
    }
    for (const item of await listCwdImages(run)) {
      if (seen.has(item.path)) continue
      seen.add(item.path)
      plots.push({ ...item, source: 'cwd' })
    }
    const truncated = plots.length > LIMITS.artifactMax
    return {
      ok: true,
      runId,
      running: run.finishedAt === null,
      plotDir: run.plotDir,
      plots: truncated ? plots.slice(0, LIMITS.artifactMax) : plots,
      truncated,
    }
  }

  /* ── Browser diagnostics (CONTRACT-V2.md §1.11) ──────────────────────────── */

  /** Recursively keep a diagnostic value JSON-safe and small (defensive). */
  function sanitizeDiagValue(value, depth) {
    const level = typeof depth === 'number' ? depth : 0
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value
    if (level >= 3) return undefined
    if (Array.isArray(value)) {
      const output = []
      for (const item of value.slice(0, 20)) {
        const next = sanitizeDiagValue(item, level + 1)
        if (next !== undefined) output.push(next)
      }
      return output
    }
    if (typeof value === 'object') {
      const output = {}
      let count = 0
      for (const key of Object.keys(value)) {
        if (count >= 24) break
        if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) continue
        const next = sanitizeDiagValue(value[key], level + 1)
        if (next !== undefined) {
          output[key] = next
          count += 1
        }
      }
      return output
    }
    return undefined
  }

  /** Append one or more browser events to the in-memory ring buffer. */
  function recordDiag(events) {
    const list = Array.isArray(events) ? events : [events]
    for (const raw of list) {
      const clean = sanitizeDiagValue(raw)
      const event = clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : { value: clean }
      diagEvents.push({ seq: (diagSeq += 1), receivedAt: Date.now(), event })
    }
    while (diagEvents.length > LIMITS.diagMaxEvents) diagEvents.shift()
  }

  async function handleDiagPost({ body }) {
    const request = requireObjectBody(body)
    const events = Array.isArray(request.events)
      ? request.events
      : request.event !== undefined
        ? [request.event]
        : []
    if (events.length === 0) {
      throw new HttpError(400, 'bad-request', 'event or events is required')
    }
    const accepted = events.slice(0, 20)
    recordDiag(accepted)
    return { ok: true, accepted: accepted.length }
  }

  async function handleDiagGet() {
    return {
      ok: true,
      plugin: 'dsh-code-runner',
      route: ROUTE_PREFIX,
      events: diagEvents,
      dropped: false,
    }
  }

  /* ── v3: AI explanation (CONTRACT-V3.md §1.2) ────────────────────────────── */

  /** Optional Host service lookup; absence is normal (services are optional). */
  function getOptionalService(serviceName) {
    try {
      if (typeof ctx.get !== 'function') return undefined
      const service = ctx.get(serviceName)
      return service ?? undefined
    } catch {
      return undefined
    }
  }

  /** {provider, model} from the Host default-model selection, or null. */
  function readExplainRoute() {
    const service = getOptionalService('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return null
    let selection = null
    try {
      selection = service.currentSelection()
    } catch {
      return null
    }
    if (!selection || typeof selection !== 'object') return null
    const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection.model === 'string' ? selection.model.trim() : ''
    if (provider === '' || model === '') return null
    return { provider, model }
  }

  /**
   * Stream one explanation. Every failure maps onto the v3 error codes and the
   * HTTP request never waits longer than explainTimeoutMs.
   */
  async function collectExplanation(llm, route, languageId, fileName, code) {
    const controller = new AbortController()
    let timedOut = false
    let timer = null
    const timeoutError = () =>
      new HttpError(
        504,
        'llm-timeout',
        `the model did not answer within ${Math.round(LIMITS.explainTimeoutMs / 1000)}s`,
      )
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
        reject(timeoutError())
      }, LIMITS.explainTimeoutMs)
      timer.unref?.()
    })
    const collectPromise = (async () => {
      let text = ''
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: EXPLAIN_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: buildExplainUserPrompt(languageId, fileName, code) }],
          },
        ],
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          if (text.length >= LIMITS.explainOutputMaxChars) {
            text = text.slice(0, LIMITS.explainOutputMaxChars)
            try {
              controller.abort()
            } catch {
              /* ignore */
            }
            break
          }
          continue
        }
        if (chunk.type === 'finish') {
          const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : null
          if (reason && reason.kind === 'error') {
            const failure = reason.failure && typeof reason.failure === 'object' ? reason.failure : null
            const message =
              failure && typeof failure.message === 'string' && failure.message !== ''
                ? failure.message
                : 'the model request failed'
            const failureCode = failure && typeof failure.code === 'string' ? failure.code : 'LLM_FAILED'
            throw new Error(`${message} (${failureCode})`)
          }
          if (reason && reason.kind === 'aborted' && !timedOut) {
            throw new Error('the model request was aborted')
          }
        }
      }
      return text
    })()
    // If the timeout wins the race, the losing collector may still reject later.
    collectPromise.catch(() => {})
    try {
      return await Promise.race([collectPromise, timeoutPromise])
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (timedOut) throw timeoutError()
      throw new HttpError(502, 'llm-failed', `the model request failed: ${error?.message ?? error}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function handleExplain({ body }) {
    const request = requireObjectBody(body)
    const language = findLanguagePack(String(request.language))
    if (!language) {
      throw new HttpError(400, 'unsupported-language', `unknown language: ${String(request.language)}`)
    }
    const code = request.code
    if (typeof code !== 'string' || code.length === 0) {
      throw new HttpError(400, 'bad-request', 'code must be a non-empty string')
    }
    const fileName =
      typeof request.fileName === 'string' && request.fileName.trim() !== ''
        ? request.fileName.trim()
        : null
    const truncatedInput = code.length > LIMITS.explainMaxChars
    const promptCode = truncatedInput ? code.slice(0, LIMITS.explainMaxChars) : code

    const route = readExplainRoute()
    const llm = getOptionalService('llm')
    const missing = []
    if (!route) missing.push('agentDefaultModel.currentSelection()')
    if (!llm || typeof llm.stream !== 'function') missing.push('llm.stream()')
    if (missing.length > 0) {
      throw new HttpError(
        503,
        'llm-unavailable',
        `the Host LLM service is unavailable (missing: ${missing.join(', ')})`,
      )
    }

    const rawText = await collectExplanation(llm, route, language.id, fileName, promptCode)
    const parsed = parseExplainText(rawText)
    return {
      ok: true,
      summary: parsed.summary,
      annotatedCode: parsed.annotatedCode,
      provider: route.provider,
      model: route.model,
      truncatedInput,
    }
  }

  /* ── v3: report export / plot saving (CONTRACT-V3.md §1.3, §1.4) ─────────── */

  /** Validate one export plot entry; returns a normalized descriptor or throws. */
  function validateReportPlotEntry(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, 'bad-request', 'plots entries must be objects')
    }
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
      throw new HttpError(400, 'bad-path', `plot path must be absolute: ${String(item.path)}`)
    }
    const ext = pathExtension(item.path)
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new HttpError(415, 'unsupported-file', `unsupported plot type: .${ext || '(none)'}`)
    }
    return { path: item.path, name: plotDisplayName(item.name, item.path), ext }
  }

  /** Output body for the report fenced block: stdout then stderr (§1.3). */
  function buildReportOutputText(stdoutResult, stderrResult) {
    const sections = [stdoutResult.text + (stdoutResult.truncated ? REPORT_TRUNCATED_MARKER : '')]
    if (stderrResult.text !== '' || stderrResult.truncated) {
      sections.push('--- stderr ---')
      sections.push(stderrResult.text + (stderrResult.truncated ? REPORT_TRUNCATED_MARKER : ''))
    }
    return sections.join('\n')
  }

  /** Self-contained HTML report (images inlined while within the 32 MiB budget). */
  async function buildReportHtml(context) {
    let remainingBudget = LIMITS.reportInlineImageBudgetBytes
    const plotMarkup = []
    for (const plot of context.plots) {
      const contentType = BLOB_CONTENT_TYPES[plot.ext] ?? 'application/octet-stream'
      if (plot.size <= remainingBudget) {
        try {
          const bytes = await fsp.readFile(plot.path)
          remainingBudget -= bytes.length
          plotMarkup.push(
            `<figure><img src="data:${contentType};base64,${bytes.toString('base64')}" alt="${htmlEscape(plot.name)}"><figcaption>${htmlEscape(plot.name)}</figcaption></figure>`,
          )
          continue
        } catch {
          /* fall through to a plain link */
        }
      }
      plotMarkup.push(
        `<p class="plot-link">📈 <a href="plots/${encodeURIComponent(plot.name)}">${htmlEscape(plot.name)}</a>（超出内联预算，可打开文件查看）</p>`,
      )
    }
    const metaItems = [
      ['脚本', context.file ?? '缓冲区（buffer）'],
      ['工作目录', context.cwd ?? '—'],
      ['命令', context.command === '' ? '—' : context.command],
      ['退出码', context.exitCode === null ? '—' : String(context.exitCode)],
      ['耗时', context.durationMs === null ? '—' : `${context.durationMs} ms`],
      ['生成时间', context.localTime],
    ]
      .map(([label, value]) => `<li><strong>${htmlEscape(label)}：</strong>${htmlEscape(value)}</li>`)
      .join('')
    const include = context.include || { code: true, output: true, plots: true, summary: true }
    const summaryMarkup = include.summary && context.summary
      ? `<section><h2>AI 解读：</h2><p class="summary">${htmlEscape(context.summary)}</p></section>`
      : ''
    const plotsMarkup =
      include.plots && plotMarkup.length > 0
        ? `<section><h2>统计图：</h2><div class="plots">${plotMarkup.join('')}</div></section>`
        : ''
    const codeMarkup = include.code
      ? `<section><h2>源代码：</h2><pre class="code">${htmlEscape(context.codeText)}</pre></section>`
      : ''
    const outputMarkup = include.output
      ? `<section><h2>输出结果：</h2><pre class="output">${htmlEscape(context.outputText)}</pre></section>`
      : ''
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(context.title || '代码实验报告')}</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d0d7de;--surface:#f6f8fa;}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--surface:#161b22;}}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
main{max-width:980px;margin:0 auto;padding:32px 20px 64px;}
h1{font-size:22px;margin:0 0 12px;}
h2{font-size:16px;margin:28px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border);}
.meta{list-style:none;margin:0;padding:0;color:var(--muted);font-size:13px;}
.meta li{margin:2px 0;}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow:auto;max-height:560px;white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 "SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;}
.summary{white-space:pre-wrap;margin:0;}
.plots{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}
figure{margin:0;border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--surface);}
figure img{display:block;width:100%;height:auto;border-radius:4px;}
figcaption{color:var(--muted);font-size:12px;margin-top:8px;word-break:break-all;}
.plot-link{color:var(--muted);}
footer{margin-top:40px;color:var(--muted);font-size:12px;}
</style>
</head>
<body>
<main>
<h1>${htmlEscape(context.title || '代码实验报告')}</h1>
<ul class="meta">${metaItems}</ul>
${codeMarkup}
${outputMarkup}
${plotsMarkup}
${summaryMarkup}
<footer>由 dsh-code-runner 导出 · ${htmlEscape(context.localTime)}</footer>
</main>
</body>
</html>
`
  }

  /* ── Word (.docx) report writer — no dependencies, pure zlib + OOXML ───── */

  const DOCX_MAX_SECTION_LINES = 900
  const DOCX_MAX_IMAGE_WIDTH_EMU = 5760000 // 16 cm
  const DOCX_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

  const CRC32_TABLE = (() => {
    const table = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      table[index] = value
    }
    return table
  })()

  function crc32(buffer) {
    let crc = 0xffffffff
    for (let index = 0; index < buffer.length; index += 1) {
      crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  /** Minimal ZIP archive (deflate entries, UTF-8 names) — enough for OOXML. */
  function zipArchive(entries) {
    const localParts = []
    const centralParts = []
    let offset = 0
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8')
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
      const method = entry.store === true ? 0 : 8
      const compressed = method === 0 ? data : zlib.deflateRawSync(data, { level: 9 })
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      localParts.push(local, nameBuf, compressed)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0x0800, 8)
      central.writeUInt16LE(method, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(compressed.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(nameBuf.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(offset, 42)
      centralParts.push(central, nameBuf)
      offset += local.length + nameBuf.length + compressed.length
    }
    const centralBuf = Buffer.concat(centralParts)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...localParts, centralBuf, eocd])
  }

  /** XML text escape for OOXML text runs (control chars dropped). */
  function docxEscape(value) {
    const stripped = String(value ?? '')
      .split('')
      .filter((char) => {
        const code = char.codePointAt(0)
        return !(code < 0x20 && code !== 0x09)
      })
      .join('')
    return stripped
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  }

  function docxParagraph(styleId, text, extraRunProps = '') {
    const props = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''
    const runs = String(text) === '' ? '' : `<w:r>${extraRunProps}<w:t xml:space="preserve">${docxEscape(text)}</w:t></w:r>`
    return `<w:p>${props}${runs}</w:p>`
  }

  function docxCodeParagraphs(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n')
    const capped = lines.slice(0, DOCX_MAX_SECTION_LINES)
    const paragraphs = capped.map((line) => docxParagraph('Code', line))
    if (lines.length > capped.length) paragraphs.push(docxParagraph('Code', REPORT_TRUNCATED_MARKER))
    if (paragraphs.length === 0) paragraphs.push(docxParagraph('Code', ''))
    return paragraphs
  }

  function pngPixelSize(buffer) {
    try {
      if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
      }
    } catch {
      /* ignore */
    }
    return { width: 800, height: 600 }
  }

  function docxImageParagraph(relId, imageId, name, buffer) {
    const pixels = pngPixelSize(buffer)
    const naturalCx = Math.max(1, Math.round(pixels.width * 9525))
    const naturalCy = Math.max(1, Math.round(pixels.height * 9525))
    const scale = naturalCx > DOCX_MAX_IMAGE_WIDTH_EMU ? DOCX_MAX_IMAGE_WIDTH_EMU / naturalCx : 1
    const cx = Math.max(1, Math.round(naturalCx * scale))
    const cy = Math.max(1, Math.round(naturalCy * scale))
    return (
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr><w:r><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${imageId}" name="Picture ${imageId}"/><a:graphic>` +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      `<pic:nvPicPr><pic:cNvPr id="${imageId}" name="${docxEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>'
    )
  }

  /**
   * Build a Word document: 标题, then exactly the 源代码：/输出结果：/统计图：
   * sections the caller included (plus optional AI 解读), with PNG figures.
   */
  async function buildDocxReport(context) {
    const media = []
    const body = []
    body.push(docxParagraph('Title', context.title))
    body.push(docxParagraph('Normal', context.metaLine))
    const include = context.include
    if (include.code) {
      body.push(docxParagraph('Heading1', '源代码：'))
      body.push(...docxCodeParagraphs(context.codeText))
    }
    if (include.output) {
      body.push(docxParagraph('Heading1', '输出结果：'))
      body.push(...docxCodeParagraphs(context.outputText))
    }
    if (include.plots && context.plots.length > 0) {
      body.push(docxParagraph('Heading1', '统计图：'))
      let imageIndex = 0
      for (const plot of context.plots) {
        let bytes
        try {
          bytes = await fsp.readFile(plot.path)
        } catch {
          continue
        }
        imageIndex += 1
        const relId = `rIdImg${imageIndex}`
        const mediaName = `image${imageIndex}${path.extname(plot.name) || '.png'}`
        media.push({ relId, name: mediaName, data: bytes })
        body.push(docxImageParagraph(relId, imageIndex, plot.name, bytes))
        body.push(docxParagraph('Caption', `图 ${imageIndex}：${plot.name}`))
      }
    }
    if (include.summary && context.summary) {
      body.push(docxParagraph('Heading1', 'AI 解读：'))
      for (const line of String(context.summary).replace(/\r\n/g, '\n').split('\n')) {
        body.push(docxParagraph('Normal', line))
      }
    }
    const sectPr =
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>'
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<w:document ${DOCX_NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`
    const stylesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:eastAsia="PingFang SC"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:eastAsia="PingFang SC"/>' +
      '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr>' +
      '<w:rPr><w:i/><w:color w:val="666666"/><w:sz w:val="18"/></w:rPr></w:style>' +
      '</w:styles>'
    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>'
    const rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
    const relItems = [
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      ...media.map(
        (image) =>
          `<Relationship Id="${image.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.name}"/>`,
      ),
    ]
    const documentRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relItems.join('')}</Relationships>`
    const entries = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml },
      { name: 'word/_rels/document.xml.rels', data: documentRels },
      ...media.map((image) => ({ name: `word/media/${image.name}`, data: image.data, store: true })),
    ]
    return zipArchive(entries)
  }

  /** File-name stem rules (CONTRACT-V4 §1.3): keep CJK, drop path separators + control chars. */
  const REPORT_NAME_FORBIDDEN = '\\/:*?"<>|'
  function sanitizeReportStem(value) {
    const filtered = String(value ?? '')
      .split('')
      .filter((char) => {
        const code = char.codePointAt(0)
        if (code < 0x20) return false
        return REPORT_NAME_FORBIDDEN.indexOf(char) < 0
      })
      .join('')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '')
      .slice(0, 80)
    return filtered === '' ? '未命名' : filtered
  }

  async function handleExport({ body }) {
    const request = requireObjectBody(body)
    const language = findLanguagePack(String(request.language))
    if (!language) {
      throw new HttpError(400, 'unsupported-language', `unknown language: ${String(request.language)}`)
    }

    const file =
      request.file === undefined || request.file === null || request.file === '' ? null : request.file
    const cwd = request.cwd === undefined || request.cwd === null || request.cwd === '' ? null : request.cwd
    if (file !== null && (typeof file !== 'string' || !path.isAbsolute(file))) {
      throw new HttpError(400, 'bad-path', 'file must be an absolute path')
    }
    if (cwd !== null && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
      throw new HttpError(400, 'bad-path', 'cwd must be an absolute path')
    }
    const base = file !== null ? path.dirname(file) : cwd
    if (base === null) throw new HttpError(400, 'bad-path', 'cwd or file is required')
    let baseStat
    try {
      baseStat = await fsp.stat(base)
    } catch {
      throw new HttpError(400, 'bad-cwd', `base directory does not exist: ${base}`)
    }
    if (!baseStat.isDirectory()) {
      throw new HttpError(400, 'bad-cwd', `base path is not a directory: ${base}`)
    }

    const requestedPlots = request.plots === undefined || request.plots === null ? [] : request.plots
    if (!Array.isArray(requestedPlots)) throw new HttpError(400, 'bad-request', 'plots must be an array')
    const plotDescriptors = requestedPlots.map(validateReportPlotEntry)

    const codeSource = typeof request.code === 'string' ? request.code : ''
    const stdoutSource = typeof request.stdout === 'string' ? request.stdout : ''
    const stderrSource = typeof request.stderr === 'string' ? request.stderr : ''
    const summary =
      typeof request.summary === 'string' && request.summary.trim() !== '' ? request.summary : null
    const command = typeof request.command === 'string' ? request.command : ''
    const mode = typeof request.mode === 'string' ? request.mode : null
    const exitCode = Number.isInteger(request.exitCode) ? request.exitCode : null
    const durationMs = Number.isFinite(request.durationMs)
      ? Math.max(0, Math.trunc(request.durationMs))
      : null
    const startedAt = Number.isFinite(request.startedAt) ? Math.trunc(request.startedAt) : null

    // CONTRACT-V4 §1.3: format / include / file-name options.
    const formatInput = request.format === undefined || request.format === null ? 'all' : request.format
    const FORMAT_VALUES = ['md', 'html', 'docx', 'all']
    if (typeof formatInput !== 'string' || FORMAT_VALUES.indexOf(formatInput) < 0) {
      throw new HttpError(400, 'bad-request', 'format must be one of md, html, docx, all')
    }
    const includeInput = request.include !== null && typeof request.include === 'object' ? request.include : {}
    const include = {
      code: includeInput.code !== false,
      output: includeInput.output !== false,
      plots: includeInput.plots !== false,
      summary: includeInput.summary !== false,
    }
    const requestedStem =
      typeof request.name === 'string' && request.name.trim() !== ''
        ? request.name
        : file !== null
          ? path.basename(file, path.extname(file))
          : '未命名'
    const baseName = `${sanitizeReportStem(requestedStem)}实验报告`

    const generatedAt = Date.now()
    const generatedDate = new Date(generatedAt)
    const timestamp = formatTimestamp(generatedDate)
    const localTime = formatLocalTime(generatedDate)

    // 1. A brand-new folder under <base>/dsh-code-runner-reports (collision → -2, -3 …).
    const reportsRoot = path.join(base, REPORT_DIR_NAME)
    try {
      await fsp.mkdir(reportsRoot, { recursive: true })
    } catch (error) {
      throw new HttpError(500, 'internal', `could not create the reports directory: ${error?.message ?? error}`)
    }
    let folder = null
    for (let suffix = 1; suffix <= 100 && folder === null; suffix += 1) {
      const name = suffix === 1 ? `${timestamp}-${language.id}` : `${timestamp}-${language.id}-${suffix}`
      const candidate = path.join(reportsRoot, name)
      try {
        await fsp.mkdir(candidate)
        folder = candidate
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
          throw new HttpError(500, 'internal', `could not create the report folder: ${error?.message ?? error}`)
        }
      }
    }
    if (folder === null) throw new HttpError(500, 'internal', 'could not create a unique report folder')

    // 2. Copy plots (≤40, dedupe names, skip unreadable / >16 MiB) — §1.3.
    const copiedPlots = []
    if (plotDescriptors.length > 0 && include.plots) {
      const plotsDir = path.join(folder, 'plots')
      try {
        await fsp.mkdir(plotsDir, { recursive: true })
      } catch (error) {
        throw new HttpError(500, 'internal', `could not create the plots directory: ${error?.message ?? error}`)
      }
      for (const descriptor of plotDescriptors) {
        if (copiedPlots.length >= LIMITS.artifactMax) break
        let sourceStat
        try {
          sourceStat = await fsp.stat(descriptor.path)
        } catch {
          continue // a missing single plot is skipped, not fatal
        }
        if (!sourceStat.isFile() || sourceStat.size > LIMITS.blobMaxBytes) continue
        let targetPath = null
        for (let attempt = 0; attempt <= 100 && targetPath === null; attempt += 1) {
          const targetName = attempt === 0 ? descriptor.name : appendNameSuffix(descriptor.name, attempt)
          const candidate = path.join(plotsDir, targetName)
          try {
            await fsp.copyFile(descriptor.path, candidate, FS_CONSTANTS.COPYFILE_EXCL)
            targetPath = candidate
          } catch (error) {
            if (!error || error.code !== 'EEXIST') break
          }
        }
        if (targetPath === null) continue
        const targetName = path.basename(targetPath)
        copiedPlots.push({
          name: targetName,
          relative: `plots/${targetName}`,
          path: targetPath,
          ext: descriptor.ext,
          size: sourceStat.size,
        })
      }
    }
    const plotFiles = copiedPlots.map((plot) => plot.relative)

    // 3. Sections (CONTRACT-V4 §1.4): 源代码：/输出结果：/统计图： (+ optional AI 解读).
    const codeTruncated = truncateUtf8(codeSource, LIMITS.codeMaxBytes)
    const stdoutTruncated = truncateUtf8(stdoutSource, LIMITS.outputMaxBytes)
    const stderrTruncated = truncateUtf8(stderrSource, LIMITS.outputMaxBytes)
    const codeText = codeTruncated.text + (codeTruncated.truncated ? REPORT_TRUNCATED_MARKER : '')
    const outputText = buildReportOutputText(stdoutTruncated, stderrTruncated)
    const title = baseName
    const metaLine = `${language.label} · ${file ?? '缓冲区（buffer）'} · 退出码 ${exitCode === null ? '—' : exitCode} · ${localTime}`

    const markdown = []
    markdown.push(`# ${title}`)
    markdown.push('')
    markdown.push(`- 语言：${language.label}`)
    markdown.push(`- 脚本：${file ?? '缓冲区（buffer）'}`)
    if (cwd !== null) markdown.push(`- 工作目录：${cwd}`)
    markdown.push(`- 命令：${command === '' ? '—' : command}`)
    markdown.push(`- 退出码：${exitCode === null ? '—' : exitCode}`)
    markdown.push(`- 耗时：${durationMs === null ? '—' : `${durationMs} ms`}`)
    markdown.push(`- 生成时间：${localTime}`)
    markdown.push('')
    if (include.code) {
      markdown.push('## 源代码：')
      markdown.push('')
      markdown.push(fencedBlock(codeText, languageFence(language.id)))
      markdown.push('')
    }
    if (include.output) {
      markdown.push('## 输出结果：')
      markdown.push('')
      markdown.push(fencedBlock(outputText, 'text'))
      markdown.push('')
    }
    if (include.plots && copiedPlots.length > 0) {
      markdown.push('## 统计图：')
      markdown.push('')
      for (const plot of copiedPlots) markdown.push(`![${plot.name}](${plot.relative})`)
      markdown.push('')
    }
    if (include.summary && summary !== null) {
      markdown.push('## AI 解读：')
      markdown.push('')
      markdown.push(summary)
      markdown.push('')
    }

    const wanted = {
      md: formatInput === 'md' || formatInput === 'all',
      html: formatInput === 'html' || formatInput === 'all',
      docx: formatInput === 'docx' || formatInput === 'all',
    }
    const mdPath = wanted.md ? path.join(folder, `${baseName}.md`) : null
    const htmlPath = wanted.html ? path.join(folder, `${baseName}.html`) : null
    const docxPath = wanted.docx ? path.join(folder, `${baseName}.docx`) : null
    const runJsonPath = path.join(folder, 'run.json')
    const files = []
    try {
      if (mdPath !== null) {
        await fsp.writeFile(mdPath, `${markdown.join('\n')}\n`, 'utf8')
        files.push(path.basename(mdPath))
      }
      if (htmlPath !== null) {
        const html = await buildReportHtml({
          title,
          languageLabel: language.label,
          localTime,
          file,
          cwd,
          command,
          exitCode,
          durationMs,
          codeText,
          outputText,
          summary,
          include,
          plots: copiedPlots,
        })
        await fsp.writeFile(htmlPath, html, 'utf8')
        files.push(path.basename(htmlPath))
      }
      if (docxPath !== null) {
        const docx = await buildDocxReport({
          title,
          metaLine,
          include,
          codeText,
          outputText,
          summary,
          plots: copiedPlots,
        })
        await fsp.writeFile(docxPath, docx)
        files.push(path.basename(docxPath))
      }
      // 4. run.json: sanitized metadata only (no code/output bodies).
      const runMeta = {
        plugin: 'dsh-code-runner',
        reportVersion: 4,
        baseName,
        format: formatInput,
        include,
        language: language.id,
        mode,
        file,
        cwd,
        command,
        exitCode,
        durationMs,
        startedAt,
        generatedAt,
        plotFiles,
        hasSummary: summary !== null,
      }
      await fsp.writeFile(runJsonPath, `${JSON.stringify(runMeta, null, 2)}\n`, 'utf8')
      files.push('run.json', ...plotFiles)
    } catch (error) {
      throw new HttpError(500, 'internal', `could not write the report: ${error?.message ?? error}`)
    }

    return {
      ok: true,
      folder,
      baseName,
      format: formatInput,
      include,
      reportPath: mdPath,
      htmlPath,
      docxPath,
      plotFiles,
      files,
    }
  }

  async function handleSavePlots({ body }) {
    const request = requireObjectBody(body)
    const targetDir = request.targetDir
    if (typeof targetDir !== 'string' || !path.isAbsolute(targetDir)) {
      throw new HttpError(400, 'bad-path', 'targetDir must be an absolute path')
    }
    const plots = request.plots === undefined || request.plots === null ? [] : request.plots
    if (!Array.isArray(plots)) throw new HttpError(400, 'bad-request', 'plots must be an array')
    if (plots.length === 0) throw new HttpError(400, 'bad-request', 'plots must not be empty')
    if (plots.length > LIMITS.savePlotsMax) {
      throw new HttpError(400, 'bad-request', `at most ${LIMITS.savePlotsMax} plots can be saved at once`)
    }

    let targetStat = null
    try {
      targetStat = await fsp.stat(targetDir)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw new HttpError(400, 'bad-path', `could not stat target directory: ${targetDir}`)
      }
    }
    if (targetStat !== null && !targetStat.isDirectory()) {
      throw new HttpError(400, 'bad-path', `targetDir is not a directory: ${targetDir}`)
    }
    if (targetStat === null) {
      try {
        await fsp.mkdir(targetDir, { recursive: true })
      } catch (error) {
        throw new HttpError(400, 'bad-path', `could not create target directory: ${error?.message ?? error}`)
      }
    }

    // Validate every plot before writing anything (all-or-nothing).
    const sources = []
    for (const item of plots) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new HttpError(400, 'bad-request', 'plots entries must be objects')
      }
      if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
        throw new HttpError(400, 'bad-path', `plot path must be absolute: ${String(item.path)}`)
      }
      const ext = pathExtension(item.path)
      if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new HttpError(415, 'unsupported-file', `unsupported plot type: .${ext || '(none)'}`)
      }
      let sourceStat
      try {
        sourceStat = await fsp.stat(item.path)
      } catch {
        throw new HttpError(404, 'not-found', `plot not found: ${item.path}`)
      }
      if (!sourceStat.isFile()) {
        throw new HttpError(404, 'not-found', `plot is not a regular file: ${item.path}`)
      }
      if (sourceStat.size > LIMITS.blobMaxBytes) {
        throw new HttpError(413, 'too-large', `plot exceeds ${LIMITS.blobMaxBytes} bytes: ${item.path}`)
      }
      sources.push({ source: item.path, name: plotDisplayName(item.name, item.path) })
    }

    const saved = []
    for (const source of sources) {
      let targetPath = null
      for (let attempt = 0; attempt <= 1000 && targetPath === null; attempt += 1) {
        const name = attempt === 0 ? source.name : appendNameSuffix(source.name, attempt)
        const candidate = path.join(targetDir, name)
        try {
          await fsp.copyFile(source.source, candidate, FS_CONSTANTS.COPYFILE_EXCL)
          targetPath = candidate
        } catch (error) {
          if (!error || error.code !== 'EEXIST') {
            throw new HttpError(500, 'internal', `could not save plot: ${error?.message ?? error}`)
          }
        }
      }
      if (targetPath === null) throw new HttpError(500, 'internal', 'could not find a free file name')
      saved.push({ source: source.source, path: targetPath })
    }
    return { ok: true, targetDir, saved }
  }

  /* ── v5: language packs (opt-in, detection-gated) — CONTRACT-V5 §1.1–1.3 ── */

  async function buildPacksState() {
    const settings = await loadPackSettings()
    const packs = []
    for (const pack of allLanguagePacks()) {
      const builtin = pack.builtin !== false
      const enabled = builtin
        ? settings.disabledBuiltins.indexOf(pack.id) < 0
        : settings.enabledExtras.indexOf(pack.id) >= 0
      let command = null
      try {
        command = await resolveCommand(pack)
      } catch {
        command = null
      }
      const detected = Boolean(command)
      const capture = await probeCaptureReadiness(pack, detected ? { command } : null)
      const installed = await isPackInstalled(pack.id)
      packs.push({
        id: pack.id,
        label: pack.label,
        builtin,
        enabled,
        detected,
        command: command ?? null,
        extensions: [...pack.extensions],
        capture: {
          kind: capture.kind,
          required: capture.required,
          ready: capture.ready,
          hint: capture.hint,
          installed,
        },
      })
    }
    return { ok: true, stateDir: packStateDir(), packs }
  }

  async function handlePacksGet() {
    return buildPacksState()
  }

  async function handlePacksPost({ body }) {
    const request = requireObjectBody(body)
    const id = request.id
    if (typeof id !== 'string' || id === '') throw new HttpError(400, 'bad-request', 'id is required')
    const pack = findLanguagePack(id)
    if (!pack) throw new HttpError(400, 'unsupported-language', `unknown language: ${id}`)
    if (typeof request.enabled !== 'boolean') throw new HttpError(400, 'bad-request', 'enabled must be a boolean')
    const settings = await loadPackSettings()
    const builtin = pack.builtin !== false
    if (builtin) {
      const disabled = settings.disabledBuiltins.filter((entry) => entry !== id)
      if (!request.enabled) disabled.push(id)
      await savePackSettings({ ...settings, disabledBuiltins: disabled })
    } else {
      const enabledExtras = settings.enabledExtras.filter((entry) => entry !== id)
      if (request.enabled) {
        let command = null
        try {
          command = await resolveCommand(pack)
        } catch {
          command = null
        }
        if (!command) {
          throw new HttpError(
            400,
            'language-unavailable',
            `no executable found for "${id}" (tried: ${pack.candidates.join(', ')})`,
          )
        }
        if (captureKindOf(pack) !== 'none') await installPackAssets(id)
        enabledExtras.push(id)
      }
      await savePackSettings({ ...settings, enabledExtras })
    }
    envCache = null
    envCacheAt = 0
    envCachePromise = null
    capturingDependencyCache = new Map()
    return buildPacksState()
  }

  async function handlePacksRescan() {
    envCache = null
    envCacheAt = 0
    envCachePromise = null
    capturingDependencyCache = new Map()
    return buildPacksState()
  }

  /* ── Dispatch: path → method → authorization → body → handler ────────────── */

  const routes = new Map([
    [API_ENV, { handlers: { GET: handleEnv } }],
    [API_RUN, { handlers: { POST: handleRun } }],
    [API_OUTPUT, { handlers: { GET: handleOutput } }],
    [API_STOP, { handlers: { POST: handleStop } }],
    [API_TOKEN, { handlers: { GET: handleToken }, bootstrap: true }],
    [API_FILES, { handlers: { GET: handleFiles } }],
    [API_FILE, { handlers: { GET: handleFileRead, POST: handleFileSave } }],
    [API_BLOB, { handlers: { GET: handleBlob } }],
    [API_ARTIFACTS, { handlers: { GET: handleArtifacts } }],
    [API_DIAG, { handlers: { GET: handleDiagGet, POST: handleDiagPost } }],
    [API_PACKS, { handlers: { GET: handlePacksGet, POST: handlePacksPost } }],
    [API_PACKS_RESCAN, { handlers: { POST: handlePacksRescan } }],
    [API_EXPLAIN, { handlers: { POST: handleExplain } }],
    [API_EXPORT, { handlers: { POST: handleExport } }],
    [API_SAVE_PLOTS, { handlers: { POST: handleSavePlots } }],
  ])

  async function dispatch(req, res, url) {
    const route = routes.get(url.pathname)
    if (!route) {
      throw new HttpError(404, 'unknown-route', `unknown route: ${url.pathname}`)
    }
    const method = typeof req.method === 'string' && req.method ? req.method.toUpperCase() : 'GET'
    const routeHandler = method === 'OPTIONS' ? null : route.handlers[method]
    if (!routeHandler) {
      throw new HttpError(405, 'method-not-allowed', `${method} is not allowed for ${url.pathname}`)
    }
    if (route.bootstrap) authorizeTokenBootstrap(req)
    else authorize(req)

    if (method === 'POST') {
      const raw = await readBody(req, LIMITS.bodyMaxBytes)
      return routeHandler({ url, body: parseJsonBody(raw) })
    }
    return routeHandler({ url, body: null })
  }

  async function handler(req, res) {
    try {
      const url = new URL((req && req.url) || '/', 'http://local')
      const payload = await dispatch(req, res, url)
      if (payload && payload[RAW_RESPONSE]) {
        if (!res.writableEnded) sendRaw(res, 200, payload.body, payload.contentType)
      } else if (!res.writableEnded) {
        sendJson(res, 200, payload)
      }
    } catch (error) {
      const isHttp = error instanceof HttpError
      const status = isHttp ? error.status : 500
      const code = isHttp ? error.code : 'internal'
      const message = isHttp ? error.message : String(error?.message ?? error)
      const failure = failurePayload(code, message)
      if (isHttp && error.extra) Object.assign(failure, error.extra)
      try {
        if (!res.writableEnded && !res.headersSent) sendJson(res, status, failure)
        else if (typeof res.end === 'function') res.end()
      } catch {
        /* the response stream is already gone — nothing left to do */
      }
    }
  }

  /* ── Registrations (all disposable, in reverse dispose order) ────────────── */

  function disposePlugin() {
    if (disposed) return
    disposed = true
    // Kill version probes that may still be in flight.
    for (const probe of activeProbes) {
      try {
        probe?.terminate?.()
      } catch {
        /* ignore */
      }
    }
    activeProbes.clear()
    // Terminate + remove every retained run.
    const removals = []
    for (const run of runs.values()) {
      if (run.timer) {
        clearTimeout(run.timer)
        run.timer = null
      }
      terminateRun(run)
      removals.push(removeRunDirectory(run))
    }
    runs.clear()
    envCache = null
    envCachePromise = null
    // Drop the (now empty) temp root once the per-run removals settle. rmdir is
    // non-recursive, so a concurrently reloaded instance's runs are never touched.
    void Promise.allSettled(removals).then(() => fsp.rmdir(TMP_ROOT).catch(() => {}))
  }

  // 1. Cleanup first, so it is disposed last.
  ctx.effect(() => disposePlugin)
  // 2. Token injection into the page shell.
  ctx.effect(() =>
    ctx.webServer.tapIndex((html) => {
      const page = typeof html === 'string' ? html : String(html ?? '')
      const match = /<\/head>/i.exec(page)
      if (!match) return tokenScript + page
      return page.slice(0, match.index) + tokenScript + page.slice(match.index)
    }),
  )
  // 3. The API prefix route.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
}
