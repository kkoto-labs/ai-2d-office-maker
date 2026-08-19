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

import officeconfig
import sessionscan
from statefile import load_state, state_lock, write_state

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "state", "agents.json")
LOCK_PATH = STATE_PATH + ".lock"
SESSION_DIR = os.path.join(BASE_DIR, "state", "sessions")
PROMPTS_DIR = os.path.join(BASE_DIR, "prompts")
PORT = 8420

task_queue = queue.Queue()
queue_len_lock = threading.Lock()
queue_len_by_agent = {}


def session_file(agent_id):
    return os.path.join(SESSION_DIR, f"{agent_id}.txt")


# ブラウザには最終的な報告テキストしか届かない（ヘッドレス実行なので途中で
# 対話できない）。社長に選択肢から選んでほしい場面では、この形式で報告の
# 最後に書いてもらうことで、画面側がボタン付きのモーダルとして表示できる。
QUESTION_FORMAT_PROMPT = (
    "社長に選択肢から選んでもらいたい確認がある場合は、報告の最後に次の形式で"
    "書いてください（自由記述で答えてほしいだけなら、この形式は使わず普通に"
    "聞いてください）:\n\n"
    "[SHACHO_QUESTION]\n"
    "質問文をここに\n"
    "1. 選択肢A\n"
    "2. 選択肢B\n"
    "[/SHACHO_QUESTION]\n\n"
    "選択肢は2〜4個にしてください。"
)


def system_prompt_for(cfg, agent):
    """SOUL(人格) + 役割プロンプト + 関係性(自動生成) を連結する。

    関係性のブロックだけは config から毎回組み立てる。部下や相談先を
    prompts/*.txt に手書きしていた頃は、設定を変えても本文が古いままになり
    実態とプロンプトがずれていた。
    """
    # 名乗りも設定から組み立てる。prompts/*.txt に名前を書いていた頃は、
    # 設定画面で改名しても本文が古い名前のままになっていた。
    parts = [
        f"あなたは「AI見える化」という社内シミュレーションの{agent['dept']}"
        f"{agent['role']}、{agent['name']}(内部ID: {agent['id']})です。"
    ]

    soul = officeconfig.read_soul(agent["soul"])
    if soul.strip():
        parts.append(soul)

    role_path = os.path.join(PROMPTS_DIR, f"{agent['id']}.txt")
    if os.path.exists(role_path):
        with open(role_path, encoding="utf-8") as f:
            parts.append(f.read())

    workspaces = workspace_prompt(cfg, agent)
    if workspaces:
        parts.append(workspaces)

    relations = relationship_prompt(cfg, agent)
    if relations:
        parts.append(relations)

    parts.append(QUESTION_FORMAT_PROMPT)

    return "\n\n".join(parts) if parts else None


def workspace_prompt(cfg, agent):
    """担当ワークスペースを伝える。2つ目以降がある場合だけ書く。

    1つだけならカレントディレクトリがそれなので、わざわざ説明する必要がない。
    """
    keys = agent.get("workspaces") or []
    if len(keys) < 2:
        return ""

    defined = cfg.get("workspaces") or {}
    paths = officeconfig.workspace_paths(cfg, agent)
    lines = [f"- {defined.get(k, {}).get('name', k)}: {p}" for k, p in zip(keys, paths)]
    return ("あなたは以下のワークスペースを担当しています。1つ目が現在の作業ディレクトリで、\n"
            "残りも読み書きできます:\n\n" + "\n".join(lines))


