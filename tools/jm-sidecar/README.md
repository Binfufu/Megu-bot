# jm-sidecar（JM 边车服务，可选）

本目录是 JM 搜本/下本功能的**可选手边车**：一个本机 HTTP 服务，负责访问 JM、搜索、下载、
生成拼图与 PDF，并可拉起 jm-view-server 做网页阅读。**本仓库的 Node 客户端
（`src/jm-command.js` / `src/jm-service.js` / `scripts/jm-fetch-one.mjs`）通过
[docs/45-JM搜本.md](../../docs/45-JM搜本.md) 的 API v1 契约调用它。**

- 默认监听 `127.0.0.1:8790`；网页阅读默认 `0.0.0.0:8088`（均可配）。
- 只在本机跑，不随 bot 进程启动；未部署它时 bot 的 JM 功能保持关闭/失败兜底。
- 依赖：Python 3.11+；上游两个 MIT 项目
  [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 与
  [jm-view-server](https://github.com/hect0x7/jm-view-server)（**不随本仓库分发**，需自行克隆）。
- 本目录不附带任何 JM 内容、图片、凭据或运行数据；`config/`、`data/`、`logs/`、`vendor/`、`.venv/`
  均被 `.gitignore` 忽略。

## 1. 安装（Windows 与 Linux 通用）

```bash
cd tools/jm-sidecar

# 1) 上游依赖（放在本目录 vendor/ 下，已被 .gitignore 忽略）
git clone https://github.com/hect0x7/JMComic-Crawler-Python vendor/JMComic-Crawler-Python
git clone https://github.com/hect0x7/jm-view-server      vendor/jm-view-server

# 2) 虚拟环境与依赖
python -m venv .venv
.venv/bin/pip install -r requirements.txt          # Windows: .venv\Scripts\pip install -r requirements.txt

# 3) 配置（可选；不建则用内置默认值）
mkdir -p config
cp config.example.json config/jm-service.json
```

## 2. 启动

Linux / macOS：

```bash
cd tools/jm-sidecar
export PYTHONPATH="$PWD:$PWD/vendor/JMComic-Crawler-Python/src:$PWD/vendor/jm-view-server/src"
export PYTHONIOENCODING=utf-8
.venv/bin/python -m jm_service
```

Windows PowerShell：

```powershell
cd tools\jm-sidecar
$env:PYTHONPATH = "$PWD;$PWD\vendor\JMComic-Crawler-Python\src;$PWD\vendor\jm-view-server\src"
$env:PYTHONIOENCODING = "utf-8"
.venv\Scripts\python -m jm_service
# 或者用随附脚本：.\run.ps1
```

验证：

```bash
curl http://127.0.0.1:8790/health
# {"ok":true,"service":"jm-service","version":"1.0.0","viewer_base":"http://<lan-ip>:8088", ...}
```

停止：前台 Ctrl+C；systemd 见下。

## 3. Linux systemd 示例

`jm-sidecar.service.example`（把 `/opt/jm-sidecar` 换成实际目录、`User=` 换成实际用户）：

```bash
sudo cp jm-sidecar.service.example /etc/systemd/system/jm-sidecar.service
sudo systemctl daemon-reload
sudo systemctl enable --now jm-sidecar
```

## 4. 配置项（`config/jm-service.json`，缺省即内置默认）

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "viewer": {"enabled": true, "host": "0.0.0.0", "port": 8088,
             "auto_spawn": true, "public_base": "", "password": ""},
  "cache": {"search_ttl_sec": 21600, "detail_ttl_sec": 86400},
  "jm": {"proxy": "", "domain": "", "threads": 16, "timeout_sec": 30},
  "pdf": {"width": 1000, "quality": 80, "max_pages": 300, "max_bytes": 20971520},
  "paths": {"data_dir": "data"}
}
```

- `viewer.public_base`：给用户点的网页阅读链接前缀；留空自动探测局域网 IP（手机需同一网络）。
- `jm.proxy`：`""` 直连；支持 `system` 或 `host:port`（由 jmcomic 读取）。
- `pdf.*`：整本 PDF 目标宽度/质量/页数上限/大小上限；超限会自动降级压缩。
- 数据目录：`data/comics/`（漫画）、`data/pdfs/`（PDF）、`data/covers|previews/`（封面/拼图）、
  `data/cache/`（SQLite 缓存）、`logs/`（日志）。全部留在本机，不进 Git。

## 5. API v1（本服务对外）

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | 健康检查、viewer base、库/缓存计数 |
| `GET /search?q=&limit=&page=&mode=&refresh=` | 搜索（`mode=site/work/author/tag/actor`）+ 拼图；`limit` 1~10 |
| `GET /cover/<id>.jpg` | 封面 |
| `GET /preview/<name>.jpg` | 搜索结果拼图 |
| `GET /album/<id>` | 详情 + 本地状态（`downloaded`、`viewer_url`、`pdf_ready`、`pdf_size`） |
| `POST /download` `{"id":"..."}` | 入队下载（单 worker 串行）；已下载 `status=done` |
| `GET /jobs/<job_id>` | 任务状态 `running/done/failed` + `pdf_ready/pdf_size` |
| `GET /pdf/<id>` | 整本 PDF（`application/pdf`）；未下载 404 `album_not_downloaded`；`?refresh=1` 重生成 |
| `GET /library` | 本地漫画库 |

字段级契约见 [docs/45-JM搜本.md](../../docs/45-JM搜本.md) 第 2 节。

## 6. 测试

- `tests/selftest.py`：离线合成测试（不联网，不需要 JM 凭据）：
  ```bash
  PYTHONPATH="$PWD:$PWD/vendor/JMComic-Crawler-Python/src:$PWD/vendor/jm-view-server/src" \
    .venv/bin/python tests/selftest.py
  ```
- `tests/smoke_live.py`：**联网**烟测（真实搜索/下载/PDF；会下载少量内容到本机，仅部署者本地运行）。

## 7. 注意

- 本目录只被 bot 通过 HTTP 调用；bot 的 `.env` 里用 `QQBOT_JM_API=http://127.0.0.1:8790` 指向它。
- JM/图片来源、平台条款与地区要求由部署者自行确认并承担；成人内容仅限本人/授权群使用。
- 服务失败一律返回 JSON 错误（`ok:false` + 错误码），bot 侧按固定话术兜底，不会静默失败。
