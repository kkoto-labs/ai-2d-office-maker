const POLL_MS = 1000;
const STALE_MS = 90 * 1000;
const REPORT_DECAY_MS = 4000;
// 選択欄の「新しく作る」を表す値。実在のキーと衝突しない綴りにしてある。
const NEW_VALUE = "__new__";

const STATE_LABEL = {
  idle: "待機中",
  thinking: "検討中",
  working: "作業中",
  consulting: "相談中",
  reporting: "報告中",
};

/** 生のstateから、実際に画面へ出す状態を求める。
 *
 *  キャラ本体とタブの「動いているか」表示が別々に鮮度判定をすると、
 *  片方だけ古い状態を出したまま取り残される。
 */
function displayState(data) {
  const ageMs = Date.now() - data.updated_at * 1000;
  let state = data.state || "idle";
  let detail = data.detail || (data.queue_len > 0 ? "指示を受け取りました" : "");
  if (!data.state && data.queue_len > 0) state = "thinking";

  if (state !== "idle" && ageMs > STALE_MS) {
    state = "idle";
    detail = "応答待ち";
  }
  if (state === "reporting" && ageMs > REPORT_DECAY_MS) {
    state = "idle";
    detail = "待機中";
  }
  return { state, detail };
}


// オフィスの構成は config/office.json が真実源で、サーバーの /api/office 経由で
// 受け取る。以前はこのファイルにキャラ定義をベタ書きしていたため、設定を変える
// たびに server.py・hooks・ここの3箇所を直す必要があった。
let AGENTS = [];
let SUBAGENT_SPRITE = {};

let office = null;

const lastRenderedLogKey = {};
const lastRenderedSubagentKey = {};
const lastRenderedGuestKey = {};
// ワークスペースごとに、最後に描いた回答の時刻を覚える。
const lastRenderedReportAt = {};

// --------------------------------------------------------------------------
// オフィスの読み込みと描画
// --------------------------------------------------------------------------

async function loadOffice() {
  office = await fetchOffice();
  AGENTS = office.config.agents;
  SUBAGENT_SPRITE = Object.fromEntries(
    Object.entries(office.config.subagents || {}).map(([name, meta]) => [name, meta.sprite]));
  buildRooms();
}

function buildRooms() {
  const roomsEl = document.getElementById("rooms");
  // 組み直しても、選んでいた宛先と書きかけの指示は失わないようにする。
  const previous = {};
  for (const form of roomsEl.querySelectorAll(".workspace-console")) {
    previous[form.dataset.workspace] = {
      target: form.querySelector(".instruct-target").value,
      text: form.querySelector(".instruct-input").value,
    };
  }

  // エージェントは設定画面で増減するので、毎回まっさらに組み直す。
  roomsEl.innerHTML = "";
  for (const key of Object.keys(lastRenderedSubagentKey)) delete lastRenderedSubagentKey[key];

  // 担当ワークスペースごとにフロアを分ける。別のリポジトリを見ている人が
  // 同じ場所に混ざっていると、どの成果物の話をしているのか読めなくなる。
  const workspaces = office.config.workspaces || {};
  const byWorkspace = new Map();
  for (const agent of AGENTS) {
    const key = (agent.workspaces || [])[0] || "";
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(agent);
  }

  const allDepts = [];
  for (const [workspaceKey, members] of byWorkspace) {
    const floor = document.createElement("section");
    floor.className = "workspace-floor";
    floor.dataset.workspace = workspaceKey;

    const workspace = workspaces[workspaceKey] || {};

    // ワークスペースが1つしかないなら見出しは足さない。分ける意味がないため。
    const head = byWorkspace.size > 1 ? `
      <div class="workspace-floor-head">
        <span class="workspace-floor-name">${escapeHtml(workspace.name || workspaceKey || "未設定")}</span>
        <code class="workspace-floor-path">${escapeHtml(workspace.path || "")}</code>
        <span class="workspace-floor-count">${members.length}人</span>
      </div>` : "";

    // 指示はワークスペースごとに出す。宛先もそのフロアの人だけに絞る。
    // 全員が1つの欄に並んでいると、別のリポジトリの担当へ誤って投げてしまう。
    floor.innerHTML = `${head}
      <form class="workspace-console" data-workspace="${escapeHtml(workspaceKey)}">
        <select class="instruct-target">${members.map((a) =>
          `<option value="${escapeHtml(a.id)}">${escapeHtml(a.dept)} - ${escapeHtml(a.name)}</option>`).join("")}</select>
        <textarea class="instruct-input" rows="2"
          placeholder="${escapeHtml(workspace.name || "このワークスペース")}への指示を入力..."></textarea>
        <button type="submit">指示を送る</button>
      </form>
      <div class="instruct-status" data-status="${escapeHtml(workspaceKey)}"></div>
      <div class="rooms-group"></div>
      <div class="console-reply" data-reply="${escapeHtml(workspaceKey)}">
        <h2 class="reply-title">回答</h2>
        <div class="reply-text">まだ報告はありません。</div>
      </div>`;

    const group = floor.querySelector(".rooms-group");
    roomsEl.appendChild(floor);

    const saved = previous[workspaceKey];
    if (saved) {
      const select = floor.querySelector(".instruct-target");
      if (members.some((a) => a.id === saved.target)) select.value = saved.target;
      floor.querySelector(".instruct-input").value = saved.text;
    }
    wireConsole(floor);

    const byDept = new Map();
    for (const agent of members) {
      if (!byDept.has(agent.dept)) byDept.set(agent.dept, []);
      byDept.get(agent.dept).push(agent);
    }

    for (const [dept, deptMembers] of byDept) {
      if (!allDepts.includes(dept)) allDepts.push(dept);
      const room = document.createElement("section");
      room.className = "room";
      room.dataset.dept = dept;
      room.innerHTML = `<div class="room-label">${escapeHtml(dept)}</div>`
        + deptMembers.map(deskUnitHtml).join("");
      group.appendChild(room);

      for (const agent of deptMembers) {
        document.getElementById(`sprite-${agent.id}`).style.backgroundImage =
          `url("assets/characters/${agent.sprite}")`;
      }
    }
  }

  document.getElementById("topbar-sub").textContent = allDepts.join("・");
  buildWorkspaceTabs([...byWorkspace.keys()], workspaces);
}

