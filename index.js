require("dotenv").config();
const cron = require("node-cron");
const fetch = require("node-fetch");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const IS_TEST = process.argv.includes("--test");

const RECIPIENTS = [
  { name:"HK",      email:process.env.EMAIL_HK,      filterLevel:"priority", lang:"ja",        group:"hk" },
  { name:"Nicolas", email:process.env.EMAIL_NICOLAS,  filterLevel:"priority", lang:"fr",        group:"nicolas" },
  { name:"Luana",   email:process.env.EMAIL_LUANA,    filterLevel:"all",      lang:"bilingual", group:"team" },
  { name:"Joana",   email:process.env.EMAIL_JOANA,    filterLevel:"all",      lang:"bilingual", group:"team" },
  { name:"Antoine", email:process.env.EMAIL_ANTOINE,  filterLevel:"all",      lang:"bilingual", group:"team" },
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
  "cinema","gallery","philharmonic","kulturhus","kulturzentrum",
  "biblioteca","teatro","museo","kultursenter",
  "博物館","美術館","図書館","文化センター","劇場","コンサートホール","文化施設",
];

const GEO = {
  1: { ja:"🇫🇷 フランス",        fr:"🇫🇷 France",              en:"🇫🇷 France",              keywords:["france","french"] },
  2: { ja:"🇨🇭🇸🇪 スイス/北欧",  fr:"🇨🇭🇸🇪 Suisse/Nordique",  en:"🇨🇭🇸🇪 Switzerland/Nordic", keywords:["switzerland","suisse","sweden","suède","norway","norvège","denmark","danemark","finland","finlande"] },
  3: { ja:"🌍 その他欧州",        fr:"🌍 Europe",                en:"🌍 Europe",                keywords:["germany","allemagne","belgium","belgique","netherlands","austria","autriche","spain","espagne","italy","italie","portugal","luxembourg","greece","uk","united kingdom","ireland"] },
  4: { ja:"🇯🇵 日本",             fr:"🇯🇵 Japon",                en:"🇯🇵 Japan",                keywords:["japan","japon","日本"] },
  5: { ja:"🌎 北米",              fr:"🌎 Amérique du Nord",      en:"🌎 North America",         keywords:["united states","usa","canada","états-unis"] },
  6: { ja:"🌏 東南アジア",        fr:"🌏 Asie du Sud-Est",       en:"🌏 Southeast Asia",        keywords:["thailand","thaïlande","indonesia","indonésie","india","inde"] },
  65:{ ja:"🕌 中東",              fr:"🕌 Moyen-Orient",          en:"🕌 Middle East",           keywords:["saudi","arabia","alula","al-ula","neom","uae","dubai","abu dhabi","qatar","bahrain","kuwait","oman","riyadh","الولايات"] },
  7: { ja:"🌐 その他",            fr:"🌐 Reste du monde",        en:"🌐 Rest of world",         keywords:["china","chine","arab","gulf","africa","afrique"] },
};

function detectGeo(notice) {
  const text = [notice.country,notice.region,notice.acheteur,notice.description,notice.title]
    .filter(Boolean).join(" ").toLowerCase();
  // 中東を優先チェック
  if (GEO[65].keywords.some(k=>text.includes(k))) return 65;
  for (let p=1;p<=7;p++) {
    if (p===65) continue;
    if (GEO[p]?.keywords.some(k=>text.includes(k.toLowerCase()))) return p;
  }
  if (["BOAMP"].includes(notice._source)) return 1;
  if (["SIMAP"].includes(notice._source)) return 2;
  if (["Doffin"].includes(notice._source)) return 2;
  if (["TED/OJEU"].includes(notice._source)) return 3;
  if (["JIA","MLIT"].includes(notice._source)) return 4;
  if (["RCU AlUla","NEOM"].includes(notice._source)) return 65;
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
  // 地域スコア（中東は別途加点）
  const geoScore = {1:35,2:30,3:25,4:20,5:15,65:18,6:10,7:5};
  score += geoScore[geo]||5;
  if (isCultural(notice)&&[1,2,3].includes(geo)) score+=15;
  if (notice.procedure==="Competition"||notice.nature==="Competition") score+=20;
  // AlUla/NEOMは特別加点
  const t2 = text;
  if (t2.includes("alula")||t2.includes("al-ula")||t2.includes("neom")) score+=25;
  return score;
}

