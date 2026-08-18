const POLL_MS = 1000;
const STALE_MS = 90 * 1000;
const REPORT_DECAY_MS = 4000;
const PROJECTS_KEY = "__projects__";
const SUBAGENTS_KEY = "__subagents__";

const STATE_LABEL = {
  idle: "待機中",
  thinking: "検討中",
  working: "作業中",
  reporting: "報告中",
};

const SUBAGENT_SPRITE_DEFAULT = "pipo-charachip001b.png";

// オフィスの構成は config/office.json が真実源で、サーバーの /api/office 経由で
// 受け取る。以前はこのファイルにキャラ定義をベタ書きしていたため、設定を変える
// たびに server.py・hooks・ここの3箇所を直す必要があった。
let AGENTS = [];
let SUBAGENT_SPRITE = {};

let office = null;
let draft = null;
let draftSouls = {};
let draftSubagents = [];
let deletedSubagentFiles = [];
let selectedKey = null;
let selectedSubagent = 0;

const lastRenderedLogKey = {};
const lastRenderedSubagentKey = {};
let lastRenderedReportAt = null;

// --------------------------------------------------------------------------
// オフィスの読み込みと描画
// --------------------------------------------------------------------------

async function loadOffice() {
  const res = await fetch(`/api/office?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`設定の取得に失敗しました (${res.status})`);
  office = await res.json();
  AGENTS = office.config.agents;
  SUBAGENT_SPRITE = office.config.subagent_sprites || {};
  buildRooms();
}

function buildRooms() {
  const roomsEl = document.getElementById("rooms");
  const targetSelect = document.getElementById("instruct-target");
  const previousTarget = targetSelect.value;

  // エージェントは設定画面で増減するので、毎回まっさらに組み直す。
  roomsEl.innerHTML = "";
  targetSelect.innerHTML = "";
  for (const key of Object.keys(lastRenderedSubagentKey)) delete lastRenderedSubagentKey[key];

  for (const agent of AGENTS) {
    const room = document.createElement("section");
    room.className = "room";
    room.dataset.dept = agent.dept;
    room.innerHTML = `
      <div class="room-label">${escapeHtml(agent.dept)}</div>
      <div class="desk">
        <div class="monitor"><div class="monitor-screen"></div></div>
        <div class="character" id="char-${agent.id}">
          <div class="speech-bubble" id="bubble-${agent.id}"></div>
          <div class="thinking-dots" id="dots-${agent.id}"><span></span><span></span><span></span></div>
          <div class="shadow"></div>
          <div class="sprite" id="sprite-${agent.id}"></div>
          <div class="nameplate">
            <span class="nameplate-name">${escapeHtml(agent.name)}</span>
            <span class="nameplate-role">${escapeHtml(agent.role)}</span>
          </div>
        </div>
      </div>
      <div class="status-badge" id="status-${agent.id}">
        <span class="status-dot"></span>
        <span class="status-text">読み込み中...</span>
      </div>
      <div class="subagents" id="subagents-${agent.id}"></div>
    `;
    roomsEl.appendChild(room);
    document.getElementById(`sprite-${agent.id}`).style.backgroundImage =
      `url("assets/characters/${agent.sprite}")`;

    const opt = document.createElement("option");
    opt.value = agent.id;
    opt.textContent = `${agent.dept} - ${agent.name}`;
    targetSelect.appendChild(opt);
  }

  if (AGENTS.some((a) => a.id === previousTarget)) targetSelect.value = previousTarget;
  document.getElementById("topbar-sub").textContent =
    AGENTS.map((a) => a.dept).join("・");
}

async function poll() {
  try {
    const res = await fetch(`../state/agents.json?t=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    render(data.agents || {});
  } catch (e) {
    // state file not available yet; keep last rendered view
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function render(agentsData) {
  const mergedLog = [];
  let latestReport = null;

  for (const agent of AGENTS) {
    const data = agentsData[agent.id];
    if (!data) continue;
    renderAgent(agent, data);

    for (const item of data.log || []) {
      mergedLog.push({ ...item, name: agent.name, agentId: agent.id });
    }
    if (data.last_report && (!latestReport || data.last_report_at > latestReport.at)) {
      latestReport = { name: agent.name, dept: agent.dept, text: data.last_report, at: data.last_report_at };
    }
  }

  mergedLog.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  renderLog(mergedLog);
  if (latestReport) renderReport(latestReport);
}

function renderAgent(agent, data) {
  const ageMs = Date.now() - data.updated_at * 1000;
  let state = data.state || "idle";
  let detail = data.detail || "";

  if (state !== "idle" && ageMs > STALE_MS) {
    state = "idle";
    detail = "応答待ち";
  }
  if (state === "reporting" && ageMs > REPORT_DECAY_MS) {
    state = "idle";
    detail = "待機中";
  }

  const charEl = document.getElementById(`char-${agent.id}`);
  const bubbleEl = document.getElementById(`bubble-${agent.id}`);
  const statusEl = document.getElementById(`status-${agent.id}`);
  if (!charEl) return;

  charEl.className = `character ${state}`;

  bubbleEl.textContent = detail;
  bubbleEl.classList.toggle("show", state === "working" || state === "reporting");

  statusEl.className = `status-badge ${state}`;
  let statusText = STATE_LABEL[state] || state;
  if (data.queue_len > 0) statusText += ` (待ち${data.queue_len}件)`;
  statusEl.querySelector(".status-text").textContent = statusText;

  renderSubagents(agent.id, data.active_subagents || []);
}

function renderSubagents(agentId, activeSubagents) {
  const container = document.getElementById(`subagents-${agentId}`);
  if (!container) return;

  // Only touch the DOM when the set of active subagents actually changes.
  // Rebuilding on every poll tick would restart each badge's CSS animation,
  // producing a flicker instead of a smooth pulse.
  const key = activeSubagents.map((s) => s.id).sort().join(",");
  if (lastRenderedSubagentKey[agentId] === key) return;
  lastRenderedSubagentKey[agentId] = key;

  container.innerHTML = "";
  for (const sub of activeSubagents) {
    const sprite = SUBAGENT_SPRITE[sub.type] || SUBAGENT_SPRITE_DEFAULT;
    const el = document.createElement("div");
    el.className = "subagent-character";
    el.innerHTML = `
      <div class="subagent-sprite" style="background-image: url('assets/characters/${sprite}')"></div>
      <div class="subagent-label">${escapeHtml(sub.type)}</div>
    `;
    container.appendChild(el);
  }
}

function renderReport(report) {
  if (lastRenderedReportAt === report.at) return;
  lastRenderedReportAt = report.at;
  document.getElementById("report-title").textContent = `${report.name}（${report.dept}）からの回答`;
  document.getElementById("report-text").innerHTML = renderMarkdown(report.text);
}

function renderInline(str) {
  return str
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, "<em>$1</em>");
}

function renderMarkdown(raw) {
  const lines = escapeHtml(raw).split("\n");
  let html = "";
  let listType = null;

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      closeList();
      continue;
    }
    const numMatch = line.match(/^\d+\.\s+(.*)$/);
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);

    if (headingMatch) {
      closeList();
      const level = Math.min(headingMatch[1].length + 3, 6);
      html += `<h${level}>${renderInline(headingMatch[2])}</h${level}>`;
    } else if (numMatch) {
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${renderInline(numMatch[1])}</li>`;
    } else if (bulletMatch) {
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${renderInline(bulletMatch[1])}</li>`;
    } else {
      closeList();
      html += `<p>${renderInline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function renderLog(mergedLog) {
  if (!mergedLog.length) return;
  const latest = mergedLog[mergedLog.length - 1];
  const key = latest.time + latest.agentId + latest.detail;
  if (lastRenderedLogKey.key === key) return;
  lastRenderedLogKey.key = key;

  const latestEl = document.getElementById("log-latest");
  latestEl.innerHTML = `<span class="log-time">${latest.time}</span><span class="log-dept">[${escapeHtml(latest.name)}]</span><span class="log-detail">${escapeHtml(latest.detail)}</span>`;

  const listEl = document.getElementById("log-list");
  listEl.innerHTML = "";
  for (let i = mergedLog.length - 1; i >= 0; i--) {
    const item = mergedLog[i];
    const li = document.createElement("li");
    li.innerHTML = `<span class="log-time">${item.time}</span><span class="log-dept">[${escapeHtml(item.name)}]</span><span class="log-detail">${escapeHtml(item.detail)}</span>`;
    listEl.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// --------------------------------------------------------------------------
// 設定画面
// --------------------------------------------------------------------------

function openSettings() {
  // 編集は必ず複製に対して行う。保存せず閉じたときに画面の表示が
  // 変わってしまわないようにするため。
  draft = JSON.parse(JSON.stringify(office.config));
  draftSouls = { ...office.souls };
  draftSubagents = office.subagent_catalog.map((s) => ({
    ...s,
    sprite: draft.subagent_sprites[s.name] || SUBAGENT_SPRITE_DEFAULT,
  }));
  deletedSubagentFiles = [];
  selectedSubagent = 0;
  selectedKey = draft.agents.length ? draft.agents[0].id : PROJECTS_KEY;
  setSettingsStatus("");
  document.getElementById("settings-modal").hidden = false;
  renderSettings();
}

function closeSettings() {
  document.getElementById("settings-modal").hidden = true;
  closeSpritePicker();
  draft = null;
}

function setSettingsStatus(text, isError) {
  const el = document.getElementById("settings-status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

function renderSettings() {
  renderSettingsNav();
  renderSettingsEditor();
}

function renderSettingsNav() {
  const list = document.getElementById("settings-nav-list");
  list.innerHTML = "";

  for (const agent of draft.agents) {
    const li = document.createElement("li");
    li.className = `nav-item${agent.id === selectedKey ? " active" : ""}`;
    li.innerHTML = `
      <div class="nav-sprite" style="background-image: url('assets/characters/${agent.sprite}')"></div>
      <div class="nav-text">
        <span class="nav-name" data-nav-name="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</span>
        <span class="nav-dept" data-nav-dept="${escapeHtml(agent.id)}">${escapeHtml(agent.dept)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      selectedKey = agent.id;
      renderSettings();
    });
    list.appendChild(li);
  }

  for (const [key, label, sub] of [
    [SUBAGENTS_KEY, "👥 サブエージェント", "部下の追加・編集"],
    [PROJECTS_KEY, "📁 プロジェクト", "作業ディレクトリの管理"],
  ]) {
    const li = document.createElement("li");
    li.className = `nav-item nav-meta${selectedKey === key ? " active" : ""}`;
    li.innerHTML = `<div class="nav-text"><span class="nav-name">${label}</span>
      <span class="nav-dept">${sub}</span></div>`;
    li.addEventListener("click", () => {
      selectedKey = key;
      renderSettings();
    });
    list.appendChild(li);
  }
}

