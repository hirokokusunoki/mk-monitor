require("dotenv").config();
const cron    = require("node-cron");
const fetch   = require("node-fetch");
const express = require("express");
const { Resend } = require("resend");
const partnerDB    = require("./partners");

// Resend初期化（APIキーがない場合はnull、メール送信をスキップ）
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
if (!resend) console.warn("⚠️  RESEND_API_KEY が未設定です。メール送信は無効化されています。");
const IS_TEST = process.argv.includes("--test");
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
partnerDB(app);

const RECIPIENTS = [
  { name:"HK",      email:process.env.EMAIL_HK,      filterLevel:"priority", lang:"ja",        group:"hk" },
  { name:"Nicolas", email:process.env.EMAIL_NICOLAS,  filterLevel:"priority", lang:"fr",        group:"nicolas" },
  { name:"Luana",   email:process.env.EMAIL_LUANA,    filterLevel:"all",      lang:"bilingual", group:"team" },
  { name:"Joana",   email:process.env.EMAIL_JOANA,    filterLevel:"all",      lang:"bilingual", group:"team" },
  { name:"Antoine", email:process.env.EMAIL_ANTOINE,  filterLevel:"all",      lang:"bilingual", group:"team" },
  { name:"Shohei",  email:process.env.EMAIL_SHOHEI,   filterLevel:"japan",    lang:"ja",        group:"shohei" },
];

const CONFIG = {
  senderEmail:   process.env.SENDER_EMAIL || "onboarding@resend.dev",
  anthropicKey:  process.env.ANTHROPIC_API_KEY,
  timezone:      "Europe/Paris",
  schedule:      "0 7 * * *",
  priorityScore: parseInt(process.env.PRIORITY_SCORE || "15"),
};

// ─── ユーティリティ ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cleanText(str, maxLen = 400) {
  if (!str) return "";
  return String(str)
    .replace(/<[^>]*>/g, "") // HTMLタグ除去
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}



const BUILDING_TYPES = {
  cultural: {
    label: { ja:"文化施設", fr:"Culturel", en:"Cultural" },
    color: "#065f46",
    bg:    "#d1fae5",
    keywords: [
      "musée","médiathèque","bibliothèque","théâtre","opéra","centre culturel",
      "salle de spectacle","conservatoire","école d'art","équipement culturel",
      "monument","patrimoine","cinéma","galerie","auditorium","philharmonie",
      "maison de la culture","cité de la musique","centre d'art","maison des arts",
      "museum","library","theatre","theater","opera","cultural centre","cultural center",
      "concert hall","conservatory","arts school","heritage","cinema","gallery",
      "philharmonic","kulturhus","learning centre","learning center","media center",
      "médiathèque","博物館","美術館","図書館","劇場","文化センター","ギャラリー",
    ],
    cpv: ["92000000","92100000","92300000","92310000","45212300","45212310","45212314"],
  },
  education: {
    label: { ja:"教育施設", fr:"Éducation", en:"Education" },
    color: "#1d4ed8",
    bg:    "#dbeafe",
    keywords: [
      "école","lycée","collège","université","campus","établissement scolaire",
      "école primaire","école secondaire","école maternelle","grande école",
      "centre de formation","école supérieure","institut","académie",
      "school","university","college","campus","academy","institute",
      "learning center","education center","kindergarten","nursery",
      "学校","大学","キャンパス","小学校","中学校","高校","幼稚園",
    ],
    cpv: ["45214000","45214100","45214200","45214300","45214400","80000000","80100000","80200000","80300000"],
  },
  hospitality: {
    label: { ja:"ホスピタリティ", fr:"Hôtellerie", en:"Hospitality" },
    color: "#92400e",
    bg:    "#fef3c7",
    keywords: [
      "hôtel","resort","auberge","hôtellerie","établissement hôtelier","spa","lodge",
      "hotel","resort","hospitality","inn","lodge","accommodation","wellness center",
      "ホテル","リゾート","宿泊施設",
    ],
    cpv: ["45211100","55100000","55110000","55120000","55200000"],
  },
  infrastructure: {
    label: { ja:"インフラ", fr:"Infrastructure", en:"Infrastructure" },
    color: "#5b21b6",
    bg:    "#ede9fe",
    keywords: [
      "gare","aéroport","station","terminal","hub de transport","infrastructure de transport",
      "port","quai","passerelle","pont","tunnel","métro","tramway",
      "airport","railway station","train station","transport hub","terminal","port",
      "bridge","tunnel","metro","tram","transit","駅","空港","ターミナル","橋",
    ],
    cpv: ["45234000","45234100","45234200","45213000","60000000","34000000","45221000"],
  },
  office: {
    label: { ja:"オフィス", fr:"Bureau", en:"Office" },
    color: "#374151",
    bg:    "#f3f4f6",
    keywords: [
      "bureau","immeuble de bureaux","siège social","immeuble tertiaire","tour de bureaux",
      "bâtiment administratif","mairie","hôtel de ville","préfecture","palais de justice",
      "office","headquarters","office building","administrative building","town hall",
      "courthouse","government building","civic center","city hall",
      "オフィス","庁舎","役所","裁判所","行政施設",
    ],
    cpv: ["45213100","45213200","45213300","70000000","70100000","70200000"],
  },
};

// 全CPVコードと全キーワードをフラットに展開
const ALL_KEYWORDS = Object.values(BUILDING_TYPES).flatMap(t => t.keywords);
const ALL_CPV      = [...new Set(Object.values(BUILDING_TYPES).flatMap(t => t.cpv))];
const ARCH_CPV     = ["71200000","71220000","71221000","71222000","71240000","71300000"];
const ALL_FETCH_CPV = [...new Set([...ARCH_CPV, ...ALL_CPV])];

function detectBuildingType(notice) {
  const text = [notice.title,notice.description].filter(Boolean).join(" ").toLowerCase();
  for (const [type, cfg] of Object.entries(BUILDING_TYPES)) {
    if (cfg.keywords.some(k => text.includes(k.toLowerCase()))) return type;
  }
  return null;
}

function extractDeadlineFromText(text) {
  if (!text) return null;
  // 日付パターンを説明文から抽出
  const patterns = [
    // 2025年3月31日、2025/03/31
    /(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/,
    // 31 March 2025, March 31 2025
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})[,\s]+(\d{4})/i,
    // 31/03/2025, 31-03-2025
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    // deadline: 31 mars 2025
    /(?:deadline|échéance|date limite|締切|応募期限)[^\d]*(\d{1,2})[\/\-\s](\d{1,2})[\/\-\s](\d{4})/i,
  ];

  const deadlineKW = ["deadline","date limite","échéance","closing date","submission","応募期限","締切","提出期限"];
  const lowerText = text.toLowerCase();
  const hasDeadlineKW = deadlineKW.some(k => lowerText.includes(k));

  if (!hasDeadlineKW) return null;

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const date = new Date(match[0].replace(/年|月/g, "/").replace(/日/g, ""));
        if (!isNaN(date.getTime()) && date > new Date()) return date.toISOString();
      } catch(e) {}
    }
  }
  return null;
}



const EXCLUSIVITY_KW = [
  // フランス語
  "exclusivité","exclusif","exclusive","clause d'exclusivité",
  "engagement d'exclusivité","ne peut participer qu'à",
  "ne peut être membre que d'un","ne peut figurer que dans un",
  "un même prestataire ne peut","un même bureau ne peut",
  "un même co-traitant ne peut","chaque sous-traitant ne peut",
  "chaque co-traitant ne peut","chaque bureau d'études ne peut",
  "un seul groupement","ne peut appartenir qu'à",
  "interdit de participer à plusieurs","candidater à plusieurs",
  "membre de plusieurs candidatures","plusieurs équipes",
  // 英語
  "exclusivity clause","exclusive participation",
  "cannot participate in more than one","one team only",
  "single team participation",
];

function hasExclusivity(notice) {
  const text = [notice.title, notice.description].filter(Boolean).join(" ").toLowerCase();
  return EXCLUSIVITY_KW.some(k => text.includes(k.toLowerCase()));
}



const GEO = {
  1:  { ja:"🇫🇷 フランス",       fr:"🇫🇷 France",             en:"🇫🇷 France",            order:1, keywords:["france","french"] },
  2:  { ja:"🇨🇭🇸🇪 スイス/北欧", fr:"🇨🇭🇸🇪 Suisse/Nordique", en:"🇨🇭🇸🇪 Switzerland/Nordic",order:2, keywords:["switzerland","suisse","sweden","suède","norway","norvège","denmark","danemark","finland","finlande"] },
  3:  { ja:"🌍 その他欧州",       fr:"🌍 Europe",               en:"🌍 Europe",              order:3, keywords:["germany","allemagne","belgium","belgique","netherlands","austria","autriche","spain","espagne","italy","italie","portugal","luxembourg","greece","uk","united kingdom","ireland"] },
  4:  { ja:"🇯🇵 日本",            fr:"🇯🇵 Japon",               en:"🇯🇵 Japan",              order:4, keywords:["japan","japon","日本"] },
  5:  { ja:"🌎 北米",             fr:"🌎 Amérique du Nord",     en:"🌎 North America",       order:5, keywords:["united states","usa","canada"] },
  65: { ja:"🕌 中東",             fr:"🕌 Moyen-Orient",         en:"🕌 Middle East",         order:6, keywords:["saudi","alula","al-ula","neom","uae","dubai","abu dhabi","qatar","bahrain","kuwait","oman","riyadh"] },
  6:  { ja:"🌏 東南アジア",       fr:"🌏 Asie du Sud-Est",      en:"🌏 Southeast Asia",      order:7, keywords:["thailand","thaïlande","indonesia","indonésie","india","inde"] },
  7:  { ja:"🌐 その他",           fr:"🌐 Reste du monde",       en:"🌐 Rest of world",       order:8, keywords:["china","chine","africa","afrique"] },
};

function detectGeo(notice) {
  const text = [notice.country,notice.region,notice.acheteur,notice.description,notice.title]
    .filter(Boolean).join(" ").toLowerCase();
  if (GEO[65].keywords.some(k=>text.includes(k))) return 65;
  for (const [p,g] of Object.entries(GEO)) {
    if (parseInt(p)===65) continue;
    if (g.keywords.some(k=>text.includes(k.toLowerCase()))) return parseInt(p);
  }
  const srcGeo = { "BOAMP":1,"SIMAP":2,"Doffin":2,"TED/OJEU":3,"JIA":4,"MLIT":4,"RCU AlUla":65,"NEOM":65 };
  return srcGeo[notice._source] || 7;
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
  const text   = [notice.title,notice.description].filter(Boolean).join(" ").toLowerCase();
  const cpv    = notice.cpv||"";
  const budget = parseBudget(notice.budget);
  const geo    = detectGeo(notice);
  const bType  = detectBuildingType(notice);
  const isExcl = hasExclusivity(notice);

  // キーワードマッチ
  ALL_KEYWORDS.forEach(k=>{if(text.includes(k.toLowerCase()))score+=6});
  // CPVマッチ
  ALL_FETCH_CPV.forEach(c=>{if(cpv.startsWith(c.slice(0,5)))score+=12});
  // 予算スコア
  if (budget>=5000000)      score+=30;
  else if (budget>=1000000) score+=20;
  else if (budget>=500000)  score+=8;
  // 地域スコア
  const geoBonus = {1:35,2:30,3:25,4:20,5:15,65:20,6:10,7:5};
  score += geoBonus[geo]||5;
  // 建物タイプボーナス
  if (bType==="cultural")        score+=20;
  else if (bType==="education")  score+=15;
  else if (bType==="hospitality")score+=12;
  else if (bType==="infrastructure")score+=10;
  else if (bType==="office")     score+=8;
  // コンペは加点
  if (notice.procedure==="Competition"||notice.nature==="Competition") score+=20;
  // AlUla/NEOM特別加点
  if (text.includes("alula")||text.includes("al-ula")||text.includes("neom")) score+=25;
  return score;
}