// ─── ヘルパー：RSSパーサー ─────────────────────────────────────────────────────

function parseRSS(xml, source, mapFn) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g)||[];
  matches.forEach(item => {
    try {
      const get = (tag) => {
        const m = item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i"));
        return m ? m[1].trim() : "";
      };
      const mapped = mapFn(get, item);
      if (mapped && mapped.title) items.push({ _source: source, ...mapped });
    } catch(e) {}
  });
  return items;
}

async function safeFetch(url, options={}, source="") {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MKMonitor/1.0; +https://moreau-kusunoki.fr)",
        "Accept": "application/json, application/xml, text/xml, */*",
        ...options.headers,
      },
      timeout: 15000,
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch(e) {
    console.error(`⚠️ ${source} error: ${e.message}`);
    return null;
  }
}

// ─── BOAMP ─────────────────────────────────────────────────────────────────────

async function fetchBOAMP() {
  console.log("📡 BOAMP...");
  const cpvF = ALL_CPV.map(c=>`code_cpv like "${c.slice(0,5)}%"`).join(" OR ");
  const kwF  = CULTURAL_KW.slice(0,8).map(k=>`objet like "%${k}%"`).join(" OR ");
  const url  = `https://api.boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records?where=${encodeURIComponent(`(${cpvF}) OR (${kwF})`)}&order_by=date_publication%20DESC&limit=80`;
  const res  = await safeFetch(url, {}, "BOAMP");
  if (!res) return [];
  const data = await res.json();
  const results = (data.results||[]).map(r=>{
    const f=r.record?.fields||r.fields||r;
    return { _id:`boamp-${f.id||Math.random()}`, _source:"BOAMP", title:f.objet, description:f.description, acheteur:f.acheteur_denomination||f.pouvoir_adjudicateur, budget:f.valeur_totale||f.valeur_estimee, date_pub:f.date_publication, deadline:f.date_limite_reception, region:f.region||"France", country:"France", cpv:f.code_cpv, procedure:f.procedure, nature:f.nature, url:f.url_document||"https://www.boamp.fr" };
  });
  console.log(`  ✅ BOAMP: ${results.length}件`);
  return results;
}

// ─── TED/OJEU ─────────────────────────────────────────────────────────────────

async function fetchTED() {
  console.log("📡 TED/OJEU...");
  const url = `https://api.ted.europa.eu/v3/notices/search?${ARCH_CPV.slice(0,4).map(c=>`cpvs=${c}`).join("&")}&limit=40&page=1&sortField=publicationDate&sortOrder=desc`;
  const res = await safeFetch(url, {}, "TED");
  if (!res) return [];
  const data = await res.json();
  const notices = data.notices||data.results||data.items||[];
  const results = notices.map(n=>({ _id:`ted-${n.id||Math.random()}`, _source:"TED/OJEU", title:Array.isArray(n.title)?n.title[0]:n.title, description:Array.isArray(n.description)?n.description[0]:n.description, acheteur:Array.isArray(n["organisation-name"])?n["organisation-name"][0]:(n["organisation-name"]||n.buyerName), budget:n["value-pub"]||n["estimated-value"], date_pub:n["publication-date"]||n.publicationDate, deadline:n["deadline-date"]||n.submissionDeadline, country:n.country, region:n.country, cpv:Array.isArray(n["cpv-code"])?n["cpv-code"][0]:n["cpv-code"], procedure:n["procedure-type"], nature:n["notice-type"], url:n.link||"https://ted.europa.eu" }));
  console.log(`  ✅ TED: ${results.length}件`);
  return results;
}

