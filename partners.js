// ============================================================
// partners.js — MK Partner DB + Team Builder
// ============================================================

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE  = path.join(DATA_DIR, "partners_data.json");
const TEAMS_FILE = path.join(DATA_DIR, "teams_data.json");
const SEED_FILE  = path.join(__dirname, "partners_data.json");

if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, DATA_FILE);
  console.log("✅ partners_data.json → Volume に初期コピー完了");
}

let partners = [];
let teams    = {};

function loadPartners() {
  try { partners = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); console.log(`✅ Partner DB: ${partners.length} partenaires chargés`); }
  catch(e) { console.warn("⚠️ partners_data.json introuvable"); partners = []; }
}
function loadTeams() { try { teams = JSON.parse(fs.readFileSync(TEAMS_FILE, "utf-8")); } catch(e) { teams = {}; } }
function saveTeams() { fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2)); }
function savePartners() { fs.writeFileSync(DATA_FILE, JSON.stringify(partners, null, 2)); }

loadPartners();
loadTeams();

function calcScore(p) {
  const e = {"★★★":15,"★★":10,"★":5,"":0}[p.evaluation]||0;
  const r = p.derniere_collab ? Math.max(0,10-(new Date().getFullYear()-parseInt(p.derniere_collab))*2) : 0;
  return (p.nb_collabs*10)+e+r;
}
function getAllSpecialties() { const s=new Set(); partners.forEach(p=>p.specialites.forEach(x=>s.add(x))); return [...s].sort(); }
function esc(s) { if(!s)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ── 共通CSS ──────────────────────────────────────────────────────────────────
const CSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#D9D8D6;min-height:100vh}
.mk-header{background:#fff;border-bottom:1px solid #c4c3c1;padding:28px 48px 0}
.mk-wordmark{font-size:26px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#1a1a1a;line-height:1}
.mk-sub{font-size:8px;font-weight:400;letter-spacing:0.28em;text-transform:uppercase;color:#676867;margin-top:6px}
.mk-nav{display:flex;margin-top:22px}
.mk-nav a{font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#676867;text-decoration:none;padding:9px 32px 9px 0;border-bottom:2px solid transparent}
.mk-nav a:hover{color:#1a1a1a}
.mk-nav a.active{color:#0016B4;border-bottom-color:#0016B4}
.mk-band{background:#676867;padding:9px 48px}
.mk-band-inner{max-width:1100px;margin:0 auto;font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#D9D8D6}
.mk-body{max-width:1100px;margin:0 auto;padding:28px 48px}
.mk-label{font-size:8px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#676867;border-bottom:1px solid #b8b7b5;padding-bottom:8px;margin-bottom:20px}
.mk-filters{background:#fff;border:1px solid #c4c3c1;padding:14px 18px;margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.mk-fg{display:flex;flex-direction:column;gap:4px}
.mk-fg label{font-size:8px;font-weight:700;color:#676867;letter-spacing:0.15em;text-transform:uppercase}
.mk-input{font-size:12px;padding:6px 9px;border:1px solid #c4c3c1;background:#fff;color:#1a1a1a;font-family:Arial,sans-serif;outline:none}
.mk-input:focus{border-color:#0016B4}
.mk-select{font-size:12px;padding:6px 9px;border:1px solid #c4c3c1;background:#fff;color:#1a1a1a;font-family:Arial,sans-serif;outline:none}
.mk-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #c4c3c1;font-size:12px}
.mk-table th{background:#f5f4f2;font-size:8px;font-weight:700;color:#676867;letter-spacing:0.15em;text-transform:uppercase;padding:9px 12px;text-align:left;border-bottom:1px solid #c4c3c1}
.mk-table td{padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;color:#1a1a1a}
.mk-table tr:last-child td{border-bottom:none}
.mk-table tr:hover td{background:#fafaf9}
.mk-btn{font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:6px 14px;border:none;cursor:pointer;font-family:Arial,sans-serif}
.mk-btn-primary{background:#1a1a1a;color:#fff}.mk-btn-primary:hover{background:#0016B4}
.mk-btn-ghost{background:#D9D8D6;color:#676867;border:1px solid #c4c3c1}.mk-btn-ghost:hover{background:#c4c3c1}
.mk-btn-sm{font-size:8px;padding:4px 9px}
.mk-empty{text-align:center;padding:60px 0;color:#676867;font-size:9px;letter-spacing:0.2em;text-transform:uppercase}
.mk-warn{background:#fff0f0;border-left:3px solid #cc0000;padding:5px 9px;font-size:9px;color:#cc0000;margin-top:5px;font-weight:700}
.mk-note{background:#f0f4ff;border-left:3px solid #0016B4;padding:5px 9px;font-size:9px;color:#0016B4;margin-top:5px}
.mk-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;align-items:center;justify-content:center}
.mk-modal.open{display:flex}
.mk-modal-box{background:#fff;border:1px solid #c4c3c1;padding:28px;max-width:500px;width:90%;max-height:85vh;overflow-y:auto}
.mk-modal-title{font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1a1a1a;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid #c4c3c1}
.mk-field{margin-bottom:12px}
.mk-field label{display:block;font-size:8px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#676867;margin-bottom:4px}
.mk-score-bar{display:inline-block;height:3px;background:#0016B4;min-width:2px}
.tb-grid{display:grid;grid-template-columns:1fr 300px;gap:20px}
.tb-chip{font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:5px 10px;cursor:pointer;border:1px solid #c4c3c1;background:#fff;color:#676867}
.tb-chip.selected{background:#0016B4;color:#fff;border-color:#0016B4}
.tb-panel{background:#fff;border:1px solid #c4c3c1;padding:20px;position:sticky;top:20px}
.tb-member{border:1px solid #c4c3c1;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;background:#fafaf9}
.tb-remove{font-size:9px;color:#c4c3c1;cursor:pointer;border:none;background:none}.tb-remove:hover{color:#cc0000}
.tb-save{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:none;font-size:9px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;cursor:pointer;margin-top:12px;font-family:Arial,sans-serif}
.tb-save:hover{background:#0016B4}
.tb-pcard{border:1px solid #c4c3c1;padding:14px 16px;margin-bottom:8px;background:#fff}
.tb-pcard.excl{border-color:#cc0000;background:#fff8f8}
.tb-add{font-size:8px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 10px;border:1px solid #0016B4;color:#0016B4;background:#fff;cursor:pointer;font-family:Arial,sans-serif}
.tb-add:hover,.tb-added{background:#0016B4;color:#fff;border-color:#0016B4}
.tb-score{display:inline-block;font-size:9px;font-weight:700;padding:2px 7px;background:#1a1a1a;color:#fff}
</style>`;

function mkNav(active) {
  return `<div class="mk-header"><div style="max-width:1100px;margin:0 auto">
    <div class="mk-wordmark">Moreau Kusunoki</div>
    <div class="mk-sub">Architectes &mdash; MK Monitor</div>
    <nav class="mk-nav">
      <a href="/dashboard"${active==="dashboard"?' class="active"':""}>Dashboard</a>
      <a href="/partners"${active==="partners"?' class="active"':""}>Partner DB</a>
    </nav>
  </div></div>`;
}

function page(title, active, band, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moreau Kusunoki — ${title}</title>${CSS}</head><body>
${mkNav(active)}
<div class="mk-band"><div class="mk-band-inner">${band}</div></div>
<div class="mk-body">${body}</div></body></html>`;
}

module.exports = function(app) {

  // ── API: パートナー検索 ──────────────────────────────────────────────────────
  app.get("/api/partners", (req, res) => {
    const { q="", specialty="", pays="", min_score=0 } = req.query;
    const ql = q.toLowerCase();
    let results = partners.filter(p => {
      if (specialty && !p.specialites.includes(specialty)) return false;
      if (pays && p.pays !== pays) return false;
      if (p.score < parseInt(min_score)) return false;
      if (ql && !p.nom.toLowerCase().includes(ql) && !(p.ville||"").toLowerCase().includes(ql)) return false;
      return true;
    }).sort((a,b) => b.score - a.score);
    res.json({ count: results.length, results: results.slice(0,100) });
  });

  // ── API: パートナー更新 ──────────────────────────────────────────────────────
  app.post("/api/partners/:id/update", (req, res) => {
    const p = partners.find(x => x.id === parseInt(req.params.id));
    if (!p) return res.status(404).json({ error: "Not found" });
    ["evaluation","nb_collabs","derniere_collab","exclusivite","amo_client","notes","kbis_echeance","urssaf_echeance","statut_docs"]
      .forEach(k => { if (req.body[k] !== undefined) p[k] = req.body[k]; });
    p.score = calcScore(p);
    savePartners();
    res.json({ ok: true, partner: p });
  });

  // ── API: チーム保存 ──────────────────────────────────────────────────────────
  app.post("/api/team/save", (req, res) => {
    const { noticeId, noticeTitle, noticeUrl, members } = req.body;
    if (!noticeId) return res.status(400).json({ error: "noticeId required" });
    teams[noticeId] = { noticeTitle, noticeUrl, savedAt: new Date().toISOString(), members: members||[] };
    saveTeams();
    (members||[]).forEach(m => {
      const p = partners.find(x => x.id === m.partnerId);
      if (p) { p.nb_collabs += 1; p.derniere_collab = String(new Date().getFullYear()); p.score = calcScore(p); }
    });
    savePartners();
    res.json({ ok: true });
  });

  app.get("/api/team/:noticeId", (req, res) => res.json(teams[req.params.noticeId] || null));

  // ── Partner DB ページ ────────────────────────────────────────────────────────
  app.get("/partners", (req, res) => {
    const specialties = getAllSpecialties();
    const pays_list   = [...new Set(partners.map(p => p.pays))].sort();
    const opts_spec   = specialties.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    const opts_pays   = pays_list.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");

    const body = `
<div class="mk-label">Partner DB</div>
<div class="mk-filters">
  <div class="mk-fg" style="flex:2;min-width:180px">
    <label>Recherche</label>
    <input id="q" class="mk-input" style="width:100%" type="text" placeholder="Nom, ville…" oninput="search()">
  </div>
  <div class="mk-fg" style="flex:2;min-width:200px">
    <label>Spécialité</label>
    <select id="specialty" class="mk-select" onchange="search()"><option value="">— Toutes —</option>${opts_spec}</select>
  </div>
  <div class="mk-fg">
    <label>Pays</label>
    <select id="pays" class="mk-select" onchange="search()"><option value="">— Tous —</option>${opts_pays}</select>
  </div>
  <div class="mk-fg">
    <label>Score min.</label>
    <select id="min_score" class="mk-select" onchange="search()">
      <option value="0">Tous</option>
      <option value="10">1 collab. +</option>
      <option value="20">2 collabs +</option>
      <option value="30">Prioritaire</option>
    </select>
  </div>
  <button class="mk-btn mk-btn-ghost" onclick="reset()">Réinitialiser</button>
</div>
<div style="font-size:9px;color:#676867;letter-spacing:0.1em;margin-bottom:12px" id="count"></div>
<div style="overflow-x:auto">
<table class="mk-table">
  <thead><tr>
    <th style="width:30px"></th>
    <th>Nom</th>
    <th>Spécialité(s)</th>
    <th>Ville / Pays</th>
    <th>Contact</th>
    <th>Score MK</th>
    <th>Éval.</th>
    <th></th>
  </tr></thead>
  <tbody id="tbody"><tr><td colspan="8" class="mk-empty">Chargement…</td></tr></tbody>
</table></div>

<div class="mk-modal" id="modal">
<div class="mk-modal-box">
  <div class="mk-modal-title" id="modal-title"></div>
  <input type="hidden" id="edit-id">
  <div class="mk-field" style="background:#fff0f0;padding:12px;border-left:3px solid #cc0000;margin-bottom:16px">
    <label style="color:#cc0000">Exclusivité / Concurrence</label>
    <textarea id="edit-excl" class="mk-input" rows="2" style="width:100%;margin-top:5px" placeholder="Lié à l'agence XYZ…"></textarea>
  </div>
  <div class="mk-field"><label>AMO / Programmiste côté client</label><input id="edit-amo" class="mk-input" style="width:100%" type="text"></div>
  <div class="mk-field"><label>Évaluation MK</label>
    <select id="edit-eval" class="mk-select" style="width:100%"><option value="">Non évalué</option><option>★</option><option>★★</option><option>★★★</option></select>
  </div>
  <div class="mk-field"><label>Nombre de collaborations</label><input id="edit-collabs" class="mk-input" style="width:100%" type="number" min="0"></div>
  <div class="mk-field"><label>Dernière collaboration (année)</label><input id="edit-annee" class="mk-input" style="width:100%" type="number" min="2000" max="2099"></div>
  <div class="mk-field"><label>Kbis — date d'échéance</label><input id="edit-kbis" class="mk-input" style="width:100%" type="date"></div>
  <div class="mk-field"><label>URSSAF — date d'échéance</label><input id="edit-urssaf" class="mk-input" style="width:100%" type="date"></div>
  <div class="mk-field"><label>Statut documents</label>
    <select id="edit-statut" class="mk-select" style="width:100%"><option>À vérifier</option><option>OK</option><option>À renouveler</option><option>Expiré</option></select>
  </div>
  <div class="mk-field"><label>Notes</label><textarea id="edit-notes" class="mk-input" rows="3" style="width:100%"></textarea></div>
  <div style="display:flex;gap:10px;margin-top:16px">
    <button class="mk-btn mk-btn-primary" onclick="save()">Enregistrer</button>
    <button class="mk-btn mk-btn-ghost" onclick="closeModal()">Annuler</button>
  </div>
</div></div>

<script>
let all=[];let timer;
function search(){clearTimeout(timer);timer=setTimeout(go,250);}
async function go(){
  const p=new URLSearchParams({q:document.getElementById("q").value,specialty:document.getElementById("specialty").value,pays:document.getElementById("pays").value,min_score:document.getElementById("min_score").value});
  const d=await(await fetch("/api/partners?"+p)).json();
  all=d.results;
  document.getElementById("count").textContent=d.count+" partenaire"+(d.count!==1?"s":"")+(d.count>100?" (100 affichés)":"");
  render();
}
function render(){
  const tb=document.getElementById("tbody");
  if(!all.length){tb.innerHTML='<tr><td colspan="8" class="mk-empty">Aucun résultat</td></tr>';return;}
  tb.innerHTML=all.map(p=>{
    const ex=p.exclusivite?'<div class="mk-warn">EXCLUSIVITE : '+e(p.exclusivite.slice(0,80))+'</div>':"";
    const am=p.amo_client?'<div class="mk-note">AMO CLIENT : '+e(p.amo_client.slice(0,80))+'</div>':"";
    const sp=p.specialites.slice(0,3).map(s=>'<span style="font-size:9px;color:#0016B4;margin-right:6px">'+e(s)+'</span>').join("")+(p.specialites.length>3?'<span style="font-size:9px;color:#676867">+'+(p.specialites.length-3)+'</span>':"");
    const sw=Math.min(p.score*2,80);
    return'<tr><td style="color:#c4c3c1;font-size:9px">'+p.id+'</td><td><div style="font-weight:700;font-size:13px">'+e(p.nom)+'</div>'+ex+am+'</td><td>'+sp+'</td><td style="font-size:11px">'+e(p.ville)+'<br><span style="color:#676867">'+e(p.pays)+'</span></td><td style="font-size:11px">'+(p.contact?e(p.contact)+'<br>':"")+'<a href="mailto:'+e(p.email)+'" style="color:#0016B4;text-decoration:none">'+e(p.email)+'</a></td><td><div style="display:flex;align-items:center;gap:6px"><div class="mk-score-bar" style="width:'+sw+'px"></div><span style="font-size:11px">'+p.score+'</span></div><div style="font-size:9px;color:#676867">'+p.nb_collabs+' collab.</div></td><td style="color:#f59e0b">'+(p.evaluation||'<span style="color:#c4c3c1">—</span>')+'</td><td><button class="mk-btn mk-btn-ghost mk-btn-sm" onclick="open_('+p.id+')">Éditer</button></td></tr>';
  }).join("");
}
function e(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function reset(){["q","specialty","pays"].forEach(id=>document.getElementById(id).value="");document.getElementById("min_score").value="0";go();}
function open_(id){const p=all.find(x=>x.id===id);if(!p)return;
  document.getElementById("edit-id").value=id;
  document.getElementById("modal-title").textContent=p.nom;
  document.getElementById("edit-excl").value=p.exclusivite||"";
  document.getElementById("edit-amo").value=p.amo_client||"";
  document.getElementById("edit-eval").value=p.evaluation||"";
  document.getElementById("edit-collabs").value=p.nb_collabs||0;
  document.getElementById("edit-annee").value=p.derniere_collab||"";
  document.getElementById("edit-kbis").value=p.kbis_echeance||"";
  document.getElementById("edit-urssaf").value=p.urssaf_echeance||"";
  document.getElementById("edit-statut").value=p.statut_docs||"À vérifier";
  document.getElementById("edit-notes").value=p.notes||"";
  document.getElementById("modal").classList.add("open");
}
function closeModal(){document.getElementById("modal").classList.remove("open");}
async function save(){
  const id=parseInt(document.getElementById("edit-id").value);
  const body={exclusivite:document.getElementById("edit-excl").value,amo_client:document.getElementById("edit-amo").value,evaluation:document.getElementById("edit-eval").value,nb_collabs:parseInt(document.getElementById("edit-collabs").value)||0,derniere_collab:document.getElementById("edit-annee").value,kbis_echeance:document.getElementById("edit-kbis").value,urssaf_echeance:document.getElementById("edit-urssaf").value,statut_docs:document.getElementById("edit-statut").value,notes:document.getElementById("edit-notes").value};
  const d=await(await fetch("/api/partners/"+id+"/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json();
  if(d.ok){const i=all.findIndex(x=>x.id===id);if(i>=0)all[i]=d.partner;render();closeModal();}
}
document.getElementById("modal").addEventListener("click",ev=>{if(ev.target===document.getElementById("modal"))closeModal();});
go();
</script>`;

    res.send(page("Partner DB","partners",`${partners.length} partenaires`,body));
  });

  // ── Team Builder ─────────────────────────────────────────────────────────────
  app.get("/team-builder", (req, res) => {
    const { noticeId="", noticeTitle="", noticeUrl="" } = req.query;
    const specialties = getAllSpecialties();
    const saved = teams[noticeId] || null;
    const savedMembers = saved ? JSON.stringify(saved.members.map(m=>{const p=partners.find(x=>x.id===m.partnerId);return p?{partnerId:p.id,nom:p.nom,specialites:p.specialites,role:m.role}:null;}).filter(Boolean)) : "[]";

    const body = `
<div class="mk-label">Team Builder — ${esc(noticeTitle||"Sans titre")}</div>
<div class="tb-grid">
  <div>
    <div style="background:#fff;border:1px solid #c4c3c1;padding:16px;margin-bottom:14px">
      <div class="mk-label">Filtrer par spécialité</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px" id="specs">
        ${specialties.map(s=>`<button class="tb-chip" onclick="toggleSpec(this,'${esc(s)}')">${esc(s)}</button>`).join("")}
      </div>
      <input class="mk-input" style="width:100%" type="text" placeholder="Nom, ville…" oninput="onQ(this.value)">
      <div style="font-size:9px;color:#676867;margin-top:8px" id="pcount">Sélectionnez des spécialités</div>
    </div>
    <div id="plist"></div>
  </div>
  <div>
    <div class="tb-panel">
      <div class="mk-label">Équipe <span id="tcount" style="color:#c4c3c1">(0)</span></div>
      <div id="tlist"><div class="mk-empty" style="padding:20px 0">Ajoutez des partenaires</div></div>
      <button class="tb-save" onclick="saveTeam()">Enregistrer l'équipe</button>
      <div style="font-size:8px;color:#c4c3c1;margin-top:8px;text-align:center;letter-spacing:0.1em;text-transform:uppercase">Met à jour les scores de collaboration</div>
    </div>
  </div>
</div>
<script>
const NID=${JSON.stringify(noticeId)},NTITLE=${JSON.stringify(noticeTitle)},NURL=${JSON.stringify(noticeUrl)};
let specs=[],q="",all=[],team=${savedMembers};
function toggleSpec(el,s){const i=specs.indexOf(s);i>=0?(specs.splice(i,1),el.classList.remove("selected")):(specs.push(s),el.classList.add("selected"));load();}
function onQ(v){q=v;load();}
async function load(){
  if(!specs.length&&!q){document.getElementById("plist").innerHTML="";document.getElementById("pcount").textContent="Sélectionnez des spécialités";return;}
  const fs=specs.length?specs.map(s=>fetch("/api/partners?specialty="+encodeURIComponent(s)+"&q="+encodeURIComponent(q)).then(r=>r.json())):[fetch("/api/partners?q="+encodeURIComponent(q)).then(r=>r.json())];
  const res=await Promise.all(fs);const seen=new Set();all=[];
  res.forEach(r=>r.results.forEach(p=>{if(!seen.has(p.id)){seen.add(p.id);all.push(p);}}));
  all.sort((a,b)=>b.score-a.score);
  document.getElementById("pcount").textContent=all.length+" partenaire"+(all.length!==1?"s":"");
  renderP();
}
function renderP(){
  const inT=new Set(team.map(m=>m.partnerId));
  document.getElementById("plist").innerHTML=all.slice(0,50).map(p=>{
    const added=inT.has(p.id);
    const sp=p.specialites.slice(0,2).map(s=>'<span style="font-size:9px;color:#0016B4;margin-right:5px">'+e(s)+'</span>').join("")+(p.specialites.length>2?'<span style="font-size:9px;color:#676867">+'+(p.specialites.length-2)+'</span>':"");
    return'<div class="tb-pcard'+(p.exclusivite?" excl":"")+'">'+'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'+'<div style="flex:1"><div style="font-size:13px;font-weight:700">'+e(p.nom)+'</div><div style="font-size:9px;color:#676867;margin-top:2px">'+e(p.ville)+(p.pays!=="France"?" · "+e(p.pays):"")+'</div><div style="margin-top:5px">'+sp+'</div>'+(p.exclusivite?'<div class="mk-warn">'+e(p.exclusivite.slice(0,80))+'</div>':"")+(p.amo_client?'<div class="mk-note">AMO: '+e(p.amo_client.slice(0,80))+'</div>':"")+'</div>'+'<div style="text-align:right;flex-shrink:0"><span class="tb-score">'+p.score+'</span><div style="font-size:9px;color:#676867;margin-top:3px">'+(p.evaluation||"—")+'</div><button class="'+(added?"tb-added":"tb-add")+'" style="margin-top:5px" onclick="'+(added?"rem("+p.id+")":"add("+p.id+")")+'">'+(added?"Dans l'équipe":"+ Ajouter")+'</button></div>'+'</div></div>';
  }).join("");
}
function add(id){const p=all.find(x=>x.id===id);if(!p||team.find(m=>m.partnerId===id))return;team.push({partnerId:id,nom:p.nom,specialites:p.specialites,role:""});renderP();renderT();}
function rem(id){team=team.filter(m=>m.partnerId!==id);renderP();renderT();}
function renderT(){
  document.getElementById("tcount").textContent="("+team.length+")";
  if(!team.length){document.getElementById("tlist").innerHTML='<div class="mk-empty" style="padding:20px 0">Ajoutez des partenaires</div>';return;}
  document.getElementById("tlist").innerHTML=team.map(m=>'<div class="tb-member"><div><div style="font-size:12px;font-weight:700">'+e(m.nom)+'</div><div style="font-size:9px;color:#676867">'+(m.specialites||[]).slice(0,1).join(",")+'</div></div><button class="tb-remove" onclick="rem('+m.partnerId+')">✕</button></div>').join("");
}
async function saveTeam(){
  if(!team.length){alert("Ajoutez au moins un partenaire.");return;}
  const d=await(await fetch("/api/team/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({noticeId:NID,noticeTitle:NTITLE,noticeUrl:NURL,members:team})})).json();
  if(d.ok){alert("Équipe enregistrée.");location.reload();}
}
function e(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
renderT();
</script>`;

    res.send(page("Team Builder","dashboard",`Team Builder — ${esc(noticeTitle||"Sans titre")}`,body));
  });

  console.log("✅ Partner DB routes: /partners  /team-builder  /api/partners  /api/team/*");
};
