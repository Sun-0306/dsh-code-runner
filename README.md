# dsh-code-runner · 代码运行器（v5 · 0.5.0）

DeepSeek Harness (DSH) 插件：在 **对话框右侧** 打开一个 RStudio 风格的代码工作台，直接运行
Python、R、Node.js 等脚本，**图表自动显示**，并且可以 **打开 / 编辑 / 保存工作目录里的程序文件**。
不必离开和 DeepSeek 的对话。

- **v5 新增**：语言功能包按需安装 —— 检测到本机有某语言才自动启用并安装其图形捕获程序（没有就不加任何文件）；
  语言下拉旁「语言与功能」可一键启用/停用；可选包 **C / C++ / Swift**（检测到工具链后可一键安装，C/C++ 先编译再运行）；
  Python 捕获依赖（matplotlib）自动探测并给出安装提示。
- **v4**：导出报告可选格式（**Word .docx** / Markdown / HTML / 全部）、文件名自动为
  `<程序名>实验报告`、可勾选是否插入**源代码 / 输出结果 / 统计图 / AI 解读**，文档按
  「源代码：/ 输出结果：/ 统计图：」结构输出；Word 由 Host 用纯 Node 生成（无需 Office/pandoc）。
- **v3**：运行选中的代码；AI 自动注释/解释代码（使用 DSH 默认模型）；一键把「代码 + 输出 +
  图表 + AI 解读」导出为文档文件夹（report.md + 自包含 report.html）；MATLAB 支持（R2026a 自动发现、
  figure 自动导出）；图表一键保存到代码所在文件夹；切换语言时界面自适应（控制台名称、提示、模板、
  扩展名、MATLAB 启动提示）。
- v2 能力：右侧栏面板（对话与代码同屏）、图表画廊（matplotlib / R / MATLAB 图形自动捕获）、文件
  浏览器与编辑器（打开、⌘S 保存、冲突检测、直接运行磁盘文件）。
- v1 能力：左侧栏入口 + 中央全屏工作台、流式输出、停止/超时、语言探测、token 安全闸门。

## 两个入口

| 入口 | 形态 | 适合 |
|---|---|---|
| 对话右上角 **代码运行器图标**（或右侧栏「+」→「代码运行器」） | 右侧栏 tab，与对话并排 | 边聊边跑、看图表 |
| 左侧栏「代码运行器」图标（order 30） | 中央全屏页面 | 大屏、RStudio 式三栏布局 |

右侧栏 tab 里是紧凑模式：顶部工具栏（文件、保存、运行/停止、语言、工作目录）、带行号的编辑器、
可拖动分隔条、底部 **控制台 / 图表 / 文件** 三个标签页以及一行状态栏。全屏页面模式则把
「文件/图表」放进左侧栏、编辑器和控制器上下排列。

升级到 v2 后 **首次加载会在这个浏览器里自动打开一次右侧工作台**（localStorage 标记
`dsh-code-runner.autopened.v2`，只一次）；之后右侧栏按会话记住你上次的开/关与标签布局，
头部图标则用于随时展开/收起。

## 功能

### 运行
- 自动探测本机解释器：Python 3.13.9、R 4.6.1、**MATLAB R2026a**、Node v24、Bash、Zsh、Ruby、Perl（Julia/Deno/Bun/PHP
  未安装时自动隐藏，可「重新扫描」）。
- **运行编辑器内容**（scratch buffer）或 **运行打开的文件**：打开文件后 Run 会先自动保存再以
  `mode:"file"` 直接在磁盘上执行（`scriptPath` 就是该文件，`__file__`/相对路径行为与命令行一致）。
- 流式 stdout/stderr、退出码/信号/超时/耗时、停止按钮、⌘/Ctrl+Enter 运行、⌘/Ctrl+S 保存。
- 工作目录会持久化，可用「选择…」从系统目录选择器挑选；每个语言保留独立草稿。

