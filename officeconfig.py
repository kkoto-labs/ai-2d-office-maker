#!/usr/bin/env python3
"""config/office.json（オフィス構成の単一の真実源）の読み書きと検証。

以前はキャラクター定義が server.py・hooks/update_state.py・viewer/app.js の
3箇所に重複していた。ここに集約して、3者とも実行時にこのファイルを読む。

ブラウザの設定画面から書き込まれる値をそのままファイル名やコマンドに使うため、
検証はこのモジュールの責務として厳しめに行う。指示は --permission-mode auto で
実行されるので、パスの取り違えがそのまま被害になりうる。
"""
import json
import os
import re
import shutil

from statefile import state_lock, write_state

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config", "office.json")
# 配布する雛形。office.json は各自の設定なのでGitの追跡外にしてある。
CONFIG_TEMPLATE_PATH = os.path.join(BASE_DIR, "config", "office.example.json")
CONFIG_LOCK = CONFIG_PATH + ".lock"
SOULS_DIR = os.path.join(BASE_DIR, "souls")
PROMPTS_DIR = os.path.join(BASE_DIR, "prompts")
AGENTS_DIR = os.path.join(BASE_DIR, ".claude", "agents")
SPRITE_DIR = os.path.join(BASE_DIR, "viewer", "assets", "characters")

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
PROJECT_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MAX_NAME_LEN = 40
MAX_SOUL_BYTES = 64 * 1024
# どの部署にも属していない部下の置き場所。空文字だと画面上で見失うため。
UNASSIGNED_DEPT = "未所属"


class ConfigError(ValueError):
    """設定が不正なときに投げる。HTTP 400 として返す想定。"""


# --------------------------------------------------------------------------
# 読み込み
# --------------------------------------------------------------------------

def ensure_config():
    """初回起動時に、雛形から自分用の設定を起こす。"""
    if os.path.exists(CONFIG_PATH) or not os.path.exists(CONFIG_TEMPLATE_PATH):
        return
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    shutil.copyfile(CONFIG_TEMPLATE_PATH, CONFIG_PATH)


def load():
    ensure_config()
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return _migrate(json.load(f))


def _migrate(cfg):
    """古い形の設定を、いまの読み手が期待する形に揃えてから渡す。

    担当プロジェクトは project(単数・文字列)から projects(配列)へ移った。
    読み込んだ時点で均しておかないと、サーバー・フック・ビューアがそれぞれ
    別の形を想定することになり、存在しないフィールドを触って壊れる。
    """
    for agent in cfg.get("agents") or []:
        if "projects" not in agent:
            agent["projects"] = [agent["project"]] if agent.get("project") else []
        agent.pop("project", None)

    # 部下は画像だけを持つ subagent_sprites から、部署も持てる subagents へ移った。
    # 移行時の所属は、その部下を実際に使っている上司の部署から引き継ぐ。
    if "subagents" not in cfg and "subagent_sprites" in cfg:
        owner = {}
        for agent in cfg.get("agents") or []:
            for name in agent.get("subagents") or []:
                owner.setdefault(name, agent.get("dept", ""))
        cfg["subagents"] = {
            name: {"sprite": sprite, "dept": owner.get(name, UNASSIGNED_DEPT)}
            for name, sprite in (cfg.get("subagent_sprites") or {}).items()
        }
    cfg.pop("subagent_sprites", None)
    cfg.setdefault("subagents", {})

    # 部署は「エージェントが持つ文字列」から、親子関係を持てる設定項目になった。
    # 移行時の親は相談関係から起こす。ユイが各PMに相談できるなら、
    # 秘書室の下に各部署がぶら下がっていた、と読むのが実態に近い。
    if "departments" not in cfg:
        by_id = {a["id"]: a for a in cfg.get("agents") or []}
        parent = {}
        for agent in cfg.get("agents") or []:
            for target in agent.get("consults") or []:
                child = by_id.get(target, {}).get("dept")
                if child and child != agent.get("dept"):
                    parent.setdefault(child, agent.get("dept"))
        cfg["departments"] = {}
        for name in _collect_dept_names(cfg):
            cfg["departments"][name] = {"parent": parent.get(name)}
    return cfg


