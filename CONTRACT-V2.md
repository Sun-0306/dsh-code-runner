# dsh-code-runner v2 — implementation contract (shared, read-only for implementers)

v2 upgrades the v1 plugin in three directions the user asked for:

1. **Beside the conversation, not instead of it** — the workbench becomes a **right-sidebar
   tab type** of the DSH shell (`ctx.sidebarRightTabs` + `sidebar.right.pane.tab`), opened by a
   compact button in the conversation header, so chat stays visible. The v1 full-page
   entry (left sidebar row + `main` panel) is KEPT as a big-screen "workbench" mode.
2. **RStudio-like plots** — Python matplotlib figures and R graphics devices are captured
   automatically, together with image files a script writes into its working directory, and
   shown in a **Plots** tab with thumbnails, zoom/lightbox and refresh.
3. **Open real files from the working folder** — a **Files** tab browses the working
   directory, opens program/text files into the editor, saves them back (⌘S, conflict
   detection), and "Run" executes the opened file from disk (not a temp copy).

`CONTRACT.md` is the v1 contract. Everything in it still applies EXCEPT where
this file says otherwise. All identifiers from v1 §0 stay: package `dsh-code-runner`,
client module id `dsh-code-runner`, row id `dsh-code-runner`, locale namespace
`dsh-code-runner`, route prefix `/dsh-code-runner`, token header `x-dsh-code-runner-token`,
page global `window.__DSH_CODE_RUNNER__`, left sidebar id `code-runner`, `main` key
`code-runner`. New fixed identifiers:

| Thing | Value |
|---|---|
| right-sidebar tab type `id` | `dsh-code-runner` (must be unique; the shipped types use their package name) |
| right-sidebar tab `kind` | `code-runner` |
| guide entry `id` | `dsh-code-runner` |
| conversation-header button slot id | `code-runner-toggle` |

No build step, no npm dependencies, both halves stay hand-written JS
(Host: ESM + Node builtins; Client: single `window.__ModuleLoader__.load` file with only
`require('react')`). No JSX/TS/import in `client.js`.

## 1. Host half — `index.js` v2

v1 §1.1–1.11 remain in force (module shape, token + `tapIndex` injection, auth/origin gate,
`/api/token` bootstrap, JSON envelopes, language table, `/api/env`, `/api/output`,
`/api/stop`, retention and disposal). The `/api/run` contract is **extended** and five
**new** endpoints are added. Every new route sits under the same prefix and passes the same
`authorize()` gate as v1 (except the already-special `/api/token`).

### 1.1 Route table (v2, complete)

```
GET  /dsh-code-runner/api/env        v1 §1.6 + limits additions (see 1.2)
POST /dsh-code-runner/api/run        extended request (1.3), extended response (1.4)
GET  /dsh-code-runner/api/output     v1 §1.8 + extra fields (1.5)
POST /dsh-code-runner/api/stop       v1 §1.9 unchanged
GET  /dsh-code-runner/api/token      v1 §1.10 unchanged
GET  /dsh-code-runner/api/files      new (1.6)
GET  /dsh-code-runner/api/file       new (1.7)
POST /dsh-code-runner/api/file       new (1.8, save)
GET  /dsh-code-runner/api/blob       new (1.9, raw image/pdf bytes)
GET  /dsh-code-runner/api/artifacts  new (1.10, plots of a run)
GET  /dsh-code-runner/api/diag       new (1.12, browser diagnostics read)
POST /dsh-code-runner/api/diag       new (1.12, browser diagnostics append)
```

New stable error codes (same envelope as v1 §1.4): `bad-path`, `not-found`, `conflict`,
`too-large`, `unsupported-file`.

Timestamp fields (`mtimeMs`, `startedAt` follows the v1 integer epoch-ms rule; all
file `mtimeMs` values are **finite numbers** and filesystem precision may make them
fractional — clients must treat them as opaque tokens and echo them back unchanged
in `baseMtimeMs`). Equivalence for the §1.8 conflict guard is exact equality of the
number the API returned.

Envelope/serialization rules unchanged (JSON, `ok:true`/`{ok:false,error:{code,message}}`,
handler never throws, no CORS, bounded bodies).

