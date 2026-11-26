// تحدي الكرة العالمية — server version 2 (Node.js, no dependencies).
// Serves the game + JSON API, stores players in data/db.json.
// Run:  node server.js        (PORT env or 3000)
//
// v2 security notes (see CHANGES.md):
// - Coins/points are SERVER-authoritative: the client can no longer set its
//   own balance. /api/submit validates the score against the real scoring
//   formula (100-200 pts per correct answer) and the earned coins against
//   the real in-game economy, then the server adds the validated amounts.
// - /api/sync can only DECREASE inventory (using an item in a match) and can
//   only activate titles the server already sold the player. It can never
//   set coins, grant items or grant titles.
// - All shop purchases (items + titles) go through /api/shop/buy and are
//   validated + deducted server-side.
// - Player names are sanitised (HTML/tags stripped, max 20 chars).
// - In-memory per-IP rate limits on all API routes.
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

// ---------- game economy (must match the client in public/index.html) ----------
// Points per correct answer: 100 base + time bonus 0..50 + streak bonus 0..50
//   => 100..200 points per correct answer.
// Coins per game: +5 per correct answer, +30 duel-win bonus, +20 completing
//   a full match, +50 daily-challenge bonus  => 5*correct .. 5*correct+100.
// In-game coin spends: retry 20/question, hint 50:50 15/question
//   => 0..35*total, always a multiple of 5.
// Game lengths: quick/daily/duel = 10 questions, final = 15 questions.
// Timer: 15s/question (12s in final) => a real game takes >= ~0.8s/question.
const GAME_TOTALS = [10, 15];
const MAX_SCORE_PER_CORRECT = 200;
const MIN_SCORE_PER_CORRECT = 100;
const COINS_PER_CORRECT = 5;
const MAX_BONUS_COINS = 100; // 30 duel win + 20 completion + 50 daily
const MAX_SPEND_PER_QUESTION = 35;
const MIN_MS_PER_QUESTION = 800;
const MAX_MS_PER_QUESTION = 600000; // 10 min/question (generous, allows idle)
const MAX_PLAYERS = 20000;

const SHOP = {
  life:  { price: 30,  label: "حياة إضافية" },
  hint:  { price: 15,  label: "تلميح 50:50" },
  retry: { price: 20,  label: "إعادة محاولة" },
  time:  { price: 15,  label: "وقت إضافي" },
  skip:  { price: 25,  label: "تخطي إضافي" },
  noads:{ price: 150, label: "إزالة الإعلانات" },
};
const TITLE_PRICES = { sniper: 75, bolt: 150, king: 300, goat: 500 };
const TITLES = ["sniper", "bolt", "king", "goat"];
const PACKS = [
  { coins: 200,  price: 0.49, bonus: 0,   save: "الباقة الأساسية" },
  { coins: 650,  price: 1.49, bonus: 42,  save: "أوفر 7%" },
  { coins: 1400, price: 2.99, bonus: 180, save: "أوفر 15%" },
  { coins: 2500, price: 4.99, bonus: 463, save: "أوفر 23% — الأوفر" },
];
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
    lastSubmitAt: 0,
  };
}
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// ---------- name sanitising ----------
// Strip anything that could break the page or inject markup, collapse
// whitespace, cap at 20 chars. A name must contain at least one letter or
// digit (Arabic or Latin) — pure symbols are rejected.
function cleanName(n) {
  let s = String(n == null ? "" : n);
  s = s.replace(/[<>&"'`\\/]/g, "");            // markup / quotes / slashes
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");  // control chars
  s = s.replace(/\s+/g, " ").trim().slice(0, 20).trim();
  if (!/[A-Za-z0-9\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(s)) return "";
  return s;
}

// ---------- rate limiting (in-memory, per IP) ----------
// Buckets: { key: [timestamps...] }. Old entries are pruned on each hit.
const buckets = new Map();
function hitBucket(key, limit, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= now - 60000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 60000).unref();

function clientIp(req) {
  // Render terminates TLS and proxies every request, appending the real
  // client IP as the LAST entry of X-Forwarded-For. Taking the last entry
  // (not the first) matters: a client can prepend fake entries, but it
  // cannot forge the entry the trusted proxy appends.
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) {
    const parts = String(fwd).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || "unknown";
}
function rateLimit(req, res, kind) {
  const ip = clientIp(req);
  const rules = {
    general: ["g:" + ip, 300, 60000],
    write:   ["w:" + ip, 60, 60000],
    submit:  ["s:" + ip, 12, 60000],
    register:["r:" + ip, 5, 60000],
  };
  const [key, limit, win] = rules[kind];
  if (!hitBucket(key, limit, win)) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "طلبات كثيرة — جرّب بعد شوي" }));
    return false;
  }
  return true;
}

// ---------- http helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, SECURITY_HEADERS));
  res.end(b);
}
function sendFile(res, file) {
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) { sendJson(res, 404, { error: "not found" }); return; }
    res.writeHead(200, Object.assign({ "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=300" }, SECURITY_HEADERS));
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

