const POLL_MS = 1000;
const STALE_MS = 90 * 1000;
const REPORT_DECAY_MS = 4000;

const STATE_LABEL = {
  idle: "待機中",
  thinking: "検討中",
  working: "作業中",
  consulting: "相談中",
  reporting: "報告中",
};


// オフィスの構成は config/office.json が真実源で、サーバーの /api/office 経由で
// 受け取る。以前はこのファイルにキャラ定義をベタ書きしていたため、設定を変える
// たびに server.py・hooks・ここの3箇所を直す必要があった。
let AGENTS = [];
let SUBAGENT_SPRITE = {};

let office = null;

const lastRenderedLogKey = {};
const lastRenderedSubagentKey = {};
const lastRenderedGuestKey = {};
// プロジェクトごとに、最後に描いた回答の時刻を覚える。
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
  for (const form of roomsEl.querySelectorAll(".project-console")) {
    previous[form.dataset.project] = {
      target: form.querySelector(".instruct-target").value,
      text: form.querySelector(".instruct-input").value,
    };
  }

  // エージェントは設定画面で増減するので、毎回まっさらに組み直す。
  roomsEl.innerHTML = "";
  for (const key of Object.keys(lastRenderedSubagentKey)) delete lastRenderedSubagentKey[key];

  // 担当プロジェクトごとにフロアを分ける。別のリポジトリを見ている人が
  // 同じ場所に混ざっていると、どの成果物の話をしているのか読めなくなる。
  const projects = office.config.projects || {};
  const byProject = new Map();
  for (const agent of AGENTS) {
    const key = (agent.projects || [])[0] || "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(agent);
  }

  const allDepts = [];
  for (const [projectKey, members] of byProject) {
    const floor = document.createElement("section");
    floor.className = "project-floor";
    floor.dataset.project = projectKey;

    const project = projects[projectKey] || {};

    // プロジェクトが1つしかないなら見出しは足さない。分ける意味がないため。
    const head = byProject.size > 1 ? `
      <div class="project-floor-head">
        <span class="project-floor-name">${escapeHtml(project.name || projectKey || "未設定")}</span>
        <code class="project-floor-path">${escapeHtml(project.path || "")}</code>
        <span class="project-floor-count">${members.length}人</span>
      </div>` : "";

    // 指示はプロジェクトごとに出す。宛先もそのフロアの人だけに絞る。
    // 全員が1つの欄に並んでいると、別のリポジトリの担当へ誤って投げてしまう。
    floor.innerHTML = `${head}
      <form class="project-console" data-project="${escapeHtml(projectKey)}">
        <select class="instruct-target">${members.map((a) =>
          `<option value="${escapeHtml(a.id)}">${escapeHtml(a.dept)} - ${escapeHtml(a.name)}</option>`).join("")}</select>
        <textarea class="instruct-input" rows="2"
          placeholder="${escapeHtml(project.name || "このプロジェクト")}への指示を入力..."></textarea>
        <button type="submit">指示を送る</button>
      </form>
      <div class="instruct-status" data-status="${escapeHtml(projectKey)}"></div>
      <div class="rooms-group"></div>
      <div class="console-reply" data-reply="${escapeHtml(projectKey)}">
        <h2 class="reply-title">回答</h2>
        <div class="reply-text">まだ報告はありません。</div>
      </div>`;

    const group = floor.querySelector(".rooms-group");
    roomsEl.appendChild(floor);

    const saved = previous[projectKey];
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
}

/** フロアごとの指示ボックスを動かす。 */
function wireConsole(floor) {
  const form = floor.querySelector(".project-console");
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
      const res = await fetch("/instruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, agent_id: agentId }),
      });
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
  const mergedLog = [];
  // 回答はプロジェクトごとに出す。指示を出した場所で答えが返るほうが追える。
  const latestByProject = new Map();

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
      const key = (agent.projects || [])[0] || "";
      const current = latestByProject.get(key);
      if (!current || data.last_report_at > current.at) {
        latestByProject.set(key, {
          name: agent.name, dept: agent.dept,
          text: data.last_report, at: data.last_report_at,
        });
      }
    }
  }

  mergedLog.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  renderLog(mergedLog);
  for (const [key, report] of latestByProject) renderReport(key, report);
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
        <span class="guest-name">${escapeHtml(guest.project)}</span>
        <span class="guest-detail">${escapeHtml(STATE_LABEL[guest.state] || guest.state)}・${escapeHtml(guest.detail)}</span>
      </div>`;
    el.title = `${guest.cwd}\nセッション ${guest.short}`;
    list.appendChild(el);
  }
}

function renderAgent(agent, data) {
  const ageMs = Date.now() - data.updated_at * 1000;
  let state = data.state || "idle";
  // 指示を受け取った直後は、まだフックが動く前で state が無い。順番待ちの
  // 件数だけがある状態を「待機中」と読ませると、止まって見えてしまう。
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

function renderReport(projectKey, report) {
  if (lastRenderedReportAt[projectKey] === report.at) return;
  const panel = document.querySelector(`[data-reply="${CSS.escape(projectKey)}"]`);
  if (!panel) return;
  lastRenderedReportAt[projectKey] = report.at;
  panel.querySelector(".reply-title").textContent = `${report.name}（${report.dept}）からの回答`;
  panel.querySelector(".reply-text").innerHTML = renderMarkdown(report.text);
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
  try {
    await loadOffice();
  } catch (e) {
    document.getElementById("topbar-sub").textContent = `設定を読み込めません: ${e.message}`;
  }
  poll();
}

init();