def relationship_prompt(cfg, agent):
    """設定された部下・相談先を、そのままプロンプトに使える文章にする。"""
    blocks = []

    subagents = agent.get("subagents") or []
    if subagents:
        described = {s["name"]: s["description"] for s in officeconfig.subagent_catalog()}
        lines = [f"- {name}: {described.get(name, '')}".rstrip() for name in subagents]
        blocks.append(
            "あなたの部下として、以下のサブエージェントが用意されています。仕事の内容に\n"
            "応じて、Agentツールで名前を指定して使い分けてください。1人で何でもこなそうと\n"
            "せず、規模のある仕事は適切な相手に振ってください:\n\n" + "\n".join(lines))

    consults = agent.get("consults") or []
    if consults:
        by_id = officeconfig.agent_map(cfg)
        lines = [f"- {by_id[c]['name']} ({c}): {by_id[c]['dept']}"
                 for c in consults if c in by_id]
        blocks.append(
            "以下の部署に直接相談できます:\n\n" + "\n".join(lines) + "\n\n"
            + consult_recipe(consults))

    return "\n\n".join(blocks)


def consult_recipe(consults):
    """他部署への相談に使う Bash コマンドの雛形。

    セッションIDの生成にはこのサーバーを動かしている Python
    (sys.executable) をフルパスで埋め込む。プロンプトに "python3" と
    書いていた頃は、Windows で Microsoft Store のスタブに解決されて
    相談が丸ごと失敗していた。
    """
    ids = "・".join(consults)
    return (
        f"相談するには、プロジェクトルート(カレントディレクトリ)で以下のBashコマンドを\n"
        f"実行してください(<部署ID>を {ids} のいずれかに、<相談内容>を実際の相談文に\n"
        f"置き換える。セッションがまだ無い部署にも対応できるよう、必ずこのif分岐の形で\n"
        f"実行すること):\n\n"
        f'if [ -f "state/sessions/<部署ID>.txt" ]; then\n'
        f'  SID=$(cat "state/sessions/<部署ID>.txt")\n'
        f'  AI_MIERUKA_AGENT=<部署ID> claude -p "<相談内容>" --resume "$SID" '
        f'--permission-mode auto --output-format text\n'
        f"else\n"
        f'  SID=$("{sys.executable}" -c "import uuid; print(uuid.uuid4())")\n'
        f'  echo "$SID" > "state/sessions/<部署ID>.txt"\n'
        f'  AI_MIERUKA_AGENT=<部署ID> claude -p "<相談内容>" --session-id "$SID" '
        f'--permission-mode auto --output-format text\n'
        f"fi\n\n"
        f"このコマンドの標準出力が、その部署からの回答です。複数の部署に相談する場合は、\n"
        f"それぞれ個別にこの形式で実行してください(並行して構いません)。")


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


dialog_lock = threading.Lock()


def pick_directory(initial):
    """ネイティブのフォルダ選択ダイアログを開き、選ばれたパスを返す。

    キャンセルされたら None。ダイアログは別プロセス(dirpicker.py)で開く。
    """
    script = os.path.join(BASE_DIR, "dirpicker.py")
    start = initial if os.path.isdir(initial or "") else BASE_DIR
    cmd = [sys.executable, "-X", "utf8", script, start]

    # ダイアログは1つずつ。連打で何枚も開くと、どれがどれだか分からなくなる。
    with dialog_lock:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding="utf-8", timeout=600)

    if result.returncode != 0:
        detail = result.stderr.strip()[:300]
        raise RuntimeError(detail or f"ダイアログが異常終了しました (exit={result.returncode})")
    return result.stdout.strip() or None


def relative_to_base(path):
    """リポジトリ配下ならリポジトリからの相対パスにする。

    設定ファイルを別のマシンへ持っていっても壊れにくくするため。
    別ドライブなど相対にできない場合は絶対パスのまま返す。
    """
    abs_path = os.path.abspath(path)
    try:
        rel = os.path.relpath(abs_path, BASE_DIR)
    except ValueError:  # 別ドライブ同士は相対にできない
        rel = ".."
    return (abs_path if rel.startswith("..") else rel).replace("\\", "/")


# 状態を書き出したいイベント。matcher が要るものだけ第2要素に持たせる。
HOOK_EVENTS = [
    ("SessionStart", None), ("UserPromptSubmit", None),
    ("PreToolUse", "*"), ("PostToolUse", "*"),
    ("Stop", None), ("SubagentStart", None), ("SubagentStop", None),
]