### 运行选中的代码（v3）
- 在编辑器里选中若干行，点工具栏 **运行选中**（或 `⌘/Ctrl+Shift+Enter`），只执行选中的片段
  （以 buffer 模式在相同工作目录/语言下运行，编辑器内容不受影响，控制台会标记「选中运行」）。
- 适合 R/Python 交互式探索：先定义变量，再选几行逐步运行。

### AI 注释 / 解释代码（v3）
- 工具栏 **理解 / 注释代码**：把当前代码（有选中时用选中部分）发给 DSH 的默认模型，返回
  中文解释 + 带注释的代码版本；可 **插入注释版本到编辑器**（一次撤销可还原）、**复制解释**。
- 模型来自 **设置 → 模型**（默认 `deepseek-account/deepseek-flash`）。未配置模型时对话框会提示
  「先在 DSH 设置里配置模型/提供商」；网络/超时错误会给出可重试的提示。
- 代码超过 20,000 字符会截断后发送（对话框会标注）；请求经过 Host，token 门禁与其它接口一致。

### 导出运行报告（v3）
- 工具栏 **导出报告** 打开导出对话框，可选择：
  - **文件格式**：Word（`.docx`，默认）、Markdown（`.md`）、HTML（`.html`，图表内嵌）、全部格式；
  - **插入内容**：源代码 / 输出结果 / 统计图 / AI 解读（逐项勾选，不需要的不会写进文档）；
  - **文件名**：自动为「程序文件名 + 实验报告」，例如 `chart.R` → `chart实验报告.docx`。
- 报告写入 **代码文件所在目录**（草稿则在当前工作目录）下的新文件夹：
  `dsh-code-runner-reports/<时间戳>-<语言>/`，其中文档结构固定为 **源代码：/ 输出结果：/ 统计图：**
  （勾选了 AI 解读时追加「AI 解读：」）；Word 中代码/输出用等宽字体、统计图内嵌为图片并带图注。
  另含 `run.json` 元数据与 `plots/` 图片副本；同一秒重名文件夹自动 `-2`，绝不覆盖旧报告。
- 每次导出都新建文件夹（同一秒重名自动 `-2`），不会覆盖旧报告；这些文件夹是用户文档，插件不会删除。
  成功后会显示路径并提供「复制路径」，状态栏也保留可点击的报告目录入口。

### MATLAB 支持（v3）
- 自动发现 `matlab`（含 `/Applications/MATLAB_R*.app/bin/matlab`、`/usr/local/MATLAB/*/bin/matlab`）；
  **R2026a 已在本机验证**：`-batch` 执行包装脚本，运行后把每个 `figure` 用 `exportgraphics` 导出到
  图表页（`source:run` PNG）。
- 注意事项：MATLAB 需要本机许可证且首次启动较慢（约 15–25 秒，界面会显示「正在启动 MATLAB…」）；
  未安装时该语言自动隐藏。包装脚本变量统一用 `dsh*` 前缀，避免 MATLAB `run()` 与 `script` 变量名冲突。

### 图表保存与呈现（v3）
- 图表卡片悬停出现 **保存**；灯箱底部有 **保存图片**；图表页头部有 **全部保存**。
- 默认保存到 **当前打开代码文件所在文件夹**（无文件时为工作目录），重名自动加 `-1/-2`，绝不覆盖；
  成功提示会显示目标文件夹，状态栏保留可点击入口。
- 呈现升级：页面模式更大的图表网格、文件名/来源/大小信息、灯箱元信息、加载骨架与空状态。

### 语言自适应界面（v3）
- 切换语言时界面自动适配：控制台/命令窗口名称、工具栏下的提示条、启动模板、另存为默认扩展名、
  状态栏语言名；MATLAB 额外显示启动提示，Python/R 显示绘图捕获提示。

### 图表（类似 RStudio Plots）
- **Python**：脚本里 `import matplotlib.pyplot as plt` 并画图（**不需要 savefig**），运行结束后图形
  自动保存为 PNG 并出现在「图表」标签页；`plt.show()` 在 Agg 后端下无副作用。