// ─── RSSパーサー・safeFetch ────────────────────────────────────────────────────

function parseRSS(xml, source, mapFn) {
  const items = [];
  const matches = xml.match(/<item>([\s\S]*?)<\/item>/g)||[];
  matches.forEach(item => {
    try {
      const get = (tag) => {
        // CDATA形式と通常形式の両方に対応
        const cdataMatch = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"));
        if (cdataMatch) return cdataMatch[1].trim();
        const normalMatch = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
        if (normalMatch) return cleanText(normalMatch[1]);
        return "";
      };
      const mapped = mapFn(get, item);
      if (mapped && mapped.title && mapped.title.trim().length > 3) {
        items.push({ _source: source, ...mapped });
      }
    } catch(e) {}
  });
  return items;
}

async function safeFetch(url, options={}, source="") {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent":"Mozilla/5.0 (compatible; MKMonitor/1.0)", "Accept":"application/json, application/xml, text/xml, */*", ...options.headers },
      timeout: 15000, ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch(e) {
    console.error(`⚠️ ${source}: ${e.message}`);
    return null;
  }
}

// ─── BOAMP（data.gouv.fr経由） ─────────────────────────────────────────────────

async function fetchBOAMP() {
  console.log("📡 BOAMP...");

  // boamp-datadila.opendatasoft.comはアクセス可能（400はクエリ形式の問題）
  // まずフィルターなしで試行し、その後クライアントサイドでフィルタリング
  const endpoints = [
    // フィルターなし版（最も互換性が高い）
    `https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records?limit=80&offset=0`,
    // シンプルなキーワード版
    `https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records?q=architecture+culturel+musée+école&limit=80`,
    // api.boamp.fr フィルターなし
    `https://api.boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records?limit=80&offset=0`,
  ];

  const KW = [
    // 文化・展示
    "musée","muséo","galerie","exposit","patrimoine","monument","historique",
    "réhabilitation","rénovation","restauration","restructuration","réaménagement",
    "théâtre","opéra","philharmonie","concert","salle de spectacle","auditorium",
    "cinéma","médiathèque","bibliothèque","archives","conservatoire",
    "culturel","culture","artistique","art","œuvre",
    // 教育
    "école","collège","lycée","université","campus","internat","EPLE",
    "enseignement","formation","recherche",
    // ホスピタリティ・観光
    "hôtel","hébergement","resort","tourisme","accueil",
    // 公共施設
    "mairie","hôtel de ville","préfecture","tribunal","justice","palais",
    "centre","équipement","bâtiment public","ouvrage public",
    "sport","piscine","gymnase","stade",
    // インフラ
    "gare","aéroport","transport","mobilité",
    // 建築一般
    "maîtrise d'œuvre","conception","construction","architecture",
    "bureau","logement","résidence",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
        timeout: 15000,
      });

      if (!res.ok) {
        const errText = await res.text().catch(()=>"").then(t=>t.slice(0,100));
        console.error(`  ⚠️ BOAMP ${res.status} (${url.split("/")[2]}): ${errText}`);
        continue;
      }

      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text); } catch(e) { console.error("  ⚠️ BOAMP JSON parse error:", e.message); continue; }
      const rows = data.results||data.data||data.records||[];

      if (rows.length === 0) {
        console.log(`  ⚠️ BOAMP 0件 (${url.split("/")[2]})`);
        continue;
      }

      // クライアントサイドでフィルタリング
      const results = rows.map(r => {
        const f = r.record?.fields || r.fields || r;
        if (!f.objet || f.objet.trim().length < 3) return null;
        const text = [(f.objet||""),(f.description||""),(f.descripteur_libelle||""),(f.nature||""),(f.typemarche||"")].join(" ").toLowerCase();
        const cpv = String(f.code_cpv||f.cpv||"");
        const isRelevant = KW.some(k=>text.includes(k)) ||
          ["7120","7122","7121","7123","7124","4521","4522","9200","9201","9202","9203"].some(c=>cpv.startsWith(c));
        if (!isRelevant) return null;
        return {
          _id:`boamp-${f.id||f.idweb||Math.random()}`, _source:"BOAMP",
          title: cleanText(f.objet),
          description: cleanText(f.descripteur_libelle||f.description||""),
          acheteur: f.acheteur_denomination||f.denominationacheteur||f.pouvoir_adjudicateur||"",
          budget: f.valeur_totale||f.valeur_estimee||f.montant||null,
          date_pub: f.date_publication||f.dateparution,
          deadline: f.date_limite_reception||f.datelimitereponse,
          region: f.region||f.departement||"France",
          country: "France",
          cpv: f.code_cpv||f.cpv,
          procedure: f.procedure,
          nature: f.nature||f.typemarche,
          url: f.url_document||f.urlboamp||`https://www.boamp.fr`,
        };
      }).filter(Boolean);

      console.log(`  ✅ BOAMP: ${results.length}件 / ${rows.length}件中 (${url.split("/")[2]})`);
      return results;

    } catch(e) {
      console.error(`  ⚠️ BOAMP error (${url.split("/")[2]}): ${e.message}`);
    }
  }

  console.error("  ❌ BOAMP: 全エンドポイント失敗");
  return [];
}

// ─── TED APIヘルパー（v3 POST、fieldsなし） ──────────────────────────────────

// TED RSS feeds by CPV code
async function fetchTEDFeed(cpv, label) {
  const url = `https://ted.europa.eu/TED_RSSS/rss/ted-daily-view/cpv/${cpv}`;
  const res = await safeFetch(url, {}, `TED-${cpv}`);
  if (!res) return [];
  const xml = await res.text();
  return parseRSS(xml, "TED/OJEU", (get) => {
    const title = get("title");
    if (!title || title.length < 3) return null;
    return {
      _id: `ted-${cpv}-${Math.random()}`,
      _source: "TED/OJEU",
      title: cleanText(title),
      description: cleanText(get("description").replace(/<[^>]*>/g,"").slice(0,400)),
      acheteur: get("dc:creator") || get("author") || "",
      budget: null,
      date_pub: get("pubDate"),
      deadline: null,
      country: label || "Europe",
      region: label || "Europe",
      cpv: String(cpv),
      procedure: "Tender",
      nature: "Tender",
      url: get("link") || "https://ted.europa.eu",
    };
  });
}

async function tedSearch(query, limit=30) {
  // fieldsを省略して試行（空もNG、無効名もNG → 省略）
  // TED API v3 requires "fields" to not be empty
  const body = {
    query,
    page: 1,
    limit,
    fields: ["submission-url-lot","organisation-city-serv-prov","sme-part"],
  };
  try {
    const res = await fetch("https://api.ted.europa.eu/v3/notices/search", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Accept":"application/json",
                 "User-Agent":"Mozilla/5.0 (compatible; MKMonitor/1.0)" },
      body: JSON.stringify(body),
      timeout: 15000,
    });
    if (!res.ok) {
      const errText = await res.text().catch(()=>"");
      console.error(`⚠️ TED HTTP ${res.status}: ${errText.slice(0,300)}`);
      return null;
    }
    const text = await res.text();
    if (!tedSearch._logged) {
      tedSearch._logged = true;
      try {
        const sample = JSON.parse(text);
        const keys = Object.keys(sample);
        const first = (sample.notices||sample.results||[])[0];
        console.log("  TED response keys:", keys.join(", "));
        if (first) console.log("  TED notice keys:", Object.keys(first).slice(0,20).join(", "));
        else console.log("  TED: no notices in response. Sample:", text.slice(0,200));
      } catch(e) { console.log("  TED raw:", text.slice(0,200)); }
    }
    return { ok: true, _text: text };
  } catch(e) {
    console.error(`⚠️ TED error: ${e.message}`);
    return null;
  }
}

function mapTEDNotice(n, source="TED/OJEU", countryOverride=null) {
  // 取得できたキーに合わせて柔軟にマッピング
  const get = (...keys) => {
    for (const k of keys) {
      const v = n[k];
      if (!v) continue;
      const s = Array.isArray(v) ? (v.find(x=>x&&String(x).trim().length>2)||v[0]) : v;
      if (s && String(s).trim().length > 0) return String(s).trim();
    }
    return "";
  };
  const title = get("title","notice-title","subject","name","BT-21-Procedure","procedure-title");
  if (title.length < 3) return null;
  return {
    _id: `${source.toLowerCase().replace(/[^a-z]/g,"-")}-${get("id","publication-number","nd")||Math.random()}`,
    _source: source,
    title: cleanText(title),
    description: cleanText(get("description","summary","content","BT-23-Procedure","short-description")),
    acheteur: cleanText(get("organisation-name","buyer-name","buyer","authority","OPP-052-Organization")),
    budget: n["value-pub"]||n["estimated-value"]||n.value||null,
    date_pub: get("publication-date","publicationDate","published-date"),
    deadline: get("deadline-date","submissionDeadline","submission-deadline","deadline"),
    country: countryOverride||get("country","buyer-country","location","place"),
    region:  countryOverride||get("country","buyer-country","location","place"),
    cpv: get("cpv-code","cpv","cpvCodes","cpv-codes"),
    procedure: get("procedure-type","procedure","form-type"),
    nature: get("notice-type","noticeType","type","form-type"),
    url: get("link","permalink","url")||"https://ted.europa.eu",
  };
}

async function fetchTED() {
  console.log("📡 TED/OJEU...");
  // CPVコード別RSSフィード（APIより安定）
  const feeds = [
    { cpv: "71200000", label: "Europe" },  // Architectural services
    { cpv: "71220000", label: "Europe" },  // Architectural design services
    { cpv: "71221000", label: "Europe" },  // Architectural services for buildings
    { cpv: "45210000", label: "Europe" },  // Building construction work
    { cpv: "92000000", label: "Europe" },  // Cultural services
  ];
  const allResults = [];
  for (const { cpv, label } of feeds) {
    const items = await fetchTEDFeed(cpv, label);
    allResults.push(...items);
  }
  const unique = allResults.filter((n,i,arr)=>arr.findIndex(x=>x.title===n.title)===i);
  console.log(`  ✅ TED: ${unique.length}件`);
  return unique;
}

// ─── SIMAP（スイス：TED経由） ─────────────────────────────────────────────────

async function fetchSIMAP() {
  console.log("📡 SIMAP (Switzerland)...");
  // SIMAPはsimap.ch直接、またはTEDのCH向けフィード
  const urls = [
    "https://www.simap.ch/shabforms/COMMON/application/applicationGrid.do?method=display&feed=true",
    "https://ted.europa.eu/TED_RSSS/rss/ted-daily-view/cpv/71200000/country/CH",
    "https://ted.europa.eu/TED_RSSS/rss/ted-daily-view/cpv/71220000/country/CH",
  ];
  const allItems = [];
  for (const url of urls) {
    const res = await safeFetch(url, {}, "SIMAP");
    if (!res) continue;
    const xml = await res.text();
    const items = parseRSS(xml, "SIMAP", (get) => {
      const title = get("title");
      if (!title || title.length < 3) return null;
      return {
        _id: `simap-${Math.random()}`,
        _source: "SIMAP",
        title: cleanText(title),
        description: cleanText(get("description").replace(/<[^>]*>/g,"").slice(0,400)),
        acheteur: get("dc:creator") || "",
        budget: null,
        date_pub: get("pubDate"),
        deadline: null,
        country: "Switzerland", region: "Switzerland",
        cpv: "71200000", procedure: "Tender", nature: "Tender",
        url: get("link") || "https://www.simap.ch",
      };
    });
    if (items.length > 0) { allItems.push(...items); break; }
  }
  console.log(`  ✅ SIMAP: ${allItems.length}件`);
  return allItems;
}

// ─── Doffin（ノルウェー：TED経由） ───────────────────────────────────────────

async function fetchDoffin() {
  console.log("📡 Doffin (Norway)...");
  const urls = [
    "https://ted.europa.eu/TED_RSSS/rss/ted-daily-view/cpv/71200000/country/NO",
    "https://ted.europa.eu/TED_RSSS/rss/ted-daily-view/cpv/71220000/country/NO",
    "https://kgv.doffin.no/en/notice/rss",
  ];
  const allItems = [];
  for (const url of urls) {
    const res = await safeFetch(url, {}, "Doffin");
    if (!res) continue;
    const xml = await res.text();
    const items = parseRSS(xml, "Doffin", (get) => {
      const title = get("title");
      if (!title || title.length < 3) return null;
      return {
        _id: `doffin-${Math.random()}`,
        _source: "Doffin",
        title: cleanText(title),
        description: cleanText(get("description").replace(/<[^>]*>/g,"").slice(0,400)),
        acheteur: get("dc:creator") || "",
        budget: null,
        date_pub: get("pubDate"),
        deadline: null,
        country: "Norway", region: "Norway",
        cpv: "71200000", procedure: "Tender", nature: "Tender",
        url: get("link") || "https://kgv.doffin.no",
      };
    });
    if (items.length > 0) { allItems.push(...items); break; }
  }
  console.log(`  ✅ Doffin: ${allItems.length}件`);
  return allItems;
}

// ─── Bustler ──────────────────────────────────────────────────────────────────

async function fetchBustler() {
  console.log("📡 Bustler...");
  const res = await safeFetch("https://bustler.net/rss/competitions",{},"Bustler");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml,"Bustler",(get)=>({
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

// ─── ArchDaily ────────────────────────────────────────────────────────────────

async function fetchArchDaily() {
  console.log("📡 ArchDaily...");
  const res = await safeFetch("https://www.archdaily.com/competitions/feed/",{},"ArchDaily");
  if (!res) return [];
  const xml = await res.text();
  const results = parseRSS(xml,"ArchDaily",(get)=>({
    _id:`ad-${Math.random()}`, title:get("title"),
    description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
    acheteur:"", budget:null, date_pub:get("pubDate"), deadline:null,
    country:"", region:"", cpv:"", procedure:"Competition", nature:"Competition",
    url:get("link")||"https://www.archdaily.com",
  }));
  console.log(`  ✅ ArchDaily: ${results.length}件`);
  return results;
}

// ─── RIBA ─────────────────────────────────────────────────────────────────────

async function fetchRIBA() {
  console.log("📡 RIBA...");
  // RIBAのフィードURLを複数試行（URLが変更された可能性あり）
  const ribaUrls = [
    "https://www.architecture.com/riba/competitions/feed/",
    "https://www.architecture.com/awards-and-competitions-landing-page/competitions/feed/",
    "https://www.architecture.com/knowledge-and-resources/find-an-architect/competitions/feed/",
  ];
  for (const url of ribaUrls) {
    const res = await safeFetch(url, {}, "RIBA");
    if (!res) continue;
    const xml = await res.text();
    const results = parseRSS(xml,"RIBA",(get)=>({
      _id:`riba-${Math.random()}`, title:get("title"),
      description:get("description").replace(/<[^>]*>/g,"").slice(0,400),
      acheteur:"RIBA", budget:null, date_pub:get("pubDate"), deadline:null,
      country:"UK", region:"UK", cpv:"71200000",
      procedure:"Competition", nature:"Competition",
      url:get("link")||"https://www.architecture.com",
    }));
    if (results.length > 0) {
      console.log(`  ✅ RIBA: ${results.length}件`);
      return results;
    }
  }
  console.log("  ⚠️ RIBA: 全URL失敗または0件");
  return [];
}

// ─── 日本（JIA・国土交通省） ──────────────────────────────────────────────────

async function fetchJapan() {
  console.log("📡 Japan...");
  const allResults = [];

  const jiaRes = await safeFetch("https://www.jia.or.jp/competition/feed/",{},"JIA");
  if (jiaRes) {
    const xml = await jiaRes.text();
    const items = parseRSS(xml, "JIA", (get) => {
      const desc = get("description").replace(/<[^>]*>/g,"").slice(0,600);
      const extractedDeadline = extractDeadlineFromText(desc);
      return {
        _id:`jia-${Math.random()}`, title:get("title"),
        description: cleanText(desc, 400),
        acheteur:"JIA 日本建築家協会", budget:null,
        date_pub:get("pubDate"),
        deadline: extractedDeadline,
        country:"Japan", region:"Japan", cpv:"71200000",
        procedure:"Competition", nature:"Competition",
        url:get("link")||"https://www.jia.or.jp/competition/",
      };
    });
    console.log(`  ✅ JIA: ${items.length}件`);
    allResults.push(...items);
  }

  // 国土交通省（複数URLを試行）
  const mlitUrls = [
    "https://www.mlit.go.jp/rss/report/press/kanbo.xml",
    "https://www.mlit.go.jp/rss/report/press/all.xml",
    "https://www.mlit.go.jp/common/rss/press.xml",
  ];
  const kw = ["設計競技","コンペ","プロポーザル","設計者選定","建築設計","公共施設","文化施設","学校","庁舎","駅","空港"];
  for (const mlitUrl of mlitUrls) {
    const mlitRes = await safeFetch(mlitUrl,{},"MLIT");
    if (!mlitRes) continue;
    const xml = await mlitRes.text();
    const items = parseRSS(xml,"MLIT",(get)=>{
      const title = get("title"); const desc = cleanText(get("description"),400);
      if (!kw.some(k=>title.includes(k)||desc.includes(k))) return null;
      const extractedDeadline = extractDeadlineFromText(desc);
      return { _id:`mlit-${Math.random()}`, title, description:desc, acheteur:"国土交通省", budget:null, date_pub:get("pubDate"), deadline:extractedDeadline, country:"Japan", region:"Japan", cpv:"71200000", procedure:"Competition", nature:"Competition", url:get("link")||"https://www.mlit.go.jp" };
    }).filter(Boolean);
    console.log(`  ✅ MLIT: ${items.length}件`);
    allResults.push(...items);
    break;
  }

  return allResults;
}

// ─── 中東（RCU AlUla・NEOM・Gulf TED POST） ───────────────────────────────────

async function fetchMIQCP() {
  console.log("📡 MIQCP (France — Concours architecture)...");
  const urls = [
    "https://www.miqcp.gouv.fr/index.php?option=com_content&view=category&id=17&format=feed&type=rss",
    "https://www.miqcp.gouv.fr/index.php/concours/appels-a-candidatures?format=feed&type=rss",
    "https://www.miqcp.gouv.fr/feed/",
  ];
  const allItems = [];
  for (const url of urls) {
    const res = await safeFetch(url, {}, "MIQCP");
    if (!res) continue;
    const xml = await res.text();
    const items = parseRSS(xml, "MIQCP", (get) => {
      const title = get("title");
      if (!title || title.length < 3) return null;
      return {
        _id: `miqcp-${Math.random()}`,
        _source: "MIQCP",
        title: cleanText(title),
        description: cleanText(get("description").replace(/<[^>]*>/g, "").slice(0, 400)),
        acheteur: get("dc:creator") || "MIQCP",
        budget: null,
        date_pub: get("pubDate"),
        deadline: null,
        country: "France",
        region: "France",
        cpv: "71221000",
        procedure: "Competition",
        nature: "Competition",
        url: get("link") || "https://www.miqcp.gouv.fr",
      };
    });
    if (items.length > 0) {
      allItems.push(...items);
      console.log(`  ✅ MIQCP: ${items.length}件`);
      break;
    }
  }
  if (!allItems.length) {
    console.log("  ⚠️ MIQCP: 0件（RSSが取得できませんでした）");
  }
  return allItems;
}

async function fetchMiddleEast() {
  console.log("📡 Middle East...");
  const allResults = [];

  // RCU AlUla → ドメイン消滅のためスキップ（2026年6月確認）
  // 代替: Saudi Vision 2030プロジェクトはTED Gulf経由でカバー

  // NEOM（複数URLを試行）
  const neomRes = await safeFetch("https://www.neom.com/en-us/media/news/feed",{},"NEOM") ||
                  await safeFetch("https://www.neom.com/en-us/rss.xml",{},"NEOM") ||
                  await safeFetch("https://www.neom.com/feed",{},"NEOM");
  if (neomRes) {
    const xml = await neomRes.text();
    const kw = ["architecture","design","competition","tender","construction","cultural","architect","hotel","hospitality"];
    const items = parseRSS(xml,"NEOM",(get)=>{
      const title=get("title"); const desc=cleanText(get("description"),400);
      if (!kw.some(k=>title.toLowerCase().includes(k)||desc.toLowerCase().includes(k))) return null;
      return { _id:`neom-${Math.random()}`, title, description:desc, acheteur:"NEOM", budget:null, date_pub:get("pubDate"), deadline:null, country:"Saudi Arabia", region:"NEOM", cpv:"71200000", procedure:"", nature:"", url:get("link")||"https://www.neom.com" };
    }).filter(Boolean);
    console.log(`  ✅ NEOM: ${items.length}件`);
    allResults.push(...items);
  }

  // Gulf TED（RSSフィード経由）
  const gulfCpvs = ["71200000","71220000","45210000"];
  const gulfCountries = ["SA","AE","QA","BH","KW","OM"];
  for (const cpv of gulfCpvs) {
    for (const cc of gulfCountries) {
      const items = await fetchTEDFeed(cpv, cc === "SA" ? "Saudi Arabia" : cc === "AE" ? "UAE" : cc === "QA" ? "Qatar" : cc);
      // フィルタリングはURL内のcountryパラメーターで行う
      const gulfItems = items.filter(n => n.title && n.title.length > 3);
      if (gulfItems.length > 0) {
        console.log(`  ✅ Gulf TED (${cpv}/${cc}): ${gulfItems.length}件`);
        allResults.push(...gulfItems);
      }
    }
  }

  return allResults;
}

// ─── Museum Insider ────────────────────────────────────────────────────────────

async function fetchMuseumInsider() {
  if (!process.env.MUSEUM_INSIDER_ENABLED) return [];
  console.log("📡 Museum Insider...");
  return [];
}

// ─── AIサマリー ────────────────────────────────────────────────────────────────


// ─── 案件詳細の自動解析 ───────────────────────────────────────────────────────
// 各コンペの詳細ページを取得し、Claudeで構造化データを抽出する

async function callClaude(prompt, maxTokens=800) {
  if (!CONFIG.anthropicKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":CONFIG.anthropicKey,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]}),
      timeout:20000,
    });
    if (!res.ok) return null;
    const rawText = await res.text();
    const data = JSON.parse(rawText);
    return data.content.map(c=>c.text||"").join("").trim();
  } catch(e) { return null; }
}

async function enrichNoticeDetails(notice) {
  // 既に解析済みならスキップ
  if (notice._enriched) return notice;

  // 詳細ページを取得
  let detailHtml = "";
  try {
    const res = await safeFetch(notice.url, {
      headers:{"User-Agent":"Mozilla/5.0 (compatible; MKMonitor/1.0)","Accept":"text/html,application/xhtml+xml"},
    }, `enrich:${notice._source}`);
    if (res) {
      detailHtml = await res.text();
      // HTMLタグを除去してテキストのみ（最大3000文字）
      detailHtml = detailHtml
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,"")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"")
        .replace(/<[^>]+>/g," ")
        .replace(/\s+/g," ")
        .slice(0,3000);
    }
  } catch(e) {}

  if (!detailHtml || detailHtml.length < 100) return notice;

  const prompt = `Tu es un expert en marchés publics d'architecture. Analyse ce texte d'un avis de concours et extrais les informations structurées.

Source: ${notice._source}
Titre: ${notice.title}
Texte: ${detailHtml}

Réponds UNIQUEMENT avec un JSON valide (pas de markdown, pas d'explication):
{
  "specialites_requises": ["liste des spécialités/compétences requises dans l'équipe, ex: Architecte du patrimoine, OPC, Acousticien, Paysagiste, BET Structure..."],
  "prime": null_ou_nombre_en_euros,
  "surface": null_ou_nombre_en_m2,
  "mission": "Base|Complète|Partielle|null",
  "type_concours": "International|Restreint|Ouvert|null",
  "nb_candidats_max": null_ou_nombre,
  "criteres_selection": "résumé des critères de sélection en 1 phrase",
  "planning_cle": "dates importantes en 1 phrase",
  "note_mk": "pertinence pour Moreau Kusunoki en 1 phrase (musée, culture, international, réhabilitation de patrimoine)"
}`;

  const result = await callClaude(prompt, 800);
  if (!result) return notice;

  try {
    const extracted = JSON.parse(result.replace(/```json|```/g,"").trim());
    return {
      ...notice,
      _enriched: true,
      specialites_requises: extracted.specialites_requises || [],
      prime: extracted.prime || notice.prime || null,
      surface: extracted.surface || notice.surface || null,
      mission: extracted.mission || null,
      type_concours: extracted.type_concours || null,
      nb_candidats_max: extracted.nb_candidats_max || null,
      criteres_selection: extracted.criteres_selection || null,
      planning_cle: extracted.planning_cle || null,
      note_mk: extracted.note_mk || null,
    };
  } catch(e) { return notice; }
}

async function generateSummary(notice) {
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

  const prompt = `Analyse this procurement notice for Moreau Kusunoki Architects (Paris) and return a summary in THREE languages simultaneously. Return ONLY valid JSON, no markdown, no explanation.

Notice:
${noticeText}

Return this exact structure (translate values to each language, use "不明"/"N/A"/"N/A" if unknown):
{
  "ja": {
    "総工費": "",
    "建築面積": "",
    "建築タイプ": "新築／増築／改修／不明",
    "コンペの有無": "あり／なし／不明",
    "Exclusivity": "あり（パートナーの早期確保が必要）／なし／不明",
    "審査基準": "",
    "審査員": "",
    "提出物": "",
    "スケジュール": "",
    "敷地の特徴": "",
    "設計チーム構成": "",
    "参加報酬": "",
    "設計報酬上限": "",
    "MKコメント": "MK事務所への適合性について一言"
  },
  "fr": {
    "Coût total": "",
    "Surface": "",
    "Type de projet": "Neuf/Extension/Réhabilitation/N/A",
    "Concours": "Oui/Non/N/A",
    "Exclusivity": "Oui (sécuriser les partenaires rapidement)/Non/N/A",
    "Critères de sélection": "",
    "Jury": "",
    "Pièces à fournir": "",
    "Calendrier": "",
    "Caractéristiques du site": "",
    "Équipe requise": "",
    "Indemnité de concours": "",
    "Plafond honoraires": "",
    "Commentaire": "Une phrase sur la pertinence pour MK"
  },
  "en": {
    "Total cost": "",
    "Area": "",
    "Project type": "New build/Extension/Renovation/N/A",
    "Competition": "Yes/No/N/A",
    "Exclusivity": "Yes (secure partners quickly)/No/N/A",
    "Selection criteria": "",
    "Jury": "",
    "Deliverables": "",
    "Schedule": "",
    "Site characteristics": "",
    "Team required": "",
    "Competition fee": "",
    "Fee cap": "",
    "Comment": "One sentence on relevance for MK"
  }
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":CONFIG.anthropicKey,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1500,messages:[{role:"user",content:prompt}]}),
    });
    if (!res.ok) return null;
    const rawText = await res.text();
    const data = JSON.parse(rawText);
    const text = data.content.map(c=>c.text||"").join("").trim();
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e) { return null; }
}

// ─── メールHTML ────────────────────────────────────────────────────────────────

const LABELS = {
  ja:        { title:"MK Monitor", total:"新着案件", feeAlert:"⚠️ 設計報酬上限", footer:"BOAMP · TED · SIMAP · Doffin · Bustler · ArchDaily · RIBA · JIA · RCU AlUla · NEOM　|　MK条件①〜⑧　|　毎朝7時（パリ時間）" },
  fr:        { title:"MK Monitor", total:"Nouvelles", feeAlert:"⚠️ Plafond",     footer:"BOAMP · TED · SIMAP · Doffin · Bustler · ArchDaily · RIBA · JIA · RCU AlUla · NEOM  |  7h00 Paris" },
  bilingual: { title:"MK Monitor", total:"New notices", feeAlert:"⚠️ Fee cap",   footer:"BOAMP · TED · SIMAP · Doffin · Bustler · ArchDaily · RIBA · JIA · RCU AlUla · NEOM  |  Daily 7:00 AM Paris" },
};

const SOURCE_COLORS = {
  "BOAMP":{bg:"#dbeafe",fg:"#1d4ed8"},"TED/OJEU":{bg:"#d1fae5",fg:"#065f46"},
  "SIMAP":{bg:"#fef3c7",fg:"#92400e"},"Doffin":{bg:"#ede9fe",fg:"#5b21b6"},
  "Bustler":{bg:"#fce7f3",fg:"#9d174d"},"ArchDaily":{bg:"#fdf4ff",fg:"#6b21a8"},
  "RIBA":{bg:"#f0fdf4",fg:"#166534"},"JIA":{bg:"#fef9c3",fg:"#854d0e"},
  "MLIT":{bg:"#fff1f2",fg:"#9f1239"},"RCU AlUla":{bg:"#f0f9ff",fg:"#0369a1"},
  "NEOM":{bg:"#f0fdfa",fg:"#0f766e"},"Gulf Procurement":{bg:"#fdf2f8",fg:"#86198f"},
  "Museum Insider":{bg:"#fef2f2",fg:"#991b1b"},
};

function buildNoticeHtml(notice, lang) {
  const L = LABELS[lang];
  const geo = detectGeo(notice);
  const geoInfo = GEO[geo]||GEO[7];
  const geoLabel = geoInfo[lang==="bilingual"?"en":lang]||geoInfo.en;
  const budget = formatBudget(notice.budget);
  const bType = detectBuildingType(notice);
  const bTypeCfg = bType ? BUILDING_TYPES[bType] : null;
  const isComp = notice.procedure==="Competition"||notice.nature==="Competition";
  const isExcl = hasExclusivity(notice);
  const pubDateStr = notice.date_pub
    ? new Date(notice.date_pub).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})
    : null;
  const deadlineStr = notice.deadline
    ? new Date(notice.deadline).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})
    : null;
  const srcColor = SOURCE_COLORS[notice._source]||{bg:"#f1f5f9",fg:"#475569"};

  let summaryHtml = "";
  if (notice._summary) {
    // トリリンガルサマリーから正しい言語を選択
    const langKey = lang === "ja" ? "ja" : lang === "fr" ? "fr" : "en";
    const s = notice._summary[langKey] || notice._summary.en || notice._summary;

    const fields = lang==="ja"
      ? ["総工費","建築面積","建築タイプ","コンペの有無","Exclusivity","審査基準","審査員","提出物","スケジュール","敷地の特徴","設計チーム構成","参加報酬"]
      : lang==="fr"
      ? ["Coût total","Surface","Type de projet","Concours","Exclusivity","Critères de sélection","Jury","Pièces à fournir","Calendrier","Caractéristiques du site","Équipe requise","Indemnité de concours"]
      : ["Total cost","Area","Project type","Competition","Exclusivity","Selection criteria","Jury","Deliverables","Schedule","Site characteristics","Team required","Competition fee"];

    const rows = fields.filter(k=>s[k]&&s[k]!=="不明"&&s[k]!=="N/A"&&s[k]!=="")
      .map(k=>`<tr><td style="padding:3px 10px 3px 0;font-size:11px;color:#6b7280;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;font-size:11px;color:#374151;line-height:1.5">${s[k]}</td></tr>`).join("");

    const feeKey = lang==="ja"?"設計報酬上限":lang==="fr"?"Plafond honoraires":"Fee cap";
    const commentKey = lang==="ja"?"MKコメント":lang==="fr"?"Commentaire":"Comment";
    const feeVal = s[feeKey];
    const commentVal = s[commentKey];

    const feeAlert = feeVal&&feeVal!=="不明"&&feeVal!=="N/A"&&feeVal!==""
      ? `<div style="margin-top:6px;padding:7px 10px;background:#fef2f2;border-left:3px solid #dc2626;font-size:11px;color:#b91c1c">${L.feeAlert}: ${feeVal}</div>` : "";
    const comment = commentVal&&commentVal!=="不明"&&commentVal!=="N/A"&&commentVal!==""
      ? `<div style="margin-top:6px;padding:7px 10px;background:#f0f9ff;border-left:3px solid #0284c7;font-size:11px;color:#0c4a6e">💡 ${commentVal}</div>` : "";

    if (rows||feeAlert||comment) {
      const summaryTitle = lang==="ja"?"✦ AI要綱サマリー":lang==="fr"?"✦ SYNTHÈSE IA":"✦ AI SUMMARY";
      summaryHtml = `<div style="padding:12px 16px;background:#f8fafc;border-top:1px solid #e2e8f0"><div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;margin-bottom:8px">${summaryTitle}</div><table cellpadding="0" cellspacing="0">${rows}</table>${feeAlert}${comment}</div>`;
    }
  }

  return `
  <div style="border:1px solid ${isExcl?"#fca5a5":"#e2e8f0"};border-radius:4px;margin-bottom:10px;overflow:hidden">
    ${isExcl ? `<div style="background:#dc2626;padding:8px 16px;display:flex;align-items:center;gap:8px">
      <span style="font-size:13px">⚡</span>
      <span style="font-size:10px;font-weight:700;color:white;letter-spacing:0.12em;text-transform:uppercase">Exclusivity clause detected — Act fast to secure your partners</span>
    </div>` : ""}
    <div style="padding:14px 16px">
      <div style="margin-bottom:8px;display:flex;gap:5px;flex-wrap:wrap">
        <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:${srcColor.bg};color:${srcColor.fg};letter-spacing:0.1em;text-transform:uppercase">${notice._source}</span>
        <span style="font-size:9px;padding:2px 7px;border-radius:3px;background:#f1f5f9;color:#475569">${geoLabel}</span>
        ${bTypeCfg?`<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:3px;background:${bTypeCfg.bg};color:${bTypeCfg.color}">${bTypeCfg.label[lang==="bilingual"?"en":lang]||bTypeCfg.label.en}</span>`:""}
        ${isComp?`<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:3px;background:#fdf4ff;color:#6b21a8">${lang==="ja"?"コンペ":lang==="fr"?"CONCOURS":"COMPETITION"}</span>`:""}
        ${isExcl?`<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:#fee2e2;color:#dc2626;letter-spacing:0.05em">⚡ EXCLUSIVITY</span>`:""}
        ${parseBudget(notice.budget)>=5000000?`<span style="font-size:9px;padding:2px 7px;border-radius:3px;background:#ede9fe;color:#6d28d9">+5M€</span>`:""}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;padding-right:12px">
          <div style="font-size:13px;font-weight:500;color:#111827;line-height:1.4">${escapeHtml(notice.title)||"—"}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:3px">${escapeHtml(notice.acheteur)||""}</div>
          ${notice.description ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5">${escapeHtml(cleanText(notice.description, 200))}</div>` : ""}
        </td>
        <td style="vertical-align:top;text-align:right;white-space:nowrap">
          <div style="font-size:15px;font-weight:600;color:#111827;font-family:monospace">${budget}</div>
        </td>
      </tr></table>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #f3f4f6;font-size:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${notice.region?`<span style="color:#9ca3af">📍 ${escapeHtml(notice.region)}</span>`:""}
          ${pubDateStr?`<span style="color:#9ca3af">Published: ${pubDateStr}</span>`:""}
          ${deadlineStr?`<span style="font-weight:600;color:#dc2626">⏱ Deadline: ${deadlineStr}</span>`:""}
        </div>
        <div style="display:flex;gap:10px">
          <a href="${notice.url}" style="color:#2563eb;text-decoration:none">→ View dossier ↗</a>
          ${buildFollowUrl(notice) ? `<a href="${buildFollowUrl(notice)}" style="color:#059669;text-decoration:none;font-weight:600">🔔 Follow this project</a>` : ""}
        </div>
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
  const geoOrder = Object.keys(grouped).sort((a,b)=>(GEO[parseInt(a)]?.order||9)-(GEO[parseInt(b)]?.order||9));
  let sections = "";
  for (const geo of geoOrder) {
    const geoInfo = GEO[parseInt(geo)]||GEO[7];
    const geoLabel = geoInfo[lang==="bilingual"?"en":lang]||geoInfo.en;
    sections += `<div style="margin-bottom:28px"><div style="font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:14px">${geoLabel} · ${grouped[geo].length}${lang==="ja"?"件":" notices"}</div>${grouped[geo].map(n=>buildNoticeHtml(n,lang)).join("")}</div>`;
  }
  const totalCount = notices.length;
  const byType = Object.fromEntries(Object.keys(BUILDING_TYPES).map(t=>[t,notices.filter(n=>detectBuildingType(n)===t).length]));

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#D9D8D6;font-family:Arial,sans-serif">
<div style="max-width:660px;margin:0 auto;padding:24px 16px">

  <!-- HEADER -->
  <div style="background:#ffffff;border-bottom:3px solid #0016B4;padding:24px 28px">
    <div style="font-size:8px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#676867">Architectes &mdash; MK Monitor</div>
    <div style="font-size:24px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#1a1a1a;margin-top:6px;line-height:1">Moreau Kusunoki</div>
    <div style="font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#676867;margin-top:10px">${dateStr}</div>
  </div>

  <!-- STATS BAR -->
  <div style="background:#676867;padding:12px 28px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;padding-right:28px;border-right:1px solid #888;margin-right:28px">
        <div style="font-size:22px;font-weight:700;color:#ffffff;font-family:Arial,sans-serif">${totalCount}</div>
        <div style="font-size:8px;font-weight:700;color:#D9D8D6;text-transform:uppercase;letter-spacing:0.18em;margin-top:2px">${L.total}</div>
      </td>
      ${Object.entries(byType).filter(([,v])=>v>0).map(([t,v])=>`<td style="text-align:center;padding:0 28px">
        <div style="font-size:22px;font-weight:700;color:#ffffff;font-family:Arial,sans-serif">${v}</div>
        <div style="font-size:8px;font-weight:700;color:#D9D8D6;text-transform:uppercase;letter-spacing:0.18em;margin-top:2px">${BUILDING_TYPES[t].label[lang==="bilingual"?"en":lang]||BUILDING_TYPES[t].label.en}</div>
      </td>`).join("")}
    </tr></table>
  </div>

  <!-- CONTENT -->
  <div style="background:#ffffff;padding:24px 28px;border:1px solid #c4c3c1;border-top:none">
    ${sections}
    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #D9D8D6;font-size:9px;color:#676867;line-height:1.7;letter-spacing:0.05em">${L.footer}</div>
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

  const [boamp,ted,simap,doffin,bustler,archdaily,riba,japan,middleEast,museumInsider] = await Promise.all([
    fetchBOAMP(), fetchTED(), fetchSIMAP(), fetchDoffin(),
    fetchBustler(), fetchArchDaily(), fetchRIBA(),
    fetchJapan(), fetchMiddleEast(), fetchMuseumInsider(),
  ]);

  const all = [...boamp,...ted,...simap,...doffin,...bustler,...archdaily,...riba,...japan,...middleEast,...museumInsider];
  console.log(`\n✅ 合計取得: ${all.length}件`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const scored = all
    .map(n=>({...n,_score:scoreNotice(n),_geo:detectGeo(n)}))
    // タイトルのない案件を除外
    .filter(n => n.title && n.title.trim().length > 3)
    // ★ 期限切れ・古すぎる案件を除外
    .filter(n => {
      // 締め切りが過去 → 除外
      if (n.deadline) {
        const dl = new Date(n.deadline);
        if (!isNaN(dl.getTime()) && dl < today) return false;
      }
      // 公開日が180日以上前 AND 締め切り不明 → 除外（古いデータ）
      if (n.date_pub && !n.deadline) {
        const pub = new Date(n.date_pub);
        const daysSince = (today - pub) / (1000 * 60 * 60 * 24);
        if (!isNaN(pub.getTime()) && daysSince > 180) return false;
      }
      return true;
    })
    .filter(n=>{
      const b = parseBudget(n.budget);
      const geo = n._geo;
      const bType = detectBuildingType(n);
      const isComp = n.procedure==="Competition"||n.nature==="Competition";
      const hasBuildingType = bType !== null;

      // コンペは全て通す
      if (isComp) return true;
      // 5M€以上は全て
      if (b>=5000000) return true;
      // 1M€以上かつ建物タイプあり
      if (b>=1000000 && hasBuildingType) return true;
      // フランス・欧州は予算なしでも建物タイプがあれば通す（BOAMP対応）
      if ([1,2,3].includes(geo) && hasBuildingType) return true;
      // 日本・中東も建物タイプがあれば通す
      if ([4,65].includes(geo) && hasBuildingType) return true;
      // AlUla/NEOMは金額不問
      const text = [n.title,n.description].filter(Boolean).join(" ").toLowerCase();
      if (text.includes("alula")||text.includes("neom")) return true;
      // スコアが高い案件
      if (n._score>=40) return true;
      return false;
    })
    .sort((a,b)=>b._score-a._score);

  // 重複除去（同一タイトル）
  const deduped = scored.filter((n,i,arr)=>
    arr.findIndex(x=>x.title&&x.title===n.title)===i
  );

  const priorityNotices = deduped.filter(n=>n._score>=CONFIG.priorityScore);
  console.log(`📊 全案件: ${deduped.length}件 / 優先度高: ${priorityNotices.length}件`);

  // 建物タイプ別集計
  Object.keys(BUILDING_TYPES).forEach(t=>{
    const count = deduped.filter(n=>detectBuildingType(n)===t).length;
    if (count>0) console.log(`   ${BUILDING_TYPES[t].label.en}: ${count}件`);
  });

  // 案件詳細の自動解析（コンペ優先、上位15件まで）
  console.log("🔍 案件詳細解析中...");
  const toEnrich = deduped
    .filter(n => n.procedure === "Competition" || n.nature === "Competition" || n._score >= 30)
    .slice(0, 15);
  for (const n of toEnrich) {
    const enriched = await enrichNoticeDetails(n);
    Object.assign(n, enriched);
    if (enriched._enriched) process.stdout.write("✓");
  }
  const enrichedCount = toEnrich.filter(n => n._enriched).length;
  console.log(`\n✅ 詳細解析完了: ${enrichedCount}/${toEnrich.length}件`);

  // AIサマリー生成
  console.log("🤖 AIサマリー生成中...");
  for (const n of priorityNotices.slice(0,10)) {
    n._summary = await generateSummary(n);
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
    let notices;
    if (group.filterLevel==="priority")  notices = priorityNotices;
    else if (group.filterLevel==="japan") notices = deduped.filter(n=>detectGeo(n)===4);
    else                                  notices = deduped;

    if (notices.length===0) { console.log(`📭 ${groupName}: 対象案件なし、スキップ`); continue; }
    const html    = buildEmail(notices,group.lang,new Date());
    const subject = buildSubject(group.lang,notices.length,new Date());
    const toList  = group.recipients.map(r=>r.email);
    console.log(`📧 送信中 → [${groupName}] ${toList.join(", ")} (${notices.length}件)`);
    if (!resend) { console.log(`📭 ${groupName}: メール送信スキップ（APIキー未設定）`); continue; }
    const {error} = await resend.emails.send({from:CONFIG.senderEmail,to:toList,subject,html});
    if (error) console.error(`❌ ${groupName}:`,error);
    else       console.log(`✅ ${groupName} 送信完了`);
  }

  // 最新の公募データをVolumeに保存（ダッシュボード表示用）
  // ★ all（フィルタリング前）を保存してダッシュボードで全件表示
  const todayTs = new Date(); todayTs.setHours(0,0,0,0);
  const allForSave = all.filter(n => {
    if (!n.title || n.title.trim().length < 3) return false;
    // 締め切り過去 → 除外
    if (n.deadline) {
      const dl = new Date(n.deadline);
      if (!isNaN(dl.getTime()) && dl < todayTs) return false;
    }
    // 180日以上前の公開 + 締め切り不明 → 除外
    if (n.date_pub && !n.deadline) {
      const pub = new Date(n.date_pub);
      const days = (todayTs - pub) / (1000*60*60*24);
      if (!isNaN(pub.getTime()) && days > 180) return false;
    }
    return true;
  });
  const NOTICES_FILE = path.join(DATA_DIR, "last_notices.json");
  try {
    const saveData = {
      runAt: new Date().toISOString(),
      count: allForSave.length,
      notices: allForSave.map(n => ({
        id: n._id || Math.random().toString(36).slice(2),
        title: n.title,
        source: n._source,
        acheteur: n.acheteur,
        budget: formatBudget(n.budget),
        budgetRaw: n.budget,
        country: n.country || n.region || "",
        region: n.region || "",
        procedure: n.procedure,
        nature: n.nature,
        date_pub: n.date_pub,
        deadline: n.deadline,
        url: n.url,
        score: n._score,
        geo: n._geo,
        buildingType: detectBuildingType(n),
        summary: n._summary || null,
        // 詳細解析データ
        enriched: n._enriched || false,
        specialites_requises: n.specialites_requises || [],
        prime: n.prime || null,
        surface: n.surface || null,
        mission: n.mission || null,
        type_concours: n.type_concours || null,
        nb_candidats_max: n.nb_candidats_max || null,
        criteres_selection: n.criteres_selection || null,
        planning_cle: n.planning_cle || null,
        note_mk: n.note_mk || null,
      }))
    };
    fs.writeFileSync(NOTICES_FILE, JSON.stringify(saveData, null, 2));
    console.log(`💾 ${allForSave.length}件の公募データを保存（フィルタリング前全件）`);
  } catch(e) { console.error("公募保存エラー:", e.message); }
}

// ─── フォローリンク生成 ────────────────────────────────────────────────────────

function buildFollowUrl(notice) {
  const SERVICE_URL = process.env.SERVICE_URL || "https://mk-monitor-production.up.railway.app";
  if (!SERVICE_URL) return null;
  const data = {
    title:   notice.title || "",
    source:  notice._source || "",
    url:     notice.url || "",
    acheteur:notice.acheteur || "",
    budget:  formatBudget(notice.budget),
    country: notice.country || notice.region || "",
    geo:     notice._geo || 7,
  };
  const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${SERVICE_URL}/follow?d=${encoded}`;
}

// ─── フォロー済みプロジェクト（メモリ内ストレージ） ────────────────────────────

const fs   = require("fs");
const path = require("path");

// /data はRailway Volume（永続ディスク）
// ローカル環境では ./data にフォールバック
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PROJECTS_FILE = path.join(DATA_DIR, "followed_projects.json");

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8")); }
  catch(e) { return []; }
}

function saveProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf-8");
}

const followedProjects = loadProjects();
console.log("✅ Followed projects: " + followedProjects.length + "件 読み込み済み");

async function sendFollowNotification(noticeData, assignedTo, assignedEmail) {
  // フォロー済みリストに追加
  followedProjects.push({
    id:         Date.now(),
    followedAt: new Date().toISOString(),
    assignedTo,
    assignedEmail,
    ...noticeData,
  });
  saveProjects(followedProjects);

  const teamMembers = RECIPIENTS.filter(r => r.email);
  const toList = teamMembers.map(r => r.email).filter(Boolean);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px 16px">
  <div style="background:#0f172a;border-radius:6px 6px 0 0;padding:20px 28px">
    <div style="font-size:9px;color:#475569;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:5px">Moreau Kusunoki Architectes</div>
    <h1 style="margin:0;font-size:18px;font-weight:300;color:#f1f5f9;letter-spacing:0.1em;text-transform:uppercase">
      🔔 Project added to follow-up
    </h1>
  </div>
  <div style="background:white;border-radius:0 0 6px 6px;padding:24px 28px;border:1px solid #e2e8f0;border-top:none">
    <div style="padding:14px 16px;background:#f0f9ff;border-left:4px solid #0284c7;margin-bottom:20px;border-radius:3px">
      <div style="font-size:10px;color:#0369a1;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">ASSIGNED TO</div>
      <div style="font-size:18px;font-weight:600;color:#0c4a6e">${assignedTo}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:8px 12px 8px 0;color:#6b7280;white-space:nowrap">Project</td><td style="padding:8px 0;color:#111827;font-weight:500">${noticeData.title}</td></tr>
      <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:8px 12px 8px 0;color:#6b7280;white-space:nowrap">Source</td><td style="padding:8px 0;color:#111827">${noticeData.source}</td></tr>
      <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:8px 12px 8px 0;color:#6b7280;white-space:nowrap">Client</td><td style="padding:8px 0;color:#111827">${noticeData.acheteur||"—"}</td></tr>
      <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:8px 12px 8px 0;color:#6b7280;white-space:nowrap">Budget</td><td style="padding:8px 0;color:#111827">${noticeData.budget}</td></tr>
      <tr><td style="padding:8px 12px 8px 0;color:#6b7280;white-space:nowrap">Country</td><td style="padding:8px 0;color:#111827">${noticeData.country||"—"}</td></tr>
    </table>
    <div style="margin-top:20px;display:flex;gap:10px">
      <a href="${noticeData.url}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:white;text-decoration:none;font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;border-radius:3px">→ View dossier ↗</a>
      ${process.env.SERVICE_URL ? `<a href="${process.env.SERVICE_URL}/dashboard" style="display:inline-block;padding:10px 20px;background:#f1f5f9;color:#0f172a;text-decoration:none;font-size:11px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;border-radius:3px">→ View all followed projects</a>` : ""}
    </div>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f1f5f9;font-size:10px;color:#94a3b8">
      Moreau Kusunoki Architectes — MK Monitor · Project follow-up
    </div>
  </div>
</div>
</body></html>`;

  const { error } = await resend.emails.send({
    from:    CONFIG.senderEmail,
    to:      toList,
    subject: `[MK Monitor] New follow-up: ${noticeData.title.slice(0,60)}${noticeData.title.length>60?"…":""}`,
    html,
  });

  if (error) console.error("Follow notification error:", error);
  else       console.log(`✅ Follow notification sent → ${toList.join(", ")}`);
}

// ─── Webサーバー（フォローページ） ────────────────────────────────────────────

const TEAM_MEMBERS = [
  { name:"HK (Hiroko Kusunoki)",      email: () => process.env.EMAIL_HK },
  { name:"Nicolas Moreau",            email: () => process.env.EMAIL_NICOLAS },
  { name:"Shohei Yamashita",          email: () => process.env.EMAIL_SHOHEI },
  { name:"Luana Zaccaron",            email: () => process.env.EMAIL_LUANA },
  { name:"Joana Lazarova",            email: () => process.env.EMAIL_JOANA },
  { name:"Antoine Guillaume",         email: () => process.env.EMAIL_ANTOINE },
];

app.get("/follow", (req, res) => {
  let noticeData = {};
  try {
    noticeData = JSON.parse(Buffer.from(req.query.d || "", "base64url").toString());
  } catch(e) {
    return res.status(400).send("Lien invalide.");
  }

  const memberOptions = TEAM_MEMBERS.map(m =>
    `<option value="${m.name}">${m.name}</option>`
  ).join("");

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MK Monitor — Suivi de projet</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; background:#f0efed; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { background:white; border-radius:6px; overflow:hidden; width:100%; max-width:520px; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
  .header { background:#0f172a; padding:20px 24px; }
  .header-sub { font-size:9px; color:#475569; letter-spacing:0.2em; text-transform:uppercase; margin-bottom:6px; }
  .header-title { font-size:16px; font-weight:300; color:#f1f5f9; letter-spacing:0.12em; text-transform:uppercase; }
  .body { padding:24px; }
  .notice-title { font-size:15px; font-weight:500; color:#111827; line-height:1.4; margin-bottom:12px; }
  .meta { display:grid; gap:6px; margin-bottom:24px; }
  .meta-row { display:flex; gap:12px; font-size:12px; }
  .meta-label { color:#9ca3af; min-width:100px; flex-shrink:0; }
  .meta-value { color:#374151; }
  .divider { border:none; border-top:1px solid #f1f5f9; margin:20px 0; }
  .section-label { font-size:9px; font-weight:700; letter-spacing:0.15em; text-transform:uppercase; color:#64748b; margin-bottom:10px; }
  select { width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:4px; font-size:13px; color:#111827; background:white; appearance:none; cursor:pointer; font-family:inherit; }
  select:focus { outline:none; border-color:#0f172a; }
  button { width:100%; margin-top:12px; padding:12px; background:#0f172a; color:white; border:none; border-radius:4px; font-size:11px; font-weight:500; letter-spacing:0.12em; text-transform:uppercase; cursor:pointer; font-family:inherit; transition:background 0.15s; }
  button:hover { background:#1e293b; }
  button:disabled { background:#9ca3af; cursor:not-allowed; }
  .success { display:none; text-align:center; padding:24px; }
  .success-icon { font-size:40px; margin-bottom:12px; }
  .success-text { font-size:14px; color:#374151; }
  .link { font-size:11px; color:#6b7280; margin-top:16px; }
  .link a { color:#2563eb; text-decoration:none; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="header-sub">Moreau Kusunoki Architectes — MK Monitor</div>
    <div class="header-title">🔔 Follow this project</div>
  </div>
  <div class="body">
    <div id="form-section">
      <div class="notice-title">${noticeData.title||"—"}</div>
      <div class="meta">
        ${noticeData.source ? `<div class="meta-row"><span class="meta-label">Source</span><span class="meta-value">${noticeData.source}</span></div>` : ""}
        ${noticeData.acheteur ? `<div class="meta-row"><span class="meta-label">Maître d'ouvrage</span><span class="meta-value">${noticeData.acheteur}</span></div>` : ""}
        ${noticeData.budget && noticeData.budget !== "—" ? `<div class="meta-row"><span class="meta-label">Budget</span><span class="meta-value">${noticeData.budget}</span></div>` : ""}
        ${noticeData.country ? `<div class="meta-row"><span class="meta-label">Pays</span><span class="meta-value">${noticeData.country}</span></div>` : ""}
      </div>
      <hr class="divider">
      <div class="section-label">Assign a responsible person</div>
      <form id="follow-form">
        <select name="assigned_to" id="assigned_to" required>
          <option value="">— Select a responsible person —</option>
          ${memberOptions}
        </select>
        <button type="submit" id="submit-btn">Assign &amp; notify team →</button>
      </form>
      ${noticeData.url ? `<div class="link">→ <a href="${noticeData.url}" target="_blank">Accéder au dossier complet ↗</a></div>` : ""}
    </div>
    <div class="success" id="success-section">
      <div class="success-icon">✅</div>
      <div class="success-text">Project added to follow-up.<br>The assigned person and the team have been notified.</div>
    </div>
  </div>
</div>
<script>
document.getElementById("follow-form").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = document.getElementById("submit-btn");
  const assignedTo = document.getElementById("assigned_to").value;
  if (!assignedTo) return;
  btn.disabled = true;
  btn.textContent = "Envoi en cours…";
  try {
    const res = await fetch("/follow/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ d: "${req.query.d || ""}", assigned_to: assignedTo })
    });
    if (res.ok) {
      document.getElementById("form-section").style.display = "none";
      document.getElementById("success-section").style.display = "block";
    } else {
      btn.disabled = false;
      btn.textContent = "Confirmer le suivi →";
      alert("Erreur lors de l'envoi. Veuillez réessayer.");
    }
  } catch(err) {
    btn.disabled = false;
    btn.textContent = "Confirmer le suivi →";
    alert("Erreur réseau. Veuillez réessayer.");
  }
});
</script>
</body>
</html>`);
});

app.post("/follow/confirm", async (req, res) => {
  try {
    const { d, assigned_to } = req.body;
    const noticeData = JSON.parse(Buffer.from(d || "", "base64url").toString());
    const member = TEAM_MEMBERS.find(m => m.name === assigned_to);
    const assignedEmail = member ? member.email() : null;
    await sendFollowNotification(noticeData, assigned_to, assignedEmail);
    res.json({ ok: true });
  } catch(e) {
    console.error("Follow confirm error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/dashboard", (req, res) => {
  // MK共通CSS
  const MK_CSS = `<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;background:#D9D8D6;min-height:100vh}
  .mk-header{background:#fff;border-bottom:1px solid #c4c3c1;padding:28px 48px 0}
  .mk-wordmark{font-size:26px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#1a1a1a;line-height:1}
  .mk-sub{font-size:8px;font-weight:400;letter-spacing:0.28em;text-transform:uppercase;color:#676867;margin-top:6px}
  .mk-nav{display:flex;margin-top:22px}
  .mk-nav a{font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#676867;text-decoration:none;padding:9px 32px 9px 0;border-bottom:2px solid transparent}
  .mk-nav a:hover{color:#1a1a1a}
  .mk-nav a.active{color:#0016B4;border-bottom-color:#0016B4}
  .mk-tabs{background:#fff;border-bottom:1px solid #c4c3c1;padding:0 48px}
  .mk-tabs-inner{max-width:1100px;margin:0 auto;display:flex}
  .mk-tab{font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#676867;padding:13px 24px 12px 0;margin-right:8px;border-bottom:2px solid transparent;cursor:pointer}
  .mk-tab:hover{color:#1a1a1a}
  .mk-tab.active{color:#0016B4;border-bottom-color:#0016B4}
  .mk-band{background:#676867;padding:9px 48px}
  .mk-band-inner{max-width:1100px;margin:0 auto;font-size:8px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#D9D8D6;display:flex;justify-content:space-between}
  .mk-body{max-width:1100px;margin:0 auto;padding:28px 48px}
  .mk-label{font-size:8px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#676867;border-bottom:1px solid #b8b7b5;padding-bottom:8px;margin-bottom:20px}
  .mk-card{background:#fff;border:1px solid #c4c3c1;margin-bottom:6px;padding:18px 22px}
  .mk-tag{font-size:8px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:2px 7px;background:#1a1a1a;color:#fff;display:inline-block;margin-right:4px}
  .mk-tag-geo{background:#D9D8D6;color:#676867}
  .mk-tag-blue{background:#0016B4;color:#fff}
  .mk-tag-red{background:#cc0000;color:#fff}
  .mk-card-title{font-size:14px;font-weight:700;color:#1a1a1a;line-height:1.35;margin-bottom:3px}
  .mk-card-client{font-size:10px;color:#676867}
  .mk-card-footer{margin-top:12px;padding-top:10px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
  .mk-assigned{font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#676867}
  .mk-assigned strong{color:#0016B4}
  .mk-links{display:flex;gap:14px;align-items:center}
  .mk-links a{font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;color:#676867}
  .mk-links a:hover,.mk-links a.primary{color:#0016B4}
  .mk-btn-remind{font-size:8px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:5px 12px;border:1px solid #676867;background:#fff;color:#676867;cursor:pointer;font-family:Arial,sans-serif}
  .mk-btn-remind:hover{background:#676867;color:#fff}
  .mk-btn-remind.sent{background:#D9D8D6;color:#676867;border-color:#D9D8D6;cursor:default}
  .mk-filters{background:#fff;border:1px solid #c4c3c1;padding:14px 18px;margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .mk-fg{display:flex;flex-direction:column;gap:4px}
  .mk-fg label{font-size:8px;font-weight:700;color:#676867;letter-spacing:0.15em;text-transform:uppercase}
  .mk-input,.mk-select{font-size:12px;padding:6px 9px;border:1px solid #c4c3c1;background:#fff;color:#1a1a1a;font-family:Arial,sans-serif;outline:none}
  .mk-input:focus,.mk-select:focus{border-color:#0016B4}
  .mk-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #c4c3c1;font-size:12px}
  .mk-table th{background:#f5f4f2;font-size:8px;font-weight:700;color:#676867;letter-spacing:0.15em;text-transform:uppercase;padding:9px 12px;text-align:left;border-bottom:1px solid #c4c3c1}
  .mk-table td{padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top}
  .mk-table tr:last-child td{border-bottom:none}
  .mk-table tr:hover td{background:#fafaf9}
  .mk-empty{text-align:center;padding:60px 0;color:#676867;font-size:9px;letter-spacing:0.2em;text-transform:uppercase}
  .tab-panel{display:none}.tab-panel.active{display:block}
</style>`;

  // フォロー済みプロジェクトカード
  const followedRows = followedProjects.length === 0
    ? `<div class="mk-empty">Aucun projet en suivi</div>`
    : followedProjects.slice().reverse().map(p => {
        const date = new Date(p.followedAt).toLocaleDateString("fr-FR",{day:"numeric",month:"short",year:"numeric"});
        return `
        <div class="mk-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
                <span class="mk-tag">${escapeHtml(p.source)}</span>
                ${p.country ? `<span class="mk-tag mk-tag-geo">${escapeHtml(p.country)}</span>` : ""}
              </div>
              <div class="mk-card-title">${escapeHtml(p.title)}</div>
              <div class="mk-card-client">${escapeHtml(p.acheteur||"")}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:14px;font-weight:700;color:#1a1a1a">${escapeHtml(p.budget)}</div>
              <div style="font-size:9px;color:#676867;margin-top:2px">Ajouté le ${date}</div>
            </div>
          </div>
          <div class="mk-card-footer">
            <div class="mk-assigned">
              Responsable : <strong>${escapeHtml(p.assignedTo)}</strong>
            </div>
            <div class="mk-links">
              <button class="mk-btn-remind" onclick="sendRemind('${p.id}', this)">Rapport requis →</button>
              <a href="/team-builder?noticeId=${encodeURIComponent(p.id||p.title)}&noticeTitle=${encodeURIComponent(p.title)}&noticeUrl=${encodeURIComponent(p.url)}" class="primary">Constituer l'équipe</a>
              <a href="${escapeHtml(p.url)}" target="_blank">Voir le dossier</a>
            </div>
          </div>
        </div>`;
      }).join("");

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moreau Kusunoki — Monitor</title>
${MK_CSS}
</head>
<body>

<div class="mk-header">
  <div style="max-width:1100px;margin:0 auto">
    <div class="mk-wordmark">Moreau Kusunoki</div>
    <div class="mk-sub">Architectes &mdash; MK Monitor</div>
    <nav class="mk-nav">
      <a href="/dashboard" class="active">Dashboard</a>
      <a href="/partners">Partner DB</a>
    </nav>
  </div>
</div>

<div class="mk-tabs">
  <div class="mk-tabs-inner">
    <div class="mk-tab active" onclick="switchTab('suivis', this)">Projets suivis (${followedProjects.length})</div>
    <div class="mk-tab" onclick="switchTab('opportunites', this)">Toutes les opportunités</div>
  </div>
</div>

<!-- TAB 1: Projets suivis -->
<div class="tab-panel active" id="tab-suivis">
  <div class="mk-band">
    <div class="mk-band-inner">
      <span>${followedProjects.length} projet${followedProjects.length!==1?"s":""} en suivi</span>
    </div>
  </div>
  <div class="mk-body">
    <div class="mk-label">Projets suivis</div>
    ${followedRows}
  </div>
</div>

<!-- TAB 2: Toutes les opportunités -->
<div class="tab-panel" id="tab-opportunites">
  <div class="mk-band">
    <div class="mk-band-inner">
      <span id="opp-count">Chargement…</span>
      <span id="opp-run"></span>
    </div>
  </div>
  <div class="mk-body">
    <div class="mk-label">Toutes les opportunités</div>

    <div class="mk-filters">
      <div class="mk-fg" style="flex:2;min-width:180px">
        <label>Recherche</label>
        <input id="f-q" class="mk-input" type="text" placeholder="Titre, maître d'ouvrage…" oninput="filterNotices()">
      </div>
      <div class="mk-fg">
        <label>Pays</label>
        <select id="f-country" class="mk-select" onchange="filterNotices()">
          <option value="">Tous</option>
        </select>
      </div>
      <div class="mk-fg">
        <label>Type</label>
        <select id="f-type" class="mk-select" onchange="filterNotices()">
          <option value="">Tous</option>
          <option value="Competition">Concours</option>
          <option value="museum">Musée / Culture</option>
          <option value="education">Éducation</option>
          <option value="residential">Logement</option>
          <option value="hospitality">Hôtellerie</option>
          <option value="office">Bureaux</option>
          <option value="infrastructure">Infrastructure</option>
        </select>
      </div>
      <div class="mk-fg">
        <label>Budget min.</label>
        <select id="f-budget" class="mk-select" onchange="filterNotices()">
          <option value="">Tous</option>
          <option value="1000000">1M€ +</option>
          <option value="5000000">5M€ +</option>
          <option value="10000000">10M€ +</option>
          <option value="50000000">50M€ +</option>
        </select>
      </div>
      <div class="mk-fg">
        <label>Échéance</label>
        <select id="f-deadline" class="mk-select" onchange="filterNotices()">
          <option value="">Toutes</option>
          <option value="7">Dans 7 jours</option>
          <option value="30">Dans 30 jours</option>
          <option value="60">Dans 60 jours</option>
          <option value="90">Dans 90 jours</option>
        </select>
      </div>
      <div class="mk-fg">
        <label>Source</label>
        <select id="f-source" class="mk-select" onchange="filterNotices()">
          <option value="">Toutes</option>
        </select>
      </div>
      <button class="mk-input" style="align-self:flex-end;background:#D9D8D6;cursor:pointer;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;white-space:nowrap" onclick="resetFilters()">Réinitialiser</button>
    </div>

    <div style="font-size:9px;color:#676867;letter-spacing:0.1em;margin-bottom:12px" id="opp-filter-count"></div>

    <div style="overflow-x:auto">
    <table class="mk-table">
      <thead>
        <tr>
          <th style="width:70px">Source</th>
          <th>Titre &amp; Informations</th>
          <th>Maître d'ouvrage</th>
          <th>Dates</th>
          <th>Budget</th>
          <th style="width:55px"></th>
        </tr>
      </thead>
      <tbody id="opp-tbody">
        <tr><td colspan="7" class="mk-empty">Chargement…</td></tr>
      </tbody>
    </table>
    </div>
  </div>
</div>

<script>
// ── Tab switching ──
function switchTab(name, el) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".mk-tab").forEach(t => t.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  el.classList.add("active");
  if (name === "opportunites" && !window._noticesLoaded) loadNotices();
}

// ── Rappel email ──
async function sendRemind(projectId, btn) {
  if (btn.classList.contains("sent")) return;
  btn.textContent = "Envoi…";
  btn.disabled = true;
  try {
    const res = await fetch("/api/remind/" + projectId, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = "Envoyé";
      btn.classList.add("sent");
    } else {
      btn.textContent = "Erreur";
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = "Erreur";
    btn.disabled = false;
  }
}

// ── Toutes les opportunités ──
let allNotices = [];

async function loadNotices() {
  window._noticesLoaded = true;
  try {
    const res = await fetch("/api/notices");
    const data = await res.json();
    allNotices = data.notices || [];

    document.getElementById("opp-count").textContent =
      allNotices.length + " opportunité" + (allNotices.length !== 1 ? "s" : "");
    if (data.runAt) {
      const d = new Date(data.runAt).toLocaleDateString("fr-FR", {day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"});
      document.getElementById("opp-run").textContent = "Mise à jour : " + d;
    }

    // Populate country filter
    const countries = [...new Set(allNotices.map(n => n.country).filter(Boolean))].sort();
    const countrySelect = document.getElementById("f-country");
    countries.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      countrySelect.appendChild(opt);
    });

    // Populate source filter
    const sources = [...new Set(allNotices.map(n => n.source).filter(Boolean))].sort();
    const sourceSelect = document.getElementById("f-source");
    sources.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      sourceSelect.appendChild(opt);
    });

    filterNotices();
  } catch(e) {
    document.getElementById("opp-count").textContent = "Aucune donnée";
    document.getElementById("opp-tbody").innerHTML =
      '<tr><td colspan="7" class="mk-empty">Aucune donnée — lancez /run pour générer un rapport</td></tr>';
  }
}

function filterNotices() {
  const q = document.getElementById("f-q").value.toLowerCase();
  const country = document.getElementById("f-country").value;
  const type = document.getElementById("f-type").value;
  const budgetMin = parseFloat(document.getElementById("f-budget").value) || 0;
  const deadlineDays = parseInt(document.getElementById("f-deadline").value) || 0;
  const source = document.getElementById("f-source").value;
  const now = new Date();

  let filtered = allNotices.filter(n => {
    if (q && !(n.title||"").toLowerCase().includes(q) && !(n.acheteur||"").toLowerCase().includes(q)) return false;
    if (country && n.country !== country) return false;
    if (type) {
      if (type === "Competition" && n.procedure !== "Competition" && n.nature !== "Competition") return false;
      if (type !== "Competition" && n.buildingType !== type) return false;
    }
    if (budgetMin && (parseFloat(n.budgetRaw)||0) < budgetMin) return false;
    if (deadlineDays && n.deadline) {
      const dl = new Date(n.deadline);
      const diff = (dl - now) / (1000*60*60*24);
      if (diff < 0 || diff > deadlineDays) return false;
    }
    if (source && n.source !== source) return false;
    return true;
  });

  document.getElementById("opp-filter-count").textContent =
    filtered.length + " résultat" + (filtered.length !== 1 ? "s" : "") + (filtered.length < allNotices.length ? " (filtré sur " + allNotices.length + ")" : "");

  const tbody = document.getElementById("opp-tbody");
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="mk-empty">Aucun résultat</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.slice(0, 200).map(n => {
    let deadline = '<span style="color:#c4c3c1">—</span>';
    if (n.deadline) {
      const dl = new Date(n.deadline);
      const diff = Math.ceil((dl - now) / (1000*60*60*24));
      const str = dl.toLocaleDateString("fr-FR",{day:"numeric",month:"short"});
      const color = diff <= 7 ? "#cc0000" : diff <= 30 ? "#b45309" : "#1a1a1a";
      deadline = '<span style="font-weight:700;color:' + color + '">' + str + '</span><span style="font-size:9px;color:#676867;display:block">' + diff + 'j</span>';
    }

    const isComp = n.procedure === "Competition" || n.nature === "Competition";
    // ── 日付表示 ──
    const fmtDate = (d) => {
      if (!d) return null;
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      return dt.toLocaleDateString("fr-FR",{day:"numeric",month:"short",year:"numeric"});
    };
    const pubDate = fmtDate(n.date_pub);
    const dlDate  = fmtDate(n.deadline);
    const now2 = new Date();
    const dlDays  = n.deadline ? Math.ceil((new Date(n.deadline)-now2)/(1000*60*60*24)) : null;
    const dlColor = dlDays !== null ? (dlDays<=14?"#cc0000":dlDays<=30?"#b45309":"#1a1a1a") : "#676867";

    const datesHtml =
      (pubDate ? '<div style="font-size:9px;color:#676867;margin-bottom:4px">Publication<br><span style="color:#1a1a1a;font-weight:700">' + pubDate + '</span></div>' : '') +
      (dlDate  ? '<div style="font-size:9px;color:' + dlColor + '">Date limite<br><span style="font-weight:700">' + dlDate + '</span>' + (dlDays!==null ? '<span style="font-size:8px;color:'+dlColor+';display:block">J−' + dlDays + '</span>' : '') + '</div>' : '<div style="font-size:9px;color:#c4c3c1">Date limite<br>—</div>');

    // ── 専門家・AMO ──
    const specs = (n.specialites_requises||[]).map(s =>
      '<span style="font-size:8px;background:#f0f4ff;color:#0016B4;padding:1px 6px;margin-right:3px;margin-bottom:2px;display:inline-block">' + esc(s) + '</span>'
    ).join("");
    const details = [
      n.surface ? '<span style="font-size:9px;color:#676867">Surface : <strong style="color:#1a1a1a">' + n.surface.toLocaleString("fr-FR") + ' m²</strong></span>' : null,
      n.prime ? '<span style="font-size:9px;color:#676867">Prime : <strong style="color:#1a1a1a">' + n.prime.toLocaleString("fr-FR") + ' €</strong></span>' : null,
      n.mission ? '<span style="font-size:9px;color:#676867">Mission : <strong style="color:#1a1a1a">' + esc(n.mission) + '</strong></span>' : null,
      n.type_concours ? '<span style="font-size:9px;color:#676867">Type : <strong style="color:#1a1a1a">' + esc(n.type_concours) + '</strong></span>' : null,
      n.nb_candidats_max ? '<span style="font-size:9px;color:#676867">Candidats max : <strong style="color:#1a1a1a">' + n.nb_candidats_max + '</strong></span>' : null,
    ].filter(Boolean).join('<span style="color:#c4c3c1;margin:0 6px">|</span>');

    // ── AMO/Programmiste（Partner DBとの照合結果も将来的に追加）──
    const amoInfo = n.amo_client || (n.specialites_requises||[]).find(s => s.toLowerCase().includes("amo")||s.toLowerCase().includes("program")) || null;

    return '<tr style="border-bottom:1px solid #eee">' +
      // Source
      '<td style="vertical-align:top;padding:12px 10px">' +
        '<span class="mk-tag" style="font-size:7px;display:block;margin-bottom:3px">' + esc(n.source) + '</span>' +
        (isComp ? '<span class="mk-tag mk-tag-blue" style="font-size:7px;display:block;margin-bottom:3px">Concours</span>' : '') +
        (n.type_concours ? '<span style="font-size:8px;color:#676867;display:block">' + esc(n.type_concours) + '</span>' : '') +
        (n.enriched ? '<span style="font-size:7px;color:#22c55e;display:block;margin-top:2px">● Analysé</span>' : '') +
      '</td>' +
      // Titre & Infos
      '<td style="vertical-align:top;padding:12px 10px;max-width:380px">' +
        '<div style="font-size:13px;font-weight:700;color:#1a1a1a;line-height:1.3;margin-bottom:4px">' + esc(n.title) + '</div>' +
        // 詳細情報バー
        (details ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px">' + details + '</div>' : '') +
        // 必要専門家
        (specs ? '<div style="margin-bottom:5px"><span style="font-size:8px;color:#676867;text-transform:uppercase;letter-spacing:0.1em;margin-right:4px">Équipe :</span>' + specs + '</div>' : '') +
        // AMO/Programmiste
        (amoInfo ? '<div style="font-size:9px;background:#fef3c7;border-left:2px solid #f59e0b;padding:3px 8px;margin-bottom:4px;color:#92400e"><strong>AMO/Prog. :</strong> ' + esc(amoInfo) + '</div>' : '') +
        // MKメモ
        (n.note_mk ? '<div style="font-size:9px;background:#f0f4ff;border-left:2px solid #0016B4;padding:3px 8px;color:#0016B4;font-style:italic">' + esc(n.note_mk) + '</div>' : '') +
      '</td>' +
      // Maître d'ouvrage
      '<td style="vertical-align:top;padding:12px 10px;min-width:140px">' +
        '<div style="font-size:11px;color:#1a1a1a;font-weight:500">' + esc(n.acheteur||"—") + '</div>' +
        (n.country ? '<div style="font-size:10px;color:#676867;margin-top:2px">' + esc(n.country) + '</div>' : '') +
      '</td>' +
      // Dates
      '<td style="vertical-align:top;padding:12px 10px;min-width:130px">' + datesHtml + '</td>' +
      // Budget
      '<td style="vertical-align:top;padding:12px 10px;font-size:12px;font-weight:700;white-space:nowrap">' +
        (n.budget ? esc(n.budget) : '—') +
        (n.prime ? '<div style="font-size:9px;color:#676867;font-weight:400;margin-top:2px">Prime : ' + n.prime.toLocaleString("fr-FR") + ' €</div>' : '') +
      '</td>' +
      // Lien
      '<td style="vertical-align:top;padding:12px 10px;text-align:right">' +
        '<a href="' + esc(n.url) + '" target="_blank" style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0016B4;text-decoration:none">Voir →</a>' +
      '</td>' +
    '</tr>';
  }).join("");
}

function resetFilters() {
  ["f-q","f-country","f-type","f-budget","f-deadline","f-source"].forEach(id => {
    const el = document.getElementById(id);
    el.value = id === "f-q" ? "" : "";
  });
  filterNotices();
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
</script>
</body>
</html>`);
});



// ─── API: 最新公募データ ────────────────────────────────────────────────────────
app.get("/api/notices", (req, res) => {
  const NOTICES_FILE = path.join(DATA_DIR, "last_notices.json");
  try {
    const data = JSON.parse(fs.readFileSync(NOTICES_FILE, "utf-8"));
    let notices = data.notices || [];
    const { country, type, budget_min, q, source } = req.query;
    if (country) notices = notices.filter(n => n.country === country || n.region === country);
    if (type) notices = notices.filter(n => n.buildingType === type || n.procedure === type || n.nature === type);
    if (budget_min) notices = notices.filter(n => (parseFloat(n.budgetRaw)||0) >= parseFloat(budget_min));
    if (q) { const ql = q.toLowerCase(); notices = notices.filter(n => (n.title||"").toLowerCase().includes(ql) || (n.acheteur||"").toLowerCase().includes(ql)); }
    if (source) notices = notices.filter(n => n.source === source);
    res.json({ runAt: data.runAt, total: data.notices.length, count: notices.length, notices });
  } catch(e) {
    res.json({ runAt: null, total: 0, count: 0, notices: [] });
  }
});

// ─── API: 進捗催促メール ────────────────────────────────────────────────────────
app.post("/api/remind/:projectId", async (req, res) => {
  const project = followedProjects.find(p => String(p.id) === req.params.projectId);
  if (!project) return res.status(404).json({ error: "Projet introuvable" });
  if (!project.assignedEmail) return res.status(400).json({ error: "Pas d'email assigné" });
  if (!resend) return res.status(500).json({ error: "RESEND_API_KEY non configuré" });
  const subject = `MK Monitor — Rapport de progression requis : ${project.title}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#1a1a1a;padding:20px 28px">
      <div style="font-size:8px;color:#676867;letter-spacing:0.25em;text-transform:uppercase">Moreau Kusunoki Architectes</div>
      <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.12em;text-transform:uppercase;margin-top:6px">MK Monitor</div>
    </div>
    <div style="background:#ffffff;padding:28px;border:1px solid #e5e7eb;border-top:none">
      <p style="font-size:13px;color:#1a1a1a">Bonjour ${escapeHtml(project.assignedTo)},</p>
      <p style="font-size:13px;color:#1a1a1a;margin-top:12px">Merci de rapporter l'état d'avancement des documents de candidature pour le concours suivant <strong>avant la fin de la journée</strong> :</p>
      <div style="background:#f5f4f2;border-left:3px solid #0016B4;padding:14px 18px;margin:18px 0">
        <div style="font-size:14px;font-weight:700;color:#1a1a1a">${escapeHtml(project.title)}</div>
        <div style="font-size:11px;color:#676867;margin-top:4px">${escapeHtml(project.acheteur||"")} · ${escapeHtml(project.country||"")}</div>
        ${project.url ? `<div style="margin-top:8px"><a href="${escapeHtml(project.url)}" style="font-size:11px;color:#0016B4">→ Accéder au dossier</a></div>` : ""}
      </div>
      <p style="font-size:11px;color:#676867;margin-top:12px">Merci de votre retour.<br>— MK Monitor</p>
    </div>
  </div>`;
  try {
    const { error } = await resend.emails.send({ from: CONFIG.senderEmail, to: project.assignedEmail, subject, html });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({
  status: "ok", service: "MK Monitor",
  followedProjects: followedProjects.length,
}));

app.get("/run", async (req, res) => {
  console.log("🔧 手動実行トリガー (web)");
  res.json({ status: "started", message: "Monitor started. Check logs." });
  runMonitor().catch(console.error);
});

function startWebServer() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Webサーバー起動: port ${PORT}`);
    if (process.env.SERVICE_URL) {
      console.log(`   フォローURL: ${process.env.SERVICE_URL}/follow`);
    } else {
      console.log("   ⚠️  SERVICE_URL未設定 — フォローリンクは無効");
    }
  });
}



function scheduleNextRun() {
  const now = new Date();
  const parisNow = new Date(now.toLocaleString("en-US", { timeZone:"Europe/Paris" }));
  const next7am = new Date(parisNow);
  next7am.setHours(7, 0, 0, 0);
  if (next7am <= parisNow) next7am.setDate(next7am.getDate() + 1);
  const msUntil = next7am - parisNow;
  const minsUntil = Math.round(msUntil / 1000 / 60);
  console.log(`⏰ 次回実行: パリ時間 ${next7am.toLocaleString("fr-FR")} (約${minsUntil}分後)`);
  setTimeout(() => {
    runMonitor()
      .catch(console.error)
      .finally(() => scheduleNextRun());
  }, msUntil);
}

if (IS_TEST) {
  console.log("🧪 テストモード実行...");
  startWebServer();
  runMonitor().catch(console.error);
} else {
  startWebServer();
  console.log("✅ MK Monitor 起動");
  RECIPIENTS.forEach(r=>r.email&&console.log(`   ${r.name}: ${r.email} [${r.lang}, ${r.filterLevel}]`));
  scheduleNextRun();
}