def hook_settings():
    """フック定義を、いまの環境の絶対パスで組み立てる。

    ファイルに書き置くと環境固有の値がリポジトリに残る。インタプリタの名前
    （python か python3 か）も、リポジトリの置き場所も、動かす人によって違う。
    どちらも実行時にしか分からないので、その都度ここで作る。
    """
    script = os.path.join(BASE_DIR, "hooks", "update_state.py").replace("\\", "/")
    command = f'"{sys.executable}" "{script}"'

    hooks = {}
    for event, matcher in HOOK_EVENTS:
        entry = {"hooks": [{"type": "command", "command": command}]}
        if matcher:
            entry["matcher"] = matcher
        hooks[event] = [entry]
    return {"hooks": hooks}


def install_local_hooks():
    """このリポジトリで claude を動かしたときのために、フックを書き出す。

    .claude/settings.local.json は個人用の層で、Gitの追跡外。配布物には
    誰かのマシンのパスが混ざらず、手元では自動で正しい値になる。
    """
    path = os.path.join(BASE_DIR, ".claude", "settings.local.json")
    try:
        with open(path, encoding="utf-8") as f:
            current = json.load(f)
    except (OSError, ValueError):
        current = {}

    updated = {**current, **hook_settings()}
    if updated == current:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(updated, f, ensure_ascii=False, indent=2)
        f.write("\n")


def subagent_definitions():
    """.claude/agents/*.md を --agents に渡せるJSONに変換する。

    作業ディレクトリがこのリポジトリの外にあると、定義ファイルが読まれず
    部下を呼べなくなる。中身は同じものを、コマンドライン経由で持たせる。
    """
    agents = {}
    for entry in officeconfig.subagent_catalog():
        spec = {"description": entry["description"], "prompt": entry["body"]}
        tools = [t.strip() for t in (entry.get("tools") or "").split(",") if t.strip()]
        if tools:
            spec["tools"] = tools
        agents[entry["name"]] = spec
    return json.dumps(agents, ensure_ascii=False) if agents else ""


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

    cfg = officeconfig.load()
    agent = officeconfig.agent_map(cfg).get(agent_id)
    if not agent:
        raise ValueError(f"エージェント {agent_id} は設定に存在しません。")

    # 担当ワークスペースの1つ目で動かし、2つ目以降は --add-dir で触れるようにする。
    workdir, *extra_dirs = officeconfig.workspace_paths(cfg, agent)

    if os.path.exists(sess_path):
        with open(sess_path, encoding="utf-8") as f:
            session_id = f.read().strip()
        cmd = [claude_bin(), "-p", instruction, "--permission-mode", "auto",
               "--resume", session_id, "--output-format", "text"]
    else:
        session_id = str(uuid.uuid4())
        cmd = [claude_bin(), "-p", instruction, "--permission-mode", "auto",
               "--session-id", session_id, "--output-format", "text"]

    for extra in extra_dirs:
        cmd += ["--add-dir", extra]

    # 別のプロジェクトで働かせる場合、claude はその作業ディレクトリ側の
    # .claude/ を読むので、このリポジトリのフック定義もサブエージェント定義も
    # 視界に入らない。状態が一切書かれず、キャラクターが「待機中」のまま
    # 動かなくなるため、どちらも明示的に渡す。
    # 自分のリポジトリで動かすときは通常どおり読まれるので、二重登録を避けて何もしない。
    if os.path.abspath(workdir) != BASE_DIR:
        # 渡すのはフックだけにする。language のような好みの設定まで、
        # 相手のプロジェクトへ押し付ける筋合いはない。
        cmd += ["--settings", json.dumps(hook_settings(), ensure_ascii=False)]
        agents_json = subagent_definitions()
        if agents_json:
            cmd += ["--agents", agents_json]

    prompt = system_prompt_for(cfg, agent)
    if prompt:
        cmd += ["--append-system-prompt", prompt]

    result = subprocess.run(cmd, cwd=workdir, env=env, capture_output=True,
                             text=True, timeout=1800)

    if not os.path.exists(sess_path):
        with open(sess_path, "w", encoding="utf-8") as f:
            f.write(session_id)

    report = result.stdout.strip() or "(出力なし)"
    if result.returncode != 0:
        report = f"[エラー exit={result.returncode}] {result.stderr.strip()[:500]}\n{report}"
    patch_state(agent_id, last_report=report, last_report_at=time.time())