- **R**：`plot(...)`、ggplot2 等图形由 `png` 设备自动捕获（脚本无需写 `png()`/`dev.off()`；顶层可见结果会自动打印，与 `Rscript script.R` 一致，所以直接写 `ggplot(...) + geom_*()` 就能出图，无需 `print()`）。
- 另外，脚本在 **工作目录** 里新写出的图片（png/jpg/gif/webp/svg/bmp/avif）也会出现在图表页，
  带「运行产物 / 目录」来源标记。
- 缩略图网格，点击打开灯箱：大图、上一张/下一张、复制路径、Esc 关闭；运行过程中每 1.2 秒自动
  刷新，新图出现会自动切到图表页；「刷新」按钮可手动重新扫描。
- 需要自己 `savefig`/`png()` 的脚本也能用：文件会作为「目录」来源被扫描到。

### 文件（直接打开工作文件夹里的程序）
- 「文件」标签页：面包屑、上一级、刷新、目录优先排序、点目录进入、点文本文件打开到编辑器
  （按扩展名自动选语言：.py/.R/.mjs/.sh/.rb/.pl/.jl/.php/.ts …）。
- 打开图片文件会直接在灯箱预览；二进制文件给出提示。
- 保存：按钮或 ⌘/Ctrl+S，带 `baseMtimeMs` 冲突检测——文件被外部改动时提示「覆盖 / 取消」后强制保存。
- 草稿缓冲区可「另存为」到当前工作目录，随后自动切换为文件模式。
- 有未保存修改时切换文件会先确认（放弃 / 取消）。

## HTTP API（Host 半，同源 + token 门禁）

| Method | Path | 用途 |
|---|---|---|
| GET | `/dsh-code-runner/api/env` | 平台、默认目录、上限、本机语言/版本/模板（`?refresh` 跳过缓存） |
| POST | `/dsh-code-runner/api/run` | `{mode:'buffer'\|'file', language?, code?, file?, cwd?, stdin?, timeoutMs?, capturePlots?}` → `{runId, plotDir, …}` |
| GET | `/dsh-code-runner/api/output` | `?runId=&stdoutFrom=&stderrFrom=` → 增量输出 + 状态 |
| POST | `/dsh-code-runner/api/stop` | `{runId}` 终止进程 |
| GET | `/dsh-code-runner/api/files` | `?dir=` 列目录（目录优先、2000 条上限） |
| GET | `/dsh-code-runner/api/file` | `?path=` 读文本（1 MiB 截断、二进制检测） |
| POST | `/dsh-code-runner/api/file` | `{path, text, baseMtimeMs?}` 保存（409 冲突 / 强制覆盖） |
| GET | `/dsh-code-runner/api/blob` | `?path=` 图片/PDF 原始字节（唯一非 JSON 路由） |
| GET | `/dsh-code-runner/api/artifacts` | `?runId=` 本次运行的图表（运行产物 + 工作目录图片） |
| GET | `/dsh-code-runner/api/token` | 仅 loopback 的 CSRF token bootstrap |
| GET/POST | `/dsh-code-runner/api/diag` | 浏览器诊断事件（内存储环缓冲，排障用） |
| POST | `/dsh-code-runner/api/explain` | `{language, code, fileName?}` → AI 解释 `{summary, annotatedCode}`（需已配置模型） |
| POST | `/dsh-code-runner/api/export` | `{format:'docx'\|'md'\|'html'\|'all', include:{code,output,plots,summary}, name?}` → `<程序名>实验报告.<ext>` + run.json/plots |
| POST | `/dsh-code-runner/api/save-plots` | `{plots, targetDir}` → 图表复制到代码文件夹（去重不覆盖） |

所有调用（除 `/api/token`）都要带 `x-dsh-code-runner-token`，值来自 Host 注入页面的
`window.__DSH_CODE_RUNNER__`（页面在插件激活前加载时自动走 loopback bootstrap）。跨站请求被拒绝，
没有 CORS。

## 安装 / 升级