// いま見ているワークスペース。タブを切り替えても、設定変更で組み直しても保つ。
let activeWorkspace = null;
// 各ワークスペースで最後に確認した報告の時刻。これより新しければ未読。
const seenReportAt = {};
// 直近のポーリング結果。タブの状況表示はここを見る。
let lastAgentData = {};

function buildWorkspaceTabs(keys, workspaces) {
  const bar = document.getElementById("workspace-tabs");
  // 1つしかないなら切り替える先が無い。タブを出さず、そのまま表示する。
  bar.hidden = keys.length < 2;
  bar.innerHTML = "";
  if (!keys.includes(activeWorkspace)) activeWorkspace = keys[0] ?? null;

  for (const key of keys) {
    const workspace = workspaces[key] || {};
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "workspace-tab";
    tab.dataset.tab = key;
    tab.innerHTML = `
      <span class="tab-pulse"></span>
      <span class="tab-name">${escapeHtml(workspace.name || key || "未設定")}</span>
      <span class="tab-badge" hidden>●</span>`;
    tab.addEventListener("click", () => selectWorkspace(key));
    bar.appendChild(tab);
  }
  applyWorkspaceVisibility();
}

function selectWorkspace(key) {
  activeWorkspace = key;
  // 開いた時点で、そのワークスペースの報告は読んだものとして扱う。
  seenReportAt[key] = latestReportAt(key);
  applyWorkspaceVisibility();
}

function workspaceOf(agent) {
  return (agent.workspaces || [])[0] || "";
}

function latestReportAt(key) {
  let latest = 0;
  for (const agent of AGENTS) {
    if (workspaceOf(agent) !== key) continue;
    const data = lastAgentData[agent.id];
    if (data && data.last_report_at > latest) latest = data.last_report_at;
  }
  return latest;
}

function applyWorkspaceVisibility() {
  const single = document.getElementById("workspace-tabs").hidden;
  for (const floor of document.querySelectorAll(".workspace-floor")) {
    floor.hidden = !single && floor.dataset.workspace !== activeWorkspace;
  }
  for (const tab of document.querySelectorAll(".workspace-tab")) {
    tab.classList.toggle("active", tab.dataset.tab === activeWorkspace);
  }
  updateWorkspaceTabs();
}

/** タブに「動いているか」と「未読の報告があるか」を出す。
 *
 *  裏で走らせているワークスペースが終わったことに気づけないと、切り替えて
 *  確認しに行くきっかけが無い。
 */