// ─── SIMAP（スイス） ───────────────────────────────────────────────────────────

async function fetchSIMAP() {
  console.log("📡 SIMAP (Switzerland)...");
  const res = await safeFetch("https://api.ted.europa.eu/v3/notices/search?countries=CH&cpvs=71200000&cpvs=71220000&limit=20&page=1&sortField=publicationDate&sortOrder=desc", {}, "SIMAP");
  if (!res) return [];
  const data = await res.json();
  const items = (data.notices||[]).map(n=>({ _id:`simap-${n.id||Math.random()}`, _source:"SIMAP", title:Array.isArray(n.title)?n.title[0]:n.title, description:Array.isArray(n.description)?n.description[0]:n.description, acheteur:Array.isArray(n["organisation-name"])?n["organisation-name"][0]:n["organisation-name"], budget:n["value-pub"], date_pub:n["publication-date"], deadline:n["deadline-date"], country:"Switzerland", region:"Switzerland", cpv:Array.isArray(n["cpv-code"])?n["cpv-code"][0]:n["cpv-code"], procedure:n["procedure-type"], nature:n["notice-type"], url:n.link||"https://www.simap.ch" }));
  console.log(`  ✅ SIMAP: ${items.length}件`);
  return items;
}

// ─── Doffin（ノルウェー） ──────────────────────────────────────────────────────

async function fetchDoffin() {
  console.log("📡 Doffin (Norway)...");
  const res = await safeFetch("https://api.ted.europa.eu/v3/notices/search?countries=NO&cpvs=71200000&cpvs=71220000&limit=20&page=1&sortField=publicationDate&sortOrder=desc", {}, "Doffin");
  if (!res) return [];
  const data = await res.json();
  const items = (data.notices||[]).map(n=>({ _id:`doffin-${n.id||Math.random()}`, _source:"Doffin", title:Array.isArray(n.title)?n.title[0]:n.title, description:Array.isArray(n.description)?n.description[0]:n.description, acheteur:Array.isArray(n["organisation-name"])?n["organisation-name"][0]:n["organisation-name"], budget:n["value-pub"], date_pub:n["publication-date"], deadline:n["deadline-date"], country:"Norway", region:"Norway", cpv:Array.isArray(n["cpv-code"])?n["cpv-code"][0]:n["cpv-code"], procedure:n["procedure-type"], nature:n["notice-type"], url:n.link||"https://doffin.no" }));
  console.log(`  ✅ Doffin: ${items.length}件`);
  return items;
}

// ─── Bustler（国際コンペ） ─────────────────────────────────────────────────────

async function fetchBustler() {
  console.log("📡 Bustler...");
  const res = await safeFetch("https://bustler.net/rss/competitions", {}, "Bustler");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml, "Bustler", (get) => ({
    _id:`bustler-${Math.random()}`, title:get("title"),
    description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
    acheteur:get("dc:creator")||"", budget:null,
    date_pub:get("pubDate"), deadline:null, country:"", region:"",
    cpv:"", procedure:"Competition", nature:"Competition",
    url:get("link")||"https://bustler.net",
  }));
  console.log(`  ✅ Bustler: ${results.length}件`);
  return results;
}

// ─── Archmarathon ─────────────────────────────────────────────────────────────

async function fetchArchmarathon() {
  console.log("📡 Archmarathon...");
  const res = await safeFetch("https://archmarathon.com/competitions/feed/", {}, "Archmarathon");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml, "Archmarathon", (get) => ({
    _id:`arch-${Math.random()}`, title:get("title"),
    description:get("description").replace(/<[^>]*>/g,"").slice(0,300),
    acheteur:"", budget:null, date_pub:get("pubDate"), deadline:null,
    country:"", region:"", cpv:"", procedure:"Competition", nature:"Competition",
    url:get("link")||"https://archmarathon.com",
  }));
  console.log(`  ✅ Archmarathon: ${results.length}件`);
  return results;
}