def next_agent_id(cfg):
    """空いている内部IDを1つ選ぶ。"""
    used = set(officeconfig.agent_ids(cfg))
    for char in "ABCEFGHIJKLNOQRTUVWXYZ":
        if char not in used:
            return char
    n = 1
    while f"A{n}" in used:
        n += 1
    return f"A{n}"


def adopt_session(payload):
    """ロビーで見つけたセッションを、社員として迎え入れる。

    セッションIDさえ分かれば --resume で会話を継続できる。オフィスが自分で
    起動したものである必要はないので、外で走っていたものを組織に組み込める。
    """
    session_id = str(payload.get("session") or "").strip()
    if not session_id:
        raise officeconfig.ConfigError("セッションIDがありません。")

    cfg = officeconfig.load()
    if session_id in managed_sessions():
        raise officeconfig.ConfigError("このセッションはすでに社員に割り当てられています。")

    workspace_key = resolve_adopt_workspace(cfg, payload)
    agent_id = next_agent_id(cfg)
    name = str(payload.get("name") or "").strip() or "引き継ぎ社員"

    cfg["agents"].append({
        "id": agent_id,
        "name": name,
        "dept": str(payload.get("dept") or "").strip() or "未所属",
        "role": str(payload.get("role") or "").strip() or "担当",
        "sprite": str(payload.get("sprite") or "").strip(),
        "soul": "",
        "workspaces": [workspace_key],
        "consults": [],
        "subagents": [],
    })

    validated = officeconfig.save(cfg)
    agent = officeconfig.agent_map(validated)[agent_id]

    # 人格は空のまま作る。設定画面から書ける入れ物だけ用意しておく。
    if not officeconfig.read_soul(agent["soul"]).strip():
        officeconfig.write_soul(agent["soul"], f"# SOUL: {name}\n\n## 人格\n\n\n## 話し方\n\n\n## クセ・キャラクター付け\n")

    os.makedirs(SESSION_DIR, exist_ok=True)
    with open(session_file(agent_id), "w", encoding="utf-8") as f:
        f.write(session_id)
    return {"agent": agent, "workspace": workspace_key, "config": validated}


def resolve_adopt_workspace(cfg, payload):
    """迎え入れ先のワークスペースを決める。無ければ作る。"""
    workspaces = cfg.setdefault("workspaces", {})
    requested = payload.get("workspace") or {}

    key = str(requested.get("key") or "").strip()
    if key:
        if key not in workspaces:
            raise officeconfig.ConfigError(f"ワークスペースが見つかりません: {key}")
        return key

    # セッションが開いているディレクトリを、そのまま新しいワークスペースにする。
    cwd = str(payload.get("cwd") or "").strip()
    if not cwd or not os.path.isdir(cwd):
        raise officeconfig.ConfigError(f"作業ディレクトリが見つかりません: {cwd}")

    path = relative_to_base(cwd)
    for existing, meta in workspaces.items():
        if meta.get("path") == path:
            return existing

    n = 1
    while f"workspace{n}" in workspaces:
        n += 1
    new_key = f"workspace{n}"
    workspaces[new_key] = {
        "name": str(requested.get("name") or "").strip() or os.path.basename(cwd) or new_key,
        "path": path,
    }
    return new_key


def managed_sessions():
    """このオフィスが動かしているセッションIDの一覧。"""
    ids = set()
    try:
        names = os.listdir(SESSION_DIR)
    except OSError:
        return ids
    for name in names:
        if not name.endswith(".txt"):
            continue
        try:
            with open(os.path.join(SESSION_DIR, name), encoding="utf-8") as f:
                ids.add(f.read().strip())
        except OSError:
            continue
    return ids


