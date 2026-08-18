// 設定画面（settings.html）。オフィス画面とは別ページで動く。

const PROJECTS_KEY = "__projects__";
const SUBAGENTS_KEY = "__subagents__";
const CHART_KEY = "__chart__";
const DEPTS_KEY = "__departments__";
const NEW_DEPT_VALUE = "__new_dept__";

// サブエージェントに渡せるツール。frontmatter には英語名で書く決まりなので、
// 保存する値は name のまま、画面には日本語の説明だけを出す。
const TOOL_CATALOG = [
  {
    group: "ファイルを読む・書く",
    tools: [
      { name: "Read", label: "ファイルを読む", desc: "ソースコードや文書の中身を見る" },
      { name: "Edit", label: "ファイルを編集する", desc: "既存ファイルの一部を書き換える" },
      { name: "Write", label: "ファイルを作る", desc: "新規作成、または丸ごと上書きする" },
      { name: "NotebookEdit", label: "ノートブックを編集する", desc: "Jupyter (.ipynb) のセルを書き換える" },
    ],
  },
  {
    group: "探す",
    tools: [
      { name: "Glob", label: "ファイルを名前で探す", desc: "「*.py」のようなパターンで一覧する" },
      { name: "Grep", label: "中身を検索する", desc: "コードや文書の中を単語・正規表現で探す" },
    ],
  },
  {
    group: "実行する",
    tools: [
      { name: "Bash", label: "コマンドを実行する", desc: "テスト実行やgit操作など。強力なので付与は慎重に" },
      { name: "PowerShell", label: "PowerShellを実行する", desc: "Windows向けのコマンド実行" },
    ],
  },
  {
    group: "外部を調べる",
    tools: [
      { name: "WebSearch", label: "Webを検索する", desc: "調べ物をする" },
      { name: "WebFetch", label: "Webページを読む", desc: "URLを指定して中身を読む" },
    ],
  },
  {
    group: "その他",
    tools: [
      { name: "TodoWrite", label: "作業リストを管理する", desc: "自分の手順を整理しながら進める" },
      { name: "Agent", label: "さらに部下を呼ぶ", desc: "この部下が、もう一段下のエージェントを起動できる" },
      { name: "Skill", label: "スキルを使う", desc: "登録済みのスキル(定型作業の手順書)を呼び出す" },
    ],
  },
];

const KNOWN_TOOLS = new Set(TOOL_CATALOG.flatMap((g) => g.tools.map((t) => t.name)));

let office = null;
let draft = null;
let draftSouls = {};
let draftSubagents = [];
let deletedSubagentFiles = [];
let selectedKey = null;
let selectedSubagent = 0;
// 保存していない変更があるか。別ページなので、離脱時に引き止める判断に使う。
let dirty = false;
// 畳んだ部署だけを覚える。新しくできた部署は開いた状態で出したいため。
const collapsedDepts = new Set();

// --------------------------------------------------------------------------
// 設定画面
// --------------------------------------------------------------------------

function startEditing() {
  // 編集は必ず複製に対して行う。保存せずに離れたとき、実際の設定が
  // 中途半端に書き換わっていない状態を保つため。
  draft = JSON.parse(JSON.stringify(office.config));
  draftSouls = { ...office.souls };
  draftSubagents = office.subagent_catalog.map((s) => {
    const meta = draft.subagents[s.name] || {};
    return {
      ...s,
      sprite: meta.sprite || SUBAGENT_SPRITE_DEFAULT,
      dept: meta.dept || UNASSIGNED_DEPT,
    };
  });
  deletedSubagentFiles = [];
  selectedSubagent = 0;
  selectedKey = draft.agents.length ? draft.agents[0].id : PROJECTS_KEY;
  setSettingsStatus("");
  document.getElementById("settings-subtitle").textContent =
    `エージェント ${draft.agents.length}人・部下 ${draftSubagents.length}人・`
    + `部署 ${Object.keys(draft.departments).length}`;
  renderSettings();
  // 最初の描画は「触った」ではない。ここで消しておかないと、何もせずに
  // 離れようとしただけで引き止めてしまう。
  dirty = false;
}

