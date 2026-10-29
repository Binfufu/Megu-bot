# Megu-bot

[Binfufu/Megu-bot](https://github.com/Binfufu/Megu-bot) 的节点 A 使用入口：腾讯 QQ 开放平台 bot + 代码层搬图。QQ 消息经本地 Node.js 进程处理；普通对话直接请求 OpenAI 兼容模型端点，搬图由代码检索、下载并发送，不交给模型执行。

**这是节点 A 的公开使用说明，不是发布或 CI 通过声明。** 公开集合不包含网页界面、官方角色内容/素材、真实别名表、图库、凭据或私人运行数据；不要按私有部署的目录结构补文件。后续能力不等于本节点已经支持。

许可：[MIT](<LICENSE>)。模型、QQ 服务和图片来源各自的条款仍须遵守；代码许可不授予图片、角色或其他第三方内容的使用权。模型调用可能产生费用，部署者自行控制访问范围、数据保存与费用。

## 需要什么

- Git（用于克隆），以及 Node.js **22 或更高版本**。当前 Node 还必须提供内置 `fetch`、`WebSocket`、`node:sqlite`；建议使用近期的受支持 Node 版本。
- 本项目没有第三方 npm 运行依赖，不需要先执行 `npm install`，也不需要安装其他 agent CLI。
- **仅离线自测不需要 QQ 或模型凭据。** 要连接 QQ，才需要自行在 [QQ 开放平台](https://q.qq.com/) 创建 bot，取得 AppID / ClientSecret，并配置对应的测试成员、消息权限和群聊权限。沙箱权限以平台实际设置为准，环境变量不会替你开启沙箱。
- 普通对话还需要自行配置一个可用的 OpenAI 兼容模型端点、模型名和 key。模板给出的 base URL / model 是可替换的非凭据示例，key 留空。

QQ 事件通过出站 WebSocket 接收，消息通过 OpenAPI 发送。本说明不要求公网入站端口、回调服务、面板或反向代理。请勿把凭据、真实 openid、私聊或日志贴进 issue/PR。

## 1. 从干净克隆开始，先离线自测

以下步骤假设没有 `.env` 或运行数据。选择一种 shell；后面的相对路径命令都在仓库根目录运行。

PowerShell：

```powershell
git clone https://github.com/Binfufu/Megu-bot.git
Set-Location Megu-bot
node --version
node --input-type=module -e "import('node:sqlite').then(() => console.log('sqlite available'))"
node scripts/selftest-public.js
```

POSIX shell（Linux / macOS）：

```sh
git clone https://github.com/Binfufu/Megu-bot.git
cd Megu-bot
node --version
node --input-type=module -e "import('node:sqlite').then(() => console.log('sqlite available'))"
node scripts/selftest-public.js
```

公开测试主入口是 [selftest-public.js](<scripts/selftest-public.js>)：使用内联 fixture、假网络响应与临时目录，不读取你的 QQ/模型凭据，不启动 bot。**公开 CI 覆盖清单（套件/例数/不覆盖项）写在 [CONTRIBUTING.md](CONTRIBUTING.md) 的「公开 CI 覆盖清单」小节，并与入口同步维护**；覆盖范围与排除项以实际输出为准，**它不是完整私库回归，也不证明 QQ、模型或外部图源已经连通**。

也可通过总入口显式选择公开子集：

```sh
node scripts/selftest.js --public
```

不要把无参数 `node scripts/selftest.js` 或 `npm run selftest` 当作公开集合的测试命令：**完整回归属于私库，依赖未公开的完整套件；公开子集不能代替它的通过结果**。不要通过缺文件、跳过套件或手动改计数来伪造全量通过。本说明不声称 GitHub CI 已绿或代码已发布。

## 2. 在本地创建 demo 配置与自己的最小设定

仓库不分发完整角色卡或素材包。下面的「示例助手 / demo」只是原创、最小的身份与回答边界；请在你自己的本地目录创建 UTF-8 的 `AGENTS.md`，按需求自行改写。**不要把模型 key、QQ secret 或其他隐私写进设定文本**，它会作为提示词交给模型端点。想给 bot 配一套自己的角色展示内容（情绪、文案、风格短句等）时，格式见 [内容包格式](<docs/39-内容包格式.md>)；公开集不附带官方内容包，也不提供安装/升级/卸载流程。想了解配置从哪一层来、可选参数文件与内容包参数边界、以及校验失败时的行为，见 [参数系统](<docs/41-参数系统.md>)。

PowerShell：

```powershell
New-Item -ItemType Directory -Force bots/demo, data/demo/workspace | Out-Null
Copy-Item .env.example bots/demo/.env
@'
# 示例助手
你是示例助手，一个简洁、友好的中文问答助手。
优先回答当前用户的问题；不确定时明确说明，不编造已经执行的操作。
不声称自己能访问用户的文件、账号或设备，也不索要密码或密钥。
'@ | Set-Content -Encoding utf8 data/demo/workspace/AGENTS.md
notepad bots/demo/.env
```

POSIX shell：

```sh
mkdir -p bots/demo data/demo/workspace
cp .env.example bots/demo/.env
cat > data/demo/workspace/AGENTS.md <<'EOF'
# 示例助手
你是示例助手，一个简洁、友好的中文问答助手。
优先回答当前用户的问题；不确定时明确说明，不编造已经执行的操作。
不声称自己能访问用户的文件、账号或设备，也不索要密码或密钥。
EOF
# 用你自己的文本编辑器打开 bots/demo/.env。
```

这些是**首次创建**命令；已有配置/设定时不要直接覆盖。你创建的设定、数据库、图片与日志都属于自己的本地数据，默认放在被 Git 忽略的 `data/` 下。

在本地 `.env` 至少核对：

| 键 | 本地配置要求 |
|---|---|
| `QQ_APP_ID` / `QQ_CLIENT_SECRET` | 填你自己的 QQ bot 凭据；模板均为空 |
| `QQBOT_LLM_BASEURL` / `QQBOT_LLM_MODEL` / `QQBOT_LLM_KEY` | 核对你的模型服务；key 留给你本地填写 |
| `QQBOT_ACCESS_MODE=allowlist` / `QQBOT_IDS` | 保持 allowlist，将你实际授权的 openid 填入；空名单谁都不回复 |
| `QQBOT_WORKSPACE=data/demo/workspace` | 指向刚创建的最小设定目录 |
| `QQBOT_HOME=data/demo/home` | 独立本地 home；启动器可能创建其 `sessions/` 子目录 |
| `QQBOT_STATE_DB` / `QQBOT_LOCK_FILE` / `QQBOT_LOG_FILE` | 分别位于 `data/demo/`；多实例时必须各自隔离 |
| `QQBOT_LEGACY_STATE_FILE=` | 显式空值，不导入旧 JSON 状态 |
| `QQBOT_MOOD_THEME=demo` / `QQBOT_BODY_THEME=demo` | 中性主题标识，两者必须一致；不要换成其他实例的内容 |

全部模板项见 [.env.example](<.env.example>)。它显式关闭情绪调味、数值/经济/养成、定时暖群、自发生活、问候、播报、额外记忆/后台摘要、模型 tools 和网页能力；群聊默认 `mention`，只在被 @ 时处理对话。不要为“先跑通”而把权限改成 `open`。

openid **不是 QQ 号**：单聊通常使用 `user_openid`，群内成员使用 `member_openid`，不同 bot 或场景的 ID 不能混用。请依据你自己的平台事件/本地日志确认授权对象，不需要向项目维护者提供真实 ID 或凭据。`QQBOT_ADMIN_IDS` 是独立的控制指令授权，模板为空，保持不授权即可。

## 3. 仅在自行配置好后连接 QQ

**下面是联网启动命令，不是隔离自测。** 只有你自己完成配置、确认平台权限和授权名单后才运行。没有 QQ 凭据会被配置校验拒绝；没有可用模型 key 也无法完成普通模型对话。模板不是开箱即连接的真实 bot。

Windows / PowerShell：

```powershell
.\bots\demo\run.cmd
```

[run.cmd](<bots/demo/run.cmd>) 是纯 ASCII 包装器：从自身位置定位仓库根，精确选择 `bots/demo/.env`，然后复用 [launch.js](<scripts/launch.js>)；因此可以从任意当前目录通过脚本的完整路径调用，不依赖其他实例默认值。

POSIX shell（在仓库根目录）：

```sh
QQBOT_ENV_FILE=bots/demo/.env node scripts/launch.js
```

PowerShell 的等价直接调用（在仓库根目录）：

```powershell
$env:QQBOT_ENV_FILE = 'bots/demo/.env'
node scripts/launch.js
```

请始终显式设置 `QQBOT_ENV_FILE`；不要依赖未指定时的兼容回退。除启动器特别处理的 home 外，既有进程环境变量通常优先于 `.env`，故不要在带有另一套 QQ/模型配置的 shell 里混用实例。

启动器做 Node/配置文件检查后调用现有入口；日志中的 READY/“机器人已就绪”只证明 QQ 网关身份已就绪，**不等于模型首轮或搬图成功**。自行在授权范围内做一条 @ 或单聊对话，分别观察模型结果和发送结果。按 `Ctrl+C` 停止；本说明不安装自启、守护或计划任务。修改本地设定后重启该进程以确认重新加载。

模板日志在 `data/demo/bridge.log`；状态与锁也在 `data/demo/`。日志可能包含身份标识与用户内容，分享前自行脱敏。不要为了排查而删除运行中的锁、数据库或 WAL/SHM 文件。

## 4. 可选：代码层搬图

搬图默认关闭，**不会在你启动后自动抓图或发图**。启用前请自行确认来源站点、版权、QQ 平台和所在地的内容要求。现有筛选不能代替人工内容审核，也不保证所有结果都适合目标群。

要在自己的授权测试群启用，请只编辑本地 `.env`，并保持对话访问名单：

```dotenv
QQBOT_MEITU=true
QQBOT_MEITU_GROUPS=
QQBOT_MEITU_ROOT=data/demo/images
QQBOT_MEITU_ALIAS=data/demo/meitu-alias.json
QQBOT_MEITU_LINES=data/demo/meitu-lines.json
QQBOT_MEITU_SOURCE=auto
```

- `QQBOT_MEITU_GROUPS` 必须由你本地填写被允许的群 openid；**空值拒绝所有群**，不要把这里的空值误认为“全开”。它不替代 `QQBOT_IDS` 的用户授权。
- `QQBOT_MEITU_ALIAS` 是你自己的名称 → 图源 tag JSON 映射；公开集不提供真实角色别名表。例如可自行写入内联示意 `{"示例主题":"your_source_tag"}`，把占位 tag 换成你确认的实际查询 tag。自定义表缺失时仍可能回退内置值，并不等于“已经配置成功”。
- `QQBOT_MEITU_LINES` 是可选的固定回复覆盖；缺失/无效时使用默认句库。已命中别名的正常请求不调用模型；别名/名称解析未命中时，现有入口可能调用一次 bot 模型帮助理解，因此不能承诺所有搬图请求都零模型费用。检索、下载和发送仍由代码执行，不是模型的文件/网络工具执行链。
- 支持的 `QQBOT_MEITU_SOURCE` 是 `auto`、`danbooru`、`safebooru`；网络/代理策略以你本地实际可达性为准。需要代理时才填写 `QQBOT_MEITU_PROXY`，不在模板提供私有代理地址。
- 默认每次最多 5 张、冷却 30000 毫秒、单张上限 10485760 字节、超时 90000 毫秒；这些是现有模板配置，不是成功率承诺。下载文件放在 `data/demo/images/`，相应元数据属于本地运行数据。

配置后重启；在被授权群里 @ bot 并发送类似 `发1张示例主题美图` 的请求（名称须对应你自己的有效 tag）。缺权限、无结果、内容筛选、代理失败、超时或平台发送失败都可能导致无图，按本地日志区分；不要用公开单测通过代替外部链路实测。

## 配置边界与排查

- **公开节点不支持网页。** 模板保留少量兼容高级键，但 `QQBOT_PANEL=false`、`QQBOT_ACCOUNTS=false`、`QQBOT_GALLERY=false` 必须保持关闭；这里没有网页安装/访问说明，也没有要求补齐被排除的模块。
- **工具不开。** `QQBOT_TOOLS=false`、`QQBOT_TOOLS_MODEL_FN=false`，授权清单为空；最小示例不需要搜索 key 或执行工具。
- **多实例不是复制后直接启动。** 每个实例必须有自己的 QQ 凭据、明确的 env 选择、工作区、home、状态/记忆库、锁、日志、图片与别名路径。此处仅给出单个 demo，不配置现存实例。
- **启动即缺文件/配置报错：** 核对当前目录、显式 env 位置、Node 能力、你创建的本地设定和空凭据；主题或模块不支持时应停止并核对所取提交，不要切换到其他实例的私有默认配置。
- **连上但不回复：** 先确认平台实际投递了事件，再核对 allowlist、openid 作用域和 @ 条件；空名单拒绝回复是预期行为。`QQBOT_SANDBOX` 只是日志标志。
- **模型失败：** 核对你自己的 endpoint、model、key、提供方权限/余额及网络；不要把 key 粘贴给他人。图片理解还取决于所选模型端点能力。

离线公开验证、你本地的真实联网验证、完整私库回归、GitHub CI 与正式发布是不同证据；只报告实际跑过的那一层。

参与 bot/搬图代码协作请先读 [贡献指南](<CONTRIBUTING.md>)；Issue 与 PR 只提交合成复现，不提供真实图库、别名资料或凭据。想先了解代码怎么分层、一条消息怎么走、加图源/内容/适配器该动哪里，看 [公开架构说明](<docs/37-公开架构说明.md>)。