def guest_loop(interval=2.0):
    """管理外のClaude Codeセッションを見張って、来客として記録し続ける。

    フックはこのオフィスが起動したセッションしか知らせてくれない。手元の
    ターミナルで開いた claude は、どこにも映らないまま裏で動くことになる。
    """
    while True:
        try:
            guests = sessionscan.scan(exclude_sessions=managed_sessions())
            with state_lock(LOCK_PATH):
                store = load_state(STATE_PATH)
                if store.get("guests") != guests:
                    store["guests"] = guests
                    write_state(STATE_PATH, store)
        except Exception:
            # 見張りが落ちてもオフィス本体は動き続けてほしい。
            pass
        time.sleep(interval)


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


# ブラウザにキャッシュさせたくないビューアのファイル。画像は枚数が多いので
# 対象外にして、コードと設定だけ毎回取り直させる。
NO_CACHE_SUFFIXES = (".html", ".js", ".css", ".json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        # viewer/ を直接編集しながら使うツールなので、ブラウザが古い app.js を
        # 握っていると「直したはずの不具合がまだ出る」という追いにくい状態になる。
        path = self.path.split("?")[0]
        if path.endswith("/") or path.endswith(NO_CACHE_SUFFIXES):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    # ---- 共通のレスポンス -------------------------------------------------

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    # ---- GET --------------------------------------------------------------

    def do_GET(self):
        if self.path.split("?")[0] == "/api/office":
            self.handle_get_office()
            return
        super().do_GET()

    def handle_get_office(self):
        """設定画面が必要とするものを一度にまとめて返す。"""
        try:
            cfg = officeconfig.load()
        except Exception as e:
            self.send_json(500, {"error": f"設定を読み込めません: {e}"})
            return

        souls = {}
        for agent in cfg.get("agents", []):
            try:
                souls[agent["id"]] = officeconfig.read_soul(agent["soul"])
            except officeconfig.ConfigError:
                souls[agent["id"]] = ""

        self.send_json(200, {
            "config": cfg,
            "souls": souls,
            "sprites": officeconfig.available_sprites(),
            "subagent_catalog": officeconfig.subagent_catalog(),
            # 相対パス("."など)のままだと、ブラウザ側からは実際の場所が分からない。
            # ロビーのセッションと同じ場所かを比べるために解決済みの絶対パスも渡す。
            "workspace_paths": {key: officeconfig.workspace_path(cfg, key)
                                for key in (cfg.get("workspaces") or {})},
        })

    # ---- POST -------------------------------------------------------------

    def do_POST(self):
        route = {
            "/instruct": self.handle_instruct,
            "/api/office": self.handle_save_office,
            "/api/pick-directory": self.handle_pick_directory,
            "/api/adopt": self.handle_adopt,
        }.get(self.path)
        if not route:
            self.send_json(404, {"error": "not found"})
            return
        route()

    def handle_instruct(self):
        payload = self.read_json()
        instruction = str(payload.get("instruction") or "").strip()
        agent_id = str(payload.get("agent_id") or "").strip()

        try:
            valid = set(officeconfig.agent_ids(officeconfig.load()))
        except Exception as e:
            self.send_json(500, {"error": f"設定を読み込めません: {e}"})
            return

        if agent_id not in valid:
            self.send_json(400, {"error": f"宛先が不正です: {agent_id}"})
            return
        if not instruction:
            self.send_json(400, {"error": "指示が空です。"})
            return

        task_queue.put((agent_id, instruction))
        set_queue_len(agent_id, 1)
        self.send_json(202, {"status": "queued", "agent_id": agent_id})

    def handle_save_office(self):
        """設定と人格テキストをまとめて保存する。

        SOULを先に書いてから設定を保存する。設定の検証で弾かれた場合に、
        存在しないSOULファイルを指す設定が残るのを避けたいため。
        """
        payload = self.read_json()
        cfg = payload.get("config")
        souls = payload.get("souls") or {}
        subagents = payload.get("subagents")

        try:
            # サブエージェントを先に反映する。config の subagents は実在する
            # 定義ファイルだけを残す作りなので、順序が逆だと、この保存で
            # 新規追加した部下がその場で捨てられてしまう。
            if isinstance(subagents, dict):
                self.apply_subagents(subagents)

            validated = officeconfig.validate(cfg)
            for agent in validated["agents"]:
                if agent["id"] in souls:
                    officeconfig.write_soul(agent["soul"], str(souls[agent["id"]]))
            officeconfig.save(validated)
        except officeconfig.ConfigError as e:
            self.send_json(400, {"error": str(e)})
            return
        except Exception as e:
            self.send_json(500, {"error": f"保存に失敗しました: {e}"})
            return

        self.send_json(200, {
            "status": "saved",
            "config": validated,
            "subagent_catalog": officeconfig.subagent_catalog(),
        })

    def handle_pick_directory(self):
        payload = self.read_json()
        initial = str(payload.get("initial") or "").strip()
        if initial:
            initial = os.path.abspath(os.path.join(BASE_DIR, initial))

        try:
            path = pick_directory(initial)
        except subprocess.TimeoutExpired:
            self.send_json(408, {"error": "ダイアログが時間内に閉じられませんでした。"})
            return
        except Exception as e:
            self.send_json(500, {"error": f"フォルダ選択を開けませんでした: {e}"})
            return

        if not path:
            self.send_json(200, {"cancelled": True})
            return
        self.send_json(200, {"path": relative_to_base(path), "absolute": path})

    def handle_adopt(self):
        try:
            result = adopt_session(self.read_json())
        except officeconfig.ConfigError as e:
            self.send_json(400, {"error": str(e)})
            return
        except Exception as e:
            self.send_json(500, {"error": f"迎え入れに失敗しました: {e}"})
            return
        self.send_json(200, result)

    def apply_subagents(self, payload):
        """サブエージェント定義の追加・更新・削除をまとめて反映する。"""
        entries = payload.get("entries") or []

        # 名前がファイル名になるので、重複すると片方が黙って消える。
        seen = set()
        for entry in entries:
            name = str(entry.get("name") or "").strip()
            if name in seen:
                raise officeconfig.ConfigError(
                    f"サブエージェント名が重複しています: {name}")
            seen.add(name)

        for filename in payload.get("deleted") or []:
            officeconfig.delete_subagent(filename)
        for entry in entries:
            officeconfig.write_subagent(entry)

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


def watched_sources():
    """再起動の判断に使うファイル一式。

    server.py だけを見ていた頃は、officeconfig.py を直しても起動中の
    プロセスが古いモジュールを掴んだままで、「直したのに反映されない」
    という分かりにくい状態になっていた。同じ階層のPythonはまとめて見る。
    """
    return sorted(os.path.join(BASE_DIR, f) for f in os.listdir(BASE_DIR)
                  if f.endswith(".py"))


def watch_self_and_exit(httpd, interval=1.0):
    """自分たちのソースが編集されたら、ポートを解放して再起動要求コードで終了する。
    手動でkill/restartしなくても、次のブラウザからの指示から新しいコードが
    使われるようにするため。"""
    def snapshot():
        stamps = {}
        for path in watched_sources():
            try:
                stamps[path] = os.path.getmtime(path)
            except OSError:
                continue
        return stamps

    last = snapshot()
    while True:
        time.sleep(interval)
        if snapshot() != last:
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

    install_local_hooks()
    officeconfig.ensure_config()
    threading.Thread(target=worker_loop, daemon=True).start()
    threading.Thread(target=guest_loop, daemon=True).start()
    httpd = OfficeServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=watch_self_and_exit, args=(httpd,), daemon=True).start()
    print(f"AI見える化オフィス: http://localhost:{PORT}/viewer/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
