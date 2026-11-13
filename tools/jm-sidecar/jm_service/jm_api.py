"""jmcomic 网络封装：站内搜索 / 专辑详情 / 封面下载 / 整本下载。

- 所有网络调用都有超时兜底（future.result(timeout)）；超时/异常统一转成 JmError。
- 客户端按线程惰性创建并复用（jmcomic 首次创建会拉 API 域名与 cookies，之后很快）。
- 下载走 jmcomic 官方 downloader：先落 staging，再由调用方 finalize。
"""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from pathlib import Path

from .util import jm_album_url


# /search?mode=xxx → jmcomic 站内搜索方法映射（顺序即前端可传值）
SEARCH_MODES = {
    "site": "search_site",
    "work": "search_work",
    "author": "search_author",
    "tag": "search_tag",
    "actor": "search_actor",
}


class JmError(RuntimeError):
    """业务层可识别的 JM 错误：code 机器可读，message 中文一句话。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class JmGateway:
    def __init__(self, config, logger):
        self.cfg = config
        self.log = logger
        self._local = threading.local()
        self._option = None
        self._option_lock = threading.Lock()
        self._module = None
        self._module_lock = threading.Lock()
        self._domain = ""
        self._search_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="jm-search")
        self._detail_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="jm-detail")
        self._cover_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="jm-cover")
        self._download_lock = threading.Lock()  # 下载由单 worker 调用，这里只防御并发调用

    # ------------------------------------------------------------------ #
    # 初始化
    # ------------------------------------------------------------------ #
    def _prepare_module(self):
        if self._module is not None:
            return self._module
        with self._module_lock:
            if self._module is not None:
                return self._module
            try:
                import jmcomic
                from jmcomic import JmModuleConfig, JmcomicText
            except ImportError as exc:  # pragma: no cover - 部署错误
                raise JmError(
                    "jmcomic_missing",
                    f"未找到 jmcomic，请检查 PYTHONPATH 是否包含 JMComic-Crawler-Python/src（{exc}）",
                ) from exc

            # 默认直连；配置了代理才走代理
            self._proxy_dict: dict[str, str] = {}
            if self.cfg.jm_proxy:
                proxy = self.cfg.jm_proxy
                if "://" not in proxy:
                    proxy = "http://" + proxy
                self._proxy_dict = {"http": proxy, "https": proxy}
            JmModuleConfig.DEFAULT_PROXIES = dict(self._proxy_dict)

            # 强制指定 API 域名（可选）
            domains = self.cfg.jm_client_list()
            if domains:
                JmModuleConfig.DOMAIN_API_LIST = list(domains)
                JmModuleConfig.FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = False
                self._domain = domains[0]

            self._module = jmcomic
            self._JmModuleConfig = JmModuleConfig
            self._JmcomicText = JmcomicText
            self.log.info("jmcomic 模块就绪：proxies=%s domain=%s",
                          self._proxy_dict or "direct", domains or "auto")
        return self._module

    def _get_option(self):
        if self._option is None:
            with self._option_lock:
                if self._option is None:
                    self._prepare_module()
                    option_class = self._JmModuleConfig.option_class()
                    self._option = option_class.default()
        return self._option

    def _get_client(self):
        """每个线程一个 client（首次创建会拉域名/cookies，之后复用）。"""
        client = getattr(self._local, "client", None)
        if client is None:
            self._prepare_module()
            client = self._get_option().new_jm_client()
            self._local.client = client
            domain_list = client.get_domain_list() or []
            if domain_list:
                self._domain = str(domain_list[0])
        return client

    def warmup(self) -> None:
        """后台预热：提前完成域名/cookies 拉取，避免首个 /search 承担冷启动代价。"""

        def _warm():
            try:
                start = time.time()
                self._get_client()
                self.log.info("JM 客户端预热完成：domain=%s, %.2fs", self._domain, time.time() - start)
            except Exception as exc:  # noqa: BLE001 - 预热失败不阻塞服务
                self.log.warning("JM 客户端预热失败（稍后请求时重试）：%s", self._short(exc))

        threading.Thread(target=_warm, name="jm-warmup", daemon=True).start()

    # ------------------------------------------------------------------ #
    # 工具
    # ------------------------------------------------------------------ #
    @staticmethod
    def _short(exc: BaseException, limit: int = 180) -> str:
        text = f"{type(exc).__name__}: {exc}"
        return text if len(text) <= limit else text[:limit] + "..."

    def _submit(self, pool: ThreadPoolExecutor, fn, *args) -> Future:
        return pool.submit(fn, *args)

    def _wait_one(self, future: Future, timeout: float, code: str, message: str):
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            future.cancel()
            raise JmError(code, message) from None
        except JmError:
            raise
        except Exception as exc:  # noqa: BLE001 - 统一转业务错误
            raise JmError(code, f"{message}（{self._short(exc)}）") from None

    @property
    def jm_domain(self) -> str:
        if self._domain:
            return self._domain
        try:
            self._prepare_module()
            domains = list(self._JmModuleConfig.DOMAIN_API_LIST or [])
            return str(domains[0]) if domains else ""
        except Exception:  # noqa: BLE001
            return ""

    # ------------------------------------------------------------------ #
    # 搜索
    # ------------------------------------------------------------------ #
    def search(self, query: str, page: int = 1, mode: str = "site") -> dict:
        """站内搜索，返回 {total, items:[{id,title,tags,author,image}]}。

        mode: site(默认)/work/author/tag/actor，分别对应 jmcomic 的 search_*。
        """
        if mode not in SEARCH_MODES:
            raise JmError("invalid_mode", f"mode 仅支持 {'/'.join(SEARCH_MODES)}")
        timeout = max(5.0, float(self.cfg.jm_timeout_sec))
        future = self._submit(self._search_pool, self._do_search, query, page, mode)
        page_obj = self._wait_one(future, timeout, "jm_search_timeout", "JM 搜索超时，请稍后重试")
        items = []
        for aid, info in getattr(page_obj, "content", []) or []:
            info = info or {}
            items.append({
                "id": str(aid),
                "title": str(info.get("name") or "").strip(),
                "tags": [str(t) for t in (info.get("tags") or [])][:12],
                "author": str(info.get("author") or "").strip(),
                "image": str(info.get("image") or "").strip(),
            })
        return {"total": int(getattr(page_obj, "total", 0) or 0), "items": items}

    def _do_search(self, query: str, page: int, mode: str = "site"):
        try:
            method = getattr(self._get_client(), SEARCH_MODES.get(mode, "search_site"))
            return method(query, page=int(page))
        except JmError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise JmError("jm_search_failed", f"JM 搜索失败（{self._short(exc)}）") from None

    # ------------------------------------------------------------------ #
    # 详情
    # ------------------------------------------------------------------ #
    @staticmethod
    def _chapter_field(chapter, *names):
        """防御式取章节字段：真实 JmPhotoDetail 与测试里的假对象都能吃。

        依次尝试 names 里的属性名；取到非空标量就返回。属性可能是会抛异常的
        property，这里全部吞掉（拿不到就试下一个）。
        """
        for name in names:
            try:
                value = getattr(chapter, name)
            except Exception:  # noqa: BLE001 - 属性实现不定，防御式取
                continue
            if value is None or callable(value):
                continue
            if isinstance(value, (str, int)):
                text = str(value).strip()
                if text:
                    return text
                continue
            return value
        return None

    @staticmethod
    def _as_id(value) -> str | None:
        """把编号值规约成纯数字字符串；规约不了返回 None。"""
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, int):
            return str(value)
        text = str(value).strip()
        return text if text.isdigit() else None

    def _build_units(self, album) -> list[dict]:
        """迭代本子得到单元/章节清单：index 从 1 起，unit_id 为章节 id。"""
        units: list[dict] = []
        try:
            iterator = iter(album)
        except TypeError:
            return units
        for position, chapter in enumerate(iterator, start=1):
            if chapter is None:
                continue
            unit_id = self._as_id(
                self._chapter_field(chapter, "photo_id", "id", "unit_id", "photoId"))
            if not unit_id:
                continue
            title = self._chapter_field(chapter, "name", "title", "photo_name") or ""
            index = position
            raw_index = self._chapter_field(chapter, "index", "sort", "order")
            try:
                if raw_index is not None:
                    index = int(str(raw_index))
            except (TypeError, ValueError):
                index = position
            page_count = None
            raw_pages = self._chapter_field(chapter, "page_count", "page_num", "image_count")
            try:
                if raw_pages is not None:
                    page_count = int(str(raw_pages))
            except (TypeError, ValueError):
                page_count = None
            units.append({
                "index": index,
                "unit_id": unit_id,
                "title": str(title).strip(),
                "page_count": page_count,
            })
        return units

    def _build_album(self, album) -> dict:
        authors = [str(a) for a in (getattr(album, "authors", None) or [])]
        tags = [str(t) for t in (getattr(album, "tags", None) or [])]
        album_id = str(album.album_id)
        try:
            cover_url = self._JmcomicText.get_album_cover_url(album_id)
        except Exception:  # noqa: BLE001
            cover_url = ""
        units = self._build_units(album)
        if units:
            count = len(units)
        else:
            # 迭代拿不到章节时保留老的 len(album) 语义（不改变整本下载规则）
            try:
                count = int(len(album))
            except Exception:  # noqa: BLE001
                count = 0
        return {
            "id": album_id,
            "title": str(album.name or "").strip(),
            "authors": authors,
            "tags": tags,
            "page_count": int(getattr(album, "page_count", 0) or 0),
            "chapter_count": count,
            "units": units,
            "unit_count": count,
            "cover_url": cover_url,
            "jm_url": jm_album_url(album_id),
        }

    def _detail_one(self, album_id: str) -> dict | None:
        try:
            album = self._get_client().get_album_detail(str(album_id))
            return self._build_album(album)
        except Exception as exc:  # noqa: BLE001 - 单个详情失败降级
            self.log.warning("详情获取失败 id=%s：%s", album_id, self._short(exc))
            return None

    def album_detail(self, album_id: str, timeout: float | None = None) -> dict:
        """单个专辑详情；失败抛 JmError。"""
        timeout = timeout or max(5.0, float(self.cfg.jm_timeout_sec))
        future = self._submit(self._detail_pool, self._detail_one_strict, str(album_id))
        return self._wait_one(future, timeout, "jm_detail_failed", "JM 详情获取失败，请稍后重试")

    def _detail_one_strict(self, album_id: str) -> dict:
        try:
            album = self._get_client().get_album_detail(str(album_id))
            return self._build_album(album)
        except Exception as exc:  # noqa: BLE001
            raise JmError("jm_detail_failed", f"JM 详情获取失败（{self._short(exc)}）") from None

    def fetch_details(self, album_ids, timeout_each: float = 4.0) -> dict[str, dict | None]:
        """并行获取多个专辑详情；单个失败/超时返回 None（降级）。"""
        ids = [str(item) for item in album_ids]
        if not ids:
            return {}
        futures = {self._submit(self._detail_pool, self._detail_one, aid): aid for aid in ids}
        wait(futures, timeout=max(1.0, float(timeout_each)))
        results: dict[str, dict | None] = {}
        for future, aid in futures.items():
            if future.done() and not future.cancelled():
                try:
                    results[aid] = future.result()
                except Exception as exc:  # noqa: BLE001
                    self.log.warning("详情并行失败 id=%s：%s", aid, self._short(exc))
                    results[aid] = None
            else:
                future.cancel()
                results[aid] = None
        return results

    # ------------------------------------------------------------------ #
    # 章节/单元详情 + 编号解析
    # ------------------------------------------------------------------ #
    def photo_detail(self, photo_id: str, timeout: float | None = None) -> dict:
        """单个章节/单元详情：{id,title,album_id}；失败抛 JmError。"""
        timeout = timeout or max(5.0, float(self.cfg.jm_timeout_sec))
        future = self._submit(self._detail_pool, self._photo_one_strict, str(photo_id))
        return self._wait_one(future, timeout, "jm_detail_failed", "JM 章节详情获取失败，请稍后重试")

    def _photo_one_strict(self, photo_id: str) -> dict:
        try:
            client = self._get_client()
            try:
                # fetch_album=True：解析父作品需要章节挂上所属本子
                photo = client.get_photo_detail(str(photo_id), fetch_album=True)
            except TypeError:  # pragma: no cover - 旧版签名兜底
                photo = client.get_photo_detail(str(photo_id))
        except JmError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise JmError("jm_detail_failed", f"JM 章节详情获取失败（{self._short(exc)}）") from None
        return {
            "id": str(photo_id),
            "title": str(self._chapter_field(photo, "name", "title", "photo_name") or "").strip(),
            "album_id": self._photo_album_id(photo),
        }

    def _photo_album_id(self, photo) -> str | None:
        """从章节实体防御式取所属本子 id（各版本字段名不一致）。"""
        for name in ("album_id", "series_id", "from_album", "albumId"):
            try:
                value = getattr(photo, name)
            except Exception:  # noqa: BLE001
                continue
            if isinstance(value, (str, int)) and not isinstance(value, bool):
                album_id = self._as_id(value)
                if album_id:
                    return album_id
        try:
            album = getattr(photo, "album", None)
        except Exception:  # noqa: BLE001
            return None
        if album is None:
            return None
        # fetch_album=True 时可能是挂着的 JmAlbumDetail 对象，也可能直接是 id
        if isinstance(album, (str, int)) and not isinstance(album, bool):
            return self._as_id(album)
        return self._as_id(self._chapter_field(album, "album_id"))

    def resolve_number(self, number: str) -> dict:
        """按编号精确解析（album 优先，其次章节→父作品）；绝不调用站内搜索。

        返回 {kind: "album"|"photo", album: <详情 dict，含 units>, matched_unit}；
        两个都不是时抛 JmError("not_found")。
        """
        number_text = str(number).strip()
        album: dict | None = None
        try:
            album = self.album_detail(number_text)
        except JmError:
            album = None
        if album:
            return {"kind": "album", "album": album, "matched_unit": None}

        photo: dict | None = None
        try:
            photo = self.photo_detail(number_text)
        except JmError:
            photo = None
        parent_id = self._as_id((photo or {}).get("album_id"))
        if not parent_id:
            raise JmError("not_found", "没有这个编号")
        try:
            album = self.album_detail(parent_id)
        except JmError:
            raise JmError("not_found", "没有这个编号") from None
        matched_unit = None
        for unit in album.get("units") or []:
            if str(unit.get("unit_id")) == number_text:
                matched_unit = {
                    "index": unit.get("index"),
                    "unit_id": str(unit.get("unit_id")),
                    "title": unit.get("title") or "",
                    "page_count": unit.get("page_count"),
                }
                break
        return {"kind": "photo", "album": album, "matched_unit": matched_unit}

    # ------------------------------------------------------------------ #
    # 封面
    # ------------------------------------------------------------------ #
    def cover_path(self, album_id: str) -> Path:
        return Path(self.cfg.covers_dir) / f"{album_id}.jpg"

    def _cover_one(self, album_id: str) -> str | None:
        path = self.cover_path(str(album_id))
        try:
            if path.exists() and path.stat().st_size > 0:
                return str(path)
            client = self._get_client()
            client.download_album_cover(str(album_id), str(path))
            if path.exists() and path.stat().st_size > 0:
                return str(path)
            self.log.warning("封面下载后为空 id=%s", album_id)
            return None
        except Exception as exc:  # noqa: BLE001 - 封面失败降级占位
            self.log.warning("封面下载失败 id=%s：%s", album_id, self._short(exc))
            try:
                if path.exists() and path.stat().st_size == 0:
                    path.unlink()
            except OSError:
                pass
            return None

    def fetch_covers(self, album_ids, timeout: float = 10.0) -> dict[str, str | None]:
        ids = [str(item) for item in album_ids]
        if not ids:
            return {}
        futures = {self._submit(self._cover_pool, self._cover_one, aid): aid for aid in ids}
        wait(futures, timeout=max(1.0, float(timeout)))
        results: dict[str, str | None] = {}
        for future, aid in futures.items():
            if future.done() and not future.cancelled():
                try:
                    results[aid] = future.result()
                except Exception:  # noqa: BLE001
                    results[aid] = None
            else:
                future.cancel()
                results[aid] = None
        return results

    def ensure_cover(self, album_id: str, timeout: float = 10.0) -> str | None:
        path = self.cover_path(str(album_id))
        if path.exists() and path.stat().st_size > 0:
            return str(path)
        return self.fetch_covers([str(album_id)], timeout=timeout).get(str(album_id))

    # ------------------------------------------------------------------ #
    # 整本下载
    # ------------------------------------------------------------------ #
    def _download_option(self, base_dir: Path, rule: str):
        self._prepare_module()
        from jmcomic import create_option_by_str

        yaml_text = f"""
