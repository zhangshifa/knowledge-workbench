"""定时同步调度：每分钟巡检，对到点的启用数据源触发同步。"""

from __future__ import annotations

import threading
import time
from datetime import datetime

from .connectors import run_sync
from .core import now_iso


class Scheduler:
    def __init__(self, store, sync_interval_minutes: int = 120, sync_on_boot: bool = False):
        self.store = store
        self.interval = int(sync_interval_minutes or 0)
        self.sync_on_boot = sync_on_boot
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _due(self, source) -> bool:
        interval = int(source.get("syncIntervalMinutes") or self.interval or 0)
        if interval <= 0:
            return False
        last = (source.get("lastSync") or {}).get("finishedAt")
        if not last:
            return True
        try:
            elapsed = (datetime.now() - datetime.fromisoformat(last.replace("Z", "+00:00")).replace(tzinfo=None)).total_seconds()
        except Exception:  # noqa: BLE001
            return True
        return elapsed >= interval * 60

    def tick(self) -> None:
        due = [s for s in self.store.sources.values() if s.get("enabled") and self._due(s)]
        if not due:
            return
        print(f"[scheduler] 触发 {len(due)} 个数据源同步")
        for s in due:
            try:
                run_sync(self.store, s)
            except Exception as e:  # noqa: BLE001
                self.store.record_sync(s["id"], {"status": "failed", "startedAt": now_iso(),
                                                 "finishedAt": now_iso(), "durationMs": 0, "count": 0, "error": str(e)})
                print(f"[scheduler] 同步失败 {s['id']}: {e}")

    def _loop(self) -> None:
        if self.sync_on_boot:
            time.sleep(1.5)
            self.tick()
        while not self._stop.wait(60):
            self.tick()

    def start(self) -> "Scheduler":
        if self.interval == 0 and not self.sync_on_boot:
            return self
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
