# dsh-code-runner — implementation contract (shared, read-only for implementers)

This file is the single source of truth for the plugin's two halves. **Do not edit it**;
if something here cannot be implemented, message the Lead instead of improvising a
different wire format. `index.js` (Host) and `client.js` (browser) must match the
shapes on this page exactly, character for character on JSON field names.

## 0. Product

A DSH plugin (one bundle, two halves) that adds a **left sidebar icon** and a center
panel page where the user writes a script (Python / R / Node.js / Bash / …), presses
Run, and watches stdout/stderr stream in. Execution happens in the DSH **Host**
process on this machine through the Host `subprocess` service.

Fixed identifiers (must not drift):

| Thing | Value |
|---|---|
| npm package name / client module id | `dsh-code-runner` |
| Host loader row id | `dsh-code-runner` |
| sidebar `sidebar.panellist` id | `code-runner` |
| `main` keyed slot key | `code-runner` |
| client locale namespace | `dsh-code-runner` |
| HTTP route prefix | `/dsh-code-runner` |
| token global injected into the page | `window.__DSH_CODE_RUNNER__` (object `{ token: string }`) |
| sidebar row order | `30` (host rows are Plugins=0, Schedules=10, Task board=20) |

No build step: plain ESM JavaScript, no TypeScript, no JSX, no npm dependencies.
Host half imports only Node builtins (`node:crypto`, `node:fs/promises`, `node:os`,
`node:path`). Client half is a single file that calls
`window.__ModuleLoader__.load({ id: 'dsh-code-runner', factory(require) { … } })`
and gets React through `require('react')` only.

## 1. Host half — `index.js`

### 1.1 Module shape

```js
export const name = 'dsh-code-runner'
export const inject = ['webServer', 'subprocess']
export function apply(ctx) { /* everything below inside here; all registrations via ctx.effect */ }
```

No `Config` export (tunables are module constants documented in README.md). Optional
services are read with `ctx.get('workingDirectory')` and must tolerate `undefined`
(fallback: `process.cwd()`).

### 1.2 Token + page injection

At apply time: `const token = crypto.randomBytes(24).toString('hex')`.

Register an index transform through `ctx.webServer.tapIndex(html => …)` (inside
`ctx.effect`) that injects, immediately before `</head>` when present (else at the
start of the document):

```html
<script>window.__DSH_CODE_RUNNER__={"token":"<token>"};</script>
```

The token is hex, so no HTML escaping is needed. This global is the CSRF token the
browser half sends back on every API call.

**Token bootstrap (added):** because a page loaded before the plugin activated may
not carry the injected global, the Host also serves `GET /dsh-code-runner/api/token`
(see §1.10). It hands the same token to loopback peers only, so the browser half can
recover without a page refresh and shell-based end-to-end tests stay deterministic.
It does not weaken the browser threat model: the endpoint never answers a cross-site
request and the response is unreadable cross-origin (no CORS).

### 1.3 Route and authorization

Register exactly one route inside `ctx.effect`:

```js
ctx.webServer.register({ kind: 'prefix', path: '/dsh-code-runner', handler })
```

`handler(req, res)` must:

1. Parse `const url = new URL(req.url ?? '/', 'http://local')`; match these exact
   pathnames (anything else → `404` JSON `unknown-route`):
   - `GET  /dsh-code-runner/api/env`
   - `POST /dsh-code-runner/api/run`
   - `GET  /dsh-code-runner/api/output`
   - `POST /dsh-code-runner/api/stop`
   - `GET  /dsh-code-runner/api/token` (bootstrap; special authorization, §1.10)
2. Reject `OPTIONS` and every other method with `405` `method-not-allowed` (no CORS
   headers are ever emitted).
3. **Authorize** every request except `GET /api/token` (which uses its own loopback
   rule in §1.10):
   - header `x-dsh-code-runner-token` must equal the generated token (constant-time
     compare preferred) → else `401` `{ok:false,error:{code:"unauthorized",message:"missing or invalid host token — reload the page"}}`;
   - if `origin` header is present it must equal `ctx.webServer.getOrigin()` exactly,
     OR its hostname[:port] must equal the request's `Host` header (case-insensitive,
     default ports normalized, scheme may differ behind a reverse proxy) → else
     `403` `forbidden`;
   - if `sec-fetch-site` equals `cross-site` → `403` `forbidden`.
