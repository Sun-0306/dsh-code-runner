# dsh-code-runner v3 — implementation contract (shared, read-only for implementers)

v3 adds five capabilities on top of v2 (`CONTRACT.md` v1 + `CONTRACT-V2.md`):

1. **导出运行报告** — one click writes the code + stdout/stderr + plots + metadata into a
   NEW folder next to the code (`dsh-code-runner-reports/<timestamp>-<language>/`), with
   `report.md`, a self-contained `report.html`, copied plot images and `run.json`.
2. **AI 注释/解释代码** — a Host endpoint calls the DSH `llm` service with the default model
   and returns `{summary, annotatedCode}`; the panel can show the summary and insert the
   annotated code into the editor.
3. **运行选中代码** — selecting text in the editor and pressing the button / shortcut runs
   exactly that selection as a buffer run (same cwd/language), R included.
4. **MATLAB** — language `matlab` (auto-discovered `MATLAB_R*.app`), executed with
   `-batch` through a wrapper that exports every `figure` to the run's plots dir; the panel
   adapts its interface per language (profiles).
5. **图表保存** — per-plot / all-plots one-click save, default destination is the folder of
   the currently open code file (else the working directory), and better plot presentation.

Everything from v1/v2 stays (routes, auth/token, files, plots, right-sidebar tab, page mode,
diagnostics). Fixed identifiers are unchanged. No build step; both halves stay plain JS
(Host: ESM + Node builtins; Client: single `__ModuleLoader__` file, only `require('react')`).

## 1. Host half — `index.js` v3

### 1.1 Routes added

```
POST /dsh-code-runner/api/explain      AI explanation + annotated code (1.2)
POST /dsh-code-runner/api/export       write the report folder (1.3)
POST /dsh-code-runner/api/save-plots   copy selected plots into the code folder (1.4)
```

All use the existing token/origin gate and JSON envelope. New error codes:
`llm-unavailable`, `llm-failed`, `llm-timeout`.

`/api/env` limits add `"explainMaxChars": 20000`. `/api/env` languages gain
`matlab` (below); every language entry also gains `"extensions": ["py","pyw"]`-style
lowercase extension list (client uses it for adaptive UI/save-as defaults).

### 1.2 `POST /api/explain`

Request: `{ "language": "r", "code": "…", "fileName": "/abs/x.R" | null }`.
- `language` known (`unsupported-language`), `code` non-empty string (`bad-request`), at most
  `explainMaxChars` (longer is truncated to the limit and `truncatedInput: true`).
- Provider/model: `ctx.get('agentDefaultModel')?.currentSelection()` must yield string
  `provider` and `model`, and `ctx.get('llm')?.stream` must exist; otherwise
  `503 llm-unavailable` (message names what is missing). Both services are optional — the
  plugin's `inject` array stays as-is and lookups use `ctx.get`.
- Call: `llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal })`.
  Collect every `text-delta` chunk's `text`; stop at 60000 chars. Overall timeout 90 s
  (`AbortController`, `504 llm-timeout`); a thrown/`finish.error` stream → `502 llm-failed`
  with the failure message. Never hang the HTTP request.
- Prompt (system): ask for STRICT JSON only, no code fences:
  `{"summary": "<中文、3-8 句，说明这段代码的目的、输入、关键步骤、输出>", "annotatedCode": "<与原代码语义完全一致、只增加注释（Python/R 用 #，MATLAB 用 %）的版本>"}`.
  The user prompt carries language, optional file name and the code in a fenced block.
- Parse the text: strip Markdown fences, take the first balanced JSON object, `JSON.parse`.
  If parsing fails, return `{summary: <raw text trimmed to 4000 chars>, annotatedCode: ""}`.
- Reply:
  `{ "ok": true, "summary": "…", "annotatedCode": "…", "provider": "…", "model": "…", "truncatedInput": false }`.

### 1.3 `POST /api/export`

Request:

```json
{
  "language": "r", "mode": "buffer", "file": "/abs/chart.R" | null,
  "cwd": "/abs/work", "command": "Rscript --vanilla /tmp/…/plot-wrapper.R",
  "code": "…", "stdout": "…", "stderr": "…",
  "exitCode": 0, "durationMs": 1234, "startedAt": 1730000000000,
  "summary": "optional AI summary" | null,
  "plots": [{ "path": "/abs/plots/plot-001.png", "name": "plot-001.png", "source": "run" }]
}
```

- `language` known; `cwd`/`file` absolute (`bad-path`); the **base directory** is
  `file ? dirname(file) : cwd` and must exist and be a directory (`bad-cwd`).
- Create `base/dsh-code-runner-reports/` (recursive) and a **new** run folder
  `<YYYYMMDD-HHmmss>-<language>` (single-dash language id, e.g. `20261027-231500-r`);
  on collision append `-2`, `-3`, … Never write into an existing run folder.
