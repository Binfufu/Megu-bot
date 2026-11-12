"""服务入口：python -m jm_service（由 start.ps1 以隐藏窗口常驻启动）。"""
from __future__ import annotations

import atexit
import signal
import sys

from .app import SERVICE_NAME, VERSION, Service
from .config import Config


def main(argv=None) -> int:
    config = Config.load()
    service = Service(config)
    log = service.log
    pid_path = config.service_pid_path
    try:
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        pid_path.write_text(str(__import__("os").getpid()), encoding="utf-8")
    except OSError as exc:
        log.warning("写入 pid 文件失败：%s", exc)

    atexit.register(service.shutdown)

    def _terminate(signum, _frame):
        log.info("收到信号 %s，准备退出", signum)
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, _terminate)
    except (ValueError, OSError):  # pragma: no cover - 非主线程等场景
        pass

    service.start_background()
    log.info("%s v%s 监听 http://%s:%s", SERVICE_NAME, VERSION, config.host, config.port)
    try:
        service.app.run(
            host=config.host,
            port=config.port,
            threaded=True,
            use_reloader=False,
            debug=False,
        )
    except OSError as exc:
        log.error("服务启动失败（端口 %s 可能被占用）：%s", config.port, exc)
        return 2
    except KeyboardInterrupt:
        pass
    finally:
        log.info("服务退出流程开始")
        service.shutdown()
        try:
            pid_path.unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