function updateWorkspaceTabs() {
  for (const tab of document.querySelectorAll(".workspace-tab")) {
    const key = tab.dataset.tab;
    const members = AGENTS.filter((a) => workspaceOf(a) === key);

    const busy = members.some((a) => {
      const data = lastAgentData[a.id];
      return !!data && displayState(data).state !== "idle";
    });
    tab.classList.toggle("busy", busy);

    const latest = latestReportAt(key);
    if (key === activeWorkspace) seenReportAt[key] = latest;
    tab.querySelector(".tab-badge").hidden = latest <= (seenReportAt[key] ?? 0);
  }
}

/** 指示を送るAPI呼び出し。指示ボックスと質問モーダルの両方から使う。 */
function sendInstruction(agentId, instruction) {
  return fetch("/instruct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, agent_id: agentId }),
  });
}

/** フロアごとの指示ボックスを動かす。 */
function wireConsole(floor) {
  const form = floor.querySelector(".workspace-console");
  const input = form.querySelector(".instruct-input");
  const select = form.querySelector(".instruct-target");
  const button = form.querySelector("button");
  const statusEl = floor.querySelector("[data-status]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const instruction = input.value.trim();
    if (!instruction) return;
    const agentId = select.value;

    button.disabled = true;
    statusEl.textContent = "送信中...";
    try {
      const res = await sendInstruction(agentId, instruction);
      if (res.ok) {
        const name = AGENTS.find((a) => a.id === agentId);
        statusEl.textContent = `${name ? name.name : agentId}に指示を送りました。`;
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

function deskUnitHtml(agent) {
  return `
    <div class="desk-unit" data-agent="${escapeHtml(agent.id)}">
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
    </div>`;
}

async function poll() {
  try {
    const res = await fetch(`../state/agents.json?t=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    render(data.agents || {});
    renderGuests(data.guests || {});
  } catch (e) {
    // state file not available yet; keep last rendered view
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function render(agentsData) {
  lastAgentData = agentsData;
  const mergedLog = [];
  // 回答はワークスペースごとに出す。指示を出した場所で答えが返るほうが追える。
  const latestByWorkspace = new Map();

  for (const agent of AGENTS) {
    // 作ったばかりのエージェントは状態ファイルにまだ現れない。データが無い＝
    // 読み込み中ではなく「まだ一度も動いていない」なので、そう表示する。
    const data = agentsData[agent.id] || { state: "idle", detail: "未出社", updated_at: 0 };
    renderAgent(agent, data);
    if (!agentsData[agent.id]) continue;

    for (const item of data.log || []) {
      mergedLog.push({ ...item, name: agent.name, agentId: agent.id });
    }
    if (data.last_report) {
      const key = (agent.workspaces || [])[0] || "";
      const current = latestByWorkspace.get(key);
      if (!current || data.last_report_at > current.at) {
        latestByWorkspace.set(key, {
          name: agent.name, dept: agent.dept, agentId: agent.id,
          text: data.last_report, at: data.last_report_at,
        });
      }
    }
  }

  mergedLog.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  renderLog(mergedLog);
  for (const [key, report] of latestByWorkspace) renderReport(key, report);
  updateWorkspaceTabs();
}

// このオフィスの管理外で動いている claude。設定に無いので配席もできず、
// 指示も出せない。ロビーに立ち寄っている人として、別枠で見せる。
const GUEST_SPRITES = [
  "pipo-charachip011.png", "pipo-charachip012.png", "pipo-charachip013.png",
  "pipo-charachip014.png", "pipo-charachip019.png", "pipo-charachip022.png",
];

function guestSprite(sessionId) {
  // 同じセッションには毎回同じ見た目を割り当てたいので、IDから決める。
  let hash = 0;
  for (const ch of sessionId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GUEST_SPRITES[hash % GUEST_SPRITES.length];
}

function renderGuests(guests) {
  const lobby = document.getElementById("lobby");
  const entries = Object.values(guests);
  lobby.hidden = entries.length === 0;
  if (!entries.length) {
    lastRenderedGuestKey.key = "";
    return;
  }

  // 中身が変わったときだけ描き直す。毎秒作り直すとアニメーションが途切れる。
  const key = entries.map((g) => `${g.session}:${g.state}:${g.detail}`).sort().join("|");
  if (lastRenderedGuestKey.key === key) return;
  lastRenderedGuestKey.key = key;

  lobby.querySelector(".lobby-count").textContent = `${entries.length}人`;
  const list = lobby.querySelector(".lobby-list");
  list.innerHTML = "";
  for (const guest of entries) {
    const el = document.createElement("div");
    el.className = `guest ${guest.state}`;
    el.innerHTML = `
      <div class="guest-sprite" style="background-image: url('assets/characters/${guestSprite(guest.session)}')"></div>
      <div class="guest-text">
        <span class="guest-name">${escapeHtml(guest.folder)}</span>
        <span class="guest-detail">${escapeHtml(STATE_LABEL[guest.state] || guest.state)}・${escapeHtml(guest.detail)}</span>
      </div>`;
    el.title = `${guest.cwd}\nセッション ${guest.short}`;
    el.appendChild(adoptButton(guest));
    list.appendChild(el);
  }
}

function adoptButton(guest) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "guest-adopt";
  button.textContent = "迎え入れる";
  button.addEventListener("click", () => openAdopt(guest));
  return button;
}

// ---- 迎え入れ -------------------------------------------------------------

let adoptTarget = null;

function openAdopt(guest) {
  adoptTarget = guest;
  const config = office.config;
  const depts = Object.keys(config.departments || {});
  // このセッションの作業先が、すでにワークスペースとして登録されているか。
  // 設定上のパスは "." のような相対表記なので、解決済みの絶対パスで比べる。
  const known = Object.entries(office.workspace_paths || {})
    .find(([, abs]) => sameFolder(abs, guest.cwd));

  const workspaceOptions = Object.entries(config.workspaces || {})
    .map(([key, w]) => `<option value="${escapeHtml(key)}"${
      known && known[0] === key ? " selected" : ""}>${escapeHtml(w.name)}</option>`).join("");

  document.getElementById("adopt-body").innerHTML = `
    <div class="adopt-who">
      <div class="guest-sprite" style="background-image: url('assets/characters/${guestSprite(guest.session)}')"></div>
      <div class="nav-text">
        <span class="nav-name">${escapeHtml(guest.folder)}</span>
        <span class="nav-dept">セッション ${escapeHtml(guest.short)}</span>
      </div>
    </div>
    <p class="hint"><code>${escapeHtml(guest.cwd)}</code></p>
    ${guest.state !== "idle" ? `<p class="warn">このセッションはまだ動いているようです。
      ターミナル側を終了してから迎え入れてください。動いたまま指示を送ると、
      同じ会話に2つのプロセスが書き込んで壊れます。</p>` : ""}

    <div class="field-grid">
      <label class="field"><span>名前</span>
        <input type="text" id="adopt-name" value="${escapeHtml(guest.folder)}" maxlength="40" /></label>
      <label class="field"><span>役職</span>
        <input type="text" id="adopt-role" value="担当" maxlength="40" /></label>
    </div>

    <label class="field"><span>配属する部署</span>
      <select id="adopt-dept">
        ${depts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
        <option value="${NEW_VALUE}">＋ 新しい部署をつくる…</option>
      </select></label>

    <label class="field"><span>ワークスペース</span>
      <select id="adopt-workspace">
        ${workspaceOptions}
        <option value="${NEW_VALUE}"${known ? "" : " selected"}>＋ このフォルダを新しいワークスペースにする</option>
      </select>
      <small class="hint">${known
        ? "このフォルダは登録済みです。既存のワークスペースに配属できます。"
        : "未登録のフォルダなので、新しいワークスペースとして追加します。"}</small></label>
  `;

  setAdoptStatus("");
  document.getElementById("adopt-modal").hidden = false;
}

function sameFolder(a, b) {
  // 区切り文字・末尾のスラッシュ・大文字小文字を揃えて比べる（Windows想定）。
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function closeAdopt() {
  document.getElementById("adopt-modal").hidden = true;
  adoptTarget = null;
}

function setAdoptStatus(text, isError) {
  const el = document.getElementById("adopt-status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

async function confirmAdopt() {
  if (!adoptTarget) return;
  const button = document.getElementById("adopt-confirm");

  let dept = document.getElementById("adopt-dept").value;
  if (dept === NEW_VALUE) {
    dept = (window.prompt("新しい部署の名前") || "").trim();
    if (!dept) return;
  }
  const workspaceValue = document.getElementById("adopt-workspace").value;

  button.disabled = true;
  setAdoptStatus("迎え入れています...");
  try {
    const res = await fetch("/api/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: adoptTarget.session,
        cwd: adoptTarget.cwd,
        name: document.getElementById("adopt-name").value.trim(),
        role: document.getElementById("adopt-role").value.trim(),
        dept,
        sprite: guestSprite(adoptTarget.session),
        workspace: workspaceValue === NEW_VALUE
          ? { name: adoptTarget.folder }
          : { key: workspaceValue },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAdoptStatus(data.error || `迎え入れに失敗しました (${res.status})`, true);
      return;
    }
    // 迎え入れた先のワークスペースを開いて、配属先がすぐ見えるようにする。
    await loadOffice();
    selectWorkspace(data.workspace);
    closeAdopt();
  } catch (e) {
    setAdoptStatus(`エラー: ${e.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function setupAdopt() {
  document.getElementById("adopt-close").addEventListener("click", closeAdopt);
  document.getElementById("adopt-cancel").addEventListener("click", closeAdopt);
  document.getElementById("adopt-confirm").addEventListener("click", confirmAdopt);
  document.getElementById("adopt-modal").addEventListener("click", (e) => {
    if (e.target.id === "adopt-modal") closeAdopt();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAdopt();
  });
}

// 選択式の確認が複数同時に来た場合、1つずつ順番にモーダルで出す。
const questionQueue = [];
let questionModalOpen = false;
// 表示中(または直前に表示した)質問。閉じる時にlocalStorageへ既読を記録するために使う。
let currentQuestion = null;

// last_report は次の応答が来るまで state/agents.json に残り続けるので、
// リロードするたびに同じ質問がまた出てくる。既読/回答済みをブラウザ側に
// 覚えさせておき、同じ report(agentId + at)なら再ポップアップさせない。
const QUESTION_SEEN_PREFIX = "aimieruka:question-seen:";

function isQuestionHandled(agentId, at) {
  try {
    return localStorage.getItem(QUESTION_SEEN_PREFIX + agentId) === String(at);
  } catch {
    return false;
  }
}

function markQuestionHandled(agentId, at) {
  try {
    localStorage.setItem(QUESTION_SEEN_PREFIX + agentId, String(at));
  } catch {
    // localStorageが使えなくても、モーダル表示自体は諦めない。
  }
}

function setupQuestionModal() {
  document.getElementById("question-close").addEventListener("click", closeQuestionModal);
  document.getElementById("question-later").addEventListener("click", closeQuestionModal);
  document.getElementById("question-modal").addEventListener("click", (e) => {
    if (e.target.id === "question-modal") closeQuestionModal();
  });
}

function queueQuestionModal(payload) {
  if (!payload.agentId) return;
  questionQueue.push(payload);
  if (!questionModalOpen) showNextQuestion();
}

function showNextQuestion() {
  const payload = questionQueue.shift();
  if (!payload) {
    questionModalOpen = false;
    currentQuestion = null;
    return;
  }
  questionModalOpen = true;
  currentQuestion = payload;

  const { agentId, agentName, dept, question, options } = payload;
  document.getElementById("question-title").textContent = `${agentName}からの確認`;

  const body = document.getElementById("question-body");
  body.innerHTML = `
    <p class="question-who">${escapeHtml(dept)}・${escapeHtml(agentName)}</p>
    <p class="question-text">${escapeHtml(question).replace(/\n/g, "<br>")}</p>
    <div class="question-options"></div>
    <div class="question-free">
      <input type="text" class="question-free-input" placeholder="他の答えを書く" />
      <button type="button" class="btn-ghost question-free-send">送信</button>
    </div>`;

  const optionsEl = body.querySelector(".question-options");
  for (const option of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary question-option";
    btn.textContent = option;
    btn.addEventListener("click", () => answerQuestion(agentId, option));
    optionsEl.appendChild(btn);
  }

  const freeInput = body.querySelector(".question-free-input");
  const sendFree = () => {
    const value = freeInput.value.trim();
    if (value) answerQuestion(agentId, value);
  };
  body.querySelector(".question-free-send").addEventListener("click", sendFree);
  freeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendFree();
  });

  document.getElementById("question-status").textContent = "";
  document.getElementById("question-modal").hidden = false;
}

function closeQuestionModal() {
  document.getElementById("question-modal").hidden = true;
  questionModalOpen = false;
  if (currentQuestion) markQuestionHandled(currentQuestion.agentId, currentQuestion.at);
  currentQuestion = null;
  if (questionQueue.length) showNextQuestion();
}

async function answerQuestion(agentId, answer) {
  const statusEl = document.getElementById("question-status");
  statusEl.textContent = "送信中...";
  try {
    const res = await sendInstruction(agentId, answer);
    if (res.ok) {
      closeQuestionModal();
    } else {
      const err = await res.json().catch(() => ({}));
      statusEl.textContent = `送信失敗: ${err.error || res.status}`;
    }
  } catch (err) {
    statusEl.textContent = `送信エラー: ${err.message}`;
  }
}

function renderAgent(agent, data) {
  const { state, detail } = displayState(data);

  const charEl = document.getElementById(`char-${agent.id}`);
  const bubbleEl = document.getElementById(`bubble-${agent.id}`);
  const statusEl = document.getElementById(`status-${agent.id}`);
  if (!charEl) return;

  // 状態（待機/作業/相談…）に加えて、何をしている作業なのかで動きを変える。
  // 「作業中」だけでは、書いているのか読んでいるのかが見て分からない。
  const activity = state === "working" ? (data.activity || "think") : state;
  charEl.className = `character ${state} act-${activity}`;

  bubbleEl.textContent = detail;
  bubbleEl.classList.toggle("show",
    state === "working" || state === "consulting" || state === "reporting");

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

// 報告の末尾にこの形式があれば、社長への選択式の確認だと分かる。
// [SHACHO_QUESTION]\n質問\n1. 選択肢A\n2. 選択肢B\n[/SHACHO_QUESTION]
const QUESTION_RE = /\[SHACHO_QUESTION\]\s*([\s\S]*?)\[\/SHACHO_QUESTION\]/;

// 選択肢の行頭記号は「1.」「A:」「①」など、モデルが書く形がまちまちなので
// 数字・英字のどちらでも受け付ける。記号が無い行も、最初の選択肢が
// 見つかった後に出てくるものは選択肢として扱う。
const OPTION_LINE_RE = /^(?:\d+|[A-Za-zＡ-Ｚａ-ｚ])[.)．、:：]\s*(.+)$/;

// 「1. B: 内容」のように番号とラベルを二重に付ける書き方もあるので、
// 先頭の記号は消えなくなるまで（最大2段まで）剥がす。
function stripOptionPrefix(line) {
  let text = line;
  for (let i = 0; i < 2; i++) {
    const m = OPTION_LINE_RE.exec(text);
    if (!m) break;
    text = m[1].trim();
  }
  return text;
}

function parseQuestion(text) {
  const m = QUESTION_RE.exec(text || "");
  if (!m) return null;

  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  let splitAt = lines.findIndex((l) => OPTION_LINE_RE.test(l));
  if (splitAt <= 0) splitAt = 1; // 記号付きの行が見当たらなければ、先頭1行を質問文とみなす。

  const questionLines = lines.slice(0, splitAt);
  const options = lines.slice(splitAt).map(stripOptionPrefix);
  if (!options.length) return null;

  return {
    question: questionLines.join("\n"),
    options,
    rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(),
  };
}

function renderReport(workspaceKey, report) {
  if (lastRenderedReportAt[workspaceKey] === report.at) return;
  const panel = document.querySelector(`[data-reply="${CSS.escape(workspaceKey)}"]`);
  if (!panel) return;
  lastRenderedReportAt[workspaceKey] = report.at;

  const parsed = parseQuestion(report.text);
  panel.querySelector(".reply-title").textContent = `${report.name}（${report.dept}）からの回答`;
  panel.querySelector(".reply-text").innerHTML =
    renderMarkdown(parsed ? (parsed.rest || "（質問はポップアップで確認してください）") : report.text);

  if (parsed && !isQuestionHandled(report.agentId, report.at)) {
    queueQuestionModal({
      agentId: report.agentId, agentName: report.name, dept: report.dept,
      question: parsed.question, options: parsed.options, at: report.at,
    });
  }
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


// --------------------------------------------------------------------------
// 指示ボックス / ログ
// --------------------------------------------------------------------------

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
  setupLogToggle();
  setupAdopt();
  setupQuestionModal();
  try {
    await loadOffice();
  } catch (e) {
    document.getElementById("topbar-sub").textContent = `設定を読み込めません: ${e.message}`;
  }
  poll();
}

init();