function renderSettingsEditor() {
  const el = document.getElementById("settings-editor");
  if (selectedKey === PROJECTS_KEY) {
    renderProjectsEditor(el);
    return;
  }
  if (selectedKey === SUBAGENTS_KEY) {
    renderSubagentEditor(el);
    return;
  }
  const agent = draft.agents.find((a) => a.id === selectedKey);
  if (!agent) {
    el.innerHTML = "";
    return;
  }
  renderAgentEditor(el, agent);
}

function renderAgentEditor(el, agent) {
  const primary = agent.projects[0];
  const projectOptions = Object.entries(draft.projects)
    .map(([key, p]) => `<option value="${escapeHtml(key)}"${key === primary ? " selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");

  const extraProjects = Object.entries(draft.projects)
    .filter(([key]) => key !== primary)
    .map(([key, p]) => `<label class="check-row">
      <input type="checkbox" data-extra-project="${escapeHtml(key)}"${agent.projects.includes(key) ? " checked" : ""} />
      <span class="check-name">${escapeHtml(p.name)}</span>
      <span class="check-desc">${escapeHtml(p.path)}</span>
    </label>`)
    .join("") || '<p class="hint">他に登録されたプロジェクトがありません。</p>';

  // 候補は保存前の下書きから引く。追加したばかりの部下も、保存を待たずに
  // ここへ割り当てられるようにするため。
  const subagentChoices = draftSubagents
    .map((s) => `<label class="check-row">
      <input type="checkbox" data-subagent="${escapeHtml(s.name)}"${agent.subagents.includes(s.name) ? " checked" : ""} />
      <span class="check-name">${escapeHtml(s.name)}</span>
      <span class="check-desc">${escapeHtml(s.description)}</span>
    </label>`)
    .join("") || '<p class="hint">サブエージェントがまだいません。左の「👥 サブエージェント」から追加できます。</p>';

  const consultChoices = draft.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => `<label class="check-row">
      <input type="checkbox" data-consult="${escapeHtml(a.id)}"${agent.consults.includes(a.id) ? " checked" : ""} />
      <span class="check-name">${escapeHtml(a.name)}</span>
      <span class="check-desc">${escapeHtml(a.dept)}</span>
    </label>`)
    .join("") || '<p class="hint">他のエージェントがいません。</p>';

  el.innerHTML = `
    <section class="edit-section">
      <h3>個人設定</h3>
      <div class="field-grid">
        <label class="field"><span>名前</span>
          <input type="text" data-field="name" value="${escapeHtml(agent.name)}" maxlength="40" /></label>
        <label class="field"><span>部署</span>
          <input type="text" data-field="dept" value="${escapeHtml(agent.dept)}" maxlength="40" /></label>
        <label class="field"><span>役職</span>
          <input type="text" data-field="role" value="${escapeHtml(agent.role)}" maxlength="40" /></label>
        <label class="field"><span>内部ID</span>
          <input type="text" value="${escapeHtml(agent.id)}" disabled />
          <small class="hint">セッションの保存先に使うため、作成後は変更できません。</small></label>
      </div>
    </section>

    <section class="edit-section">
      <h3>キャラクター画像</h3>
      ${spritePreview(agent.sprite)}
    </section>

    <section class="edit-section">
      <h3>プロジェクト</h3>
      <label class="field"><span>作業ディレクトリ（主）</span>
        <select data-primary-project>${projectOptions}</select>
        <small class="hint">このエージェントへの指示は、ここで選んだディレクトリで実行されます。</small></label>
      <h4>追加でアクセスできるプロジェクト</h4>
      <div class="check-list">${extraProjects}</div>
      <small class="hint">チェックしたディレクトリは <code>--add-dir</code> で渡され、
      作業ディレクトリを離れずに読み書きできます。</small>
    </section>

    <section class="edit-section">
      <h3>関係性</h3>
      <h4>部下（サブエージェント）</h4>
      <div class="check-list">${subagentChoices}</div>
      <h4>相談できる相手</h4>
      <div class="check-list">${consultChoices}</div>
      <small class="hint">ここで選んだ内容は、指示のたびにプロンプトへ自動で反映されます。</small>
    </section>

    <section class="edit-section">
      <h3>人格（SOUL）</h3>
      <textarea class="soul-input" data-soul rows="14"
        placeholder="人格・話し方・クセを書きます。">${escapeHtml(draftSouls[agent.id] || "")}</textarea>
      <small class="hint">保存先: souls/${escapeHtml(agent.soul || `${agent.name}.md`)}</small>
    </section>

    <section class="edit-section">
      <button type="button" class="btn-danger" id="agent-delete">このエージェントを削除</button>
    </section>
  `;

  wireAgentEditor(el, agent);
}

function wireAgentEditor(el, agent) {
  for (const input of el.querySelectorAll("[data-field]")) {
    input.addEventListener("input", () => {
      agent[input.dataset.field] = input.value;
      // 名前と部署は左のリストにも出ている。編集中にフォーム全体を組み直すと
      // 入力欄からフォーカスが外れてしまうので、該当箇所だけ書き換える。
      const navName = document.querySelector(`[data-nav-name="${agent.id}"]`);
      const navDept = document.querySelector(`[data-nav-dept="${agent.id}"]`);
      if (navName) navName.textContent = agent.name;
      if (navDept) navDept.textContent = agent.dept;
    });
  }

  wireSpritePreview(el, agent.sprite, (sprite) => {
    agent.sprite = sprite;
    renderSettings();
  });

  el.querySelector("[data-primary-project]").addEventListener("change", (e) => {
    // 主プロジェクトは常に配列の先頭。付け替えたら、元の主は追加側に残す。
    const others = agent.projects.filter((p) => p !== e.target.value);
    agent.projects = [e.target.value, ...others];
    renderSettingsEditor();
  });

  for (const box of el.querySelectorAll("[data-extra-project]")) {
    box.addEventListener("change", () => {
      agent.projects = toggleIn(agent.projects, box.dataset.extraProject, box.checked);
      // 先頭＝主プロジェクトの位置関係は崩さない。
      const primaryKey = el.querySelector("[data-primary-project]").value;
      agent.projects = [primaryKey, ...agent.projects.filter((p) => p !== primaryKey)];
    });
  }

  for (const box of el.querySelectorAll("[data-subagent]")) {
    box.addEventListener("change", () => {
      agent.subagents = toggleIn(agent.subagents, box.dataset.subagent, box.checked);
    });
  }

  for (const box of el.querySelectorAll("[data-consult]")) {
    box.addEventListener("change", () => {
      agent.consults = toggleIn(agent.consults, box.dataset.consult, box.checked);
    });
  }

  const soul = el.querySelector("[data-soul]");
  if (soul) soul.addEventListener("input", () => { draftSouls[agent.id] = soul.value; });

  el.querySelector("#agent-delete").addEventListener("click", () => deleteAgent(agent));
}

function toggleIn(list, value, on) {
  const next = list.filter((v) => v !== value);
  if (on) next.push(value);
  return next;
}

// ---- キャラクター画像ピッカー（候補が多いので別モーダルに出す） -------------

function spritePreview(sprite) {
  return `<div class="sprite-preview">
    <div class="sprite-choice large" style="background-image: url('assets/characters/${escapeHtml(sprite)}')"></div>
    <div class="sprite-preview-meta">
      <code>${escapeHtml(sprite)}</code>
      <button type="button" class="btn-ghost btn-small" data-sprite-open>変更（${office.sprites.length}種から選ぶ）</button>
    </div>
  </div>`;
}

function wireSpritePreview(el, current, onPick) {
  const button = el.querySelector("[data-sprite-open]");
  if (button) button.addEventListener("click", () => openSpritePicker(current, onPick));
}

function openSpritePicker(current, onPick) {
  const grid = document.getElementById("sprite-grid");
  grid.innerHTML = office.sprites.map((s) => `
    <button type="button" class="sprite-choice${s === current ? " selected" : ""}"
      data-sprite="${escapeHtml(s)}" title="${escapeHtml(s)}"
      style="background-image: url('assets/characters/${s}')"></button>`).join("");

  for (const button of grid.querySelectorAll(".sprite-choice")) {
    button.addEventListener("click", () => {
      closeSpritePicker();
      onPick(button.dataset.sprite);
    });
  }
  document.getElementById("sprite-modal").hidden = false;
  const selected = grid.querySelector(".sprite-choice.selected");
  if (selected) selected.scrollIntoView({ block: "center" });
}

function closeSpritePicker() {
  document.getElementById("sprite-modal").hidden = true;
}

// ---- サブエージェント -------------------------------------------------------

function renderSubagentEditor(el) {
  if (!draftSubagents.length) {
    el.innerHTML = `<section class="edit-section">
      <h3>サブエージェント</h3>
      <p class="hint">まだ部下がいません。</p>
      <button type="button" class="btn-ghost" id="subagent-add">＋ サブエージェントを追加</button>
    </section>`;
    el.querySelector("#subagent-add").addEventListener("click", addSubagent);
    return;
  }

  selectedSubagent = Math.min(selectedSubagent, draftSubagents.length - 1);
  const sub = draftSubagents[selectedSubagent];

  const chips = draftSubagents.map((s, i) => `
    <button type="button" class="chip${i === selectedSubagent ? " active" : ""}" data-subagent-index="${i}">
      <span class="chip-sprite" style="background-image: url('assets/characters/${escapeHtml(s.sprite)}')"></span>
      ${escapeHtml(s.name)}
    </button>`).join("");

  el.innerHTML = `
    <section class="edit-section">
      <h3>サブエージェント</h3>
      <div class="chip-row">${chips}
        <button type="button" class="chip chip-add" id="subagent-add">＋ 追加</button>
      </div>
      <p class="hint">実体は <code>.claude/agents/*.md</code>（Claude Code標準のサブエージェント定義）です。</p>
    </section>

    <section class="edit-section">
      <div class="field-grid">
        <label class="field"><span>名前</span>
          <input type="text" data-sub-field="name" value="${escapeHtml(sub.name)}" maxlength="40" /></label>
        <label class="field"><span>使えるツール</span>
          <input type="text" data-sub-field="tools" value="${escapeHtml(sub.tools)}"
            placeholder="Read, Grep, Glob, Edit, Write, Bash" />
          <small class="hint">空にすると全ツールを継承します。</small></label>
      </div>
      <label class="field"><span>説明（どんなときに呼ぶか）</span>
        <textarea class="soul-input" data-sub-field="description" rows="3"
          placeholder="この部下をいつ使うべきかを書きます。上司がこの文章を見て呼び出しを判断します。">${escapeHtml(sub.description)}</textarea></label>
    </section>

    <section class="edit-section">
      <h3>キャラクター画像</h3>
      ${spritePreview(sub.sprite)}
    </section>

    <section class="edit-section">
      <h3>人格・仕事内容</h3>
      <textarea class="soul-input" data-sub-field="body" rows="14"
        placeholder="## 人格&#10;&#10;## 仕事">${escapeHtml(sub.body)}</textarea>
    </section>

    <section class="edit-section">
      <button type="button" class="btn-danger" id="subagent-delete">この部下を削除</button>
    </section>
  `;

  for (const button of el.querySelectorAll("[data-subagent-index]")) {
    button.addEventListener("click", () => {
      selectedSubagent = Number(button.dataset.subagentIndex);
      renderSettingsEditor();
    });
  }
  el.querySelector("#subagent-add").addEventListener("click", addSubagent);
  el.querySelector("#subagent-delete").addEventListener("click", () => deleteSubagent(sub));

  for (const input of el.querySelectorAll("[data-sub-field]")) {
    input.addEventListener("input", () => {
      const field = input.dataset.subField;
      if (field === "name") {
        renameSubagent(sub, input.value);
        const chip = el.querySelector(`[data-subagent-index="${selectedSubagent}"]`);
        if (chip) chip.lastChild.textContent = ` ${input.value}`;
        return;
      }
      sub[field] = input.value;
    });
  }

  wireSpritePreview(el, sub.sprite, (sprite) => {
    sub.sprite = sprite;
    renderSettingsEditor();
  });
}

function renameSubagent(sub, nextName) {
  // 上司側の「部下」リストは名前で参照している。改名したら追随させないと
  // 保存時に存在しない部下として捨てられてしまう。
  const before = sub.name;
  sub.name = nextName;
  for (const agent of draft.agents) {
    agent.subagents = agent.subagents.map((s) => (s === before ? nextName : s));
  }
}

function addSubagent() {
  let n = draftSubagents.length + 1;
  while (draftSubagents.some((s) => s.name === `新しい部下${n}`)) n += 1;
  draftSubagents.push({
    name: `新しい部下${n}`,
    // file を空にしておくと、サーバー側が名前からファイル名を決める。
    file: "",
    description: "",
    tools: "",
    body: "## 人格\n\n\n## 仕事\n",
    sprite: office.sprites[0] || SUBAGENT_SPRITE_DEFAULT,
  });
  selectedSubagent = draftSubagents.length - 1;
  setSettingsStatus("");
  renderSettingsEditor();
}

function deleteSubagent(sub) {
  if (!window.confirm(`${sub.name} を削除しますか？（.claude/agents/ の定義ファイルも削除されます）`)) return;

  if (sub.file) deletedSubagentFiles.push(sub.file);
  draftSubagents = draftSubagents.filter((s) => s !== sub);
  for (const agent of draft.agents) {
    agent.subagents = agent.subagents.filter((s) => s !== sub.name);
  }
  selectedSubagent = 0;
  setSettingsStatus("");
  renderSettingsEditor();
}

function renderProjectsEditor(el) {
  const rows = Object.entries(draft.projects).map(([key, p]) => `
    <div class="project-row" data-project="${escapeHtml(key)}">
      <label class="field"><span>表示名</span>
        <input type="text" data-project-field="name" value="${escapeHtml(p.name)}" maxlength="40" /></label>
      <label class="field"><span>パス</span>
        <div class="path-row">
          <input type="text" data-project-field="path" value="${escapeHtml(p.path)}" />
          <button type="button" class="btn-ghost btn-small" data-project-browse>参照…</button>
        </div></label>
      <button type="button" class="btn-danger btn-small" data-project-delete>削除</button>
    </div>
  `).join("");

  el.innerHTML = `
    <section class="edit-section">
      <h3>プロジェクト</h3>
      <p class="hint">エージェントが作業するディレクトリです。相対パスはこのリポジトリからの
      相対、絶対パスもそのまま使えます。存在しないパスは保存時に弾かれます。</p>
      <p class="warn">指示は <code>--permission-mode auto</code> で実行されます。
      ここに追加したディレクトリは、確認プロンプトなしで読み書きされます。</p>
      <div class="project-list">${rows}</div>
      <button type="button" class="btn-ghost" id="project-add">＋ プロジェクトを追加</button>
    </section>
  `;

  for (const row of el.querySelectorAll(".project-row")) {
    const key = row.dataset.project;
    for (const input of row.querySelectorAll("[data-project-field]")) {
      input.addEventListener("input", () => {
        draft.projects[key][input.dataset.projectField] = input.value;
      });
    }
    row.querySelector("[data-project-browse]").addEventListener("click", (e) => {
      browseForDirectory(e.currentTarget, row.querySelector('[data-project-field="path"]'), key);
    });
    row.querySelector("[data-project-delete]").addEventListener("click", () => {
      const used = draft.agents.filter((a) => a.project === key);
      if (used.length) {
        setSettingsStatus(
          `「${draft.projects[key].name}」は ${used.map((a) => a.name).join("・")} が使用中です。`, true);
        return;
      }
      if (Object.keys(draft.projects).length <= 1) {
        setSettingsStatus("プロジェクトは1つ以上必要です。", true);
        return;
      }
      delete draft.projects[key];
      setSettingsStatus("");
      renderSettingsEditor();
    });
  }

  el.querySelector("#project-add").addEventListener("click", async () => {
    let n = 1;
    while (draft.projects[`project${n}`]) n += 1;
    const key = `project${n}`;
    draft.projects[key] = { name: `新しいプロジェクト${n}`, path: "." };
    renderSettingsEditor();

    // 追加した直後にフォルダを選ばせる。手で絶対パスを打つのは間違えやすいうえ、
    // 存在しないパスは保存時に弾かれるだけで、その場では気づけないため。
    const row = el.querySelector(`.project-row[data-project="${key}"]`);
    if (row) row.querySelector("[data-project-browse]").click();
  });
}

async function browseForDirectory(button, input, projectKey) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "選択中…";
  setSettingsStatus("フォルダ選択ダイアログを開きました。別ウィンドウをご確認ください。");
  try {
    const res = await fetch("/api/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial: input.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSettingsStatus(data.error || `フォルダを選択できませんでした (${res.status})`, true);
      return;
    }
    if (data.cancelled) {
      setSettingsStatus("");
      return;
    }
    input.value = data.path;
    draft.projects[projectKey].path = data.path;
    setSettingsStatus(`選択しました: ${data.absolute}`);
  } catch (e) {
    setSettingsStatus(`フォルダ選択エラー: ${e.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function addAgent() {
  const used = new Set(draft.agents.map((a) => a.id));
  let id = "";
  for (const c of "ABCEFGHIJKLNOQRTUVWXYZ") {
    if (!used.has(c)) { id = c; break; }
  }
  if (!id) {
    let n = 1;
    while (used.has(`A${n}`)) n += 1;
    id = `A${n}`;
  }

  const agent = {
    id,
    name: `新入社員${id}`,
    dept: "新部署",
    role: "担当",
    sprite: office.sprites[0] || SUBAGENT_SPRITE_DEFAULT,
    // 空にしておくと、サーバー側が名前からファイル名を決めてくれる。
    soul: "",
    project: Object.keys(draft.projects)[0],
    consults: [],
    subagents: [],
  };
  draft.agents.push(agent);
  draftSouls[id] = `# SOUL: ${agent.name}\n\n## 人格\n\n\n## 話し方\n\n\n## クセ・キャラクター付け\n`;
  selectedKey = id;
  setSettingsStatus("");
  renderSettings();
}

function deleteAgent(agent) {
  if (draft.agents.length <= 1) {
    setSettingsStatus("エージェントは1人以上必要です。", true);
    return;
  }
  if (!window.confirm(`${agent.name} を削除しますか？（souls/${agent.soul} は残ります）`)) return;

  draft.agents = draft.agents.filter((a) => a.id !== agent.id);
  for (const other of draft.agents) {
    other.consults = other.consults.filter((c) => c !== agent.id);
  }
  delete draftSouls[agent.id];
  selectedKey = draft.agents[0].id;
  setSettingsStatus("");
  renderSettings();
}

async function saveSettings() {
  const button = document.getElementById("settings-save");
  button.disabled = true;
  setSettingsStatus("保存中...");

  // 部下の画像は名前をキーに持つので、改名にも追随するよう毎回組み直す。
  draft.subagent_sprites = Object.fromEntries(
    draftSubagents.map((s) => [s.name, s.sprite]));

  try {
    const res = await fetch("/api/office", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: draft,
        souls: draftSouls,
        subagents: { entries: draftSubagents, deleted: deletedSubagentFiles },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSettingsStatus(data.error || `保存に失敗しました (${res.status})`, true);
      return;
    }
    await loadOffice();
    closeSettings();
  } catch (e) {
    setSettingsStatus(`保存エラー: ${e.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function setupSettings() {
  document.getElementById("settings-open").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  document.getElementById("settings-cancel").addEventListener("click", closeSettings);
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("agent-add").addEventListener("click", addAgent);

  document.getElementById("sprite-close").addEventListener("click", closeSpritePicker);
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettings();
  });
  document.getElementById("sprite-modal").addEventListener("click", (e) => {
    if (e.target.id === "sprite-modal") closeSpritePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 画像選びを開いている間は、Escで閉じるのはそちらだけにする。
    if (!document.getElementById("sprite-modal").hidden) closeSpritePicker();
    else if (!document.getElementById("settings-modal").hidden) closeSettings();
  });
}

// --------------------------------------------------------------------------
// 指示ボックス / ログ
// --------------------------------------------------------------------------

function setupInstructForm() {
  const form = document.getElementById("instruct-form");
  const input = document.getElementById("instruct-input");
  const targetSelect = document.getElementById("instruct-target");
  const statusEl = document.getElementById("instruct-status");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const instruction = input.value.trim();
    if (!instruction) return;
    const agentId = targetSelect.value;

    button.disabled = true;
    statusEl.textContent = "送信中...";
    try {
      const res = await fetch("/instruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, agent_id: agentId }),
      });
      if (res.ok) {
        statusEl.textContent = `${agentId}に指示を送りました。オフィスの様子をご確認ください。`;
        input.value = "";
      } else {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = `送信失敗: ${err.error || res.status}`;
      }
    } catch (err) {
      statusEl.textContent = `送信エラー: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  });
}

function setupLogToggle() {
  const toggle = document.getElementById("log-toggle");
  const list = document.getElementById("log-list");
  toggle.addEventListener("click", () => {
    const expanded = list.classList.toggle("expanded");
    toggle.textContent = expanded ? "▲ 閉じる" : "▼ すべて表示";
    toggle.setAttribute("aria-expanded", String(expanded));
  });
}

async function init() {
  setupInstructForm();
  setupLogToggle();
  setupSettings();
  try {
    await loadOffice();
  } catch (e) {
    document.getElementById("topbar-sub").textContent = `設定を読み込めません: ${e.message}`;
  }
  poll();
}

init();
