require("dotenv").config();
const cron = require("node-cron");
const fetch = require("node-fetch");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const IS_TEST = process.argv.includes("--test");

const RECIPIENTS = [
  { name: "HK",      email: process.env.EMAIL_HK,      filterLevel: "priority", lang: "ja",        group: "hk" },
  { name: "Nicolas", email: process.env.EMAIL_NICOLAS,  filterLevel: "priority", lang: "fr",        group: "nicolas" },
  { name: "Luana",   email: process.env.EMAIL_LUANA,    filterLevel: "all",      lang: "bilingual", group: "team" },
  { name: "Joana",   email: process.env.EMAIL_JOANA,    filterLevel: "all",      lang: "bilingual", group: "team" },
  { name: "Antoine", email: process.env.EMAIL_ANTOINE,  filterLevel: "all",      lang: "bilingual", group: "team" },
];

const CONFIG = {
  senderEmail:   process.env.SENDER_EMAIL || "onboarding@resend.dev",
  anthropicKey:  process.env.ANTHROPIC_API_KEY,
  timezone:      "Europe/Paris",
  schedule:      "0 7 * * *",
  priorityScore: parseInt(process.env.PRIORITY_SCORE || "15"),
};

const ARCH_CPV = ["71200000","71220000","71221000","71222000","71240000","71300000"];
const CULT_CPV = ["45212300","45212310","45212314","45212000","92000000","92300000"];
const ALL_CPV  = [...ARCH_CPV, ...CULT_CPV];

const CULTURAL_KW = [
  "musée","médiathèque","bibliothèque","théâtre","opéra","centre culturel",
  "salle de spectacle","conservatoire","école d'art","équipement culturel",
  "monument","patrimoine","cinéma","galerie","auditorium","philharmonie",
  "maison de la culture","cité de la musique",
  "museum","library","theatre","theater","opera","cultural centre",
  "cultural center","concert hall","conservatory","arts school","heritage",
  "cinema","gallery","philharmonic",
];

const GEO = {
  1: { ja:"🇫🇷 フランス",       fr:"🇫🇷 France",             en:"🇫🇷 France",           keywords:["france","french"] },
  2: { ja:"🇨🇭🇸🇪 スイス/北欧", fr:"🇨🇭🇸🇪 Suisse/Nordique", en:"🇨🇭🇸🇪 Switzerland/Nordic", keywords:["switzerland","suisse","sweden","suède","norway","norvège","denmark","danemark","finland","finlande"] },
  3: { ja:"🌍 その他欧州",       fr:"🌍 Europe",               en:"🌍 Europe",             keywords:["germany","allemagne","belgium","belgique","netherlands","austria","autriche","spain","espagne","italy","italie","portugal","luxembourg","greece","uk","united kingdom"] },
  4: { ja:"🇯🇵 日本",            fr:"🇯🇵 Japon",               en:"🇯🇵 Japan",             keywords:["japan","japon"] },
  5: { ja:"🌎 北米",             fr:"🌎 Amérique du Nord",     en:"🌎 North America",      keywords:["united states","usa","canada"] },
  6: { ja:"🌏 東南アジア",       fr:"🌏 Asie du Sud-Est",      en:"🌏 Southeast Asia",     keywords:["thailand","thaïlande","indonesia","indonésie","india","inde"] },
  7: { ja:"🌐 その他",           fr:"🌐 Reste du monde",       en:"🌐 Rest of world",      keywords:["china","chine","arab","gulf","africa","afrique"] },
};

function detectGeo(notice) {
  const text = [notice.country,notice.region,notice.acheteur,notice.description,notice.title]
    .filter(Boolean).join(" ").toLowerCase();
  for (let p=1;p<=7;p++) {
    if (GEO[p].keywords.some(k=>text.includes(k))) return p;
  }
  if (notice._source==="BOAMP") return 1;
  if (notice._source==="TED/OJEU") return 3;
  return 7;
}

function isCultural(notice) {
  const text = [notice.title,notice.description].filter(Boolean).join(" ").toLowerCase();
  return CULTURAL_KW.some(k=>text.includes(k));
}

