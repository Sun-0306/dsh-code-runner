# dsh-code-runner v6 — 报告图表位置（跟随源代码 / 独立章节）

## 1. Host
### 1.1 新字段
- `POST /api/export` 增加 `plotPlacement: "section" | "under-code"`。
- 缺省/`null` → `section`（与 v4/v5 行为完全一致，旧客户端不变）。
- 其他值 → 400 `bad-request`（`plotPlacement must be one of section, under-code`）。

### 1.2 生效规则与顺序
- 有效位置在报告生成时决定：`under-code` 仅当 **勾选源代码 + 勾选统计图 + 至少复制到 1 张图** 时生效，
  否则自动回落 `section`（避免图表悬空）。
- `section`（默认）：`源代码： → 输出结果： → 统计图： →（可选）AI 解读：`。
- `under-code`：`源代码： → 统计图： → 输出结果： →（可选）AI 解读：`；图表不再单独成节。
- 三种格式一致：
  - Markdown：`## 统计图：` 段整体位于代码围栏之后、输出段之前。
  - HTML：源代码与图表包在同一个 `<section class="code-with-plots">` 中，图表网格在代码块下方，
    不生成独立统计图 section；图片内联（base64）与 32 MiB 预算逻辑不变。
  - Word：统计图标题在 under-code 时用 **Heading2**（从属源代码），独立章节仍为 **Heading1**；
    图片与「图 N：文件名」图注位置不变。

### 1.3 元数据
- 响应新增 `plotPlacement`（有效值）。
- `run.json`：`reportVersion: 6`，新增 `plotPlacement`。
- `include` 语义不变；`include.plots=false` 时图表不复制、位置选项无意义（回落 section）。

## 2. Client
- 导出对话框「插入内容」下方新增「图表位置」下拉：
  - `独立章节（统计图：在最后）`（默认）
  - `跟随源代码（放在源代码下方）`
- 本次运行没有图表、或取消勾选「统计图」时下拉置灰，并显示「本次运行还没有图表」提示。
- 下方提示当前段落顺序（`顺序：源代码 → 输出结果 → 统计图` / `顺序：源代码 → 统计图 → 输出结果`）。
- 选择在本次会话内保留（再次打开对话框仍为上次选择）；请求体带 `plotPlacement`。
- 新增 locale 键（zh/en 同键集）：`export.plotPlacement`、`export.plotPlacementSection`、
  `export.plotPlacementUnderCode`、`export.plotPlacementSectionHint`、`export.plotPlacementUnderCodeHint`。

## 3. 验收
- `host-smoke`：under-code 顺序（md 代码→图→输出）、缺省保持独立章节、未知值 400、无代码时回落。
- `verify-host`：三种格式顺序（docx 解包校验 Heading2 与段落序）、run.json v6、默认/校验/回落。
- `verify-static`：Host 标记（`PLOT_PLACEMENTS`/`code-with-plots`/`Heading2`/`reportVersion: 6`）与
  Client 标记（`dcr-export-placement`/`setExportPlotPlacement`）及 locale 键。
- `verify-live`：真实 Host 导出 under-code（md/html/run.json）与默认 section、未知值 400。
- `client-smoke`：位置下拉渲染/默认值/切换提示/请求体传值/重开保留/无图表时置灰。