// ─── RIBA（英国） ──────────────────────────────────────────────────────────────

async function fetchRIBA() {
  console.log("📡 RIBA...");
  const res = await safeFetch("https://competitions.architecture.com/feed/", {}, "RIBA");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml, "RIBA", (get) => ({
    _id:`riba-${Math.random()}`, title:get("title"),
    description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
    acheteur:get("dc:creator")||"RIBA", budget:null,
    date_pub:get("pubDate"), deadline:null, country:"UK", region:"UK",
    cpv:"71200000", procedure:"Competition", nature:"Competition",
    url:get("link")||"https://competitions.architecture.com",
  }));
  console.log(`  ✅ RIBA: ${results.length}件`);
  return results;
}

// ─── ArchDaily（国際コンペ） ──────────────────────────────────────────────────

async function fetchArchDaily() {
  console.log("📡 ArchDaily...");
  const res = await safeFetch("https://www.archdaily.com/competitions/feed/", {}, "ArchDaily");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml, "ArchDaily", (get) => ({
    _id:`ad-${Math.random()}`, title:get("title"),
    description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
    acheteur:"", budget:null, date_pub:get("pubDate"), deadline:null,
    country:"", region:"", cpv:"", procedure:"Competition", nature:"Competition",
    url:get("link")||"https://www.archdaily.com",
  }));
  console.log(`  ✅ ArchDaily: ${results.length}件`);
  return results;
}

// ─── 日本（JIA・国土交通省） ──────────────────────────────────────────────────

async function fetchJapan() {
  console.log("📡 Japan (JIA + MLIT)...");
  const allResults = [];

  // JIA（日本建築家協会）
  const jiaRes = await safeFetch("https://www.jia.or.jp/competition/feed/", {}, "JIA");
  if (jiaRes) {
    const xml = await jiaRes.text();
    const items = parseRSS(xml, "JIA", (get) => ({
      _id:`jia-${Math.random()}`, title:get("title"),
      description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
      acheteur:"日本建築家協会 / JIA", budget:null,
      date_pub:get("pubDate"), deadline:null,
      country:"Japan", region:"Japan",
      cpv:"71200000", procedure:"Competition", nature:"Competition",
      url:get("link")||"https://www.jia.or.jp/competition/",
    }));
    console.log(`  ✅ JIA: ${items.length}件`);
    allResults.push(...items);
  }

  // 国土交通省（設計競技・プロポーザル関連プレスリリース）
  const mlitRes = await safeFetch("https://www.mlit.go.jp/rss/report/press/kanbo.xml", {}, "MLIT");
  if (mlitRes) {
    const xml = await mlitRes.text();
    const items = parseRSS(xml, "MLIT", (get) => {
      const title = get("title");
      const desc  = get("description").replace(/<[^>]*>/g,"");
      const relevant = ["設計競技","コンペ","プロポーザル","設計者選定","建築設計","公共施設","文化施設"]
        .some(k => title.includes(k) || desc.includes(k));
      if (!relevant) return null;
      return {
        _id:`mlit-${Math.random()}`, title, description:desc.slice(0,400),
        acheteur:"国土交通省", budget:null,
        date_pub:get("pubDate"), deadline:null,
        country:"Japan", region:"Japan",
        cpv:"71200000", procedure:"Competition", nature:"Competition",
        url:get("link")||"https://www.mlit.go.jp",
      };
    }).filter(Boolean);
    console.log(`  ✅ MLIT: ${items.length}件`);
    allResults.push(...items);
  }

  // Bustler・Archmarathon日本案件（既存ソースからフィルタ）
  return allResults;
}

// ─── 中東（RCU AlUla・NEOM・UAE） ─────────────────────────────────────────────

