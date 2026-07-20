#!/usr/bin/env python3
"""Claude Codeのフックから呼ばれ、エージェントの状態を state/agents.json に書き込む。
サブエージェントが並行実行されると、このスクリプトが同時に複数プロセスで動く
（例: coder/testerが同時にツールを使う）。そのため read-modify-write を
ファイルロックで直列化し、一時ファイル名もプロセスごとに一意にしている。"""
import fcntl
import json
import os
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE_DIR, "state", "agents.json")
LOCK_PATH = STATE_PATH + ".lock"

AGENT_REGISTRY = {
    "P": {"name": "発田案", "dept": "企画部", "role": "PM"},
    "D": {"name": "築山創", "dept": "開発部", "role": "PM"},
    "M": {"name": "広瀬映", "dept": "広報・マーケティング部", "role": "PM"},
    "S": {"name": "ユイ", "dept": "秘書室", "role": "秘書"},
}

AGENT_ID = os.environ.get("AI_MIERUKA_AGENT", "P")
AGENT_META = AGENT_REGISTRY.get(AGENT_ID, AGENT_REGISTRY["P"])

MAX_LOG = 30


def load_stdin():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def tool_detail(tool_name, tool_input):
    ti = tool_input or {}
    if tool_name == "Bash":
        return (ti.get("command") or "")[:40]
    if tool_name in ("Read", "Edit", "Write", "NotebookEdit"):
        fp = ti.get("file_path") or ti.get("notebook_path") or ""
        return os.path.basename(fp)
    if tool_name in ("Agent", "Task"):
        return ti.get("description") or "サブエージェント起動"
    if tool_name == "Grep":
        return ti.get("pattern") or ""
    if tool_name == "WebSearch":
        return ti.get("query") or ""
    if tool_name == "WebFetch":
        return ti.get("url") or ""
    if tool_name == "TodoWrite":
        return "タスク更新"
    return tool_name or ""


def build_update(data):
    event = data.get("hook_event_name", "")
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    prompt = data.get("prompt", "")

    if event == "SessionStart":
        return "idle", "出社しました"
    if event == "UserPromptSubmit":
        return "thinking", f"社長の指示を検討中: {prompt[:30]}"
    if event == "PreToolUse":
        return "working", f"{tool_name}: {tool_detail(tool_name, tool_input)}"
    if event == "PostToolUse":
        return "working", f"{tool_name} 完了"
    if event == "Stop":
        return "reporting", "社長へ報告中"
    if event == "SubagentStart":
        return "working", f"部下({data.get('agent_type', '?')})に作業を依頼"
    if event == "SubagentStop":
        return "working", f"部下({data.get('agent_type', '?')})から報告を受領"
    return None, None


def main():
    data = load_stdin()
    event = data.get("hook_event_name", "")
    state, detail = build_update(data)
    if state is None:
        return

    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)

    with open(LOCK_PATH, "w") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            try:
                with open(STATE_PATH, "r", encoding="utf-8") as f:
                    store = json.load(f)
            except Exception:
                store = {"agents": {}}

            agents = store.setdefault("agents", {})
            now = datetime.now()
            agent = agents.setdefault(AGENT_ID, {**AGENT_META, "log": []})
            agent.update(AGENT_META)
            agent["state"] = state
            agent["detail"] = detail
            agent["updated_at"] = now.timestamp()

            active = agent.setdefault("active_subagents", [])
            if event == "SubagentStart":
                active.append({"id": data.get("agent_id", ""), "type": data.get("agent_type", "agent")})
            elif event == "SubagentStop":
                stopped_id = data.get("agent_id", "")
                agent["active_subagents"] = [a for a in active if a.get("id") != stopped_id]

            log = agent.setdefault("log", [])
            log.append({"time": now.strftime("%H:%M:%S"), "state": state, "detail": detail})
            del log[:-MAX_LOG]

            tmp_path = f"{STATE_PATH}.{os.getpid()}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(store, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, STATE_PATH)
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