def _collect_dept_names(cfg):
    """実際に使われている部署名を、登場順のまま重複なく集める。"""
    names = []
    for agent in cfg.get("agents") or []:
        if agent.get("dept") and agent["dept"] not in names:
            names.append(agent["dept"])
    for meta in (cfg.get("subagents") or {}).values():
        if meta.get("dept") and meta["dept"] not in names:
            names.append(meta["dept"])
    return names


def agent_map(cfg):
    return {a["id"]: a for a in cfg.get("agents", [])}


def agent_ids(cfg):
    return [a["id"] for a in cfg.get("agents", [])]


def project_path(cfg, key):
    """プロジェクトキーを実際の作業ディレクトリ(絶対パス)に解決する。

    未知のキーやディレクトリが消えている場合はリポジトリ直下にフォールバックする。
    指示の実行先が意図せず別の場所になるより、既定に戻したほうが安全なため。
    """
    proj = (cfg.get("projects") or {}).get(key)
    if not proj:
        return BASE_DIR
    path = os.path.abspath(os.path.join(BASE_DIR, proj.get("path", ".")))
    return path if os.path.isdir(path) else BASE_DIR


def project_paths(cfg, agent):
    """エージェントが担当する全プロジェクトの実パスを返す。

    先頭が作業ディレクトリ(cwd)、2つ目以降は claude の --add-dir に渡す
    「アクセスを許す追加ディレクトリ」になる。
    """
    keys = agent.get("projects") or []
    paths = []
    for key in keys:
        path = project_path(cfg, key)
        if path not in paths:
            paths.append(path)
    return paths or [BASE_DIR]


# --------------------------------------------------------------------------
# 選択肢（設定画面に出す候補）
# --------------------------------------------------------------------------

def available_sprites():
    """キャラクター画像の候補。

    pipo-shadow*.png は影の素材でキャラクターではないので、選択肢からは外す。
    """
    try:
        return sorted(f for f in os.listdir(SPRITE_DIR)
                      if f.lower().endswith(".png") and not f.startswith("pipo-shadow"))
    except OSError:
        return []


# --------------------------------------------------------------------------
# サブエージェント（.claude/agents/*.md）
# --------------------------------------------------------------------------

def safe_agent_filename(name):
    """サブエージェント定義のファイル名として安全な文字列に整える。"""
    name = (name or "").strip()
    if not name.endswith(".md"):
        name += ".md"
    if not name or name != os.path.basename(name) or name.startswith("."):
        raise ConfigError(f"サブエージェント名が不正です: {name!r}")
    if os.path.splitdrive(name)[0] or any(c in name for c in '\\/:*?"<>|'):
        raise ConfigError(f"サブエージェント名が不正です: {name!r}")
    return name


def subagent_catalog():
    """.claude/agents/*.md を読み、部下として選べる一覧を作る。

    サブエージェントの実体は Claude Code 標準の定義ファイルなので、説明文を
    config 側に写して二重管理にはしない。ここで実物から読み出す。
    設定画面での編集にも使うので、本文まで含めて返す。
    """
    catalog = []
    try:
        names = sorted(os.listdir(AGENTS_DIR))
    except OSError:
        return catalog

    for filename in names:
        if not filename.endswith(".md"):
            continue
        try:
            with open(os.path.join(AGENTS_DIR, filename), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue

        meta, body = _split_frontmatter(text)
        catalog.append({
            "name": meta.get("name") or filename[:-3],
            "file": filename,
            "description": meta.get("description", ""),
            "tools": meta.get("tools", ""),
            "body": body,
        })
    return catalog


def write_subagent(entry):
    """サブエージェント定義を .claude/agents/<名前>.md に書き出す。

    ファイル名は常に名前から決め直し、改名したら古いファイルを消す。
    残しておくと、中身が同じ定義が2つ並んで、どちらが生きているのか
    ファイル一覧から判断できなくなるため。
    """
    name = _clean_text(entry.get("name"), "サブエージェント名")
    filename = safe_agent_filename(name)
    previous = str(entry.get("file") or "").strip()
    description = str(entry.get("description") or "").strip().replace("\n", " ")
    tools = str(entry.get("tools") or "").strip().replace("\n", " ")
    body = str(entry.get("body") or "")

    if len(body.encode("utf-8")) > MAX_SOUL_BYTES:
        raise ConfigError(f"{name} の本文が大きすぎます。")

    lines = ["---", f"name: {name}", f"description: {description}"]
    if tools:
        lines.append(f"tools: {tools}")
    lines += ["---", "", body.strip(), ""]

    os.makedirs(AGENTS_DIR, exist_ok=True)
    with open(os.path.join(AGENTS_DIR, filename), "w",
              encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))

    if previous and previous != filename:
        delete_subagent(previous)
    return filename