- Copy up to 40 plot files with an image extension into `<run>/plots/<name>` (dedupe names,
  skip unreadable / >16 MiB). `plots[].path` must be absolute and an allowed image extension
  (`unsupported-file` when it is not; a missing single plot is skipped, not fatal).
- Write `<run>/report.md` (UTF-8):
  - Title `# 代码运行报告 · <language> · <local time>`, metadata bullets (脚本/工作目录/命令/
    退出码/耗时/生成时间), `## 代码` fenced block in the language, `## 输出` fenced text block
    (stdout then stderr, truncated markers when clipped), `## 图表` with `![](plots/<name>)`
    per copied plot, `## AI 解读` when `summary` is a non-empty string.
  - Caps: code ≤ 1 MiB, each stream ≤ 2 MiB (mark `…（已截断）`).
- Write `<run>/report.html`: one self-contained HTML document (`<!doctype html>`, zh-CN,
  system font stack, neutral light/dark via `prefers-color-scheme`, escaped text, `<pre>`
  code/output, plots inlined as `data:image/<type>;base64,…`, AI summary section). Total
  inline image budget ≤ 32 MiB; over-budget plots are links to `plots/<name>` instead.
- Write `<run>/run.json` with the sanitized request metadata (no code/output bodies).
- Reply: `{ "ok": true, "folder": "<abs>", "reportPath": "<abs>/report.md",
  "htmlPath": "<abs>/report.html", "plotFiles": ["plots/a.png"], "files": ["report.md","report.html","run.json","plots/a.png"] }`.

### 1.4 `POST /api/save-plots`

Request: `{ "plots": [{ "path": "/abs/a.png", "name": "a.png" }], "targetDir": "/abs/code/dir" }`.
- `targetDir` absolute; create it recursively when missing (a file at that path → `bad-path`).
- Each plot: absolute path, allowed image extension (`unsupported-file`), existing regular
  file (`not-found`), size ≤ 16 MiB (`too-large`). At most 40 entries (`bad-request`).
- Copy into `targetDir` keeping `name` (basename), dedupe by appending `-1`, `-2`, …;
  never overwrite an existing file.
- Reply: `{ "ok": true, "targetDir": "<abs>", "saved": [{ "source": "/abs/a.png",
  "path": "/abs/code/dir/a.png" }] }`.

### 1.5 MATLAB language

Add to the language table (order after `r`):

| id | label | candidates | script | argv |
|---|---|---|---|---|
| `matlab` | MATLAB | `matlab`, discovered absolute paths (below) | `script.m` | wrapper run (below) |

- **Discovery**: `resolveCommand` for `matlab` also scans, in order:
  `/Applications` entries matching `MATLAB_R*.app` (+ `/Applications/MATLAB_R*.app/bin/matlab`),
  then `/usr/local/MATLAB/*/bin/matlab`. Only existing executable files become candidates.
  A plain `resolveExecutable('matlab')` is still tried first.
- `skipVersionProbe: true` for matlab (a `-batch` version probe would pay a full startup on
  every `/api/env`); `version` stays `null`.
- Extension `m` → `matlab`.
- **With `capturePlots:true`** (default): write `<runDir>/dsh_plot_wrapper.m` with EXACTLY:

```matlab
% dsh-code-runner: run a MATLAB script and export its figures to PNG.
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
```

  The wrapper variables are deliberately `dsh*`-prefixed: MATLAB's `run()` warns and misbehaves when
the caller workspace defines a variable named like the target script stem (the buffer script is
`script.m`).

  argv `[matlabCommand, '-batch', 'run("<wrapperPath>")']` (double quotes inside the path are
  escaped by doubling), env adds `DSH_CODE_RUNNER_SCRIPT=<scriptPath>`,
  `DSH_CODE_RUNNER_PLOTS_DIR=<runDir>/plots`. `capturePlots:false` runs the user script
  directly: `[matlabCommand, '-batch', 'run("<scriptPath>")']`.
- Buffer mode writes `script.m`; file mode uses the on-disk `.m` file (no copy).
- MATLAB startup is slow; the existing 300 s default timeout covers it; the client shows a
  "正在启动 MATLAB…" hint while the run is in `starting`.

### 1.6 Disposal

Unchanged: run dirs (including `.m` wrappers) are removed on eviction/dispose; export folders
are **user documents and are never deleted** by the plugin. No new persistent state.

## 2. Browser half — `client.js` v3

### 2.1 Run selection

- CodeEditor tracks the textarea selection `{start, end}` in the store on
  `select`/`keyup`/`click`/`input`.
- Toolbar gains **运行选中** enabled only when the selection contains non-whitespace. Shortcut
  `⌘/Ctrl+Shift+Enter` in the editor runs the selection; plain `⌘/Ctrl+Enter` keeps running
  the whole buffer/file.
- The request is `{ mode: 'buffer', language: current, code: selectedText, cwd, capturePlots:
  true, origin: 'selection' }` (the Host ignores `origin` safely). Console header/status
  shows the localized "选中运行" marker for that run; the editor content is untouched.

### 2.2 AI explanation / annotated code