function parseBudget(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[^\d.]/g,""));
  return isNaN(n)?0:n;
}

function formatBudget(val) {
  const n = parseBudget(val);
  if (!n) return "—";
  if (n>=1000000) return `${(n/1000000).toFixed(1)} M€`;
  if (n>=1000)    return `${(n/1000).toFixed(0)} K€`;
  return `${n} €`;
}

function scoreNotice(notice) {
  let score = 0;
  const text  = [notice.title,notice.description].filter(Boolean).join(" ").toLowerCase();
  const cpv   = notice.cpv||"";
  const budget= parseBudget(notice.budget);
  const geo   = detectGeo(notice);
  CULTURAL_KW.forEach(k=>{if(text.includes(k))score+=8});
  ALL_CPV.forEach(c=>{if(cpv.startsWith(c.slice(0,5)))score+=12});
  if (budget>=5000000)      score+=30;
  else if (budget>=1000000) score+=20;
  else if (budget>=500000)  score+=8;
  score += Math.max(0,(8-geo)*5);
  if (isCultural(notice)&&geo<=3) score+=15;
  return score;
}

// ─── BOAMP via Archmarathon RSS fallback ───────────────────────────────────────
// BOAMP直接APIが制限される場合、Archmarathonのパブリックデータを使用

async function fetchBOAMP() {
  console.log("📡 BOAMP取得中...");
  try {
    // User-Agentを設定してアクセス
    const cpvFilter = ALL_CPV.map(c=>`code_cpv like "${c.slice(0,5)}%"`).join(" OR ");
    const kwFilter  = CULTURAL_KW.slice(0,8).map(k=>`objet like "%${k}%"`).join(" OR ");
    const where     = encodeURIComponent(`(${cpvFilter}) OR (${kwFilter})`);
    const url = `https://api.boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records?where=${where}&order_by=date_publication%20DESC&limit=80`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MKMonitor/1.0; +https://moreau-kusunoki.fr)",
        "Accept": "application/json",
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
      timeout: 15000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const results = (data.results||[]).map(r=>{
      const f=r.record?.fields||r.fields||r;
      return {
        _id:`boamp-${f.id||Math.random()}`,_source:"BOAMP",
        title:f.objet,description:f.description,
        acheteur:f.acheteur_denomination||f.pouvoir_adjudicateur,
        budget:f.valeur_totale||f.valeur_estimee,
        date_pub:f.date_publication,deadline:f.date_limite_reception,
        region:f.region||"France",country:"France",
        cpv:f.code_cpv,procedure:f.procedure,nature:f.nature,
        url:f.url_document||"https://www.boamp.fr",
      };
    });
    console.log(`✅ BOAMP: ${results.length}件`);
    return results;
  } catch(e) {
    console.error("⚠️ BOAMP error:", e.message);
    return [];
  }
}

// ─── TED/OJEU ─────────────────────────────────────────────────────────────────

async function fetchTED() {
  console.log("📡 TED/OJEU取得中...");
  try {
    // TED API v3 - 正しいフォーマット
    const cpvQuery = ARCH_CPV.slice(0,4).map(c=>`cpvs=${c}`).join("&");
    const url = `https://api.ted.europa.eu/v3/notices/search?${cpvQuery}&limit=40&page=1&sortField=publicationDate&sortOrder=desc`;

    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "MKMonitor/1.0",
      },
      timeout: 15000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const notices = data.notices || data.results || data.items || [];
    const results = notices.map(n=>({
      _id:`ted-${n.id||n.noticeId||Math.random()}`,_source:"TED/OJEU",
      title:Array.isArray(n.title)?n.title[0]:(n.title||n.noticeTitle),
      description:Array.isArray(n.description)?n.description[0]:n.description,
      acheteur:Array.isArray(n["organisation-name"])?n["organisation-name"][0]:(n["organisation-name"]||n.buyerName||n.organisationName),
      budget:n["value-pub"]||n["estimated-value"]||n.estimatedValue,
      date_pub:n["publication-date"]||n.publicationDate,
      deadline:n["deadline-date"]||n.submissionDeadline,
      country:n.country||n.buyerCountry,region:n.country||n.buyerCountry,
      cpv:Array.isArray(n["cpv-code"])?n["cpv-code"][0]:(n["cpv-code"]||n.cpvCode),
      procedure:n["procedure-type"]||n.procedureType,
      nature:n["notice-type"]||n.noticeType,
      url:n.link||n.permalink||"https://ted.europa.eu",
    }));
    console.log(`✅ TED: ${results.length}件`);
    return results;
  } catch(e) {
    console.error("⚠️ TED error:", e.message);
    return [];
  }
}

