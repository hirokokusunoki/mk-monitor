// ============================================================
// partners.js — MK Partner DB + Team Builder
// require('./partners')(app) を index.js に追加するだけで動く
// ============================================================

const fs   = require("fs");
const path = require("path");

// ─── データ読み込み ─────────────────────────────────────────────────────────────

const DATA_FILE  = path.join(__dirname, "partners_data.json");
const TEAMS_FILE = path.join(__dirname, "teams_data.json");

let partners = [];
let teams    = {};   // { noticeId: { noticeTitle, noticeUrl, members: [{partnerId, role}] } }

function loadPartners() {
  try {
    partners = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    console.log(`✅ Partner DB: ${partners.length} partenaires chargés`);
  } catch (e) {
    console.warn("⚠️  partners_data.json introuvable — DB vide");
    partners = [];
  }
}

function loadTeams() {
  try {
    teams = JSON.parse(fs.readFileSync(TEAMS_FILE, "utf-8"));
  } catch (e) {
    teams = {};
  }
}

function saveTeams() {
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2), "utf-8");
}

function savePartners() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(partners, null, 2), "utf-8");
}

loadPartners();
loadTeams();

// ─── スコア計算 ──────────────────────────────────────────────────────────────────

function calcScore(p) {
  const evalScore = { "★★★": 15, "★★": 10, "★": 5, "": 0 }[p.evaluation] || 0;
  const recence   = p.derniere_collab
    ? Math.max(0, 10 - (new Date().getFullYear() - parseInt(p.derniere_collab)) * 2)
    : 0;
  return (p.nb_collabs * 10) + evalScore + recence;
}

// ─── 全専門カテゴリ一覧 ──────────────────────────────────────────────────────────

function getAllSpecialties() {
  const set = new Set();
  partners.forEach(p => p.specialites.forEach(s => set.add(s)));
  return [...set].sort();
}

// ─── ユーティリティ ─────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

// ─── ルート登録 ─────────────────────────────────────────────────────────────────