4. Read the optional JSON body for POST with `req.on('data' | 'end' | 'error')`,
   cap at 2 MiB (bigger → `413` `body-too-large`), parse JSON (`400` `bad-json` on
   failure), and count `code` length ≤ 1 MiB (`413` `code-too-large`).
5. Respond with `content-type: application/json; charset=utf-8` and a plain JSON
   body. Never throw out of the handler: unexpected failures become `500`
   `{ok:false,error:{code:"internal",message:String(error?.message ?? error)}}`.

### 1.4 JSON envelopes

Success: `{ "ok": true, …payload }`.
Failure: `{ "ok": false, "error": { "code": "<stable-code>", "message": "<human text>" } }`
with an appropriate HTTP status. Stable error codes used by the browser:

`unauthorized`, `forbidden`, `unknown-route`, `unknown-run`, `body-too-large`,
`code-too-large`, `bad-json`, `bad-request`, `bad-cwd`, `unsupported-language`,
`language-unavailable`, `spawn-failed`, `method-not-allowed`, `internal`.

Error messages are English (the panel renders localized text for the *codes* and
appends the host `message` as detail).

### 1.5 Languages

Module constant table, in this order. `candidates` are tried in order through
`ctx.subprocess.resolveExecutable` (catch failures and continue); first hit wins.
Also try each bare name once more with `env: { PATH: process.env.PATH ?? '' }` when
the plain lookup fails, and always keep the absolute candidates.

| id | label | candidates | script file | argv after executable |
|---|---|---|---|---|
| `python` | Python | `python3`, `python`, `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/opt/anaconda3/bin/python3`, `/usr/bin/python3` | `script.py` | `-u`, script |
| `r` | R | `Rscript`, `/opt/homebrew/bin/Rscript`, `/usr/local/bin/Rscript`, `/Library/Frameworks/R.framework/Resources/bin/Rscript`, `/usr/bin/Rscript` | `script.R` | `--vanilla`, script |
| `node` | Node.js | `node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node` | `script.mjs` | script |
| `bash` | Bash | `bash`, `/bin/bash` | `script.sh` | script |
| `zsh` | Zsh | `zsh`, `/bin/zsh` | `script.zsh` | script |
| `ruby` | Ruby | `ruby`, `/usr/bin/ruby` | `script.rb` | script |
| `perl` | Perl | `perl`, `/usr/bin/perl` | `script.pl` | script |
| `julia` | Julia | `julia` | `script.jl` | script |
| `deno` | Deno | `deno` | `script.ts` | `run`, `--allow-all`, script |
| `bun` | Bun | `bun` | `script.ts` | `run`, script |
| `php` | PHP | `php` | `script.php` | script |

Each language also carries a one-line starter template the browser uses as the
editor placeholder (`template` string, see §1.6). Version probing: for each
*available* language spawn its `--version` argv (`['--version']`) with collect-mode
max 4096 bytes, 3 s timeout, parse the first non-empty line of stdout or stderr
(trim, cap at 80 chars), cache the whole env result for 10 minutes. Version probing
must never fail the endpoint (missing/erroring probe → `version: null`).

### 1.6 `GET /api/env` response

```json
{
  "ok": true,
  "platform": "posix",
  "defaultCwd": "/Users/sunchujun/Desktop/deepseek",
  "tmpRoot": "/var/folders/…/dsh-code-runner",
  "limits": { "codeMaxBytes": 1048576, "outputMaxBytes": 2097152, "defaultTimeoutMs": 300000, "maxTimeoutMs": 1800000 },
  "languages": [
    {
      "id": "python",
      "label": "Python",
      "available": true,
      "command": "/opt/anaconda3/bin/python3",
      "version": "Python 3.13.9",
      "template": "print(\"Hello from Python\", 1 + 1)\n"
    }
  ]
}
```

`languages` contains every known language with `available` flags (the panel renders
only available ones, so `command`/`version` may be `null` for unavailable entries).
`defaultCwd` = `ctx.get('workingDirectory')?.defaultDirectory` ?? `process.cwd()`.
`template` is a non-executing starter snippet (e.g. Python:
`print("Hello from Python", 1 + 1)`; R: `cat("Hello from R\n")`; Node.js:
`console.log("Hello from Node.js", process.version)`; Bash: `echo "Hello from Bash"`;
others: a comment line plus hello-world line).

### 1.7 `POST /api/run` request and response

Request body:

```json
{ "language": "python", "code": "print('hi')", "cwd": "/abs/path", "stdin": "optional text", "timeoutMs": 300000 }
```

