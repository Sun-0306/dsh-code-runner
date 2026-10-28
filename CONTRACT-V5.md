# dsh-code-runner v5 — 语言功能包（按需安装 / 检测即启用）

## 1. 目标
不同用户只需要部分语言。v5 把每种语言做成一个「功能包」：**检测到本机可执行文件 → 自动启用并安装该语言的图形捕获配置；未安装 → 不加入、不安装任何文件**；用户也可在面板里一键启用/停用。

## 2. Host
### 2.1 功能包模型
- 内置包（默认启用，检测到才出现在语言下拉）：python / r / matlab / node / bash / zsh / ruby / perl / julia / deno / bun / php。
- 可选包（默认停用，需一键安装）：`c`（clang/gcc，先编译再运行）、`cpp`（clang++/g++，同）、`swift`（swift 解释执行）。
- 每个包声明：id、label、探测候选、扩展名、脚本名、argv（或 compile 规则）、`captureKind`（python/r/matlab/none）。
- 设置与已安装资产：`$DSH_HOME/dsh-code-runner/`（`packs.json` + `packs/<id>/<helper>`）。测试可用 `DSH_CODE_RUNNER_STATE_DIR` 覆盖。
- 自动安装：`/api/env` 构建时，对**已启用且已检测到**的捕获型语言确保安装 helper（幂等）。运行优先使用已安装 helper，缺失时退化为每次运行生成。
- Python 捕获依赖探测：`python -c "import matplotlib"`（8s 超时，10 分钟缓存），未就绪给出 `pip install matplotlib` 提示；R/MATLAB 图形设备内置，检测到即 ready。

### 2.2 API（同 token/同源门禁）
- `GET /api/packs` → `{ok, stateDir, packs:[{id,label,builtin,enabled,detected,command,extensions,capture:{kind,required,ready,hint,installed}}]}`
- `POST /api/packs` `{id, enabled}` → 启用/停用并持久化；启用可选包要求已检测到（否则 400 `language-unavailable`），启用时安装捕获 helper；返回最新 packs 列表。内置包停用后从 `/api/env` 语言列表消失（不删除已安装 helper）。
- `POST /api/packs/rescan` → 清空检测/依赖缓存并返回最新 packs。
- 编译型语言（c/cpp）：先以编译器 argv 执行，编译失败时该次运行直接以编译进程的输出与退出码结束；成功后再运行产物；`run`/`output`/`artifacts` 语义不变。

## 3. Client
- 语言下拉旁新增「语言与功能」按钮 → 对话框列出全部功能包：语言名、检测状态、捕获状态（自动捕获图形 / 无 / 缺少依赖）、启用/停用（或未检测到）、依赖提示；支持「重新检测」与关闭。
- 启用/停用后自动刷新语言下拉（`/api/env`）与包列表；所有文字走 locale（zh/en 同键集）。
- 语言切换、运行、图表、导出等既有行为不变。

## 4. 验收
- `host-smoke`：packs GET（R 检测→自动安装、Python helper、C 默认停用）、一键启用 C 后 env 出现并真实编译运行、停用后消失、401/校验。
- `client-smoke`：语言与功能对话框（列表、捕获状态、未检测语言不可启用、一键启用请求体、关闭）。
- `verify-live`：真实页面/真实 Host 启用 C → 编译运行 → 停用；R helper 已安装于 `$DSH_HOME/dsh-code-runner/packs/r/`；Python matplotlib 探测；未知包报错。
