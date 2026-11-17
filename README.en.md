<p align="right">
  <b>English</b> · <a href="README.md">简体中文</a>
</p>

# Megu-bot

- Megu-bot is a bot project for long-term companionship and easy interaction. It began with a simple frustration: tabletop-style roleplay cannot be played in a lightweight way over the long run, and the ecosystem feels lonely. So it builds its own bot framework: put a character into a custom world, give each character a long-term memory layer and a set of multi-function components, then apply the fan character card you like (this project started with Megumin 😋), so you can interact with the character anytime, anywhere, on the chat platforms you already use 😋
- Characters get a long-term memory system with a good cost/benefit ratio: memory does not weaken as the interaction gets longer, while token usage stays under control (about 5k tokens per bot reply, with ~90% of input served from cache).
- You can connect the official Tencent QQ Open Platform. By design, QQ is only one of the platforms that can be connected: the QQ-specific implementation is about 2.0% of the runtime source (~1.4% of the whole project). The core is fully decoupled from the platform, so other platforms can be added as needed (~the author only uses QQ and WeChat, so it is not a priority~).
- By design, no matter which platform you connect, you always interact with the same character body (memory unchanged, cognition unchanged — the character just needs to know who you are).

The full project architecture is shown below (box area is approximately proportional to runtime source lines):

![Megu-bot overview architecture: bot core, front-end platforms, and external interfaces](<docs/architecture-overview.en.png>)

