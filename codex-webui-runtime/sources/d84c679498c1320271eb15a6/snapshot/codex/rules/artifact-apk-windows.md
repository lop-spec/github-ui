# Windows、产物、APK 专项规则

读取触发：任务涉及 Windows shell/路径、cmd/nu/nush/nushell、文件或目录展示、生成产物、安装包/APK、Android 本地测试、可执行文件、打包签名、版本号、可打开路径。

## Windows 命令

- Windows 本地操作默认 shellless：命令执行、文件、打开、注册表、服务、进程、端口、文本、JSON、zip/unzip 一律先触发 `$lop-winops`，首选 `C:\Users\lop\.codex\tools\winops\winops.exe <job.json>`；复杂内容只写 UTF-8 job 文件，主结果写 result.json，stdout 只作为结果路径提示。
- `cmd/pwsh/nu/nush` 只允许三类例外：当前 Codex 执行工具需要宿主进程来启动 `winops.exe` 的 bootstrap；winops 尚未覆盖的系统对象/API；用户明确要求 shell 复现。例外必须说明原因，且复杂业务内容仍不得进入 shell 命令行。
- 2026-07-04 的 `cmd`/`nu` 横评只保留为 legacy fallback 参考，不再作为默认路线：`cmd` 可处理极短只读外部命令，`nu` 可处理简单结构化过滤；一旦涉及引号、反引号、空格、中文、JSON/HTML/Markdown/正则、长参数或原样输出，立即回到 winops job。
- `winops.exe` 适用：外部进程 argv 保真、文件读写/复制/移动/删除/hash、打开文件/目录/URL、注册表、服务、进程、端口、文本搜索替换、JSON 读写选择、zip/unzip；参数含空格/中文/引号/反引号/`&|()<>%!`、JSON/HTML/Markdown/正则、长参数、需要原样输出、或之前在 `cmd/nu` 中出现拆参/乱码/转义失败时，不再二次堆 shell 转义。
- `run-argv.mjs` 仅作为旧兼容；新任务默认用 `winops.exe`。`.cmd/.bat` 默认拒绝，必须定位真实 `.exe/.js` 入口；确实必须跑 `.cmd/.bat` 时才回到显式 shell 例外并记录原因。
- `winops.exe` job 必须把 `op`、`input`、路径和参数分开写；破坏性操作默认 dry-run，实际执行必须同时设置 `dryRun:false` 和 `confirm:true`；删除默认进 `%USERPROFILE%\.codex\quarantine\winops`，不得默认硬删。
- 总原则：最稳方案不是继续修 shell 转义，而是让业务输入完全退出 shell 命令行；失败默认按规则迁移到 winops job/result，不再归因给 `cmd`、`nu` 或外层转义。
- legacy fallback 转换顺序：只有 winops 不覆盖或用户明确要求 shell 时，才生成目标 shell 标准形态；仍不稳定就停止堆转义，改成 winops job、参数文件或输入文件。
- `cmd` 标准入口优先用 `cmd.exe /d /q /v:off /s /c "..."`；程序路径含空格时标准形态是 `cmd.exe /d /q /v:off /s /c ""C:\Program Files\Tool\tool.exe" "arg with space""`。在 `exec_command` 等外层还会解析引号的场景，先保留这个目标形态，再按外层要求把内层 `"` 成对加倍或改临时 `.cmd`，不要凭感觉混写。
- 简单读文件、查文本、列目录、`rg/git/jq/where` 等外部工具必须用 `cmd`；`exec_command(shell="cmd")` 只用于无嵌套引号、无空格敏感参数、无 `|&<>()^%!` 控制符的扁平命令体。
- cmd 元字符作字面量时用 caret 转义：`^&`、`^|`、`^<`、`^>`、`^(`、`^)`、`^^`。双引号内的元字符通常作为参数字符传给目标程序；若外层会剥掉双引号，立即改临时 `.cmd` 或参数文件。
- 空格路径和空格参数用双引号包住完整 argv；单引号在 cmd 里不是 quoting，只是普通字符；反引号在 cmd 里也是普通字符，禁止把 PowerShell 的反引号当 cmd 转义符，反引号出错时优先判定为外层解析问题并改 `.cmd`/文件输入。
- 变量默认用 `set "NAME=value"` 和 `%NAME%`；默认 `/v:off` 防止 `!` 被延迟扩展吞掉。批处理文件中要输出字面 `%` 写 `%%`；变量值本身含字面双引号时，不要混进 `set "..."`，改文件输入/参数文件，或用纯 cmd caret 形态单独验证；需要循环内更新变量时才显式 `/v:on` 并处理 `!`。
- 固定字符串搜索优先用无空格锚点或多个 `-e` 分开查；只有本层引号已验证稳定时才用 `rg -n -F -- "text" "file"`。正则优先 `rg -n -- "pattern" "file"`；含空格、`|`、引号、反引号、中文、换行、复杂正则或大量标点时，统一改 pattern 文件：`rg -n -F -f patterns.txt -- "file"`，或改无空格关键词锚点，不要继续堆转义。
- `findstr` 只用于单词级简单过滤；多词、中文、标点、正则、括号和路径有空格时，改用 `rg -F`、`rg -e`、pattern 文件或脚本探针。
- 大复制优先 `robocopy`；超大枚举或结构化管道必须优先用 `nu`。
- `cmd` 中禁止使用 PowerShell 语法如 `$ts=...`、`$(...)`、对象管道和反引号转义；需要时间戳用纯 cmd 语法、固定文件名或临时脚本。
- `node -e`、`python -c`、JSON、HTML、正则和多行逻辑只允许无内层引号、无模板字符串、无路径、无中文、无 shell 元字符、输出不要求引号保真的短表达式；只要 JS/Python 代码或输出需要字符串字面量、模板字符串、JSON/HTML/正则、Markdown、代码片段、路径、中文、多语句、换行或原样引号，必须改临时 `.mjs`/`.py` 加 argv/文件输入，不能继续硬拼一行。
- 在 `exec_command(shell="cmd")` 等外层还会解析引号的场景，`node -e`/`python -c` 第一次出现拆引号、输出引号丢失/错位、`SyntaxError`、`os error 123`、参数被拆或搜索词被当文件名时，立即停止内联，写临时脚本、pattern 文件或参数文件后用 `cmd` 执行；禁止为了省一步继续二次、三次堆转义。
- Windows 下从 Node/脚本启动 `.cmd` wrapper 易受 spawn/引号影响；能定位到真实 JS/EXE 入口就直调入口，必须跑 `.cmd`/`npm` 时用 shell 模式或显式 `cmd.exe /d /s /c`。
- 当前 `exec_command(shell="cmd")` 中，路径不含空格且命令扁平时可不加引号；路径含空格或参数需要引号时，进入复杂 wrapper/参数文件模板，不能把引号当字面量传给 `rg/python/nu` 导致 `os error 123`。
- `nu`/`nush` 一律按 Nushell 处理：优先用 `C:\Users\lop\AppData\Local\Programs\nu\bin\nu.exe --no-config-file --no-history --no-std-lib -c "..."`；脚本内路径用正斜杠和单引号，外部命令加 `^`，丢弃输出用 `| ignore`，避免把 `>nul`、`%VAR%`、`&&`、`||` 等 cmd 语法塞进 nu。
- `cmd` 或 `nu` 发生语法、引号、重定向、编码或管道错误时，禁止直接逃回 `pwsh`；必须先按上面模板分类改写并重跑，记录成功形态。只有 wrapper/脚本/参数文件仍失败，且任务属于本文件列出的 PowerShell 例外，才可临时用 `pwsh` 并说明原因。
- 若某类 `cmd/nu` 语法错误被修成可复用通用格式，必须立即写入本文件或项目 `RULES.md`，并验证触发词可命中。

