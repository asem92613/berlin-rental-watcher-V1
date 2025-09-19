import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio"; // ESM-konformer Import
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env laden (lokal). Auf Render trägst du die Variablen im Dashboard ein.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of envLines) {
    const i = line.indexOf("=");
    if (i > -1) {
      const k = line.slice(0, i);
      const v = line.slice(i + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Mini-DB
const dataFile = path.join(__dirname, "data.json");
let DB = { searches: [], seen: {} };
try { DB = JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch {}
function persist(){ fs.writeFileSync(dataFile, JSON.stringify(DB, null, 2)); }

// Mailer optional
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

// Utils
async function fetchHTML(url){
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BerlinWatcher/3.0" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
function abs(base, href){
  try { return href?.startsWith("http") ? href : new URL(href, base).toString(); } catch { return null; }
}
function pickText($node){ return ($node.text() || "").replace(/\s+/g," ").trim(); }
function parseNums(text){
  const t = (text||"").replace(/\s+/g," ");
  const price = (t.match(/(\d{2,5}(?:[.,]\d{3})*)\s*€/)||[])[1];
  const rooms = (t.match(/(\d+(?:[.,]\d)?)\s*(?:Zi|Zimmer)\b/i)||[])[1];
  const size  = (t.match(/(\d{2,4})\s*(?:m²|qm|m2)\b/i)||[])[1];
  return {
    price: price ? Number(price.replace(/\./g,"").replace(",", ".")) : null,
    rooms: rooms ? Number(rooms.replace(",", ".")) : null,
    size : size  ? Number(size) : null
  };
}
function matchesDistrict(text, wanted){
  if(!wanted || !wanted.length) return true;
  const hay = (text||"").toLowerCase();
  return wanted.some(b => hay.includes(b.toLowerCase()));
}

// generischer Provider-Helfer
async function genericProvider(name, url, hrefRegex){
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const out = [];
  $("a[href]").each((_, el)=>{
    const a = $(el);
    const href = a.attr("href")||"";
    if(!hrefRegex.test(href)) return;
    const link = abs(url, href); if(!link) return;
    const block = a.closest("article,li,div");
    const text = pickText(block);
    const {price, rooms, size} = parseNums(text);
    const title = pickText(a) || "Angebot";
    const location = (text.match(/Berlin[^|,\n]*/)||["Berlin"])[0];
    out.push({ id: link, url: link, title, provider: name, price, rooms, size, location });
  });
  return out;
}

// Provider
const PROVIDERS = {
  vonovia:      { name: "Vonovia",          fn: (q)=>genericProvider("Vonovia","https://www.vonovia.de/immobiliensuche",/immobilie|mieten|wohnung/i), enabled: true },
  gewobag:      { name: "Gewobag",          fn: (q)=>genericProvider("Gewobag","https://www.gewobag.de/wohnungen/angebote/",/angebot|wohnung|miete/i), enabled: true },
  degewo:       { name: "DEGEWO",           fn: (q)=>genericProvider("DEGEWO","https://www.degewo.de/wohnungen/wohnungsangebote/",/angebot|wohnung|miete/i), enabled: true },
  dw:           { name: "Deutsche Wohnen",  fn: (q)=>genericProvider("Deutsche Wohnen","https://www.deutsche-wohnen.com/mieten/wohnungsangebote/",/angebot|wohnung|miete/i), enabled: true },
  stadtundland: { name: "STADT UND LAND",   fn: (q)=>genericProvider("STADT UND LAND","https://www.stadtundland.de/wohnungen/wohnungsangebote",/wohnung|angebot|miete/i), enabled: true },
  berlinovo:    { name: "Berlinovo",        fn: (q)=>genericProvider("Berlinovo","https://www.berlinovo.de/de/wohnraum",/wohn|apartment|miete|angebot/i), enabled: true }
};

// Suche
function newSearch(input){
  const id = String(Date.now()) + Math.random().toString(36).slice(2,8);
  const s = { id, email: input.email || "", criteria: input.criteria || {}, providers: input.providers || Object.keys(PROVIDERS), active: true, createdAt: Date.now() };
  DB.searches.push(s); persist(); return s;
}
async function runOnce(search){
  let results = [];
  for(const pid of search.providers){
    const prov = PROVIDERS[pid]; if(!prov || !prov.enabled) continue;
    try{
      const items = await prov.fn(search.criteria || {});
      items.forEach(it => it.providerId = pid);
      results = results.concat(items);
    }catch(e){ console.error("Provider error", pid, e.message); }
  }
  const c = search.criteria || {};
  results = results.filter(r => {
    if(c.zimmerMin && r.rooms && r.rooms < Number(c.zimmerMin)) return false;
    if(c.zimmerMax && r.rooms && r.rooms > Number(c.zimmerMax)) return false;
    if(c.flaecheMin && r.size  && r.size  < Number(c.flaecheMin)) return false;
    if(c.preisMax  && r.price && r.price > Number(c.preisMax))   return false;
    if(c.bezirke && c.bezirke.length && r.location && !matchesDistrict(r.location, c.bezirke)) return false;
    return true;
  });

  const seen = DB.seen[search.id] ||= {};
  const fresh = [];
  for(const r of results){
    if(!seen[r.id]){ fresh.push(r); seen[r.id] = { ts: Date.now(), url: r.url }; }
  }
  if(fresh.length && transporter && search.email){
    await sendEmail(search.email, fresh);
  }
  persist();
  return { all: results, new: fresh };
}
async function sendEmail(to, items){
  if(!transporter) return;
  const html = `
  <h3>Neue Angebote (${items.length})</h3>
  <table border="1" cellpadding="6" cellspacing="0">
    <tr><th>Titel</th><th>Anbieter</th><th>Bezirk/Ort</th><th>Preis</th><th>Zimmer</th><th>m²</th><th>Link</th></tr>
    ${items.map(i => `<tr><td>${i.title||""}</td><td>${i.provider||""}</td><td>${i.location||""}</td><td>${i.price||""}</td><td>${i.rooms||""}</td><td>${i.size||""}</td><td><a href="${i.url}">Öffnen</a></td></tr>`).join("")}
  </table>`;
  const text = items.map(i => `${i.title||""} | ${i.provider||""} | ${i.location||""} | ${i.price||""} € | ${i.rooms||""} Zi | ${i.size||""} m² | ${i.url}`).join("\n");
  await transporter.sendMail({ from: process.env.FROM_EMAIL || "wohnung-bot@example.com", to, subject: `Neue Wohnungsangebote (${items.length})`, text, html });
}

// Server
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req,res)=> res.json({ ok:true }));
app.get("/api/providers", (req,res)=>{
  res.json(Object.entries(PROVIDERS).map(([id,p])=>({ id, name:p.name, enabled:!!p.enabled })));
});
app.post("/api/searches", (req,res)=>{
  const { email, criteria, providers } = req.body || {};
  const s = newSearch({ email, criteria, providers });
  res.json(s);
});
app.get("/api/searches", (req,res)=> res.json(DB.searches));
app.post("/api/searches/:id/toggle", (req,res)=>{
  const s = DB.searches.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ error:"not found" });
  s.active = !s.active; persist(); res.json(s);
});
app.get("/api/searches/:id/results", async (req,res)=>{
  const s = DB.searches.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ error:"not found" });
  const out = await runOnce(s);
  res.json(out);
});

// Polling
setInterval(async ()=>{
  for(const s of DB.searches.filter(s=>s.active)){
    try{ await runOnce(s); }catch(e){ console.error("runOnce error", e); }
  }
}, 30 * 1000);

// listen – wichtig: Prozess offen halten
app.listen(PORT, ()=> console.log("Server on", BASE_URL));