- `language` must be a known id (`unsupported-language`) and available on this
  machine (`language-unavailable`, message names the missing executables).
- `code` must be a non-empty string (`bad-request`).
- `cwd` optional; when present it must be a string, absolute (`bad-cwd`), and an
  existing directory (`bad-cwd`). Default `defaultCwd`; if that is missing too, fall
  back to `os.tmpdir()`.
- `timeoutMs` optional integer, clamped to `1000 … 1800000`, default `300000`.
- `stdin` optional string ≤ 1 MiB; when present it is fed to the process as
  `{ data: stdin.endsWith('\n') ? stdin : stdin + '\n' }`, else stdin is `'ignore'`.

Behavior: create `<tmpRoot>/<runId>/` (runId = `crypto.randomUUID()`), write the
script file with mode `0o600`, spawn through `ctx.subprocess.spawn` with

```js
{
  argv: [executable, ...args], cwd,
  stdio: { stdin, stdout: { maxBytes: 2097152, spill: { maxBytes: 16777216 } },
           stderr: { maxBytes: 2097152, spill: { maxBytes: 16777216 } } },
  env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PYTHONUNBUFFERED: '1',
         PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg' },
  graceMs: 2000,
}
```

Record the run before replying. Reply immediately (do not await process exit):

```json
{ "ok": true, "runId": "…", "language": "python", "command": "…", "scriptPath": "…",
  "cwd": "…", "startedAt": 1730000000000, "timeoutMs": 300000 }
```

`command` is the executable plus args joined by single spaces for display.
`handle.done` records `exitCode`, `signal`, `finishedAt`, `durationMs` and clears
the timeout timer; a timeout sets `timedOut: true` then calls `handle.terminate()`.
Terminate on `SIGTERM`-ish grace failures must never crash the plugin.

Retention: keep at most 25 most recent runs; evicting a finished run deletes its
directory (`fsp.rm(dir,{recursive:true,force:true})`), terminates an evicted running
run first. All runs are terminated and removed on plugin disposal (cleanup returned
from `ctx.effect`), timers cleared.

### 1.8 `GET /api/output?runId=…&stdoutFrom=0&stderrFrom=0`

`runId` required (`bad-request`), unknown/evicted → `404` `unknown-run`.
`stdoutFrom`/`stderrFrom` are byte offsets (integers ≥ 0, default 0; invalid → 0).
Read with the providers' non-consuming readers:

```js
const out = run.handle.collected.stdout?.readFrom(stdoutFrom)
// → { text, nextOffset, lossy, spillPath? }
```

Response (always `ok:true` when the run is known):

```json
{
  "ok": true, "runId": "…", "language": "python", "command": "…", "scriptPath": "…",
  "cwd": "…", "startedAt": 0, "running": true,
  "exitCode": null, "signal": null, "durationMs": null, "timedOut": false, "stopped": false,
  "stdout": { "text": "…", "nextOffset": 12, "lossy": false },
  "stderr": { "text": "", "nextOffset": 0, "lossy": false }
}
```

Missing readers (e.g. none) → `{ text: '', nextOffset: <from>, lossy: false }`.
`durationMs` is `finishedAt - startedAt` once finished, else `null`. `stopped` is true
when the user requested a stop.

### 1.9 `POST /api/stop` body `{ "runId": "…" }`

Known run → call `handle.terminate()`, mark `stopped: true`, reply
`{ ok:true, runId, stopped:true, running:<still true → false> }`. Unknown → `404`
`unknown-run`. Stopping an already finished run replies `{ok:true,…,stopped:false}`.

### 1.10 `GET /api/token` — loopback token bootstrap

Purpose: a page that loaded before this plugin activated has no
`window.__DSH_CODE_RUNNER__`; the panel can fetch the token instead of forcing a page
refresh, and shell-based end-to-end verification can drive the real API.

This route does **not** require the token header. It answers only when **all** of
these hold, else `403 forbidden`:

1. `req.socket.remoteAddress` parses as loopback: `127.0.0.0/8` (also
   `::ffff:127.*`), or `::1`. Anything else (LAN, tunnel peer) → 403.
2. The `Host` header's hostname is a loopback name: `127.*`, `localhost`, `[::1]`,
   or `::1` (strip the port correctly for bracketed IPv6). A reverse proxy or tunnel
   presents its public authority here → 403.
