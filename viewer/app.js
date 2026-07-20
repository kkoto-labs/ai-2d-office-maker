const POLL_MS = 1000;
const STALE_MS = 90 * 1000;
const REPORT_DECAY_MS = 4000;

const AGENTS = [
  { id: "S", name: "ユイ", dept: "秘書室", sprite: "pipo-charachip017.png", role: "秘書" },
  { id: "P", name: "発田案", dept: "企画部", sprite: "pipo-charachip015a.png", role: "PM" },
  { id: "D", name: "築山創", dept: "開発部", sprite: "pipo-charachip025.png", role: "PM" },
  { id: "M", name: "広瀬映", dept: "広報・マーケティング部", sprite: "pipo-charachip021.png", role: "PM" },
];

const STATE_LABEL = {
  idle: "待機中",
  thinking: "検討中",
  working: "作業中",
  reporting: "報告中",
};

const SUBAGENT_SPRITE = {
  明石要: "pipo-charachip003.png",
  設楽構: "pipo-charachip016.png",
  織田創: "pipo-charachip001b.png",
  見城評: "pipo-charachip004.png",
  精田照: "pipo-charachip002a.png",
  試崎験: "pipo-charachip007.png",
};
const SUBAGENT_SPRITE_DEFAULT = "pipo-charachip001b.png";

const lastRenderedLogKey = {};
let lastRenderedReportAt = null;

function buildRooms() {
  const roomsEl = document.getElementById("rooms");
  const targetSelect = document.getElementById("instruct-target");

  for (const agent of AGENTS) {
    const room = document.createElement("section");
    room.className = "room";
    room.dataset.dept = agent.dept;
    room.innerHTML = `
      <div class="room-label">${agent.dept}</div>
      <div class="desk">
        <div class="monitor"><div class="monitor-screen"></div></div>
        <div class="character" id="char-${agent.id}">
          <div class="speech-bubble" id="bubble-${agent.id}"></div>
          <div class="thinking-dots" id="dots-${agent.id}"><span></span><span></span><span></span></div>
          <div class="shadow"></div>
          <div class="sprite" id="sprite-${agent.id}"></div>
          <div class="nameplate">
            <span class="nameplate-name">${agent.name}</span>
            <span class="nameplate-role">${agent.role}</span>
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

const lastRenderedSubagentKey = {};

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

buildRooms();
setupInstructForm();
setupLogToggle();
poll();