// ─── Archmarathon（補助ソース） ────────────────────────────────────────────────

async function fetchArchmarathon() {
  console.log("📡 Archmarathon取得中...");
  try {
    const res = await fetch("https://archmarathon.com/competitions/feed/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MKMonitor/1.0)" },
      timeout: 10000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // シンプルなRSSパース
    const items = [];
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    itemMatches.slice(0,30).forEach(item => {
      const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||item.match(/<title>(.*?)<\/title>/))?.[1]||"";
      const link    = (item.match(/<link>(.*?)<\/link>/))?.[1]||"";
      const desc    = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)||item.match(/<description>(.*?)<\/description>/))?.[1]||"";
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]||"";
      if (title) items.push({
        _id:`arch-${Math.random()}`,_source:"Archmarathon",
        title,description:desc.replace(/<[^>]*>/g,"").slice(0,300),
        acheteur:"",budget:null,
        date_pub:pubDate,deadline:null,
        country:"",region:"",cpv:"",procedure:"Competition",nature:"Competition",
        url:link,
      });
    });
    console.log(`✅ Archmarathon: ${items.length}件`);
    return items;
  } catch(e) {
    console.error("⚠️ Archmarathon error:", e.message);
    return [];
  }
}

// ─── AIサマリー ────────────────────────────────────────────────────────────────

async function generateSummary(notice, lang) {
  if (!CONFIG.anthropicKey) return null;
  const noticeText = [
    notice.title       && `Title: ${notice.title}`,
    notice.description && `Description: ${notice.description}`,
    notice.acheteur    && `Client: ${notice.acheteur}`,
    notice.budget      && `Budget: ${formatBudget(notice.budget)}`,
    notice.country     && `Country: ${notice.country}`,
    notice.procedure   && `Procedure: ${notice.procedure}`,
    notice.deadline    && `Deadline: ${notice.deadline}`,
  ].filter(Boolean).join("\n");

  const prompts = {
    ja: `Moreau Kusunoki建築事務所向けに以下の案件を分析。不明な場合は「不明」。JSONのみ返答。\n\n${noticeText}\n\n{"総工費":"","建築面積":"","建築タイプ":"新築/増築/改修","コンペの有無":"あり/なし/不明","審査基準":"","審査員":"","提出物":"","スケジュール":"","敷地の特徴":"","設計チーム構成":"","参加報酬":"","設計報酬上限":"","MKコメント":"MK事務所への適合性について一言"}`,
    fr: `Analysez cette notice pour Moreau Kusunoki Architectes. Indiquez "N/A" si inconnu. JSON uniquement.\n\n${noticeText}\n\n{"Coût total":"","Surface":"","Type de projet":"Neuf/Extension/Réhabilitation","Concours":"Oui/Non/N/A","Critères de sélection":"","Jury":"","Pièces à fournir":"","Calendrier":"","Caractéristiques du site":"","Équipe requise":"","Indemnité de concours":"","Plafond honoraires":"","Commentaire":""}`,
    bilingual: `Analyse for Moreau Kusunoki Architects. Use "N/A" if unknown. JSON only.\n\n${noticeText}\n\n{"Total cost":"","Area":"","Project type":"New build/Extension/Renovation","Competition":"Yes/No/N/A","Selection criteria":"","Jury":"","Deliverables":"","Schedule":"","Site characteristics":"","Team required":"","Competition fee":"","Fee cap":"","Comment":""}`,
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json","x-api-key":CONFIG.anthropicKey,"anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-sonnet-4-20250514",max_tokens:800,messages:[{role:"user",content:prompts[lang]||prompts.bilingual}] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content.map(c=>c.text||"").join("").trim();
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e) {
    console.error("Summary error:", e.message);
    return null;
  }
}

