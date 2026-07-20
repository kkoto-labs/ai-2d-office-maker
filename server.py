#!/usr/bin/env python3
"""ビューア配信 + ブラウザからの指示を受け付けるローカルサーバー。
localhost専用（他マシンからはアクセスできません）。
エージェントごとに state/sessions/<AGENT_ID>.txt へセッションIDを記録し、
それを --resume することで、同じキャラへの指示が過去の会話を引き継ぐ。"""
import fcntl
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "state", "agents.json")
LOCK_PATH = STATE_PATH + ".lock"
SESSION_DIR = os.path.join(BASE_DIR, "state", "sessions")
PROMPTS_DIR = os.path.join(BASE_DIR, "prompts")
SOULS_DIR = os.path.join(BASE_DIR, "souls")
PORT = 8420

VALID_AGENTS = {"P", "D", "M", "S"}
DEFAULT_AGENT = "P"

# 内部ID(セッションファイル名・env var用)と、実際の人物名(souls/*.md用)の対応。
AGENT_NAMES = {"P": "発田案", "D": "築山創", "M": "広瀬映", "S": "ユイ"}

task_queue = queue.Queue()
queue_len_lock = threading.Lock()
queue_len_by_agent = {}


def session_file(agent_id):
    return os.path.join(SESSION_DIR, f"{agent_id}.txt")


def system_prompt_for(agent_id):
    parts = []
    name = AGENT_NAMES.get(agent_id, agent_id)
    soul_path = os.path.join(SOULS_DIR, f"{name}.md")
    if os.path.exists(soul_path):
        with open(soul_path, encoding="utf-8") as f:
            parts.append(f.read())
    role_path = os.path.join(PROMPTS_DIR, f"{agent_id}.txt")
    if os.path.exists(role_path):
        with open(role_path, encoding="utf-8") as f:
            parts.append(f.read())
    return "\n\n".join(parts) if parts else None


def patch_state(agent_id, **fields):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(LOCK_PATH, "w") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            try:
                with open(STATE_PATH, "r", encoding="utf-8") as f:
                    store = json.load(f)
            except Exception:
                store = {"agents": {}}
            agent = store.setdefault("agents", {}).setdefault(agent_id, {})
            agent.update(fields)
            tmp_path = f"{STATE_PATH}.{os.getpid()}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(store, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, STATE_PATH)
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def set_queue_len(agent_id, delta):
    with queue_len_lock:
        n = queue_len_by_agent.get(agent_id, 0) + delta
        queue_len_by_agent[agent_id] = n
    patch_state(agent_id, queue_len=n)


def run_instruction(agent_id, instruction):
    os.makedirs(SESSION_DIR, exist_ok=True)
    sess_path = session_file(agent_id)
    env = os.environ.copy()
    env["AI_MIERUKA_AGENT"] = agent_id

    if os.path.exists(sess_path):
        with open(sess_path, encoding="utf-8") as f:
            session_id = f.read().strip()
        cmd = ["claude", "-p", instruction, "--permission-mode", "auto",
               "--resume", session_id, "--output-format", "text"]
    else:
        session_id = str(uuid.uuid4())
        cmd = ["claude", "-p", instruction, "--permission-mode", "auto",
               "--session-id", session_id, "--output-format", "text"]

    prompt = system_prompt_for(agent_id)
    if prompt:
        cmd += ["--append-system-prompt", prompt]

    result = subprocess.run(cmd, cwd=BASE_DIR, env=env, capture_output=True,
                             text=True, timeout=1800)

    if not os.path.exists(sess_path):
        with open(sess_path, "w", encoding="utf-8") as f:
            f.write(session_id)

    report = result.stdout.strip() or "(出力なし)"
    if result.returncode != 0:
        report = f"[エラー exit={result.returncode}] {result.stderr.strip()[:500]}\n{report}"
    patch_state(agent_id, last_report=report, last_report_at=time.time())


def worker_loop():
    while True:
        agent_id, instruction = task_queue.get()
        try:
            run_instruction(agent_id, instruction)
        except Exception as e:
            patch_state(agent_id, last_report=f"[エラー] {e}", last_report_at=time.time())
        finally:
            set_queue_len(agent_id, -1)
            task_queue.task_done()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_POST(self):
        if self.path != "/instruct":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
            instruction = (payload.get("instruction") or "").strip()
            agent_id = (payload.get("agent_id") or DEFAULT_AGENT).strip()
        except Exception:
            instruction = ""
            agent_id = DEFAULT_AGENT

        if agent_id not in VALID_AGENTS:
            agent_id = DEFAULT_AGENT

        if not instruction:
            body = b'{"error":"empty instruction"}'
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        task_queue.put((agent_id, instruction))
        set_queue_len(agent_id, 1)
        body = json.dumps({"status": "queued", "agent_id": agent_id}).encode("utf-8")
        self.send_response(202)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    threading.Thread(target=worker_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"AI見える化オフィス: http://localhost:{PORT}/viewer/")
    httpd.serve_forever()
