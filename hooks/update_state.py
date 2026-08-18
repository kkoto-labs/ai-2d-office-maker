#!/usr/bin/env python3
"""Claude Codeのフックから呼ばれ、エージェントの状態を state/agents.json に書き込む。
サブエージェントが並行実行されると、このスクリプトが同時に複数プロセスで動く
（例: coder/testerが同時にツールを使う）。そのため read-modify-write を
ファイルロックで直列化し、一時ファイル名もプロセスごとに一意にしている。"""
import json
import os
import re
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(BASE_DIR, "state", "agents.json")
LOCK_PATH = STATE_PATH + ".lock"

# フックはリポジトリ外の作業ディレクトリから起動されうるため、
# 共有ヘルパーを import できるようリポジトリルートを明示的に通す。
sys.path.insert(0, BASE_DIR)
from statefile import load_state, state_lock, write_state  # noqa: E402

# 設定が読めなくてもフックは落とさない。ここで例外を投げると、
# セッション中のあらゆるツール実行が巻き添えで失敗するため。
FALLBACK_META = {"name": "不明", "dept": "未設定", "role": ""}


def load_registry():
    try:
        import officeconfig
        cfg = officeconfig.load()
        return {a["id"]: {"name": a["name"], "dept": a["dept"], "role": a["role"]}
                for a in cfg.get("agents", [])}
    except Exception:
        return {}


AGENT_REGISTRY = load_registry()
SESSION_DIR = os.path.join(BASE_DIR, "state", "sessions")

MAX_LOG = 30


def agent_from_session(session_id):
    """記録済みのセッションIDから、どのキャラのものかを引く。

    server.py はキャラごとのセッションIDを state/sessions/<ID>.txt に控えている。
    環境変数が届かない経路（サブエージェントなど）でも、ここから本人が分かる。
    """
    if not session_id:
        return None
    try:
        names = os.listdir(SESSION_DIR)
    except OSError:
        return None
    for filename in names:
        if not filename.endswith(".txt"):
            continue
        try:
            with open(os.path.join(SESSION_DIR, filename), encoding="utf-8") as f:
                if f.read().strip() == session_id:
                    return filename[:-len(".txt")]
        except OSError:
            continue
    return None


def resolve_agent(data):
    """このフックがどのキャラのものかを決める。無関係なら None。

    以前は分からないときに先頭のキャラへ書き込んでいた。そのため、この
    リポジトリで手元の claude を開いただけで、秘書が勝手に働いているように
    見えていた。誰か分からないものは、誰でもないものとして扱う。
    """
    agent_id = os.environ.get("AI_MIERUKA_AGENT")
    if not agent_id:
        agent_id = agent_from_session(data.get("session_id"))
    if not agent_id:
        return None
    return agent_id


def load_stdin():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


# 他部署への相談は、claude を子プロセスとして起動するBashコマンドで行う。
# 宛先は AI_MIERUKA_AGENT で渡しているので、そこから相手を読み取る。
CONSULT_RE = re.compile(r"AI_MIERUKA_AGENT=([A-Za-z0-9_-]+)\s+\S*claude\b")


def consult_target(command):
    """相談コマンドなら宛先の表示名を返す。違えば None。

    コマンド文には if 分岐の両側が入るので、同じIDが2回現れる。宛先は
    1つなので最初の1件だけを見る。
    """
    match = CONSULT_RE.search(command or "")
    if not match:
        return None
    agent_id = match.group(1)
    return AGENT_REGISTRY.get(agent_id, {}).get("name", agent_id)


# ツールを「何をしている様子か」に束ねる。画面の動きはこの分類で決まる。
# ツール名そのままだと種類が多すぎて、見た目を作り分けられない。
ACTIVITY_BY_TOOL = {
    "Edit": "edit", "Write": "edit", "NotebookEdit": "edit",
    "Read": "read", "Grep": "read", "Glob": "read",
    "Bash": "run", "PowerShell": "run",
    "WebFetch": "web", "WebSearch": "web",
    "Agent": "delegate", "Task": "delegate",
}


def tool_activity(tool_name, tool_input):
    if tool_name == "Bash" and consult_target((tool_input or {}).get("command")):
        return "consult"
    return ACTIVITY_BY_TOOL.get(tool_name, "think")


def tool_detail(tool_name, tool_input):
    ti = tool_input or {}
    if tool_name == "Bash":
        command = ti.get("command") or ""
        # 生のコマンドを出しても、社内の誰と話しているのかは読み取れない。
        target = consult_target(command)
        return f"{target}に相談中" if target else command[:40]
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
        return "idle", "出社しました", "rest"
    if event == "UserPromptSubmit":
        return "thinking", f"社長の指示を検討中: {prompt[:30]}", "think"
    # 他部署への相談は、ツール名を頭に付けず状態も分ける。
    # 「Bash: ...」では、社内で誰と話しているのかが画面から読めない。
    consulting = consult_target(tool_input.get("command")) if tool_name == "Bash" else None

    if event == "PreToolUse":
        if consulting:
            return "consulting", f"{consulting}に相談中", "consult"
        return ("working", f"{tool_name}: {tool_detail(tool_name, tool_input)}",
                tool_activity(tool_name, tool_input))
    if event == "PostToolUse":
        if consulting:
            return "working", f"{consulting}から回答を受領", "consult"
        return "working", f"{tool_name} 完了", tool_activity(tool_name, tool_input)
    if event == "Stop":
        return "reporting", "社長へ報告中", "report"
    if event == "SubagentStart":
        return "working", f"部下({data.get('agent_type', '?')})に作業を依頼", "delegate"
    if event == "SubagentStop":
        return "working", f"部下({data.get('agent_type', '?')})から報告を受領", "delegate"
    return None, None, None


def main():
    data = load_stdin()
    agent_id = resolve_agent(data)
    if agent_id is None:
        # このオフィスと関係のないセッション。誰の状態も書き換えない。
        return

    event = data.get("hook_event_name", "")
    state, detail, activity = build_update(data)
    if state is None:
        return

    meta = AGENT_REGISTRY.get(agent_id, FALLBACK_META)
    with state_lock(LOCK_PATH):
        store = load_state(STATE_PATH)

        agents = store.setdefault("agents", {})
        now = datetime.now()
        agent = agents.setdefault(agent_id, {**meta, "log": []})
        agent.update(meta)
        agent["state"] = state
        agent["detail"] = detail
        agent["activity"] = activity
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

        write_state(STATE_PATH, store)


if __name__ == "__main__":
    main()