### 1.2 `/api/env` additions

Add to `limits`: `"fileMaxBytes": 1048576`, `"blobMaxBytes": 16777216`,
`"artifactMax": 40`. Everything else unchanged.

### 1.3 `POST /api/run` — extended request

```json
{
  "mode": "buffer",
  "language": "python",
  "code": "print(1)",
  "file": "/abs/path/script.py",
  "cwd": "/abs/dir",
  "stdin": "optional",
  "timeoutMs": 300000,
  "capturePlots": true
}
```

Rules (v1 rules apply unless overridden):

- `mode`: optional `"buffer" | "file"`. Default: `"file"` when `file` is present, else `"buffer"`.
- **buffer mode**: `language` must be a known id (v1) and `code` a non-empty string (v1).
- **file mode**: `file` must be an absolute path (`bad-path`) to an existing regular file
  (`bad-path` or `not-found`; directories are `bad-path`). `code` is ignored.
  `language` optional: when absent, infer from the file extension (map below); when present
  it must be a known language id. If neither works → `400 unsupported-language`.
  The run uses the file on disk directly — no copy; `scriptPath` in the response is that path.
- `cwd`: optional absolute existing directory (v1). File mode does not default cwd to the
  file's directory: the same `defaultCwd` rule applies unless `cwd` is given (the client
  sends the workbench cwd explicitly).
- `capturePlots`: optional boolean, default `true`. When true the Host captures plots
  (1.3.1/1.3.2) into `<runDir>/plots/`.

Extension → language map (case-insensitive extension, no dot):

| ext | language |
|---|---|
| `py`, `pyw` | `python` |
| `r` | `r` |
| `mjs`, `cjs`, `js` | `node` |
| `sh` | `bash` |
| `zsh` | `zsh` |
| `rb` | `ruby` |
| `pl` | `perl` |
| `jl` | `julia` |
| `php` | `php` |
| `ts` | first available of `deno`, `bun`, `node` |

#### 1.3.1 Python plot capture

When `capturePlots` is true and the language is `python`:

- create `<runDir>/pysite/`, write `sitecustomize.py`. The **reference content** below is
  the required saver; on Python 3.13 / matplotlib 3.10 a plain `atexit.register` is NOT
  enough, because `matplotlib.pyplot` itself registers `Gcf.destroy_all` with `atexit`
  after startup and LIFO then destroys the figures before the saver runs. **Approved
  deviation D1:** append a small, documented one-shot `builtins.__import__` hook that
  re-registers `_dsh_code_runner_save` (after matplotlib imports pyplot, so LIFO runs the
  saver before `Gcf.destroy_all`). The wire behaviour (a matplotlib figure created without
  `savefig` appears as `source:"run"` PNG in `/api/artifacts`) is the contract; the file
  content is reference + documented workaround. The saver MUST keep this behaviour:

```python
# dsh-code-runner: save open matplotlib figures for the panel's Plots tab.
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
```

- spawn env adds `PYTHONPATH=<runDir>/pysite` (prepended to `process.env.PYTHONPATH` with
  `path.delimiter` when that exists) and `DSH_CODE_RUNNER_PLOTS_DIR=<runDir>/plots`.
- argv is unchanged from v1 (`[python, '-u', scriptPath]`, `MPLBACKEND=Agg` already set).

#### 1.3.2 R plot capture

When `capturePlots` is true and the language is `r`:

- create `<runDir>/plots/`, write `<runDir>/plot-wrapper.R` with EXACTLY this content:

```r
# dsh-code-runner: open a png device so plots are captured for the panel.
script <- Sys.getenv("DSH_CODE_RUNNER_SCRIPT")
outdir <- Sys.getenv("DSH_CODE_RUNNER_PLOTS_DIR")
if (!nzchar(script) || !nzchar(outdir)) {
  stop("dsh-code-runner: missing runner environment")
}
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)
grDevices::png(filename = file.path(outdir, "plot-%03d.png"), width = 1400, height = 1000, res = 144)
on.exit(try(grDevices::dev.off(), silent = TRUE), add = TRUE)
source(script, echo = FALSE, print.eval = TRUE)
```