// ─── メールHTML ────────────────────────────────────────────────────────────────

const LABELS = {
  ja: { title:"MK Monitor",subtitle:"コンペ・入札 日次レポート",total:"新着案件",cultural:"文化施設",budget:"+1M€",footer:"情報源: BOAMP · TED/OJEU · Archmarathon　|　MK条件①〜⑧　|　毎朝7時（パリ時間）自動配信",feeAlert:"⚠️ 設計報酬上限",noticeSuffix:"件" },
  fr: { title:"MK Monitor",subtitle:"Rapport quotidien — Concours & Marchés",total:"Nouvelles notices",cultural:"Culturel",budget:"+1M€",footer:"Sources : BOAMP · TED/OJEU · Archmarathon  |  Critères MK ①–⑧  |  Envoi automatique à 7h00 (Paris)",feeAlert:"⚠️ Plafond honoraires",noticeSuffix:" notices" },
  bilingual: { title:"MK Monitor",subtitle:"Daily Report — Competitions & Tenders",total:"New notices",cultural:"Cultural",budget:"+1M€",footer:"Sources: BOAMP · TED/OJEU · Archmarathon  |  MK criteria ①–⑧  |  Automated daily at 7:00 AM Paris time",feeAlert:"⚠️ Fee cap",noticeSuffix:" notices" },
};

