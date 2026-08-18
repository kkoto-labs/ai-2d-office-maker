#!/usr/bin/env python3
"""このマシンで動いている、オフィス管理外の Claude Code セッションを見つける。

フックはこのオフィスが起動したセッションしか教えてくれない。手元のターミナルで
開いた claude は、どこにも現れないまま裏で働いていることになる。
Claude Code は会話を ~/.claude/projects/<作業ディレクトリ>/<セッションID>.jsonl に
書き続けているので、その末尾だけを覗いて「いま誰が何をしているか」を拾う。

読むのは種別・時刻・ツール名だけで、会話の中身には触れない。
"""
import json
import os
import time

PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
# 末尾から読む量。1件の記録が数KBあるので、これだけあれば直近の数件は入る。
TAIL_BYTES = 64 * 1024
# これ以上更新が無いセッションは、もう終わったものとして扱う。
ACTIVE_WINDOW = 90.0


def scan(exclude_sessions=(), now=None):
    """稼働中の外部セッションを {セッションID: 情報} で返す。"""
    now = now or time.time()
    found = {}
    try:
        projects = os.listdir(PROJECTS_DIR)
    except OSError:
        return found

    for project in projects:
        project_dir = os.path.join(PROJECTS_DIR, project)
        try:
            names = os.listdir(project_dir)
        except OSError:
            continue

        for name in names:
            if not name.endswith(".jsonl"):
                continue
            session_id = name[: -len(".jsonl")]
            if session_id in exclude_sessions:
                continue

            path = os.path.join(project_dir, name)
            try:
                if now - os.path.getmtime(path) > ACTIVE_WINDOW:
                    continue
            except OSError:
                continue

            record = _read_last_record(path)
            if record:
                found[session_id] = _summarize(session_id, record, path)
    return found


def _read_last_record(path):
    """ファイル末尾から、最後に書かれた完全な1件を取り出す。

    数MBに育つので、頭から読むと1秒ごとの巡回に耐えない。
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read()
    except OSError:
        return None

    # 先頭は行の途中で切れている可能性が高いので捨てる。
    lines = chunk.split(b"\n")[1:] if len(chunk) == TAIL_BYTES else chunk.split(b"\n")
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            return json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
    return None


def _summarize(session_id, record, path):
    """記録1件から、画面に出す最小限の情報だけを取り出す。"""
    cwd = record.get("cwd") or ""
    state, detail = _read_activity(record)
    return {
        "session": session_id,
        "short": session_id[:8],
        "project": os.path.basename(cwd.replace("\\", "/").rstrip("/")) or "不明",
        "cwd": cwd,
        "state": state,
        "detail": detail,
        "updated_at": os.path.getmtime(path),
    }


def _read_activity(record):
    """最後の記録から、いまの様子を推し量る。"""
    message = record.get("message")
    message = message if isinstance(message, dict) else {}

    if record.get("type") == "user":
        return "thinking", "指示を受け取りました"

    tools = [c.get("name") for c in message.get("content") or []
             if isinstance(c, dict) and c.get("type") == "tool_use"]
    if tools:
        return "working", tools[0]
    return "reporting", "応答中"