- argv becomes `[Rscript, '--vanilla', wrapperPath]` (file/buffer mode alike); spawn env adds
  `DSH_CODE_RUNNER_SCRIPT=<scriptPath>` and `DSH_CODE_RUNNER_PLOTS_DIR=<runDir>/plots`.
- Documented consequence: inside an R run, `commandArgs()` names the wrapper; `source()`
  runs the user script in the global environment.

Other languages: no wrapper, no plot capture env (still scan cwd per 1.10).

### 1.4 `POST /api/run` — extended response

v1 §1.7 fields plus:

```json
{
  "ok": true, "runId": "…", "language": "python", "mode": "file",
  "file": "/abs/path/script.py",
  "command": "…", "scriptPath": "…", "cwd": "…",
  "startedAt": 1730000000000, "timeoutMs": 300000,
  "capturePlots": true, "plotDir": "<tmpRoot>/<runId>/plots"
}
```

`file` is `null` in buffer mode. `plotDir` is always the conventional path (created only
when `capturePlots` is true).

### 1.5 `/api/output` additions

The v1 `run` record must now also carry `mode`, `file`, `plotDir`, `capturePlots`; the
output response includes them verbatim on every poll (in addition to v1 fields):
`"mode"`, `"file"` (string or null), `"plotDir"`, `"capturePlots"`.

### 1.6 `GET /api/files?dir=<abs>`

List one directory. `dir` is required and absolute (`bad-path`); must be an existing
directory (`bad-path`). Does **not** recurse.

```json
{
  "ok": true,
  "dir": "/abs/dir",
  "parent": "/abs",
  "entries": [
    { "name": "script.py", "path": "/abs/dir/script.py", "isDir": false,
      "size": 123, "mtimeMs": 1730000000000, "ext": "py" }
  ],
  "truncated": false
}
```

- `parent`: `path.dirname(dir)` (for a filesystem root, the root itself).
- entries are not hidden: dotfiles are listed like any other entry (the client dims them).
- classification: `readdir(dir, { withFileTypes: true })`; a symlink is classified from its
  target (`stat`, broken link → `isDir:false`, `size:null`, `mtimeMs:null`). `stat` failures
  never fail the listing.
- sort: directories first, then files, each by `name` case-insensitive ascending
  (`localeCompare` with base sensitivity); cap `2000` entries, `truncated` true when more.
- `ext` = lowercase extension without the dot (`""` when none).

### 1.7 `GET /api/file?path=<abs>`

Read one text file. `path` absolute (`bad-path`); must exist (`not-found`) and be a regular
file (`bad-path`).

```json
{ "ok": true, "path": "/abs/f.py", "text": "print(1)\n", "size": 9,
  "mtimeMs": 1730000000000, "ext": "py", "truncated": false, "binary": false }
```

- binary detection: any NUL byte in the first 8192 bytes → `{ok:true, binary:true, text:"",
  size, mtimeMs, ext, truncated:false}` (no HTTP error; the client explains it).
- text cap `fileMaxBytes` (1 MiB): read at most that many bytes; when the file is larger,
  `truncated:true` and `text` holds the head (invalid UTF-8 bytes decoded lossily).
- 400 `bad-path` for directories or non-absolute paths; 404 `not-found`.

### 1.8 `POST /api/file` — save

Request:

```json
{ "path": "/abs/f.py", "text": "print(2)\n", "baseMtimeMs": 1730000000000 }
```

- `path` absolute (`bad-path`), must not be a directory (`bad-path`), parent directory must
  exist and be a directory (`bad-path`).
- `text` must be a string (`bad-request`) with `Buffer.byteLength <= fileMaxBytes`
  (`413 too-large`).
