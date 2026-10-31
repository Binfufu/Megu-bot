# Megu-bot介绍

- Megu-bot 是面向长期陪伴/轻松互动的机器人项目，设计灵感源于酒馆rp不能长期轻量化游玩/生态孤独，故自制bot框架，将角色放入自定义世界观中，为每个角色搭配长期记忆层系统与多功能组件，再套喜欢的同人角色卡（始于惠惠😋），让用户能够随时随地在常用的聊天平台与角色互动😋
- 角色拥有高性价比的长期记忆系统，在记忆不随互动时长减弱的同时兼顾了token消耗（bot单轮回复消耗约 5k token，约 90% 输入命中缓存。）
- 用户可接入腾讯官方 QQ 开放平台，设计上 QQ 只是可接入平台之一，QQ 专用实现仅占运行源码约 2.0%（全项目代码约 1.4%），核心与平台完全解耦，可按需求接入其他平台（ ~作者只常用qq微信所以懒得做~ ）。
- 设计上无论接入任何平台都默认与同一个角色本体互动（记忆不变，认知不变，只需要让角色知道你是谁）

完整项目架构图如下（方框面积约为运行源码量）：

![Megu-bot 总览架构：Bot 核心、前端平台与外部接口](<docs/architecture-overview.png>)

此项目用 Node.js 编写，没有第三方 npm 依赖。下游逻辑只消费统一的 `message` 结构。
本仓库 [Binfufu/Megu-bot](https://github.com/Binfufu/Megu-bot) 是它的公开 v1 版本，由维护仓库筛选出的公开部分组成，不是完整的私有项目。

## 能做什么，不能做什么

能做：

- 在 QQ 私聊或群聊中互动，（直接请求你配置的 OpenAI 兼容模型端点）将回复发至 QQ。
- 可选的多功能组件-搬图：按指令由代码检索、下载并发送图片，不交给模型执行。默认关闭，见[第 4 节](#4-可选代码层搬图)。

不能做，或默认没有：

- 公开版不含官方角色内容和素材（可访问meguming.top体验同人角色互动）。
- 模板默认关闭模型工具（tools）、定时与主动消息、额外记忆、数值/经济/养成。
- 只提供一个最小的 demo 实例，不提供多实例部署方案。

QQ 事件通过出站 WebSocket 接收，消息通过 OpenAPI 发送，不需要公网入站端口、回调服务、面板或反向代理。

许可为 [MIT](<LICENSE>)。代码许可不授予图片、角色或其他第三方内容的使用权；模型、QQ 服务和图片来源各自的条款仍须遵守。模型调用可能产生费用，访问范围、数据保存与费用由部署者自行控制。版本与发布说明见仓库的 Releases 和 [CHANGELOG.md](<CHANGELOG.md>)。

## 我想要本地部署，需要准备什么？

- 本地环境：Git，以及 Node.js **22 或更高版本**。（Node 必须提供内置的 `fetch`、`WebSocket` 和 `node:sqlite`，建议使用仍受支持的较新版本。）
- 连接QQ： 需要你在 [QQ 开放平台](https://q.qq.com/)自行创建 bot，取得 AppID 和 ClientSecret，并在平台上配置测试成员、消息权限和群聊权限。沙箱权限以平台实际设置为准，环境变量不会替你开启沙箱。
- 接入LLM：普通对话需要一个可用的 OpenAI 兼容模型端点、模型名和 key。模板里的 base URL 和 model 是可替换的示例，key 为空。

注：
- 不需要执行 `npm install`，也不需要安装其他 agent CLI。
- 只做离线自测时，不需要 QQ 或模型凭据。

## 具体操作步骤：1. 克隆并离线自测

下面的命令假设目录里还没有 `.env` 和运行数据。之后的相对路径命令都在仓库根目录运行。

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

[selftest-public.js](<scripts/selftest-public.js>) 使用内联 fixture、假网络响应和临时目录，不读取你的 QQ 或模型凭据，也不启动 bot。输出末行形如 `N passed, 0 failed` 且退出码为 0，就说明公开子集在你的环境里通过。各套件覆盖什么、不覆盖什么，见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「公开 CI 覆盖清单」。

通过只说明公开代码能在本机加载并通过合成用例，**不说明 QQ、模型或图片来源已经连通**，也不等于私有仓库的完整回归。

也可以通过总入口显式选择公开子集：

```sh
node scripts/selftest.js --public
```

`package.json` 里对应的 npm 脚本是 `npm run selftest:public`。不要用无参数的 `node scripts/selftest.js` 来测公开版：它属于完整回归，需要未公开的套件，缺件时会报错。不要通过缺文件、跳过套件或手动改计数来制造通过。

## 2. 创建本地配置

仓库不分发完整的角色卡或素材包。下面的「示例助手」只是一份原创的最小设定，用来说明身份和回答边界，你可以按需要改写。设定文件是工作区里的 UTF-8 文本 `AGENTS.md`，它会作为提示词发给模型端点，所以不要在里面写模型 key、QQ secret 或其他隐私。

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

这些命令用于首次创建；已有配置或设定时不要直接覆盖。你创建的设定、数据库、图片和日志都是本地数据，默认放在被 Git 忽略的 `data/` 下。

打开 `bots/demo/.env`，至少处理下表中的键。模板里其余各项的默认值都可以不动。

| 键 | 要做什么 |
|---|---|
| `QQ_APP_ID` / `QQ_CLIENT_SECRET` | 填你自己的 QQ bot 凭据，模板中为空 |
| `QQBOT_LLM_BASEURL` / `QQBOT_LLM_MODEL` / `QQBOT_LLM_KEY` | 核对为你的模型服务，key 在本地填写 |
| `QQBOT_ACCESS_MODE=allowlist` / `QQBOT_IDS` | 保持 `allowlist`，把你授权的 openid 填进 `QQBOT_IDS`。名单为空时，谁都不会得到回复 |

模板还预设了以下几项，对应 demo 的目录布局，一般不用改：

- `QQBOT_WORKSPACE=data/demo/workspace`：指向刚创建的设定目录。
- `QQBOT_HOME=data/demo/home`：独立的本地 home，启动器可能在其中创建 `sessions/` 子目录。
- `QQBOT_STATE_DB`、`QQBOT_LOCK_FILE`、`QQBOT_LOG_FILE`：分别位于 `data/demo/`。
- `QQBOT_LEGACY_STATE_FILE=`：显式留空，表示不导入旧的 JSON 状态。
- `QQBOT_MOOD_THEME=demo` 和 `QQBOT_BODY_THEME=demo`：中性主题标识，两者必须一致。

**openid 不是 QQ 号。** 单聊通常使用 `user_openid`，群内成员使用 `member_openid`，不同 bot 或场景的 ID 不能混用。请根据你自己的平台事件或本地日志确认授权对象。`QQBOT_ADMIN_IDS` 是独立的控制指令授权，模板为空，保持为空即可。

全部配置项见 [.env.example](<.env.example>)。模板默认关闭情绪、数值/经济/养成、定时暖群、自发生活、问候、播报、额外记忆与后台摘要、模型 tools 和网页能力；群聊模式为 `mention`，只在被 @ 时处理对话。不要为了先跑通而把访问模式改成 `open`。

## 3. 连接 QQ 并确认运行成功

这一步会联网。只有在你填好凭据、确认平台权限和授权名单之后再运行。没有 QQ 凭据，配置校验会拒绝启动；没有可用的模型 key，普通对话无法完成。

Windows / PowerShell：

```powershell
.\bots\demo\run.cmd
```

[run.cmd](<bots/demo/run.cmd>) 从自身位置定位仓库根，选定 `bots/demo/.env`，再调用 [launch.js](<scripts/launch.js>)，所以可以从任意当前目录用完整路径调用。

POSIX shell（在仓库根目录）：

```sh
QQBOT_ENV_FILE=bots/demo/.env node scripts/launch.js
```

PowerShell 直接调用（在仓库根目录）：

```powershell
$env:QQBOT_ENV_FILE = 'bots/demo/.env'
node scripts/launch.js
```

请始终显式设置 `QQBOT_ENV_FILE`。未设置时，程序会依次回退到仓库根的 `.env` 和 `bots/megumin/.env`，可能读到不是你想用的那份。另外，已存在的进程环境变量通常优先于 `.env`（启动器单独处理 `QQBOT_HOME`），所以不要在已经设置了另一套 QQ 或模型配置的 shell 里启动。

### 怎样判断运行成功

分两步看：

1. **QQ 网关连通。** 日志里出现「机器人已就绪」，说明 QQ 网关已认证并返回了机器人身份。这一步不涉及模型。
2. **模型对话可用。** 用一个已在 `QQBOT_IDS` 中的账号，单聊机器人，或在群里 @ 它，发一句话。收到由模型生成的回复，说明从 QQ 收消息、请求模型到发回 QQ 的链路通了。收不到回复时，按下面第 5 节分别查事件、授权和模型。

按 `Ctrl+C` 停止进程。本文不涉及自启、守护进程或计划任务。修改本地设定后，需要重启进程才会重新加载。

日志在 `data/demo/bridge.log`，状态库和锁文件也在 `data/demo/`。日志可能包含身份标识和用户内容，分享前请先脱敏。排查时不要删除运行中的锁、数据库或 WAL/SHM 文件。

## 4. 可选：代码层搬图

搬图默认关闭，启动后不会自动抓图或发图。启用前，请自行确认图片来源站点、版权，以及 QQ 平台和所在地对内容的要求。内置筛选不能代替人工审核，也不保证所有结果都适合目标群。

只编辑本地 `.env`，并保持 `QQBOT_ACCESS_MODE=allowlist`：

```dotenv
QQBOT_MEITU=true
QQBOT_MEITU_GROUPS=
QQBOT_MEITU_ROOT=data/demo/images
QQBOT_MEITU_ALIAS=data/demo/meitu-alias.json
QQBOT_MEITU_LINES=data/demo/meitu-lines.json
QQBOT_MEITU_SOURCE=auto
```

各项含义：

- `QQBOT_MEITU_GROUPS`：允许使用搬图的群 openid，由你在本地填写。**空值表示拒绝所有群**，不是全开。它与 `QQBOT_IDS` 的用户授权相互独立，不能替代。
- `QQBOT_MEITU_ALIAS`：你自己的「名称 → 图源 tag」JSON 映射。公开版不提供真实角色别名表。例如写入 `{"示例主题":"your_source_tag"}`，并把占位 tag 换成你确认过的实际查询 tag。文件缺失或不是合法 JSON 时，程序会回退到默认别名表（公开版的默认表为空），并不一定报错，所以「没有报错」不等于「别名已配置成功」。
- `QQBOT_MEITU_LINES`：可选，用于覆盖固定回复句子。文件缺失或无效时使用默认句库。
- `QQBOT_MEITU_SOURCE`：可选值为 `auto`、`danbooru`、`safebooru`。能否访问以你本地的网络环境为准。需要代理时才填写 `QQBOT_MEITU_PROXY`，模板不提供代理地址。
- 默认限制：每次最多 5 张，冷却 30000 毫秒，单张上限 10485760 字节，超时 90000 毫秒。这些是模板里的现有默认值，不是成功率承诺。下载的图片放在 `data/demo/images/`，连同元数据都属于本地运行数据。

**关于模型费用：** 别名命中的正常请求不调用模型；别名或名称解析未命中时，程序可能调用一次 bot 模型帮助理解。因此不能认为所有搬图请求都没有模型费用。无论哪种情况，检索、下载和发送都由代码完成，不经过模型的文件或网络工具。

配置后重启进程，在已授权的群里 @ 机器人，发送类似 `发1张示例主题美图` 的请求（名称要对应你自己的有效 tag）。没有出图可能是缺权限、无结果、被内容筛选拦下、代理失败、超时或平台发送失败，请对照本地日志区分。公开自测通过不能代替这条外部链路的实测。

## 5. 出问题时去哪查

- **启动时报缺文件或配置错误：** 核对当前目录、`QQBOT_ENV_FILE` 指向的位置、Node 版本和能力、你创建的设定文件，以及凭据是否为空。如果报告主题或模块不受支持，应当停下来核对所用的提交，不要切换到别的实例的私有默认配置。
- **已连上但不回复：** 先确认 QQ 平台确实把事件投递给了机器人，再核对 `allowlist`、openid 的作用域，以及群里是否 @ 了机器人。名单为空时不回复是预期行为。`QQBOT_SANDBOX` 只改日志标签，不决定平台权限。
- **模型调用失败：** 核对你的 endpoint、model、key、服务商权限和余额，以及网络。图片理解是否可用还取决于所选模型端点。不要把 key 发给别人。
- **打开了网页或工具相关开关：** 公开版不支持网页。`QQBOT_PANEL`、`QQBOT_ACCOUNTS`、`QQBOT_GALLERY` 必须保持 `false`。例如打开 `QQBOT_PANEL` 而网页模块缺失时，启动会明确报错；此时应关闭开关，不要从私有部署补文件。`QQBOT_TOOLS` 和 `QQBOT_TOOLS_MODEL_FN` 也保持 `false`，授权清单留空，最小示例不需要搜索 key。
- **想同时运行多个实例：** 不能复制后直接启动。每个实例需要自己的 QQ 凭据、`QQBOT_ENV_FILE`、工作区、home、状态库、记忆库、锁、日志、图片和别名路径。本文只给出单个 demo。

请不要把凭据、真实 openid、私聊内容或未脱敏的日志贴到 issue 或 PR 里。

## 6. 深入定制与参与贡献

- 想了解代码分层、一条消息的处理路径，以及加图源、加内容、加平台适配器该改哪里：[公开架构说明](<docs/37-公开架构说明.md>)。
- 为 bot 配置自己的角色展示内容（情绪、文案、风格短句）：[内容包格式](<docs/39-内容包格式.md>)。公开版不附带官方内容包，也没有安装、升级、卸载流程。
- 世界级共享内容（场所、世界文案、编年史、通用命令文案、暖群和搬图话术等）用世界包提供：[世界包格式](<docs/42-世界包格式.md>)。公开版只带一个中性的示例世界 `content/worlds/example/`。
- 配置值从哪一层来、可选的参数文件、内容包参数的边界，以及校验失败时的行为：[参数系统](<docs/41-参数系统.md>)。
- 项目已经交付什么、明确不做什么、有哪些未排期的后续方向：[公开路线图](<docs/43-公开路线图.md>)。
- 提交 issue 或 PR 前，请先读 [贡献指南](<CONTRIBUTING.md>)。issue 和 PR 里只放人工合成的复现，不提供真实图库、别名资料或凭据。

验证有不同层次：公开自测、你本地的真实联网验证、私有仓库的完整回归、GitHub CI、正式发布。汇报结果时，只写实际运行过的那一层。
