/**
 * dsh-code-runner — browser half (single classic-JS module for the DSH Web loader).
 *
 * v2 surfaces, one shared workbench store:
 *   · a right-sidebar tab (kind `code-runner`) opened from a conversation-header toggle,
 *     so the workbench sits beside the conversation;
 *   · the v1 left-sidebar row + keyed `main` page as the big-screen "workbench" mode;
 *   · Files browsing/editing with save + conflict detection, and a Plots gallery fed by
 *     the Host's `/api/artifacts` + authenticated `/api/blob` reads.
 *
 * No build step: no TypeScript, no JSX, no module statements. React is the only
 * module-table entry this file resolves. The wire format is CONTRACT-V2.md §1; the
 * browser behaviour is §2 of the same contract.
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-runner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── Fixed identifiers (CONTRACT-V2 §0) ─────────────────────────────────
    /** Reported in the diagnostics boot event and the README test table. */
    const CLIENT_VERSION = '0.7.0'
    const NS = 'dsh-code-runner'
    const PANEL_ID = 'code-runner'
    const PANEL_ORDER = 30
    const RIGHT_TAB_ID = 'dsh-code-runner'
    const RIGHT_TAB_KIND = 'code-runner'
    const HEADER_TOGGLE_ID = 'code-runner-toggle'

    const POLL_MS = 250
    const ARTIFACT_POLL_MS = 1200
    const POLL_BACKOFF_MAX_MS = 2000
    const DETAIL_MAX = 280
    const DEFAULT_SPLIT_RATIO = 0.42
    const MIN_SPLIT_RATIO = 0.18
    const MAX_SPLIT_RATIO = 0.72

    const STORAGE_CWD = 'dsh-code-runner.cwd'
    const STORAGE_LANGUAGE = 'dsh-code-runner.language'
    const STORAGE_SPLIT = 'dsh-code-runner.splitRatio'
    const STORAGE_BOTTOM_TAB = 'dsh-code-runner.bottomTab'
    const STORAGE_DRAFT_PREFIX = 'dsh-code-runner.draft.'

    /** Document-relative API paths: no leading slash, so sub-path deployments work. */
    const API = {
      token: 'dsh-code-runner/api/token',
      env: 'dsh-code-runner/api/env',
      run: 'dsh-code-runner/api/run',
      output: 'dsh-code-runner/api/output',
      stop: 'dsh-code-runner/api/stop',
      files: 'dsh-code-runner/api/files',
      file: 'dsh-code-runner/api/file',
      blob: 'dsh-code-runner/api/blob',
      artifacts: 'dsh-code-runner/api/artifacts',
      diag: 'dsh-code-runner/api/diag',
      packs: 'dsh-code-runner/api/packs',
      packsRescan: 'dsh-code-runner/api/packs/rescan',
      explain: 'dsh-code-runner/api/explain',
      export: 'dsh-code-runner/api/export',
      savePlots: 'dsh-code-runner/api/save-plots',
      datasetPreview: 'dsh-code-runner/api/dataset/preview',
    }

    // ── Browser diagnostics (CONTRACT-V2.md §1.11) ──────────────────────────
    // Fire-and-forget events for the Host's in-memory ring buffer: they let the
    // operator (and the agent) prove from the shell what the real page did —
    // plugin boot, right-tab registration, surface mount/crash, runs, plots.
    // They never affect the UI: no throws, no awaits by callers.
    const DIAG_MAX_EVENTS = 24
    let diagSent = 0

    function reportDiag(name, detail) {
      try {
        if (diagSent >= DIAG_MAX_EVENTS) return
        if (typeof name !== 'string' || name === '') return
        diagSent += 1
        const event = { name: name.slice(0, 64), at: Date.now() }
        if (detail && typeof detail === 'object') event.detail = detail
        const payload = JSON.stringify({ event: event })
        // A reloaded Host mints a new token, so a page that was loaded before the
        // reload still holds a stale injected token. Retry once through a forced
        // bootstrap before dropping a diagnostic event.
        const post = function postDiagnostic(token) {
          return fetch(API.diag, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-dsh-code-runner-token': token,
            },
            credentials: 'same-origin',
            cache: 'no-store',
            body: payload,
          }).then(function markDiagnosticResponse(response) {
            const stale = Boolean(response && response.status === 401)
            const consume = response && typeof response.text === 'function' ? response.text() : null
            return Promise.resolve(consume).then(function diagnosticConsumed() { return stale })
          })
        }
        resolveToken(false).then(post).then(function maybeRetryDiagnostic(stale) {
          if (stale !== true) return null
          return resolveToken(true).then(post).then(function diagnosticRetried() { return null })
        }).then(function diagnosticDone() { return null }, function ignoreDiagnosticFailure() { return null })
      } catch (error) {
        /* diagnostics must never break the UI */
      }
    }

    /** Extension → language id map (CONTRACT-V2 §1.3); `ts` picks the first available. */
    const EXT_LANGUAGE = {
      py: 'python', pyw: 'python', r: 'r', mjs: 'node', cjs: 'node', js: 'node',
      sh: 'bash', zsh: 'zsh', rb: 'ruby', pl: 'perl', jl: 'julia', php: 'php',
      ts: 'ts', m: 'matlab',
    }

    /** Language id → default file extension for the "Save as…" dialog (v3 §2.5). */
    const LANGUAGE_EXTENSION = {
      python: 'py', r: 'R', matlab: 'm', node: 'mjs', bash: 'sh', zsh: 'sh',
      ruby: 'rb', perl: 'pl', julia: 'jl', deno: 'ts', bun: 'ts', php: 'php',
    }

    // ── v3 language profiles (CONTRACT-V3 §2.5) ────────────────────────────
    // Profiles drive the console label, the hint strip under the toolbar and the
    // save-as default extension per language; `language.<id>` keys drive the
    // status-bar display name for every language the Host can report.
    const LANGUAGE_PROFILES = {
      python: { consoleKey: 'language.consoleDefault', hintKey: 'language.hint.python', extension: 'py' },
      r: { consoleKey: 'language.consoleDefault', hintKey: 'language.hint.r', extension: 'R' },
      matlab: { consoleKey: 'language.consoleMatlab', hintKey: 'language.hint.matlab', extension: 'm' },
      node: { consoleKey: 'output.title', hintKey: 'language.hint.node', extension: 'mjs' },
      bash: { consoleKey: 'output.title', hintKey: 'language.hint.shell', extension: 'sh' },
      zsh: { consoleKey: 'output.title', hintKey: 'language.hint.shell', extension: 'sh' },
    }
    const LANGUAGE_PROFILE_DEFAULT = {
      consoleKey: 'output.title',
      hintKey: 'language.hint.generic',
      extension: 'txt',
    }
    const LANGUAGE_DISPLAY_KEYS = {
      python: 'language.python', r: 'language.r', matlab: 'language.matlab',
      node: 'language.node', bash: 'language.bash', zsh: 'language.zsh',
      ruby: 'language.ruby', perl: 'language.perl', julia: 'language.julia',
      deno: 'language.deno', bun: 'language.bun', php: 'language.php',
    }

    function profileFor(languageId) {
      const id = typeof languageId === 'string' ? languageId : ''
      const profile = Object.prototype.hasOwnProperty.call(LANGUAGE_PROFILES, id)
        ? LANGUAGE_PROFILES[id]
        : LANGUAGE_PROFILE_DEFAULT
      return {
        consoleKey: profile.consoleKey,
        hintKey: profile.hintKey,
        extension: profile.extension,
        displayKey: Object.prototype.hasOwnProperty.call(LANGUAGE_DISPLAY_KEYS, id) ? LANGUAGE_DISPLAY_KEYS[id] : null,
      }
    }

    /** Save-as extension: the Host's declared extension list first, then the profile. */
    function saveAsExtension(language, languageId) {
      if (language && Array.isArray(language.extensions)) {
        for (let index = 0; index < language.extensions.length; index += 1) {
          const extension = language.extensions[index]
          if (typeof extension === 'string' && extension !== '') return extension.replace(/^\./, '')
        }
      }
      return profileFor(language ? language.id : languageId).extension
    }

    /** Extensions previewed through the Plots lightbox / artifact cards. */
    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']
    const IS_IMAGE_EXT_SET = { png: true, jpg: true, jpeg: true, gif: true, webp: true, svg: true, bmp: true, avif: true }

    // ── Locale dictionaries: v1 keys (CONTRACT-V1 §2.4) + v2 keys (§2.6) ───
    const zh = {
      'panel.label': '代码运行器',
      'panel.title': '代码运行器',
      'panel.subtitle': '在本机直接运行脚本，浏览文件，实时查看输出与图表。',
      'panel.rightbarOpen': '在右侧栏打开代码运行器',
      'panel.rightbarClose': '收起右侧栏代码运行器',
      'status.ready': '宿主已就绪',
      'status.offline': '宿主不可用',
      'toolbar.language': '语言',
      'toolbar.cwd': '工作目录',
      'toolbar.pick': '选择…',
      'toolbar.rescan': '重新扫描',
      'toolbar.run': '运行',
      'toolbar.stop': '停止',
      'toolbar.clear': '清空输出',
      'toolbar.copy': '复制输出',
      'toolbar.running': '运行中',
      'toolbar.save': '保存',
      'toolbar.saveAs': '另存为…',
      'toolbar.file': '文件',
      'toolbar.untitled': '未命名',
      'toolbar.dirty': '未保存的修改',
      'toolbar.runFile': '运行文件',
      'toolbar.runBuffer': '运行代码',
      'toolbar.newFile': '新建',
      'hint.shortcut': '⌘/Ctrl + Enter 运行 · ⌘/Ctrl + S 保存',
      'editor.placeholder': '在这里写脚本…',
      'editor.saving': '正在保存…',
      'editor.saved': '已保存',
      'editor.dirty': '未保存的修改',
      'editor.unsavedTitle': '放弃未保存的修改？',
      'editor.unsavedBody': '当前文件有未保存的修改，继续会丢失它们。',
      'editor.discard': '放弃修改',
      'editor.cancel': '取消',
      'editor.conflictTitle': '文件已被外部修改',
      'editor.conflictBody': '磁盘上的文件比编辑器里的新，覆盖会丢失外部修改。',
      'editor.overwrite': '仍然覆盖',
      'editor.saveFailed': '保存失败：{detail}',
      'editor.savedAndRan': '已保存并运行',
      'editor.openFileTitle': '打开另一个文件',
      'editor.saveAsTitle': '另存为',
      'editor.saveAsPlaceholder': '文件名，例如 script.py',
      'editor.saveAsConfirm': '保存',
      'tabs.console': '控制台',
      'tabs.plots': '图表',
      'tabs.files': '文件',
      'output.title': '输出',
      'output.idle': '运行脚本后，输出会显示在这里。',
      'output.running': '正在运行，输出会实时追加。',
      'output.empty': '（暂无输出）',
      'output.truncated': '输出过长，较早的内容已被截断',
      'files.title': '文件',
      'files.refresh': '刷新文件列表',
      'files.up': '上一级',
      'files.empty': '这个目录是空的',
      'files.loading': '正在读取目录…',
      'files.root': '根目录',
      'files.openFailed': '打开文件失败：{detail}',
      'files.binary': '这是一个二进制文件，无法在编辑器中打开。',
      'files.tooLarge': '文件太大，只显示了前一部分内容。',
      'files.dir': '目录',
      'plots.title': '图表',
      'plots.refresh': '刷新图表',
      'plots.empty': '这次运行还没有图表。',
      'plots.loading': '正在加载图表…',
      'plots.count': '{count} 个图表',
      'plots.sourceRun': '运行产物',
      'plots.sourceCwd': '目录',
      'plots.close': '关闭',
      'plots.prev': '上一张',
      'plots.next': '下一张',
      'plots.copyPath': '复制路径',
      'plots.copied': '已复制路径',
      'plots.unsupported': '无法预览的文件',
      'status.exit': '退出码',
      'status.signal': '信号',
      'status.timeout': '超时',
      'status.stopped': '已停止',
      'status.duration': '耗时',
      'status.modeFile': '文件模式',
      'status.modeBuffer': '缓冲区模式',
      'status.line': '行',
      'status.col': '列',
      'env.scanning': '正在检测可用的解释器…',
      'env.none': '没有检测到可用的解释器',
      'error.noToken': '页面还没拿到宿主令牌，请刷新页面后重试。',
      'error.host': '连接不上宿主服务，请确认 DSH 仍在运行，然后重试。',
      'error.unauthorized': '登录状态已失效，请刷新页面后重试。',
      'error.forbidden': '当前环境未通过同源校验：桌面外壳或反向代理可能没有传递浏览器标记。',
      'error.setup': '无法访问宿主的运行接口（可能没有挂载）：{detail}',
      'error.unknownRun': '这次运行已经不存在了，请重新运行。',
      'error.languageUnavailable': '这个语言在这台机器上不可用：{detail}',
      'error.badCwd': '工作目录无效：{detail}',
      'error.emptyCode': '先写一点代码再运行。',
      'error.crashed': '面板出错了',
      'error.crashedHint': '这个面板已停止渲染，请刷新页面重新加载。',
      'error.copyFailed': '复制失败，请手动选中内容复制。',
      'error.badPath': '路径无效：{detail}',
      'error.fileNotFound': '文件不存在：{detail}',
      'error.conflict': '文件冲突：{detail}',
      'error.fileTooLarge': '文件过大：{detail}',
      'error.unsupportedFile': '不支持的文件类型：{detail}',
      'selection.run': '运行选中',
      'selection.hint': '选中代码后按 ⌘/Ctrl + Shift + Enter 只运行选中的部分',
      'selection.marker': '选中运行',
      'explain.open': '理解 / 注释代码',
      'explain.title': 'AI 代码解释',
      'explain.loading': '正在请求模型…',
      'explain.summary': '解释',
      'explain.insert': '插入注释版本到编辑器',
      'explain.inserted': '注释版本已插入编辑器',
      'explain.undoInsert': '撤销插入',
      'explain.copy': '复制解释',
      'explain.copied': '解释已复制',
      'explain.close': '关闭',
      'explain.retry': '重试',
      'explain.llmUnavailable': '还没有可用的模型：请先在 DSH 设置里配置模型/提供商，然后重试。',
      'explain.failed': 'AI 请求失败：{detail}',
      'explain.truncated': '输入过长，已截断后发送',
      'export.button': '导出报告',
      'export.running': '正在生成报告…',
      'export.done': '报告已生成：{folder}',
      'export.folder': '报告目录',
      'export.copyPath': '复制路径',
      'export.copied': '路径已复制',
      'export.failed': '导出失败：{detail}',
      'export.empty': '还没有可导出的代码或输出',
      'export.dialogTitle': '导出实验报告',
      'export.format': '文件格式',
      'export.formatDocx': 'Word 文档（.docx）',
      'export.formatMd': 'Markdown（.md）',
      'export.formatHtml': 'HTML（.html，图表内嵌）',
      'export.formatAll': '全部格式（.docx + .md + .html）',
      'export.include': '插入内容',
      'export.includeCode': '源代码',
      'export.includeOutput': '输出结果',
      'export.includePlots': '统计图',
      'export.includeSummary': 'AI 解读',
      'export.name': '文件名',
      'export.start': '开始导出',
      'export.cancel': '取消',
      'export.noPlots': '本次运行还没有图表',
      'export.plotPlacement': '图表位置',
      'export.plotPlacementSection': '独立章节（统计图：在最后）',
      'export.plotPlacementUnderCode': '跟随源代码（放在源代码下方）',
      'export.plotPlacementSectionHint': '顺序：源代码 → 输出结果 → 统计图',
      'export.plotPlacementUnderCodeHint': '顺序：源代码 → 统计图 → 输出结果',
      'dataset.open': '数据集',
      'dataset.dialogTitle': '导入数据集（仿 RStudio）',
      'dataset.path': '数据文件',
      'dataset.pathPlaceholder': '输入 .xlsx / .csv 文件绝对路径',
      'dataset.read': '读取',
      'dataset.browseDir': '浏览目录',
      'dataset.up': '上级',
      'dataset.refresh': '刷新',
      'dataset.noDataFiles': '当前目录没有数据文件',
      'dataset.loading': '正在读取数据集…',
      'dataset.failed': '读取失败：{detail}',
      'dataset.sheet': '工作表',
      'dataset.header': '首行为列名',
      'dataset.delimiter': '分隔符',
      'dataset.delimiterAuto': '自动',
      'dataset.delimiterTab': '制表符',
      'dataset.summary': '共 {rows} 行 × {cols} 列',
      'dataset.truncated': '仅预览前 {rows} 行',
      'dataset.import': '导入代码（{language}）',
      'dataset.insert': '插入到编辑器',
      'dataset.inserted': '导入代码已插入编辑器',
      'dataset.copy': '复制代码',
      'dataset.copied': '代码已复制',
      'dataset.unsupported': '当前语言暂不支持自动生成导入代码',
      'dataset.empty': '选择下方数据文件或输入路径以查看预览',
      'dataset.close': '关闭',
      'dataset.kindXlsx': 'Excel 工作簿',
      'dataset.kindText': '文本数据',
      'packs.open': '语言与功能',
      'packs.title': '语言与功能（按需安装）',
      'packs.intro': '检测到本机已安装的语言会自动启用并安装其图形捕获配置；未安装的语言不会加入，也可以按需一键启用或停用。',
      'packs.loading': '正在检测本机语言…',
      'packs.empty': '没有可管理的语言。',
      'packs.detected': '已检测',
      'packs.notInstalled': '未安装',
      'packs.enable': '一键启用',
      'packs.disable': '停用',
      'packs.unavailable': '未检测到',
      'packs.autoCapture': '自动捕获图形',
      'packs.noCapture': '无图形捕获',
      'packs.captureMissing': '图形捕获缺少依赖',
      'packs.rescan': '重新检测',
      'packs.close': '关闭',
      'plots.save': '保存',
      'plots.saveAll': '全部保存',
      'plots.saved': '已保存 {count} 个图表到 {dir}',
      'plots.saveFailed': '保存图表失败：{detail}',
      'plots.target': '保存到',
      'plots.size': '大小',
      'language.python': 'Python',
      'language.r': 'R',
      'language.matlab': 'MATLAB',
      'language.node': 'Node.js',
      'language.bash': 'Bash',
      'language.zsh': 'Zsh',
      'language.ruby': 'Ruby',
      'language.perl': 'Perl',
      'language.julia': 'Julia',
      'language.deno': 'Deno',
      'language.bun': 'Bun',
      'language.php': 'PHP',
      'language.hint.python': 'matplotlib 图形自动进图表页（无需 savefig）',
      'language.hint.r': 'base/ggplot 图形自动捕获（顶层可见结果自动打印）',
      'language.hint.matlab': 'figure 自动导出到图表页；MATLAB 启动较慢，请稍候',
      'language.hint.node': 'console.log 输出实时显示',
      'language.hint.shell': '脚本以 shell 执行',
      'language.hint.generic': '通用运行提示',
      'language.startingMatlab': '正在启动 MATLAB…',
      'language.consoleMatlab': '命令窗口',
      'language.consoleDefault': '控制台',
      'error.saveFailed': '保存失败：{detail}',
    }

    const en = {
      'panel.label': 'Code Runner',
      'panel.title': 'Code Runner',
      'panel.subtitle': 'Run scripts, browse files, and watch live output and plots beside the conversation.',
      'panel.rightbarOpen': 'Open Code Runner in the right sidebar',
      'panel.rightbarClose': 'Collapse the Code Runner right sidebar',
      'status.ready': 'Host ready',
      'status.offline': 'Host unavailable',
      'toolbar.language': 'Language',
      'toolbar.cwd': 'Working directory',
      'toolbar.pick': 'Choose…',
      'toolbar.rescan': 'Rescan',
      'toolbar.run': 'Run',
      'toolbar.stop': 'Stop',
      'toolbar.clear': 'Clear output',
      'toolbar.copy': 'Copy output',
      'toolbar.running': 'Running',
      'toolbar.save': 'Save',
      'toolbar.saveAs': 'Save as…',
      'toolbar.file': 'File',
      'toolbar.untitled': 'Untitled',
      'toolbar.dirty': 'Unsaved changes',
      'toolbar.runFile': 'Run file',
      'toolbar.runBuffer': 'Run code',
      'toolbar.newFile': 'New',
      'hint.shortcut': '⌘/Ctrl + Enter to run · ⌘/Ctrl + S to save',
      'editor.placeholder': 'Write your script here…',
      'editor.saving': 'Saving…',
      'editor.saved': 'Saved',
      'editor.dirty': 'Unsaved changes',
      'editor.unsavedTitle': 'Discard unsaved changes?',
      'editor.unsavedBody': 'This file has unsaved changes; continuing loses them.',
      'editor.discard': 'Discard',
      'editor.cancel': 'Cancel',
      'editor.conflictTitle': 'The file changed on disk',
      'editor.conflictBody': 'The file on disk is newer than the editor. Overwriting loses those external changes.',
      'editor.overwrite': 'Overwrite anyway',
      'editor.saveFailed': 'Save failed: {detail}',
      'editor.savedAndRan': 'Saved and ran',
      'editor.openFileTitle': 'Open another file',
      'editor.saveAsTitle': 'Save as',
      'editor.saveAsPlaceholder': 'File name, e.g. script.py',
      'editor.saveAsConfirm': 'Save',
      'tabs.console': 'Console',
      'tabs.plots': 'Plots',
      'tabs.files': 'Files',
      'output.title': 'Output',
      'output.idle': 'Run a script and its output will appear here.',
      'output.running': 'Running — output appears as it streams in.',
      'output.empty': '(no output)',
      'output.truncated': 'Output too long — earlier bytes were truncated',
      'files.title': 'Files',
      'files.refresh': 'Refresh the file list',
      'files.up': 'Up one level',
      'files.empty': 'This directory is empty',
      'files.loading': 'Reading directory…',
      'files.root': 'Root',
      'files.openFailed': 'Could not open the file: {detail}',
      'files.binary': 'This is a binary file; the editor cannot open it.',
      'files.tooLarge': 'The file is too large — showing the beginning only.',
      'files.dir': 'Directory',
      'plots.title': 'Plots',
      'plots.refresh': 'Refresh plots',
      'plots.empty': 'This run produced no plots yet.',
      'plots.loading': 'Loading plots…',
      'plots.count': '{count} plots',
      'plots.sourceRun': 'Run',
      'plots.sourceCwd': 'Directory',
      'plots.close': 'Close',
      'plots.prev': 'Previous',
      'plots.next': 'Next',
      'plots.copyPath': 'Copy path',
      'plots.copied': 'Path copied',
      'plots.unsupported': 'Preview unavailable',
      'status.exit': 'Exit code',
      'status.signal': 'Signal',
      'status.timeout': 'Timed out',
      'status.stopped': 'Stopped',
      'status.duration': 'Duration',
      'status.modeFile': 'File mode',
      'status.modeBuffer': 'Buffer mode',
      'status.line': 'Line',
      'status.col': 'Col',
      'env.scanning': 'Detecting available interpreters…',
      'env.none': 'No interpreters found on this machine',
      'error.noToken': 'This page has not received the host token yet — refresh the page and try again.',
      'error.host': 'Cannot reach the host service. Make sure DSH is still running, then retry.',
      'error.unauthorized': 'Your session has expired — refresh the page and try again.',
      'error.forbidden': 'This environment failed the same-origin check: the desktop shell or a reverse proxy may not be forwarding browser markers.',
      'error.setup': 'Cannot reach the host run API (it may not be mounted): {detail}',
      'error.unknownRun': 'That run no longer exists — run the script again.',
      'error.languageUnavailable': 'That language is unavailable on this machine: {detail}',
      'error.badCwd': 'Invalid working directory: {detail}',
      'error.emptyCode': 'Write some code before running.',
      'error.crashed': 'This panel crashed',
      'error.crashedHint': 'The panel stopped rendering — refresh the page to load it again.',
      'error.copyFailed': 'Copy failed — select the content and copy it manually.',
      'error.badPath': 'Invalid path: {detail}',
      'error.fileNotFound': 'File not found: {detail}',
      'error.conflict': 'File conflict: {detail}',
      'error.fileTooLarge': 'File too large: {detail}',
      'error.unsupportedFile': 'Unsupported file type: {detail}',
      'selection.run': 'Run selection',
      'selection.hint': 'Select code, then ⌘/Ctrl + Shift + Enter to run just that part',
      'selection.marker': 'Selection run',
      'explain.open': 'Explain / annotate',
      'explain.title': 'AI code explanation',
      'explain.loading': 'Asking the model…',
      'explain.summary': 'Explanation',
      'explain.insert': 'Insert annotated code',
      'explain.inserted': 'Annotated code inserted',
      'explain.undoInsert': 'Undo insert',
      'explain.copy': 'Copy explanation',
      'explain.copied': 'Explanation copied',
      'explain.close': 'Close',
      'explain.retry': 'Retry',
      'explain.llmUnavailable': 'No model is available yet: configure a model/provider in DSH Settings first, then retry.',
      'explain.failed': 'The AI request failed: {detail}',
      'explain.truncated': 'The input was truncated before sending',
      'export.button': 'Export report',
      'export.running': 'Writing the report…',
      'export.done': 'Report written to {folder}',
      'export.folder': 'Report folder',
      'export.copyPath': 'Copy path',
      'export.copied': 'Path copied',
      'export.failed': 'Export failed: {detail}',
      'export.empty': 'Nothing to export yet',
      'export.dialogTitle': 'Export experiment report',
      'export.format': 'File format',
      'export.formatDocx': 'Word document (.docx)',
      'export.formatMd': 'Markdown (.md)',
      'export.formatHtml': 'HTML (.html, plots embedded)',
      'export.formatAll': 'All formats (.docx + .md + .html)',
      'export.include': 'Include',
      'export.includeCode': 'Source code',
      'export.includeOutput': 'Output',
      'export.includePlots': 'Charts',
      'export.includeSummary': 'AI summary',
      'export.name': 'File name',
      'export.start': 'Export',
      'export.cancel': 'Cancel',
      'export.noPlots': 'This run has no charts yet',
      'export.plotPlacement': 'Chart placement',
      'export.plotPlacementSection': 'Separate section (统计图 at the end)',
      'export.plotPlacementUnderCode': 'Follow the source code (charts under the code)',
      'export.plotPlacementSectionHint': 'Order: source → output → charts',
      'export.plotPlacementUnderCodeHint': 'Order: source → charts → output',
      'dataset.open': 'Dataset',
      'dataset.dialogTitle': 'Import dataset (RStudio-style)',
      'dataset.path': 'Data file',
      'dataset.pathPlaceholder': 'Absolute path to an .xlsx / .csv file',
      'dataset.read': 'Read',
      'dataset.browseDir': 'Browse',
      'dataset.up': 'Up',
      'dataset.refresh': 'Refresh',
      'dataset.noDataFiles': 'No data files in this directory',
      'dataset.loading': 'Reading the dataset…',
      'dataset.failed': 'Could not read the dataset: {detail}',
      'dataset.sheet': 'Sheet',
      'dataset.header': 'First row as names',
      'dataset.delimiter': 'Delimiter',
      'dataset.delimiterAuto': 'Auto',
      'dataset.delimiterTab': 'Tab',
      'dataset.summary': '{rows} rows × {cols} columns',
      'dataset.truncated': 'Previewing the first {rows} rows',
      'dataset.import': 'Import code ({language})',
      'dataset.insert': 'Insert into editor',
      'dataset.inserted': 'Import code inserted into the editor',
      'dataset.copy': 'Copy code',
      'dataset.copied': 'Code copied',
      'dataset.unsupported': 'No import snippet for this language yet',
      'dataset.empty': 'Pick a data file below or type a path to preview it',
      'dataset.close': 'Close',
      'dataset.kindXlsx': 'Excel workbook',
      'dataset.kindText': 'Text data',
      'packs.open': 'Languages',
      'packs.title': 'Languages & features (on demand)',
      'packs.intro': 'Detected languages are enabled automatically with their plot-capture config installed; missing ones are not added, and you can enable/disable any pack here.',
      'packs.loading': 'Detecting local languages…',
      'packs.empty': 'No languages to manage.',
      'packs.detected': 'Detected',
      'packs.notInstalled': 'Not installed',
      'packs.enable': 'Enable',
      'packs.disable': 'Disable',
      'packs.unavailable': 'Unavailable',
      'packs.autoCapture': 'Auto plot capture',
      'packs.noCapture': 'No plot capture',
      'packs.captureMissing': 'Capture dependency missing',
      'packs.rescan': 'Rescan',
      'packs.close': 'Close',
      'plots.save': 'Save',
      'plots.saveAll': 'Save all',
      'plots.saved': 'Saved {count} plot(s) to {dir}',
      'plots.saveFailed': 'Could not save plots: {detail}',
      'plots.target': 'Save to',
      'plots.size': 'Size',
      'language.python': 'Python',
      'language.r': 'R',
      'language.matlab': 'MATLAB',
      'language.node': 'Node.js',
      'language.bash': 'Bash',
      'language.zsh': 'Zsh',
      'language.ruby': 'Ruby',
      'language.perl': 'Perl',
      'language.julia': 'Julia',
      'language.deno': 'Deno',
      'language.bun': 'Bun',
      'language.php': 'PHP',
      'language.hint.python': 'matplotlib figures go to Plots automatically (no savefig needed)',
      'language.hint.r': 'Base/ggplot figures are captured automatically (top-level visible values print)',
      'language.hint.matlab': 'Figures are exported to Plots; MATLAB starts slowly — please wait',
      'language.hint.node': 'console.log output streams live',
      'language.hint.shell': 'The script runs as a shell script',
      'language.hint.generic': 'Generic run hints',
      'language.startingMatlab': 'Starting MATLAB…',
      'language.consoleMatlab': 'Command Window',
      'language.consoleDefault': 'Console',
      'error.saveFailed': 'Save failed: {detail}',
    }

    // ── Locale plumbing ────────────────────────────────────────────────────
    /** Locale service captured by apply(); null until then. */
    let localeService = null
    /** Bound translate function for this namespace (reads the active locale). */
    let boundTranslate = null
    /** Client root context captured by apply(); surface components read optional services. */
    let rootContext = null

    function wireLocale(service, boundCandidate) {
      localeService = service || null
      let bound = typeof boundCandidate === 'function' ? boundCandidate : null
      if (bound === null && localeService && typeof localeService.bind === 'function') {
        try {
          bound = localeService.bind(NS)
        } catch (error) {
          bound = null
        }
      }
      boundTranslate = typeof bound === 'function' ? bound : null
    }

    function fallbackDictionary() {
      let language = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          language = String(document.documentElement.lang || '')
        }
      } catch (error) {
        language = ''
      }
      return language.toLowerCase().indexOf('en') === 0 ? en : zh
    }

    /** Translate a key, interpolating `{name}` placeholders from `params`. */
    function t(key, params) {
      let text = null
      if (boundTranslate !== null) {
        try {
          text = boundTranslate(key)
        } catch (error) {
          text = null
        }
      }
      if (typeof text !== 'string' || text === '') {
        const dictionary = fallbackDictionary()
        text = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
      }
      if (params && typeof params === 'object') {
        const names = Object.keys(params)
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index]
          text = text.split('{' + name + '}').join(String(params[name]))
        }
      }
      return text
    }

    function useLocaleRefresh() {
      const pair = React.useState(0)
      const setTick = pair[1]
      React.useEffect(function subscribeLocale() {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        let active = true
        let off = null
        try {
          off = localeService.subscribe(function onLocaleChange() {
            if (active) setTick(function bump(value) { return value + 1 })
          })
        } catch (error) {
          off = null
        }
        return function unsubscribeLocale() {
          active = false
          if (typeof off === 'function') {
            try { off() } catch (error) { /* ignore */ }
          }
        }
      }, [])
    }

    // ── Browser storage helpers (never throw) ──────────────────────────────
    function storageGet(key) {
      try {
        const value = window.localStorage.getItem(key)
        return typeof value === 'string' ? value : null
      } catch (error) {
        return null
      }
    }

    function storageSet(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch (error) {
        /* ignore storage failures */
      }
    }

    // ── Small utilities ────────────────────────────────────────────────────
    function errorMessage(error) {
      if (error && typeof error.message === 'string') return error.message
      return String(error)
    }

    function makeError(code, message, extra) {
      const error = new Error(typeof message === 'string' && message !== '' ? message : code)
      error.code = code
      if (extra && typeof extra === 'object') {
        if (typeof extra.status === 'number') error.status = extra.status
        if (extra.bootstrap === true) error.bootstrap = true
      }
      return error
    }

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'aborted')
    }

    function normalizeError(raw) {
      if (raw && typeof raw === 'object' && typeof raw.code === 'string') return raw
      if (isAbortError(raw)) return makeError('aborted', 'aborted')
      return makeError('network', errorMessage(raw))
    }

    function clampDetail(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return ''
      return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + '…' : text
    }

    function clampRatio(value) {
      if (typeof value !== 'number' || !isFinite(value)) return DEFAULT_SPLIT_RATIO
      return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))
    }

    function formatDuration(milliseconds) {
      if (typeof milliseconds !== 'number' || !isFinite(milliseconds) || milliseconds < 0) return ''
      if (milliseconds < 1000) return Math.round(milliseconds) + ' ms'
      if (milliseconds < 60000) return (milliseconds / 1000).toFixed(2) + ' s'
      const totalSeconds = Math.round(milliseconds / 1000)
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      return minutes + ' min ' + (seconds < 10 ? '0' + seconds : String(seconds)) + ' s'
    }

    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return Math.round(bytes) + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function basename(path) {
      const text = String(path || '')
      if (text === '') return ''
      const normalized = text.replace(/[\\/]+$/, '')
      const parts = normalized.split(/[\\/]/)
      return parts.length > 0 ? parts[parts.length - 1] : normalized
    }

    function dirname(path) {
      const text = String(path || '')
      if (text === '') return ''
      const normalized = text.replace(/[\\/]+$/, '')
      const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
      if (slash < 0) return '.'
      if (slash === 0) return normalized.charAt(0)
      return normalized.slice(0, slash)
    }

    function joinPath(directory, name) {
      const dir = String(directory || '')
      const leaf = String(name || '').replace(/^[\\/]+/, '')
      if (dir === '') return leaf
      const last = dir.charAt(dir.length - 1)
      if (last === '/' || last === '\\') return dir + leaf
      const separator = dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/'
      return dir + separator + leaf
    }

    function extensionOf(path) {
      const name = basename(path)
      const dot = name.lastIndexOf('.')
      if (dot <= 0 || dot === name.length - 1) return ''
      return name.slice(dot + 1).toLowerCase()
    }

    function isDatasetFileName(name) {
      const extension = extensionOf(name)
      return extension === 'xlsx' || extension === 'csv' || extension === 'tsv' || extension === 'txt'
    }

    function languageForExtension(extension, availableIds) {
      const language = EXT_LANGUAGE[String(extension || '').toLowerCase()]
      if (language === undefined) return null
      if (language !== 'ts') return language
      const preferred = ['deno', 'bun', 'node']
      for (let index = 0; index < preferred.length; index += 1) {
        if (availableIds.indexOf(preferred[index]) >= 0) return preferred[index]
      }
      return 'node'
    }

    function defaultFileNameForLanguage(languageId, language) {
      const extension = saveAsExtension(language || null, languageId) || LANGUAGE_EXTENSION[languageId] || 'txt'
      return 'script.' + extension
    }

    function availableLanguagesOf(environment) {
      if (!environment || !Array.isArray(environment.languages)) return []
      const result = []
      for (let index = 0; index < environment.languages.length; index += 1) {
        const language = environment.languages[index]
        if (language && language.available === true && typeof language.id === 'string' && language.id !== '') {
          result.push(language)
        }
      }
      return result
    }

    function languageOptionLabel(language) {
      const label = language && typeof language.label === 'string' && language.label !== '' ? language.label : String(language && language.id)
      const version = language && typeof language.version === 'string' ? language.version.trim() : ''
      if (version === '') return label
      if (version.toLowerCase().indexOf(label.toLowerCase()) === 0) return version
      return label + ' · ' + version
    }

    function findLanguage(languages, languageId) {
      for (let index = 0; index < languages.length; index += 1) {
        if (languages[index].id === languageId) return languages[index]
      }
      return null
    }

    // ── Token resolution (global token, else loopback bootstrap §1.10) ────
    let cachedToken = null
    let tokenBootstrapPromise = null
    let distrustGlobalToken = false

    function readInjectedToken() {
      try {
        const holder = typeof window !== 'undefined' ? window.__DSH_CODE_RUNNER__ : null
        if (holder && typeof holder.token === 'string' && holder.token !== '') return holder.token
      } catch (error) {
        /* ignore malformed globals */
      }
      return null
    }

    function resolveToken(forceBootstrap) {
      if (forceBootstrap === true) {
        cachedToken = null
        distrustGlobalToken = true
      } else if (cachedToken !== null) {
        return Promise.resolve(cachedToken)
      } else if (!distrustGlobalToken) {
        const injected = readInjectedToken()
        if (injected !== null) {
          cachedToken = injected
          return Promise.resolve(injected)
        }
      }
      if (tokenBootstrapPromise !== null) return tokenBootstrapPromise
      tokenBootstrapPromise = fetchTokenFromHost().then(function onToken(token) {
        tokenBootstrapPromise = null
        cachedToken = token
        return token
      }, function onTokenFailure(error) {
        tokenBootstrapPromise = null
        throw error
      })
      return tokenBootstrapPromise
    }

    function fetchTokenFromHost() {
      return fetch(API.token, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      }).then(function readBootstrapResponse(response) {
        return response.text().then(function parseBootstrapBody(text) {
          return { response: response, text: typeof text === 'string' ? text : '' }
        }, function onBodyReadFailure(error) {
          throw makeError('network', errorMessage(error), { bootstrap: true })
        })
      }, function onBootstrapFetchFailure(error) {
        throw makeError('network', errorMessage(error), { bootstrap: true })
      }).then(function extractBootstrapToken(result) {
        const response = result.response
        const text = result.text
        let payload = null
        if (text !== '') {
          try {
            payload = JSON.parse(text)
          } catch (error) {
            payload = null
          }
        }
        if (payload === null) {
          if (response.status === 404) {
            throw makeError('not-mounted', clampDetail(text) || 'HTTP 404', { status: 404, bootstrap: true })
          }
          throw makeError('http', 'HTTP ' + response.status, { status: response.status, bootstrap: true })
        }
        if (payload.ok !== true) {
          const hostError = payload.error && typeof payload.error === 'object' ? payload.error : {}
          throw makeError(
            typeof hostError.code === 'string' ? hostError.code : 'internal',
            typeof hostError.message === 'string' ? hostError.message : '',
            { status: response.status, bootstrap: true }
          )
        }
        if (typeof payload.token !== 'string' || payload.token === '') {
          throw makeError('no-token', 'the host token bootstrap returned no token', { bootstrap: true })
        }
        return payload.token
      })
    }

    // ── HTTP layer ──────────────────────────────────────────────────────────
    function requestWithToken(method, path, options) {
      const settings = options || {}
      return resolveToken(false).then(function withToken(token) {
        return rawRequest(method, path, token, settings)
      }).catch(function onFailure(error) {
        if (error && error.code === 'unauthorized' && settings.retryOnUnauthorized !== false) {
          return resolveToken(true).then(function withFreshToken(token) {
            return rawRequest(method, path, token, settings)
          })
        }
        throw error
      })
    }

    function rawRequest(method, path, token, options) {
      const settings = options || {}
      const headers = { accept: 'application/json', 'x-dsh-code-runner-token': token }
      const init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' }
      if (settings.signal) init.signal = settings.signal
      if (settings.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(settings.body)
      }
      return fetch(path, init).then(function readResponse(response) {
        return response.text().then(function parseBody(text) {
          return { response: response, text: typeof text === 'string' ? text : '' }
        }, function onBodyReadFailure(error) {
          if (settings.signal && settings.signal.aborted) throw makeError('aborted', 'aborted')
          throw makeError('network', errorMessage(error))
        })
      }, function onFetchFailure(error) {
        if (isAbortError(error) || (settings.signal && settings.signal.aborted)) {
          throw makeError('aborted', 'aborted')
        }
        throw makeError('network', errorMessage(error))
      }).then(function unwrapPayload(result) {
        const response = result.response
        const text = result.text
        let payload = null
        if (text !== '') {
          try {
            payload = JSON.parse(text)
          } catch (error) {
            payload = null
          }
        }
        if (payload === null) {
          if (response.status === 404) {
            throw makeError('not-mounted', clampDetail(text) || 'HTTP 404', { status: 404 })
          }
          throw makeError('http', 'HTTP ' + response.status, { status: response.status })
        }
        if (payload.ok !== true) {
          const hostError = payload.error && typeof payload.error === 'object' ? payload.error : {}
          throw makeError(
            typeof hostError.code === 'string' ? hostError.code : 'internal',
            typeof hostError.message === 'string' ? hostError.message : '',
            { status: response.status }
          )
        }
        return payload
      })
    }

    /** GET raw bytes (images/PDF preview). The blob route is not JSON. */
    function fetchBlobWithToken(token, path, signal) {
      const init = {
        method: 'GET',
        headers: { accept: '*/*', 'x-dsh-code-runner-token': token },
        credentials: 'same-origin',
        cache: 'no-store',
      }
      if (signal) init.signal = signal
      return fetch(path, init).then(function readBlobResponse(response) {
        if (response.ok === false) {
          return response.text().then(function parseBlobError(text) {
            let payload = null
            if (text) {
              try { payload = JSON.parse(text) } catch (error) { payload = null }
            }
            if (payload && payload.error && typeof payload.error.code === 'string') {
              throw makeError(payload.error.code, typeof payload.error.message === 'string' ? payload.error.message : '', { status: response.status })
            }
            throw makeError('http', 'HTTP ' + response.status, { status: response.status })
          }, function onBlobErrorBodyFailure() {
            throw makeError('http', 'HTTP ' + response.status, { status: response.status })
          })
        }
        return response.blob().then(function onBlob(blob) {
          return {
            blob: blob,
            contentType: response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null,
          }
        }, function onBlobReadFailure(error) {
          if (isAbortError(error) || (signal && signal.aborted)) throw makeError('aborted', 'aborted')
          throw makeError('network', errorMessage(error))
        })
      }, function onBlobFetchFailure(error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw makeError('aborted', 'aborted')
        throw makeError('network', errorMessage(error))
      })
    }

    function requestBlob(path, options) {
      const settings = options || {}
      return resolveToken(false).then(function withToken(token) {
        return fetchBlobWithToken(token, path, settings.signal)
      }).catch(function onBlobFailure(error) {
        if (error && error.code === 'unauthorized') {
          return resolveToken(true).then(function withFreshToken(token) {
            return fetchBlobWithToken(token, path, settings.signal)
          })
        }
        throw error
      })
    }

    function objectUrlFromBlob(blob) {
      try {
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          return URL.createObjectURL(blob)
        }
      } catch (error) {
        /* ignore URL failures */
      }
      return null
    }

    function revokeObjectUrl(url) {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && typeof url === 'string' && url !== '') {
          URL.revokeObjectURL(url)
        }
      } catch (error) {
        /* ignore URL failures */
      }
    }

    // ── Localized failure presentation ─────────────────────────────────────
    /**
     * Map a normalized host/browser failure onto a localized notice descriptor
     * (`{key, params, tone, retry}`); the surface translates it at render time.
     */
    function noticeSpecForError(rawError, options) {
      const error = rawError && typeof rawError === 'object' ? rawError : null
      if (error === null) return null
      const code = typeof error.code === 'string' ? error.code : 'internal'
      const detail = clampDetail(error.message)
      const canRetry = !!(options && options.retry)
      const fromBootstrap = error.bootstrap === true

      if (code === 'aborted') return null
      if (code === 'no-token' || (fromBootstrap && (code === 'unauthorized' || code === 'forbidden' || code === 'no-token'))) {
        return { key: 'error.noToken', params: null, tone: 'error', retry: false }
      }
      switch (code) {
        case 'unauthorized':
          return { key: 'error.unauthorized', params: null, tone: 'error', retry: false }
        case 'forbidden':
          return { key: 'error.forbidden', params: null, tone: 'error', retry: false }
        case 'network':
          return { key: 'error.host', params: null, tone: 'warn', retry: canRetry }
        case 'not-mounted':
          return { key: 'error.setup', params: { detail: detail || 'HTTP 404' }, tone: 'error', retry: canRetry }
        case 'unknown-run':
          return { key: 'error.unknownRun', params: null, tone: 'warn', retry: false }
        case 'language-unavailable':
          return { key: 'error.languageUnavailable', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'bad-cwd':
          return { key: 'error.badCwd', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'bad-path':
          return { key: 'error.badPath', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'not-found':
          return { key: 'error.fileNotFound', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'conflict':
          return { key: 'error.conflict', params: { detail: detail || code }, tone: 'warn', retry: false }
        case 'too-large':
          return { key: 'error.fileTooLarge', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'unsupported-file':
          return { key: 'error.unsupportedFile', params: { detail: detail || code }, tone: 'error', retry: false }
        case 'save-failed':
          return { key: 'error.saveFailed', params: { detail: detail || code }, tone: 'error', retry: false }
        default:
          return { key: 'error.setup', params: { detail: detail || code }, tone: 'error', retry: canRetry }
      }
    }

    /** Localized error copy for the AI explain dialog (CONTRACT-V3 §2.2). */
    function explainErrorText(translate, error) {
      const normalized = error && typeof error === 'object' ? error : null
      const code = normalized && typeof normalized.code === 'string' ? normalized.code : 'internal'
      const detail = normalized ? clampDetail(normalized.message) : ''
      if (code === 'llm-unavailable') return translate('explain.llmUnavailable')
      if (code === 'llm-timeout') return translate('explain.failed', { detail: translate('status.timeout') })
      if (code === 'llm-failed') return translate('explain.failed', { detail: detail || code })
      const spec = noticeSpecForError(normalized)
      if (spec) return translate(spec.key, spec.params || undefined)
      return translate('explain.failed', { detail: detail || code })
    }

    // ── Module-level workbench store (shared by the page and the right pane) ─
    function createIdleRun() {
      return {
        phase: 'idle',
        runId: null,
        language: null,
        mode: null,
        file: null,
        command: '',
        cwd: '',
        startedAt: 0,
        timeoutMs: 0,
        running: false,
        finished: false,
        exitCode: null,
        signal: null,
        durationMs: null,
        timedOut: false,
        stopped: false,
        capturePlots: false,
        plotDir: '',
        origin: 'manual',
        error: null,
      }
    }

    function createIdleOutput() {
      return {
        stdout: '',
        stderr: '',
        stdoutOffset: 0,
        stderrOffset: 0,
        stdoutLossy: false,
        stderrLossy: false,
      }
    }

    function createInitialState() {
      let splitRatio = DEFAULT_SPLIT_RATIO
      try {
        const storedSplit = parseFloat(storageGet(STORAGE_SPLIT))
        if (isFinite(storedSplit)) splitRatio = clampRatio(storedSplit)
      } catch (error) {
        splitRatio = DEFAULT_SPLIT_RATIO
      }
      let bottomTab = storageGet(STORAGE_BOTTOM_TAB)
      if (bottomTab !== 'console' && bottomTab !== 'plots' && bottomTab !== 'files') bottomTab = 'console'
      return {
        env: { status: 'loading', data: null, error: null },
        languages: [],
        cwd: storageGet(STORAGE_CWD) || '',
        languageId: storageGet(STORAGE_LANGUAGE) || '',
        code: '',
        filePath: null,
        fileMtimeMs: null,
        savedCode: '',
        dirty: false,
        run: createIdleRun(),
        output: createIdleOutput(),
        plots: { items: [], status: 'idle', error: null, runId: null, truncated: false, urls: {} },
        files: { dir: '', parent: '', entries: [], status: 'idle', error: null, truncated: false },
        selection: { start: 0, end: 0, text: '' },
        explain: {
          status: 'idle',
          summary: '',
          annotatedCode: '',
          provider: '',
          model: '',
          truncatedInput: false,
          error: null,
          inserted: false,
          previousCode: null,
          requestCode: '',
          lastSummary: '',
          lastCodeKey: '',
        },
        exportState: { status: 'idle', folder: '', reportPath: '', htmlPath: '', docxPath: '', error: null, savedAt: 0 },
        exportDialog: { open: false, format: 'docx', plotPlacement: 'section', include: { code: true, output: true, plots: true, summary: true } },
        datasetDialog: {
          open: false,
          path: '',
          browseDir: '',
          entries: [],
          entriesStatus: 'idle',
          entriesError: null,
          status: 'idle',
          error: null,
          preview: null,
          sheet: null,
          header: null,
          delimiter: null,
        },
        packs: { status: 'idle', items: [], stateDir: '', error: null },
        packsOpen: false,
        plotSave: { status: 'idle', targetDir: '', saved: [], error: null },
        ui: {
          bottomTab: bottomTab,
          railTab: 'files',
          splitRatio: splitRatio,
          lightbox: null,
          notice: null,
          discard: null,
          conflict: null,
          saveAs: null,
          saving: false,
          plotsUnseen: 0,
          cursor: { line: 1, col: 1 },
        },
        editorFocused: false,
      }
    }

    const store = (function createWorkbenchStore() {
      const state = createInitialState()
      const listeners = new Set()
      let snapshotCache = null

      // Timers and abort controllers owned by the store (no leaks when idle).
      let surfaceCount = 0
      let pollTimer = null
      let pollAbort = null
      let tailDrainUsed = false
      let pollFailures = 0
      let artifactTimer = null
      let artifactAbort = null
      let artifactSeq = 0
      let blobAbort = null
      let bootAbort = null
      let bootPromise = null
      let draftTimer = null
      let filesSeq = 0

      function getSnapshot() {
        if (snapshotCache === null) {
          snapshotCache = {
            env: state.env,
            languages: state.languages,
            cwd: state.cwd,
            languageId: state.languageId,
            code: state.code,
            filePath: state.filePath,
            fileMtimeMs: state.fileMtimeMs,
            dirty: state.dirty,
            run: state.run,
            output: state.output,
            plots: state.plots,
            files: state.files,
            selection: state.selection,
            explain: state.explain,
            exportState: state.exportState,
            exportDialog: state.exportDialog,
            datasetDialog: state.datasetDialog,
            packs: state.packs,
            packsOpen: state.packsOpen,
            plotSave: state.plotSave,
            ui: state.ui,
            editorFocused: state.editorFocused,
          }
        }
        return snapshotCache
      }

      function emit() {
        snapshotCache = null
        const snap = getSnapshot()
        listeners.forEach(function notify(listener) {
          try {
            listener(snap)
          } catch (error) {
            try { console.error('[dsh-code-runner] workbench store listener failed', error) } catch (ignored) { /* ignore */ }
          }
        })
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function noop() {}
        listeners.add(listener)
        return function unsubscribe() { listeners.delete(listener) }
      }

      function setRun(patch) {
        state.run = Object.assign({}, state.run, patch)
      }

      function setOutput(patch) {
        state.output = Object.assign({}, state.output, patch)
      }

      function setPlots(patch) {
        state.plots = Object.assign({}, state.plots, patch)
      }

      function setFiles(patch) {
        state.files = Object.assign({}, state.files, patch)
      }

      function setUi(patch) {
        state.ui = Object.assign({}, state.ui, patch)
      }

      function setNoticeSpec(spec) {
        if (!spec) return
        setUi({ notice: { key: spec.key, params: spec.params || null, tone: spec.tone || 'error', retry: spec.retry === true } })
      }

      function pushNotice(key, tone, params) {
        setUi({ notice: { key: key, params: params || null, tone: tone || 'info', retry: false } })
      }

      // ── persistence helpers ─────────────────────────────────────────────
      function scheduleDraftSave() {
        if (draftTimer !== null) clearTimeout(draftTimer)
        draftTimer = setTimeout(function onDraftTimer() {
          draftTimer = null
          saveDraftNow()
        }, 400)
      }

      function saveDraftNow() {
        if (state.filePath === null && state.languageId !== '') {
          storageSet(STORAGE_DRAFT_PREFIX + state.languageId, state.code)
        }
      }

      function flushDraft() {
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
        saveDraftNow()
      }

      function readDraft(languageId) {
        if (languageId === '') return ''
        const stored = storageGet(STORAGE_DRAFT_PREFIX + languageId)
        return stored !== null ? stored : ''
      }

      function availableIds() {
        const ids = []
        for (let index = 0; index < state.languages.length; index += 1) ids.push(state.languages[index].id)
        return ids
      }

      // ── boot: token + env + defaults ────────────────────────────────────
      function applyEnvDefaults() {
        const languages = availableLanguagesOf(state.env.data)
        state.languages = languages
        const ids = availableIds()
        let languageId = state.languageId
        if (ids.indexOf(languageId) < 0) {
          const stored = storageGet(STORAGE_LANGUAGE)
          if (stored !== null && ids.indexOf(stored) >= 0) languageId = stored
          else if (ids.length > 0) languageId = ids[0]
          else languageId = ''
        }
        state.languageId = languageId
        if (languageId !== '') storageSet(STORAGE_LANGUAGE, languageId)
        if (typeof state.cwd !== 'string' || state.cwd === '') {
          state.cwd = state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : ''
        }
        if (state.filePath === null && state.code === '') state.code = readDraft(languageId)
        if (state.cwd !== '') storageSet(STORAGE_CWD, state.cwd)
      }

      function ensureBoot(force) {
        if (!force && state.env.status === 'ready') return Promise.resolve()
        if (bootPromise !== null) return bootPromise
        const controller = new AbortController()
        bootAbort = controller
        state.env = { status: 'loading', data: state.env.data, error: null }
        emit()
        bootPromise = resolveToken(false).then(function requestEnvironment() {
          return requestWithToken('GET', API.env, { signal: controller.signal })
        }).then(function onEnvironment(payload) {
          if (controller.signal.aborted) return
          state.env = { status: 'ready', data: payload, error: null }
          applyEnvDefaults()
          emit()
          if (state.cwd !== '') loadFiles(state.cwd)
        }, function onEnvironmentFailure(error) {
          if (controller.signal.aborted || isAbortError(error)) {
            state.env = { status: 'loading', data: null, error: null }
            emit()
            return
          }
          const normalized = normalizeError(error)
          state.env = { status: 'error', data: null, error: normalized }
          setNoticeSpec(noticeSpecForError(normalized, { retry: true }))
          emit()
        }).then(function settleBoot() {
          if (bootAbort === controller) bootAbort = null
          bootPromise = null
          return null
        })
        return bootPromise
      }

      // ── v5: language packs (detect → one-click install/enable) ─────────
      function loadPacks() {
        state.packs = Object.assign({}, state.packs, { status: 'loading', error: null })
        emit()
        return requestWithToken('GET', API.packs).then(function onPacks(payload) {
          state.packs = {
            status: 'ready',
            items: Array.isArray(payload.packs) ? payload.packs : [],
            stateDir: typeof payload.stateDir === 'string' ? payload.stateDir : '',
            error: null,
          }
          emit()
          return state.packs
        }, function onPacksError(error) {
          if (isAbortError(error)) return null
          state.packs = Object.assign({}, state.packs, { status: 'error', error: normalizeError(error) })
          emit()
          return null
        })
      }

      function openPacksDialog() {
        state.packsOpen = true
        emit()
        return loadPacks()
      }

      function closePacksDialog() {
        if (!state.packsOpen) return
        state.packsOpen = false
        emit()
      }

      function refreshPacks() {
        return requestWithToken('POST', API.packsRescan, { body: {} }).then(function onRescanned(payload) {
          state.packs = {
            status: 'ready',
            items: Array.isArray(payload.packs) ? payload.packs : [],
            stateDir: typeof payload.stateDir === 'string' ? payload.stateDir : '',
            error: null,
          }
          emit()
          retry()
          return null
        }, function onRescanError(error) {
          if (isAbortError(error)) return null
          setNoticeSpec(noticeSpecForError(normalizeError(error), { retry: false }))
          emit()
          return null
        })
      }

      function togglePack(id, enabled) {
        return requestWithToken('POST', API.packs, { body: { id: id, enabled: enabled } }).then(function onToggled(payload) {
          state.packs = {
            status: 'ready',
            items: Array.isArray(payload.packs) ? payload.packs : [],
            stateDir: typeof payload.stateDir === 'string' ? payload.stateDir : '',
            error: null,
          }
          emit()
          retry()
          return null
        }, function onToggleError(error) {
          if (isAbortError(error)) return null
          setNoticeSpec(noticeSpecForError(normalizeError(error), { retry: false }))
          emit()
          return null
        })
      }

      function retry() {
        if (state.env.status === 'loading') return
        setUi({ notice: null })
        ensureBoot(true)
      }

      // ── cwd / language / code ───────────────────────────────────────────
      function setCwd(value) {
        state.cwd = String(value === undefined || value === null ? '' : value)
        storageSet(STORAGE_CWD, state.cwd)
        emit()
      }

      function commitCwd() {
        const trimmed = state.cwd.trim()
        if (trimmed !== state.cwd) {
          state.cwd = trimmed
          storageSet(STORAGE_CWD, trimmed)
          emit()
        }
        if (trimmed !== '') loadFiles(trimmed)
      }

      function pickCwd() {
        try {
          const workspace = rootContext && typeof rootContext.get === 'function' ? rootContext.get('uiWorkspace') : null
          if (!workspace || typeof workspace.pickDirectory !== 'function') return Promise.resolve()
          return Promise.resolve(workspace.pickDirectory()).then(function onPicked(value) {
            if (typeof value === 'string' && value !== '') {
              setCwd(value)
              commitCwd()
            }
          }, function onPickFailure() {
            /* a failed pick is ignored */
          })
        } catch (error) {
          return Promise.resolve()
        }
      }

      function switchLanguageNow(nextId) {
        if (state.filePath === null) {
          saveDraftNow()
          state.code = readDraft(nextId)
          state.savedCode = ''
        }
        state.languageId = nextId
        storageSet(STORAGE_LANGUAGE, nextId)
        setUi({ discard: null, notice: null })
        emit()
      }

      function setLanguage(nextId) {
        const languageId = String(nextId || '')
        if (languageId === '' || languageId === state.languageId) return
        // The scratch buffer keeps one draft per language and an open file is not
        // replaced by the switch, so this never loses text: no dirty guard needed.
        switchLanguageNow(languageId)
      }

      function setCode(code) {
        state.code = typeof code === 'string' ? code : ''
        if (state.filePath !== null) {
          state.dirty = state.code !== state.savedCode
        } else {
          state.dirty = false
          scheduleDraftSave()
        }
        // Keep a stale selection inside the new text; a programmatic replacement
        // resets it explicitly through resetSelection().
        if (state.selection.end > state.code.length) {
          const start = Math.max(0, Math.min(state.selection.start, state.code.length))
          state.selection = { start: start, end: start, text: '' }
        }
        emit()
      }

      /** Track the textarea selection in the shared store (CONTRACT-V3 §2.1). */
      function setSelection(start, end) {
        const codeLength = state.code.length
        let nextStart = typeof start === 'number' && isFinite(start) ? Math.floor(start) : 0
        let nextEnd = typeof end === 'number' && isFinite(end) ? Math.floor(end) : nextStart
        nextStart = Math.max(0, Math.min(codeLength, nextStart))
        nextEnd = Math.max(0, Math.min(codeLength, nextEnd))
        if (nextEnd < nextStart) {
          const swap = nextStart
          nextStart = nextEnd
          nextEnd = swap
        }
        const previous = state.selection
        if (previous.start === nextStart && previous.end === nextEnd) return
        state.selection = { start: nextStart, end: nextEnd, text: state.code.slice(nextStart, nextEnd) }
        emit()
      }

      function resetSelection() {
        if (state.selection.start === 0 && state.selection.end === 0 && state.selection.text === '') return
        state.selection = { start: 0, end: 0, text: '' }
      }

      function selectedText() {
        const selection = state.selection
        if (!selection || typeof selection.text !== 'string') return ''
        return selection.text
      }

      function hasRunnableSelection() {
        return selectedText().trim() !== ''
      }

      function setCursor(line, col) {
        const next = { line: line, col: col }
        if (state.ui.cursor.line === next.line && state.ui.cursor.col === next.col) return
        setUi({ cursor: next })
        emit()
      }

      function setEditorFocused(focused) {
        const next = focused === true
        if (state.editorFocused === next) return
        state.editorFocused = next
        if (next) setUi({ plotsUnseen: 0 })
        emit()
      }

      // ── files ───────────────────────────────────────────────────────────
      function compareEntries(left, right) {
        const leftDir = left && left.isDir === true ? 0 : 1
        const rightDir = right && right.isDir === true ? 0 : 1
        if (leftDir !== rightDir) return leftDir - rightDir
        const leftName = left && typeof left.name === 'string' ? left.name : ''
        const rightName = right && typeof right.name === 'string' ? right.name : ''
        return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' })
      }

      function loadFiles(directory) {
        const target = typeof directory === 'string' && directory !== '' ? directory : state.cwd
        if (target === '') {
          setFiles({ status: 'idle', dir: '', parent: '', entries: [], error: null, truncated: false })
          emit()
          return Promise.resolve()
        }
        const seq = filesSeq + 1
        filesSeq = seq
        setFiles({ status: 'loading', dir: target, error: null })
        emit()
        return requestWithToken('GET', API.files + '?dir=' + encodeURIComponent(target)).then(function onListing(payload) {
          if (seq !== filesSeq) return
          const entries = Array.isArray(payload.entries) ? payload.entries.slice() : []
          entries.sort(compareEntries)
          setFiles({
            status: 'ready',
            dir: typeof payload.dir === 'string' ? payload.dir : target,
            parent: typeof payload.parent === 'string' ? payload.parent : dirname(target),
            entries: entries,
            truncated: payload.truncated === true,
            error: null,
          })
          emit()
        }, function onListingFailure(error) {
          if (seq !== filesSeq || isAbortError(error)) return
          const normalized = normalizeError(error)
          setFiles({ status: 'error', dir: target, entries: [], error: normalized })
          setNoticeSpec(noticeSpecForError(normalized))
          emit()
        })
      }

      function filesRefresh() {
        const target = state.files.dir !== '' ? state.files.dir : state.cwd
        return loadFiles(target)
      }

      function filesUp() {
        const current = state.files.dir !== '' ? state.files.dir : state.cwd
        const parent = state.files.parent !== '' ? state.files.parent : dirname(current)
        if (parent === '' || parent === current) return Promise.resolve()
        return loadFiles(parent)
      }

      function openEntry(entry) {
        if (!entry || typeof entry.path !== 'string' || entry.path === '') return
        if (entry.isDir === true) {
          loadFiles(entry.path)
          return
        }
        requestOpenPath(entry.path)
      }

      // ── opening files ───────────────────────────────────────────────────
      function requestOpenPath(path) {
        if (state.dirty) {
          setUi({ discard: { kind: 'open', path: path } })
          emit()
          return
        }
        openPathNow(path)
      }

      function openFileImageLightbox(path) {
        return requestBlob(API.blob + '?path=' + encodeURIComponent(path), { signal: blobAbort ? blobAbort.signal : null }).then(function onImage(result) {
          const url = objectUrlFromBlob(result.blob)
          if (url === null) {
            setNoticeSpec({ key: 'plots.unsupported', params: null, tone: 'warn', retry: false })
            emit()
            return
          }
          setUi({
            lightbox: {
              items: [{ path: path, name: basename(path), source: 'file', url: url, ext: extensionOf(path), size: null }],
              index: 0,
            },
          })
          emit()
        }, function onImageFailure(error) {
          if (isAbortError(error)) return
          const normalized = normalizeError(error)
          setNoticeSpec(noticeSpecForError(normalized))
          emit()
        })
      }

      function openPathNow(path) {
        return requestWithToken('GET', API.file + '?path=' + encodeURIComponent(path)).then(function onFile(payload) {
          const resolvedPath = typeof payload.path === 'string' ? payload.path : path
          const ext = typeof payload.ext === 'string' && payload.ext !== '' ? payload.ext : extensionOf(resolvedPath)
          if (IS_IMAGE_EXT_SET[ext] === true) {
            return openFileImageLightbox(resolvedPath)
          }
          if (payload.binary === true) {
            setNoticeSpec({ key: 'files.binary', params: null, tone: 'warn', retry: false })
            emit()
            return
          }
          const text = typeof payload.text === 'string' ? payload.text : ''
          state.filePath = resolvedPath
          state.fileMtimeMs = typeof payload.mtimeMs === 'number' ? payload.mtimeMs : null
          state.code = text
          state.savedCode = text
          state.dirty = false
          resetSelection()
          const inferred = languageForExtension(ext, availableIds())
          if (inferred !== null && availableIds().indexOf(inferred) >= 0) {
            state.languageId = inferred
            storageSet(STORAGE_LANGUAGE, inferred)
          }
          setUi({ discard: null, saveAs: null, notice: null })
          if (payload.truncated === true) setNoticeSpec({ key: 'files.tooLarge', params: null, tone: 'warn', retry: false })
          emit()
          return null
        }, function onFileFailure(error) {
          if (isAbortError(error)) return
          const normalized = normalizeError(error)
          setUi({ discard: null })
          setNoticeSpec(noticeSpecForError(normalized) || {
            key: 'files.openFailed',
            params: { detail: clampDetail(normalized.message) },
            tone: 'error',
            retry: false,
          })
          emit()
        })
      }

      // ── saving ──────────────────────────────────────────────────────────
      function openSaveAs() {
        const name = state.filePath !== null
          ? basename(state.filePath)
          : defaultFileNameForLanguage(state.languageId, findLanguage(state.languages, state.languageId))
        setUi({ saveAs: { name: name, dir: state.cwd || (state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : '') } })
        emit()
      }

      function setSaveAsName(name) {
        if (!state.ui.saveAs) return
        setUi({ saveAs: Object.assign({}, state.ui.saveAs, { name: String(name) }) })
        emit()
      }

      function cancelSaveAs() {
        setUi({ saveAs: null })
        emit()
      }

      function confirmSaveAs() {
        const dialog = state.ui.saveAs
        if (!dialog) return Promise.resolve({ ok: false, reason: 'closed' })
        const name = String(dialog.name || '').trim()
        if (name === '') return Promise.resolve({ ok: false, reason: 'empty' })
        const directory = dialog.dir !== '' ? dialog.dir : state.cwd
        if (directory === '') return Promise.resolve({ ok: false, reason: 'no-directory' })
        const path = joinPath(directory, name)
        setUi({ saving: true })
        emit()
        return requestWithToken('POST', API.file, { body: { path: path, text: state.code } }).then(function onSaved(payload) {
          const resolvedPath = typeof payload.path === 'string' ? payload.path : path
          state.filePath = resolvedPath
          state.fileMtimeMs = typeof payload.mtimeMs === 'number' ? payload.mtimeMs : null
          state.savedCode = state.code
          state.dirty = false
          resetSelection()
          // Adopting the new file means opening it: infer its language from the name.
          const inferred = languageForExtension(extensionOf(resolvedPath), availableIds())
          if (inferred !== null && availableIds().indexOf(inferred) >= 0) {
            state.languageId = inferred
            storageSet(STORAGE_LANGUAGE, inferred)
          }
          setUi({ saving: false, saveAs: null, notice: { key: 'editor.saved', params: null, tone: 'success', retry: false } })
          emit()
          return { ok: true }
        }, function onSaveFailure(error) {
          if (isAbortError(error)) return { ok: false, reason: 'aborted' }
          const normalized = normalizeError(error)
          setUi({ saving: false })
          if (normalized.code === 'conflict') {
            setUi({ saveAs: null, conflict: { kind: 'saveAs' } })
          } else {
            setNoticeSpec(noticeSpecForError(normalized))
          }
          emit()
          return { ok: false, reason: normalized.code }
        })
      }

      function saveFile(options) {
        const settings = options || {}
        if (state.filePath === null) {
          openSaveAs()
          return Promise.resolve({ ok: false, reason: 'scratch' })
        }
        const body = { path: state.filePath, text: state.code }
        if (settings.overwrite !== true && typeof state.fileMtimeMs === 'number') body.baseMtimeMs = state.fileMtimeMs
        setUi({ saving: true })
        emit()
        return requestWithToken('POST', API.file, { body: body }).then(function onSaved(payload) {
          state.fileMtimeMs = typeof payload.mtimeMs === 'number' ? payload.mtimeMs : state.fileMtimeMs
          state.savedCode = state.code
          state.dirty = false
          if (settings.silent === true) {
            setUi({ saving: false, conflict: null })
          } else {
            setUi({
              saving: false,
              conflict: null,
              notice: { key: 'editor.saved', params: null, tone: 'success', retry: false },
            })
          }
          emit()
          return { ok: true }
        }, function onSaveError(error) {
          if (isAbortError(error)) {
            setUi({ saving: false })
            emit()
            return { ok: false, reason: 'aborted' }
          }
          const normalized = normalizeError(error)
          setUi({ saving: false })
          if (normalized.code === 'conflict') {
            setUi({ conflict: { kind: 'save' } })
            emit()
            return { ok: false, reason: 'conflict' }
          }
          setNoticeSpec(noticeSpecForError(normalized) || {
            key: 'error.saveFailed',
            params: { detail: clampDetail(normalized.message) },
            tone: 'error',
            retry: false,
          })
          emit()
          return { ok: false, reason: normalized.code }
        })
      }

      function confirmOverwrite() {
        const conflict = state.ui.conflict
        setUi({ conflict: null })
        emit()
        if (!conflict) return
        if (conflict.kind === 'saveAs') confirmSaveAs()
        else saveFile({ overwrite: true })
      }

      function cancelConflict() {
        setUi({ conflict: null })
        emit()
      }

      // ── scratch buffer / dirty guards ───────────────────────────────────
      function startScratch() {
        saveDraftNow()
        state.filePath = null
        state.fileMtimeMs = null
        state.savedCode = ''
        state.code = readDraft(state.languageId)
        state.dirty = false
        resetSelection()
        setUi({ discard: null, conflict: null, saveAs: null, notice: null })
        emit()
      }

      function newFile() {
        if (state.dirty) {
          setUi({ discard: { kind: 'new' } })
          emit()
          return
        }
        startScratch()
      }

      function confirmDiscard() {
        const discard = state.ui.discard
        setUi({ discard: null })
        emit()
        if (!discard) return
        if (discard.kind === 'open' && typeof discard.path === 'string') openPathNow(discard.path)
        else if (discard.kind === 'new') startScratch()
        else if (discard.kind === 'language' && typeof discard.languageId === 'string') switchLanguageNow(discard.languageId)
      }

      function cancelDiscard() {
        setUi({ discard: null })
        emit()
      }

      // ── run + output polling ────────────────────────────────────────────
      function clearPollTimer() {
        if (pollTimer !== null) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
      }

      function abortPollRequest() {
        if (pollAbort !== null) {
          const controller = pollAbort
          pollAbort = null
          try { controller.abort() } catch (error) { /* ignore */ }
        }
      }

      function schedulePoll(delay) {
        if (surfaceCount <= 0) return
        clearPollTimer()
        pollTimer = setTimeout(function onPollTimer() {
          pollTimer = null
          pollOnce()
        }, typeof delay === 'number' ? delay : POLL_MS)
      }

      function applyOutputPayload(payload) {
        if (!payload || typeof payload !== 'object') return
        const stdout = payload.stdout
        if (stdout) {
          if (typeof stdout.text === 'string' && stdout.text !== '') setOutput({ stdout: state.output.stdout + stdout.text })
          if (typeof stdout.nextOffset === 'number' && isFinite(stdout.nextOffset) && stdout.nextOffset >= 0) {
            setOutput({ stdoutOffset: Math.floor(stdout.nextOffset) })
          }
          if (stdout.lossy === true) setOutput({ stdoutLossy: true })
        }
        const stderr = payload.stderr
        if (stderr) {
          if (typeof stderr.text === 'string' && stderr.text !== '') setOutput({ stderr: state.output.stderr + stderr.text })
          if (typeof stderr.nextOffset === 'number' && isFinite(stderr.nextOffset) && stderr.nextOffset >= 0) {
            setOutput({ stderrOffset: Math.floor(stderr.nextOffset) })
          }
          if (stderr.lossy === true) setOutput({ stderrLossy: true })
        }
        const patch = {}
        if (typeof payload.runId === 'string' && payload.runId !== '') patch.runId = payload.runId
        if (typeof payload.language === 'string' && payload.language !== '') patch.language = payload.language
        if (typeof payload.command === 'string' && payload.command !== '') patch.command = payload.command
        if (typeof payload.cwd === 'string' && payload.cwd !== '') patch.cwd = payload.cwd
        if (typeof payload.startedAt === 'number' && payload.startedAt > 0) patch.startedAt = payload.startedAt
        if (typeof payload.mode === 'string') patch.mode = payload.mode
        if (typeof payload.file === 'string') patch.file = payload.file
        if (typeof payload.plotDir === 'string') patch.plotDir = payload.plotDir
        if (payload.capturePlots === true) patch.capturePlots = true
        if (Object.keys(patch).length > 0) setRun(patch)
      }

      function finalizeRun(payload) {
        clearPollTimer()
        abortPollRequest()
        stopArtifactTimer()
        const runPatch = {
          running: false,
          finished: true,
          phase: 'finished',
          exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
          signal: typeof payload.signal === 'string' && payload.signal !== '' ? payload.signal : null,
          durationMs: typeof payload.durationMs === 'number'
            ? payload.durationMs
            : (state.run.startedAt > 0 ? Date.now() - state.run.startedAt : null),
          timedOut: payload.timedOut === true,
          stopped: payload.stopped === true,
          error: null,
        }
        setRun(runPatch)
        emit()
        reportDiag('run', {
          runId: state.run.runId,
          language: state.run.language,
          mode: state.run.mode,
          exitCode: runPatch.exitCode,
          timedOut: runPatch.timedOut,
          stopped: runPatch.stopped,
        })
        if (state.run.runId !== null) loadArtifacts(state.run.runId)
      }

      function pollOnce() {
        const runId = state.run.runId
        if (runId === null || runId === undefined) return
        const controller = new AbortController()
        pollAbort = controller
        const path = API.output
          + '?runId=' + encodeURIComponent(runId)
          + '&stdoutFrom=' + state.output.stdoutOffset
          + '&stderrFrom=' + state.output.stderrOffset
        requestWithToken('GET', path, { signal: controller.signal }).then(function onOutput(payload) {
          if (pollAbort === controller) pollAbort = null
          pollFailures = 0
          applyOutputPayload(payload)
          if (payload.running === true) {
            setRun({ running: true, phase: 'running', error: null })
            emit()
            schedulePoll(POLL_MS)
            return
          }
          if (!tailDrainUsed) {
            tailDrainUsed = true
            schedulePoll(0)
            return
          }
          finalizeRun(payload)
        }, function onOutputFailure(error) {
          if (pollAbort === controller) pollAbort = null
          if (isAbortError(error)) return
          const normalized = normalizeError(error)
          if (normalized.code === 'unknown-run') {
            clearPollTimer()
            abortPollRequest()
            stopArtifactTimer()
            setRun({ running: false, finished: true, phase: 'finished', error: normalized })
            emit()
            return
          }
          pollFailures += 1
          setRun({ error: normalized })
          emit()
          const backoff = Math.min(POLL_BACKOFF_MAX_MS, POLL_MS * Math.pow(2, Math.min(pollFailures, 4)))
          schedulePoll(backoff)
        })
      }

      function resetPlotsForRun() {
        revokeAllPlotUrls(false)
        setPlots({ items: [], status: 'idle', error: null, runId: null, truncated: false, urls: {} })
        setUi({ plotsUnseen: 0, lightbox: null })
      }

      /** Run a buffer selection (CONTRACT-V3 §2.1): editor content stays untouched. */
      function runSelection() {
        const text = selectedText()
        if (text.trim() === '') return Promise.resolve()
        return run({ origin: 'selection', code: text })
      }

      function run(options) {
        const settings = options || {}
        const isSelectionRun = settings.origin === 'selection'
        const overrideCode = typeof settings.code === 'string' ? settings.code : null
        if (state.run.running || state.run.phase === 'starting') return Promise.resolve()
        if (state.ui.saveAs || state.ui.conflict) return Promise.resolve()
        if (state.languageId === '') return Promise.resolve()
        if (isSelectionRun) {
          if (overrideCode === null || overrideCode.trim() === '') return Promise.resolve()
        } else if (state.filePath === null && String(state.code).trim() === '') {
          setNoticeSpec({ key: 'error.emptyCode', params: null, tone: 'error', retry: false })
          emit()
          return Promise.resolve()
        }
        const proceed = function proceedRun() {
          const request = { capturePlots: true }
          const fallbackCwd = state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : ''
          const cwd = state.cwd !== '' ? state.cwd : fallbackCwd
          if (cwd !== '') request.cwd = cwd
          if (isSelectionRun) {
            request.mode = 'buffer'
            request.language = state.languageId
            request.code = overrideCode
            request.origin = 'selection'
          } else if (state.filePath !== null) {
            request.mode = 'file'
            request.file = state.filePath
            request.language = state.languageId
          } else {
            request.mode = 'buffer'
            request.language = state.languageId
            request.code = state.code
          }
          clearPollTimer()
          abortPollRequest()
          stopArtifactTimer()
          tailDrainUsed = false
          pollFailures = 0
          resetPlotsForRun()
          setOutput(createIdleOutput())
          setRun(Object.assign(createIdleRun(), {
            phase: 'starting',
            running: true,
            mode: request.mode,
            file: request.file || null,
            language: request.language,
            capturePlots: true,
            origin: isSelectionRun ? 'selection' : 'manual',
          }))
          emit()
          return requestWithToken('POST', API.run, { body: request }).then(function onRunStarted(payload) {
            setRun({
              runId: typeof payload.runId === 'string' ? payload.runId : null,
              language: typeof payload.language === 'string' ? payload.language : state.run.language,
              mode: typeof payload.mode === 'string' ? payload.mode : state.run.mode,
              file: typeof payload.file === 'string' ? payload.file : null,
              command: typeof payload.command === 'string' ? payload.command : '',
              cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
              startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : Date.now(),
              timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 0,
              capturePlots: payload.capturePlots === true,
              plotDir: typeof payload.plotDir === 'string' ? payload.plotDir : '',
              phase: 'running',
              running: true,
              error: null,
            })
            emit()
            if (state.run.runId !== null) {
              schedulePoll(POLL_MS)
              scheduleArtifactPoll(ARTIFACT_POLL_MS)
            }
            return null
          }, function onRunFailure(error) {
            if (isAbortError(error)) return
            const normalized = normalizeError(error)
            setRun(Object.assign(createIdleRun(), { error: normalized }))
            setNoticeSpec(noticeSpecForError(normalized))
            emit()
          })
        }
        if (!isSelectionRun && state.filePath !== null && state.dirty) {
          return saveFile({ silent: true }).then(function onAutoSaved(result) {
            if (!result || result.ok !== true) return
            const running = proceed()
            if (running && typeof running.then === 'function') {
              return running.then(function afterRunStarted() {
                setUi({ notice: { key: 'editor.savedAndRan', params: null, tone: 'info', retry: false } })
                emit()
              })
            }
            return null
          })
        }
        return proceed()
      }

      function stop() {
        const runId = state.run.runId
        if (runId === null || runId === undefined || !state.run.running) return Promise.resolve()
        return requestWithToken('POST', API.stop, { body: { runId: runId } }).then(function onStopped() {
          emit()
          if (state.run.running && pollTimer === null && pollAbort === null) schedulePoll(0)
        }, function onStopFailure(error) {
          if (isAbortError(error)) return
          const normalized = normalizeError(error)
          if (normalized.code === 'unknown-run') {
            setRun({ running: false, finished: true, phase: 'finished', error: normalized })
          } else {
            setNoticeSpec(noticeSpecForError(normalized))
          }
          emit()
        })
      }

      function clearOutput() {
        setOutput(createIdleOutput())
        emit()
      }

      function copyOutput() {
        const text = state.output.stdout + state.output.stderr
        if (text === '') return Promise.resolve(false)
        let clipboard = null
        try {
          clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        } catch (error) {
          clipboard = null
        }
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          pushNotice('error.copyFailed', 'error')
          emit()
          return Promise.resolve(false)
        }
        return clipboard.writeText(text).then(function onCopied() {
          return true
        }, function onCopyFailure() {
          pushNotice('error.copyFailed', 'error')
          emit()
          return false
        })
      }

      // ── v3: clipboard helper shared by explain/export/plot-save ─────────
      function copyText(text, successKey) {
        const value = typeof text === 'string' ? text : ''
        if (value === '') return Promise.resolve(false)
        let clipboard = null
        try {
          clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        } catch (error) {
          clipboard = null
        }
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          pushNotice('error.copyFailed', 'error')
          emit()
          return Promise.resolve(false)
        }
        return clipboard.writeText(value).then(function onCopied() {
          pushNotice(successKey || 'export.copied', 'success')
          emit()
          return true
        }, function onCopyFailure() {
          pushNotice('error.copyFailed', 'error')
          emit()
          return false
        })
      }

      function copyNoticePath() {
        const notice = state.ui.notice
        if (!notice || typeof notice.copyPath !== 'string' || notice.copyPath === '') return Promise.resolve(false)
        return copyText(notice.copyPath, notice.copyKey || 'export.copied')
      }

      // ── v3: AI explanation / annotated code (CONTRACT-V3 §2.2) ──────────
      function simpleCodeKey(languageId, code) {
        const text = String(code || '')
        let hash = 5381
        for (let index = 0; index < text.length; index += 1) {
          hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
        }
        return String(languageId || '') + ':' + text.length + ':' + hash.toString(16)
      }

      function setExplain(patch) {
        state.explain = Object.assign({}, state.explain, patch)
      }

      function closeExplain() {
        if (state.explain.status === 'idle') return
        setExplain({
          status: 'idle', summary: '', annotatedCode: '', provider: '', model: '',
          truncatedInput: false, error: null, inserted: false, previousCode: null, requestCode: '',
        })
        emit()
      }

      /** Selection when non-whitespace, else the whole buffer (v3 §2.2). */
      function explainRequestCode() {
        const selection = selectedText()
        if (selection.trim() !== '') return { code: selection, fromSelection: true }
        return { code: state.code, fromSelection: false }
      }

      function runExplain() {
        if (state.explain.status === 'loading') return Promise.resolve()
        if (state.languageId === '') return Promise.resolve()
        const request = explainRequestCode()
        if (String(request.code).trim() === '') {
          setNoticeSpec({ key: 'error.emptyCode', params: null, tone: 'error', retry: false })
          emit()
          return Promise.resolve()
        }
        setExplain({
          status: 'loading', summary: '', annotatedCode: '', provider: '', model: '',
          truncatedInput: false, error: null, inserted: false, previousCode: null,
          requestCode: request.code,
        })
        emit()
        const body = {
          language: state.languageId,
          code: request.code,
          fileName: state.filePath !== null ? state.filePath : null,
        }
        return requestWithToken('POST', API.explain, { body: body }).then(function onExplained(payload) {
          if (!payload || typeof payload !== 'object') return null
          const summary = typeof payload.summary === 'string' ? payload.summary : ''
          const annotatedCode = typeof payload.annotatedCode === 'string' ? payload.annotatedCode : ''
          setExplain({
            status: 'ready',
            summary: summary,
            annotatedCode: annotatedCode,
            provider: typeof payload.provider === 'string' ? payload.provider : '',
            model: typeof payload.model === 'string' ? payload.model : '',
            truncatedInput: payload.truncatedInput === true,
            error: null,
            inserted: false,
            previousCode: null,
            lastSummary: summary,
            lastCodeKey: simpleCodeKey(state.languageId, request.code),
          })
          emit()
          reportDiag('explain', { ok: true, language: state.languageId, selection: request.fromSelection })
          return null
        }, function onExplainFailure(error) {
          if (isAbortError(error)) return null
          const normalized = normalizeError(error)
          setExplain({ status: 'error', error: normalized, inserted: false, previousCode: null })
          emit()
          reportDiag('explain', { ok: false, language: state.languageId, code: normalized.code })
          return null
        })
      }

      function insertExplanation() {
        const explain = state.explain
        if (explain.status !== 'ready') return
        if (typeof explain.annotatedCode !== 'string' || explain.annotatedCode === '') return
        const previousCode = state.code
        state.code = explain.annotatedCode
        if (state.filePath !== null) state.dirty = state.code !== state.savedCode
        else {
          state.dirty = false
          scheduleDraftSave()
        }
        resetSelection()
        setExplain({ inserted: true, previousCode: previousCode })
        setUi({ notice: { key: 'explain.inserted', params: null, tone: 'success', retry: false } })
        emit()
      }

      function undoExplanationInsert() {
        const explain = state.explain
        if (explain.inserted !== true || typeof explain.previousCode !== 'string') return
        state.code = explain.previousCode
        if (state.filePath !== null) state.dirty = state.code !== state.savedCode
        else {
          state.dirty = false
          scheduleDraftSave()
        }
        resetSelection()
        setExplain({ inserted: false, previousCode: null })
        emit()
      }

      function copyExplanation() {
        const summary = state.explain.status === 'ready' ? state.explain.summary : ''
        return copyText(summary, 'explain.copied')
      }

      // ── v7: dataset import (CONTRACT-V7 §2) ─────────────────────────────
      function datasetDialogPatch(patch) {
        state.datasetDialog = Object.assign({}, state.datasetDialog, patch)
        emit()
      }

      function loadDatasetEntries(dir) {
        const target = typeof dir === 'string' && dir !== '' ? dir : (state.cwd || '')
        if (target === '') {
          datasetDialogPatch({ browseDir: '', entries: [], entriesStatus: 'ready', entriesError: null })
          return Promise.resolve(null)
        }
        datasetDialogPatch({ browseDir: target, entriesStatus: 'loading', entriesError: null })
        return requestWithToken('GET', API.files + '?dir=' + encodeURIComponent(target)).then(function onDatasetEntries(payload) {
          if (!state.datasetDialog.open || state.datasetDialog.browseDir !== target) return null
          state.datasetDialog = Object.assign({}, state.datasetDialog, {
            entries: payload && Array.isArray(payload.entries) ? payload.entries : [],
            entriesStatus: 'ready',
            entriesError: null,
          })
          emit()
          return null
        }, function onDatasetEntriesFailure(error) {
          if (isAbortError(error)) return null
          const normalized = normalizeError(error)
          if (state.datasetDialog.browseDir !== target) return null
          state.datasetDialog = Object.assign({}, state.datasetDialog, {
            entries: [],
            entriesStatus: 'error',
            entriesError: normalized,
          })
          emit()
          return null
        })
      }

      function openDatasetDialog() {
        if (!state.datasetDialog.open) {
          state.datasetDialog = Object.assign({}, state.datasetDialog, { open: true })
          emit()
        }
        const fallbackDir = state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : ''
        loadDatasetEntries(state.datasetDialog.browseDir || state.cwd || fallbackDir)
      }

      function closeDatasetDialog() {
        if (!state.datasetDialog.open) return
        datasetDialogPatch({ open: false })
      }

      function setDatasetPath(value) {
        datasetDialogPatch({ path: typeof value === 'string' ? value : '' })
      }

      function requestDatasetPreview(overrides) {
        const dialog = state.datasetDialog
        const options = overrides || {}
        const filePath = String(typeof options.path === 'string' ? options.path : dialog.path || '').trim()
        if (filePath === '') return Promise.resolve(null)
        const sheet = Object.prototype.hasOwnProperty.call(options, 'sheet') ? options.sheet : dialog.sheet
        const header = Object.prototype.hasOwnProperty.call(options, 'header') ? options.header : dialog.header
        const delimiter = Object.prototype.hasOwnProperty.call(options, 'delimiter') ? options.delimiter : dialog.delimiter
        const body = { path: filePath, maxRows: 20 }
        if (state.languageId !== '') body.language = state.languageId
        if (typeof sheet === 'string' && sheet !== '') body.sheet = sheet
        if (header === true || header === false) body.header = header
        if (typeof delimiter === 'string' && delimiter !== '') body.delimiter = delimiter
        datasetDialogPatch({
          path: filePath,
          status: 'loading',
          error: null,
          sheet: typeof sheet === 'string' && sheet !== '' ? sheet : null,
          header: header === true || header === false ? header : null,
          delimiter: typeof delimiter === 'string' && delimiter !== '' ? delimiter : null,
        })
        return requestWithToken('POST', API.datasetPreview, { body: body }).then(function onDatasetPreview(payload) {
          if (!state.datasetDialog.open) return null
          state.datasetDialog = Object.assign({}, state.datasetDialog, {
            status: 'ready',
            error: null,
            preview: payload,
            sheet: payload && payload.sheet ? payload.sheet : null,
            path: payload && typeof payload.path === 'string' ? payload.path : state.datasetDialog.path,
          })
          emit()
          return payload
        }, function onDatasetPreviewFailure(error) {
          if (isAbortError(error)) return null
          const normalized = normalizeError(error)
          state.datasetDialog = Object.assign({}, state.datasetDialog, {
            status: 'error',
            error: normalized,
            preview: null,
          })
          emit()
          return null
        })
      }

      function selectDatasetEntry(entry) {
        if (!entry || typeof entry.path !== 'string' || entry.path === '') return Promise.resolve(null)
        if (entry.isDir === true) return loadDatasetEntries(entry.path)
        if (!isDatasetFileName(entry.name)) return Promise.resolve(null)
        return requestDatasetPreview({ path: entry.path })
      }

      function datasetUp() {
        const dir = state.datasetDialog.browseDir || state.cwd || ''
        if (dir === '') return Promise.resolve(null)
        return loadDatasetEntries(dirname(dir))
      }

      function refreshDatasetEntries() {
        return loadDatasetEntries(state.datasetDialog.browseDir || state.cwd || '')
      }

      function readDatasetPath() {
        return requestDatasetPreview({ path: state.datasetDialog.path })
      }

      function setDatasetSheet(name) {
        if (typeof name !== 'string' || name === '') return Promise.resolve(null)
        return requestDatasetPreview({ sheet: name })
      }

      function setDatasetHeader(value) {
        return requestDatasetPreview({ header: value === true })
      }

      function setDatasetDelimiter(value) {
        return requestDatasetPreview({ delimiter: typeof value === 'string' && value !== '' ? value : null })
      }

      function datasetImportCode() {
        const preview = state.datasetDialog.preview
        if (!preview || !preview.import || typeof preview.import.code !== 'string') return ''
        return preview.import.code
      }

      function insertDatasetCode() {
        const snippet = datasetImportCode()
        if (snippet === '') {
          pushNotice('dataset.unsupported', 'warn')
          emit()
          return Promise.resolve(false)
        }
        const previousCode = state.code
        let nextCode = previousCode
        if (nextCode === '') nextCode = snippet + '\n'
        else if (nextCode.charAt(nextCode.length - 1) === '\n') nextCode = nextCode + snippet + '\n'
        else nextCode = nextCode + '\n\n' + snippet + '\n'
        const preview = state.datasetDialog.preview
        state.code = nextCode
        if (state.filePath !== null) state.dirty = state.code !== state.savedCode
        else {
          state.dirty = false
          scheduleDraftSave()
        }
        resetSelection()
        state.datasetDialog = Object.assign({}, state.datasetDialog, { open: false })
        setUi({ notice: { key: 'dataset.inserted', params: null, tone: 'success', retry: false } })
        emit()
        reportDiag('dataset-insert', {
          language: state.languageId,
          rows: preview && typeof preview.totalRows === 'number' ? preview.totalRows : 0,
        })
        return Promise.resolve(true)
      }

      function copyDatasetCode() {
        return copyText(datasetImportCode(), 'dataset.copied')
      }

      // ── v3: export report (CONTRACT-V3 §2.3) ────────────────────────────
      function hasExportableContent() {
        return String(state.code).trim() !== '' || state.output.stdout !== '' || state.output.stderr !== ''
      }

      function exportPlotsPayload() {
        const plots = []
        for (let index = 0; index < state.plots.items.length; index += 1) {
          const item = state.plots.items[index]
          if (!item || typeof item.path !== 'string' || item.path === '') continue
          plots.push({
            path: item.path,
            name: typeof item.name === 'string' ? item.name : basename(item.path),
            source: item.source === 'cwd' ? 'cwd' : 'run',
          })
        }
        return plots
      }

      function openExportDialog() {
        if (state.exportState.status === 'loading') return
        const include = state.exportDialog.include
        const hasPlots = state.plots.items.length > 0
        state.exportDialog = {
          open: true,
          format: state.exportDialog.format || 'docx',
          plotPlacement: state.exportDialog.plotPlacement === 'under-code' ? 'under-code' : 'section',
          include: {
            code: include.code !== false,
            output: include.output !== false,
            plots: hasPlots && include.plots !== false,
            summary: include.summary !== false,
          },
        }
        emit()
      }

      function closeExportDialog() {
        if (!state.exportDialog.open) return
        state.exportDialog = Object.assign({}, state.exportDialog, { open: false })
        emit()
      }

      function setExportFormat(format) {
        const allowed = ['docx', 'md', 'html', 'all']
        if (allowed.indexOf(format) < 0) return
        state.exportDialog = Object.assign({}, state.exportDialog, { format: format })
        emit()
      }

      function setExportPlotPlacement(value) {
        if (value !== 'section' && value !== 'under-code') return
        state.exportDialog = Object.assign({}, state.exportDialog, { plotPlacement: value })
        emit()
      }

      function toggleExportInclude(key) {
        if (['code', 'output', 'plots', 'summary'].indexOf(key) < 0) return
        const include = Object.assign({}, state.exportDialog.include)
        include[key] = include[key] === false
        state.exportDialog = Object.assign({}, state.exportDialog, { include: include })
        emit()
      }

      function exportReport() {
        if (state.exportState.status === 'loading') return Promise.resolve()
        if (!hasExportableContent()) {
          pushNotice('export.empty', 'warn')
          emit()
          return Promise.resolve()
        }
        const fallbackCwd = state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : ''
        const body = {
          language: state.languageId,
          mode: state.run.mode || (state.filePath !== null ? 'file' : 'buffer'),
          file: state.filePath !== null ? (state.run.file || state.filePath) : null,
          cwd: state.cwd !== '' ? state.cwd : fallbackCwd,
          command: state.run.command || '',
          code: state.code,
          stdout: state.output.stdout,
          stderr: state.output.stderr,
          exitCode: typeof state.run.exitCode === 'number' ? state.run.exitCode : null,
          durationMs: typeof state.run.durationMs === 'number' ? state.run.durationMs : null,
          startedAt: state.run.startedAt > 0 ? state.run.startedAt : null,
          summary: typeof state.explain.lastSummary === 'string' && state.explain.lastSummary !== ''
            ? state.explain.lastSummary
            : null,
          plots: exportPlotsPayload(),
          format: state.exportDialog.format || 'docx',
          plotPlacement: state.exportDialog.plotPlacement === 'under-code' ? 'under-code' : 'section',
          include: state.exportDialog.include,
          name:
            state.filePath !== null
              ? String(basename(state.filePath)).replace(/\.[^.]+$/, '')
              : '未命名',
        }
        state.exportDialog = Object.assign({}, state.exportDialog, { open: false })
        state.exportState = {
          status: 'loading',
          folder: state.exportState.folder,
          reportPath: '',
          htmlPath: '',
          error: null,
          savedAt: 0,
        }
        emit()
        return requestWithToken('POST', API.export, { body: body }).then(function onExported(payload) {
          const folder = payload && typeof payload.folder === 'string' ? payload.folder : ''
          state.exportState = {
            status: 'ready',
            folder: folder,
            reportPath: payload && typeof payload.reportPath === 'string' ? payload.reportPath : '',
            htmlPath: payload && typeof payload.htmlPath === 'string' ? payload.htmlPath : '',
            docxPath: payload && typeof payload.docxPath === 'string' ? payload.docxPath : '',
            error: null,
            savedAt: Date.now(),
          }
          setUi({
            notice: {
              key: 'export.done',
              params: { folder: folder },
              tone: 'success',
              retry: false,
              copyPath: folder,
              copyKey: 'export.copied',
            },
          })
          emit()
          reportDiag('export', { ok: true, plots: body.plots.length })
          return { ok: true, folder: folder }
        }, function onExportFailure(error) {
          if (isAbortError(error)) return { ok: false }
          const normalized = normalizeError(error)
          state.exportState = {
            status: 'error',
            folder: state.exportState.folder,
            reportPath: '',
            htmlPath: '',
            error: normalized,
            savedAt: 0,
          }
          const mapped = (normalized.code === 'bad-cwd' || normalized.code === 'bad-path' || normalized.code === 'too-large')
            ? noticeSpecForError(normalized)
            : null
          if (mapped) {
            setNoticeSpec(mapped)
          } else {
            setNoticeSpec({
              key: 'export.failed',
              params: { detail: clampDetail(normalized.message) || String(normalized.code) },
              tone: 'error',
              retry: false,
            })
          }
          emit()
          reportDiag('export', { ok: false, code: normalized.code })
          return { ok: false }
        })
      }

      function showExportNotice() {
        if (state.exportState.folder === '') return
        setUi({
          notice: {
            key: 'export.done',
            params: { folder: state.exportState.folder },
            tone: 'success',
            retry: false,
            copyPath: state.exportState.folder,
            copyKey: 'export.copied',
          },
        })
        emit()
      }

      // ── v3: plot saving (CONTRACT-V3 §2.4) ──────────────────────────────
      /** Default destination: the open code file's folder, else the working dir. */
      function plotSaveTargetDir() {
        if (state.filePath !== null) {
          const directory = dirname(state.filePath)
          if (typeof directory === 'string' && directory !== '') return directory
        }
        const fallbackCwd = state.env.data && typeof state.env.data.defaultCwd === 'string' ? state.env.data.defaultCwd : ''
        return state.cwd !== '' ? state.cwd : fallbackCwd
      }

      function savePlotItems(items) {
        if (state.plotSave.status === 'loading') return Promise.resolve()
        const plots = []
        for (let index = 0; index < (items || []).length; index += 1) {
          const item = items[index]
          if (!item || typeof item.path !== 'string' || item.path === '') continue
          plots.push({
            path: item.path,
            name: typeof item.name === 'string' && item.name !== '' ? item.name : basename(item.path),
          })
        }
        if (plots.length === 0) return Promise.resolve({ ok: false, reason: 'empty' })
        const targetDir = plotSaveTargetDir()
        if (targetDir === '') {
          setNoticeSpec({ key: 'error.badPath', params: { detail: '' }, tone: 'error', retry: false })
          emit()
          return Promise.resolve({ ok: false, reason: 'no-target' })
        }
        state.plotSave = { status: 'loading', targetDir: targetDir, saved: state.plotSave.saved, error: null }
        emit()
        return requestWithToken('POST', API.savePlots, { body: { plots: plots, targetDir: targetDir } }).then(function onSaved(payload) {
          const saved = payload && Array.isArray(payload.saved) ? payload.saved.slice() : []
          const directory = payload && typeof payload.targetDir === 'string' && payload.targetDir !== ''
            ? payload.targetDir
            : targetDir
          state.plotSave = { status: 'ready', targetDir: directory, saved: saved, error: null }
          setUi({
            notice: {
              key: 'plots.saved',
              params: { count: saved.length, dir: directory },
              tone: 'success',
              retry: false,
              copyPath: directory,
              copyKey: 'export.copied',
            },
          })
          emit()
          reportDiag('save-plots', { ok: true, count: saved.length })
          return { ok: true, saved: saved }
        }, function onSaveFailed(error) {
          if (isAbortError(error)) return { ok: false }
          const normalized = normalizeError(error)
          state.plotSave = { status: 'error', targetDir: targetDir, saved: [], error: normalized }
          const mapped = noticeSpecForError(normalized)
          if (mapped) {
            setNoticeSpec(mapped)
          } else {
            setNoticeSpec({
              key: 'plots.saveFailed',
              params: { detail: clampDetail(normalized.message) || String(normalized.code) },
              tone: 'error',
              retry: false,
            })
          }
          emit()
          reportDiag('save-plots', { ok: false, code: normalized.code })
          return { ok: false }
        })
      }

      function savePlotAt(index) {
        const item = state.plots.items[index]
        if (!item) return Promise.resolve({ ok: false, reason: 'missing' })
        return savePlotItems([item])
      }

      function saveAllPlots() {
        return savePlotItems(state.plots.items)
      }

      function saveLightboxPlot() {
        const lightbox = state.ui.lightbox
        if (!lightbox || lightbox.items.length === 0) return Promise.resolve({ ok: false, reason: 'closed' })
        const index = Math.max(0, Math.min(lightbox.index, lightbox.items.length - 1))
        const item = lightbox.items[index]
        if (!item) return Promise.resolve({ ok: false, reason: 'missing' })
        return savePlotItems([{ path: item.path, name: item.name }])
      }

      function showPlotSaveNotice() {
        if (state.plotSave.status !== 'ready' || state.plotSave.targetDir === '') return
        setUi({
          notice: {
            key: 'plots.saved',
            params: { count: state.plotSave.saved.length, dir: state.plotSave.targetDir },
            tone: 'success',
            retry: false,
            copyPath: state.plotSave.targetDir,
            copyKey: 'export.copied',
          },
        })
        emit()
      }

      // ── plots / artifacts ───────────────────────────────────────────────
      function stopArtifactTimer() {
        if (artifactTimer !== null) {
          clearTimeout(artifactTimer)
          artifactTimer = null
        }
      }

      function scheduleArtifactPoll(delay) {
        if (surfaceCount <= 0) return
        stopArtifactTimer()
        artifactTimer = setTimeout(function onArtifactTimer() {
          artifactTimer = null
          const runId = state.run.runId
          if (runId === null || runId === undefined || !state.run.running) return
          loadArtifacts(runId).then(function afterArtifacts() {
            if (state.run.running) scheduleArtifactPoll(ARTIFACT_POLL_MS)
          })
        }, typeof delay === 'number' ? delay : ARTIFACT_POLL_MS)
      }

      function normalizePlotItems(payload) {
        const items = []
        if (!payload || !Array.isArray(payload.plots)) return items
        for (let index = 0; index < payload.plots.length; index += 1) {
          const raw = payload.plots[index]
          if (!raw || typeof raw.path !== 'string' || raw.path === '') continue
          items.push({
            path: raw.path,
            name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : basename(raw.path),
            source: raw.source === 'cwd' ? 'cwd' : 'run',
            size: typeof raw.size === 'number' ? raw.size : null,
            mtimeMs: typeof raw.mtimeMs === 'number' ? raw.mtimeMs : null,
            ext: typeof raw.ext === 'string' && raw.ext !== '' ? raw.ext : extensionOf(raw.path),
          })
        }
        return items
      }

      function countRunSource(items) {
        let count = 0
        for (let index = 0; index < items.length; index += 1) {
          if (items[index].source === 'run') count += 1
        }
        return count
      }

      function revokeAllPlotUrls(shouldEmit) {
        const urls = state.plots.urls
        const keys = Object.keys(urls)
        for (let index = 0; index < keys.length; index += 1) {
          const entry = urls[keys[index]]
          if (entry && entry.url) revokeObjectUrl(entry.url)
        }
        setPlots({ urls: {} })
        if (shouldEmit !== false) emit()
      }

      function hydratePlotUrls(runId, seq) {
        if (blobAbort !== null) {
          try { blobAbort.abort() } catch (error) { /* ignore */ }
          blobAbort = null
        }
        const controller = new AbortController()
        blobAbort = controller
        const items = state.plots.items
        const jobs = []
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]
          if (IMAGE_EXTS.indexOf(String(item.ext || '').toLowerCase()) < 0) continue
          const existing = state.plots.urls[item.path]
          if (existing && existing.url && existing.size === item.size && existing.mtimeMs === item.mtimeMs) continue
          jobs.push(hydrateOnePlot(item, controller.signal, runId, seq))
        }
        if (jobs.length === 0) return Promise.resolve()
        return Promise.all(jobs).then(function settled() { return null }, function settledFailure() { return null })
      }

      function hydrateOnePlot(item, signal, runId, seq) {
        return requestBlob(API.blob + '?path=' + encodeURIComponent(item.path), { signal: signal }).then(function onBlob(result) {
          if (artifactSeq !== seq || signal.aborted) return null
          const url = objectUrlFromBlob(result.blob)
          if (url === null) return null
          const previous = state.plots.urls[item.path]
          if (previous && previous.url) revokeObjectUrl(previous.url)
          setPlots({
            urls: Object.assign({}, state.plots.urls, {
              [item.path]: { url: url, size: item.size, mtimeMs: item.mtimeMs },
            }),
          })
          emit()
          return null
        }, function onBlobFailure(error) {
          if (isAbortError(error)) return null
          return null
        })
      }

      function loadArtifacts(runId) {
        if (runId === null || runId === undefined || runId === '') return Promise.resolve()
        const seq = artifactSeq + 1
        artifactSeq = seq
        if (artifactAbort !== null) {
          try { artifactAbort.abort() } catch (error) { /* ignore */ }
        }
        const controller = new AbortController()
        artifactAbort = controller
        if (state.plots.items.length === 0) {
          setPlots({ status: 'loading', error: null })
          emit()
        }
        return requestWithToken('GET', API.artifacts + '?runId=' + encodeURIComponent(runId), { signal: controller.signal }).then(function onArtifacts(payload) {
          if (artifactAbort === controller) artifactAbort = null
          if (seq !== artifactSeq) return null
          const items = normalizePlotItems(payload)
          const previousRunCount = countRunSource(state.plots.items)
          const nextUrls = {}
          const staleKeys = []
          const urls = state.plots.urls
          const keys = Object.keys(urls)
          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index]
            let found = null
            for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
              if (items[itemIndex].path === key) {
                found = items[itemIndex]
                break
              }
            }
            if (found === null) {
              staleKeys.push(key)
            } else if (urls[key] && urls[key].url && urls[key].size === found.size && urls[key].mtimeMs === found.mtimeMs) {
              nextUrls[key] = urls[key]
            } else {
              staleKeys.push(key)
            }
          }
          for (let index = 0; index < staleKeys.length; index += 1) {
            const old = urls[staleKeys[index]]
            if (old && old.url) revokeObjectUrl(old.url)
          }
          const runCount = countRunSource(items)
          setPlots({
            items: items,
            status: 'ready',
            error: null,
            runId: runId,
            truncated: payload && payload.truncated === true,
            urls: nextUrls,
          })
          if (runCount > previousRunCount) {
            if (state.editorFocused) {
              setUi({ plotsUnseen: (state.ui.plotsUnseen || 0) + (runCount - previousRunCount) })
            } else {
              setUi({ bottomTab: 'plots', plotsUnseen: 0 })
              storageSet(STORAGE_BOTTOM_TAB, 'plots')
            }
          }
          emit()
          reportDiag('artifacts', {
            runId: runId,
            count: items.length,
            runSourceCount: runCount,
            cwdSourceCount: Math.max(0, items.length - runCount),
          })
          return hydratePlotUrls(runId, seq)
        }, function onArtifactsFailure(error) {
          if (artifactAbort === controller) artifactAbort = null
          if (seq !== artifactSeq || isAbortError(error)) return null
          const normalized = normalizeError(error)
          setPlots({ status: 'error', error: normalized })
          emit()
          return null
        })
      }

      function refreshArtifacts() {
        const runId = state.run.runId !== null ? state.run.runId : state.plots.runId
        revokeAllPlotUrls(false)
        setUi({ lightbox: null })
        if (runId === null || runId === undefined) {
          setPlots({ items: [], status: 'idle', error: null, runId: null, urls: {} })
          emit()
          return Promise.resolve()
        }
        return loadArtifacts(runId)
      }

      function markPlotsSeen() {
        if (state.ui.plotsUnseen === 0) return
        setUi({ plotsUnseen: 0 })
        emit()
      }

      function openPlot(index) {
        const items = state.plots.items.map(function toLightbox(item) {
          const entry = state.plots.urls[item.path]
          return {
            path: item.path,
            name: item.name,
            source: item.source,
            ext: item.ext,
            size: item.size,
            url: entry && entry.url ? entry.url : null,
          }
        })
        if (items.length === 0) return
        const bounded = Math.max(0, Math.min(items.length - 1, index))
        setUi({ lightbox: { items: items, index: bounded }, plotsUnseen: 0 })
        emit()
      }

      function closeLightbox() {
        setUi({ lightbox: null })
        emit()
      }

      function stepLightbox(delta) {
        const lightbox = state.ui.lightbox
        if (!lightbox || lightbox.items.length === 0) return
        const next = (lightbox.index + delta + lightbox.items.length) % lightbox.items.length
        setUi({ lightbox: { items: lightbox.items, index: next } })
        emit()
      }

      function copyLightboxPath() {
        const lightbox = state.ui.lightbox
        if (!lightbox || lightbox.items.length === 0) return Promise.resolve(false)
        const item = lightbox.items[lightbox.index]
        let clipboard = null
        try {
          clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        } catch (error) {
          clipboard = null
        }
        if (!clipboard || typeof clipboard.writeText !== 'function' || typeof item.path !== 'string') {
          pushNotice('error.copyFailed', 'error')
          emit()
          return Promise.resolve(false)
        }
        return clipboard.writeText(item.path).then(function onCopied() {
          pushNotice('plots.copied', 'success')
          emit()
          return true
        }, function onCopyFailure() {
          pushNotice('error.copyFailed', 'error')
          emit()
          return false
        })
      }

      // ── UI actions ──────────────────────────────────────────────────────
      function setBottomTab(tab) {
        const next = tab === 'plots' || tab === 'files' ? tab : 'console'
        storageSet(STORAGE_BOTTOM_TAB, next)
        setUi({ bottomTab: next, plotsUnseen: next === 'plots' ? 0 : state.ui.plotsUnseen })
        emit()
      }

      function setRailTab(tab) {
        setUi({ railTab: tab === 'plots' ? 'plots' : 'files' })
        emit()
      }

      function setSplitRatio(ratio) {
        setUi({ splitRatio: clampRatio(ratio) })
        emit()
      }

      function persistSplitRatio() {
        storageSet(STORAGE_SPLIT, String(state.ui.splitRatio))
      }

      function dismissNotice() {
        setUi({ notice: null })
        emit()
      }

      // ── mounting: surface refcount + polling attach/detach ──────────────
      function abortInFlight() {
        if (bootAbort !== null) {
          try { bootAbort.abort() } catch (error) { /* ignore */ }
          bootAbort = null
        }
        abortPollRequest()
        if (artifactAbort !== null) {
          try { artifactAbort.abort() } catch (error) { /* ignore */ }
          artifactAbort = null
        }
        if (blobAbort !== null) {
          try { blobAbort.abort() } catch (error) { /* ignore */ }
          blobAbort = null
        }
      }

      function stopAllTimers() {
        clearPollTimer()
        stopArtifactTimer()
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
      }

      function attach() {
        surfaceCount += 1
        if (surfaceCount === 1) {
          ensureBoot(false)
          if (state.run.runId !== null || state.run.phase === 'starting') {
            if (state.run.running) {
              schedulePoll(0)
              scheduleArtifactPoll(0)
            } else if (!state.run.finished) {
              schedulePoll(0)
            }
          }
          if (state.plots.runId !== null && state.run.runId === state.plots.runId) {
            // Object URLs are revoked when the last surface unmounts; refetch the
            // artifact list on re-attach so thumbnails come back.
            let needsArtifacts = state.plots.items.length === 0
            if (!needsArtifacts) {
              for (let index = 0; index < state.plots.items.length; index += 1) {
                const item = state.plots.items[index]
                if (IMAGE_EXTS.indexOf(String(item.ext || '').toLowerCase()) >= 0 && !state.plots.urls[item.path]) {
                  needsArtifacts = true
                  break
                }
              }
            }
            if (needsArtifacts) loadArtifacts(state.plots.runId)
          }
          if (state.cwd !== '' && state.files.status === 'idle') loadFiles(state.cwd)
        }
        return function detach() {
          surfaceCount = Math.max(0, surfaceCount - 1)
          if (surfaceCount === 0) {
            stopAllTimers()
            abortInFlight()
            flushDraft()
            state.editorFocused = false
            setUi({ lightbox: null })
            revokeAllPlotUrls(false)
          }
        }
      }

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        attach: attach,
        actions: {
          ensureBoot: ensureBoot,
          retry: retry,
          setCwd: setCwd,
          commitCwd: commitCwd,
          pickCwd: pickCwd,
          setLanguage: setLanguage,
          setCode: setCode,
          setCursor: setCursor,
          setEditorFocused: setEditorFocused,
          loadFiles: loadFiles,
          filesRefresh: filesRefresh,
          filesUp: filesUp,
          openEntry: openEntry,
          openPathNow: openPathNow,
          requestOpenPath: requestOpenPath,
          saveFile: saveFile,
          openSaveAs: openSaveAs,
          setSaveAsName: setSaveAsName,
          cancelSaveAs: cancelSaveAs,
          confirmSaveAs: confirmSaveAs,
          confirmOverwrite: confirmOverwrite,
          cancelConflict: cancelConflict,
          newFile: newFile,
          confirmDiscard: confirmDiscard,
          cancelDiscard: cancelDiscard,
          run: run,
          runSelection: runSelection,
          stop: stop,
          clearOutput: clearOutput,
          copyOutput: copyOutput,
          setSelection: setSelection,
          openExplain: runExplain,
          retryExplain: runExplain,
          closeExplain: closeExplain,
          insertExplanation: insertExplanation,
          undoExplanationInsert: undoExplanationInsert,
          copyExplanation: copyExplanation,
          exportReport: exportReport,
          openExportDialog: openExportDialog,
          openPacksDialog: openPacksDialog,
          closePacksDialog: closePacksDialog,
          refreshPacks: refreshPacks,
          togglePack: togglePack,
          closeExportDialog: closeExportDialog,
          setExportFormat: setExportFormat,
          setExportPlotPlacement: setExportPlotPlacement,
          openDatasetDialog: openDatasetDialog,
          closeDatasetDialog: closeDatasetDialog,
          setDatasetPath: setDatasetPath,
          readDatasetPath: readDatasetPath,
          selectDatasetEntry: selectDatasetEntry,
          browseDatasetDir: loadDatasetEntries,
          datasetUp: datasetUp,
          refreshDatasetEntries: refreshDatasetEntries,
          setDatasetSheet: setDatasetSheet,
          setDatasetHeader: setDatasetHeader,
          setDatasetDelimiter: setDatasetDelimiter,
          insertDatasetCode: insertDatasetCode,
          copyDatasetCode: copyDatasetCode,
          toggleExportInclude: toggleExportInclude,
          showExportNotice: showExportNotice,
          savePlotAt: savePlotAt,
          saveAllPlots: saveAllPlots,
          saveLightboxPlot: saveLightboxPlot,
          showPlotSaveNotice: showPlotSaveNotice,
          copyNoticePath: copyNoticePath,
          refreshArtifacts: refreshArtifacts,
          markPlotsSeen: markPlotsSeen,
          openPlot: openPlot,
          closeLightbox: closeLightbox,
          stepLightbox: stepLightbox,
          copyLightboxPath: copyLightboxPath,
          setBottomTab: setBottomTab,
          setRailTab: setRailTab,
          setSplitRatio: setSplitRatio,
          persistSplitRatio: persistSplitRatio,
          dismissNotice: dismissNotice,
        },
      }
    })()

    // ── React bindings for the shared store ────────────────────────────────
    function useWorkbenchSnapshot() {
      const pair = React.useState(function initialWorkbenchSnapshot() { return store.getSnapshot() })
      const setSnapshot = pair[1]
      React.useEffect(function subscribeWorkbenchStore() {
        return store.subscribe(function onWorkbenchChange(snapshot) { setSnapshot(snapshot) })
      }, [])
      return pair[0]
    }

    /** Media-query hook used to move the page rail into the bottom tab strip when narrow. */
    function useMediaQuery(query) {
      const pair = React.useState(function initialMatch() {
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            return window.matchMedia(query).matches === true
          }
        } catch (error) {
          return false
        }
        return false
      })
      const matches = pair[0]
      const setMatches = pair[1]
      React.useEffect(function subscribeMediaQuery() {
        let mql = null
        try {
          if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
          mql = window.matchMedia(query)
        } catch (error) {
          return undefined
        }
        const onChange = function onMediaChange(event) { setMatches(event && event.matches === true) }
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', onChange)
          return function removeMediaListener() {
            try { mql.removeEventListener('change', onChange) } catch (error) { /* ignore */ }
          }
        }
        if (typeof mql.addListener === 'function') {
          mql.addListener(onChange)
          return function removeLegacyMediaListener() {
            try { mql.removeListener(onChange) } catch (error) { /* ignore */ }
          }
        }
        return undefined
      }, [query])
      return matches
    }

    // ── Styles: one <style> element rendered inside each surface root ──────
    // Only --dsw-alias-* tokens and --dsh-frame-top-clearance carry colour or
    // spacing; the only literal palette keywords are currentColor/inherit.
    const MONO_FONT = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace'
    const PANEL_CSS = [
      // surface roots
      '.dcr-surface{position:relative;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit;}',
      '.dcr-mode-page{background:var(--dsw-alias-bg-base);padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 0;}',
      '.dcr-mode-pane{background:transparent;padding:8px;gap:8px;font-size:12px;line-height:18px;}',
      '.dcr-pageShell{box-sizing:border-box;flex:1 1 0;min-height:0;min-width:0;display:flex;flex-direction:column;gap:12px;padding:0 max(max(16px,min(4vw,48px)),50% - 620px) 20px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}',
      '.dcr-paneShell{flex:1 1 0;min-height:0;min-width:0;display:flex;flex-direction:column;gap:8px;overflow:hidden;}',
      // header (page mode)
      '.dcr-header{flex:none;display:flex;align-items:flex-start;gap:16px;min-width:0;}',
      '.dcr-headText{flex:1 1 auto;min-width:0;}',
      '.dcr-title{margin:0;font-size:20px;line-height:28px;font-weight:600;}',
      '.dcr-subtitle{margin:2px 0 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary);}',
      '.dcr-hostChip{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;}',
      '.dcr-hostChip[data-state="ready"]{color:var(--dsw-alias-state-success-primary);}',
      '.dcr-hostChip[data-state="offline"]{color:var(--dsw-alias-state-error-primary);}',
      '.dcr-hostChip[data-state="running"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dcr-chipDot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;}',
      // notices
      '.dcr-notice{flex:none;display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;}',
      '.dcr-notice[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dcr-notice[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dcr-notice[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dcr-noticeText{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;}',
      '.dcr-noticeClose{flex:none;width:20px;height:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;}',
      '.dcr-noticeClose:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dcr-noticeClose:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      // toolbar
      '.dcr-toolbar{flex:none;display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;}',
      '.dcr-toolbarRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;}',
      '.dcr-grow{flex:1 1 auto;min-width:0;}',
      '.dcr-fileChip{appearance:none;font:inherit;display:inline-flex;align-items:center;gap:6px;height:28px;min-width:0;max-width:100%;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:default;overflow:hidden;}',
      '.dcr-fileChipName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px;}',
      '.dcr-dirtyDot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);}',
      '.dcr-field{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.dcr-fieldLanguage{flex:0 1 auto;}',
      '.dcr-fieldCwd{flex:1 1 200px;min-width:120px;}',
      '.dcr-label{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
      '.dcr-inlineRow{display:flex;align-items:center;gap:6px;min-width:0;}',
      '.dcr-select,.dcr-input{box-sizing:border-box;height:28px;min-width:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;}',
      '.dcr-select{padding-right:22px;}',
      '.dcr-cwdInput{flex:1 1 auto;}',
      '.dcr-select:focus-visible,.dcr-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary);}',
      '.dcr-select:disabled,.dcr-input:disabled{opacity:.6;}',
      '.dcr-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-left:auto;}',
      '.dcr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,color .12s ease;}',
      '.dcr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}',
      '.dcr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.dcr-btn:disabled{opacity:.5;cursor:default;}',
      '.dcr-btnSmall{height:22px;padding:0 8px;font-size:11px;}',
      '.dcr-btnPrimary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600;}',
      '.dcr-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);filter:brightness(1.08);}',
      '.dcr-btnStop:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.dcr-btnStop:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-state-error-primary);}',
      // editor
      '.dcr-editor{box-sizing:border-box;display:flex;flex:1 1 0;min-height:120px;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
      '.dcr-editor:focus-within{border-color:var(--dsw-alias-brand-primary);}',
      '.dcr-gutter{flex:none;width:44px;margin:0;padding:8px 4px 8px 0;overflow:hidden;text-align:right;font-family:' + MONO_FONT + ';font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l1);white-space:pre;user-select:none;}',
      '.dcr-textarea{box-sizing:border-box;flex:1 1 0;width:100%;min-width:0;min-height:0;margin:0;padding:8px 10px;border:0;outline:none;resize:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO_FONT + ';font-size:13px;line-height:19px;tab-size:2;white-space:pre;overflow:auto;}',
      '.dcr-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:1;}',
      '.dcr-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      // workspace split
      '.dcr-mainCol{flex:1 1 0;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;}.dcr-mode-pane .dcr-editor{min-height:80px;}',
      '.dcr-divider{flex:none;height:8px;display:flex;align-items:center;justify-content:center;cursor:row-resize;background:transparent;}',
      '.dcr-dividerHandle{width:36px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);}',
      '.dcr-divider:hover .dcr-dividerHandle,.dcr-divider:focus-visible .dcr-dividerHandle{background:var(--dsw-alias-brand-primary);}',
      '.dcr-divider:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      // bottom panel + tabs
      '.dcr-bottom{flex:none;display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
      '.dcr-tabStrip{flex:none;display:flex;align-items:stretch;gap:2px;padding:3px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;}',
      '.dcr-tab{appearance:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-bottom:2px solid transparent;padding:3px 9px 4px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;border-radius:6px 6px 0 0;white-space:nowrap;}',
      '.dcr-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dcr-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}',
      '.dcr-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.dcr-tabBadge{min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:10px;line-height:15px;font-weight:600;text-align:center;}',
      '.dcr-tabGlyph{display:inline-flex;flex:none;color:currentColor;}',
      '.dcr-bottomBody{flex:1 1 0;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;}',
      // console
      '.dcr-console{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      '.dcr-consoleHead{flex:none;display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.dcr-consoleTitle{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12px;}',
      '.dcr-consoleActions{margin-left:auto;display:flex;align-items:center;gap:4px;}',
      '.dcr-outPre{box-sizing:border-box;flex:1 1 0;min-height:0;margin:0;padding:8px 10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO_FONT + ';font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;}',
      '.dcr-outPre:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.dcr-outStdout{display:block;}',
      '.dcr-outStderr{display:block;color:var(--dsw-alias-state-error-primary);}',
      '.dcr-outEmpty{display:block;color:var(--dsw-alias-label-secondary);font-style:italic;white-space:pre-wrap;}',
      '.dcr-runStatus{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;padding:3px 8px 5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);}',
      // page grid + rail
      '.dcr-pageGrid{flex:1 1 0;min-height:0;display:grid;grid-template-columns:minmax(200px,320px) minmax(0,1fr);gap:12px;}',
      '.dcr-rail{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
      '.dcr-railBody{flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      '.dcr-railTabs{flex:none;display:flex;align-items:stretch;gap:2px;padding:3px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      // files panel
      '.dcr-files{display:flex;flex-direction:column;flex:1 1 0;min-height:0;min-width:0;overflow:hidden;}',
      '.dcr-filesHead{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}',
      '.dcr-breadcrumb{display:flex;align-items:center;gap:1px;min-width:0;flex:1 1 100px;overflow:hidden;}',
      '.dcr-crumb{appearance:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;padding:1px 3px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;}',
      '.dcr-crumb:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dcr-crumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.dcr-crumbSep{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none;}',
      '.dcr-filesList{flex:1 1 0;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:3px;}',
      '.dcr-fileRow{appearance:none;font:inherit;text-align:left;display:flex;align-items:center;gap:7px;min-width:0;padding:3px 7px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px;}',
      '.dcr-fileRow:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dcr-fileRow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.dcr-fileRow[data-dot="true"]{opacity:.62;}',
      '.dcr-fileIcon{flex:none;width:13px;display:inline-flex;color:var(--dsw-alias-label-secondary);}',
      '.dcr-fileName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dcr-fileMeta{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;}',
      '.dcr-panelEmpty{padding:14px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;}',
      // plots
      '.dcr-plots{display:flex;flex-direction:column;flex:1 1 0;min-height:0;min-width:0;overflow:hidden;}',
      '.dcr-plotsHead{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dcr-plotsTitle{font-weight:600;font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dcr-plotsCount{color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.dcr-plotHeadActions{margin-left:auto;display:flex;align-items:center;gap:4px;}',
      '.dcr-plotsGrid{flex:1 1 0;min-height:0;overflow:auto;display:grid;gap:8px;padding:8px;align-content:start;}',
      '.dcr-mode-page .dcr-plotsGrid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:12px;}',
      '.dcr-mode-pane .dcr-plotsGrid{grid-template-columns:repeat(2,minmax(0,1fr));}',
      '.dcr-plotCard{appearance:none;font:inherit;text-align:left;display:flex;flex-direction:column;gap:4px;padding:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0;}',
      '.dcr-plotCard:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.dcr-plotCard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.dcr-plotThumb{display:block;width:100%;aspect-ratio:4/3;object-fit:contain;background:var(--dsw-alias-bg-base);border-radius:5px;}',
      '.dcr-plotPlaceholder{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:4/3;padding:6px;background:var(--dsw-alias-bg-base);border-radius:5px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;text-align:center;overflow:hidden;word-break:break-all;}',
      '.dcr-plotCaption{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:15px;}',
      '.dcr-plotName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dcr-plotSource{flex:none;padding:0 5px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:9px;line-height:14px;}',
      // status bar
      '.dcr-statusBar{flex:none;display:flex;flex-wrap:wrap;align-items:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;}.dcr-mode-pane .dcr-statusBar{flex-wrap:nowrap;overflow:hidden;}.dcr-mode-pane .dcr-statusItem{flex:0 1 auto;max-width:46%;padding:0 6px;}',
      '.dcr-statusItem{padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;}',
      '.dcr-statusItem:first-child{padding-left:0;}',
      '.dcr-statusItem+.dcr-statusItem{border-left:1px solid var(--dsw-alias-border-l1);}',
      '.dcr-statusStrong{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dcr-statusOk{color:var(--dsw-alias-state-success-primary);}',
      '.dcr-statusBad{color:var(--dsw-alias-state-error-primary);}',
      '.dcr-statusWarn{color:var(--dsw-alias-state-warn-primary);}',
      // inline dialogs
      '.dcr-inlineDialog{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.dcr-inlineDialog[data-tone="danger"]{border-color:var(--dsw-alias-state-error-primary);}',
      '.dcr-dialogTitle{font-weight:600;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}',
      '.dcr-dialogBody{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap;}',
      '.dcr-dialogRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:flex-end;}',
      '.dcr-dialogRow .dcr-input{flex:1 1 160px;}',
      '.dcr-datasetDialog{max-height:calc(100vh - 120px);overflow:auto;}',
      '.dcr-datasetPath{flex:1 1 260px;}',
      '.dcr-datasetBrowse{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dcr-datasetBrowseHead{justify-content:flex-start;}',
      '.dcr-datasetDir{overflow-wrap:anywhere;}',
      '.dcr-datasetFiles{display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);}',
      '.dcr-datasetEntry{box-sizing:border-box;max-width:100%;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:22px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dcr-datasetEntry:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dcr-datasetEntry[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dcr-datasetPreview{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.dcr-datasetControls{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;}',
      '.dcr-datasetTableWrap{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);}',
      '.dcr-datasetTable{border-collapse:collapse;width:100%;font-size:11px;line-height:16px;}',
      '.dcr-datasetTable th,.dcr-datasetTable td{border-bottom:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);padding:3px 8px;text-align:left;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}',
      '.dcr-datasetTable th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dcr-datasetTable tr:last-child td{border-bottom:0;}',
      '.dcr-datasetImport{display:flex;flex-direction:column;gap:4px;}',
      '.dcr-datasetCode{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO_FONT + ';font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto;}',
      '.dcr-datasetError{color:var(--dsw-alias-state-error-primary);}',
      // lightbox
      '.dcr-lightbox{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--dsw-alias-bg-overlay);}',
      '.dcr-lightboxHead{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-primary);min-width:0;}',
      '.dcr-lightboxName{font-weight:600;font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 100px;min-width:0;}',
      '.dcr-lightboxMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dcr-lightboxBody{flex:1 1 0;min-height:0;display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;}',
      '.dcr-lightboxImg{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.dcr-lightboxFallback{padding:20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;line-height:18px;overflow-wrap:anywhere;}',
      // crash fallback
      '.dcr-crashWrap{box-sizing:border-box;flex:none;padding:0 max(max(16px,min(4vw,48px)),50% - 620px) 20px;}',
      '.dcr-crash{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.dcr-crashTitle{margin:0;font-size:15px;line-height:22px;color:var(--dsw-alias-state-error-primary);}',
      '.dcr-crashHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.dcr-crashDetail{margin:0;max-height:160px;overflow:auto;font-family:' + MONO_FONT + ';font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;}',
      // v3: selection marker, hint strip, hidden labels
      '.dcr-marker{flex:none;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-size:10px;line-height:15px;white-space:nowrap;}',
      '.dcr-markerWarn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dcr-hintStrip{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;overflow-wrap:anywhere;}',
      '.dcr-srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
      // v3: plot cards (open button + hover save action + size)
      '.dcr-plotCard{position:relative;display:flex;flex-direction:column;gap:0;padding:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:0;}',
      '.dcr-plotCard:hover,.dcr-plotCard:focus-within{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}',
      '.dcr-plotCardOpen{appearance:none;font:inherit;text-align:left;display:flex;flex-direction:column;gap:4px;min-width:0;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;}',
      '.dcr-plotCardOpen:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px;}',
      '.dcr-plotSave{position:absolute;top:9px;right:9px;opacity:0;pointer-events:none;}',
      '.dcr-plotCard:hover .dcr-plotSave,.dcr-plotCard:focus-within .dcr-plotSave{opacity:1;pointer-events:auto;}',
      '.dcr-plotSize{flex:none;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:14px;}',
      '.dcr-plotSkeleton{width:100%;aspect-ratio:4/3;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);animation:dcrSkeletonPulse 1.2s ease-in-out infinite;}',
      '@keyframes dcrSkeletonPulse{0%,100%{opacity:1;}50%{opacity:.55;}}',
      // v3: AI explain dialog
      '.dcr-explainDialog{max-height:52vh;overflow:auto;}',
      '.dcr-explainHead{align-items:center;justify-content:space-between;}',
      '.dcr-explainHeadActions{display:flex;align-items:center;gap:4px;margin-left:auto;}',
      '.dcr-explainLoading{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
      '.dcr-spinner{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dcrSpin .8s linear infinite;}',
      '@keyframes dcrSpin{to{transform:rotate(360deg);}}',
      '.dcr-explainSummary{margin:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto;}',
      '.dcr-explainSummary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '.dcr-explainError{color:var(--dsw-alias-state-error-primary);}',
      '.dcr-explainInserted{color:var(--dsw-alias-state-success-primary);}',
      // v3: status-bar action chips
      '.dcr-statusAction{appearance:none;font:inherit;font-size:11px;line-height:16px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dcr-statusAction:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;}',
      '.dcr-statusAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
      '@media (prefers-reduced-motion:reduce){.dcr-plotSkeleton{animation:none;}.dcr-spinner{animation:none;}}',
      // responsive + motion
      '@media (max-width:720px){.dcr-mode-page{padding-top:calc(16px + var(--dsh-frame-top-clearance,0px));}.dcr-pageShell{padding-left:max(12px,min(4vw,32px));padding-right:max(12px,min(4vw,32px));}.dcr-title{font-size:18px;line-height:26px;}.dcr-pageGrid{grid-template-columns:minmax(0,1fr);}.dcr-rail{display:none;}.dcr-gutter{width:38px;}}',
      '@media (prefers-reduced-motion:reduce){.dcr-btn{transition:none;}}',
    ].join('')

    /** Header-toggle styles live outside the surface roots (conversation header). */
    const TOGGLE_CSS = [
      '.dcr-toggle{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dcr-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dcr-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '@media (prefers-reduced-motion:reduce){.dcr-toggle{transition:none;}}',
    ].join('')

    // ── Inline SVG glyphs (currentColor only) ──────────────────────────────
    function SidebarIcon(ownerProps) {
      const props = ownerProps || {}
      const size = typeof props.size === 'number' && isFinite(props.size) && props.size > 0 ? props.size : 16
      const active = props.active === true
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.6 : 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('path', { key: 'chevron', d: 'M3 3.25 7.75 8 3 12.75' }),
        h('path', { key: 'underscore', d: 'M9.25 12.75h4' }),
      ])
    }

    function RightbarGlyph(ownerProps) {
      const props = ownerProps || {}
      const size = typeof props.size === 'number' && isFinite(props.size) && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('rect', { key: 'frame', x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' }),
        h('path', { key: 'divider', d: 'M10 2.5v11' }),
      ])
    }

    function ConsoleGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'prompt', d: 'M2 3l2.5 3L2 9' }),
        h('path', { key: 'line', d: 'M6.5 9h3.5' }),
      ])
    }

    function PlotsGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'axis', d: 'M2 2v8h8' }),
        h('path', { key: 'curve', d: 'M3 8l2.5-3 2 1.5L10 3' }),
      ])
    }

    function FilesGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'folder', d: 'M2 3.5h3l1 1h4v4.5H2z' }),
      ])
    }

    function FolderGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'folder', d: 'M1.5 3h3.2l1 1H10.5v5.5h-9z' }),
      ])
    }

    function FileGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'page', d: 'M3 1.5h4l2 2v7H3z' }),
        h('path', { key: 'fold', d: 'M7 1.5v2h2' }),
      ])
    }

    function SelectionGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'frame', d: 'M2 2h3M7 2h3M2 10h3M7 10h3M2 2v3M10 2v3M2 7v3M10 7v3' }),
        h('path', { key: 'play', d: 'M4.6 4.4l3 1.6-3 1.6z' }),
      ])
    }

    function SparkleGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'big', d: 'M5 1.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z' }),
        h('path', { key: 'small', d: 'M9.4 7.4l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z' }),
      ])
    }

    function DocumentGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('path', { key: 'page', d: 'M2.5 1.5h4.5l2.5 2.5v6.5h-7z' }),
        h('path', { key: 'fold', d: 'M7 1.5v2.5h2.5' }),
        h('path', { key: 'lines', d: 'M4.2 6.2h3.6M4.2 8.2h2.6' }),
      ])
    }

    function DatasetGlyph() {
      return h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, [
        h('ellipse', { key: 'top', cx: '6', cy: '3', rx: '3.6', ry: '1.4' }),
        h('path', { key: 'left', d: 'M2.4 3v3c0 .8 1.6 1.4 3.6 1.4s3.6-.6 3.6-1.4V3' }),
        h('path', { key: 'bottom', d: 'M2.4 6v3c0 .8 1.6 1.4 3.6 1.4s3.6-.6 3.6-1.4V6' }),
      ])
    }

    // ── Error boundary: a throwing slot entry must not blank the slot ──────
    class WorkbenchBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error : new Error(String(error)) }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-code-runner] slot entry crashed', error, info && info.componentStack)
        } catch (ignored) {
          /* ignore logging failures */
        }
        try {
          reportDiag('surface-crash', {
            message: String((error && error.message) || error).slice(0, 500),
            stack: String((info && info.componentStack) || '').slice(0, 1200),
          })
        } catch (ignored) {
          /* diagnostics must never re-enter the boundary */
        }
      }

      render() {
        if (this.state.error === null) return this.props.children
        const translate = typeof this.props.t === 'function' ? this.props.t : t
        const detail = this.state.error && typeof this.state.error.message === 'string'
          ? this.state.error.message
          : String(this.state.error)
        return h('div', { className: 'dcr-crashWrap', role: 'alert' },
          h('div', { className: 'dcr-crash' },
            h('h2', { className: 'dcr-crashTitle' }, translate('error.crashed')),
            h('p', { className: 'dcr-crashHint' }, translate('error.crashedHint')),
            detail !== '' ? h('pre', { className: 'dcr-crashDetail' }, detail) : null))
      }
    }

    // ── Conversation-header toggle: opens/collapses the right sidebar ──────
    /**
     * Toggle the right-sidebar workbench. Returns the new "open" state (for
     * aria-pressed). Never throws: a service failure falls back to the v1 page.
     */
    function toggleRightbar() {
      try {
        const right = rootContext && typeof rootContext.get === 'function' ? rootContext.get('sidebarRight') : null
        if (right && typeof right.openTab === 'function') {
          let expanded = false
          try { expanded = typeof right.isExpanded === 'function' && right.isExpanded() === true } catch (error) { expanded = false }
          let activeTab = null
          try { activeTab = typeof right.active === 'function' ? right.active() : null } catch (error) { activeTab = null }
          if (expanded && activeTab && activeTab.kind === RIGHT_TAB_KIND && activeTab.id !== undefined) {
            if (typeof right.close === 'function') {
              right.close(activeTab.id)
              reportDiag('toggle', { opened: false })
              return false
            }
          }
          right.openTab(RIGHT_TAB_KIND)
          reportDiag('toggle', { opened: true })
          return true
        }
      } catch (error) {
        try { console.error('[dsh-code-runner] right sidebar toggle failed', error) } catch (ignored) { /* ignore */ }
      }
      try {
        const layout = rootContext && typeof rootContext.get === 'function' ? rootContext.get('layout') : null
        if (layout && typeof layout.selectPanel === 'function') {
          layout.selectPanel(PANEL_ID)
          reportDiag('toggle', { opened: false, fallback: 'page' })
          return false
        }
      } catch (error) {
        /* never throw out of a header button */
      }
      return false
    }

    function HeaderToggle() {
      useLocaleRefresh()
      const pair = React.useState(false)
      const pressed = pair[0]
      const setPressed = pair[1]
      const label = pressed ? t('panel.rightbarClose') : t('panel.rightbarOpen')
      return h(React.Fragment, null,
        h('style', null, TOGGLE_CSS),
        h('button', {
          type: 'button',
          className: 'dcr-toggle',
          'aria-label': label,
          'aria-pressed': pressed,
          title: label,
          onClick: function onToggleClick() {
            setPressed(toggleRightbar() === true)
          },
        }, h(RightbarGlyph, { size: 16 })))
    }

    // ── Shared view helpers ────────────────────────────────────────────────
    function hostChipInfo(translate, snapshot) {
      const run = snapshot.run
      if (run.running || run.phase === 'starting') return { state: 'running', label: translate('toolbar.running') }
      if (snapshot.env.status === 'ready') return { state: 'ready', label: translate('status.ready') }
      if (snapshot.env.status === 'error') return { state: 'offline', label: translate('status.offline') }
      return { state: 'loading', label: translate('env.scanning') }
    }

    function HostChip(props) {
      const translate = props.t
      const info = hostChipInfo(translate, props.snapshot)
      return h('span', { className: 'dcr-hostChip', 'data-state': info.state, role: 'status' },
        h('span', { className: 'dcr-chipDot', 'aria-hidden': 'true' }),
        info.label)
    }

    function editorPlaceholderFor(translate, snapshot) {
      const language = findLanguage(snapshot.languages, snapshot.languageId)
      const template = language && typeof language.template === 'string' ? language.template : ''
      if (snapshot.filePath === null && template !== '') return translate('editor.placeholder') + '\n\n' + template
      return translate('editor.placeholder')
    }

    function canPickDirectory() {
      try {
        const workspace = rootContext && typeof rootContext.get === 'function' ? rootContext.get('uiWorkspace') : null
        return !!(workspace && typeof workspace.pickDirectory === 'function')
      } catch (error) {
        return false
      }
    }

    function relativeBreadcrumbSegments(cwd, dir) {
      const base = String(cwd || '').replace(/[\\/]+$/, '')
      const target = String(dir || '').replace(/[\\/]+$/, '')
      if (base === '' || target === '' || target === base) return []
      if (target.indexOf(base + '/') !== 0) return [{ name: basename(target), path: target }]
      const rest = target.slice(base.length + 1)
      const parts = rest.split('/')
      const segments = []
      let accumulated = base
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]
        if (part === '') continue
        accumulated = accumulated + '/' + part
        segments.push({ name: part, path: accumulated })
      }
      return segments
    }

    /** True while a MATLAB run is starting up (POST in flight or no output yet). */
    function isMatlabStarting(snapshot) {
      const run = snapshot.run
      if (!run || run.language !== 'matlab') return false
      if (run.phase === 'starting') return true
      return run.running === true && snapshot.output.stdout === '' && snapshot.output.stderr === ''
    }

    function profileHintKeyFor(languageId) {
      return profileFor(languageId).hintKey
    }

    function runStatusParts(translate, run) {
      const parts = []
      if (run.origin === 'selection') {
        parts.push({ key: 'selection', text: translate('selection.marker'), cls: 'dcr-statusStrong' })
      }
      if (run.running || run.phase === 'starting') {
        parts.push({ key: 'busy', text: translate('output.running'), cls: 'dcr-statusWarn' })
      } else if (run.finished) {
        if (run.timedOut) parts.push({ key: 'timeout', text: translate('status.timeout'), cls: 'dcr-statusBad' })
        else if (run.stopped) parts.push({ key: 'stopped', text: translate('status.stopped'), cls: 'dcr-statusWarn' })
        if (typeof run.exitCode === 'number') {
          parts.push({
            key: 'exit',
            text: translate('status.exit') + ' ' + run.exitCode,
            cls: run.exitCode === 0 ? 'dcr-statusOk' : 'dcr-statusBad',
          })
        }
        if (typeof run.signal === 'string' && run.signal !== '') {
          parts.push({ key: 'signal', text: translate('status.signal') + ' ' + run.signal, cls: 'dcr-statusBad' })
        }
        if (typeof run.durationMs === 'number') {
          parts.push({ key: 'duration', text: translate('status.duration') + ' ' + formatDuration(run.durationMs), cls: null })
        }
      }
      if (run.error) {
        const text = run.error.code === 'unknown-run'
          ? translate('error.unknownRun')
          : translate('error.setup', { detail: clampDetail(run.error.message) || String(run.error.code || '') })
        parts.push({ key: 'error', text: text, cls: 'dcr-statusBad' })
      }
      return parts
    }

    // ── Notice bar (auto-dismisses success/info) ───────────────────────────
    function SurfaceNotice(props) {
      const translate = props.t
      const notice = props.snapshot.ui.notice
      React.useEffect(function autoDismissNotice() {
        if (!notice) return undefined
        if (notice.tone !== 'success' && notice.tone !== 'info') return undefined
        const timer = setTimeout(function dismissAfterDelay() { store.actions.dismissNotice() }, 4000)
        return function cancelDismiss() { clearTimeout(timer) }
      }, [notice])
      if (!notice) return null
      return h('div', { className: 'dcr-notice', 'data-tone': notice.tone || 'error', role: notice.tone === 'error' ? 'alert' : 'status' },
        h('span', { className: 'dcr-noticeText' }, translate(notice.key, notice.params || undefined)),
        notice.retry
          ? h('button', { type: 'button', className: 'dcr-btn dcr-btnSmall', onClick: function onRetry() { store.actions.retry() } }, translate('toolbar.rescan'))
          : null,
        notice.copyPath
          ? h('button', { type: 'button', className: 'dcr-btn dcr-btnSmall', onClick: function onCopyPath() { store.actions.copyNoticePath() } }, translate('export.copyPath'))
          : null,
        h('button', {
          type: 'button',
          className: 'dcr-noticeClose',
          'aria-label': translate('plots.close'),
          onClick: function onDismiss() { store.actions.dismissNotice() },
        }, h('span', { 'aria-hidden': 'true' }, '×')))
    }

    // ── Tab strip (role=tablist, arrow-key switching) ──────────────────────
    function SurfaceTabStrip(props) {
      const tabs = props.tabs
      const active = props.active
      const onSelect = props.onSelect
      const nodeRefs = React.useRef({})
      function focusTab(id) {
        const node = nodeRefs.current[id]
        if (node && typeof node.focus === 'function') node.focus()
      }
      function handleKeyDown(event, index) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? -1 : 1
        const nextIndex = (index + delta + tabs.length) % tabs.length
        onSelect(tabs[nextIndex].id)
        focusTab(tabs[nextIndex].id)
      }
      return h('div', { className: 'dcr-tabStrip', role: 'tablist' }, tabs.map(function renderTab(tab, index) {
        const selected = tab.id === active
        return h('button', {
          key: tab.id,
          type: 'button',
          role: 'tab',
          className: 'dcr-tab',
          'aria-selected': selected,
          tabIndex: selected ? 0 : -1,
          ref: function rememberTabNode(node) { nodeRefs.current[tab.id] = node },
          onClick: function onTabClick() { onSelect(tab.id) },
          onKeyDown: function onTabKeyDown(event) { handleKeyDown(event, index) },
        },
          tab.glyph ? h('span', { className: 'dcr-tabGlyph', 'aria-hidden': 'true' }, tab.glyph) : null,
          h('span', null, tab.label),
          tab.badge ? h('span', { className: 'dcr-tabBadge' }, String(tab.badge)) : null)
      }))
    }

    function buildBottomTabs(translate, snapshot) {
      return [
        { id: 'console', label: translate('tabs.console'), glyph: h(ConsoleGlyph) },
        {
          id: 'plots',
          label: translate('tabs.plots'),
          glyph: h(PlotsGlyph),
          badge: snapshot.ui.plotsUnseen > 0 ? snapshot.ui.plotsUnseen : null,
        },
        { id: 'files', label: translate('tabs.files'), glyph: h(FilesGlyph) },
      ]
    }

    // ── Toolbar ────────────────────────────────────────────────────────────
    function FileChip(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const hasFile = snapshot.filePath !== null
      const name = hasFile ? basename(snapshot.filePath) : translate('toolbar.untitled')
      return h('span', {
        className: 'dcr-fileChip',
        title: hasFile ? snapshot.filePath : translate('toolbar.untitled'),
        'data-dirty': snapshot.dirty ? 'true' : 'false',
      },
        h(FileGlyph),
        h('span', { className: 'dcr-fileChipName' }, name),
        snapshot.dirty
          ? h('span', { className: 'dcr-dirtyDot', role: 'img', 'aria-label': translate('toolbar.dirty'), title: translate('toolbar.dirty') }, null)
          : null)
    }

    function LanguageField(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const languages = snapshot.languages
      const options = languages.length === 0
        ? [h('option', { key: 'none', value: '' }, snapshot.env.status === 'ready' ? translate('env.none') : translate('env.scanning'))]
        : languages.map(function languageToOption(language) {
          return h('option', { key: language.id, value: language.id }, languageOptionLabel(language))
        })
      return h('div', { className: 'dcr-field dcr-fieldLanguage' },
        h('label', { className: 'dcr-label', htmlFor: 'dcr-language' }, translate('toolbar.language')),
        h('div', { className: 'dcr-inlineRow' },
          h('select', {
            id: 'dcr-language',
            className: 'dcr-select',
            value: snapshot.languageId,
            disabled: snapshot.env.status !== 'ready' || languages.length === 0,
            onChange: function onLanguageChange(event) { actions.setLanguage(event.target.value) },
            'aria-label': translate('toolbar.language'),
          }, options),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onRescan() { actions.retry() },
            disabled: snapshot.env.status === 'loading',
          }, translate('toolbar.rescan')),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onPacks() { actions.openPacksDialog() },
            title: translate('packs.open'),
            'aria-label': translate('packs.open'),
          }, translate('packs.open'))))
    }

    function CwdField(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const canPick = canPickDirectory()
      const placeholder = snapshot.env.data && typeof snapshot.env.data.defaultCwd === 'string' ? snapshot.env.data.defaultCwd : ''
      return h('div', { className: 'dcr-field dcr-fieldCwd' },
        h('label', { className: 'dcr-label', htmlFor: 'dcr-cwd' }, translate('toolbar.cwd')),
        h('div', { className: 'dcr-inlineRow' },
          h('input', {
            id: 'dcr-cwd',
            className: 'dcr-input dcr-cwdInput',
            type: 'text',
            value: snapshot.cwd,
            spellCheck: false,
            autoComplete: 'off',
            autoCorrect: 'off',
            placeholder: placeholder,
            onChange: function onCwdInput(event) { actions.setCwd(event.target.value) },
            onBlur: function onCwdBlur() { actions.commitCwd() },
            onKeyDown: function onCwdKeyDown(event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                actions.commitCwd()
              }
            },
          }),
          canPick
            ? h('button', { type: 'button', className: 'dcr-btn', onClick: function onPick() { actions.pickCwd() } }, translate('toolbar.pick'))
            : null))
    }

    function WorkbenchToolbar(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const mode = props.mode
      const busy = snapshot.run.running || snapshot.run.phase === 'starting'
      const hasFile = snapshot.filePath !== null
      const canSave = snapshot.env.status === 'ready' && !snapshot.ui.saving
      const canRun = !busy && snapshot.env.status === 'ready' && snapshot.languageId !== ''
      const canStop = busy && snapshot.run.runId !== null
      const selection = snapshot.selection || { start: 0, end: 0, text: '' }
      const hasSelection = typeof selection.text === 'string' && selection.text.trim() !== ''
      const canRunSelection = canRun && hasSelection
      const canExplain = snapshot.env.status === 'ready' && snapshot.languageId !== ''
        && (hasSelection || String(snapshot.code).trim() !== '' || (snapshot.filePath !== null && snapshot.code !== ''))
        && snapshot.explain.status !== 'loading'
      const canExport = snapshot.exportState.status !== 'loading'
        && (String(snapshot.code).trim() !== '' || snapshot.output.stdout !== '' || snapshot.output.stderr !== '')
      const exporting = snapshot.exportState.status === 'loading'
      const runLabel = hasFile ? translate('toolbar.runFile') : translate('toolbar.runBuffer')
      const saveLabel = snapshot.ui.saving ? translate('editor.saving') : translate('toolbar.save')
      return h('div', { className: 'dcr-toolbar' },
        h('div', { className: 'dcr-toolbarRow' },
          h(FileChip, { t: translate, snapshot: snapshot }),
          h('button', { type: 'button', className: 'dcr-btn', onClick: function onNewFile() { actions.newFile() } }, translate('toolbar.newFile')),
          h('button', { type: 'button', className: 'dcr-btn', onClick: function onSave() { actions.saveFile() }, disabled: !canSave }, saveLabel),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onRunSelection() { actions.runSelection() },
            disabled: !canRunSelection,
            title: translate('selection.hint'),
            'aria-label': translate('selection.run') + ' · ' + translate('selection.hint'),
          }, h(SelectionGlyph), translate('selection.run')),
          h('button', {
            type: 'button',
            className: 'dcr-btn dcr-btnPrimary',
            onClick: function onRun() { actions.run() },
            disabled: !canRun,
            'aria-label': translate('toolbar.run') + ' · ' + runLabel,
          }, runLabel),
          h('button', { type: 'button', className: 'dcr-btn dcr-btnStop', onClick: function onStop() { actions.stop() }, disabled: !canStop }, translate('toolbar.stop')),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onExplain() { actions.openExplain() },
            disabled: !canExplain,
            title: translate('explain.open'),
          }, h(SparkleGlyph), translate('explain.open')),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onExport() { actions.openExportDialog() },
            disabled: !canExport,
            title: translate('export.button'),
          }, h(DocumentGlyph), exporting ? translate('export.running') : translate('export.button')),
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onDataset() { actions.openDatasetDialog() },
            title: translate('dataset.open'),
          }, h(DatasetGlyph), translate('dataset.open')),
          mode === 'pane' ? h('span', { className: 'dcr-actions' }, h(HostChip, { t: translate, snapshot: snapshot })) : null),
        h('div', { className: 'dcr-toolbarRow' },
          h(LanguageField, { t: translate, snapshot: snapshot, actions: actions }),
          h(CwdField, { t: translate, snapshot: snapshot, actions: actions }),
          h('div', { className: 'dcr-actions' },
            h('button', {
              type: 'button',
              className: 'dcr-btn',
              onClick: function onSaveAs() { actions.openSaveAs() },
              disabled: !canSave,
            }, translate('toolbar.saveAs')))))
    }

    /** Language-adaptive hint strip under the toolbar (CONTRACT-V3 §2.5). */
    function LanguageHintStrip(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const profile = profileFor(snapshot.languageId)
      const parts = [translate(profile.hintKey)]
      if (snapshot.run.origin === 'selection') parts.push(translate('selection.marker'))
      if (isMatlabStarting(snapshot)) parts.push(translate('language.startingMatlab'))
      const selection = snapshot.selection || { start: 0, end: 0, text: '' }
      if (typeof selection.text === 'string' && selection.text.trim() !== '') parts.push(translate('selection.hint'))
      return h('div', {
        className: 'dcr-hintStrip',
        'data-language': snapshot.languageId || '',
        role: 'status',
      }, parts.join(' · '))
    }

    // ── Code editor with line-number gutter ────────────────────────────────
    function CodeEditor(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const textareaRef = React.useRef(null)
      const gutterRef = React.useRef(null)
      const pendingCaretRef = React.useRef(null)
      const code = snapshot.code

      React.useEffect(function restoreCaretAfterTab() {
        const node = textareaRef.current
        const caret = pendingCaretRef.current
        if (node === null || caret === null) return
        pendingCaretRef.current = null
        try {
          node.selectionStart = caret
          node.selectionEnd = caret
        } catch (error) {
          /* ignore selection failures */
        }
        actions.setSelection(caret, caret)
      }, [code])

      let lineCount = 1
      for (let index = 0; index < code.length; index += 1) {
        if (code.charCodeAt(index) === 10) lineCount += 1
      }
      const numbers = []
      for (let number = 1; number <= lineCount; number += 1) numbers.push(String(number))
      const gutterText = numbers.join('\n')

      function updateCursor(node) {
        const position = typeof node.selectionStart === 'number' ? node.selectionStart : 0
        const before = code.slice(0, position)
        const lines = before.split('\n')
        actions.setCursor(lines.length, lines[lines.length - 1].length + 1)
        // Track the textarea selection in the shared store (v3 §2.1).
        actions.setSelection(
          typeof node.selectionStart === 'number' ? node.selectionStart : position,
          typeof node.selectionEnd === 'number' ? node.selectionEnd : position
        )
      }

      function handleKeyDown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.shiftKey) {
          event.preventDefault()
          actions.runSelection()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          actions.run()
          return
        }
        if ((event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          actions.saveFile()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const node = event.currentTarget
          const start = typeof node.selectionStart === 'number' ? node.selectionStart : code.length
          const end = typeof node.selectionEnd === 'number' ? node.selectionEnd : start
          const nextCode = code.slice(0, start) + '  ' + code.slice(end)
          pendingCaretRef.current = start + 2
          actions.setCode(nextCode)
        }
      }

      function handleScroll(event) {
        const node = event.currentTarget
        if (gutterRef.current) gutterRef.current.scrollTop = node.scrollTop
      }

      return h('div', { className: 'dcr-editor' },
        h('pre', { className: 'dcr-gutter', ref: gutterRef, 'aria-hidden': 'true' }, gutterText),
        h('textarea', {
          ref: textareaRef,
          className: 'dcr-textarea',
          value: code,
          placeholder: editorPlaceholderFor(translate, snapshot),
          spellCheck: false,
          autoComplete: 'off',
          autoCorrect: 'off',
          autoCapitalize: 'off',
          wrap: 'off',
          'aria-label': translate('editor.placeholder'),
          onChange: function onChange(event) {
            actions.setCode(event.target.value)
            const node = event.target
            if (node && typeof node.selectionStart === 'number') {
              actions.setSelection(node.selectionStart, typeof node.selectionEnd === 'number' ? node.selectionEnd : node.selectionStart)
            }
          },
          onKeyDown: handleKeyDown,
          onScroll: handleScroll,
          onSelect: function onSelect(event) { updateCursor(event.currentTarget) },
          onKeyUp: function onKeyUp(event) { updateCursor(event.currentTarget) },
          onClick: function onClick(event) { updateCursor(event.currentTarget) },
          onFocus: function onFocus() { actions.setEditorFocused(true) },
          onBlur: function onBlur() { actions.setEditorFocused(false) },
        }))
    }

    // ── Drag divider for the bottom panel height ───────────────────────────
    function SplitDivider(props) {
      const dragRef = React.useRef(null)
      const cleanupRef = React.useRef(null)

      function removeListeners() {
        if (cleanupRef.current !== null) {
          cleanupRef.current()
          cleanupRef.current = null
        }
      }

      React.useEffect(function cleanupDragListeners() { return removeListeners }, [])

      function handlePointerDown(event) {
        event.preventDefault()
        const parent = event.currentTarget.parentElement
        if (!parent) return
        const rect = parent.getBoundingClientRect()
        if (!rect || rect.height <= 0) return
        dragRef.current = { startY: event.clientY, startRatio: props.ratio, height: rect.height }
        const onMove = function onPointerMove(moveEvent) {
          const drag = dragRef.current
          if (!drag) return
          const delta = (drag.startY - moveEvent.clientY) / drag.height
          props.onRatio(drag.startRatio + delta)
        }
        const onUp = function onPointerUp() {
          dragRef.current = null
          removeListeners()
          props.onCommit()
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          cleanupRef.current = function cleanupDrag() {
            try { window.removeEventListener('pointermove', onMove) } catch (error) { /* ignore */ }
            try { window.removeEventListener('pointerup', onUp) } catch (error) { /* ignore */ }
          }
        }
      }

      function handleKeyDown(event) {
        let delta = 0
        if (event.key === 'ArrowUp') delta = 0.03
        else if (event.key === 'ArrowDown') delta = -0.03
        else return
        event.preventDefault()
        props.onRatio(props.ratio + delta)
        props.onCommit()
      }

      return h('div', {
        className: 'dcr-divider',
        role: 'separator',
        'aria-orientation': 'horizontal',
        'aria-valuenow': Math.round(props.ratio * 100),
        'aria-valuemin': Math.round(MIN_SPLIT_RATIO * 100),
        'aria-valuemax': Math.round(MAX_SPLIT_RATIO * 100),
        'aria-label': props.label,
        tabIndex: 0,
        onPointerDown: handlePointerDown,
        onKeyDown: handleKeyDown,
      }, h('span', { className: 'dcr-dividerHandle', 'aria-hidden': 'true' }))
    }

    // ── Console panel (v1 streaming output, restyled) ──────────────────────
    function ConsolePanel(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const run = snapshot.run
      const output = snapshot.output
      const busy = run.running || run.phase === 'starting'
      const hasOutput = output.stdout !== '' || output.stderr !== ''
      const isLossy = output.stdoutLossy || output.stderrLossy
      const blocks = []
      if (output.stdout !== '') blocks.push(h('span', { key: 'stdout', className: 'dcr-outStdout' }, output.stdout))
      if (output.stderr !== '') blocks.push(h('span', { key: 'stderr', className: 'dcr-outStderr' }, output.stderr))
      if (blocks.length === 0) {
        let emptyLabel = translate('output.idle')
        if (busy) emptyLabel = translate('output.running')
        else if (run.runId !== null || run.finished) emptyLabel = translate('output.empty')
        blocks.push(h('span', { key: 'empty', className: 'dcr-outEmpty' }, emptyLabel))
      }
      const statusParts = runStatusParts(translate, run)
      if (isMatlabStarting(snapshot)) {
        statusParts.push({ key: 'matlab-start', text: translate('language.startingMatlab'), cls: 'dcr-statusWarn' })
      }
      const profile = profileFor(run.language || snapshot.languageId)
      const outputRef = React.useRef(null)
      const stickRef = React.useRef(true)
      React.useEffect(function scrollOutputToBottom() {
        const node = outputRef.current
        if (node && stickRef.current) node.scrollTop = node.scrollHeight
      }, [output.stdout, output.stderr, run.runId])
      return h('div', { className: 'dcr-console' },
        h('div', { className: 'dcr-consoleHead' },
          h('span', { className: 'dcr-consoleTitle' }, translate(profile.consoleKey)),
          run.origin === 'selection' ? h('span', { className: 'dcr-marker' }, translate('selection.marker')) : null,
          isMatlabStarting(snapshot) ? h('span', { className: 'dcr-marker dcr-markerWarn' }, translate('language.startingMatlab')) : null,
          isLossy ? h('span', null, translate('output.truncated')) : null,
          h('div', { className: 'dcr-consoleActions' },
            h('button', { type: 'button', className: 'dcr-btn dcr-btnSmall', onClick: function onCopy() { actions.copyOutput() }, disabled: !hasOutput }, translate('toolbar.copy')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnSmall', onClick: function onClear() { actions.clearOutput() }, disabled: !hasOutput && !run.finished }, translate('toolbar.clear')))),
        h('pre', {
          ref: outputRef,
          className: 'dcr-outPre',
          role: 'log',
          tabIndex: 0,
          'aria-live': 'polite',
          'aria-label': translate('output.title'),
          onScroll: function onOutputScroll(event) {
            const node = event.currentTarget
            stickRef.current = (node.scrollHeight - node.scrollTop - node.clientHeight) < 32
          },
        }, blocks),
        statusParts.length > 0
          ? h('div', { className: 'dcr-runStatus', role: 'status' }, statusParts.map(function statusPart(part) {
            return h('span', { key: part.key, className: part.cls || null }, part.text)
          }))
          : null)
    }

    // ── Files panel ────────────────────────────────────────────────────────
    function FilesPanel(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const files = snapshot.files
      const currentDir = files.dir !== '' ? files.dir : snapshot.cwd
      const segments = relativeBreadcrumbSegments(snapshot.cwd, currentDir)
      const rows = []
      if (files.status === 'loading' && files.entries.length === 0) {
        rows.push(h('div', { key: 'loading', className: 'dcr-panelEmpty' }, translate('files.loading')))
      } else if (files.status === 'error') {
        const spec = noticeSpecForError(files.error) || { key: 'error.fileNotFound', params: { detail: '' } }
        rows.push(h('div', { key: 'error', className: 'dcr-panelEmpty' }, translate(spec.key, spec.params || undefined)))
      } else if (files.entries.length === 0) {
        rows.push(h('div', { key: 'empty', className: 'dcr-panelEmpty' }, translate('files.empty')))
      } else {
        for (let index = 0; index < files.entries.length; index += 1) {
          const entry = files.entries[index]
          if (!entry || typeof entry.path !== 'string') continue
          const isDir = entry.isDir === true
          const isDot = typeof entry.name === 'string' && entry.name.charAt(0) === '.'
          rows.push(h('button', {
            key: entry.path,
            type: 'button',
            className: 'dcr-fileRow',
            'data-dot': isDot ? 'true' : 'false',
            title: entry.path,
            onClick: function onOpenEntry() { actions.openEntry(entry) },
          },
            h('span', { className: 'dcr-fileIcon', 'aria-hidden': 'true' }, isDir ? h(FolderGlyph) : h(FileGlyph)),
            h('span', { className: 'dcr-fileName' }, isDir ? entry.name + '/' : entry.name),
            h('span', { className: 'dcr-fileMeta' }, isDir ? translate('files.dir') : formatSize(entry.size))))
        }
      }
      return h('div', { className: 'dcr-files', role: 'region', 'aria-label': translate('files.title') },
        h('div', { className: 'dcr-filesHead' },
          h('button', {
            type: 'button',
            className: 'dcr-btn dcr-btnSmall',
            onClick: function onUp() { actions.filesUp() },
            title: translate('files.up'),
            'aria-label': translate('files.up'),
          }, translate('files.up')),
          h('div', { className: 'dcr-breadcrumb' },
            h('button', {
              type: 'button',
              className: 'dcr-crumb',
              onClick: function onRoot() { actions.loadFiles(snapshot.cwd) },
              title: snapshot.cwd,
            }, translate('files.root')),
            segments.map(function renderSegment(segment) {
              return h(React.Fragment, { key: segment.path },
                h('span', { className: 'dcr-crumbSep', 'aria-hidden': 'true' }, '/'),
                h('button', {
                  type: 'button',
                  className: 'dcr-crumb',
                  onClick: function onSegment() { actions.loadFiles(segment.path) },
                  title: segment.path,
                }, segment.name))
            })),
          h('button', {
            type: 'button',
            className: 'dcr-btn dcr-btnSmall',
            onClick: function onRefresh() { actions.filesRefresh() },
            title: translate('files.refresh'),
            'aria-label': translate('files.refresh'),
          }, translate('files.refresh'))),
        h('div', { className: 'dcr-filesList' }, rows))
    }

    // ── Plots gallery ──────────────────────────────────────────────────────
    function PlotsPanel(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const plots = snapshot.plots
      const saving = snapshot.plotSave.status === 'loading'
      const cards = []
      if (plots.status === 'loading' && plots.items.length === 0) {
        for (let index = 0; index < 4; index += 1) {
          cards.push(h('div', { key: 'skeleton-' + index, className: 'dcr-plotSkeleton', 'aria-hidden': 'true' }))
        }
        cards.push(h('div', { key: 'skeleton-label', className: 'dcr-srOnly' }, translate('plots.loading')))
      } else if (plots.status === 'error' && plots.items.length === 0) {
        const spec = noticeSpecForError(plots.error) || { key: 'error.setup', params: { detail: '' } }
        cards.push(h('div', { key: 'error', className: 'dcr-panelEmpty' }, translate(spec.key, spec.params || undefined)))
      } else if (plots.items.length === 0) {
        cards.push(h('div', { key: 'empty', className: 'dcr-panelEmpty' }, translate('plots.empty')))
      } else {
        for (let index = 0; index < plots.items.length; index += 1) {
          cards.push(h(PlotCard, {
            key: plots.items[index].path,
            t: translate,
            item: plots.items[index],
            urlEntry: plots.urls[plots.items[index].path] || null,
            onOpen: function makeOpen(openIndex) {
              return function onOpenPlot() { actions.openPlot(openIndex) }
            }(index),
            onSave: function makeSave(saveIndex) {
              return function onSavePlot() { actions.savePlotAt(saveIndex) }
            }(index),
          }))
        }
      }
      return h('div', { className: 'dcr-plots' },
        h('div', { className: 'dcr-plotsHead' },
          h('span', { className: 'dcr-plotsTitle' }, translate('plots.title')),
          plots.items.length > 0 ? h('span', { className: 'dcr-plotsCount' }, translate('plots.count', { count: plots.items.length })) : null,
          h('div', { className: 'dcr-plotHeadActions' },
            plots.items.length > 0
              ? h('button', {
                type: 'button',
                className: 'dcr-btn dcr-btnSmall',
                onClick: function onSaveAllPlots() { actions.saveAllPlots() },
                disabled: saving,
                title: translate('plots.saveAll'),
                'aria-label': translate('plots.saveAll'),
              }, translate('plots.saveAll'))
              : null,
            h('button', {
              type: 'button',
              className: 'dcr-btn dcr-btnSmall',
              onClick: function onRefreshPlots() { actions.refreshArtifacts() },
              title: translate('plots.refresh'),
              'aria-label': translate('plots.refresh'),
            }, translate('plots.refresh')))),
        h('div', { className: 'dcr-plotsGrid' }, cards))
    }

    function PlotCard(props) {
      const translate = props.t
      const item = props.item
      const hasUrl = props.urlEntry && typeof props.urlEntry.url === 'string'
      const isImage = IMAGE_EXTS.indexOf(String(item.ext || '').toLowerCase()) >= 0
      const sourceLabel = item.source === 'cwd' ? translate('plots.sourceCwd') : translate('plots.sourceRun')
      let thumb = null
      if (hasUrl) thumb = h('img', { className: 'dcr-plotThumb', src: props.urlEntry.url, alt: item.name, loading: 'lazy' })
      else if (isImage) thumb = h('span', { className: 'dcr-plotPlaceholder' }, translate('plots.loading'))
      else thumb = h('span', { className: 'dcr-plotPlaceholder' }, translate('plots.unsupported') + ' · ' + item.name)
      return h('div', { className: 'dcr-plotCard', 'data-source': item.source },
        h('button', {
          type: 'button',
          className: 'dcr-plotCardOpen',
          title: item.path,
          onClick: props.onOpen,
        },
          thumb,
          h('span', { className: 'dcr-plotCaption' },
            h('span', { className: 'dcr-plotName' }, item.name),
            h('span', { className: 'dcr-plotSource' }, sourceLabel),
            typeof item.size === 'number' && item.size > 0
              ? h('span', { className: 'dcr-plotSize', title: translate('plots.size') }, formatSize(item.size))
              : null)),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall dcr-plotSave',
          onClick: props.onSave,
          title: translate('plots.save'),
          'aria-label': translate('plots.save'),
        }, translate('plots.save')))
    }

    // ── Lightbox (plots and image files) ───────────────────────────────────
    function PlotsLightbox(props) {
      const translate = props.t
      const actions = props.actions
      const lightbox = props.lightbox

      React.useEffect(function lightboxKeyboard() {
        if (!lightbox) return undefined
        const target = typeof window !== 'undefined' ? window : null
        if (!target || typeof target.addEventListener !== 'function') return undefined
        const handler = function onLightboxKey(event) {
          if (event.key === 'Escape') {
            event.preventDefault()
            actions.closeLightbox()
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            actions.stepLightbox(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            actions.stepLightbox(1)
          }
        }
        target.addEventListener('keydown', handler)
        return function removeLightboxKeys() {
          try { target.removeEventListener('keydown', handler) } catch (error) { /* ignore */ }
        }
      }, [lightbox, actions])

      if (!lightbox || lightbox.items.length === 0) return null
      const index = Math.max(0, Math.min(lightbox.items.length - 1, lightbox.index))
      const item = lightbox.items[index]
      const sourceLabel = item.source === 'cwd'
        ? translate('plots.sourceCwd')
        : (item.source === 'run' ? translate('plots.sourceRun') : translate('toolbar.file'))
      const metaParts = [sourceLabel]
      if (typeof item.size === 'number' && item.size > 0) metaParts.push(translate('plots.size') + ' ' + formatSize(item.size))
      metaParts.push((index + 1) + '/' + lightbox.items.length)
      return h('div', {
        className: 'dcr-lightbox',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': translate('plots.title'),
      },
      h('div', { className: 'dcr-lightboxHead' },
        h('span', { className: 'dcr-lightboxName', title: item.path }, item.name),
        h('span', { className: 'dcr-lightboxMeta' }, metaParts.join(' · ')),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall',
          onClick: function onSaveLightboxPlot() { actions.saveLightboxPlot() },
          'aria-label': translate('plots.save'),
        }, translate('plots.save')),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall',
          onClick: function onCopyPath() { actions.copyLightboxPath() },
        }, translate('plots.copyPath')),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall',
          onClick: function onPrev() { actions.stepLightbox(-1) },
          disabled: lightbox.items.length < 2,
          'aria-label': translate('plots.prev'),
        }, translate('plots.prev')),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall',
          onClick: function onNext() { actions.stepLightbox(1) },
          disabled: lightbox.items.length < 2,
          'aria-label': translate('plots.next'),
        }, translate('plots.next')),
        h('button', {
          type: 'button',
          className: 'dcr-btn dcr-btnSmall',
          onClick: function onClose() { actions.closeLightbox() },
          'aria-label': translate('plots.close'),
        }, translate('plots.close'))),
      h('div', { className: 'dcr-lightboxBody' },
        item.url
          ? h('img', { className: 'dcr-lightboxImg', src: item.url, alt: item.name })
          : h('div', { className: 'dcr-lightboxFallback' },
            h('div', null, translate('plots.unsupported')),
            h('div', { className: 'dcr-lightboxMeta' }, item.name))))
    }

    // ── Inline dialogs: dirty guard, conflict, save-as, AI explanation ────
    function ExplainDialog(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const explain = snapshot.explain
      if (!explain || explain.status === 'idle') return null
      const loading = explain.status === 'loading'
      const ready = explain.status === 'ready'
      const error = explain.status === 'error'
      const unavailable = error && explain.error && explain.error.code === 'llm-unavailable'
      const rows = []
      rows.push(h('div', { key: 'head', className: 'dcr-dialogRow dcr-explainHead' },
        h('span', { className: 'dcr-dialogTitle' }, translate('explain.title')),
        h('div', { className: 'dcr-explainHeadActions' },
          h('button', {
            type: 'button',
            className: 'dcr-btn dcr-btnSmall',
            onClick: function onCloseExplain() { actions.closeExplain() },
            'aria-label': translate('explain.close'),
          }, translate('explain.close')))))
      if (loading) {
        rows.push(h('div', { key: 'loading', className: 'dcr-explainLoading' },
          h('span', { className: 'dcr-spinner', 'aria-hidden': 'true' }),
          h('span', null, translate('explain.loading'))))
      }
      if (error) {
        rows.push(h('div', { key: 'error', className: 'dcr-dialogBody dcr-explainError' }, explainErrorText(translate, explain.error)))
      }
      if (ready) {
        if (explain.truncatedInput) {
          rows.push(h('div', { key: 'truncated', className: 'dcr-dialogBody' }, translate('explain.truncated')))
        }
        rows.push(h('div', {
          key: 'summary',
          className: 'dcr-explainSummary',
          role: 'region',
          tabIndex: 0,
          'aria-label': translate('explain.summary'),
        }, explain.summary !== '' ? explain.summary : translate('explain.loading')))
        if (explain.inserted) {
          rows.push(h('div', { key: 'inserted', className: 'dcr-dialogBody dcr-explainInserted' }, translate('explain.inserted')))
        }
        const actionsRow = []
        if (explain.inserted) {
          actionsRow.push(h('button', {
            key: 'undo',
            type: 'button',
            className: 'dcr-btn',
            onClick: function onUndoInsert() { actions.undoExplanationInsert() },
          }, translate('explain.undoInsert')))
        } else {
          actionsRow.push(h('button', {
            key: 'insert',
            type: 'button',
            className: 'dcr-btn dcr-btnPrimary',
            onClick: function onInsert() { actions.insertExplanation() },
            disabled: explain.annotatedCode === '',
          }, translate('explain.insert')))
        }
        actionsRow.push(h('button', {
          key: 'copy',
          type: 'button',
          className: 'dcr-btn',
          onClick: function onCopyExplanation() { actions.copyExplanation() },
          disabled: explain.summary === '',
        }, translate('explain.copy')))
        actionsRow.push(h('button', {
          key: 'retry',
          type: 'button',
          className: 'dcr-btn',
          onClick: function onRetryExplain() { actions.retryExplain() },
        }, translate('explain.retry')))
        rows.push(h('div', { key: 'actions', className: 'dcr-dialogRow' }, actionsRow))
      }
      if (error && !unavailable) {
        rows.push(h('div', { key: 'errorActions', className: 'dcr-dialogRow' },
          h('button', {
            type: 'button',
            className: 'dcr-btn',
            onClick: function onRetryFailedExplain() { actions.retryExplain() },
          }, translate('explain.retry'))))
      }
      return h('div', {
        className: 'dcr-inlineDialog dcr-explainDialog',
        role: 'dialog',
        'aria-label': translate('explain.title'),
        'data-status': explain.status,
      }, rows)
    }

    function DatasetDialog(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const dialog = snapshot.datasetDialog
      const preview = dialog.preview
      const dirs = dialog.entries.filter(function onlyDirs(entry) { return entry.isDir === true })
      const dataFiles = dialog.entries.filter(function onlyData(entry) { return entry.isDir !== true && isDatasetFileName(entry.name) })
      const entries = []
      for (const dir of dirs) {
        entries.push(h('button', {
          key: 'dir:' + dir.path,
          type: 'button',
          className: 'dcr-datasetEntry',
          title: dir.path,
          onClick: function onDir() { actions.selectDatasetEntry(dir) },
        }, '📁 ' + dir.name))
      }
      for (const file of dataFiles) {
        const active = dialog.path === file.path
        entries.push(h('button', {
          key: 'file:' + file.path,
          type: 'button',
          className: 'dcr-datasetEntry' + (active ? ' dcr-datasetEntryActive' : ''),
          title: file.path,
          'data-active': active ? 'true' : 'false',
          onClick: function onFile() { actions.selectDatasetEntry(file) },
        }, '📄 ' + file.name))
      }
      let previewNode = null
      if (dialog.status === 'loading') {
        previewNode = h('div', { className: 'dcr-dialogBody dcr-datasetLoading' }, translate('dataset.loading'))
      } else if (dialog.status === 'error') {
        const detail = dialog.error && dialog.error.message ? clampDetail(dialog.error.message) : ''
        previewNode = h('div', { className: 'dcr-dialogBody dcr-datasetError' }, translate('dataset.failed', { detail: detail }))
      } else if (preview) {
        const headerChecked = dialog.header === null ? preview.header !== false : dialog.header === true
        const headCells = preview.columns.map(function columnHead(column) {
          return h('th', { key: column.index, title: column.name + ' · ' + column.type }, column.name)
        })
        const bodyRows = preview.rows.map(function bodyRow(row, rowIndex) {
          return h('tr', { key: 'row-' + rowIndex }, preview.columns.map(function bodyCell(column) {
            return h('td', { key: column.index }, row[column.index] === undefined ? '' : row[column.index])
          }))
        })
        const controls = []
        if (preview.sheets && preview.sheets.length > 1) {
          controls.push(h('label', { key: 'sheet', className: 'dcr-inlineRow' },
            h('span', { className: 'dcr-label' }, translate('dataset.sheet')),
            h('select', {
              id: 'dcr-dataset-sheet',
              className: 'dcr-select',
              value: preview.sheet || '',
              onChange: function onSheet(event) { actions.setDatasetSheet(event.target.value) },
            }, preview.sheets.map(function sheetOption(name) { return h('option', { key: name, value: name }, name) }))))
        }
        if (preview.sheets && preview.sheets.length === 1) {
          controls.push(h('span', { key: 'onlySheet', className: 'dcr-dialogBody' }, translate('dataset.sheet') + '：' + preview.sheet))
        }
        if (preview.kind === 'csv' || preview.kind === 'tsv' || preview.kind === 'txt') {
          controls.push(h('label', { key: 'delimiter', className: 'dcr-inlineRow' },
            h('span', { className: 'dcr-label' }, translate('dataset.delimiter')),
            h('select', {
              id: 'dcr-dataset-delimiter',
              className: 'dcr-select',
              value: preview.delimiter || '',
              onChange: function onDelimiter(event) { actions.setDatasetDelimiter(event.target.value) },
            },
              h('option', { value: '' }, translate('dataset.delimiterAuto')),
              h('option', { value: ',' }, '， ,'),
              h('option', { value: ';' }, '； ;'),
              h('option', { value: '\t' }, translate('dataset.delimiterTab')),
              h('option', { value: '|' }, '|'))))
        }
        const previewCode = preview.import && typeof preview.import.code === 'string' ? preview.import.code : ''
        previewNode = h('div', { className: 'dcr-datasetPreview' },
          h('div', { className: 'dcr-datasetControls' },
            h('label', { className: 'dcr-exportCheck' },
              h('input', {
                id: 'dcr-dataset-header',
                type: 'checkbox',
                checked: headerChecked,
                onChange: function onHeader() { actions.setDatasetHeader(!headerChecked) },
              }),
              h('span', null, translate('dataset.header'))),
            controls),
          h('div', { className: 'dcr-dialogBody dcr-datasetSummary' },
            translate('dataset.summary', { rows: String(preview.totalRows), cols: String(preview.columns.length) }) +
              (preview.truncated ? ' · ' + translate('dataset.truncated', { rows: String(preview.previewRows) }) : '')),
          h('div', { className: 'dcr-datasetTableWrap' },
            h('table', { className: 'dcr-datasetTable' },
              h('thead', null, h('tr', null, headCells)),
              h('tbody', null, bodyRows))),
          h('div', { className: 'dcr-datasetImport' },
            h('span', { className: 'dcr-label' }, translate('dataset.import', { language: snapshot.languageId })),
            previewCode !== ''
              ? h('pre', { className: 'dcr-datasetCode' }, previewCode)
              : h('span', { className: 'dcr-dialogBody dcr-datasetNoImport' }, translate('dataset.unsupported')),
            h('div', { className: 'dcr-dialogRow' },
              previewCode !== ''
                ? h('button', {
                    type: 'button',
                    className: 'dcr-btn dcr-btnPrimary',
                    onClick: function onInsert() { actions.insertDatasetCode() },
                  }, translate('dataset.insert'))
                : null,
              previewCode !== ''
                ? h('button', {
                    type: 'button',
                    className: 'dcr-btn',
                    onClick: function onCopy() { actions.copyDatasetCode() },
                  }, translate('dataset.copy'))
                : null)))
      } else {
        previewNode = h('div', { className: 'dcr-dialogBody dcr-datasetEmpty' }, translate('dataset.empty'))
      }
      return h('div', { key: 'dataset', className: 'dcr-inlineDialog dcr-datasetDialog', role: 'dialog', 'aria-label': translate('dataset.dialogTitle') },
        h('span', { className: 'dcr-dialogTitle' }, translate('dataset.dialogTitle')),
        h('div', { className: 'dcr-dialogRow dcr-exportField' },
          h('label', { className: 'dcr-label', htmlFor: 'dcr-dataset-path' }, translate('dataset.path')),
          h('input', {
            id: 'dcr-dataset-path',
            className: 'dcr-input dcr-datasetPath',
            type: 'text',
            value: dialog.path,
            placeholder: translate('dataset.pathPlaceholder'),
            spellCheck: false,
            autoComplete: 'off',
            autoCorrect: 'off',
            onChange: function onPathInput(event) { actions.setDatasetPath(event.target.value) },
            onKeyDown: function onPathKey(event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                actions.readDatasetPath()
              }
            },
          }),
          h('button', { type: 'button', className: 'dcr-btn', onClick: function onRead() { actions.readDatasetPath() } }, translate('dataset.read'))),
        h('div', { className: 'dcr-datasetBrowse' },
          h('div', { className: 'dcr-dialogRow dcr-datasetBrowseHead' },
            h('span', { className: 'dcr-label dcr-datasetDir' }, translate('dataset.browseDir') + '：' + (dialog.browseDir || '—')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnSmall', onClick: function onUp() { actions.datasetUp() } }, translate('dataset.up')),
            h('button', {
              type: 'button',
              className: 'dcr-btn dcr-btnSmall',
              disabled: dialog.entriesStatus === 'loading',
              onClick: function onRefresh() { actions.refreshDatasetEntries() },
            }, translate('dataset.refresh'))),
          entries.length > 0
            ? h('div', { className: 'dcr-datasetFiles' }, entries)
            : h('span', { className: 'dcr-dialogBody dcr-datasetNoFiles' }, translate('dataset.noDataFiles'))),
        previewNode,
        h('div', { className: 'dcr-dialogRow' },
          h('button', { type: 'button', className: 'dcr-btn', onClick: function onClose() { actions.closeDatasetDialog() } }, translate('dataset.close'))))
    }

    function SurfaceDialogs(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const dialogs = []
      if (snapshot.explain && snapshot.explain.status !== 'idle') {
        dialogs.push(h(ExplainDialog, { key: 'explain', t: translate, snapshot: snapshot, actions: actions }))
      }
      if (snapshot.exportDialog && snapshot.exportDialog.open) {
        const options = snapshot.exportDialog
        const include = options.include
        const placement = options.plotPlacement === 'under-code' ? 'under-code' : 'section'
        const placementDisabled = include.plots === false || snapshot.plots.items.length === 0
        const stem = snapshot.filePath !== null
          ? String(basename(snapshot.filePath)).replace(/\.[^.]+$/, '')
          : '未命名'
        const suffix = options.format === 'docx' ? '.docx' : options.format === 'md' ? '.md' : options.format === 'html' ? '.html' : '(.docx/.md/.html)'
        const toggleRow = function toggleRow(key, label, disabled) {
          return h('label', { className: 'dcr-exportCheck', key: key },
            h('input', {
              type: 'checkbox',
              checked: include[key] !== false && !disabled,
              disabled: disabled === true,
              onChange: function onToggle() { actions.toggleExportInclude(key) },
            }),
            h('span', null, label))
        }
        dialogs.push(h('div', { key: 'export', className: 'dcr-inlineDialog', role: 'dialog', 'aria-label': translate('export.dialogTitle') },
          h('span', { className: 'dcr-dialogTitle' }, translate('export.dialogTitle')),
          h('div', { className: 'dcr-dialogRow dcr-exportField' },
            h('label', { className: 'dcr-label', htmlFor: 'dcr-export-format' }, translate('export.format')),
            h('select', {
              id: 'dcr-export-format',
              className: 'dcr-select',
              value: options.format,
              onChange: function onFormat(event) { actions.setExportFormat(event.target.value) },
            },
              h('option', { value: 'docx' }, translate('export.formatDocx')),
              h('option', { value: 'md' }, translate('export.formatMd')),
              h('option', { value: 'html' }, translate('export.formatHtml')),
              h('option', { value: 'all' }, translate('export.formatAll')))),
          h('div', { className: 'dcr-dialogRow dcr-exportField' },
            h('span', { className: 'dcr-label' }, translate('export.include')),
            h('div', { className: 'dcr-exportChecks' },
              toggleRow('code', translate('export.includeCode'), false),
              toggleRow('output', translate('export.includeOutput'), false),
              toggleRow('plots', translate('export.includePlots'), snapshot.plots.items.length === 0),
              toggleRow('summary', translate('export.includeSummary'), false))),
          h('div', { className: 'dcr-dialogRow dcr-exportField' },
            h('label', { className: 'dcr-label', htmlFor: 'dcr-export-placement' }, translate('export.plotPlacement')),
            h('select', {
              id: 'dcr-export-placement',
              className: 'dcr-select',
              value: placement,
              disabled: placementDisabled,
              title: placementDisabled ? translate('export.noPlots') : undefined,
              onChange: function onPlacement(event) { actions.setExportPlotPlacement(event.target.value) },
            },
              h('option', { value: 'section' }, translate('export.plotPlacementSection')),
              h('option', { value: 'under-code' }, translate('export.plotPlacementUnderCode')))),
          h('div', { className: 'dcr-dialogBody dcr-exportPlacementHint' },
            placementDisabled
              ? translate('export.noPlots')
              : placement === 'under-code'
                ? translate('export.plotPlacementUnderCodeHint')
                : translate('export.plotPlacementSectionHint')),
          h('div', { className: 'dcr-dialogBody dcr-exportName' },
            translate('export.name') + '：' + stem + '实验报告' + suffix),
          h('div', { className: 'dcr-dialogRow' },
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onCancelExport() { actions.closeExportDialog() } }, translate('export.cancel')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnPrimary', onClick: function onStartExport() { actions.exportReport() } }, translate('export.start')))))
      }
      if (snapshot.datasetDialog && snapshot.datasetDialog.open) {
        dialogs.push(h(DatasetDialog, { key: 'dataset', t: translate, snapshot: snapshot, actions: actions }))
      }
      if (snapshot.packsOpen) {
        const packsState = snapshot.packs || { status: 'idle', items: [], error: null }
        const rows = []
        for (const pack of packsState.items) {
          const capture = pack.capture || { kind: 'none', ready: false, installed: false, hint: null }
          const captureLabel = capture.kind === 'none'
            ? translate('packs.noCapture')
            : capture.ready
              ? translate('packs.autoCapture')
              : translate('packs.captureMissing')
          rows.push(h('div', { key: pack.id, className: 'dcr-packRow', 'data-detected': pack.detected ? 'true' : 'false' },
            h('span', { className: 'dcr-packName' }, pack.label + ' · ' + pack.id),
            h('span', { className: 'dcr-packStatus' }, pack.detected ? translate('packs.detected') : translate('packs.notInstalled')),
            h('span', { className: 'dcr-packCapture', title: capture.hint || captureLabel }, captureLabel),
            h('button', {
              type: 'button',
              className: 'dcr-btn dcr-btnSmall',
              disabled: !pack.detected || packsState.status === 'loading',
              onClick: function onTogglePack() { actions.togglePack(pack.id, !pack.enabled) },
            }, !pack.detected ? translate('packs.unavailable') : pack.enabled ? translate('packs.disable') : translate('packs.enable')),
            capture.hint ? h('span', { className: 'dcr-packHint' }, capture.hint) : null))
        }
        dialogs.push(h('div', { key: 'packs', className: 'dcr-inlineDialog', role: 'dialog', 'aria-label': translate('packs.title') },
          h('span', { className: 'dcr-dialogTitle' }, translate('packs.title')),
          h('span', { className: 'dcr-dialogBody' }, translate('packs.intro')),
          packsState.status === 'loading'
            ? h('div', { className: 'dcr-dialogBody' }, translate('packs.loading'))
            : h('div', { className: 'dcr-explainDialog dcr-packList' }, rows.length > 0 ? rows : h('div', { className: 'dcr-dialogBody' }, translate('packs.empty'))),
          h('div', { className: 'dcr-dialogRow' },
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onPacksRescan() { actions.refreshPacks() } }, translate('packs.rescan')),
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onPacksClose() { actions.closePacksDialog() } }, translate('packs.close')))))
      }
      if (snapshot.ui.discard) {
        const discard = snapshot.ui.discard
        const title = discard.kind === 'open' ? translate('editor.openFileTitle') : translate('editor.unsavedTitle')
        dialogs.push(h('div', { key: 'discard', className: 'dcr-inlineDialog', role: 'alertdialog', 'aria-label': title },
          h('span', { className: 'dcr-dialogTitle' }, title),
          h('span', { className: 'dcr-dialogBody' }, translate('editor.unsavedBody')),
          h('div', { className: 'dcr-dialogRow' },
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onCancelDiscard() { actions.cancelDiscard() } }, translate('editor.cancel')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnStop', onClick: function onDiscard() { actions.confirmDiscard() } }, translate('editor.discard')))))
      }
      if (snapshot.ui.conflict) {
        dialogs.push(h('div', { key: 'conflict', className: 'dcr-inlineDialog', 'data-tone': 'danger', role: 'alertdialog', 'aria-label': translate('editor.conflictTitle') },
          h('span', { className: 'dcr-dialogTitle' }, translate('editor.conflictTitle')),
          h('span', { className: 'dcr-dialogBody' }, translate('editor.conflictBody')),
          h('div', { className: 'dcr-dialogRow' },
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onCancelConflict() { actions.cancelConflict() } }, translate('editor.cancel')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnStop', onClick: function onOverwrite() { actions.confirmOverwrite() } }, translate('editor.overwrite')))))
      }
      if (snapshot.ui.saveAs) {
        const dialog = snapshot.ui.saveAs
        dialogs.push(h('div', { key: 'saveAs', className: 'dcr-inlineDialog', role: 'dialog', 'aria-label': translate('editor.saveAsTitle') },
          h('span', { className: 'dcr-dialogTitle' }, translate('editor.saveAsTitle')),
          h('span', { className: 'dcr-dialogBody' }, dialog.dir !== '' ? dialog.dir : snapshot.cwd),
          h('div', { className: 'dcr-dialogRow' },
            h('input', {
              className: 'dcr-input',
              type: 'text',
              value: dialog.name,
              placeholder: translate('editor.saveAsPlaceholder'),
              'aria-label': translate('editor.saveAsPlaceholder'),
              spellCheck: false,
              onChange: function onNameChange(event) { actions.setSaveAsName(event.target.value) },
              onKeyDown: function onNameKeyDown(event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  actions.confirmSaveAs()
                }
              },
            }),
            h('button', { type: 'button', className: 'dcr-btn', onClick: function onCancelSaveAs() { actions.cancelSaveAs() } }, translate('editor.cancel')),
            h('button', { type: 'button', className: 'dcr-btn dcr-btnPrimary', onClick: function onConfirmSaveAs() { actions.confirmSaveAs() } }, translate('editor.saveAsConfirm')))))
      }
      if (dialogs.length === 0) return null
      return h(React.Fragment, null, dialogs)
    }

    // ── Status bar ─────────────────────────────────────────────────────────
    function WorkbenchStatusBar(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const items = []
      items.push({
        key: 'mode',
        className: 'dcr-statusStrong',
        text: snapshot.filePath !== null ? translate('status.modeFile') : translate('status.modeBuffer'),
      })
      items.push({
        key: 'file',
        className: snapshot.dirty ? 'dcr-statusWarn' : null,
        text: (snapshot.filePath !== null ? basename(snapshot.filePath) : translate('toolbar.untitled')) + (snapshot.dirty ? ' • ' + translate('editor.dirty') : ''),
      })
      const language = findLanguage(snapshot.languages, snapshot.languageId)
      const profile = profileFor(snapshot.languageId)
      const displayName = profile.displayKey ? translate(profile.displayKey) : (language ? language.label : snapshot.languageId)
      if (displayName !== '') items.push({ key: 'language', className: null, text: displayName })
      items.push({ key: 'cursor', className: null, text: translate('status.line') + ' ' + snapshot.ui.cursor.line + ' · ' + translate('status.col') + ' ' + snapshot.ui.cursor.col })
      items.push({ key: 'shortcut', className: null, text: translate('hint.shortcut') })
      const runParts = runStatusParts(translate, snapshot.run)
      for (let index = 0; index < runParts.length; index += 1) {
        items.push({ key: 'run-' + runParts[index].key, className: runParts[index].cls, text: runParts[index].text })
      }
      if (snapshot.exportState.folder !== '') {
        items.push({
          key: 'export',
          className: 'dcr-statusAction',
          text: translate('export.folder') + ': ' + basename(snapshot.exportState.folder),
          title: snapshot.exportState.folder,
          action: function onShowExport() { actions.showExportNotice() },
        })
      }
      if (snapshot.plotSave.status === 'ready' && snapshot.plotSave.targetDir !== '') {
        items.push({
          key: 'plot-target',
          className: 'dcr-statusAction',
          text: translate('plots.target') + ': ' + basename(snapshot.plotSave.targetDir),
          title: snapshot.plotSave.targetDir,
          action: function onShowPlotSave() { actions.showPlotSaveNotice() },
        })
      }
      return h('div', { className: 'dcr-statusBar', role: 'status' }, items.map(function statusItem(item) {
        if (typeof item.action === 'function') {
          return h('button', {
            key: item.key,
            type: 'button',
            className: 'dcr-statusItem ' + (item.className || ''),
            title: item.title || item.text,
            onClick: item.action,
          }, item.text)
        }
        return h('span', { key: item.key, className: 'dcr-statusItem ' + (item.className || '') }, item.text)
      }))
    }

    // ── Bottom panel (console / plots / files) ─────────────────────────────
    function WorkbenchBottomPanel(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const tabs = props.tabs
      const activeTab = props.activeTab
      const ratio = snapshot.ui.splitRatio
      const showStrip = tabs.length > 1
      let body = null
      if (activeTab === 'plots') body = h(PlotsPanel, { t: translate, snapshot: snapshot, actions: actions })
      else if (activeTab === 'files') body = h(FilesPanel, { t: translate, snapshot: snapshot, actions: actions })
      else body = h(ConsolePanel, { t: translate, snapshot: snapshot, actions: actions })
      return h('div', { className: 'dcr-bottom', style: { flex: '0 0 ' + Math.round(ratio * 1000) / 10 + '%' } },
        showStrip
          ? h(SurfaceTabStrip, {
            tabs: buildBottomTabs(translate, snapshot),
            active: activeTab,
            onSelect: function onSelectBottom(tab) { actions.setBottomTab(tab) },
          })
          : null,
        h('div', { className: 'dcr-bottomBody' }, body))
    }

    // ── Page rail (Files | Plots) ──────────────────────────────────────────
    function PageRail(props) {
      const translate = props.t
      const snapshot = props.snapshot
      const actions = props.actions
      const active = snapshot.ui.railTab === 'plots' ? 'plots' : 'files'
      return h('div', { className: 'dcr-rail' },
        h('div', { className: 'dcr-railTabs', role: 'tablist' },
          h('button', {
            type: 'button',
            role: 'tab',
            className: 'dcr-tab',
            'aria-selected': active === 'files',
            onClick: function onFiles() { actions.setRailTab('files') },
          }, h('span', { className: 'dcr-tabGlyph', 'aria-hidden': 'true' }, h(FilesGlyph)), h('span', null, translate('tabs.files'))),
          h('button', {
            type: 'button',
            role: 'tab',
            className: 'dcr-tab',
            'aria-selected': active === 'plots',
            onClick: function onPlots() { actions.setRailTab('plots') },
          }, h('span', { className: 'dcr-tabGlyph', 'aria-hidden': 'true' }, h(PlotsGlyph)), h('span', null, translate('tabs.plots')))),
        h('div', { className: 'dcr-railBody' },
          active === 'plots'
            ? h(PlotsPanel, { t: translate, snapshot: snapshot, actions: actions })
            : h(FilesPanel, { t: translate, snapshot: snapshot, actions: actions })))
    }

    // ── Page header ────────────────────────────────────────────────────────
    function PageHeader(props) {
      const translate = props.t
      return h('header', { className: 'dcr-header' },
        h('div', { className: 'dcr-headText' },
          h('h1', { className: 'dcr-title' }, translate('panel.title')),
          h('p', { className: 'dcr-subtitle' }, translate('panel.subtitle'))),
        h(HostChip, { t: translate, snapshot: props.snapshot }))
    }

    // ── Surface content (page + pane share this tree) ──────────────────────
    function WorkbenchContent(props) {
      const translate = props.t || t
      const mode = props.mode === 'pane' ? 'pane' : 'page'
      useLocaleRefresh()
      const snapshot = useWorkbenchSnapshot()
      const narrow = useMediaQuery('(max-width: 720px)')

      React.useEffect(function attachSurface() {
        return store.attach()
      }, [])

      const actions = store.actions
      const isPage = mode === 'page'
      const tabs = isPage && !narrow
        ? [{ id: 'console' }]
        : buildBottomTabs(translate, snapshot)
      const tabIds = tabs.map(function tabId(tab) { return tab.id })
      let activeTab = snapshot.ui.bottomTab
      if (tabIds.indexOf(activeTab) < 0) activeTab = 'console'

      // Plots seen bookkeeping: opening the Plots view clears the badge.
      React.useEffect(function markPlotsSeenEffect() {
        const plotsVisible = activeTab === 'plots' || (isPage && !narrow && snapshot.ui.railTab === 'plots')
        if (plotsVisible && snapshot.ui.plotsUnseen > 0) store.actions.markPlotsSeen()
      }, [activeTab, isPage, narrow, snapshot.ui.plotsUnseen, snapshot.ui.railTab])

      // Lazy-load the Plots for the current run when the panel becomes visible.
      React.useEffect(function ensurePlotsForRun() {
        if (snapshot.run.runId === null) return
        if (snapshot.plots.runId === snapshot.run.runId) return
        // Do not auto-retry a failed artifacts read; the Refresh control owns that.
        if (snapshot.plots.status === 'loading' || snapshot.plots.status === 'error') return
        store.actions.refreshArtifacts()
      }, [snapshot.run.runId, snapshot.plots.runId, snapshot.plots.status])

      const toolbarNode = h(WorkbenchToolbar, { mode: mode, t: translate, snapshot: snapshot, actions: actions })
      const hintNode = h(LanguageHintStrip, { t: translate, snapshot: snapshot })
      const noticeNode = h(SurfaceNotice, { t: translate, snapshot: snapshot })
      const dialogsNode = h(SurfaceDialogs, { t: translate, snapshot: snapshot, actions: actions })
      const editorNode = h(CodeEditor, { t: translate, snapshot: snapshot, actions: actions })
      const dividerNode = h(SplitDivider, {
        ratio: snapshot.ui.splitRatio,
        label: translate('output.title'),
        onRatio: function onRatio(value) { actions.setSplitRatio(value) },
        onCommit: function onCommit() { actions.persistSplitRatio() },
      })
      const bottomNode = h(WorkbenchBottomPanel, {
        t: translate,
        snapshot: snapshot,
        actions: actions,
        tabs: isPage && !narrow ? [{ id: 'console' }] : tabs,
        activeTab: activeTab,
      })
      const statusNode = h(WorkbenchStatusBar, { t: translate, snapshot: snapshot, actions: actions })
      const lightboxNode = snapshot.ui.lightbox
        ? h(PlotsLightbox, { t: translate, snapshot: snapshot, actions: actions, lightbox: snapshot.ui.lightbox })
        : null

      if (isPage) {
        const showRail = !narrow
        return h('div', { className: 'dcr-pageShell' },
          h(PageHeader, { t: translate, snapshot: snapshot }),
          noticeNode,
          toolbarNode,
          hintNode,
          dialogsNode,
          h('div', { className: 'dcr-pageGrid' },
            showRail ? h(PageRail, { t: translate, snapshot: snapshot, actions: actions }) : null,
            h('div', { className: 'dcr-mainCol' }, editorNode, dividerNode, bottomNode)),
          statusNode,
          lightboxNode)
      }
      return h('div', { className: 'dcr-paneShell' },
        toolbarNode,
        hintNode,
        noticeNode,
        dialogsNode,
        editorNode,
        dividerNode,
        bottomNode,
        statusNode,
        lightboxNode)
    }

    function Workbench(props) {
      const mode = props.mode === 'pane' ? 'pane' : 'page'
      const translate = typeof props.t === 'function' ? props.t : t
      useLocaleRefresh()
      // Prove from the shell that this surface really mounted on the live page
      // (and report its crash via the boundary, not a blank slot).
      React.useEffect(function reportSurfaceLifecycle() {
        reportDiag('surface-mount', {
          mode: mode,
          width: typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0,
        })
        return function reportSurfaceUnmount() {
          reportDiag('surface-unmount', { mode: mode })
        }
      }, [])
      return h('div', {
        className: 'dcr-surface dcr-mode-' + mode,
        'data-dsh-code-runner-view': mode,
      },
        h('style', null, PANEL_CSS),
        h(WorkbenchBoundary, { t: translate },
          h(WorkbenchContent, { mode: mode, t: translate })))
    }

    /** v1 main-slot page component. */
    function PageWorkbench(ownerProps) {
      const props = ownerProps || {}
      const translate = typeof props.t === 'function' ? props.t : t
      return h(Workbench, { mode: 'page', t: translate })
    }

    /** Right-sidebar tab body; the shell mounts it while the tab is open. */
    function PaneWorkbench() {
      return h(Workbench, { mode: 'pane', t: t })
    }

    // ── Right-sidebar tab registration pieces ──────────────────────────────
    /**
     * The tab-type declaration. The shipped right-sidebar registry calls
     * `title(address)` for the tab chip and `entry.title()` /
     * `entry.description?.()` for every guide capsule, so these are thunks,
     * not pre-translated strings.
     */
    function rightTabDefinition() {
      return {
        id: RIGHT_TAB_ID,
        kind: RIGHT_TAB_KIND,
        title: function rightTabTitle() { return t('panel.title') },
        guide: [{
          id: RIGHT_TAB_ID,
          order: PANEL_ORDER,
          title: function rightTabGuideTitle() { return t('panel.title') },
          description: function rightTabGuideDescription() { return t('panel.subtitle') },
        }],
        keepMounted: true,
      }
    }

    // ── Plugin entry: registrations ────────────────────────────────────────
    function apply(ctx) {
      rootContext = ctx

      ctx.effect(function registerLocale() {
        return ctx.locale.register(NS, { zh, en })
      }, 'dsh-code-runner: locale')

      let bound = null
      try {
        bound = ctx.locale.bind(NS)
      } catch (error) {
        bound = null
      }
      wireLocale(ctx.locale, bound)

      // (v1) left sidebar row
      ctx.effect(function registerSidebarRow() {
        return ctx.slots.inject('sidebar.panellist', function mountSidebarRow() {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function panelLabel() { return t('panel.label') },
            locale: NS,
          }, SidebarIcon)
        })
      }, 'dsh-code-runner: sidebar row')

      // (v1) keyed main page — the big-screen workbench fallback
      ctx.effect(function registerMainPanel() {
        return ctx.slots.inject('main', function mountMainPanel() {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: function panelInject() { return { t: t } },
          }, PageWorkbench)
        })
      }, 'dsh-code-runner: panel')

      // (v2) right-sidebar tab type + keyed tab body. The services are
      // optional: if they never arrive the v1 page remains the way in, so the
      // module's inject array stays exactly ['slots', 'locale'].
      ctx.effect(function registerRightTab() {
        let tabApplyCount = 0
        let lastTabTypeError = null
        let sharedTabType = false
        let disposed = false
        const ownedDisposers = []
        const feed = ctx.inject(['sidebarRightTabs', 'sidebarRight'], function mountRightTab(scoped) {
          tabApplyCount += 1
          const scope = scoped || {}
          const slotHost = scope.slots ? scope : ctx
          let offType = null
          let offBody = null
          // The tab type lives in a root-scoped registry owned by the shell. A
          // client hot-reload can mount the new module before the previous
          // generation's fiber is torn down, and the registry refuses a second
          // registration of the same id. Keep exactly one type per PAGE: the
          // first generation registers it and marks a page global; later
          // generations (HMR) reuse it. The body registration below is keyed by
          // the same id, so the newest body still wins.
          const pageHolder = typeof window !== 'undefined' && window ? window : null
          const sharedKey = '__DSH_CODE_RUNNER_RIGHT_TAB_REGISTERED__'
          try {
            const tabs = scope.sidebarRightTabs
              || (typeof scope.get === 'function' ? scope.get('sidebarRightTabs') : null)
            const alreadyRegistered = Boolean(pageHolder && pageHolder[sharedKey] === true)
            if (alreadyRegistered) {
              sharedTabType = true
            } else if (tabs && typeof tabs.register === 'function') {
              offType = tabs.register(rightTabDefinition())
              sharedTabType = true
              try { if (pageHolder) pageHolder[sharedKey] = true } catch (ignored) { /* ignore */ }
            } else {
              lastTabTypeError = 'sidebarRightTabs.register unavailable'
            }
          } catch (error) {
            const message = String((error && error.message) || error).slice(0, 300)
            if (/already registered/i.test(message)) {
              // A leaked registration from an earlier generation still provides
              // the type; treat it as shared instead of failing the feature.
              sharedTabType = true
              try { if (pageHolder) pageHolder[sharedKey] = true } catch (ignored) { /* ignore */ }
            } else {
              lastTabTypeError = message
              try { console.error('[dsh-code-runner] tab type registration failed', error) } catch (ignored) { /* ignore */ }
            }
          }
          try {
            if (slotHost && slotHost.slots && typeof slotHost.slots.inject === 'function') {
              offBody = slotHost.slots.inject('sidebar.right.pane.tab', function mountRightTabBody() {
                return slotHost.slots.register({
                  name: 'sidebar.right.pane.tab',
                  key: RIGHT_TAB_ID,
                  locale: NS,
                }, PaneWorkbench)
              })
            }
          } catch (error) {
            try { console.error('[dsh-code-runner] tab body registration failed', error) } catch (ignored) { /* ignore */ }
          }
          if (disposed) {
            // The surface was torn down while the injected fiber was starting:
            // release anything this callback just acquired.
            try { if (typeof offBody === 'function') offBody() } catch (ignored) { /* ignore */ }
            try { if (typeof offType === 'function') offType() } catch (ignored) { /* ignore */ }
            return function disposeLateRightTab() {}
          }
          ownedDisposers.push(function disposeRightTabRegistrations() {
            try { if (typeof offBody === 'function') offBody() } catch (ignored) { /* ignore */ }
            try { if (typeof offType === 'function') offType() } catch (ignored) { /* ignore */ }
          })
          reportDiag('right-tab', {
            tabType: Boolean(offType) || sharedTabType,
            registered: Boolean(offType),
            shared: sharedTabType,
            body: Boolean(offBody),
            tabApplyCount: tabApplyCount,
            tabTypeError: lastTabTypeError,
          })
          return function disposeRightTab() {
            try { if (typeof offBody === 'function') offBody() } catch (error) { /* ignore */ }
            try { if (typeof offType === 'function') offType() } catch (error) { /* ignore */ }
          }
        })
        // Dispose our own registrations synchronously first (the fiber's own
        // disposal is best-effort and may resolve later), then release the feed.
        return function disposeRightTabFeed() {
          if (disposed) return undefined
          disposed = true
          for (const dispose of ownedDisposers.splice(0).reverse()) {
            try { dispose() } catch (error) { /* ignore */ }
          }
          try {
            if (!feed) return undefined
            if (typeof feed === 'function') return feed()
            if (typeof feed.dispose === 'function') return feed.dispose()
            if (typeof feed.then === 'function') {
              return feed.then(function disposeLoadedFiber(fiber) {
                try {
                  if (fiber && typeof fiber.dispose === 'function') return fiber.dispose()
                } catch (error) { /* ignore */ }
                return undefined
              })
            }
          } catch (error) {
            try { console.error('[dsh-code-runner] right tab disposal failed', error) } catch (ignored) { /* ignore */ }
          }
          return undefined
        }
      }, 'dsh-code-runner: right tab')

      // (v2) conversation-header toggle
      ctx.effect(function registerHeaderToggle() {
        return ctx.slots.inject('conversation.session.header.utilities', function mountHeaderToggle() {
          reportDiag('header-toggle', { mounted: true })
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: HEADER_TOGGLE_ID,
            order: 5,
            label: function headerToggleLabel() { return t('panel.label') },
            locale: NS,
          }, HeaderToggle)
        })
      }, 'dsh-code-runner: header toggle')

      // (v2) one-time onboarding: the user asked for the workbench BESIDE the
      // conversation, so the very first page load after the upgrade opens the
      // right panel once. Afterwards the shell's own per-session layout memory
      // owns it (open/closed), and this flag keeps us from ever doing it again.
      // Real browser only (document) — headless harnesses never schedule it.
      ctx.effect(function autoOpenRightbar() {
        const STORAGE_KEY = 'dsh-code-runner.autopened.v2'
        if (typeof document === 'undefined' || typeof window === 'undefined') {
          return function noopAutoOpen() {}
        }
        let storage = null
        try { storage = window.localStorage } catch (error) { storage = null }
        try {
          if (storage && storage.getItem(STORAGE_KEY) === '1') return function alreadyAutoOpened() {}
        } catch (error) { /* ignore storage failures */ }
        let cancelled = false
        let timer = null
        let attempts = 0
        const finish = function finishAutoOpen() {
          try { if (storage) storage.setItem(STORAGE_KEY, '1') } catch (error) { /* ignore */ }
        }
        const tryOpen = function tryAutoOpen() {
          timer = null
          if (cancelled) return
          attempts += 1
          try {
            const right = rootContext && typeof rootContext.get === 'function' ? rootContext.get('sidebarRight') : null
            if (right && typeof right.openTab === 'function') {
              let expanded = false
              try { expanded = typeof right.isExpanded === 'function' && right.isExpanded() === true } catch (error) { expanded = false }
              if (expanded) {
                // The shell already restored a layout (ours or the user's): leave it alone.
                finish()
                return
              }
              try {
                // openTab needs a Session on screen; retry briefly until one mounts.
                right.openTab(RIGHT_TAB_KIND)
                reportDiag('auto-open', { ok: true, attempts: attempts })
                finish()
                return
              } catch (error) {
                if (attempts >= 30) return
                timer = setTimeout(tryOpen, 700)
                return
              }
            }
          } catch (error) { /* fall through to the retry below */ }
          if (attempts >= 30) {
            reportDiag('auto-open', { ok: false, attempts: attempts })
            return
          }
          timer = setTimeout(tryOpen, 700)
        }
        timer = setTimeout(tryOpen, 900)
        return function cancelAutoOpen() {
          cancelled = true
          if (timer !== null) { clearTimeout(timer); timer = null }
        }
      }, 'dsh-code-runner: auto open right panel')

      // Boot fingerprint: proves which client build the page loaded and which
      // optional right-sidebar services this shell exposes.
      reportDiag('apply', {
        version: CLIENT_VERSION,
        hasSidebarRight: Boolean(ctx.get && ctx.get('sidebarRight')),
        hasSidebarRightTabs: Boolean(ctx.get && ctx.get('sidebarRightTabs')),
        localeBound: Boolean(bound),
      })
    }

    return { name: 'dsh-code-runner', inject: ['slots', 'locale'], apply: apply }
  },
})