log: true
client:
  impl: api
  postman:
    type: curl_cffi
    meta_data:
      impersonate: chrome
      proxies: {json.dumps(self._proxy_dict)}
download:
  cache: true
  image:
    decode: true
  threading:
    image: {int(self.cfg.jm_threads)}
dir_rule:
  rule: '{rule}'
  base_dir: '{(str(base_dir)).replace(chr(92), "/")}'
"""
        return create_option_by_str(yaml_text)

    def download_album(self, album_id: str, staging_dir: Path, rule: str = "Bd") -> None:
        """调用 jmcomic 下载整本到 staging_dir（阻塞，单 worker 调用）。"""
        staging_dir = Path(staging_dir)
        staging_dir.mkdir(parents=True, exist_ok=True)
        if not self._download_lock.acquire(timeout=1):
            raise JmError("download_busy", "已有下载任务在进行，请稍后重试")
        try:
            option = self._download_option(staging_dir, rule)
            start = time.time()
            self.log.info("开始下载 id=%s rule=%s → %s", album_id, rule, staging_dir)
            option.download_album(int(album_id))
            self.log.info("下载完成 id=%s，%.1fs", album_id, time.time() - start)
        except JmError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise JmError("download_failed", f"下载失败（{self._short(exc)}）") from None
        finally:
            self._download_lock.release()

    def download_photo(self, photo_id: str, staging_dir: Path, rule: str = "Bd") -> None:
        """调用 jmcomic 下载单个章节/单元到 staging_dir（阻塞，单 worker 调用）。

        option.download_photo 优先；AttributeError 时回退模块级 download_photo(photo_id, option)。
        """
        staging_dir = Path(staging_dir)
        staging_dir.mkdir(parents=True, exist_ok=True)
        if not self._download_lock.acquire(timeout=1):
            raise JmError("download_busy", "已有下载任务在进行，请稍后重试")
        try:
            option = self._download_option(staging_dir, rule)
            start = time.time()
            self.log.info("开始下载章节 photo_id=%s rule=%s → %s", photo_id, rule, staging_dir)
            called = False
            try:
                option_method = getattr(option, "download_photo", None)
                if callable(option_method):
                    option_method(int(photo_id))
                    called = True
            except AttributeError:
                called = False
            if not called:
                from jmcomic import download_photo as download_photo_module
                download_photo_module(int(photo_id), option)
            self.log.info("章节下载完成 photo_id=%s，%.1fs", photo_id, time.time() - start)
        except JmError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise JmError("download_failed", f"下载失败（{self._short(exc)}）") from None
        finally:
            self._download_lock.release()

    def shutdown(self) -> None:
        for pool in (self._search_pool, self._detail_pool, self._cover_pool):
            pool.shutdown(wait=False, cancel_futures=True)