- Conflict guard: when `baseMtimeMs` is a number and the file exists with a different
  `mtimeMs` → `409 conflict` with payload
  `{"ok":false,"error":{"code":"conflict","message":…},"currentMtimeMs":…,"size":…}`.
  Omitting `baseMtimeMs` forces the write (client's explicit "overwrite").
- Writing creates the file when missing (mode `0o644`) and preserves an existing file's mode;
  it does not create parent directories.
- Reply: `{ "ok": true, "path", "size", "mtimeMs", "ext" }`.

### 1.9 `GET /api/blob?path=<abs>`

Raw bytes for previewing images/PDFs. `path` absolute (`bad-path`), existing regular file
(`not-found`), extension in the allowlist (`unsupported-file` otherwise):
`png jpg jpeg gif webp svg bmp avif pdf` (case-insensitive). Cap `blobMaxBytes` (16 MiB,
`413 too-large`). Responds `200` with the raw bytes and the matching content type
(`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`, `image/bmp`,
`image/avif`, `application/pdf`), `content-length`, `cache-control: no-store`. This is the
one route that is not JSON. No CORS.

### 1.10 `GET /api/artifacts?runId=<id>`

Plots of one known run (v1 `unknown-run` 404 otherwise). Works while running and after
finishing.

```json
{
  "ok": true, "runId": "…", "running": true,
  "plotDir": "<tmpRoot>/<runId>/plots",
  "plots": [
    { "path": "<plotDir>/plot-001.png", "name": "plot-001.png", "source": "run",
      "size": 12345, "mtimeMs": 1730000000000, "ext": "png" }
  ],
  "truncated": false
}
```

- `source:"run"`: files directly inside `<runDir>/plots` with an image extension
  (`png jpg jpeg gif webp svg bmp avif`), sorted by name.
- `source:"cwd"`: TOP-LEVEL entries of `run.cwd` that (a) are regular files, (b) have an
  image extension, (c) `size` between 1 and 16 MiB, (d) `mtimeMs >= run.startedAt - 2000`,
  and (e) are not inside the run directory; sorted by `mtimeMs` descending.
- Combine `run` first then `cwd`, de-duplicate by path, cap `artifactMax` (40),
  `truncated:true` when the cap cut items. Unreadable/vanishing files are skipped, never
  fail the response.

### 1.11 Disposal

v1 §1.7/§1.11 disposal still removes every run directory (plot dirs and wrapper/site files
included), and all watchers/timers. No new persistent state (the §1.12 diagnostics buffer is
in-memory and dies with the plugin row).

### 1.12 `GET|POST /api/diag` — browser diagnostics

Purpose: the browser half cannot be inspected from the shell, so it posts a small
fire-and-forget event stream the Host keeps in memory. This is what lets an operator (or
the agent) prove from the shell what the **real page** did: which client build loaded,
whether the right-sidebar tab type registered, whether a surface mounted, whether it
crashed, and what runs/plots happened. It is a debugging surface, not application state.

Both verbs are token-gated exactly like the other non-bootstrap routes.

`POST` body:

```json
{ "event": { "name": "surface-mount", "at": 1730000000000, "detail": { "mode": "pane", "width": 1440 } } }
```

or `{ "events": [ …up to 20 events… ] }`. `name` is a short string; `detail` is arbitrary
JSON. Recording sanitizes defensively: strings capped at 600 characters, object depth ≤ 3,
≤ 20 array items, ≤ 24 keys per object, keys must match `^[A-Za-z0-9_.:-]{1,64}$`
(anything unsafe is dropped), non-finite numbers → `null`. At most 20 events per request
(`400 bad-request` when neither `event` nor `events` is present). Reply:
`{ "ok": true, "accepted": <n> }`.

Ring buffer: the newest **100** events are kept; older ones are dropped. Each stored entry is
`{ "seq": <monotonic int>, "receivedAt": <epoch ms>, "event": <sanitized event> }`.

`GET` reply:

```json
{ "ok": true, "plugin": "dsh-code-runner", "route": "/dsh-code-runner", "events": [ … ] }
```

The buffer is process-local, per plugin instance, and is not persisted; a Host reload or
plugin reload clears it. The client reports these event names (§2.7): `apply`,
`right-tab`, `header-toggle`, `auto-open`, `toggle`, `surface-mount`, `surface-unmount`,
`surface-crash`, `run`, `artifacts`.

## 2. Browser half — `client.js` v2

### 2.1 Module shape and registrations

Same wrapper as v1 (`window.__ModuleLoader__.load({id:'dsh-code-runner', factory})`,
`require('react')` only, `{name, inject:['slots','locale'], apply}`). Keep v1's locale
registration; v1's `sidebar.panellist` row and `main` page registration stay. Add:

```js
// (a) right-sidebar tab type + body
ctx.effect(() => ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scoped) => {
  let offType = null
  let offBody = null
  try {
    offType = scoped.sidebarRightTabs.register({
      id: 'dsh-code-runner',
      kind: 'code-runner',
      title: () => t('panel.title'),
      guide: [{ id: 'dsh-code-runner', title: t('panel.title'), description: t('panel.subtitle') }],
      keepMounted: true,
    })
  } catch (error) { console.error('[dsh-code-runner] tab type registration failed', error) }
  const slotCtx = scoped
  try {
    offBody = slotCtx.slots.inject('sidebar.right.pane.tab', () => slotCtx.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'dsh-code-runner' },
      () => h(Workbench, { mode: 'pane', t, ctxRef: ctx }),
    ))
  } catch (error) { console.error('[dsh-code-runner] tab body registration failed', error) }
  return () => { try { offBody && offBody() } catch {} try { offType && offType() } catch {} }
}), 'dsh-code-runner: right tab')

// (b) conversation-header toggle button
ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
  ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'code-runner-toggle',
    order: 5, label: () => t('panel.label'), locale: NS,
  }, HeaderToggle)
), 'dsh-code-runner: header toggle')
```

`HeaderToggle` (compact icon button, 28px, currentColor glyph, `aria-label` from
`t('panel.rightbarOpen')`) click behaviour, all in try/catch:

1. `const right = ctx.get('sidebarRight')` — when present:
   - if `right.isExpanded && right.isExpanded()` and `right.active()` returns our tab
     (`tab.kind === 'code-runner'`), call `right.close(tab.id)` (closing the sole tab
     collapses the column);
   - otherwise `right.openTab('code-runner')` (opens/focuses and expands the column).
2. when absent, fall back to the v1 full page: `ctx.get('layout')?.selectPanel?.('code-runner')`.
Never throw: any failure falls back to the page.

If `sidebarRightTabs`/`sidebarRight` never arrive (older host), nothing above registers and
the v1 page entry remains the way in — the plugin must stay functional.

### 2.2 Workbench UI

One shared component tree drives both surfaces:

- page mode (v1 left row → `main` panel): RStudio-like three-zone page;
- pane mode (right-sidebar tab body): same zones stacked for a narrow column.

Layout — **page mode**:

```
header (title + subtitle + host chip)                  [v1 style, keep]
toolbar (see 2.3)
grid:
  left rail 200–320px: rail tabs [Files | Plots] + the selected list
  right column: editor (flex) + bottom console (v1 output, ~35%) with a drag divider
status bar
```

Layout — **pane mode** (right sidebar, ~320–560px):

```
compact toolbar (wraps, 2 rows)
editor (flex, with line-number gutter)
drag divider
bottom tab strip [Console | Plots | Files] + panel body (default 42% height)
status line (one compact row)
```

Both modes share the module-level store; a surface may unmount without losing code, the
open file, a running job, plots or the file listing. `keepMounted:true` keeps the pane body
mounted across tab switches.

### 2.3 Toolbar and actions

Row 1: current-file chip (`untitled` when none, dirty dot, path tooltip) · Save · Run · Stop.
Row 2: language `<select>` (only `available` languages, version in the option) ·
working-directory input + optional Choose… (`uiWorkspace.pickDirectory`) ·
"Save as…" for a scratch buffer (small inline dialog: file name, saved under cwd).

- **Run**: if a file is open → auto-save when dirty (then `{mode:'file', file}`); otherwise
  `{mode:'buffer', language, code}`. Always send `cwd`, `capturePlots:true`. ⌘/Ctrl+Enter works
  from the editor. Stop, Clear output and the v1 shortcut/tab behaviour stay.
- **Save** (⌘/Ctrl+S): file open → `POST /api/file` with `baseMtimeMs`; on `409 conflict`
  show an inline confirm ("文件已被外部修改，覆盖？") and retry without `baseMtimeMs`.
  Scratch buffer → "Save as…" dialog.
- **Open file**: from the Files tab; text kinds open in the editor (language inferred from
  the extension via §1.3's map and selected if available), images open the Plots lightbox,
  other binary kinds show a localized notice. When the current file is dirty, an inline
  confirm (Discard / Cancel) guards the replace.
- **Files tab**: breadcrumb of the cwd with an Up control, refresh, dirs first, dotfiles
  dimmed, sizes for files; a click on a directory navigates, on a file opens it. Errors map
  to localized notices (`bad-path`, `not-found`, `too-large`).
- **Plots tab**: gallery of `GET /api/artifacts` items for the current/last run, 2 columns in
  pane mode / more in page mode; each card = thumbnail (image via authenticated
  `GET /api/blob` fetched with the token header → `URL.createObjectURL`, revoked on
  refresh/unmount), file name, `运行产物/目录` source badge; click opens a lightbox
  (full-size image, name, source, prev/next, Copy path, Close; Esc closes). "Refresh"
  re-polls artifacts. New thumbs appear live while a run is in progress: poll artifacts
  every 1200 ms while the run is running, once more when it finishes. When the newest run
  produced `run`-source plots, switch the bottom tab to Plots automatically (unless the user
  is typing in the editor — then only bump the count badge). `lossy`/PDF items render a
  placeholder card with the file name instead of an image.
- **Console tab**: v1 streaming output (offsets, status line: exit/signal/timeout/stopped,
  duration) unchanged in content, restyled to sit inside the bottom panel.

### 2.4 Store, persistence, resilience

- One module-level store shared by both surfaces (v1's run store extended):
  `{env, languages, cwd, languageId, code, filePath, fileMtimeMs, dirty, run, output,
    plots:{items, status, runId, urls}, files:{dir, entries, status, error},
    ui:{bottomTab, railTab, splitRatio, lightbox, notice}}`.
  Subscribed via the v1 `useRunSnapshot` pattern (store emits snapshots; components
  re-render).
- `localStorage` keys (never throw): `dsh-code-runner.cwd`, `dsh-code-runner.language`,
  `dsh-code-runner.splitRatio`, `dsh-code-runner.bottomTab`,
  `dsh-code-runner.draft.<language>` (scratch buffer). A file that is open but unsaved is
  NOT auto-restored across reloads.
- Token handling stays v1 §2.2 (injected global → §1.10 bootstrap → refresh banner; 401
  resets once).
- All fetches and polls carry the token; artifact/blob fetches too. Abort in-flight work on
  unmount; no leaked timers; object URLs revoked.
- Host-offline / not-mounted notices stay localized; new error codes get their own keys.
- Error boundary around each surface (a crash must not blank the slot).

### 2.5 Styling

RStudio-flavoured but 100% host-native: only `--dsw-alias-*` tokens and
`--dsh-frame-top-clearance` for colour; class prefix `dcr-`; one `<style>` element rendered
inside each surface root; no literal hex/rgb/hsl colours, no `document.body` writes.

- Editor: monospace stack, 13px/20px, line-number gutter (static numbers synced to scroll),
  subtle `--dsw-alias-bg-layer-1` surface, focus ring on the editor only.
- Tabs: RStudio-like strips — chips with 1px bottom border, active tab uses
  `--dsw-alias-bg-layer-2` + primary label, inactive secondary label; icons per tab
  (console/plots/files), counts as small badges.
- Cards/cards lists: 8px radius, `--dsw-alias-border-l1` borders, hover `bg-layer-2`.
- Plots gallery: card with neutral surface (`bg-layer-1`), image contained, caption row;
  lightbox = absolute overlay inside the surface root (`bg-overlay`, backdrop,
  `object-fit: contain`, controls in the top row).
- Status bar: 12px secondary, separator dots; primary Run button uses brand fill (v1
  contrast choice).
- Pane mode: transparent ground (the shell column owns the background), 8–10px padding;
  page mode: v1 page header + `bg-base`.
- Responsive: page mode collapses the left rail below ~720px (rail becomes a tab above the
  console); pane mode stacks and wraps toolbars; no horizontal page scroll.
- Accessibility: real buttons, `aria-label`/`aria-pressed` for icon toggles, tablist roles on
  tab strips with arrow-key switching, lightbox `role="dialog"` + Esc, focus-visible rings.

### 2.6 Locale

Keep every v1 key. Add (zh + en, identical key sets):

```
panel.rightbarOpen, panel.rightbarClose
toolbar.save, toolbar.saveAs, toolbar.file, toolbar.untitled, toolbar.dirty
toolbar.runFile, toolbar.runBuffer, toolbar.newFile
tabs.console, tabs.plots, tabs.files
files.title, files.refresh, files.up, files.empty, files.loading, files.root
files.openFailed, files.binary, files.tooLarge, files.dir
plots.title, plots.refresh, plots.empty, plots.loading, plots.count, plots.sourceRun,
plots.sourceCwd, plots.close, plots.prev, plots.next, plots.copyPath, plots.copied,
plots.unsupported
editor.saving, editor.saved, editor.dirty, editor.unsavedTitle, editor.unsavedBody,
editor.discard, editor.cancel, editor.conflictTitle, editor.conflictBody,
editor.overwrite, editor.saveFailed, editor.savedAndRan, editor.openFileTitle,
editor.saveAsTitle, editor.saveAsPlaceholder, editor.saveAsConfirm
status.modeFile, status.modeBuffer, status.line, status.col
error.badPath, error.fileNotFound, error.conflict, error.fileTooLarge,
error.unsupportedFile, error.saveFailed
```

### 2.7 Browser diagnostics

The browser half reports the §1.12 events with a `reportDiag(name, detail)` helper that is
strictly fire-and-forget: it resolves the §1.10 token, `POST`s one event, ignores each
failure, never throws into React, and sends at most **24 events per page load**. Call
sites: `apply` (boot fingerprint: client version, right-sidebar service availability,
locale id), `right-tab` (tab-type/body registration booleans), `header-toggle`
(mounted), `auto-open` (`{ok, attempts}`), `toggle` (`{opened, fallback?}`),
`surface-mount` / `surface-unmount` (`{mode, width}`), `surface-crash`
(`{message, componentStack head}` from the error boundary), `run` (language/mode/exit
facts once a run finishes), and `artifacts` (plot counts per artifacts read).

## 3. Definition of done


- `node --check index.js && node --check client.js` (and each test file).
- `node tests/host-smoke.mjs`, `node tests/verify-host.mjs`, `node tests/client-smoke.mjs`,
  `node tests/verify-static.mjs` all green; `node tests/verify-live.mjs` green against the
  running DSH (it now also covers files/save/blob/artifacts/file-mode runs/plot capture).
- Right-sidebar integration live: after the edit is picked up by the page, the client Slots
  inspector shows `sidebar.right.pane.tab` occupant with key `dsh-code-runner` and
  `conversation.session.header.utilities` occupant id `code-runner-toggle`, both active.
- The existing v1 surfaces keep working (left row + full page).
- No plugin file outside the implementer's write scope is touched; `CONTRACT-V2.md`,
  `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md` are Lead-owned.

## 4. Known risks / fallbacks

- `ctx.sidebarRightTabs` / `ctx.sidebarRight` are documented public seats of the shipped
  right sidebar but are not listed by the client Service inspect provider; registration is
  therefore fully wrapped in try/catch and the v1 page path is the fallback. Do not hard-inject
  them into the module's `inject` array (a wrong name would unmount the whole client half).
- The host half is loaded by HMR from the linked bundle directory; the first live check after
  an edit is that a v2 route answers (401 without token = mounted). If the row did not reload,
  tell the Lead instead of restarting DSH yourself.
- R runs go through a wrapper (documented consequence in §1.3.2); Python plot capture is via
  `sitecustomize` on `PYTHONPATH`. Both are no-ops for scripts that never import matplotlib /
  open a graphics device.
