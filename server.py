#!/usr/bin/env python3
"""ビューア配信 + ブラウザからの指示を受け付けるローカルサーバー。
localhost専用（他マシンからはアクセスできません）。
エージェントごとに state/sessions/<AGENT_ID>.txt へセッションIDを記録し、
それを --resume することで、同じキャラへの指示が過去の会話を引き継ぐ。"""
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from statefile import load_state, state_lock, write_state

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
    with state_lock(LOCK_PATH):
        store = load_state(STATE_PATH)
        agent = store.setdefault("agents", {}).setdefault(agent_id, {})
        agent.update(fields)
        write_state(STATE_PATH, store)


def set_queue_len(agent_id, delta):
    with queue_len_lock:
        n = queue_len_by_agent.get(agent_id, 0) + delta
        queue_len_by_agent[agent_id] = n
    patch_state(agent_id, queue_len=n)


def claude_bin():
    """claude 実行ファイルのフルパスを返す。

    Windows では claude の実体が claude.CMD なので、subprocess に文字列
    "claude" をそのまま渡すと CreateProcess が PATHEXT を見ずに解決へ失敗する。
    PATHEXT を考慮する shutil.which で解決してから渡す必要がある。
    """
    path = shutil.which("claude")
    if not path:
        raise FileNotFoundError(
            "claude コマンドが見つかりません。Claude Code CLI をインストールし、"
            "PATH が通っているか確認してください。")
    return path


def run_instruction(agent_id, instruction):
    os.makedirs(SESSION_DIR, exist_ok=True)
    sess_path = session_file(agent_id)
    env = os.environ.copy()
    env["AI_MIERUKA_AGENT"] = agent_id

    if os.path.exists(sess_path):
        with open(sess_path, encoding="utf-8") as f:
            session_id = f.read().strip()
        cmd = [claude_bin(), "-p", instruction, "--permission-mode", "auto",
               "--resume", session_id, "--output-format", "text"]
    else:
        session_id = str(uuid.uuid4())
        cmd = [claude_bin(), "-p", instruction, "--permission-mode", "auto",
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


class OfficeServer(ThreadingHTTPServer):
    # Windows の SO_REUSEADDR は、既に LISTEN 中のポートへの二重バインドまで
    # 許してしまう。二重起動に気づけないまま2つのサーバーがリクエストを
    # 取り合うより、その場で "address already in use" で失敗させたい。
    allow_reuse_address = os.name != "nt"


# 子プロセスが「server.pyが更新されたので起動し直してほしい」と
# 親に伝えるための終了コード。
RESTART_EXIT_CODE = 97
CHILD_ENV_FLAG = "AI_MIERUKA_CHILD"


def watch_self_and_exit(httpd, interval=1.0):
    """server.py自身が編集されたら、ポートを解放して再起動要求コードで終了する。
    手動でkill/restartしなくても、次のブラウザからの指示から新しいコードが
    使われるようにするため。"""
    path = os.path.abspath(__file__)
    last_mtime = os.path.getmtime(path)
    while True:
        time.sleep(interval)
        try:
            mtime = os.path.getmtime(path)
        except FileNotFoundError:
            continue
        if mtime != last_mtime:
            httpd.server_close()
            # デーモンスレッドからなので sys.exit ではプロセスが終わらない。
            os._exit(RESTART_EXIT_CODE)


def supervise():
    """サーバー本体を子プロセスとして動かし、再起動要求が来たら起動し直す親。

    以前は os.execv で自分自身を置き換えていたが、Windows の os.execv は
    プロセスを置き換えず「別プロセスを起こして自分は終了する」ため、
    起動元のターミナルがサーバーを見失い、Ctrl+Cの効かない孤児プロセスが
    ポートを掴んだまま残ってしまう。親を常駐させる方式なら、どちらのOSでも
    ターミナルがサーバーを掴んだままにできる。
    """
    env = dict(os.environ, **{CHILD_ENV_FLAG: "1"})
    child_cmd = [sys.executable]
    if sys.flags.utf8_mode:
        # 親のUTF-8モードは子に自動では伝わらない。引き継がないと、実際に
        # 画面へ出力するのは子なので、日本語だけコンソール既定のコード
        # ページ(日本語WindowsならCP932)で出てしまい文字化けする。
        child_cmd += ["-X", "utf8"]
    child_cmd += ["-u", os.path.abspath(__file__)]
    while True:
        try:
            code = subprocess.run(child_cmd, env=env).returncode
        except KeyboardInterrupt:
            return 0
        if code != RESTART_EXIT_CODE:
            return code
        print("[reload] server.py が更新されたため再起動します...", flush=True)


if __name__ == "__main__":
    if os.environ.get(CHILD_ENV_FLAG) != "1":
        sys.exit(supervise())

    threading.Thread(target=worker_loop, daemon=True).start()
    httpd = OfficeServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=watch_self_and_exit, args=(httpd,), daemon=True).start()
    print(f"AI見える化オフィス: http://localhost:{PORT}/viewer/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