function buildNoticeHtml(notice, lang) {
  const L = LABELS[lang];
  const geo = detectGeo(notice);
  const geoLabel = GEO[geo]?.[lang==="bilingual"?"en":lang] || GEO[geo].en;
  const budget = formatBudget(notice.budget);
  const cultural = isCultural(notice);
  const deadline = notice.deadline ? new Date(notice.deadline).toLocaleDateString("fr-FR",{day:"numeric",month:"short",year:"numeric"}) : null;
  const srcColor = notice._source==="BOAMP" ? {bg:"#dbeafe",fg:"#1d4ed8"} : notice._source==="TED/OJEU" ? {bg:"#d1fae5",fg:"#065f46"} : {bg:"#fef3c7",fg:"#92400e"};

  let summaryHtml = "";
  if (notice._summary) {
    const s = notice._summary;
    const fields = lang==="ja"
      ? [["総工費"],["建築タイプ"],["コンペの有無"],["審査基準"],["提出物"],["スケジュール"],["参加報酬"]]
      : lang==="fr"
      ? [["Coût total"],["Type de projet"],["Concours"],["Critères de sélection"],["Pièces à fournir"],["Calendrier"],["Indemnité de concours"]]
      : [["Total cost"],["Project type"],["Competition"],["Selection criteria"],["Deliverables"],["Schedule"],["Competition fee"]];

    const rows = fields.filter(([k])=>s[k]&&s[k]!=="不明"&&s[k]!=="N/A")
      .map(([k])=>`<tr><td style="padding:3px 10px 3px 0;font-size:11px;color:#6b7280;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;font-size:11px;color:#374151;line-height:1.5">${s[k]}</td></tr>`).join("");

    const feeKey = lang==="ja"?"設計報酬上限":lang==="fr"?"Plafond honoraires":"Fee cap";
    const commentKey = lang==="ja"?"MKコメント":lang==="fr"?"Commentaire":"Comment";
    const feeAlert = s[feeKey]&&s[feeKey]!=="不明"&&s[feeKey]!=="N/A"
      ? `<div style="margin-top:6px;padding:7px 10px;background:#fef2f2;border-left:3px solid #dc2626;font-size:11px;color:#b91c1c">${L.feeAlert}: ${s[feeKey]}</div>` : "";
    const comment = s[commentKey]
      ? `<div style="margin-top:6px;padding:7px 10px;background:#f0f9ff;border-left:3px solid #0284c7;font-size:11px;color:#0c4a6e">💡 ${s[commentKey]}</div>` : "";

    if (rows||feeAlert||comment) {
      summaryHtml = `<div style="padding:12px 16px;background:#f8fafc;border-top:1px solid #e2e8f0"><div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;margin-bottom:8px">✦ AI SUMMARY</div><table cellpadding="0" cellspacing="0">${rows}</table>${feeAlert}${comment}</div>`;
    }
  }

  return `
  <div style="border:1px solid #e2e8f0;border-radius:4px;margin-bottom:10px;overflow:hidden">
    <div style="padding:14px 16px">
      <div style="margin-bottom:8px;display:flex;gap:5px;flex-wrap:wrap">
        <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:${srcColor.bg};color:${srcColor.fg};letter-spacing:0.1em;text-transform:uppercase">${notice._source}</span>
        <span style="font-size:9px;padding:2px 7px;border-radius:3px;background:#f1f5f9;color:#475569">${geoLabel}</span>
        ${cultural?`<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:3px;background:#d1fae5;color:#065f46">${L.cultural}</span>`:""}
        ${parseBudget(notice.budget)>=5000000?`<span style="font-size:9px;padding:2px 7px;border-radius:3px;background:#ede9fe;color:#6d28d9">+5M€</span>`:""}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;padding-right:12px">
          <div style="font-size:13px;font-weight:500;color:#111827;line-height:1.4">${notice.title||"—"}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:3px">${notice.acheteur||""}</div>
        </td>
        <td style="vertical-align:top;text-align:right;white-space:nowrap">
          <div style="font-size:15px;font-weight:600;color:#111827;font-family:monospace">${budget}</div>
        </td>
      </tr></table>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #f3f4f6;font-size:10px;color:#9ca3af">
        ${notice.region?`📍 ${notice.region}&nbsp;&nbsp;`:""}
        ${deadline?`<span style="color:#dc2626">⏱ ${deadline}</span>&nbsp;&nbsp;`:""}
        <a href="${notice.url}" style="color:#2563eb;text-decoration:none">→ Dossier ↗</a>
      </div>
    </div>
    ${summaryHtml}
  </div>`;
}

function buildEmail(notices, lang, date) {
  const L = LABELS[lang];
  const dateStr = new Date(date).toLocaleDateString(lang==="ja"?"ja-JP":"fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  const grouped = {};
  for (const n of notices) {
    const g = detectGeo(n);
    if (!grouped[g]) grouped[g]=[];
    grouped[g].push(n);
  }

  let sections = "";
  for (let geo=1;geo<=7;geo++) {
    if (!grouped[geo]?.length) continue;
    const geoLabel = GEO[geo]?.[lang==="bilingual"?"en":lang]||GEO[geo].en;
    sections += `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:14px">${geoLabel} · ${grouped[geo].length}${lang==="ja"?"件":" notices"}</div>${grouped[geo].map(n=>buildNoticeHtml(n,lang)).join("")}</div>`;
  }

  const totalCount = notices.length;
  const culturalCount = notices.filter(isCultural).length;
  const largeCount = notices.filter(n=>parseBudget(n.budget)>=1000000).length;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:680px;margin:0 auto;padding:20px 16px">
  <div style="background:#0f172a;border-radius:6px 6px 0 0;padding:22px 28px">
    <div style="font-size:9px;color:#475569;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:5px">Moreau Kusunoki Architectes</div>
    <h1 style="margin:0;font-size:20px;font-weight:300;color:#f1f5f9;letter-spacing:0.15em;text-transform:uppercase">${L.title}</h1>
    <div style="font-size:12px;color:#64748b;margin-top:4px">${dateStr}</div>
  </div>
  <div style="background:#1e293b;padding:14px 28px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;padding-right:28px"><div style="font-size:22px;font-weight:600;color:#f1f5f9;font-family:monospace">${totalCount}</div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">${L.total}</div></td>
      <td style="text-align:center;padding-right:28px"><div style="font-size:22px;font-weight:600;color:#f1f5f9;font-family:monospace">${culturalCount}</div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">${L.cultural}</div></td>
      <td style="text-align:center"><div style="font-size:22px;font-weight:600;color:#f1f5f9;font-family:monospace">${largeCount}</div><div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em">${L.budget}</div></td>
    </tr></table>
  </div>
  <div style="background:white;border-radius:0 0 6px 6px;padding:24px 28px;border:1px solid #e2e8f0;border-top:none">
    ${sections}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f1f5f9;font-size:10px;color:#94a3b8;line-height:1.7">${L.footer}</div>
  </div>