- Toolbar button **理解 / 注释代码** (sparkle glyph). Opens an inline dialog (not a browser
  alert): loading spinner → result with a scrollable summary, buttons
  `插入注释版本到编辑器` (replaces the editor content with `annotatedCode`, marks dirty when a
  file is open, keeps a one-step "撤销插入" action restoring the previous code),
  `复制解释`, `关闭`. Errors map: `llm-unavailable` → "先在 DSH 设置里配置模型/提供商";
  `llm-failed`/`llm-timeout` → message + retry button.
- Request uses the current language and code (selection if non-empty, else full buffer) and
  `fileName` when a file is open. The last successful `{summary, codeKey}` is remembered in
  the store for export.

### 2.3 Export report

- Toolbar button **导出报告** (document glyph). Enabled when there is code and/or output.
  Sends the current run state + code + plots (paths/names/source) + last AI summary to
  `POST /api/export`; on success shows a notice with the folder path, a **复制路径** button,
  and keeps `lastExport` in the store (dialog also reachable from the status area).
- Failure mapping: `bad-cwd`/`bad-path` → localized path error; `too-large` → notice.

### 2.4 Plot saving + presentation

- Plot cards gain a hover/focus action **保存** (per plot); the lightbox footer gains
  **保存图片**; the Plots tab header gains **全部保存**.
- Default save target: `dirname(currentFile)` when a file is open, else `cwd`; the notice
  names the folder. Requests go to `POST /api/save-plots` with the visible plot list.
- Presentation upgrades: page mode grid shows larger cards; cards show file name, source
  badge and human size; lightbox shows name/source/size and the save/copy controls;
  loading skeleton and empty states stay localized; object URLs are still revoked.

### 2.5 Language-adaptive interface (profiles)

A `LANGUAGE_PROFILES` map in `client.js` drives language-specific UI:

| profile | console label | hint (shown under the toolbar) | save-as ext | specialty |
|---|---|---|---|---|
| `python` | 控制台 | matplotlib 图形自动进图表页（无需 savefig） | `.py` | — |
| `r` | 控制台 | base/ggplot 图形自动捕获（顶层可见结果自动打印） | `.R` | — |
| `matlab` | 命令窗口 | figure 自动导出到图表页；MATLAB 启动较慢，请稍候 | `.m` | run 在 starting 阶段显示 "正在启动 MATLAB…" |
| `node` | 输出 | console.log 输出实时显示 | `.mjs` | — |
| `bash`/`zsh` | 输出 | 脚本以 shell 执行 | `.sh` | — |
| others | 输出 | 通用运行提示 | `.txt` | — |

The hint strip updates whenever the language changes; save-as pre-fills the profile
extension; the console panel title and status-bar language label use the profile display
name. The active language is still chosen by the existing select (only `available`
languages are listed, so MATLAB appears automatically when `matlab` is detected).

### 2.6 Locale additions (zh + en, identical key sets)

```
selection.run, selection.hint, selection.marker
explain.open, explain.title, explain.loading, explain.summary, explain.insert,
explain.inserted, explain.undoInsert, explain.copy, explain.copied, explain.close,
explain.retry, explain.llmUnavailable, explain.failed, explain.truncated
export.button, export.running, export.done, export.folder, export.copyPath, export.copied,
export.failed, export.empty
plots.save, plots.saveAll, plots.saved, plots.saveFailed, plots.target, plots.size
language.python, language.r, language.matlab, language.node, language.bash,
language.zsh, language.ruby, language.perl, language.julia, language.deno, language.bun,
language.php
language.hint.python, language.hint.r, language.hint.matlab, language.hint.node,
language.hint.shell, language.hint.generic
language.startingMatlab, language.consoleMatlab, language.consoleDefault
```

## 3. Definition of done

- `node --check index.js && node --check client.js` (and every test file).
- `node tests/host-smoke.mjs`, `node tests/verify-host.mjs`, `node tests/verify-static.mjs`,
  `node tests/client-smoke.mjs` green; `node tests/verify-live.mjs` green against the running
  Host, now also covering: matlab detection+R run + figure capture **when this machine's
  MATLAB can start headless** (if the environment refuses, the live case must SKIP with the
  exact stderr and the feature still works on licensed machines), explain via the real LLM
  (assert `ok`, non-empty summary, annotatedCode when parseable; SKIP with reason when the
  provider is unavailable), export folder creation + report.md/html/run.json/plots content,
  save-plots copy + dedupe, and R selection = buffer run of a partial script.
- Host smoke must stub `llm` + `agentDefaultModel` (deterministic chunks, a JSON reply, a
  failure, a timeout) so explain is covered without network.
- The panel keeps every v2 behaviour (right sidebar tab, files, plots, diagnostics).
- Write scopes: host-core → `index.js`, `tests/host-smoke.mjs`; client-ui → `client.js`,
  `tests/client-smoke.mjs`; verifier → `tests/verify-*.mjs`; Lead owns contract, README,
  package.json, locale/blog files, install/reload and live acceptance.