def delete_subagent(filename):
    path = os.path.join(AGENTS_DIR, safe_agent_filename(filename))
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _split_frontmatter(text):
    """frontmatter の辞書と、それ以降の本文に分ける。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text

    meta = {}
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[i + 1:]).strip()
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return meta, ""


# --------------------------------------------------------------------------
# SOUL（人格テキスト）
# --------------------------------------------------------------------------

def safe_soul_filename(name):
    """SOULファイル名として安全な文字列に整える。

    設定画面から来た文字列をそのまま souls/ 配下のパスに連結すると、
    "../../" のような値でリポジトリ外を読み書きできてしまう。
    ディレクトリ区切りを含むものは、その時点で拒否する。
    """
    name = (name or "").strip()
    if not name.endswith(".md"):
        name += ".md"
    if not name or name != os.path.basename(name) or name.startswith("."):
        raise ConfigError(f"SOULファイル名が不正です: {name!r}")
    if os.path.splitdrive(name)[0] or any(c in name for c in '\\/:*?"<>|'):
        raise ConfigError(f"SOULファイル名が不正です: {name!r}")
    return name


def read_soul(filename):
    path = os.path.join(SOULS_DIR, safe_soul_filename(filename))
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def write_soul(filename, text):
    if len(text.encode("utf-8")) > MAX_SOUL_BYTES:
        raise ConfigError("人格テキストが大きすぎます。")
    os.makedirs(SOULS_DIR, exist_ok=True)
    path = os.path.join(SOULS_DIR, safe_soul_filename(filename))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# --------------------------------------------------------------------------
# 検証と保存
# --------------------------------------------------------------------------

def validate(cfg):
    """設定全体を検証し、正規化したものを返す。不正なら ConfigError。"""
    if not isinstance(cfg, dict):
        raise ConfigError("設定の形式が不正です。")

    projects = _validate_projects(cfg.get("projects"))
    sprites = set(available_sprites())
    known_subagents = {s["name"] for s in subagent_catalog()}

    raw_agents = cfg.get("agents")
    if not isinstance(raw_agents, list) or not raw_agents:
        raise ConfigError("エージェントが1人もいません。")

    agents = []
    seen_ids = set()
    for raw in raw_agents:
        agents.append(_validate_agent(raw, projects, sprites, known_subagents, seen_ids))

    # consults は「実在するエージェント」だけを指せる。自分自身は指せない。
    valid_ids = {a["id"] for a in agents}
    for agent in agents:
        agent["consults"] = [c for c in agent["consults"]
                             if c in valid_ids and c != agent["id"]]

    subagents = _validate_subagent_meta(cfg.get("subagents"), sprites, known_subagents)
    result = {
        "departments": {},
        "projects": projects,
        "agents": agents,
        "subagents": subagents,
    }
    result["departments"] = _validate_departments(cfg.get("departments"), result)
    return result


def _validate_departments(raw, cfg):
    """部署とその親子関係。使われている部署は必ず存在させる。

    エージェントの所属先が部署一覧から抜けていると、設定画面で選べない
    部署に取り残されてしまうため、実在する所属は自動で補う。
    """
    raw = raw if isinstance(raw, dict) else {}
    depts = {}
    for name in _collect_dept_names(cfg):
        entry = raw.get(name) if isinstance(raw.get(name), dict) else {}
        depts[_clean_text(name, "部署名")] = {"parent": entry.get("parent")}

    # 使われていない部署も、空のまま残しておけるようにする。
    for name, entry in raw.items():
        if name not in depts:
            depts[_clean_text(name, "部署名")] = {
                "parent": (entry or {}).get("parent")}

    for name, entry in depts.items():
        parent = entry.get("parent")
        if parent not in depts or parent == name:
            entry["parent"] = None

    # 循環していると図が描けない。たどって自分に戻る枝は根に付け替える。
    for name in depts:
        seen = {name}
        cursor = depts[name]["parent"]
        while cursor:
            if cursor in seen:
                depts[name]["parent"] = None
                break
            seen.add(cursor)
            cursor = depts[cursor]["parent"]
    return depts


def _validate_projects(raw):
    if not isinstance(raw, dict) or not raw:
        raise ConfigError("プロジェクトが1つも定義されていません。")
    projects = {}
    for key, value in raw.items():
        if not PROJECT_KEY_RE.match(str(key)):
            raise ConfigError(f"プロジェクトIDが不正です: {key!r}")
        if not isinstance(value, dict):
            raise ConfigError(f"プロジェクト定義が不正です: {key!r}")
        path = str(value.get("path", ".")).strip() or "."
        resolved = os.path.abspath(os.path.join(BASE_DIR, path))
        if not os.path.isdir(resolved):
            raise ConfigError(
                f"プロジェクト「{value.get('name', key)}」の作業ディレクトリが"
                f"見つかりません: {resolved}")
        projects[key] = {
            "name": _clean_text(value.get("name") or key, "プロジェクト名"),
            "path": path,
        }
    return projects


def _validate_agent(raw, projects, sprites, known_subagents, seen_ids):
    if not isinstance(raw, dict):
        raise ConfigError("エージェント定義が不正です。")

    agent_id = str(raw.get("id", "")).strip()
    if not ID_RE.match(agent_id):
        raise ConfigError(
            f"エージェントIDが不正です: {agent_id!r}（英数字・ハイフン・アンダースコア1〜16文字）")
    if agent_id in seen_ids:
        raise ConfigError(f"エージェントIDが重複しています: {agent_id}")
    seen_ids.add(agent_id)

    sprite = str(raw.get("sprite", "")).strip()
    if sprite not in sprites:
        raise ConfigError(f"キャラクター画像が見つかりません: {sprite!r}")

    name = _clean_text(raw.get("name"), "名前")
    return {
        "id": agent_id,
        "name": name,
        "dept": _clean_text(raw.get("dept"), "部署名"),
        "role": _clean_text(raw.get("role"), "役職"),
        "sprite": sprite,
        "soul": safe_soul_filename(raw.get("soul") or name),
        "projects": _validate_agent_projects(raw, projects, name),
        "consults": [str(c).strip() for c in (raw.get("consults") or [])],
        "subagents": [s for s in (raw.get("subagents") or []) if s in known_subagents],
    }


def _validate_agent_projects(raw, projects, name):
    """担当プロジェクトを検証する。先頭が作業ディレクトリになる。

    以前は project(単数・文字列)だったので、古い設定も読めるようにしておく。
    """
    keys = raw.get("projects")
    if keys is None and raw.get("project"):
        keys = [raw["project"]]
    keys = [str(k).strip() for k in (keys or [])]

    # 重複は落とす。--add-dir に同じパスを二重に渡す意味がないため。
    seen, cleaned = set(), []
    for key in keys:
        if key in seen:
            continue
        if key not in projects:
            raise ConfigError(f"プロジェクトが見つかりません: {key!r}")
        seen.add(key)
        cleaned.append(key)

    if not cleaned:
        raise ConfigError(f"{name} にプロジェクトが割り当てられていません。")
    return cleaned


def _validate_subagent_meta(raw, sprites, known_subagents):
    """部下ごとの見た目と所属部署。定義ファイルが実在するものだけ残す。"""
    if not isinstance(raw, dict):
        return {}
    meta = {}
    for name, value in raw.items():
        if name not in known_subagents or not isinstance(value, dict):
            continue
        sprite = value.get("sprite")
        meta[str(name)] = {
            "sprite": sprite if sprite in sprites else "",
            "dept": _clean_text(value.get("dept") or UNASSIGNED_DEPT, "部署名"),
        }
    return meta


def _clean_text(value, label):
    text = str(value or "").strip()
    if not text:
        raise ConfigError(f"{label}が空です。")
    if len(text) > MAX_NAME_LEN:
        raise ConfigError(f"{label}が長すぎます（{MAX_NAME_LEN}文字まで）。")
    # 制御文字は表示にもプロンプトにも混ぜたくない。
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in text):
        raise ConfigError(f"{label}に使用できない文字が含まれています。")
    return text


def save(cfg):
    """検証してから config/office.json をアトミックに書き換える。"""
    validated = validate(cfg)
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with state_lock(CONFIG_LOCK):
        write_state(CONFIG_PATH, validated)
    return validated
