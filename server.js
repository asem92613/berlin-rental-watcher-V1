import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env lokal lesen; auf Render trägst du die Variablen im Dashboard ein
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || !line.includes("=")) continue;
    const i = line.indexOf("="); const k = line.slice(0, i); const v = line.slice(i + 1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// einfache Persistenz
const dataFile = path.join(__dirname, "data.json");
let DB = { searches: [], seen: {} };
try { DB = JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch {}
const persist = () => fs.writeFileSync(dataFile, JSON.stringify(DB, null, 2));

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
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"
    }
  });
  if (!res.ok) {
    console.error("fetchHTML non-200", res.status, url);
    return null;
  }
  return await res.text();
}
const abs = (base, href) => {
  try { return href?.startsWith("http") ? href : new URL(href, base).toString(); } catch { return null; }
};
const pick = ($n) => ($n.text() || "").replace(/\s+/g, " ").trim();
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
const matchesDistrict = (text, wanted) => {
  if(!wanted || !wanted.length) return true;
  const hay = (text||"").toLowerCase();
  return wanted.some(b => hay.includes(b.toLowerCase()));
};
const encode = (v) => encodeURIComponent(v);

// Kriterien → Text
const roomsClause = (q) => {
  const min = q?.zimmerMin ? Number(q.zimmerMin) : null;
  const max = q?.zimmerMax ? Number(q.zimmerMax) : null;
  if(min && max) return `${min}-${max}`;
  if(min) return `${min}-`;
  if(max) return `-${max}`;
  return "";
};
const districtsClause = (q) => (Array.isArray(q?.bezirke) ? q.bezirke : []).filter(Boolean);

// HTML-Seite in strukturierte Items parsen und streng filtern
async function parseListingPage(name, url, hrefRegex, q){
  const html = await fetchHTML(url);
  if(!html) return [];
  const $ = cheerio.load(html);
  const items = [];
  const CARD_SEL = [
    "article",".card",".listing",".listing-item",".c-results__item",
    ".offer",".result",".result-item",".tile",".object",
    ".search-result",".search__result","li"
  ];
  $(CARD_SEL.join(",")).each((_, el)=>{
    const card = $(el);
    const a = card.find("a[href]").first();
    if(!a.length) return;
    const href = a.attr("href")||"";
    if(!hrefRegex.test(href)) return;
    const link = abs(url, href); if(!link) return;
    const text = pick(card);
    const { price, rooms, size } = parseNums(text);
    const title = pick(a) || "Angebot";
    const location = (text.match(/Berlin[^|,\n]*/)||[])[0] || "Berlin";
    items.push({ id: link, url: link, title, provider: name, price, rooms, size, location });
  });

  const bez = districtsClause(q);
  const wantBez = bez.length > 0;
  return items.filter(it=>{
    if(q?.zimmerMin && it.rooms && it.rooms < Number(q.zimmerMin)) return false;
    if(q?.zimmerMax && it.rooms && it.rooms > Number(q.zimmerMax)) return false;
    if(q?.flaecheMin && it.size && it.size < Number(q.flaecheMin)) return false;
    if(q?.preisMax  && it.price && it.price > Number(q.preisMax))   return false;
    if(wantBez){
      const hay = `${it.location||""} ${it.title||""}`.toLowerCase();
      const ok = bez.some(b=>hay.includes(b.toLowerCase()));
      if(!ok) return false;
    }
    return true;
  });
}

// mehrere Kandidat-URLs testen; wenn keine greift, Firmen-Suchlink zurückgeben
async function tryCandidates(name, candidates, hrefRegex, q, fallbackLink){
  for (const url of candidates) {
    const items = await parseListingPage(name, url, hrefRegex, q);
    if (items.length) return items;
  }
  return fallbackLink ? [{
    id: fallbackLink, url: fallbackLink,
    title: `Zur Suche bei ${name} öffnen`,
    provider: name, price: null, rooms: null, size: null,
    location: (q?.bezirke?.length ? q.bezirke.join(", ") : "Berlin")
  }] : [];
}

