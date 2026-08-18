// オフィス画面と設定画面で共有する小物。
// 2ページに分かれたので、両方から使うものだけをここに置く。

const SUBAGENT_SPRITE_DEFAULT = "pipo-charachip001b.png";
// どの部署にも属していない部下の置き場所（officeconfig.py と揃える）。
const UNASSIGNED_DEPT = "未所属";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** /api/office をまとめて取得する。 */
async function fetchOffice() {
  const res = await fetch(`/api/office?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`設定の取得に失敗しました (${res.status})`);
  return res.json();
}
