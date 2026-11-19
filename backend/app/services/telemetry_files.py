"""Share complete telemetry files between replay preparation and opponent analysis."""

import json
import os
from collections.abc import Callable
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

from app.core.errors import AppError

_file_locks = [Lock() for _ in range(32)]


def file_stamp(stat: os.stat_result) -> str:
    return f"{stat.st_dev}-{stat.st_ino}-{stat.st_size}-{stat.st_mtime_ns}"


def load_telemetry(path: Path, fetch: Callable[[], bytes]) -> tuple[bytes, list, str]:
    def decode(content: bytes) -> list:
        try:
            events = json.loads(content)
        except ValueError as exc:
            raise AppError("INVALID_TELEMETRY", "无法读取对局遥测", 502) from exc
        if not isinstance(events, list) or not events:
            raise AppError("INVALID_TELEMETRY", "缺少对局遥测事件", 502)
        return events

    with _file_locks[hash(path.resolve()) % len(_file_locks)]:
        if path.is_file():
            with path.open("rb") as source:
                content = source.read()
                stamp = file_stamp(os.fstat(source.fileno()))
            try:
                return content, decode(content), stamp
            except AppError:
                pass  # Replace invalid old data only after a good download.
        content = fetch()
        events = decode(content)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = NamedTemporaryFile(dir=path.parent, delete=False)
        temp_path = Path(temporary.name)
        try:
            with temporary:
                temporary.write(content)
            stamp = file_stamp(temp_path.stat())
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)
        return content, events, stamp