async function fetchMiddleEast() {
  console.log("📡 Middle East (AlUla + NEOM + UAE)...");
  const allResults = [];

  // RCU AlUla — ニュース・コンペ情報
  const rcuSources = [
    "https://www.rcualula.gov.sa/en/feed/",
    "https://www.rcualula.gov.sa/feed/",
  ];
  for (const url of rcuSources) {
    const res = await safeFetch(url, {}, "RCU AlUla");
    if (!res) continue;
    const xml = await res.text();
    const items = parseRSS(xml, "RCU AlUla", (get) => {
      const title = get("title");
      const desc  = get("description").replace(/<[^>]*>/g,"");
      return {
        _id:`rcu-${Math.random()}`, title, description:desc.slice(0,400),
        acheteur:"Royal Commission for AlUla (RCU)", budget:null,
        date_pub:get("pubDate"), deadline:null,
        country:"Saudi Arabia", region:"AlUla",
        cpv:"71200000", procedure:"Competition", nature:"Competition",
        url:get("link")||"https://www.rcualula.gov.sa",
      };
    });
    if (items.length > 0) {
      console.log(`  ✅ RCU AlUla: ${items.length}件`);
      allResults.push(...items);
      break;
    }
  }

  // NEOM — プロジェクト・調達情報
  const neomRes = await safeFetch("https://www.neom.com/en-us/feed/", {}, "NEOM");
  if (neomRes) {
    const xml = await neomRes.text();
    const items = parseRSS(xml, "NEOM", (get) => {
      const title = get("title");
      const desc  = get("description").replace(/<[^>]*>/g,"");
      const relevant = ["architecture","design","competition","tender","construction","cultural","project","architect"]
        .some(k => title.toLowerCase().includes(k) || desc.toLowerCase().includes(k));
      if (!relevant) return null;
      return {
        _id:`neom-${Math.random()}`, title, description:desc.slice(0,400),
        acheteur:"NEOM", budget:null,
        date_pub:get("pubDate"), deadline:null,
        country:"Saudi Arabia", region:"NEOM",
        cpv:"71200000", procedure:"", nature:"",
        url:get("link")||"https://www.neom.com",
      };
    }).filter(Boolean);
    console.log(`  ✅ NEOM: ${items.length}件`);
    allResults.push(...items);
  }

  // UAE政府調達（TED経由）
  const uaeRes = await safeFetch("https://api.ted.europa.eu/v3/notices/search?countries=AE&cpvs=71200000&limit=10&page=1&sortField=publicationDate&sortOrder=desc", {}, "UAE");
  if (uaeRes) {
    const data = await uaeRes.json();
    const items = (data.notices||[]).map(n=>({
      _id:`uae-${n.id||Math.random()}`, _source:"UAE Procurement",
      title:Array.isArray(n.title)?n.title[0]:n.title,
      description:Array.isArray(n.description)?n.description[0]:n.description,
      acheteur:Array.isArray(n["organisation-name"])?n["organisation-name"][0]:n["organisation-name"],
      budget:n["value-pub"], date_pub:n["publication-date"], deadline:n["deadline-date"],
      country:"UAE", region:"UAE",
      cpv:Array.isArray(n["cpv-code"])?n["cpv-code"][0]:n["cpv-code"],
      procedure:n["procedure-type"], nature:n["notice-type"],
      url:n.link||"https://ted.europa.eu",
    }));
    console.log(`  ✅ UAE: ${items.length}件`);
    allResults.push(...items);
  }

  return allResults;
}

// ─── Museum Insider（購読後に有効化） ─────────────────────────────────────────