module.exports = function(app) {

  // ── API: パートナー検索 ────────────────────────────────────────────────────────
  app.get("/api/partners", (req, res) => {
    const { q = "", specialty = "", pays = "", min_score = 0 } = req.query;
    const ql = q.toLowerCase();

    let results = partners.filter(p => {
      if (specialty && !p.specialites.includes(specialty)) return false;
      if (pays && p.pays !== pays) return false;
      if (p.score < parseInt(min_score)) return false;
      if (ql && !p.nom.toLowerCase().includes(ql) && !p.ville.toLowerCase().includes(ql)) return false;
      return true;
    });

    // 親和性スコア降順
    results.sort((a, b) => b.score - a.score);

    res.json({ count: results.length, results: results.slice(0, 100) });
  });

  // ── API: パートナー更新（評価・スコア・排他性） ──────────────────────────────────
  app.post("/api/partners/:id/update", (req, res) => {
    const id = parseInt(req.params.id);
    const p  = partners.find(x => x.id === id);
    if (!p) return res.status(404).json({ error: "Not found" });

    const allowed = ["evaluation","nb_collabs","derniere_collab","exclusivite","amo_client","notes","kbis_echeance","urssaf_echeance","statut_docs"];
    allowed.forEach(k => { if (req.body[k] !== undefined) p[k] = req.body[k]; });
    p.score = calcScore(p);

    savePartners();
    res.json({ ok: true, partner: p });
  });

  // ── API: チーム保存 ───────────────────────────────────────────────────────────
  app.post("/api/team/save", (req, res) => {
    const { noticeId, noticeTitle, noticeUrl, members } = req.body;
    if (!noticeId) return res.status(400).json({ error: "noticeId required" });

    teams[noticeId] = {
      noticeTitle, noticeUrl,
      savedAt: new Date().toISOString(),
      members: members || [],
    };
    saveTeams();

    // 協業回数を自動インクリメント
    (members || []).forEach(m => {
      const p = partners.find(x => x.id === m.partnerId);
      if (p) {
        p.nb_collabs += 1;
        p.derniere_collab = String(new Date().getFullYear());
        p.score = calcScore(p);
      }
    });
    savePartners();

    res.json({ ok: true });
  });

  // ── API: チーム取得 ───────────────────────────────────────────────────────────
  app.get("/api/team/:noticeId", (req, res) => {
    res.json(teams[req.params.noticeId] || null);
  });

  // ── Partner DB ページ ─────────────────────────────────────────────────────────
  app.get("/partners", (req, res) => {
    const specialties = getAllSpecialties();
    const pays_list   = [...new Set(partners.map(p => p.pays))].sort();

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MK — Partner DB</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f0efed;min-height:100vh}
  .header{background:#0f172a;padding:20px 32px}
  .header-sub{font-size:9px;color:#475569;letter-spacing:.2em;text-transform:uppercase;margin-bottom:6px}
  .header-title{font-size:18px;font-weight:300;color:#f1f5f9;letter-spacing:.15em;text-transform:uppercase}
  .header-nav{margin-top:12px;display:flex;gap:12px}
  .nav-link{font-size:10px;color:#94a3b8;text-decoration:none;letter-spacing:.1em;text-transform:uppercase;padding:4px 0;border-bottom:1px solid transparent}
  .nav-link:hover,.nav-link.active{color:#f1f5f9;border-bottom-color:#3b82f6}
  .content{max-width:1100px;margin:0 auto;padding:24px 32px}
  .filters{background:white;border:1px solid #e5e7eb;border-radius:4px;padding:16px 20px;margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
  .filter-group{display:flex;flex-direction:column;gap:4px}
  .filter-group label{font-size:10px;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;font-weight:500}
  input,select{font-size:12px;padding:6px 10px;border:1px solid #d1d5db;border-radius:3px;background:white;color:#111827;outline:none}
  input:focus,select:focus{border-color:#3b82f6}
  .btn{font-size:11px;padding:7px 14px;border:none;border-radius:3px;cursor:pointer;font-weight:500;letter-spacing:.05em}
  .btn-primary{background:#0f172a;color:white}.btn-primary:hover{background:#1e293b}
  .btn-ghost{background:#f1f5f9;color:#374151}.btn-ghost:hover{background:#e5e7eb}
  .results-count{font-size:11px;color:#6b7280;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;background:white;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden;font-size:12px}
  th{background:#f8fafc;font-size:9px;font-weight:600;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb}
  td{padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;color:#374151}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  .badge{display:inline-block;font-size:9px;padding:2px 6px;border-radius:3px;font-weight:500;margin-right:3px;margin-bottom:2px}
  .excl{background:#fee2e2;color:#dc2626;font-weight:700}
  .score-bar{display:inline-block;height:4px;background:#3b82f6;border-radius:2px;min-width:2px}
  .eval-stars{color:#f59e0b}
  .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
  .modal.open{display:flex}
  .modal-box{background:white;border-radius:6px;padding:28px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto}
  .modal-title{font-size:14px;font-weight:600;color:#111827;margin-bottom:16px}
  .form-row{margin-bottom:12px}
  .form-row label{display:block;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px;font-weight:500}
  .form-row input,.form-row select,.form-row textarea{width:100%;font-size:12px;padding:7px 10px;border:1px solid #d1d5db;border-radius:3px;color:#111827}
  .form-row textarea{resize:vertical;min-height:60px}
  .warn{color:#dc2626;font-size:11px;margin-top:4px}
</style>
</head>
<body>
<div class="header">
  <div style="max-width:1100px;margin:0 auto">
    <div class="header-sub">Moreau Kusunoki Architectes — MK Monitor</div>
    <div class="header-title">🗃 Partner DB</div>
    <div class="header-nav">
      <a href="/dashboard" class="nav-link">Projets suivis</a>
      <a href="/partners" class="nav-link active">Partner DB</a>
    </div>
  </div>
</div>

<div class="content">
  <div class="filters">
    <div class="filter-group" style="flex:2;min-width:180px">
      <label>Recherche</label>
      <input id="q" type="text" placeholder="Nom, ville…" oninput="search()">
    </div>
    <div class="filter-group" style="flex:2;min-width:200px">
      <label>Spécialité</label>
      <select id="specialty" onchange="search()">
        <option value="">— Toutes —</option>
        ${specialties.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
    </div>
    <div class="filter-group">
      <label>Pays</label>
      <select id="pays" onchange="search()">
        <option value="">— Tous —</option>
        ${pays_list.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}
      </select>
    </div>
    <div class="filter-group">
      <label>Score min.</label>
      <select id="min_score" onchange="search()">
        <option value="0">Tous</option>
        <option value="10">≥ 10 (1 collab.)</option>
        <option value="20">≥ 20 (2+ collabs)</option>
        <option value="30">≥ 30 (prioritaire)</option>
      </select>
    </div>
    <button class="btn btn-ghost" onclick="resetFilters()">Réinitialiser</button>
  </div>

  <div class="results-count" id="count">…</div>

  <div style="overflow-x:auto">
  <table>
    <thead>
      <tr>
        <th style="width:30px"></th>
        <th>Nom</th>
        <th>Spécialité(s)</th>
        <th>Ville / Pays</th>
        <th>Contact</th>
        <th>Score MK</th>
        <th>Éval.</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="tbody">
      <tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af">Chargement…</td></tr>
    </tbody>
  </table>
  </div>
</div>

<!-- Modal édition -->
<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-title" id="modal-title">Éditer partenaire</div>
    <input type="hidden" id="edit-id">

    <div class="form-row" style="background:#fef2f2;padding:10px;border-radius:4px;border:1px solid #fecaca;margin-bottom:16px">
      <label>⚠️ Exclusivité / Concurrence</label>
      <textarea id="edit-exclusivite" rows="2" placeholder="Ex : Lié à l'agence XYZ pour les concours en Île-de-France"></textarea>
    </div>

    <div class="form-row">
      <label>AMO / Programmiste côté client</label>
      <input id="edit-amo" type="text" placeholder="Ex : ABC Programmation — auteur du programme de l'opération Y">
    </div>
    <div class="form-row">
      <label>Évaluation MK</label>
      <select id="edit-eval">
        <option value="">Non évalué</option>
        <option value="★">★</option>
        <option value="★★">★★</option>
        <option value="★★★">★★★</option>
      </select>
    </div>
    <div class="form-row">
      <label>Nombre de collaborations</label>
      <input id="edit-collabs" type="number" min="0">
    </div>
    <div class="form-row">
      <label>Dernière collaboration (année)</label>
      <input id="edit-annee" type="number" min="2000" max="2099" placeholder="ex: 2024">
    </div>
    <div class="form-row">
      <label>Kbis — date d'échéance</label>
      <input id="edit-kbis" type="date">
    </div>
    <div class="form-row">
      <label>URSSAF — date d'échéance</label>
      <input id="edit-urssaf" type="date">
    </div>
    <div class="form-row">
      <label>Statut documents</label>
      <select id="edit-statut-docs">
        <option value="À vérifier">À vérifier</option>
        <option value="OK">✅ OK</option>
        <option value="⚠️ À renouveler">⚠️ À renouveler</option>
        <option value="❌ Expiré">❌ Expiré</option>
      </select>
    </div>
    <div class="form-row">
      <label>Notes / Points forts</label>
      <textarea id="edit-notes" rows="3"></textarea>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-primary" onclick="saveEdit()">Enregistrer</button>
      <button class="btn btn-ghost" onclick="closeModal()">Annuler</button>
    </div>
  </div>
</div>

<script>
let allResults = [];
let debounceTimer;

function search() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 250);
}

async function doSearch() {
  const q         = document.getElementById("q").value.trim();
  const specialty = document.getElementById("specialty").value;
  const pays      = document.getElementById("pays").value;
  const min_score = document.getElementById("min_score").value;

  const params = new URLSearchParams({ q, specialty, pays, min_score });
  const res    = await fetch("/api/partners?" + params);
  const data   = await res.json();
  allResults   = data.results;

  document.getElementById("count").textContent =
    data.count + " partenaire" + (data.count !== 1 ? "s" : "") +
    (data.count > 100 ? " (100 affichés)" : "");

  renderTable(allResults);
}

function renderTable(rows) {
  const tbody = document.getElementById("tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#9ca3af">Aucun résultat</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(p => {
    const excl = p.exclusivite
      ? '<div style="font-size:10px;background:#fee2e2;color:#dc2626;padding:3px 6px;border-radius:3px;margin-top:4px;font-weight:600">⚠️ ' + esc(p.exclusivite.slice(0,60)) + (p.exclusivite.length>60?"…":"") + '</div>'
      : '';
    const amo = p.amo_client
      ? '<div style="font-size:10px;background:#fef3c7;color:#92400e;padding:3px 6px;border-radius:3px;margin-top:4px">🔔 AMO client: ' + esc(p.amo_client.slice(0,60)) + '</div>'
      : '';
    const specs = p.specialites.slice(0,3).map(s =>
      '<span class="badge" style="background:#f0f9ff;color:#0369a1">' + esc(s) + '</span>'
    ).join("") + (p.specialites.length > 3 ? '<span class="badge" style="background:#f3f4f6;color:#6b7280">+' + (p.specialites.length-3) + '</span>' : '');

    const scoreW = Math.min(p.score * 2, 100);
    const docBadge = p.statut_docs !== "À vérifier" && p.statut_docs !== "OK"
      ? '<span style="font-size:9px;color:#dc2626"> ' + esc(p.statut_docs) + '</span>' : '';

    return '<tr>' +
      '<td style="color:#9ca3af;font-size:10px">#' + p.id + '</td>' +
      '<td><div style="font-weight:500;color:#111827">' + esc(p.nom) + '</div>' + excl + amo + docBadge + '</td>' +
      '<td>' + specs + '</td>' +
      '<td style="font-size:11px">' + esc(p.ville) + '<br><span style="color:#9ca3af">' + esc(p.pays) + '</span></td>' +
      '<td style="font-size:11px">' + (p.contact ? esc(p.contact) + '<br>' : '') + '<a href="mailto:' + esc(p.email) + '" style="color:#2563eb">' + esc(p.email) + '</a></td>' +
      '<td><div style="display:flex;align-items:center;gap:6px"><div class="score-bar" style="width:' + scoreW + 'px"></div><span style="font-size:11px;color:#374151">' + p.score + '</span></div><div style="font-size:10px;color:#9ca3af">' + p.nb_collabs + ' collab.</div></td>' +
      '<td class="eval-stars">' + (p.evaluation || '<span style="color:#d1d5db">—</span>') + '</td>' +
      '<td><button class="btn btn-ghost" style="font-size:10px;padding:4px 10px" onclick="openModal(' + p.id + ')">Éditer</button></td>' +
      '</tr>';
  }).join("");
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function resetFilters() {
  document.getElementById("q").value = "";
  document.getElementById("specialty").value = "";
  document.getElementById("pays").value = "";
  document.getElementById("min_score").value = "0";
  doSearch();
}

function openModal(id) {
  const p = allResults.find(x => x.id === id);
  if (!p) return;
  document.getElementById("edit-id").value         = id;
  document.getElementById("modal-title").textContent = p.nom;
  document.getElementById("edit-exclusivite").value  = p.exclusivite || "";
  document.getElementById("edit-amo").value           = p.amo_client || "";
  document.getElementById("edit-eval").value          = p.evaluation || "";
  document.getElementById("edit-collabs").value       = p.nb_collabs || 0;
  document.getElementById("edit-annee").value         = p.derniere_collab || "";
  document.getElementById("edit-kbis").value          = p.kbis_echeance || "";
  document.getElementById("edit-urssaf").value        = p.urssaf_echeance || "";
  document.getElementById("edit-statut-docs").value   = p.statut_docs || "À vérifier";
  document.getElementById("edit-notes").value         = p.notes || "";
  document.getElementById("modal").classList.add("open");
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
}

async function saveEdit() {
  const id = parseInt(document.getElementById("edit-id").value);
  const body = {
    exclusivite:   document.getElementById("edit-exclusivite").value,
    amo_client:    document.getElementById("edit-amo").value,
    evaluation:    document.getElementById("edit-eval").value,
    nb_collabs:    parseInt(document.getElementById("edit-collabs").value) || 0,
    derniere_collab: document.getElementById("edit-annee").value,
    kbis_echeance: document.getElementById("edit-kbis").value,
    urssaf_echeance:document.getElementById("edit-urssaf").value,
    statut_docs:   document.getElementById("edit-statut-docs").value,
    notes:         document.getElementById("edit-notes").value,
  };

  const res = await fetch("/api/partners/" + id + "/update", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.ok) {
    const idx = allResults.findIndex(x => x.id === id);
    if (idx >= 0) allResults[idx] = data.partner;
    renderTable(allResults);
    closeModal();
  }
}

document.getElementById("modal").addEventListener("click", e => {
  if (e.target === document.getElementById("modal")) closeModal();
});

// 初回ロード
doSearch();
</script>
</body>
</html>`);
  });

  // ── Team Builder ページ ─────────────────────────────────────────────────────────
  app.get("/team-builder", (req, res) => {
    const { noticeId = "", noticeTitle = "", noticeUrl = "" } = req.query;
    const specialties = getAllSpecialties();
    const saved = teams[noticeId] || null;

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MK — Team Builder</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f0efed;min-height:100vh}
  .header{background:#0f172a;padding:20px 32px}
  .header-sub{font-size:9px;color:#475569;letter-spacing:.2em;text-transform:uppercase;margin-bottom:6px}
  .header-title{font-size:18px;font-weight:300;color:#f1f5f9;letter-spacing:.15em;text-transform:uppercase}
  .notice-bar{background:#1e293b;padding:10px 32px;font-size:12px;color:#94a3b8;display:flex;gap:16px;align-items:center}
  .content{max-width:1200px;margin:0 auto;padding:24px 32px;display:grid;grid-template-columns:1fr 320px;gap:20px}
  .panel{background:white;border:1px solid #e5e7eb;border-radius:4px;padding:20px}
  .panel-title{font-size:11px;font-weight:600;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #f3f4f6}
  .spec-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
  .spec-chip{font-size:11px;padding:5px 10px;border-radius:3px;cursor:pointer;border:1px solid #d1d5db;background:white;color:#374151;transition:all .15s}
  .spec-chip.selected{background:#0f172a;color:white;border-color:#0f172a}
  .btn{font-size:11px;padding:7px 14px;border:none;border-radius:3px;cursor:pointer;font-weight:500}
  .btn-primary{background:#0f172a;color:white}.btn-primary:hover{background:#1e293b}
  .btn-ghost{background:#f1f5f9;color:#374151}.btn-ghost:hover{background:#e5e7eb}
  .btn-add{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font-size:10px;padding:4px 8px;border-radius:3px;cursor:pointer}
  .btn-add:hover{background:#d1fae5}
  .btn-added{background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;font-size:10px;padding:4px 8px;border-radius:3px;cursor:pointer}
  .partner-card{border:1px solid #e5e7eb;border-radius:4px;padding:12px 14px;margin-bottom:8px;background:white}
  .partner-card.has-excl{border-color:#fca5a5;background:#fff5f5}
  .partner-name{font-size:13px;font-weight:500;color:#111827}
  .partner-meta{font-size:11px;color:#6b7280;margin-top:2px}
  .excl-warn{font-size:10px;color:#dc2626;background:#fee2e2;padding:3px 7px;border-radius:3px;margin-top:6px;font-weight:600}
  .amo-note{font-size:10px;color:#92400e;background:#fef3c7;padding:3px 7px;border-radius:3px;margin-top:4px}
  .score-pill{display:inline-block;font-size:10px;padding:2px 6px;border-radius:10px;background:#dbeafe;color:#1d4ed8;font-weight:600}
  .team-member{border:1px solid #e5e7eb;border-radius:4px;padding:10px 12px;margin-bottom:6px;background:#f8fafc;display:flex;justify-content:space-between;align-items:center}
  .remove-btn{font-size:10px;color:#9ca3af;cursor:pointer;border:none;background:none;padding:0}.remove-btn:hover{color:#dc2626}
  .search-input{width:100%;font-size:12px;padding:7px 10px;border:1px solid #d1d5db;border-radius:3px;color:#111827;margin-bottom:12px}
  .save-btn{width:100%;padding:10px;background:#0f172a;color:white;border:none;border-radius:3px;font-size:12px;font-weight:500;cursor:pointer;margin-top:12px}
  .save-btn:hover{background:#1e293b}
  .saved-badge{font-size:10px;background:#d1fae5;color:#065f46;padding:3px 8px;border-radius:3px;margin-left:8px}
</style>
</head>
<body>
<div class="header">
  <div style="max-width:1200px;margin:0 auto">
    <div class="header-sub">Moreau Kusunoki Architectes — MK Monitor</div>
    <div class="header-title">👥 Team Builder</div>
  </div>
</div>
<div class="notice-bar">
  <span style="color:#64748b">Opération :</span>
  <span style="color:#e2e8f0;font-weight:500">${esc(noticeTitle || "— Sans titre —")}</span>
  ${noticeUrl ? `<a href="${esc(noticeUrl)}" target="_blank" style="color:#60a5fa;font-size:11px">→ Voir l'avis ↗</a>` : ""}
  ${saved ? `<span class="saved-badge">✅ Équipe enregistrée</span>` : ""}
</div>

<div class="content">
  <!-- Colonne gauche : recherche partenaires -->
  <div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-title">Filtrer par spécialité</div>
      <div class="spec-grid" id="spec-grid">
        ${specialties.map(s =>
          `<button class="spec-chip" onclick="toggleSpec(this,'${esc(s)}')">${esc(s)}</button>`
        ).join("")}
      </div>
      <input class="search-input" type="text" placeholder="Rechercher un nom, une ville…" oninput="onSearch(this.value)">
      <div style="font-size:11px;color:#6b7280" id="result-count">Sélectionnez des spécialités</div>
    </div>

    <div id="partner-list"></div>
  </div>

  <!-- Colonne droite : équipe en cours -->
  <div>
    <div class="panel" style="position:sticky;top:20px">
      <div class="panel-title">Équipe constituée <span id="team-count" style="color:#9ca3af">(0)</span></div>
      <div id="team-list">
        <div style="font-size:12px;color:#9ca3af;text-align:center;padding:20px 0">Ajoutez des partenaires →</div>
      </div>
      <button class="save-btn" onclick="saveTeam()">💾 Enregistrer l'équipe</button>
      <div style="font-size:10px;color:#9ca3af;margin-top:8px;text-align:center">L'enregistrement incrémente le score de collaboration de chaque partenaire.</div>
    </div>
  </div>
</div>

<script>
const NOTICE_ID    = ${JSON.stringify(noticeId)};
const NOTICE_TITLE = ${JSON.stringify(noticeTitle)};
const NOTICE_URL   = ${JSON.stringify(noticeUrl)};

let selectedSpecs = [];
let searchQuery   = "";
let allPartners   = [];
let team          = ${JSON.stringify(saved ? saved.members.map(m => {
    const p = partners.find(x => x.id === m.partnerId);
    return p ? { partnerId: p.id, nom: p.nom, specialites: p.specialites, role: m.role } : null;
  }).filter(Boolean) : [])};

function toggleSpec(el, spec) {
  const idx = selectedSpecs.indexOf(spec);
  if (idx >= 0) { selectedSpecs.splice(idx, 1); el.classList.remove("selected"); }
  else          { selectedSpecs.push(spec);      el.classList.add("selected"); }
  loadPartners();
}

function onSearch(val) {
  searchQuery = val;
  loadPartners();
}

async function loadPartners() {
  if (!selectedSpecs.length && !searchQuery) {
    document.getElementById("partner-list").innerHTML = "";
    document.getElementById("result-count").textContent = "Sélectionnez des spécialités";
    return;
  }

  const fetches = selectedSpecs.length
    ? selectedSpecs.map(s => fetch("/api/partners?specialty=" + encodeURIComponent(s) + "&q=" + encodeURIComponent(searchQuery)).then(r => r.json()))
    : [fetch("/api/partners?q=" + encodeURIComponent(searchQuery)).then(r => r.json())];

  const results = await Promise.all(fetches);

  // Merge & deduplicate, sort by score
  const seen = new Set();
  allPartners = [];
  results.forEach(r => r.results.forEach(p => {
    if (!seen.has(p.id)) { seen.add(p.id); allPartners.push(p); }
  }));
  allPartners.sort((a,b) => b.score - a.score);

  document.getElementById("result-count").textContent =
    allPartners.length + " partenaire" + (allPartners.length !== 1 ? "s" : "");

  renderPartners();
}

function renderPartners() {
  const inTeam = new Set(team.map(m => m.partnerId));
  document.getElementById("partner-list").innerHTML = allPartners.slice(0,50).map(p => {
    const added = inTeam.has(p.id);
    const specs = p.specialites.slice(0,2).map(s =>
      '<span style="font-size:9px;padding:1px 5px;border-radius:2px;background:#f0f9ff;color:#0369a1;margin-right:3px">' + esc(s) + '</span>'
    ).join("") + (p.specialites.length > 2 ? '<span style="font-size:9px;color:#9ca3af">+' + (p.specialites.length-2) + '</span>' : '');

    return '<div class="partner-card' + (p.exclusivite ? ' has-excl' : '') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
        '<div style="flex:1">' +
          '<div class="partner-name">' + esc(p.nom) + '</div>' +
          '<div class="partner-meta">' + esc(p.ville) + (p.pays !== "France" ? " · " + esc(p.pays) : "") + '</div>' +
          '<div style="margin-top:5px">' + specs + '</div>' +
          (p.exclusivite ? '<div class="excl-warn">⚠️ ' + esc(p.exclusivite.slice(0,80)) + '</div>' : '') +
          (p.amo_client ? '<div class="amo-note">🔔 AMO client : ' + esc(p.amo_client.slice(0,80)) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;padding-left:10px">' +
          '<span class="score-pill">' + p.score + '</span>' +
          '<div style="font-size:10px;color:#9ca3af;margin-top:3px">' + (p.evaluation || "—") + '</div>' +
          '<button class="' + (added ? 'btn-added' : 'btn-add') + '" style="margin-top:6px" onclick="' + (added ? 'removeFromTeam(' + p.id + ')' : 'addToTeam(' + p.id + ')') + '">' +
            (added ? '✓ Dans l\'équipe' : '+ Ajouter') +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

function addToTeam(id) {
  const p = allPartners.find(x => x.id === id);
  if (!p || team.find(m => m.partnerId === id)) return;
  team.push({ partnerId: id, nom: p.nom, specialites: p.specialites, role: "" });
  renderPartners();
  renderTeam();
}

function removeFromTeam(id) {
  team = team.filter(m => m.partnerId !== id);
  renderPartners();
  renderTeam();
}

function renderTeam() {
  document.getElementById("team-count").textContent = "(" + team.length + ")";
  if (!team.length) {
    document.getElementById("team-list").innerHTML =
      '<div style="font-size:12px;color:#9ca3af;text-align:center;padding:20px 0">Ajoutez des partenaires →</div>';
    return;
  }
  document.getElementById("team-list").innerHTML = team.map((m,i) =>
    '<div class="team-member">' +
      '<div>' +
        '<div style="font-size:12px;font-weight:500;color:#111827">' + esc(m.nom) + '</div>' +
        '<div style="font-size:10px;color:#6b7280">' + (m.specialites||[]).slice(0,1).join(", ") + '</div>' +
      '</div>' +
      '<button class="remove-btn" onclick="removeFromTeam(' + m.partnerId + ')" title="Retirer">✕</button>' +
    '</div>'
  ).join("");
}

async function saveTeam() {
  if (!team.length) { alert("Ajoutez au moins un partenaire."); return; }
  const res = await fetch("/api/team/save", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ noticeId: NOTICE_ID, noticeTitle: NOTICE_TITLE, noticeUrl: NOTICE_URL, members: team }),
  });
  const data = await res.json();
  if (data.ok) {
    alert("✅ Équipe enregistrée ! Les scores de collaboration ont été mis à jour.");
    window.location.reload();
  }
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Charger l'équipe sauvegardée si elle existe
renderTeam();
</script>
</body>
</html>`);
  });

  console.log("✅ Partner DB routes: /partners  /team-builder  /api/partners  /api/team/*");
};