function setSettingsStatus(text, isError) {
  const el = document.getElementById("settings-status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

function renderSettings() {
  // 描き直しが起きた＝何かを触った、とみなす。細かく追うより取りこぼしがない。
  if (draft) dirty = true;
  renderSettingsNav();
  renderSettingsEditor();
}

function renderSettingsNav() {
  const list = document.getElementById("settings-nav-list");
  list.innerHTML = "";

  list.appendChild(navSection("エージェント"));

  // 人数が増えるほど一覧が縦に伸びるので、部署ごとに畳めるようにする。
  const byDept = new Map();
  for (const agent of draft.agents) {
    if (!byDept.has(agent.dept)) byDept.set(agent.dept, []);
    byDept.get(agent.dept).push(agent);
  }

  for (const [dept, members] of byDept) {
    list.appendChild(navGroup(dept, dept, members.length,
      (body) => members.forEach((a) => body.appendChild(agentNavItem(a)))));
  }

  list.appendChild(navAddButton("＋ エージェントを追加", addAgent));

  // 部下も同じ見た目・同じ部署単位で並べる。役割が違うだけで、
  // どの部署の戦力なのかという見方は上司と変わらないため。
  list.appendChild(navSection("サブエージェント"));
  const subsByDept = new Map();
  draftSubagents.forEach((sub, i) => {
    const dept = sub.dept || UNASSIGNED_DEPT;
    if (!subsByDept.has(dept)) subsByDept.set(dept, []);
    subsByDept.get(dept).push({ sub, i });
  });
  for (const [dept, entries] of subsByDept) {
    list.appendChild(navGroup(`sub:${dept}`, dept, entries.length,
      (body) => entries.forEach(({ sub, i }) => body.appendChild(subagentNavItem(sub, i)))));
  }
  if (!draftSubagents.length) {
    const empty = document.createElement("li");
    empty.className = "nav-empty";
    empty.textContent = "まだいません";
    list.appendChild(empty);
  }
  list.appendChild(navAddButton("＋ サブエージェントを追加", addSubagent));

  list.appendChild(navSection("設定"));
  for (const [key, label, caption] of [
    [CHART_KEY, "🗺 組織図", "関係性を図で確認する"],
    [DEPTS_KEY, "🏢 部署", "部署の新設と上下関係"],
    [PROJECTS_KEY, "📁 プロジェクト", "作業ディレクトリの管理"],
  ]) {
    const li = document.createElement("li");
    li.className = `nav-item nav-meta${selectedKey === key ? " active" : ""}`;
    li.innerHTML = `<div class="nav-text"><span class="nav-name">${label}</span>
      <span class="nav-dept">${caption}</span></div>`;
    li.addEventListener("click", () => {
      selectedKey = key;
      renderSettings();
    });
    list.appendChild(li);
  }
}

function navGroup(stateKey, label, count, fillBody) {
  // stateKey は開閉の記憶用。エージェントと部下で同じ部署名が出るので、
  // 別々に畳めるよう呼び出し側で接頭辞を付けて渡す。
  const collapsed = collapsedDepts.has(stateKey);
  const group = document.createElement("li");
  group.className = "nav-group";
  group.innerHTML = `
    <button type="button" class="nav-group-head${collapsed ? " collapsed" : ""}"
      aria-expanded="${!collapsed}">
      <span class="nav-caret">▾</span>
      <span class="nav-group-name">${escapeHtml(label)}</span>
      <span class="nav-group-count">${count}</span>
    </button>
    <ul class="nav-group-body"${collapsed ? " hidden" : ""}></ul>`;

  group.querySelector(".nav-group-head").addEventListener("click", () => {
    if (collapsed) collapsedDepts.delete(stateKey);
    else collapsedDepts.add(stateKey);
    renderSettingsNav();
  });
  fillBody(group.querySelector(".nav-group-body"));
  return group;
}

function navSection(label) {
  const li = document.createElement("li");
  li.className = "nav-section";
  li.textContent = label;
  return li;
}

function navAddButton(label, handler) {
  const li = document.createElement("li");
  li.innerHTML = `<button type="button" class="nav-add">${escapeHtml(label)}</button>`;
  li.querySelector("button").addEventListener("click", handler);
  return li;
}

function subagentNavItem(sub, index) {
  const active = selectedKey === SUBAGENTS_KEY && selectedSubagent === index;
  // 2行目は「誰の部下か」。エージェント側の役職欄と同じ位置づけにする。
  const bosses = draft.agents.filter((a) => a.subagents.includes(sub.name));
  const caption = bosses.length ? bosses.map((b) => b.name).join("・") : "未配属";

  const li = document.createElement("li");
  li.className = `nav-item${active ? " active" : ""}`;
  li.innerHTML = `
    <div class="nav-sprite" style="background-image: url('assets/characters/${sub.sprite}')"></div>
    <div class="nav-text">
      <span class="nav-name" data-nav-sub="${index}">${escapeHtml(sub.name)}</span>
      <span class="nav-dept">${escapeHtml(caption)}</span>
    </div>
  `;
  li.addEventListener("click", () => {
    selectedKey = SUBAGENTS_KEY;
    selectedSubagent = index;
    renderSettings();
  });
  return li;
}

function agentNavItem(agent) {
  const li = document.createElement("li");
  li.className = `nav-item${agent.id === selectedKey ? " active" : ""}`;
  // 部署名はグループの見出しに出ているので、ここは役職を出す。
  li.innerHTML = `
    <div class="nav-sprite" style="background-image: url('assets/characters/${agent.sprite}')"></div>
    <div class="nav-text">
      <span class="nav-name" data-nav-name="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</span>
      <span class="nav-dept" data-nav-role="${escapeHtml(agent.id)}">${escapeHtml(agent.role)}</span>
    </div>
  `;
  li.addEventListener("click", () => {
    selectedKey = agent.id;
    renderSettings();
  });
  return li;
}

function renderSettingsEditor() {
  // 描画の途中で落ちると、前の画面が残ったまま左の選択だけが動く。別人の
  // フォームを編集してしまうので、失敗したことを画面に出して止める。
  try {
    renderSelectedEditor();
  } catch (e) {
    document.getElementById("settings-editor").innerHTML =
      `<section class="edit-section"><h3>表示できません</h3>
        <p class="warn">この画面の描画に失敗しました: ${escapeHtml(e.message)}</p>
        <p class="hint">設定は保存されていません。別の項目を選ぶか、
        ページを再読み込みしてやり直してください。</p></section>`;
    throw e;
  }
}

function renderSelectedEditor() {
  const el = document.getElementById("settings-editor");
  if (selectedKey === PROJECTS_KEY) {
    renderProjectsEditor(el);
    return;
  }
  if (selectedKey === SUBAGENTS_KEY) {
    renderSubagentEditor(el);
    return;
  }
  if (selectedKey === CHART_KEY) {
    renderOrgChart(el);
    return;
  }
  if (selectedKey === DEPTS_KEY) {
    renderDepartmentsEditor(el);
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

  const subagentChoices = subagentChoicesHtml(agent);

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
          ${deptSelectHtml(agent.dept, "data-agent-dept")}
          <small class="hint">同じ部署の人は同じ部屋に並びます。
          部署の上下関係は「🏢 部署」で設定します。</small></label>
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

function subagentChoicesHtml(agent) {
  if (!draftSubagents.length) {
    return '<p class="hint">サブエージェントがまだいません。左の「サブエージェント」から追加できます。</p>';
  }

  // 候補は保存前の下書きから引く。追加したばかりの部下も、保存を待たずに
  // ここへ割り当てられるようにするため。
  const byDept = new Map();
  for (const sub of draftSubagents) {
    const dept = sub.dept || UNASSIGNED_DEPT;
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(sub);
  }

  // 自分の部署を先頭に。他部署は畳んでおき、必要なときだけ開いて借りる。
  const own = agent.dept;
  const order = [...byDept.keys()].sort((a, b) =>
    (a === own ? -1 : 0) - (b === own ? -1 : 0));

  return order.map((dept) => {
    const rows = byDept.get(dept).map((s) => `
      <label class="check-row">
        <input type="checkbox" data-subagent="${escapeHtml(s.name)}"${agent.subagents.includes(s.name) ? " checked" : ""} />
        <span class="check-name">${escapeHtml(s.name)}</span>
        <span class="check-desc">${escapeHtml(s.description)}</span>
      </label>`).join("");

    const isOwn = dept === own;
    const assigned = byDept.get(dept).filter((s) => agent.subagents.includes(s.name)).length;
    // 他部署でも、すでに借りている相手がいるなら開いて見せる。
    const open = isOwn || assigned > 0;
    return `<details class="dept-fold"${open ? " open" : ""}>
      <summary>${escapeHtml(dept)}
        <span class="dept-fold-count">${byDept.get(dept).length}</span>
        ${isOwn ? '<span class="dept-fold-tag">自部署</span>'
                : (assigned ? `<span class="dept-fold-tag borrow">他部署から${assigned}人</span>` : "")}
      </summary>
      <div class="check-list">${rows}</div>
    </details>`;
  }).join("");
}

/** 部署の選択欄。
 *
 *  以前は datalist を使っていたが、datalist は入力済みの文字で候補を絞る仕様で、
 *  すでに部署が入っていると他の部署が一覧に出てこなかった。常に全部見えるよう
 *  select にしている。
 */
function deptSelectHtml(current, attr) {
  const names = deptNames();
  if (current && !names.includes(current)) names.push(current);
  return `<select ${attr}>
    ${names.map((d) => `<option value="${escapeHtml(d)}"${
      d === current ? " selected" : ""}>${escapeHtml(d)}</option>`).join("")}
    <option value="${NEW_DEPT_VALUE}">＋ 新しい部署をつくる…</option>
  </select>`;
}

/** 部署の選択欄に「新しい部署」用の入口を持たせる。 */
function wireDeptSelect(select, apply) {
  select.addEventListener("change", () => {
    if (select.value !== NEW_DEPT_VALUE) {
      apply(select.value);
      return;
    }
    const name = (window.prompt("新しい部署の名前") || "").trim();
    if (!name) { renderSettingsEditor(); return; }
    if (!draft.departments[name]) draft.departments[name] = { parent: null };
    apply(name);
  });
}

function wireAgentEditor(el, agent) {
  for (const input of el.querySelectorAll("[data-field]")) {
    input.addEventListener("input", () => {
      agent[input.dataset.field] = input.value;
      // 名前と役職は左のリストにも出ている。編集中にリスト全体を組み直すと
      // 入力欄からフォーカスが外れてしまうので、該当箇所だけ書き換える。
      const navName = document.querySelector(`[data-nav-name="${agent.id}"]`);
      const navRole = document.querySelector(`[data-nav-role="${agent.id}"]`);
      if (navName) navName.textContent = agent.name;
      if (navRole) navRole.textContent = agent.role;
    });
  }

  wireDeptSelect(el.querySelector("[data-agent-dept]"), (dept) => {
    agent.dept = dept;
    renderSettings();
  });

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

// ---- 部署 -----------------------------------------------------------------

function deptNames() {
  return Object.keys(draft.departments);
}

function deptMembers(name) {
  return [
    ...draft.agents.filter((a) => a.dept === name).map((a) => a.name),
    ...draftSubagents.filter((s) => s.dept === name).map((s) => s.name),
  ];
}

/** 部署をたどって根までの深さ。循環していても止まるようにする。 */
function deptDepth(name) {
  let depth = 0;
  const seen = new Set();
  let cursor = (draft.departments[name] || {}).parent;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = (draft.departments[cursor] || {}).parent;
  }
  return depth;
}

/** 自分の子孫は親に選べない。選ぶと循環するため。 */
function deptDescendants(name) {
  const out = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, meta] of Object.entries(draft.departments)) {
      if (out.has(child)) continue;
      if (meta.parent === name || out.has(meta.parent)) {
        out.add(child);
        changed = true;
      }
    }
  }
  return out;
}

/** 階層の深さを示す目印。
 *
 *  以前は行そのものを深さ分だけ字下げしていたが、それだと社長直属の行と
 *  配下の行で入力欄の左端と幅が揃わなかった。目印は固定幅の枠に閉じ込め、
 *  その中だけで字下げする。
 */
function deptDepthMark(depth) {
  if (depth <= 0) return '<span class="dept-depth"></span>';
  const indent = Math.min(depth - 1, 2) * 7;
  return `<span class="dept-depth" style="padding-left:${indent}px">└</span>`;
}

function renderDepartmentsEditor(el) {
  const rows = deptNames().map((name) => {
    const banned = deptDescendants(name);
    const options = ['<option value="">（社長直属）</option>']
      .concat(deptNames()
        .filter((other) => other !== name && !banned.has(other))
        .map((other) => `<option value="${escapeHtml(other)}"${
          draft.departments[name].parent === other ? " selected" : ""
        }>${escapeHtml(other)}</option>`))
      .join("");

    const members = deptMembers(name);
    return `
      <div class="dept-row" data-dept-row="${escapeHtml(name)}">
        <div class="dept-row-main">
          ${deptDepthMark(deptDepth(name))}
          <label class="field"><span>部署名</span>
            <input type="text" data-dept-name value="${escapeHtml(name)}" maxlength="40" /></label>
          <label class="field"><span>どこの下につくか</span>
            <select data-dept-parent>${options}</select></label>
          <button type="button" class="btn-danger btn-small" data-dept-delete>削除</button>
        </div>
        <div class="dept-row-members">${members.length
          ? `所属 ${members.length}人: ${escapeHtml(members.join("、"))}`
          : "所属なし"}</div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <section class="edit-section">
      <h3>部署</h3>
      <p class="hint">「どこの下につくか」で、社長直属か、別の部署の下かを決めます。
      組織図の段はこの設定で決まります。自分の下にある部署は、循環するので親に選べません。</p>
      <div class="dept-list">${rows || '<p class="hint">部署がありません。</p>'}</div>
      <button type="button" class="btn-ghost" id="dept-add">＋ 部署を追加</button>
    </section>`;

  for (const row of el.querySelectorAll("[data-dept-row]")) {
    const name = row.dataset.deptRow;

    row.querySelector("[data-dept-parent]").addEventListener("change", (e) => {
      draft.departments[name].parent = e.target.value || null;
      renderSettingsEditor();
    });

    // 改名は所属している全員に波及させる。取り残すと所属先が消えてしまう。
    row.querySelector("[data-dept-name]").addEventListener("change", (e) => {
      const next = e.target.value.trim();
      if (!next || next === name) { renderSettingsEditor(); return; }
      if (draft.departments[next]) {
        setSettingsStatus(`「${next}」はすでにあります。`, true);
        renderSettingsEditor();
        return;
      }
      renameDept(name, next);
      setSettingsStatus("");
      renderSettings();
    });

    row.querySelector("[data-dept-delete]").addEventListener("click", () => {
      const members = deptMembers(name);
      if (members.length) {
        setSettingsStatus(`「${name}」には ${members.join("、")} が所属しています。`, true);
        return;
      }
      // 下にぶら下がっていた部署は、消える親の代わりに一段上へ引き上げる。
      const parent = draft.departments[name].parent;
      for (const meta of Object.values(draft.departments)) {
        if (meta.parent === name) meta.parent = parent;
      }
      delete draft.departments[name];
      setSettingsStatus("");
      renderSettings();
    });
  }

  el.querySelector("#dept-add").addEventListener("click", () => {
    let n = 1;
    while (draft.departments[`新しい部署${n}`]) n += 1;
    draft.departments[`新しい部署${n}`] = { parent: null };
    setSettingsStatus("");
    renderSettings();
  });
}

function renameDept(from, to) {
  const next = {};
  for (const [name, meta] of Object.entries(draft.departments)) {
    next[name === from ? to : name] = {
      parent: meta.parent === from ? to : meta.parent,
    };
  }
  draft.departments = next;
  for (const agent of draft.agents) if (agent.dept === from) agent.dept = to;
  for (const sub of draftSubagents) if (sub.dept === from) sub.dept = to;
}

// ---- 組織図 ---------------------------------------------------------------

const CHART = { w: 178, h: 92, gapX: 20, gapY: 74, pad: 24 };
// 組織図で選んでいるノード。図の横のパネルはこれを見て中身を変える。
let chartSelection = null;

/** 「誰が誰に相談できるか」から、各エージェントの段を決める。
 *  相談される側は相談する側の下に置く＝上位ほど上、という並びになる。 */
function agentDepth() {
  // 出発点は部署の階層。そのうえで、相談関係が下向きになるよう押し下げる。
  const depth = new Map(draft.agents.map((a) => [a.id, deptDepth(a.dept)]));
  // 相談関係は入れ子になりうるので、変化がなくなるまで押し下げる。
  // 設定次第で循環しうるため、回数で必ず止める。
  for (let pass = 0; pass < draft.agents.length; pass++) {
    let moved = false;
    for (const agent of draft.agents) {
      for (const target of agent.consults) {
        if (!depth.has(target)) continue;
        const want = depth.get(agent.id) + 1;
        if (depth.get(target) < want) {
          depth.set(target, want);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return depth;
}

function buildOrgRows() {
  const depth = agentDepth();
  const rows = [];
  const put = (level, node) => {
    while (rows.length <= level) rows.push([]);
    rows[level].push(node);
  };

  put(0, { id: "__boss__", kind: "boss", name: "社長", caption: "あなた", sprite: null });

  for (const agent of draft.agents) {
    put(depth.get(agent.id) + 1, {
      id: agent.id, kind: "agent", name: agent.name,
      caption: `${agent.dept}・${agent.role}`, sprite: agent.sprite,
    });
  }

  // 部下は、その部下を使う上司の1つ下に置く。複数の上司がいるなら一番下に合わせる。
  const bossLevel = new Map();
  const primaryBoss = new Map();
  for (const agent of draft.agents) {
    for (const name of agent.subagents) {
      const level = depth.get(agent.id) + 1;
      if (level > (bossLevel.get(name) ?? -1)) {
        bossLevel.set(name, level);
        primaryBoss.set(name, agent.id);
      }
    }
  }
  const unassigned = [];
  for (const sub of draftSubagents) {
    const node = { id: `sub:${sub.name}`, kind: "sub", name: sub.name,
                   caption: sub.dept, sprite: sub.sprite };
    if (bossLevel.has(sub.name)) put(bossLevel.get(sub.name) + 1, node);
    else unassigned.push(node);
  }

  // 各ノードの「配置上の親」。1人が複数の上司を持てるので、線は全部引きつつ
  // 位置決めはこの親だけを見る。そうしないと同じ人を何箇所にも置くことになる。
  const parentOf = new Map();
  const consulted = new Map();
  for (const agent of draft.agents) {
    for (const target of agent.consults) {
      if (!consulted.has(target)) consulted.set(target, agent.id);
    }
  }
  for (const agent of draft.agents) {
    parentOf.set(agent.id, consulted.get(agent.id) ?? "__boss__");
  }
  for (const [name, boss] of primaryBoss) parentOf.set(`sub:${name}`, boss);

  return { rows, unassigned, parentOf };
}

/** 子を親の真下に集める。横位置だけを決め、段はそのまま使う。
 *
 *  段ごとに左から詰めるだけだと、誰が誰の下にいるのか線を目で追うしかない。
 *  葉から順に幅を確保し、親をその中央へ寄せると、線が交差しにくくなる。 */
function tidyPositions(rows, parentOf) {
  const children = new Map();
  for (const row of rows) {
    for (const node of row) {
      const parent = parentOf.get(node.id);
      if (!parent) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(node.id);
    }
  }

  const slot = CHART.w + CHART.gapX;
  const centerX = new Map();
  let nextLeaf = 0;

  // 相談関係は循環しうる（互いを相談先にするなど）。たどっている途中の
  // ものを覚えておかないと、親子をぐるぐる回って再帰が止まらなくなる。
  const visiting = new Set();

  const place = (id) => {
    if (centerX.has(id) || visiting.has(id)) return;
    visiting.add(id);

    const kids = (children.get(id) || []).filter((k) => k !== id && !visiting.has(k));
    for (const kid of kids) place(kid);

    const placed = kids.map((k) => centerX.get(k)).filter((v) => v !== undefined);
    if (placed.length) {
      centerX.set(id, (Math.min(...placed) + Math.max(...placed)) / 2);
    } else {
      centerX.set(id, nextLeaf * slot + CHART.w / 2);
      nextLeaf += 1;
    }
    visiting.delete(id);
  };

  // 親を持たないものが根。循環していても、置き終えたものは二度置かない。
  for (const row of rows) {
    for (const node of row) {
      if (centerX.has(node.id)) continue;
      const parent = parentOf.get(node.id);
      if (!parent || !rows.some((r) => r.some((n) => n.id === parent))) place(node.id);
    }
  }
  for (const row of rows) {
    for (const node of row) if (!centerX.has(node.id)) place(node.id);
  }
  return centerX;
}

function renderOrgChart(el) {
  const { rows, unassigned, parentOf } = buildOrgRows();
  const centerX = tidyPositions(rows, parentOf);

  // 位置を先に決めてから、箱と線の両方をその座標で描く。
  const pos = new Map();
  let widest = 0;
  rows.forEach((row, level) => {
    for (const node of row) {
      const x = CHART.pad + (centerX.get(node.id) ?? 0) - CHART.w / 2;
      pos.set(node.id, { x, y: CHART.pad + level * (CHART.h + CHART.gapY), node });
      widest = Math.max(widest, x + CHART.w);
    }
  });

  const edges = [];
  const topAgents = rows[1] || [];
  for (const node of topAgents) edges.push(["__boss__", node.id, "lead"]);
  for (const agent of draft.agents) {
    for (const target of agent.consults) {
      if (pos.has(target)) edges.push([agent.id, target, "lead"]);
    }
    for (const name of agent.subagents) {
      if (pos.has(`sub:${name}`)) edges.push([agent.id, `sub:${name}`, "sub"]);
    }
  }

  const totalW = widest + CHART.pad;
  const totalH = CHART.pad * 2 + rows.length * CHART.h + (rows.length - 1) * CHART.gapY;

  // 選んだノードにつながる線だけを強調して、関係を追いやすくする。
  const paths = edges.map(([from, to, kind]) => {
    const a = pos.get(from), b = pos.get(to);
    if (!a || !b) return "";
    const x1 = a.x + CHART.w / 2, y1 = a.y + CHART.h;
    const x2 = b.x + CHART.w / 2, y2 = b.y;
    const mid = y1 + (y2 - y1) / 2;
    const lit = chartSelection && (from === chartSelection || to === chartSelection);
    const dim = chartSelection && !lit;
    return `<path class="org-edge ${kind}${lit ? " lit" : ""}${dim ? " dim" : ""}"
      d="M${x1} ${y1} V${mid} H${x2} V${y2}" />`;
  }).join("");

  const boxes = [...pos.values()].map(({ x, y, node }) => `
    <div class="org-node ${node.kind}${node.id === chartSelection ? " selected" : ""}"
         style="left:${x}px; top:${y}px; width:${CHART.w}px; height:${CHART.h}px"
         data-node="${escapeHtml(node.id)}">
      ${node.sprite ? `<div class="org-sprite" style="background-image:url('assets/characters/${escapeHtml(node.sprite)}')"></div>`
                    : '<div class="org-sprite org-crown">👑</div>'}
      <div class="org-name">${escapeHtml(node.name)}</div>
      <div class="org-caption">${escapeHtml(node.caption)}</div>
    </div>`).join("");

  const strays = unassigned.length ? `
    <div class="org-strays">
      <h4>どの上司にも割り当てられていない部下</h4>
      <div class="chip-row">${unassigned.map((n) => `
        <span class="chip" data-node="${escapeHtml(n.id)}">
          <span class="chip-sprite" style="background-image:url('assets/characters/${escapeHtml(n.sprite)}')"></span>
          ${escapeHtml(n.name)}
        </span>`).join("")}</div>
    </div>` : "";

  // 描き直しでスクロール位置が戻ると、図の同じ場所を見失う。
  const keepScroll = el.querySelector(".org-scroll");
  const scroll = keepScroll ? { x: keepScroll.scrollLeft, y: keepScroll.scrollTop } : null;

  el.innerHTML = `
    <section class="edit-section">
      <h3>組織図</h3>
      <p class="hint">上にいるほど上位です。ノードを選ぶと、右の欄で関係性をその場で変更できます。</p>
      <div class="org-legend">
        <span><i class="org-key lead"></i>指示・相談できる</span>
        <span><i class="org-key sub"></i>部下として呼べる</span>
      </div>
      <div class="org-layout">
        <div class="org-scroll">
          <div class="org-chart" style="width:${totalW}px; height:${totalH}px">
            <svg width="${totalW}" height="${totalH}">${paths}</svg>
            ${boxes}
          </div>
        </div>
        <aside class="org-panel">${orgPanelHtml(pos)}</aside>
      </div>
      ${strays}
    </section>`;

  const scroller = el.querySelector(".org-scroll");
  if (scroll) { scroller.scrollLeft = scroll.x; scroller.scrollTop = scroll.y; }

  for (const box of el.querySelectorAll(".org-node[data-node]")) {
    const id = box.dataset.node;
    if (id === "__boss__") continue;
    box.classList.add("clickable");
    box.addEventListener("click", () => {
      chartSelection = chartSelection === id ? null : id;
      renderSettingsEditor();
    });
  }

  wireOrgPanel(el);
}

function orgPanelHtml(pos) {
  if (!chartSelection || !pos.has(chartSelection)) {
    return `<p class="hint">図のノードを選ぶと、ここで部下や相談先を付け外しできます。</p>`;
  }
  const { node } = pos.get(chartSelection);

  if (node.kind === "sub") {
    const rows = draft.agents.map((a) => `
      <label class="check-row compact">
        <input type="checkbox" data-org-boss="${escapeHtml(a.id)}"${
          a.subagents.includes(node.name) ? " checked" : ""} />
        <span class="check-name">${escapeHtml(a.name)}</span>
      </label>`).join("");
    return `${orgPanelHead(node)}
      <h4>この部下を呼べる上司</h4>
      <div class="check-list">${rows}</div>`;
  }

  const agent = draft.agents.find((a) => a.id === node.id);
  if (!agent) return orgPanelHead(node);

  const subs = draftSubagents.map((s) => `
    <label class="check-row compact">
      <input type="checkbox" data-org-sub="${escapeHtml(s.name)}"${
        agent.subagents.includes(s.name) ? " checked" : ""} />
      <span class="check-name">${escapeHtml(s.name)}</span>
      <span class="check-desc">${escapeHtml(s.dept)}</span>
    </label>`).join("") || '<p class="hint">部下がいません。</p>';

  const peers = draft.agents.filter((a) => a.id !== agent.id).map((a) => `
    <label class="check-row compact">
      <input type="checkbox" data-org-consult="${escapeHtml(a.id)}"${
        agent.consults.includes(a.id) ? " checked" : ""} />
      <span class="check-name">${escapeHtml(a.name)}</span>
      <span class="check-desc">${escapeHtml(a.dept)}</span>
    </label>`).join("") || '<p class="hint">他にエージェントがいません。</p>';

  return `${orgPanelHead(node)}
    <h4>部下として呼べる</h4>
    <div class="check-list">${subs}</div>
    <h4>指示・相談できる相手</h4>
    <div class="check-list">${peers}</div>`;
}

function orgPanelHead(node) {
  return `
    <div class="org-panel-head">
      <div class="nav-sprite" style="background-image:url('assets/characters/${escapeHtml(node.sprite)}')"></div>
      <div class="nav-text">
        <span class="nav-name">${escapeHtml(node.name)}</span>
        <span class="nav-dept">${escapeHtml(node.caption)}</span>
      </div>
    </div>
    <button type="button" class="btn-ghost btn-small" data-org-open>設定を開く</button>`;
}

function wireOrgPanel(el) {
  const id = chartSelection;
  if (!id) return;
  const agent = draft.agents.find((a) => a.id === id);
  const subName = id.startsWith("sub:") ? id.slice(4) : null;

  for (const box of el.querySelectorAll("[data-org-sub]")) {
    box.addEventListener("change", () => {
      agent.subagents = toggleIn(agent.subagents, box.dataset.orgSub, box.checked);
      renderSettingsEditor();
    });
  }
  for (const box of el.querySelectorAll("[data-org-consult]")) {
    box.addEventListener("change", () => {
      agent.consults = toggleIn(agent.consults, box.dataset.orgConsult, box.checked);
      renderSettingsEditor();
    });
  }
  for (const box of el.querySelectorAll("[data-org-boss]")) {
    box.addEventListener("change", () => {
      const boss = draft.agents.find((a) => a.id === box.dataset.orgBoss);
      boss.subagents = toggleIn(boss.subagents, subName, box.checked);
      renderSettingsEditor();
    });
  }

  const open = el.querySelector("[data-org-open]");
  if (open) {
    open.addEventListener("click", () => {
      if (subName) {
        selectedSubagent = draftSubagents.findIndex((s) => s.name === subName);
        selectedKey = SUBAGENTS_KEY;
      } else {
        selectedKey = id;
      }
      renderSettings();
    });
  }
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
      <p class="hint">まだ部下がいません。左の「＋ サブエージェントを追加」から作成できます。</p>
    </section>`;
    return;
  }

  selectedSubagent = Math.min(selectedSubagent, draftSubagents.length - 1);
  const sub = draftSubagents[selectedSubagent];

  el.innerHTML = `
    <section class="edit-section">
      <p class="hint">実体は <code>.claude/agents/*.md</code>（Claude Code標準のサブエージェント定義）です。</p>
      <div class="field-grid">
        <label class="field"><span>名前</span>
          <input type="text" data-sub-field="name" value="${escapeHtml(sub.name)}" maxlength="40" /></label>
        <label class="field"><span>部署</span>
          ${deptSelectHtml(sub.dept, "data-sub-dept")}
          <small class="hint">同じ部署の上司には、この部下が最初から開いた状態で出ます。</small></label>
      </div>
      <label class="field"><span>説明（どんなときに呼ぶか）</span>
        <textarea class="soul-input" data-sub-field="description" rows="3"
          placeholder="この部下をいつ使うべきかを書きます。上司がこの文章を見て呼び出しを判断します。">${escapeHtml(sub.description)}</textarea></label>
    </section>

    <section class="edit-section">
      <h3>できること（ツール）</h3>
      ${toolChecklistHtml(sub)}
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

  el.querySelector("#subagent-delete").addEventListener("click", () => deleteSubagent(sub));

  for (const input of el.querySelectorAll("[data-sub-field]")) {
    input.addEventListener("input", () => {
      const field = input.dataset.subField;
      if (field === "name") {
        renameSubagent(sub, input.value);
        // 左のリストにも名前が出ている。組み直すとフォーカスを失うので直接書き換える。
        const label = document.querySelector(`[data-nav-sub="${selectedSubagent}"]`);
        if (label) label.textContent = input.value;
        return;
      }
      sub[field] = input.value;
    });
  }

  wireDeptSelect(el.querySelector("[data-sub-dept]"), (dept) => {
    sub.dept = dept;
    renderSettings();
  });

  for (const box of el.querySelectorAll("[data-tool]")) {
    box.addEventListener("change", () => {
      const selected = new Set(toolList(sub));
      if (box.checked) selected.add(box.dataset.tool);
      else selected.delete(box.dataset.tool);
      sub.tools = [...selected].join(", ");
      // 「全部選択なし＝全ツール」の注意書きを出し入れするため、
      // 0件との境目をまたいだときだけ描き直す。
      const crossedZero = selected.size === 0 || selected.size === 1;
      if (crossedZero) renderSettingsEditor();
    });
  }

  wireSpritePreview(el, sub.sprite, (sprite) => {
    sub.sprite = sprite;
    renderSettings();
  });
}

function toolList(sub) {
  return String(sub.tools || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function toolChecklistHtml(sub) {
  const selected = new Set(toolList(sub));
  // カタログに無いもの（MCPツールなど）は、こちらで扱えなくても消さずに預かる。
  const extras = [...selected].filter((t) => !KNOWN_TOOLS.has(t));

  const groups = TOOL_CATALOG.map((g) => `
    <h4>${escapeHtml(g.group)}</h4>
    <div class="check-list">${g.tools.map((t) => `
      <label class="check-row">
        <input type="checkbox" data-tool="${escapeHtml(t.name)}"${selected.has(t.name) ? " checked" : ""} />
        <span class="check-name">${escapeHtml(t.label)}</span>
        <span class="check-desc">${escapeHtml(t.desc)}</span>
      </label>`).join("")}</div>`).join("");

  const extraNote = extras.length
    ? `<p class="hint">この一覧に無い設定も預かっています（保存時にそのまま残します）:
       <code>${escapeHtml(extras.join(", "))}</code></p>`
    : "";

  // 「1つも選ばない＝全部使える」は直感に反するので、その状態のときだけ強く出す。
  const inheritNote = selected.size === 0
    ? `<p class="warn">1つも選んでいないので、この部下は<strong>すべてのツールを使えます</strong>。
       絞りたい場合は必要なものにチェックを入れてください。</p>`
    : "";

  return inheritNote + groups + extraNote;
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
    // いま見ているエージェントの部署に入れておく。多くの場合その上司の部下として作るため。
    dept: (draft.agents.find((a) => a.id === selectedKey) || {}).dept || UNASSIGNED_DEPT,
  });
  selectedKey = SUBAGENTS_KEY;
  selectedSubagent = draftSubagents.length - 1;
  setSettingsStatus("");
  renderSettings();
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
  renderSettings();
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
      const used = draft.agents.filter((a) => (a.projects || []).includes(key));
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

  el.querySelector("#project-add").addEventListener("click", () => {
    let n = 1;
    while (draft.projects[`project${n}`]) n += 1;
    const key = `project${n}`;
    draft.projects[key] = { name: `新しいプロジェクト${n}`, path: "." };
    renderSettingsEditor();

    // 行を足すだけにして、フォルダ選択は「参照…」を押したときだけ開く。
    // 追加した瞬間にOSのダイアログが出ると、名前を入れる前に手が止まる。
    const row = el.querySelector(`.project-row[data-project="${key}"]`);
    if (row) row.querySelector('[data-project-field="name"]').focus();
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
    projects: [Object.keys(draft.projects)[0]],
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

  // 部下の見た目と所属は名前をキーに持つので、改名にも追随するよう毎回組み直す。
  draft.subagents = Object.fromEntries(draftSubagents.map((s) =>
    [s.name, { sprite: s.sprite, dept: s.dept || UNASSIGNED_DEPT }]));

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
    // 保存結果を正としてやり直す。サーバー側で名前や所属が整えられることが
    // あるので、そのまま編集を続けると画面と実体がずれる。
    office = await fetchOffice();
    const keepKey = selectedKey;
    const keepSub = selectedSubagent;
    startEditing();
    selectedKey = keepKey;
    selectedSubagent = keepSub;
    renderSettings();
    dirty = false;
    setSettingsStatus("保存しました。");
    return;
  } catch (e) {
    setSettingsStatus(`保存エラー: ${e.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function initSettings() {
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("sprite-close").addEventListener("click", closeSpritePicker);
  document.getElementById("sprite-modal").addEventListener("click", (e) => {
    if (e.target.id === "sprite-modal") closeSpritePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSpritePicker();
  });

  // 保存していない変更を持ったままページを離れると、静かに消えてしまう。
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  try {
    office = await fetchOffice();
    startEditing();
  } catch (err) {
    document.getElementById("settings-subtitle").textContent =
      `設定を読み込めません: ${err.message}`;
  }
}

initSettings();