3. Not cross-site: when `sec-fetch-site` is present it must not be `cross-site`;
   when `origin` is present it must be loopback (`http://127.0.0.1[:port]`,
   `http://localhost[:port]`, `http://[::1][:port]`).

On success:

```json
{ "ok": true, "token": "<the same token>" }
```

Rationale: the response is unreadable to cross-origin JavaScript (no CORS), the
token still must be sent as a header on every real call (so a cross-site request
cannot execute anything), and a tunneled public authority is refused by rule 2. This
keeps the desktop threat model unchanged while making the panel self-healing after
an in-place plugin install.

## 2. Browser half — `client.js`

Single self-contained file, no imports/exports at top level, no JSX:

```js
window.__ModuleLoader__.load({
  id: 'dsh-code-runner',
  factory(require) {
    const React = require('react')
    // …all code…
    return { name: 'dsh-code-runner', inject: ['slots', 'locale'], apply(ctx) { … } }
  },
})
```

### 2.1 apply(ctx)

```js
export-ish apply(ctx) {
  ctx.effect(() => ctx.locale.register('dsh-code-runner', { zh, en }), 'dsh-code-runner: locale')
  const t = ctx.locale.bind('dsh-code-runner')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'code-runner', order: 30,
    label: () => t('panel.label'), locale: 'dsh-code-runner',
  }, SidebarIcon)), 'dsh-code-runner: sidebar row')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'code-runner', locale: 'dsh-code-runner',
    inject: () => ({ t }),
  }, Panel)), 'dsh-code-runner: panel')
}
```

`SidebarIcon(ownerProps)` receives `{ size: number, active: boolean }` and returns a
16×16-viewBox inline SVG drawn with `stroke="currentColor"`/`fill="currentColor"`
so the shell's active/inactive colour applies: a terminal chevron `>_` glyph, no
own palette. Wrap the panel in a React error boundary that renders a localized
"panel crashed, refresh" block instead of throwing (a throwing slot entry blanks the
slot).

### 2.2 Panel behavior

- On mount: fetch env (`/api/env`), restore persisted cwd (`localStorage`
  `dsh-code-runner.cwd`), restore the per-language draft
  (`dsh-code-runner.draft.<id>`, debounced save), pick first available language.
  Token resolution is a small module-level async helper: use
  `window.__DSH_CODE_RUNNER__?.token` when present, otherwise `GET
  dsh-code-runner/api/token` once (bootstrap, §1.10) and remember the answer. If
  both fail, show the localized "refresh the page" banner and skip fetching. Any
  later `401 unauthorized` resets the cached token and retries the bootstrap once.
- Language `<select>` lists available languages (`label` + `version` in option).
  "Rescan" button re-fetches env.
- Working-directory text input (absolute path) + optional "Choose…" button when
  `ctx.get('uiWorkspace')?.pickDirectory` exists; a failed pick is ignored.
- Run: `POST /api/run`, then poll `GET /api/output` every 250 ms with the byte
  offsets returned so far, appending `text` to the matching buffer; keep polling
  until a poll reports `running:false` (one extra poll after finish to drain the
  tail). Stop: `POST /api/stop`, keep polling until finished. Clear: reset buffers
  and status. Copy: `navigator.clipboard.writeText` on the combined output.
- `⌘/Ctrl + Enter` in the editor runs. Tab in the editor inserts two spaces.
- Keep the in-flight run in a module-level store so switching to the conversation
  and back re-attaches to the same run (the panel unmounts when another sidebar row
  is selected). Abort in-flight fetches on unmount; never leak intervals
  (250 ms `setInterval` or recursive `setTimeout`, cleared on unmount/finish).
- Status line after finish: exit code / signal / timed out / stopped, plus duration.
  `stderr` is rendered in `--dsw-alias-state-error-primary`; truncation
  (`lossy`) shows the localized "output truncated" note.
- Request header on every call: `x-dsh-code-runner-token: window.__DSH_CODE_RUNNER__.token`,
  `accept: application/json`. URLs are **document-relative** (`dsh-code-runner/api/env`,
  no leading slash) so sub-path deployments work.
- Map failure codes to localized messages: `unauthorized` → refresh-page text,
  `unknown-run` → run vanished, network error → "host unavailable" chip + retry,
  `language-unavailable`/`bad-cwd` → show host message inline. A 404 (plain text
  from the webserver) means the Host half is not mounted → localized
  "host API not mounted" message.

### 2.3 Layout and styling

