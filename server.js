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

// .env lokal laden (auf Render die Variablen im Dashboard setzen)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || !line.includes("=")) continue;
    const i = line.indexOf("="); const k = line.slice(0,i); const v = line.slice(i+1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Mini-Persistenz
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
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 BerlinWatcher/3.1" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
const abs = (base, href) => {
  try { return href?.startsWith("http") ? href : new URL(href, base).toString(); } catch { return null; }
};
const pick = ($n) => ($n.text()||"").replace(/\s+/g," ").trim();
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

// generischer Parser, der mehrere Karten-Selektoren ausprobiert
async function parseListing(name, url, hrefRegex, q){
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const items = [];
  const CARD_SEL = [
    "article", ".teaser", ".card", ".listing", ".listing-item",
    ".c-results__item", ".result", "li", ".tile", ".object", ".item"
  ];
  $(CARD_SEL.join(",")).each((_, el)=>{
    const card = $(el);
    const a = card.find("a[href]").first();
    const href = a.attr("href")||"";
    if(!hrefRegex.test(href)) return;
    const link = abs(url, href); if(!link) return;
    const text = pick(card);
    const { price, rooms, size } = parseNums(text);
    const title = pick(a) || "Angebot";
    // Ort/Bezirk heuristisch aus Text
    const location = (text.match(/Berlin[^|,\n]*/)||[])[0] || (text.match(/(Charlottenburg|Wilmersdorf|Mitte|Pankow|Neukölln|Lichtenberg|Marzahn|Kreuzberg|Friedrichshain|Spandau|Reinickendorf|Steglitz|Zehlendorf|Tempelhof|Schöneberg|Köpenick|Treptow)/i)||[])[0] || "Berlin";
    if(matchesDistrict(`${text} ${title} ${location}`, q?.bezirke)) {
      items.push({ id: link, url: link, title, provider: name, price, rooms, size, location });
    }
  });
  return items;
}

// Provider (alle 6 Gesellschaften) – URLs sind die zentrale Einstiegs-/Angebotsseiten
async function providerVonovia(q){
  return parseListing("Vonovia", "https://www.vonovia.de/immobiliensuche", /immobil|wohnung|miete/i, q);
}
async function providerGewobag(q){
  return parseListing("Gewobag", "https://www.gewobag.de/wohnungen/angebote/", /angebot|wohnung|miete/i, q);
}
async function providerDegewo(q){
  return parseListing("DEGEWO", "https://www.degewo.de/wohnungen/wohnungsangebote/", /angebot|wohnung|miete/i, q);
}
async function providerDeutscheWohnen(q){
  return parseListing("Deutsche Wohnen", "https://www.deutsche-wohnen.com/mieten/wohnungsangebote/", /angebot|wohnung|miete/i, q);
}
async function providerStadtUndLand(q){
  return parseListing("STADT UND LAND", "https://www.stadtundland.de/wohnungen/wohnungsangebote", /wohnung|angebot|miete/i, q);
}
async function providerBerlinovo(q){
  return parseListing("Berlinovo", "https://www.berlinovo.de/de/wohnraum", /wohn|apartment|miete|angebot/i, q);
}

// optionaler Fallback, liefert immer einen Sammel-Link
async function providerGoogleFallback(q){
  const sites = [
    "site:vonovia.de", "site:gewobag.de", "site:degewo.de",
    "site:deutsche-wohnen.com", "site:stadtundland.de", "site:berlinovo.de"
  ];
  const terms = [ "Berlin" ].concat(q?.bezirke || []).concat(sites).join(" ");
  const url = "https://www.google.com/search?q=" + encodeURIComponent(terms);
  return [{ id:url, url, title:"Sammelsuche in allen Gesellschaften (Google)", provider:"Google", price:null, rooms:null, size:null, location:"Berlin" }];
}

const PROVIDERS = {
  vonovia:      { name: "Vonovia", fn: providerVonovia, enabled: true },
  gewobag:      { name: "Gewobag", fn: providerGewobag, enabled: true },
  degewo:       { name: "DEGEWO", fn: providerDegewo, enabled: true },
  dw:           { name: "Deutsche Wohnen", fn: providerDeutscheWohnen, enabled: true },
  stadtundland: { name: "STADT UND LAND", fn: providerStadtUndLand, enabled: true },
  berlinovo:    { name: "Berlinovo", fn: providerBerlinovo, enabled: true },
  google:       { name: "Google Fallback", fn: providerGoogleFallback, enabled: true } // bleibt an, bis echte Treffer kommen
};

// Suche
function newSearch(input){
  const id = String(Date.now()) + Math.random().toString(36).slice(2,8);
  const all = Object.keys(PROVIDERS);
  const chosen = input.providers && input.providers.length ? input.providers : all;
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
  // Filter anwenden
  const c = search.criteria || {};
  results = results.filter(r => {
    if(c.zimmerMin && r.rooms && r.rooms < Number(c.zimmerMin)) return false;
    if(c.zimmerMax && r.rooms && r.rooms > Number(c.zimmerMax)) return false;
    if(c.flaecheMin && r.size  && r.size  < Number(c.flaecheMin)) return false;
    if(c.preisMax  && r.price && r.price > Number(c.preisMax))   return false;
    if(c.bezirke && c.bezirke.length && r.location && !matchesDistrict(`${r.location} ${r.title}`, c.bezirke)) return false;
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

// Server
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
  const s = DB.searches.find(x=>x.id===req.params.id); if(!s) return res.status(404).json({ error:"not found" });
  const out = await runOnce(s); res.json(out);
});

// Polling
setInterval(async ()=>{ for(const s of DB.searches.filter(s=>s.active)){ try{ await runOnce(s); }catch(e){ console.error("runOnce", e); } } }, 30*1000);

app.listen(PORT, ()=> console.log("Server on", BASE_URL));