</div>
</body></html>`;
}

function buildSubject(lang, count, date) {
  const d = new Date(date).toLocaleDateString(lang==="ja"?"ja-JP":"fr-FR",{day:"numeric",month:"long",year:"numeric"});
  if (lang==="ja") return `MK Monitor — ${count}件の新着案件 · ${d}`;
  if (lang==="fr") return `MK Monitor — ${count} nouvelles notices · ${d}`;
  return `MK Monitor — ${count} new notices · ${d}`;
}

// ─── メイン処理 ────────────────────────────────────────────────────────────────

async function runMonitor() {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`🕐 MK Monitor 開始: ${new Date().toLocaleString("ja-JP",{timeZone:"Europe/Paris"})}`);

  // 1. データ取得（3ソース並行）
  const [boamp, ted, arch] = await Promise.all([fetchBOAMP(), fetchTED(), fetchArchmarathon()]);
  const all = [...boamp, ...ted, ...arch];
  console.log(`✅ 取得: BOAMP ${boamp.length}件 + TED ${ted.length}件 + Archmarathon ${arch.length}件`);

  // 2. スコアリング & フィルタリング
  const scored = all
    .map(n=>({...n,_score:scoreNotice(n),_geo:detectGeo(n)}))
    .filter(n=>{
      const b=parseBudget(n.budget);
      if (b>=1000000) return true;
      if (isCultural(n)&&n._geo<=3) return true;
      if (n._score>=10) return true;
      return false;
    })
    .sort((a,b)=>b._score-a._score);

  const priorityNotices = scored.filter(n=>n._score>=CONFIG.priorityScore);
  console.log(`📊 全案件: ${scored.length}件 / 優先度高: ${priorityNotices.length}件`);

  // 3. AIサマリー（上位10件）
  console.log("🤖 AIサマリー生成中...");
  for (const n of priorityNotices.slice(0,10)) {
    n._summary = await generateSummary(n, "bilingual");
    if (n._summary) process.stdout.write(".");
  }
  console.log("\n✅ サマリー完了");

  // 4. グループ別送信
  const groups = {};
  for (const r of RECIPIENTS) {
    if (!r.email) continue;
    if (!groups[r.group]) groups[r.group]={recipients:[],lang:r.lang,filterLevel:r.filterLevel};
    groups[r.group].recipients.push(r);
  }

  for (const [groupName,group] of Object.entries(groups)) {
    const notices = group.filterLevel==="priority" ? priorityNotices : scored;
    if (notices.length===0) { console.log(`📭 ${groupName}: 対象案件なし、スキップ`); continue; }

    const html    = buildEmail(notices, group.lang, new Date());
    const subject = buildSubject(group.lang, notices.length, new Date());
    const toList  = group.recipients.map(r=>r.email);

    console.log(`📧 送信中 → [${groupName}] ${toList.join(", ")} (${notices.length}件)`);
    const {error} = await resend.emails.send({from:CONFIG.senderEmail,to:toList,subject,html});
    if (error) console.error(`❌ ${groupName}:`,error);
    else       console.log(`✅ ${groupName} 送信完了`);
  }
}

// ─── 起動 ─────────────────────────────────────────────────────────────────────

if (IS_TEST) {
  console.log("🧪 テストモード実行...");
  runMonitor().catch(console.error);
} else {
  console.log("✅ MK Monitor 起動");
  console.log(`⏰ スケジュール: 毎朝7時 (${CONFIG.timezone})`);
  RECIPIENTS.forEach(r=>r.email&&console.log(`   ${r.name}: ${r.email} [${r.lang}, ${r.filterLevel}]`));
  cron.schedule(CONFIG.schedule, ()=>runMonitor().catch(console.error), {timezone:CONFIG.timezone});
}