async function fetchMuseumInsider() {
  if (!process.env.MUSEUM_INSIDER_ENABLED) return [];
  console.log("📡 Museum Insider...");
  // TODO: 購読後、専用メールボックスとの連携で実装
  return [];
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
    ja:`Moreau Kusunoki建築事務所向けに以下の案件を分析。不明な場合は「不明」。JSONのみ返答。\n\n${noticeText}\n\n{"総工費":"","建築面積":"","建築タイプ":"新築/増築/改修","コンペの有無":"あり/なし/不明","審査基準":"","審査員":"","提出物":"","スケジュール":"","敷地の特徴":"","設計チーム構成":"","参加報酬":"","設計報酬上限":"","MKコメント":"MK事務所への適合性について一言"}`,
    fr:`Analysez cette notice pour Moreau Kusunoki Architectes. Indiquez "N/A" si inconnu. JSON uniquement.\n\n${noticeText}\n\n{"Coût total":"","Surface":"","Type de projet":"","Concours":"Oui/Non/N/A","Critères de sélection":"","Jury":"","Pièces à fournir":"","Calendrier":"","Caractéristiques du site":"","Équipe requise":"","Indemnité de concours":"","Plafond honoraires":"","Commentaire":""}`,
    bilingual:`Analyse for Moreau Kusunoki Architects. Use "N/A" if unknown. JSON only.\n\n${noticeText}\n\n{"Total cost":"","Area":"","Project type":"","Competition":"Yes/No/N/A","Selection criteria":"","Jury":"","Deliverables":"","Schedule":"","Site characteristics":"","Team required":"","Competition fee":"","Fee cap":"","Comment":""}`,
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":CONFIG.anthropicKey,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,messages:[{role:"user",content:prompts[lang]||prompts.bilingual}]}),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content.map(c=>c.text||"").join("").trim();
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e) { return null; }
}

// ─── メールHTML ────────────────────────────────────────────────────────────────

const LABELS = {
  ja:        { title:"MK Monitor", total:"新着案件",       cultural:"文化施設", budget:"+1M€", feeAlert:"⚠️ 設計報酬上限", footer:"情報源: BOAMP · TED · SIMAP · Doffin · Bustler · Archmarathon · RIBA · JIA · RCU AlUla · NEOM　|　MK条件①〜⑧　|　毎朝7時（パリ時間）" },
  fr:        { title:"MK Monitor", total:"Nouvelles",      cultural:"Culturel", budget:"+1M€", feeAlert:"⚠️ Plafond",     footer:"Sources : BOAMP · TED · SIMAP · Doffin · Bustler · Archmarathon · RIBA · JIA · RCU AlUla · NEOM  |  Critères MK ①–⑧  |  7h00 Paris" },
  bilingual: { title:"MK Monitor", total:"New notices",    cultural:"Cultural", budget:"+1M€", feeAlert:"⚠️ Fee cap",     footer:"Sources: BOAMP · TED · SIMAP · Doffin · Bustler · Archmarathon · RIBA · JIA · RCU AlUla · NEOM  |  MK criteria ①–⑧  |  Daily 7:00 AM Paris" },
};

const SOURCE_COLORS = {
  "BOAMP":          {bg:"#dbeafe",fg:"#1d4ed8"},
  "TED/OJEU":       {bg:"#d1fae5",fg:"#065f46"},
  "SIMAP":          {bg:"#fef3c7",fg:"#92400e"},
  "Doffin":         {bg:"#ede9fe",fg:"#5b21b6"},
  "Bustler":        {bg:"#fce7f3",fg:"#9d174d"},
  "Archmarathon":   {bg:"#fff7ed",fg:"#c2410c"},
  "RIBA":           {bg:"#f0fdf4",fg:"#166534"},
  "ArchDaily":      {bg:"#fdf4ff",fg:"#6b21a8"},
  "JIA":            {bg:"#fef9c3",fg:"#854d0e"},
  "MLIT":           {bg:"#fff1f2",fg:"#9f1239"},
  "RCU AlUla":      {bg:"#f0f9ff",fg:"#0369a1"},
  "NEOM":           {bg:"#f0fdfa",fg:"#0f766e"},
  "UAE Procurement":{bg:"#fdf2f8",fg:"#86198f"},
  "Museum Insider": {bg:"#fef2f2",fg:"#991b1b"},
};

function getGeoOrder(geo) {
  const order = {1:1,2:2,3:3,4:4,5:5,65:6,6:7,7:8};
  return order[geo]||9;
}