本机已作为本地 bundle 安装（`link:/Users/sunchujun/Desktop/deepseek/dsh-code-runner`）：

```
plugin_manager action=install_bundle target=<绝对路径>/dsh-code-runner
```

修改源码后无需重启：Host 与 Client 代码由 HMR 从链接目录热加载（插件管理器的一次重算也会替换
已改动的文件的插件）。其他部署用同一份目录安装即可。

## 开发与测试

无构建、无第三方依赖：直接改 `index.js` / `client.js`，`node --check` 后热加载。

| 套件 | 内容 | 当前 |
|---|---|---|
| `node tests/host-smoke.mjs` | Host 路由契约 + 真实 python/R/绘图 + 文件/诊断/语言包接口（stub ctx） | 44/44 |
| `node tests/verify-host.mjs` | 独立实现的 stub Host 契约套件（含 explain/export/save-plots/MATLAB 规格、90s 超时） | 96/96 |
| `node tests/verify-static.mjs` | manifest/locale/图标/两半静态契约（含 v3 标记与 locale 键） | 88/88 |
| `node tests/verify-live.mjs` | 对运行中的 DSH 做端到端（真实 LLM explain、**Word/MD/HTML 报告导出**、图表保存、**真实 MATLAB 运行+出图**、选中运行语义） | 41/41 |
| `tests/client-real-react.mjs`（可选，需 react/react-dom/jsdom） | 真实 React 18 + jsdom 渲染两种布局 + StrictMode + 主流程点击；捕获 VM 测不出的 React #130 | 17/17 |
| `node tests/client-smoke.mjs` | VM 内渲染真实 client 模块（注册、两种布局、文件/图表/灯箱、选中运行、AI 对话框、导出格式、**语言与功能对话框**、图表保存、语言自适应、元素类型守卫、诊断） | 98/98 |

契约：`CONTRACT.md`（v1）+ `CONTRACT-V2.md`（文件/绘图）+ `CONTRACT-V3.md`（AI/导出/图表/MATLAB/选中）+ `CONTRACT-V5.md`（语言功能包按需安装）。

> 回归守卫：`client-smoke` 的迷你 React 会像真实 React 一样拒绝非法元素类型（React #130），
> 例如把 `h(组件)` 误写成 `h(组件())`；v2 首次上线时正是这类写法导致右侧面板报「面板出错了」，
> 已修复并用真实 React 18 + jsdom 的渲染/交互复现验证。

## 故障排查

右侧面板/全屏页如果显示「面板出错了」：先刷新页面。之后可以从命令行读取浏览器诊断，
看清真实页面发生了什么（加载了哪个版本、右侧 tab 类型是否注册、面板是否挂载、有没有崩溃事件）：

```bash
TOKEN=$(curl -s http://127.0.0.1:57598/dsh-code-runner/api/token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -H "x-dsh-code-runner-token: $TOKEN" http://127.0.0.1:57598/dsh-code-runner/api/diag | python3 -m json.tool
```

事件名：`apply`（客户端版本 + 右侧栏服务是否可用）、`right-tab`（tab 类型/面板注册结果）、
`header-toggle`、`auto-open`、`toggle`、`surface-mount` / `surface-unmount`、
`surface-crash`（错误边界捕获的崩溃及组件栈）、`run`、`artifacts`。缓冲仅最新 100 条、
仅内存、随页面/Host 重载清空。

## 安全说明

这是本机代码执行 + 文件读写能力：Host 端有 CSRF token（仅注入页面 / loopback bootstrap）、
Origin 同源校验与跨站拒绝，且没有 CORS。`/api/token` 只应答 loopback 对端 + loopback Host 头，
反向代理/隧道呈现公网 authority 时会被 403 拒绝。请勿把 DSH Web 服务暴露到不可信网络。

## 卸载

设置 → 插件 → Code Runner 移除，或 `plugin_manager action=remove_bundle`。运行临时目录
（脚本副本、绘图中间产物）会随插件卸载/运行淘汰清理；工作目录里的用户文件永远不动。

License: MIT.
