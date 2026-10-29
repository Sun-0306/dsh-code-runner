# dsh-code-runner v7 — 数据集导入（仿 RStudio Import Dataset）

## 1. Host
### 1.1 API
- `POST /api/dataset/preview`（同 token / 同源门禁）
  - body：`{ path, language?, sheet?, header?, delimiter?, maxRows? }`
  - `path`：数据文件绝对路径（必填）；`language`：用于挑选 `import` 代码的语言 id（可选）；
    `sheet`：工作表名（xlsx，可选，缺省第一张）；`header`：`true|false`，缺省自动判断；
    `delimiter`：`, ; | \t`（可选，缺省自动探测）；`maxRows`：1–100，缺省 20。
  - 返回：`{ ok, path, name, kind, size, encoding, delimiter, sheets, sheet, header,
    columns:[{index,name,type}], rows:[[...]], totalRows, previewRows, truncated,
    truncatedColumns, variable, snippets:{r,python,matlab}, import:{language,code}|null }`
  - `kind`：`xlsx | csv | tsv | txt`；列类型：`string | number | boolean | date | empty`。
  - 错误：400 `bad-path`/`bad-request`、404 `not-found`、413 `too-large`（>64 MiB）、
    415 `unsupported-file`（含旧版 `.xls`/`.xlsb`/`.ods`：提示另存为 .xlsx/.csv）。
- 支持格式：Excel `.xlsx`（依赖 zlib 自实现的 ZIP + OOXML 读取：sharedStrings、
  workbook/rels 工作表定位、cellXfs/numFmt 日期样式、inlineStr）、CSV/TSV/TXT
  （RFC 引号转义、自动分隔符探测、UTF-8 → GBK 回退、首行表头自动判断）。
- 导入代码（按当前语言挑选，`snippets` 同时返回三种）：
  - R（xlsx）：`library(readxl)` + `read_excel(path, sheet = "…")`
  - R（csv/tsv）：`read.table(..., header = TRUE, sep = …)` / `read.delim(...)`
  - Python：`import pandas as pd` + `pd.read_excel(..., sheet_name=…)` / `pd.read_csv(...)`
  - MATLAB：`readtable(path, 'Sheet', "…")` / `readtable(path)`
  - 变量名由文件名推导（非法字符转 `_`，数字开头加 `data_` 前缀）。

### 1.2 限制
- `datasetMaxBytes` 64 MiB；`datasetPreviewRows` 20；`datasetPreviewCols` 200；
  `datasetMaxScanRows` 500 000。预览只读，不修改/复制数据文件。

## 2. Client
- 工具栏新增 **数据集** 按钮（导出报告旁）→ 「导入数据集（仿 RStudio）」对话框：
  - **数据文件**：绝对路径输入 + 读取；输入框回车即读取。
  - **浏览目录**：当前目录的文件夹与数据文件列表（`/api/files`），点击进入/选择，
    支持上级与刷新。
  - **预览**：工作表下拉（xlsx 多表）、首行为列名开关、分隔符下拉（csv/tsv/txt）、
    行×列摘要、前 N 行表格（列头带类型 tooltip）、列类型识别（含 Excel 日期）。
  - **导入代码**：按当前语言显示代码，**插入到编辑器**（追加到现有代码末尾，对话框关闭，
    提示「导入代码已插入编辑器」）或复制代码。
- 常规对话框行为：无数据文件时提示、读取中/读取失败提示、无当前语言代码片段时提示不支持。
- 新增 locale 键（zh/en 同键集）：`dataset.*`（open/dialogTitle/path/…，见 §2.3）。

## 3. 验收
- `host-smoke`：xlsx（工作表/类型/日期/代码片段）、csv（引号/UTF-8/表头开关）、
  校验（相对路径/缺失/类型/旧版 xls/分隔符）、401。
- `verify-host`：H101–H104（三语言代码片段、工作表切换、无表头字母列名、maxRows 截断、
  显式/自动分隔符、校验与 401）。
- `verify-static`：S91/S92（Host 标记 + Client 标记 + locale 键）。
- `verify-live`：L46/L47（真实 Host 预览 .xlsx/.csv、错误映射）。
- `client-smoke`：数据集对话框打开/文件列表、点选 xlsx 预览与导入代码、工作表切换请求、
  插入编辑器并关闭、csv 分隔符+表头开关请求体。