function buildNoticeHtml(notice, lang) {
  const L = LABELS[lang];
  const geo = detectGeo(notice);
  const geoInfo = GEO[geo]||GEO[7];
  const geoLabel = geoInfo[lang==="bilingual"?"en":lang]||geoInfo.en;
  const budget = formatBudget(notice.budget);
  const cultural = isCultural(notice);
  const isComp = notice.procedure==="Competition"||notice.nature==="Competition";
  const deadline = notice.deadline ? new Date(notice.deadline).toLocaleDateString("fr-FR",{day:"numeric",month:"short",year:"numeric"}) : null;
  const srcColor = SOURCE_COLORS[notice._source]||{bg:"#f1f5f9",fg:"#475569"};

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
        ${cultural?`<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:3px;background:#d1fae5;color:#065f46">${lang==="ja"?"文化施設":lang==="fr"?"CULTUREL":"CULTURAL"}</span>`:""}
        ${isComp?`<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:3px;background:#fdf4ff;color:#6b21a8">${lang==="ja"?"コンペ":lang==="fr"?"CONCOURS":"COMPETITION"}</span>`:""}
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
  const geoOrder = Object.keys(grouped).sort((a,b)=>getGeoOrder(parseInt(a))-getGeoOrder(parseInt(b)));
  for (const geo of geoOrder) {
    const geoInfo = GEO[parseInt(geo)]||GEO[7];
    const geoLabel = geoInfo[lang==="bilingual"?"en":lang]||geoInfo.en;
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

  const [boamp,ted,simap,doffin,bustler,archmarathon,riba,archdaily,japan,middleEast,museumInsider] = await Promise.all([
    fetchBOAMP(), fetchTED(), fetchSIMAP(), fetchDoffin(),
    fetchBustler(), fetchArchmarathon(), fetchRIBA(), fetchArchDaily(),
    fetchJapan(), fetchMiddleEast(), fetchMuseumInsider(),
  ]);

  const all = [...boamp,...ted,...simap,...doffin,...bustler,...archmarathon,...riba,...archdaily,...japan,...middleEast,...museumInsider];
  console.log(`\n✅ 合計取得: ${all.length}件`);

  const scored = all
    .map(n=>({...n,_score:scoreNotice(n),_geo:detectGeo(n)}))
    .filter(n=>{
      const b=parseBudget(n.budget);
      if (b>=1000000) return true;
      if (isCultural(n)&&[1,2,3,4,65].includes(n._geo)) return true;
      if (n.procedure==="Competition"||n.nature==="Competition") return true;
      if (n._score>=10) return true;
      return false;
    })
    .sort((a,b)=>b._score-a._score);

  const priorityNotices = scored.filter(n=>n._score>=CONFIG.priorityScore);
  console.log(`📊 全案件: ${scored.length}件 / 優先度高: ${priorityNotices.length}件`);

  console.log("🤖 AIサマリー生成中...");
  for (const n of priorityNotices.slice(0,10)) {
    n._summary = await generateSummary(n,"bilingual");
    if (n._summary) process.stdout.write(".");
  }
  console.log("\n✅ サマリー完了");

  const groups = {};
  for (const r of RECIPIENTS) {
    if (!r.email) continue;
    if (!groups[r.group]) groups[r.group]={recipients:[],lang:r.lang,filterLevel:r.filterLevel};
    groups[r.group].recipients.push(r);
  }

  for (const [groupName,group] of Object.entries(groups)) {
    const notices = group.filterLevel==="priority" ? priorityNotices : scored;
    if (notices.length===0) { console.log(`📭 ${groupName}: 対象案件なし、スキップ`); continue; }
    const html    = buildEmail(notices,group.lang,new Date());
    const subject = buildSubject(group.lang,notices.length,new Date());
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
  cron.schedule(CONFIG.schedule,()=>runMonitor().catch(console.error),{timezone:CONFIG.timezone});
}