// ---------- submit validation (server-authoritative scoring) ----------
function validateSubmit(body) {
  const total = body.total;
  if (!GAME_TOTALS.includes(total)) return "عدد أسئلة غير صالح";
  if (!isInt(body.correct, 0, total)) return "عدد إجابات غير صالح";
  if (!isInt(body.score, 0, MAX_SCORE_PER_CORRECT * total)) return "نتيجة غير صالحة";
  if (body.correct === 0) {
    if (body.score !== 0) return "نتيجة غير صالحة";
  } else {
    if (body.score < MIN_SCORE_PER_CORRECT * body.correct) return "نتيجة غير صالحة";
    if (body.score > MAX_SCORE_PER_CORRECT * body.correct) return "نتيجة غير صالحة";
  }
  const earned = body.coinsEarned == null ? 0 : body.coinsEarned;
  if (!isInt(earned, COINS_PER_CORRECT * body.correct, COINS_PER_CORRECT * body.correct + MAX_BONUS_COINS))
    return "كوينز غير صالحة";
  const spent = body.coinsSpent == null ? 0 : body.coinsSpent;
  if (!isInt(spent, 0, MAX_SPEND_PER_QUESTION * total) || spent % 5 !== 0)
    return "مصروف غير صالح";
  if (body.durationMs != null) {
    if (!isInt(body.durationMs, MIN_MS_PER_QUESTION * total, MAX_MS_PER_QUESTION * total))
      return "مدة مباراة غير صالحة";
  }
  return null;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const isWrite = req.method === "POST";
  if (!rateLimit(req, res, "general")) return;
  if (isWrite && !rateLimit(req, res, "write")) return;

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
    if (!rateLimit(req, res, "register")) return;
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 400, { error: "اكتب اسمك" });
    if (p === "/api/register") {
      if (Object.keys(db.players).length >= MAX_PLAYERS)
        return sendJson(res, 503, { error: "وصلنا الحد الأقصى من اللاعبين" });
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
    if (!rateLimit(req, res, "submit")) return;
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    const err = validateSubmit(body);
    if (err) return sendJson(res, 400, { error: err });
    // One real game takes >= ~8 seconds; reject back-to-back submits.
    const now = Date.now();
    if (pl.lastSubmitAt && now - pl.lastSubmitAt < 8000)
      return sendJson(res, 429, { error: "استنى شوي قبل المباراة التالية" });
    pl.lastSubmitAt = now;
    const earned = body.coinsEarned == null ? 0 : body.coinsEarned;
    const spent = body.coinsSpent == null ? 0 : body.coinsSpent;
    ensureMonth(pl);
    pl.score += body.score;
    pl.monthlyScore += body.score;
    pl.monthlyGames += 1;
    pl.games += 1;
    // Server-authoritative coins: client "coins" field is IGNORED.
    pl.coins = Math.max(0, pl.coins + earned - spent);
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && p === "/api/sync") {
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود" });
    // Coins are NEVER accepted from the client anymore (server-authoritative).
    // Inventory: only DECREASES are accepted (using an item inside a match).
    if (body.inv && typeof body.inv === "object") {
      for (const k of ["life", "hint", "retry", "time", "skip"]) {
        const v = body.inv[k];
        if (isInt(v, 0, 999) && v <= (pl.inv[k] || 0)) pl.inv[k] = v;
      }
      // noads is only ever set by /api/shop/buy — never by sync.
    }
    // Titles can never be granted via sync — purchases happen only through
    // /api/shop/buy. Here we only sanitise the server-owned list.
    pl.titles = (pl.titles || []).filter((t) => TITLES.includes(t));
    if (body.activeTitleId === null || (typeof body.activeTitleId === "string" && pl.titles.includes(body.activeTitleId)))
      pl.activeTitleId = body.activeTitleId;
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl) });
  }
  if (req.method === "POST" && p === "/api/shop/buy") {
    const body = await readBody(req);
    const pl = db.players[body.playerId || ""];
    if (!pl) return sendJson(res, 404, { error: "لاعب غير موجود — سجّل من جديد" });
    const item = String(body.item || "");
    // Titles: "title:<id>" — price list is server-side only.
    if (item.startsWith("title:")) {
      const tid = item.slice(6);
      if (!TITLES.includes(tid)) return sendJson(res, 400, { error: "لقب غير معروف" });
      if (pl.titles.includes(tid)) return sendJson(res, 400, { error: "اللقب عندك من قبل ✓" });
      const price = TITLE_PRICES[tid];
      if (pl.coins < price) return sendJson(res, 400, { error: "كوينزك ما بتكفي — بدك " + price + " وعندك " + pl.coins });
      pl.coins -= price;
      pl.titles.push(tid);
      pl.activeTitleId = tid;
      saveDb(db);
      return sendJson(res, 200, { player: pub(pl), bought: item });
    }
    const shopItem = SHOP[item];
    if (!shopItem) return sendJson(res, 400, { error: "عنصر غير معروف" });
    if (item === "noads" && pl.inv.noads) return sendJson(res, 400, { error: "مفعّلة عندك من قبل ✓" });
    if (pl.coins < shopItem.price) return sendJson(res, 400, { error: "كوينزك ما بتكفي — بدك " + shopItem.price + " وعندك " + pl.coins });
    pl.coins -= shopItem.price;
    if (item === "noads") pl.inv.noads = true;
    else pl.inv[item] = (pl.inv[item] || 0) + 1;
    saveDb(db);
    return sendJson(res, 200, { player: pub(pl), bought: item });
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
    if (!res.headersSent) {
      if (e.message === "bad json" || e.message === "body too large")
        sendJson(res, 400, { error: "بيانات غير صالحة" });
      else sendJson(res, 500, { error: "server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`تحدي الكرة العالمية — server v2 running on http://${HOST}:${PORT} (month ${monthKey()}, players ${Object.keys(db.players).length})`);
});
