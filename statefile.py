#!/usr/bin/env python3
"""state/agents.json への read-modify-write を直列化するための共有ヘルパー。

server.py とフック(hooks/update_state.py)が同じファイルを書きにいくため、
ロックとアトミック書き込みをここに集約している。
排他ロックは Unix が fcntl.flock、Windows が msvcrt.locking と API が違うので、
その差をこのモジュールで吸収する。
"""
import json
import os
import time
from contextlib import contextmanager

try:
    import fcntl
    _WINDOWS = False
except ImportError:  # Windows には fcntl が無い
    import msvcrt
    _WINDOWS = True

# ロック取得を諦めるまでの秒数。
LOCK_TIMEOUT = 30.0
# os.replace が Windows で弾かれたときにリトライする秒数。
REPLACE_TIMEOUT = 2.0


@contextmanager
def state_lock(lock_path):
    """lock_path を排他ロックする。取得できるまでブロックする。"""
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    # "w" で開くと、他プロセスがロック中のときに Windows では truncate が
    # 失敗しうる。"a+" なら既存内容を切り詰めないので安全。
    with open(lock_path, "a+") as lock_f:
        _acquire(lock_f)
        try:
            yield
        finally:
            _release(lock_f)


def _acquire(lock_f):
    if not _WINDOWS:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        return
    # msvcrt にはブロッキング取得が無い(LK_LOCK は10秒で諦めて例外を投げる)
    # ため、ノンブロッキング版を自前でリトライする。
    deadline = time.monotonic() + LOCK_TIMEOUT
    while True:
        try:
            lock_f.seek(0)
            msvcrt.locking(lock_f.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _release(lock_f):
    if not _WINDOWS:
        fcntl.flock(lock_f, fcntl.LOCK_UN)
        return
    lock_f.seek(0)
    msvcrt.locking(lock_f.fileno(), msvcrt.LK_UNLCK, 1)


def load_state(path):
    """状態ファイルを読む。壊れている・存在しない場合は空の状態を返す。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"agents": {}}


def write_state(path, store):
    """一時ファイル経由で置き換え、読み手が中途半端なJSONを見ないようにする。

    Windows では、ビューアのポーリングがちょうど agents.json を開いている
    瞬間に os.replace が PermissionError になりうるので短くリトライする。
    """
    tmp_path = f"{path}.{os.getpid()}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)

    deadline = time.monotonic() + REPLACE_TIMEOUT
    while True:
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
                raise
            time.sleep(0.05)