## 本地文件/产物展示

- 本地文件链接只用于精确定位/编辑；需要用户直接打开目录时，Windows 原生目录路径和可复制 CMD 打开命令是硬要求，Markdown 链接只能作为可选辅助，不得承诺一定可点击打开。
- 生成产物交付必须三件套：第一行单独输出产物所在目录 Windows 绝对路径；随后给同一目录的可复制 CMD 打开命令 `start "" "C:\Users\...\dist"`，必要时再补 `explorer "C:\Users\...\dist"`；再给文件名、完整路径、哈希/版本/运行方式等必要信息。
- Windows 目录路径必须用原生反斜杠形态 `C:\Users\...\dir`；`C:/...`、`/C:/...`、Markdown 目录链接或渲染器伪路径不得作为唯一打开方式。
- 禁止只给生成文件路径；禁止用 `dir-c`/`dist-c` 当链接文字；禁止输出 `dir -c 路径` 样式；禁止把 `目录链接：reply-layout-previews` 这类相对目录名当作可打开入口；不要假定任何目录超链接一定可直开。

## APK/Android

- 做 APK/安装包改包时，每次重新产出必须递增 versionCode/versionName 或同等版本标识，并使用短文件名，避免长描述导致装错。
- 讨论 APK 本地测试或自动跑通时，必须先盘点当前机器已有 Android/ADB/SDK/反编译/签名工具和运行环境。
- 必须区分宿主机静态检查/构建/反编译/签名/manifest 校验和真实运行 APK；真实运行必须依赖真机、云真机、模拟器、容器或子系统，不能未盘点环境就要求安装完整模拟镜像。
- 当 lop 要 APK 功能场景测试、复现功能、指定流程或“代码/命令跑通功能”时，必须优先给可脚本化的场景复现方案；按“只有 APK 黑盒：Maestro/Appium/uiautomator2/ADB input”，“有源码或测试 APK：Espresso/UIAutomator/Instrumentation/Orchestrator”，“最低依赖命令层：adb am/input/uiautomator dump/logcat/screencap”排序说明。禁止把随机 Monkey、静态分析、云真机/模拟器选型或环境安装当成主答案；这些只能作为运行载体或补充验证。
