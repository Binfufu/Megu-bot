"""jm-view-server 进程管理：启动时 auto_spawn（隐藏窗口）+ 守护重启。"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


def port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


class ViewerManager:
    def __init__(self, config, logger):
        self.cfg = config
        self.log = logger
        self._proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._handles = []
        self._restart_delay = 3.0

    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if not self.cfg.viewer_enabled:
            self.log.info("viewer 已禁用（viewer.enabled=false），不启动 jm-view-server")
            return
        if not self.cfg.viewer_auto_spawn:
            self.log.info("viewer.auto_spawn=false，不自动启动 jm-view-server")
            return
        if self._is_port_busy():
            self.log.info("检测到 %s:%s 已有服务在监听，复用现有 jm-view-server",
                          self.cfg.viewer_host, self.cfg.viewer_port)
            return
        self._stop.clear()
        self._spawn()
        self._thread = threading.Thread(target=self._monitor, name="jm-viewer-monitor", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ #
    def _is_port_busy(self) -> bool:
        return port_open("127.0.0.1", self.cfg.viewer_port)

    def _build_command(self) -> list[str]:
        command = [
            sys.executable, "-m", "jm_view_server",
            str(self.cfg.comics_dir),
            "-H", self.cfg.viewer_host,
            "-p", str(self.cfg.viewer_port),
            "--no-reload", "--no-debug",
        ]
        if self.cfg.viewer_password:
            command += ["-P", self.cfg.viewer_password]
        return command

    def _build_env(self) -> dict:
        env = os.environ.copy()
        extra = [
            str(self.cfg.root / "jm-view-server" / "src"),
            str(self.cfg.root / "JMComic-Crawler-Python" / "src"),
        ]
        current = env.get("PYTHONPATH", "")
        parts = [p for p in extra if p and p not in current.split(os.pathsep)]
        env["PYTHONPATH"] = os.pathsep.join(parts + ([current] if current else []))
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        # jm-view-server 会在 ~ 下写 .jm_messages/.jm_view_server/favorites/sync。
        # 把 viewer 的 HOME 固定到 data/viewer-home，避免用户目录不可写（沙箱/权限）导致启动失败。
        viewer_home = Path(self.cfg.data_dir) / "viewer-home"
        viewer_home.mkdir(parents=True, exist_ok=True)
        env["HOME"] = str(viewer_home)
        env["USERPROFILE"] = str(viewer_home)
        drive = viewer_home.drive or "C:"
        env["HOMEDRIVE"] = drive
        env["HOMEPATH"] = str(viewer_home)[len(drive):] or "\\"
        return env

    def _open_log_files(self):
        logs_dir = Path(self.cfg.logs_dir)
        logs_dir.mkdir(parents=True, exist_ok=True)
        out_handle = open(logs_dir / "jm-view-server.out.log", "a", encoding="utf-8", errors="replace")
        err_handle = open(logs_dir / "jm-view-server.err.log", "a", encoding="utf-8", errors="replace")
        return out_handle, err_handle

    def _spawn(self) -> None:
        command = self._build_command()
        out_handle, err_handle = self._open_log_files()
        self._handles = [out_handle, err_handle]
        self.log.info("启动 jm-view-server：%s", " ".join(command))
        try:
            self._proc = subprocess.Popen(
                command,
                cwd=str(self.cfg.root),
                env=self._build_env(),
                stdin=subprocess.DEVNULL,
                stdout=out_handle,
                stderr=err_handle,
                creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
            )
        except Exception as exc:  # noqa: BLE001
            self.log.error("jm-view-server 启动失败：%s", exc)
            self._proc = None
            return
        try:
            Path(self.cfg.viewer_pid_path).write_text(str(self._proc.pid), encoding="utf-8")
        except OSError as exc:  # pragma: no cover
            self.log.warning("写入 viewer pid 文件失败：%s", exc)
        self._wait_ready()
        if self._proc.poll() is None:
            self._restart_delay = 3.0

    def _wait_ready(self, timeout: float = 12.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc is None:
                return False
            if self._proc.poll() is not None:
                self.log.error("jm-view-server 提前退出，returncode=%s（详见 logs/jm-view-server.err.log）",
                               self._proc.returncode)
                return False
            if self._is_port_busy():
                self.log.info("jm-view-server 已就绪：pid=%s port=%s", self._proc.pid, self.cfg.viewer_port)
                return True
            time.sleep(0.25)
        self.log.warning("jm-view-server %ss 内未监听端口 %s，继续后台等待", timeout, self.cfg.viewer_port)
        return False

    # ------------------------------------------------------------------ #
    def _monitor(self) -> None:
        while not self._stop.is_set():
            proc = self._proc
            if proc is None:
                return
            returncode = proc.wait()
            if self._stop.is_set():
                return
            self.log.warning("jm-view-server 退出（returncode=%s），%ss 后重启",
                             returncode, self._restart_delay)
            deadline = time.time() + self._restart_delay
            while time.time() < deadline and not self._stop.is_set():
                time.sleep(0.2)
            if self._stop.is_set():
                return
            self._restart_delay = min(self._restart_delay * 2, 30.0)
            if self._is_port_busy():
                self.log.info("端口 %s 已有监听，跳过重启", self.cfg.viewer_port)
                continue
            self._spawn()

    # ------------------------------------------------------------------ #
    def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            self.log.info("停止 jm-view-server pid=%s", proc.pid)
            try:
                proc.terminate()
            except OSError:
                pass
            try:
                proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass
        self._proc = None
        try:
            Path(self.cfg.viewer_pid_path).unlink(missing_ok=True)
        except OSError:
            pass

    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None