This project is written in Node.js and has no third-party npm dependencies. Everything downstream consumes only the unified `message` structure.
This repository, [Binfufu/Megu-bot](https://github.com/Binfufu/Megu-bot), is its public v1 version: a public subset selected from the maintenance repository, not the complete private project.

## What it can do, and what it cannot

It can:

- Interact in QQ DMs or group chats (it calls the OpenAI-compatible model endpoint you configure) and send replies to QQ.
- Optionally deliver images (搬图) as a code-level multi-function component: on command, code searches for, downloads, and sends images; the model is never asked to do it. Off by default; see [section 4](#4-optional-code-level-image-delivery).

It cannot do, or does not have by default:

- The public version does not include official character content or assets (you can visit meguming.top to try fan-character interaction).
- The template disables model tools, scheduled and proactive messages, extra memory, and stats/economy/growth by default.
- It provides only one minimal demo instance and no multi-instance deployment guide.

QQ events are received over an outbound WebSocket and messages are sent through the OpenAPI, so no public inbound port, callback service, panel, or reverse proxy is required.

Licensed under [MIT](<LICENSE>). The code license does not grant rights to images, characters, or other third-party content; the terms of the model, QQ service, and image sources still apply. Model calls may cost money; access scope, data retention, and costs are controlled by the deployer. For versions and release notes, see the repository's Releases and [CHANGELOG.md](<CHANGELOG.md>).

## What do I need to deploy locally?

- Local environment: Git, and Node.js **22 or newer**. (Node must provide built-in `fetch`, `WebSocket`, and `node:sqlite`; use a currently supported recent version.)
- Connecting QQ: You need to create a bot yourself on the [QQ Open Platform](https://q.qq.com/), obtain the AppID and ClientSecret, and configure test members, message permissions, and group-chat permissions there. Sandbox permissions follow the platform's actual settings; environment variables will not enable the sandbox for you.
- Connecting an LLM: Normal conversation needs a working OpenAI-compatible model endpoint, model name, and key. The base URL and model in the template are replaceable examples; the key is empty.

Notes:
- You do not need to run `npm install`, and you do not need any other agent CLI.
- For offline self-testing only, you do not need QQ or model credentials.

## Step-by-step: 1. Clone and run the offline self-test

The commands below assume there is no `.env` and no runtime data in the directory yet. Later relative-path commands run from the repository root.

PowerShell:

```powershell
git clone https://github.com/Binfufu/Megu-bot.git
Set-Location Megu-bot
node --version
node --input-type=module -e "import('node:sqlite').then(() => console.log('sqlite available'))"
node scripts/selftest-public.js
```

POSIX shell (Linux / macOS):

```sh
git clone https://github.com/Binfufu/Megu-bot.git
cd Megu-bot
node --version
node --input-type=module -e "import('node:sqlite').then(() => console.log('sqlite available'))"
node scripts/selftest-public.js
```

[selftest-public.js](<scripts/selftest-public.js>) uses inline fixtures, fake network responses, and temporary directories; it does not read your QQ or model credentials and does not start the bot. If the last output line looks like `N passed, 0 failed` and the exit code is 0, the public subset passed in your environment. For what each suite covers and does not cover, see the "Public CI coverage" list in [CONTRIBUTING.md](<CONTRIBUTING.md>).

Passing only proves that the public code can load locally and pass synthetic cases. It does **not** prove that QQ, the model, or image sources are reachable, nor is it the same as a full regression of the private repository.

You can also explicitly select the public subset through the main entry point:

```sh
node scripts/selftest.js --public
```

The corresponding npm script in `package.json` is `npm run selftest:public`. Do not use the parameterless `node scripts/selftest.js` to test the public version: that is the full regression and needs suites that are not public, so it errors when files are missing. Do not fake a pass by deleting files, skipping suites, or editing counters by hand.

## 2. Create the local configuration

The repository does not ship complete character cards or asset packs. The "example assistant" below is a minimal original setup that explains identity and answer boundaries; rewrite it as needed. The persona file is the UTF-8 text `AGENTS.md` in the workspace. It is sent to the model endpoint as a prompt, so never put a model key, QQ secret, or other private data in it.

PowerShell:

```powershell
New-Item -ItemType Directory -Force bots/demo, data/demo/workspace | Out-Null
Copy-Item .env.example bots/demo/.env
@'
# Example assistant
You are a concise, friendly example assistant.
Answer the current user's question first; say when you are unsure, and never claim to have performed actions you did not perform.
Do not claim access to the user's files, accounts, or devices, and never ask for passwords or keys.
'@ | Set-Content -Encoding utf8 data/demo/workspace/AGENTS.md
notepad bots/demo/.env
```

POSIX shell:

```sh
mkdir -p bots/demo data/demo/workspace
cp .env.example bots/demo/.env
cat > data/demo/workspace/AGENTS.md <<'EOF'
# Example assistant
You are a concise, friendly example assistant.
Answer the current user's question first; say when you are unsure, and never claim to have performed actions you did not perform.
Do not claim access to the user's files, accounts, or devices, and never ask for passwords or keys.
EOF
# Open bots/demo/.env in your own text editor.
```

These commands are for first-time creation; do not overwrite existing configuration or persona files. The persona, database, images, and logs you create are local data and live under the Git-ignored `data/` directory by default.

Open `bots/demo/.env` and handle at least the keys in the table below. Every other value in the template can stay as is.

| Key | What to do |
|---|---|
| `QQ_APP_ID` / `QQ_CLIENT_SECRET` | Fill in your own QQ bot credentials; empty in the template |
| `QQBOT_LLM_BASEURL` / `QQBOT_LLM_MODEL` / `QQBOT_LLM_KEY` | Check that they point to your model service; enter the key locally |
| `QQBOT_ACCESS_MODE=allowlist` / `QQBOT_IDS` | Keep `allowlist` and put the openids you authorize into `QQBOT_IDS`. With an empty list, nobody gets a reply |

The template also presets the following, matching the demo directory layout; normally you do not need to change them:

- `QQBOT_WORKSPACE=data/demo/workspace`: points to the persona directory you just created.
- `QQBOT_HOME=data/demo/home`: an independent local home; the launcher may create a `sessions/` subdirectory inside it.
- `QQBOT_STATE_DB`, `QQBOT_LOCK_FILE`, `QQBOT_LOG_FILE`: located in `data/demo/`.
- `QQBOT_LEGACY_STATE_FILE=`: explicitly empty, meaning no import of an old JSON state.
- `QQBOT_MOOD_THEME=demo` and `QQBOT_BODY_THEME=demo`: neutral theme identifiers; the two must match.

**An openid is not a QQ number.** DMs usually use `user_openid`, and group members use `member_openid`; IDs from different bots or scenarios must not be mixed. Confirm the authorized target from your own platform events or local logs. `QQBOT_ADMIN_IDS` is a separate authorization for control commands; it is empty in the template, and you can leave it empty.

See [.env.example](<.env.example>) for all configuration keys. By default the template turns off mood, stats/economy/growth, scheduled group warm-up, spontaneous life, greetings, announcements, extra memory and background summaries, model tools, and web capabilities; group-chat mode is `mention`, so the bot only handles a group message when it is @-mentioned. Do not switch the access mode to `open` just to get things running.

## 3. Connect QQ and confirm it runs

This step goes online. Run it only after you have filled in credentials and confirmed platform permissions and the authorized list. Without QQ credentials, config validation refuses to start; without a working model key, normal conversation cannot complete.

Windows / PowerShell:

```powershell
.\bots\demo\run.cmd
```

[run.cmd](<bots/demo/run.cmd>) locates the repository root from its own position, selects `bots/demo/.env`, and then calls [launch.js](<scripts/launch.js>), so you can invoke it from any current directory using its full path.

POSIX shell (from the repository root):

```sh
QQBOT_ENV_FILE=bots/demo/.env node scripts/launch.js
```

Calling PowerShell directly (from the repository root):

```powershell
$env:QQBOT_ENV_FILE = 'bots/demo/.env'
node scripts/launch.js
```

Always set `QQBOT_ENV_FILE` explicitly. When it is unset, the program falls back in order to the repository-root `.env` and `bots/megumin/.env`, which may read a configuration you did not intend to use. Also, existing process environment variables usually take precedence over `.env` (the launcher handles `QQBOT_HOME` separately), so do not start the bot from a shell that already exports another set of QQ or model settings.

### How to tell it is running

Check two things:

1. **QQ gateway connected.** When "机器人已就绪" (bot ready) appears in the log, the QQ gateway has authenticated and returned the bot identity. This step does not involve the model.
2. **Model conversation works.** With an account that is in `QQBOT_IDS`, DM the bot or @-mention it in a group and send a sentence. If you receive a model-generated reply, the path from receiving the QQ message to requesting the model to sending the reply back to QQ works. If you get no reply, use section 6 to check events, authorization, and the model separately.

Press Ctrl+C to stop the process. This document does not cover auto-start, daemons, or scheduled tasks. After changing local settings, restart the process to reload them.

Logs are in `data/demo/bridge.log`; the state database and lock file are also in `data/demo/`. Logs may contain identity data and user content, so redact them before sharing. When troubleshooting, do not delete the running lock, database, or WAL/SHM files.

## 4. Optional: code-level image delivery

Image delivery (搬图) is off by default: once started, it does not fetch or send images automatically. Before enabling it, confirm the image-source sites, copyright, and the requirements of QQ and your jurisdiction yourself. The built-in filters cannot replace human review and do not guarantee that every result suits the target group.

Edit only your local `.env` and keep `QQBOT_ACCESS_MODE=allowlist`:

```dotenv
QQBOT_MEITU=true
QQBOT_MEITU_GROUPS=
QQBOT_MEITU_ROOT=data/demo/images
QQBOT_MEITU_ALIAS=data/demo/meitu-alias.json
QQBOT_MEITU_LINES=data/demo/meitu-lines.json
QQBOT_MEITU_SOURCE=auto
```

What each key means:

- `QQBOT_MEITU_GROUPS`: group openids allowed to use image delivery, filled in by you locally. **An empty value rejects all groups**; it does not mean "everyone". It is independent of the `QQBOT_IDS` user authorization and cannot replace it.
- `QQBOT_MEITU_ALIAS`: your own JSON mapping from "name → image-source tag". The public version does not provide a real character alias table. For example, write `{"example topic":"your_source_tag"}` and replace the placeholder tag with the actual query tag you have confirmed. If the file is missing or is not valid JSON, the program falls back to the default alias table (empty in the public version) and does not necessarily report an error, so "no error" does not mean "the alias is configured correctly".
- `QQBOT_MEITU_LINES`: optional; overrides the fixed reply sentences. If the file is missing or invalid, the default sentence bank is used.
- `QQBOT_MEITU_SOURCE`: valid values are `auto`, `danbooru`, `safebooru`. Whether it works depends on your local network. If a proxy is required, fill in `QQBOT_MEITU_PROXY`; the template does not provide a proxy address.
- Default limits: at most 5 images per request, 30000 ms cooldown, 10485760 bytes per image, 90000 ms timeout. These are the existing defaults in the template, not a promise of success rate. Downloaded images go to `data/demo/images/`; together with their metadata, they are local runtime data.

**About model cost:** A normal request that hits an alias does not call the model; if alias or name resolution misses, the program may call the bot model once to help interpret it. So you cannot assume every image-delivery request is free of model cost. In either case, retrieval, download, and sending are done by code, not by the model's file or network tools.

After configuring, restart the process, then @-mention the bot in an authorized group and send a request like `发1张示例主题美图` (the name must correspond to a valid tag of your own). No image may mean missing permission, no results, blocked by content filters, proxy failure, timeout, or platform sending failure; check the local log to tell them apart. Passing the public self-test does not replace a real test of this external path.

## 5. Optional: JM book search/download (requires a self-hosted JM sidecar)

This feature is off by default. The actual JM search/download is performed by the **local JM sidecar service** that you run yourself; the Node side only calls it over an HTTP contract. The repo includes an optional sidecar implementation under `tools/jm-sidecar/` (Python; you install its dependencies and clone two upstream MIT projects yourself — see the [JM search doc](<docs/45-JM搜本.md>)); you can also use another implementation that follows the same contract. Without a deployed sidecar, turning the switch on only produces the fixed reply "JM service is not started"; it does not go online or send anything out.

Pure digits are resolved **exactly by number** (work or unit), not through the site's keyword search; when a work has several unit books, the bot first replies with the unit list so the user can choose, then downloads/sends only that unit's PDF. Search no longer sends a collage or cover. Structured search is also available: `搜本 作者:xxx`, `搜本 原作:xxx`/`IP:xxx`, `搜本 角色:xxx`, `搜本 标签:xxx`, and `搜本 标题:xxx` (combinable; `页码:2` for paging). It picks one upstream mode for the current page, fetches text details only, verifies the remaining conditions with AND, and returns only a "within this checked range" list without auto-download. Fuzzy forms such as `搜原神的本子` and `来个莉音的本` also enter the book search path; they require a request verb plus a trailing `本子`/`本` and use compound-word guards so ordinary chat containing 本来/日本/成本/笔记本 is not captured.

The same parent feature includes a **local catalog** sub-feature: `收藏 <条目ID>`, `取消收藏 <条目ID>`, and `收藏夹 [page]` / `收藏夹 作者:xxx`. Favoriting stores item-level metadata in a separate SQLite DB and **does not download or send images**; unfavoriting does not delete files. When `QQBOT_JM` is off the whole entry point is inactive, and group authorization still follows `QQBOT_JM_GROUPS` (empty = deny all).

Edit only your local `.env` and keep `QQBOT_ACCESS_MODE=allowlist`:

```dotenv
QQBOT_JM=true
QQBOT_JM_GROUPS=
QQBOT_JM_API=http://127.0.0.1:8790
QQBOT_JM_MAX=5
QQBOT_JM_COOLDOWN_MS=30000
QQBOT_JM_ROOT=data/demo/jm-images
QQBOT_JM_MAX_BYTES=10485760
QQBOT_JM_TIMEOUT_MS=120000
QQBOT_CATALOG_DB=data/demo/catalog.db
QQBOT_CATALOG_PAGE_SIZE=8
```

- `QQBOT_JM_GROUPS`: group openids allowed to use this feature, filled in by you. **An empty value rejects all groups**, not "all allowed"; it is independent of `QQBOT_IDS`.
- `QQBOT_JM_API`: sidecar address. The template defaults to `http://127.0.0.1:8790`; change it here if your sidecar listens on another port (this repo does not hard-code a port).
- `QQBOT_JM_COOLDOWN_MS` only limits **book search**; downloads do not consume the cooldown (otherwise a search followed immediately by a download would be blocked by itself), and failures do not consume it either.
- `QQBOT_CATALOG_DB` is the separate SQLite file for favorites (default `data/catalog.db`); do not share it with chat/memory DBs. `QQBOT_CATALOG_PAGE_SIZE` is the favorites page size (template 8, tentative).
- The rest are count limits, timeouts, and a legacy image limit kept for compatibility; all are template defaults, not a promise of success rate.

After configuring, restart the process, then @-mention the bot in an authorized group and send `搜本 示例关键词` or `下本 示例编号`. If there is no response, first check: is the group in `QQBOT_JM_GROUPS`; is the sidecar running (you can self-check with `node scripts/jm-fetch-one.mjs --op health --api http://127.0.0.1:8790`). **The terms of use of JM/image sources, and platform or regional content requirements, are the deployer's responsibility**; this repo ships no JM content, images, or credentials.

## 6. Where to look when something goes wrong

- **Missing files or config errors at startup:** Check the current directory, the location `QQBOT_ENV_FILE` points to, the Node version and capabilities, the persona file you created, and whether credentials are empty. If it reports an unsupported theme or module, stop and check the commit you are using; do not switch to another instance's private default configuration.
- **Connected but not replying:** First confirm that the QQ platform is actually delivering events to the bot, then check `allowlist`, the openid scope, and whether the bot was @-mentioned in the group. Not replying when the list is empty is expected behavior. `QQBOT_SANDBOX` only changes the log tag; it does not decide platform permissions.
- **Model call failures:** Check your endpoint, model, key, provider permissions and balance, and the network. Whether image understanding is available also depends on the chosen model endpoint. Do not send your key to anyone.
- **Turned on web or tool switches:** The public version does not support the web. `QQBOT_PANEL`, `QQBOT_ACCOUNTS`, and `QQBOT_GALLERY` must stay `false`. For example, if `QQBOT_PANEL` is on while the web module is missing, startup reports an explicit error; turn the switch off instead of copying files from a private deployment. Keep `QQBOT_TOOLS` and `QQBOT_TOOLS_MODEL_FN` `false` and leave the authorization list empty; the minimal example needs no search key.
- **Want to run multiple instances at once:** You cannot just copy and start. Each instance needs its own QQ credentials, `QQBOT_ENV_FILE`, workspace, home, state database, memory database, lock, logs, images, and alias paths. This document only covers a single demo.

Do not paste credentials, real openids, DM content, or unredacted logs into issues or PRs.

## 7. Deep customization and contributing

> The linked documents are currently written in Chinese.

- Want to understand the code layering, the path a message takes, and where to change things to add an image source, content, or a platform adapter: [public architecture notes](<docs/37-公开架构说明.md>).
- To configure your own character presentation content for the bot (mood, copy, style phrases): [content pack format](<docs/39-内容包格式.md>). The public version ships no official content pack and has no install/upgrade/uninstall flow.
- World-level shared content (places, world copy, chronicle, common command copy, group warm-up and image-delivery lines) is provided via world packs: [world pack format](<docs/42-世界包格式.md>). The public version ships only one neutral example world, `content/worlds/example/`.
- Where configuration values come from, optional parameter files, the boundaries of content-pack parameters, and behavior on validation failure: [parameter system](<docs/41-参数系统.md>).
- To enable the optional JM book search/download (you need to deploy a local JM sidecar yourself; off by default): [JM search](<docs/45-JM搜本.md>).
- What the project has delivered, what it explicitly does not do, and unscheduled future directions: [public roadmap](<docs/43-公开路线图.md>).
- Before opening an issue or PR, read the [contributing guide](<CONTRIBUTING.md>). Issues and PRs should contain only synthetic reproductions; do not provide real galleries, alias data, or credentials.

Verification has different levels: the public self-test, your local real-network verification, the private repository's full regression, GitHub CI, and official releases. When reporting results, state only the level you actually ran.
