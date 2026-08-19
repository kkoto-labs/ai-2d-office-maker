#!/usr/bin/env python3
"""このマシンで動いている、オフィス管理外の Claude Code セッションを見つける。

フックはこのオフィスが起動したセッションしか教えてくれない。手元のターミナルで
開いた claude は、どこにも現れないまま裏で働いていることになる。
Claude Code は会話を ~/.claude/projects/<作業ディレクトリ>/<セッションID>.jsonl に
書き続けているので、その末尾だけを覗いて「いま誰が何をしているか」を拾う。

何をしているか分かるよう、ツールの入力（コマンドやファイル名など）や直近の
応答テキストも短く覗くが、いずれも先頭の数十文字に切り詰めて画面に出すだけで、
どこかに保存したり別セッションへ転送したりはしない。
"""
import json
import os
import time

PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
# 末尾から読む量。1件の記録が数KBあるので、これだけあれば直近の数件は入る。
TAIL_BYTES = 64 * 1024
# これ以上更新が無いセッションは、もう終わったものとして扱う。
# 長いツール実行中はログが暫く追記されないことがあるため、短すぎると
# 動いているセッションを誤って「終わった」と見なしてしまう。
ACTIVE_WINDOW = 600.0


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
    """ファイル末尾から、最後に書かれた user/assistant の1件を取り出す。

    数MBに育つので、頭から読むと1秒ごとの巡回に耐えない。Claude Desktop経由の
    セッションは、queue-operationやattachmentなど画面に出す情報を持たない
    補助的な記録も書くので、それらは読み飛ばして意味のある記録まで遡る。
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
            record = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        else:
            if record.get("type") in ("user", "assistant"):
                return record
    return None


def _summarize(session_id, record, path):
    """記録1件から、画面に出す最小限の情報だけを取り出す。"""
    cwd = record.get("cwd") or ""
    state, detail = _read_activity(record)
    return {
        "session": session_id,
        "short": session_id[:8],
        "folder": os.path.basename(cwd.replace("\\", "/").rstrip("/")) or "不明",
        "cwd": cwd,
        "state": state,
        "detail": detail,
        "updated_at": os.path.getmtime(path),
    }


DETAIL_LEN = 60

# ツールごとに、何をしているかが分かる引数だけを取り出す。
TOOL_INPUT_KEY = {
    "Bash": "command", "PowerShell": "command",
    "Read": "file_path", "Edit": "file_path", "Write": "file_path",
    "NotebookEdit": "notebook_path",
    "Grep": "pattern", "Glob": "pattern",
    "WebSearch": "query", "WebFetch": "url",
}


def _tool_detail(name, tool_input):
    key = TOOL_INPUT_KEY.get(name)
    value = (tool_input or {}).get(key) if key else None
    if not value:
        return name
    if key == "file_path" or key == "notebook_path":
        value = os.path.basename(value)
    return f"{name}: {value}"[:DETAIL_LEN]


def _read_activity(record):
    """最後の記録から、いまの様子を推し量る。"""
    message = record.get("message")
    message = message if isinstance(message, dict) else {}
    blocks = [c for c in (message.get("content") or []) if isinstance(c, dict)]

    if record.get("type") == "user":
        texts = [c.get("content") for c in blocks if c.get("type") == "tool_result"]
        if texts:
            return "working", "ツール結果を確認中"
        text = message.get("content") if isinstance(message.get("content"), str) else None
        return "thinking", (text or "指示を受け取りました")[:DETAIL_LEN]

    tools = [c for c in blocks if c.get("type") == "tool_use"]
    if tools:
        tool = tools[0]
        return "working", _tool_detail(tool.get("name") or "", tool.get("input"))

    texts = [c.get("text") for c in blocks if c.get("type") == "text" and c.get("text")]
    if texts:
        return "reporting", texts[-1].strip().replace("\n", " ")[:DETAIL_LEN]
    return "reporting", "応答中"