- Root: `height:100%; min-height:0; box-sizing:border-box; display:flex;
  flex-direction:column; color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-base);
  padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 0;`
- Content column centered like a host page:
  `padding-left/right: max(max(16px,min(4vw,48px)), 50% - 620px)`; the panel fills
  the remaining height with `min-height:0`.
- Header: title + one-line subtitle (secondary label colour), host status chip.
- Toolbar: bordered controls on `--dsw-alias-bg-layer-1` surface,
  `--dsw-alias-border-l1` borders, `--dsw-alias-brand-primary` primary Run button
  (white/contrast label), 28–32 px control height, 8 px radius, 12 px gaps.
- Editor and output share vertical space (editor `flex: 1 1 0`, min-height 120 px;
  output `flex: 1 1 0`, min-height 100 px). Monospace editor textarea with
  `resize:none`, `tab-size:2`. Output is one scrollable `<pre>` (stdout+stderr
  blocks), `role="log"`, auto-scroll to bottom on new output.
- All styles live in a `<style>` React element rendered inside the panel root;
  component unmount removes them. **Only** `--dsw-alias-*` and
  `--dsh-frame-top-clearance` variables for colour/spacing; no literal palette
  except `transparent`/`currentColor`/`inherit`. Class prefix `dcr-`.
- Every visible string goes through `t('…')`; zh and en dictionaries must have the
  exact same key set (list in §2.4). `t(key, params)` is a tiny local helper that
  interpolates `{name}` placeholders from the params object.
- Buttons are real `<button>` elements (no divs), have `type="button"`,
  `aria-label` where the label is icon-only, disabled states, and `:focus-visible`
  outlines. The select has a visually associated `<label>`.

### 2.4 Locale keys (both zh and en required, identical key sets)

```
panel.label, panel.title, panel.subtitle
status.ready, status.offline
toolbar.language, toolbar.cwd, toolbar.pick, toolbar.rescan, toolbar.run,
toolbar.stop, toolbar.clear, toolbar.copy, toolbar.running
hint.shortcut
editor.placeholder
output.title, output.idle, output.running, output.empty, output.truncated
status.exit, status.signal, status.timeout, status.stopped, status.duration
env.scanning, env.none
error.noToken, error.host, error.unauthorized, error.forbidden, error.setup,
error.unknownRun, error.languageUnavailable, error.badCwd, error.emptyCode,
error.crashed, error.crashedHint, error.copyFailed
```

Suggested zh values (final wording is the implementer's): panel.label 代码运行器,
toolbar.run 运行, toolbar.stop 停止, output.title 输出, error.noToken
「页面还没拿到宿主令牌，请刷新页面后重试」.

## 3. Definition of done for each file

- `node --check index.js` and `node --check client.js` pass.
- No `import`/`export`/JSX/TS syntax in `client.js`; no `require()` other than
  `require('react')`.
- Host: every registration is wrapped in `ctx.effect`; disposal terminates
  processes and removes temp files; handler never throws.
- Client: only theme tokens; no `document.body` mutation; no Harness client package
  imports; all locale keys present in both languages; UI text via `t()`.
- JSON field names match §1.4–§1.9 exactly (the two files are written by different
  people — treat this page as the compiler).

## 4. Verification hooks

- `tests/host-smoke.mjs` (Host implementer): import `../index.js`, build a stub
  `ctx` ({ webServer: { register, tapIndex, getOrigin }, subprocess: a stub backed by
  `node:child_process` that implements the same collect/readFrom contract,
  effect(fn) }, `get`, `on` no-ops), then drive `handler` with fake req/res objects
  (EventEmitter with `method`, `url`, `headers`, `socket`) and assert: unauthorized
  401, env lists python/r, run python prints, output polling returns text and exit 0,
  run R prints, stop works, unknown run 404, bad cwd 400. This test does not need
  the plugin installed.
- Lead/verifier do the live checks after installation: the DSH page itself is
  cookie-authenticated, but **named plugin routes are reachable anonymously**, and
  §1.10's bootstrap answers a loopback `curl` with the token. So the live suite is:
  `GET /dsh-code-runner/api/token` on `http://127.0.0.1:<port>` (Host header is
  loopback) → token → `/api/env`, real Python + R runs, stop, error cases; plus the
  sidebar row + panel occupancy through `cordis_inspect_query` (client Slots). Also
  assert anonymous `GET /api/env` without the header is `401`.