// Such-URL-Builder je Anbieter
function buildVonoviaURL(q){
  const p = [];
  p.push(`city=${encode("Berlin")}`);
  if(q?.zimmerMin) p.push(`roomsFrom=${encode(q.zimmerMin)}`);
  if(q?.zimmerMax) p.push(`roomsTo=${encode(q.zimmerMax)}`);
  if(q?.preisMax)  p.push(`rentTo=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`areaFrom=${encode(q.flaecheMin)}`);
  return `https://www.vonovia.de/immobiliensuche?${p.join("&")}`;
}
function buildGewobagURL(q){
  const p = [];
  p.push(`ort=${encode("Berlin")}`);
  if(q?.preisMax)  p.push(`miete_bis=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`flaeche_ab=${encode(q.flaecheMin)}`);
  if(q?.zimmerMin) p.push(`zimmer_ab=${encode(q.zimmerMin)}`);
  if(q?.zimmerMax) p.push(`zimmer_bis=${encode(q.zimmerMax)}`);
  return `https://www.gewobag.de/wohnungen/angebote/?${p.join("&")}`;
}
function buildDegewoURL(q){
  const p = [];
  p.push(`ort=${encode("Berlin")}`);
  if(q?.zimmerMin) p.push(`zimmer_von=${encode(q.zimmerMin)}`);
  if(q?.zimmerMax) p.push(`zimmer_bis=${encode(q.zimmerMax)}`);
  if(q?.preisMax)  p.push(`miete_bis=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`flaeche_ab=${encode(q.flaecheMin)}`);
  return `https://www.degewo.de/wohnungen/wohnungssuche/?${p.join("&")}`;
}
function buildDeutscheWohnenURL(q){
  const p = [];
  p.push(`ort=${encode("Berlin")}`);
  if(q?.zimmerMin) p.push(`zimmer_von=${encode(q.zimmerMin)}`);
  if(q?.zimmerMax) p.push(`zimmer_bis=${encode(q.zimmerMax)}`);
  if(q?.preisMax)  p.push(`miete_bis=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`flaeche_ab=${encode(q.flaecheMin)}`);
  return `https://www.deutsche-wohnen.com/mieten/wohnungsangebote/?${p.join("&")}`;
}
function buildStadtUndLandURL(q){
  const p = [];
  p.push(`stadt=${encode("Berlin")}`);
  if(q?.zimmerMin) p.push(`zimmer_ab=${encode(q.zimmerMin)}`);
  if(q?.zimmerMax) p.push(`zimmer_bis=${encode(q.zimmerMax)}`);
  if(q?.preisMax)  p.push(`miete_bis=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`flaeche_ab=${encode(q.flaecheMin)}`);
  return `https://www.stadtundland.de/mietangebote?${p.join("&")}`;
}
function buildBerlinovoURL(q){
  const p = [];
  p.push(`search=${encode("Berlin")}`);
  const rc = roomsClause(q);
  if(rc)           p.push(`rooms=${encode(rc)}`);
  if(q?.preisMax)  p.push(`rentTo=${encode(q.preisMax)}`);
  if(q?.flaecheMin)p.push(`spaceFrom=${encode(q.flaecheMin)}`);
  return `https://www.berlinovo.de/de/wohnraum?${p.join("&")}`;
}

// Provider-Funktionen
async function providerVonovia(q){
  const url = buildVonoviaURL(q);
  return tryCandidates("Vonovia",
    [url, "https://www.vonovia.de/de-de/mieten/immobiliensuche"],
    /immobil|wohnung|miete|expose/i, q,
    url);
}
async function providerGewobag(q){
  const url = buildGewobagURL(q);
  return tryCandidates("Gewobag",
    [url, "https://www.gewobag.de/wohnungen/"],
    /angebot|wohnung|miete|expose/i, q,
    url);
}
async function providerDegewo(q){
  const url = buildDegewoURL(q);
  return tryCandidates("DEGEWO",
    [url, "https://www.degewo.de/wohnungen/wohnungsangebote/"],
    /angebot|wohnung|miete|expose/i, q,
    url);
}
async function providerDeutscheWohnen(q){
  const url = buildDeutscheWohnenURL(q);
  return tryCandidates("Deutsche Wohnen",
    [url, "https://www.deutsche-wohnen.com/mieten/"],
    /angebot|wohnung|miete|expose/i, q,
    url);
}
async function providerStadtUndLand(q){
  const url = buildStadtUndLandURL(q);
  return tryCandidates("STADT UND LAND",
    [url, "https://www.stadtundland.de/wohnungen/wohnungsangebote"],
    /wohnung|angebot|miete|expose/i, q,
    url);
}
async function providerBerlinovo(q){
  const url = buildBerlinovoURL(q);
  return tryCandidates("Berlinovo",
    [url, "https://www.berlinovo.de/de/wohnraum/mieten"],
    /wohn|apartment|miete|angebot|expose/i, q,
    url);
}
async function providerGoogleFallback(q){
  const sites = [
    "site:vonovia.de","site:gewobag.de","site:degewo.de",
    "site:deutsche-wohnen.com","site:stadtundland.de","site:berlinovo.de"
  ];
  const parts = ["Berlin"].concat(q?.bezirke||[]).concat(sites);
  const url = "https://www.google.com/search?q=" + encode(parts.join(" "));
  const loc = (q?.bezirke?.length ? q.bezirke.join(", ") : "Berlin");
  return [{ id:url, url, title:"Sammelsuche (Google)", provider:"Google", price:null, rooms:null, size:null, location:loc }];
}

const PROVIDERS = {
  vonovia:      { name: "Vonovia", fn: providerVonovia, enabled: true },
  gewobag:      { name: "Gewobag", fn: providerGewobag, enabled: true },
  degewo:       { name: "DEGEWO", fn: providerDegewo, enabled: true },
  dw:           { name: "Deutsche Wohnen", fn: providerDeutscheWohnen, enabled: true },
  stadtundland: { name: "STADT UND LAND", fn: providerStadtUndLand, enabled: true },
  berlinovo:    { name: "Berlinovo", fn: providerBerlinovo, enabled: true },
  google:       { name: "Google Fallback", fn: providerGoogleFallback, enabled: true }
};

// Suche und Filter
function newSearch(input){
  const id = String(Date.now()) + Math.random().toString(36).slice(2,8);
  const chosen = input.providers && input.providers.length ? input.providers : Object.keys(PROVIDERS);
  const s = { id, email: input.email || "", criteria: input.criteria || {}, providers: chosen, active: true, createdAt: Date.now() };
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
    if(c.bezirke && c.bezirke.length) {
      const hay = `${r.location || ""} ${r.title || ""}`.trim();
      const ok = hay ? matchesDistrict(hay, c.bezirke) : false;
      if (!ok && r.providerId !== "google") return false;
    }
    return true;
  });

  const seen = DB.seen[search.id] ||= {};
  const fresh = [];
  for(const r of results){
    if(!seen[r.id]){ fresh.push(r); seen[r.id] = { ts: Date.now(), url: r.url }; }
  }
  if(fresh.length && transporter && search.email){ await sendEmail(search.email, fresh); }
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

// Server + API
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req,res)=> res.json({ ok:true }));
app.get("/api/providers", (req,res)=> res.json(Object.entries(PROVIDERS).map(([id,p])=>({ id, name:p.name, enabled:!!p.enabled }))));
app.post("/api/searches", (req,res)=> res.json(newSearch(req.body||{})));
app.get("/api/searches", (req,res)=> res.json(DB.searches));
app.post("/api/searches/:id/toggle", (req,res)=>{
  const s = DB.searches.find(x=>x.id===req.params.id); if(!s) return res.status(404).json({ error:"not found" });
  s.active = !s.active; persist(); res.json(s);
});
app.get("/api/searches/:id/results", async (req,res)=>{
  const s = DB.searches.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ error:"not found" });
  const out = await runOnce(s); res.json(out);
});

// Polling alle 30s
setInterval(async ()=>{ for(const s of DB.searches.filter(s=>s.active)){ try{ await runOnce(s); }catch(e){ console.error("runOnce", e); } } }, 30*1000);

app.listen(PORT, ()=> console.log("Server on", BASE_URL));
