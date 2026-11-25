// تحدي الكرة العالمية — server version (Node.js, no dependencies).
// Serves the game + JSON API, stores players in data/db.json.
// Run:  node server.js        (PORT env or 3000)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DB_FILE = path.join(ROOT, "data", "db.json");

const SHOP = {
  life:  { price: 30,  label: "حياة إضافية" },
  hint:  { price: 15,  label: "تلميح 50:50" },
  retry: { price: 20,  label: "إعادة محاولة" },
  time:  { price: 15,  label: "وقت إضافي" },
  skip:  { price: 25,  label: "تخطي إضافي" },
  noads:{ price: 150, label: "إزالة الإعلانات" },
};
const PACKS = [
  { coins: 200,  price: 0.49, bonus: 0,   save: "الباقة الأساسية" },
  { coins: 650,  price: 1.49, bonus: 42,  save: "أوفر 7%" },
  { coins: 1400, price: 2.99, bonus: 180, save: "أوفر 15%" },
  { coins: 2500, price: 4.99, bonus: 463, save: "أوفر 23% — الأوفر" },
];
const TITLES = ["sniper", "bolt", "king", "goat"];
const IG_ORDER = "https://www.instagram.com/ward.6012700";

// ---------- store ----------
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (d && typeof d === "object" && d.players) return d;
  } catch (e) {}
  return { players: {} };
}
function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
let db = loadDb();

function monthKey() {
  // Asia/Damascus month, e.g. "2026-11"
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Damascus" }).slice(0, 7);
}
function ensureMonth(p) {
  const m = monthKey();
  if (p.month !== m) { p.month = m; p.monthlyScore = 0; p.monthlyGames = 0; }
}
function pub(p) {
  return {
    id: p.id, name: p.name, coins: p.coins, score: p.score,
    monthlyScore: p.monthlyScore, monthlyGames: p.monthlyGames, games: p.games,
    inv: p.inv, titles: p.titles, activeTitleId: p.activeTitleId || null,
  };
}
function newPlayer(name) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), name, coins: 100, score: 0,
    monthlyScore: 0, monthlyGames: 0, games: 0,
    inv: { life: 0, hint: 0, retry: 0, time: 0, skip: 0, noads: false },
    titles: [], activeTitleId: null, month: monthKey(), createdAt: now,
  };
}
const cleanName = (n) => String(n == null ? "" : n).trim().slice(0, 20);
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// ---------- http helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(b);
}
function sendFile(res, file) {
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) { sendJson(res, 404, { error: "not found" }); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=300" });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 65536) { reject(new Error("body too large")); req.destroy(); } chunks.push(c); });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/health") {
    return sendJson(res, 200, { ok: true, month: monthKey(), players: Object.keys(db.players).length });
  }
  if (req.method === "GET" && p === "/api/packs") {
    return sendJson(res, 200, { packs: PACKS, orderVia: IG_ORDER, note: "الشحن عن طريق مراسلة المطوّر على إنستغرام — لا دفع داخل الصفحة." });
  }
  if (req.method === "GET" && p === "/api/leaderboard") {
    const type = url.searchParams.get("type") === "global" ? "global" : "monthly";
    const list = Object.values(db.players).map((pl) => { ensureMonth(pl); return pl; });
    list.sort((a, b) => (type === "global" ? b.score - a.score : b.monthlyScore - a.monthlyScore));
    return sendJson(res, 200, {
      type, month: monthKey(),
      entries: list.slice(0, 25).map((pl) => ({ id: pl.id, name: pl.name, monthlyScore: pl.monthlyScore, score: pl.score, games: pl.games })),
    });
  }
  if (req.method === "GET" && p === "/api/player") {
    const pl = db.players[url.searchParams.get("id") || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    ensureMonth(pl); saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && (p === "/api/register" || p === "/api/rename")) {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 400, { error: "اكتب اسمك" });
    if (p === "/api/register") {
      const pl = newPlayer(name);
      db.players[pl.id] = pl; saveDb(db);
      return sendJson(res, 200, { player: pub(pl) });
    }
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    pl.name = name; saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && p === "/api/submit") {
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    if (!isInt(body.score, 0, 30000) || !isInt(body.correct, 0, 1000) || !isInt(body.total, 0, 1000))
      return sendJson(res, 400, { error: "نتيجة غير صالحة" });
    ensureMonth(pl);
    pl.score += body.score;
    pl.monthlyScore += body.score;
    pl.monthlyGames += 1;
    pl.games += 1;
    if (isInt(body.coins, 0, 1000000)) pl.coins = body.coins; // final local balance after in-game spends
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && p === "/api/sync") {
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود" });
    if (isInt(body.coins, 0, 1000000)) pl.coins = body.coins;
    if (body.inv && typeof body.inv === "object") {
      for (const k of ["life", "hint", "retry", "time", "skip"])
        if (isInt(body.inv[k], 0, 999)) pl.inv[k] = body.inv[k];
      if (typeof body.inv.noads === "boolean") pl.inv.noads = body.inv.noads;
    }
    if (Array.isArray(body.titles)) pl.titles = body.titles.filter((t) => TITLES.includes(t));
    if (body.activeTitleId === null || TITLES.includes(body.activeTitleId)) pl.activeTitleId = body.activeTitleId;
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && p === "/api/shop/buy") {
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    const item = SHOP[body.item];
    if (!item) return sendJson(res, 400, { error: "عنصر غير معروف" });
    if (body.item === "noads" && pl.inv.noads) return sendJson(res, 400, { error: "مفعّلة عندك من قبل ✓" });
    if (pl.coins < item.price) return sendJson(res, 400, { error: "كوينزك ما بتكفي — بدك " + item.price + " وعندك " + pl.coins });
    pl.coins -= item.price;
    if (body.item === "noads") pl.inv.noads = true;
    else pl.inv[body.item] = (pl.inv[body.item] || 0) + 1;
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl), bought: body.item });
  }
  return sendJson(res, 404, { error: "unknown api" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) { await handleApi(req, res, url); return; }
    let rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (url.pathname === "/" || !url.pathname.includes(".")) { sendFile(res, path.join(PUBLIC, "index.html")); return; }
      return sendJson(res, 404, { error: "not found" });
    }
    sendFile(res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`تحدي الكرة العالمية — server running on http://${HOST}:${PORT} (month ${monthKey()}, players ${Object.keys(db.players).length})`);
});
