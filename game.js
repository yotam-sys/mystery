// Mystery Player — game logic.
// Sections: 1 config · 2 name matching · 3 state · 4 Firebase sync · 5 host loop · 6 actions · 7 screens

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, update, get, remove, onValue, onDisconnect, serverTimestamp, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { MYSTERY, ALL_NAMES } from "./players.js";

// ============ 1. CONFIG ============
const firebaseConfig = {
  apiKey: "AIzaSyAIHK5B4j3Ce0ZM9lWVNa_e71reQSsWGLw",
  authDomain: "nba1-4cb83.firebaseapp.com",
  databaseURL: "https://nba1-4cb83-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "nba1-4cb83",
  storageBucket: "nba1-4cb83.firebasestorage.app",
  messagingSenderId: "44817531262",
  appId: "1:44817531262:web:18eeb3807bdeded2a2732f",
  measurementId: "G-LW9BVZ2C49"
};

const CLUE_MS = 7000;        // time between clues
const GRACE_MS = 8000;       // time after the last clue
const REVEAL_MS = 10000;     // time on the answer screen
const HOST_TIMEOUT = 4000;   // how long the host can be offline before someone takes over
const COLORS = ["#FF7A1A", "#3BE38F", "#4FB6FF", "#FF5DB1", "#FFC23D", "#B38CFF", "#5EF0E0", "#FF8F8F"];
const REACTIONS = ["🔥", "😂", "😱", "👏", "🧱"];
const DIFFS = { easy: "Famous", mix: "Mix", hard: "Real fans" };
const pts = clue => (6 - clue) * 100;

// ============ 2. NAME MATCHING ============
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const SUFFIX = /^(jr|sr|ii|iii|iv)$/;
function wordsOf(name) {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[\s-]+/)
    .map(w => w.replace(/[^a-z0-9]/g, "")).filter(w => w && !SUFFIX.test(w));
}

// Every guessable player: mystery players first (they carry aliases), then the extra names.
const ENTRIES = [];
const seen = new Set();
function addEntry(name, idx, alias) {
  const key = norm(name);
  if (seen.has(key)) return;
  seen.add(key);
  const words = wordsOf(name);
  ENTRIES.push({ name, idx, keys: [key, ...alias.map(norm)], words, first: words[0], last: words[words.length - 1] });
}
MYSTERY.forEach((p, i) => addEntry(p.name, i, p.alias));
ALL_NAMES.forEach(n => addEntry(n, -1, []));
ENTRIES.sort((a, b) => a.name.localeCompare(b.name));

// Typo distance (Damerau-Levenshtein, optimal string alignment).
function dist(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const sim = (a, b) => 1 - dist(a, b) / Math.max(a.length, b.length);

// Exact matches: full name, nickname, then unique-ish last or first name.
function exactMatches(input) {
  const g = norm(input);
  if (!g) return [];
  const full = ENTRIES.filter(e => e.keys.includes(g));
  if (full.length) return full;
  const byLast = ENTRIES.filter(e => e.last === g);
  if (byLast.length) return byLast;
  return ENTRIES.filter(e => e.first === g);
}
// Close matches for typos, best first.
function fuzzyMatches(input, limit = 3) {
  const g = norm(input);
  if (g.length < 3) return [];
  const scored = ENTRIES.map(e => {
    let s = Math.max(...e.keys.map(k => sim(g, k)));
    s = Math.max(s, sim(g, e.last) - 0.04);
    if (e.keys.some(k => k.startsWith(g)) && g.length >= 4) s = Math.max(s, 0.9);
    return { e, s };
  }).filter(x => x.s >= 0.66).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(x => x.e);
}
// Live suggestions while typing.
function suggestions(input, limit = 6) {
  const raw = (input || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const g = norm(raw), toks = raw.split(/\s+/).map(norm).filter(Boolean);
  if (g.length < 2) return [];
  const ranked = [];
  for (const e of ENTRIES) {
    let r = -1;
    if (e.keys[0].startsWith(g)) r = 0;
    else if (toks.length && toks.every(t => e.words.some(w => w.startsWith(t)))) r = 1;
    else if (e.keys.slice(1).some(k => k.startsWith(g))) r = 2;
    if (r >= 0) ranked.push({ e, r });
  }
  ranked.sort((a, b) => a.r - b.r || a.e.name.localeCompare(b.e.name));
  if (ranked.length) return ranked.slice(0, limit).map(x => x.e);
  return g.length >= 4 ? fuzzyMatches(input, 4) : [];
}

// ============ 3. STATE ============
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
let myId = store.get("mp-id");
if (!myId) { myId = "p" + Math.random().toString(36).slice(2, 10); store.set("mp-id", myId); }
const me = { name: store.get("mp-name") || "", color: store.get("mp-color") || COLORS[Math.floor(Math.random() * COLORS.length)] };
store.set("mp-color", me.color);

let mode = "home";          // home | solo | online
let code = null;            // current game code
let homeMsg = "";
let net = "off";            // on | connecting | off
let offset = 0;             // server clock minus local clock
let rejoining = false;
// The game as everyone sees it. Online it mirrors Firebase; solo it lives here.
let game = { host: null, g: null, players: {}, exists: false, loaded: false };
const now = () => Date.now() + (mode === "online" ? offset : 0);

// ============ 4. FIREBASE SYNC ============
const configured = /^https:\/\//.test(firebaseConfig.databaseURL || "");
let db = null;
if (configured) {
  try {
    db = getDatabase(initializeApp(firebaseConfig));
    net = "connecting";
    onValue(ref(db, ".info/connected"), s => {
      net = s.val() ? "on" : "connecting";
      if (s.val() && mode === "online" && code) armPresence();   // came back online: mark me online again
      schedule();
    });
    onValue(ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; });
  } catch (e) { console.error(e); db = null; net = "off"; }
}
const path = (...p) => ["games", code, ...p].join("/");
let unsubs = [];

function listen() {
  stopListening();
  game = { host: null, g: null, players: {}, exists: false, loaded: false };
  unsubs.push(onValue(ref(db, path()), s => {
    const v = s.val();
    game.exists = !!v;
    game.loaded = true;
    game.host = v ? v.host : null;
    game.g = v ? v.g : null;
    game.players = (v && v.players) || {};
    onPlayersChanged();
    schedule();
  }));
}
function stopListening() { unsubs.forEach(u => u()); unsubs = []; }

// Marks me online, and makes Firebase mark me offline if I disconnect (closed tab, lost wifi).
function armPresence() {
  const onlineRef = ref(db, path("players", myId, "online"));
  onDisconnect(onlineRef).set(false).catch(() => {});
  set(onlineRef, true).catch(() => {});
}

// Writes go to Firebase online, or straight into `game` in solo.
function writeG(patch) {
  if (mode === "solo") { game.g = Object.assign({}, game.g, patch); schedule(); return; }
  update(ref(db, path("g")), patch).catch(console.error);
}
function writeMe(patch) {
  if (mode === "solo") { game.players[myId] = Object.assign({}, game.players[myId], patch); schedule(); return; }
  update(ref(db, path("players", myId)), patch).catch(console.error);
}

// ============ 5. HOST LOOP ============
// One device (the host) runs the clock. If the host disappears, the longest-connected player takes over.
const amHost = () => game.host === myId;
const playerList = () => Object.entries(game.players).filter(([, p]) => p && p.name)
  .map(([id, p]) => ({ id, ...p, online: p.online !== false || id === myId }))
  .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.id.localeCompare(b.id));
const activePlayers = () => playerList().filter(p => p.online);
const resultOf = (p, g, round) => (g && p && p.res && p.res.game === g.id && p.res.r) ? p.res.r["r" + round] || null : null;
const scoreOf = (p, g) => {
  if (!g || !p || !p.res || p.res.game !== g.id || !p.res.r) return 0;
  return Object.values(p.res.r).reduce((a, x) => a + (x && x.ok ? pts(x.c) : 0), 0);
};

let lastIssued = "";
function advance(patch) {                       // write each host transition only once
  const { at, ...rest } = patch;
  const key = JSON.stringify(rest) + (game.g && game.g.id);
  if (key === lastIssued) return;
  lastIssued = key;
  writeG(patch);
}
setInterval(() => {
  if (mode === "home" || !amHost() || !game.g) return;
  const g = game.g, t = now();
  if (g.phase === "round") {
    const active = activePlayers();
    const allDone = active.length > 0 && active.every(p => resultOf(p, g, g.round));
    if (allDone) advance({ phase: "reveal", at: t, round: g.round });
    else if (g.clue < 5 && t - g.at >= CLUE_MS) advance({ clue: g.clue + 1, at: t, round: g.round });
    else if (g.clue === 5 && t - g.at >= GRACE_MS) advance({ phase: "reveal", at: t, round: g.round });
  } else if (g.phase === "reveal" && t - g.at >= REVEAL_MS) {
    if (g.round < g.rounds - 1) advance({ phase: "round", round: g.round + 1, clue: 0, at: t });
    else advance({ phase: "final", at: t, round: g.round });
  }
}, 250);

// Host handoff.
let hostGoneSince = 0;
const seenReact = {};
function onPlayersChanged() {
  // reactions from others
  for (const p of playerList()) {
    if (p.react && p.react.t && seenReact[p.id] !== p.react.t) {
      const fresh = seenReact[p.id] !== undefined;
      seenReact[p.id] = p.react.t;
      if (fresh && REACTIONS.includes(p.react.e)) floatEmoji(p.react.e, p.name, p.color);
    }
  }
  if (mode !== "online" || !game.exists) return;
  const h = game.players[game.host];
  if (h && h.online !== false) { hostGoneSince = 0; return; }
  if (!hostGoneSince) { hostGoneSince = Date.now(); setTimeout(onPlayersChanged, HOST_TIMEOUT + 100); return; }
  if (Date.now() - hostGoneSince < HOST_TIMEOUT) return;
  const next = activePlayers()[0];
  if (next && next.id === myId) {
    const oldHost = game.host;
    runTransaction(ref(db, path("host")), cur => (cur === oldHost ? myId : undefined)).catch(() => {});
  }
}
setInterval(() => { if (mode === "online" && hostGoneSince) onPlayersChanged(); }, 1000);

// ============ 6. ACTIONS ============
function readName() {
  const v = (document.getElementById("nm").value || "").trim().slice(0, 16);
  if (!v) { homeMsg = "Type a name first."; paint(true); return null; }
  me.name = v; store.set("mp-name", v); return v;
}
function onlineOk() {
  if (db) return true;
  homeMsg = configured ? "Couldn't reach the game server. Check your internet." : "Online play isn't set up yet (see README).";
  paint(true); return false;
}
function newRound0(settings) {
  const pool = MYSTERY.map((p, i) => ({ p, i })).filter(x => settings.diff === "mix" || (settings.diff === "easy" ? x.p.d === 1 : x.p.d === 2));
  const order = pool.map(x => x.i).sort(() => Math.random() - 0.5).slice(0, settings.rounds);
  return { id: Math.random().toString(36).slice(2, 8), phase: "round", round: 0, clue: 0, at: now(), order,
           diff: settings.diff, rounds: order.length };
}
function startGame() {
  const g = game.g || {};
  lastIssued = "";
  writeG(newRound0({ diff: g.diff || "mix", rounds: g.rounds || 7 }));
}
function setSetting(k, v) { if (amHost()) writeG({ [k]: v }); }

function goSolo() {
  if (!readName()) return;
  mode = "solo"; code = "SOLO"; homeMsg = "";
  game = { host: myId, g: { phase: "lobby", diff: "mix", rounds: 7 }, players: { [myId]: { name: me.name, color: me.color, online: true, joinedAt: 1 } }, exists: true, loaded: true };
  paint(true);
}
async function goCreate() {
  if (!readName() || !onlineOk()) return;
  homeMsg = "Creating game…"; paint(true);
  try {
    let c = "";
    for (let i = 0; i < 6; i++) {
      c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
      if (!(await get(ref(db, "games/" + c + "/host"))).exists()) break;
    }
    code = c;
    await set(ref(db, path()), {
      host: myId, createdAt: serverTimestamp(), g: { phase: "lobby", diff: "mix", rounds: 7 },
      players: { [myId]: { name: me.name, color: me.color, online: true, joinedAt: serverTimestamp() } }
    });
    enterOnline();
  } catch (e) { console.error(e); code = null; homeMsg = "Couldn't create the game. Check the database rules."; paint(true); }
}
async function goJoin(codeInput, silent) {
  if (!silent && (!readName() || !onlineOk())) return;
  const c = (codeInput || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (c.length !== 4) { homeMsg = "Game codes have 4 letters."; paint(true); return; }
  try {
    const snap = await get(ref(db, "games/" + c));
    if (!snap.exists()) {
      store.set("mp-code", null); rejoining = false;
      homeMsg = silent ? "" : "No game with code " + c + ". Check it with your friend.";
      paint(true); return;
    }
    code = c;
    const mine = snap.val().players && snap.val().players[myId];
    if (mine) await update(ref(db, path("players", myId)), { name: me.name, color: me.color, online: true });
    else await set(ref(db, path("players", myId)), { name: me.name, color: me.color, online: true, joinedAt: serverTimestamp() });
    enterOnline();
  } catch (e) { console.error(e); rejoining = false; homeMsg = "Couldn't join. Check your connection."; paint(true); }
}
function enterOnline() {
  mode = "online"; homeMsg = ""; rejoining = false; lastIssued = "";
  store.set("mp-code", code);
  armPresence();
  listen();
  paint(true);
}
async function leave() {
  if (mode === "online" && db && code) {
    const others = activePlayers().filter(p => p.id !== myId);
    try {
      await onDisconnect(ref(db, path("players", myId, "online"))).cancel();
      if (amHost() && others.length === 0) await remove(ref(db, path()));
      else {
        if (amHost()) await set(ref(db, path("host")), others[0].id);
        await remove(ref(db, path("players", myId)));
      }
    } catch (e) { console.error(e); }
    stopListening();
  }
  store.set("mp-code", null);
  mode = "home"; code = null; homeMsg = "";
  game = { host: null, g: null, players: {}, exists: false, loaded: false };
  paint(true);
}
function shoot(entry) {
  const g = game.g;
  if (!g || g.phase !== "round") return;
  if (resultOf(game.players[myId], g, g.round)) return;
  const ok = entry.idx === g.order[g.round];
  const prev = (game.players[myId] && game.players[myId].res && game.players[myId].res.game === g.id) ? game.players[myId].res.r || {} : {};
  writeMe({ res: { game: g.id, r: Object.assign({}, prev, { ["r" + g.round]: { ok, c: g.clue, n: entry.name } }) } });
}
let lastReact = 0;
function react(e) {
  if (Date.now() - lastReact < 900) return;
  lastReact = Date.now();
  floatEmoji(e, me.name, me.color);
  if (mode === "online") { seenReact[myId] = undefined; writeMe({ react: { e, t: Date.now() } }); }
}

// ============ 7. SCREENS ============
const app = document.getElementById("app");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeColor = c => /^#[0-9A-Fa-f]{6}$/.test(c) ? c : "#888888";
let raf = 0, lastKey = "", lastClueShown = -1;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(false); }); }
setInterval(schedule, 200);

function currentView() {
  if (mode === "home") return rejoining ? "rejoin" : "home";
  if (mode === "online" && game.loaded && !game.exists) return "ended";
  if (!game.loaded) return "loading";
  const g = game.g;
  if (!g || g.phase === "lobby") return "lobby";
  return g.phase;
}

function paint(force) {
  const view = currentView(), g = game.g;
  const myRes = g ? resultOf(game.players[myId], g, g.round) : null;
  const key = [view, g && g.id, g && g.round, myRes ? 1 : 0, amHost() ? "h" : "", view === "home" ? net : "", view === "lobby" ? JSON.stringify([g && g.diff, g && g.rounds]) : ""].join("|");
  paintJumbo(view, g);
  if (force || key !== lastKey) { lastKey = key; build(view, g, myRes); }
  refresh(view, g, myRes);
}

function paintJumbo(view, g) {
  const c = document.getElementById("jClock"), l = document.getElementById("jLbl");
  if (view === "round") { c.textContent = "Q" + (g.round + 1) + " · " + pts(g.clue); l.textContent = "Points on the board"; }
  else if (view === "reveal") { c.textContent = "Q" + (g.round + 1) + " END"; l.textContent = "Round over"; }
  else if (view === "final") { c.textContent = "FINAL"; l.textContent = "Game over"; }
  else if (view === "lobby") { c.textContent = code || "--"; l.textContent = mode === "solo" ? "Practice" : "Game code"; }
  else { c.textContent = "--"; l.textContent = "Pregame"; }
}

function rosterHTML(g, how) {
  let list = playerList();
  if (how === "score") list = list.slice().sort((a, b) => scoreOf(b, g) - scoreOf(a, g));
  return list.map(p => {
    let st = "", cls = "";
    if (how === "score") st = scoreOf(p, g);
    else if (how === "round" || how === "reveal") {
      const x = resultOf(p, g, g.round);
      if (x) {
        cls = x.ok ? "ok" : "no";
        st = how === "reveal" ? (x.ok ? "+" + pts(x.c) + " · " + x.n : "✖ " + x.n) : (x.ok ? "✓ clue " + (x.c + 1) : "✖ locked");
      } else st = how === "reveal" ? "no guess" : (p.online ? "thinking…" : "offline");
    } else st = p.id === game.host ? "host" : (p.online ? "ready" : "offline");
    return '<div class="pl' + (p.id === myId ? " me" : "") + (p.online ? "" : " off") + '">' +
      '<span class="dot" style="background:' + safeColor(p.color) + '"></span>' +
      '<span class="nm">' + esc(String(p.name).slice(0, 16)) + (p.id === myId ? "<em>you</em>" : "") + (p.id === game.host && how !== "lobby" ? "<em>host</em>" : "") + '</span>' +
      '<span class="st ' + cls + '">' + esc(st) + '</span></div>';
  }).join("");
}
const reactBar = () => '<div class="reacts">' + REACTIONS.map(e => '<button type="button" class="react" data-e="' + e + '" aria-label="React ' + e + '">' + e + '</button>').join("") + '</div>';
function wireReacts() { app.querySelectorAll(".react").forEach(b => b.onclick = () => react(b.dataset.e)); }

function build(view, g, myRes) {
  if (view === "home" || view === "rejoin") {
    const status = net === "on" ? ["on", "Online ready"] : net === "connecting" ? ["", "Connecting…"] : ["off", configured ? "Online unavailable" : "Online not set up"];
    app.innerHTML = '<div class="panel">' +
      '<div class="status ' + status[0] + '"><i></i>' + status[1] + '</div>' +
      '<h2>Guess the NBA player before your friends do</h2>' +
      '<ol class="rules"><li>A clue about a secret NBA player appears <b>every 7 seconds</b>, starting with the hardest.</li><li>Guess right on clue 1 for <b>600</b> points, clue 6 for <b>100</b>.</li><li>You get <b>one guess per player</b>. A wrong guess locks you out of that round.</li><li>Over 500 players to guess from. Typos are fine: the game will ask what you meant.</li></ol>' +
      (rejoining ? '<p><b>Rejoining your last game…</b></p>' : '') +
      '<label class="fld">Your name<input type="text" id="nm" maxlength="16" autocomplete="off" value="' + esc(me.name) + '" placeholder="e.g. Yotam"></label>' +
      '<button class="btn" id="bCreate" type="button">Create game</button>' +
      '<div class="or">or join a friend</div>' +
      '<div class="row"><input type="text" class="code" id="cd" maxlength="4" autocomplete="off" placeholder="CODE" aria-label="Game code"><button class="btn ghost" id="bJoin" type="button">Join</button></div>' +
      '<div class="or">or</div>' +
      '<button class="btn ghost" id="bSolo" type="button">Solo practice</button>' +
      '<div class="err">' + esc(homeMsg) + '</div></div>';
    document.getElementById("bCreate").onclick = goCreate;
    document.getElementById("bJoin").onclick = () => goJoin(document.getElementById("cd").value);
    document.getElementById("bSolo").onclick = goSolo;
    document.getElementById("cd").addEventListener("keydown", e => { if (e.key === "Enter") goJoin(e.target.value); });
    return;
  }
  if (view === "loading") { app.innerHTML = '<div class="panel"><h2>Loading game…</h2></div>'; return; }
  if (view === "ended") {
    app.innerHTML = '<div class="panel"><div class="kicker">Game over</div><h2>This game has ended</h2><p>Everyone left, so the game was closed. Start a new one or join another code.</p><button class="btn" id="bLeave" type="button">Back to home</button></div>';
    document.getElementById("bLeave").onclick = leave; return;
  }
  if (view === "lobby") {
    const host = amHost(), d = (g && g.diff) || "mix", r = (g && g.rounds) || 7;
    const seg = (k, opts, cur) => '<div class="seg" role="group">' + opts.map(([v, label]) =>
      '<button type="button" class="' + (String(v) === String(cur) ? "on" : "") + '" data-k="' + k + '" data-v="' + v + '"' + (host ? "" : " disabled") + '>' + label + '</button>').join("") + '</div>';
    app.innerHTML = '<div class="panel"><div class="kicker">Lobby</div>' +
      (mode === "online" ? '<div class="codebox"><div class="kicker">Game code</div><div class="c">' + esc(code) + '</div><div class="kicker">Friends open the same link and type this code</div></div>' : '') +
      '<h2 id="lobbyH"></h2><div class="roster" id="roster"></div>' +
      '<div class="kicker">Players to guess</div>' + seg("diff", Object.entries(DIFFS), d) +
      '<div class="kicker">Rounds</div>' + seg("rounds", [[5, "5"], [7, "7"], [10, "10"]], r) +
      (host ? '<button class="btn" id="bStart" type="button">Tip off</button>' : '<p>The host picks the settings and starts the game.</p>') +
      '<button class="btn ghost" id="bLeave" type="button">Leave</button></div>';
    app.querySelectorAll(".seg button").forEach(b => b.onclick = () => setSetting(b.dataset.k, b.dataset.k === "rounds" ? Number(b.dataset.v) : b.dataset.v));
    if (host) document.getElementById("bStart").onclick = startGame;
    document.getElementById("bLeave").onclick = leave; return;
  }
  if (view === "round") {
    app.innerHTML = '<div class="panel">' +
      '<div class="worth"><div class="kicker">Mystery player ' + (g.round + 1) + ' of ' + g.rounds + ' · ' + esc(DIFFS[g.diff] || "Mix") + '</div><div>Worth <b id="worth"></b></div></div>' +
      '<div class="shot"><i id="shot"></i></div>' +
      '<ol class="clues" id="clues"></ol>' +
      (myRes ? '<div class="verdict ' + (myRes.ok ? "ok" : "no") + '">' + (myRes.ok ? "Bucket! +" + pts(myRes.c) : "Airball") + '<small>' + (myRes.ok ? "Waiting for the others…" : esc(myRes.n) + " isn't it. You're locked out this round.") + '</small></div>'
        : '<form class="guess" id="gform" autocomplete="off"><div class="ac"><input type="text" id="gs" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Type a player" aria-label="Your guess" role="combobox" aria-expanded="false" aria-controls="sug"><ul class="sug" id="sug" role="listbox" hidden></ul></div><button class="btn" type="submit">Shoot</button></form><div id="pick"></div>') +
      reactBar() + '<div class="kicker">On the court</div><div class="roster" id="roster"></div></div>';
    if (!myRes) wireGuess();
    wireReacts(); lastClueShown = -1; return;
  }
  if (view === "reveal") {
    const p = MYSTERY[g.order[g.round]];
    app.innerHTML = '<div class="panel"><div class="answer"><div class="kicker">Mystery player ' + (g.round + 1) + ' was</div><div class="who">' + esc(p.name) + '</div></div>' +
      '<ol class="clues">' + p.clues.map((c, i) => '<li' + (i > g.clue ? ' class="locked"' : '') + '><span class="n">' + (i + 1) + '</span><span>' + esc(c) + '</span></li>').join("") + '</ol>' +
      '<div class="kicker">Guesses</div><div class="roster" id="roster"></div>' +
      '<div class="kicker">Standings</div><div class="board" id="board"></div>' + reactBar() +
      '<div class="shot"><i id="shot"></i></div><p>' + (g.round < g.rounds - 1 ? "Next player coming up…" : "Final scores coming up…") + '</p></div>';
    wireReacts(); return;
  }
  if (view === "final") {
    app.innerHTML = '<div class="panel"><div class="kicker">Final buzzer</div><h2 id="champ"></h2><div class="board podium" id="board"></div>' + reactBar() +
      '<div class="kicker">The mystery players</div><p>' + g.order.map(i => esc(MYSTERY[i].name)).join(" · ") + '</p>' +
      (amHost() ? '<button class="btn" id="bAgain" type="button">Run it back</button><button class="btn ghost" id="bLobby" type="button">Change settings</button>' : '<p>The host can start a rematch.</p>') +
      '<button class="btn ghost" id="bLeave" type="button">Leave game</button></div>';
    if (amHost()) {
      document.getElementById("bAgain").onclick = startGame;
      document.getElementById("bLobby").onclick = () => writeG({ phase: "lobby" });
    }
    document.getElementById("bLeave").onclick = leave; wireReacts(); return;
  }
}

// Guess box: live suggestions, arrow keys, and "did you mean" on submit.
function wireGuess() {
  const inp = document.getElementById("gs"), list = document.getElementById("sug"), pick = document.getElementById("pick");
  let items = [], sel = -1;
  const show = () => {
    list.hidden = items.length === 0;
    inp.setAttribute("aria-expanded", String(!list.hidden));
    list.innerHTML = items.map((e, i) => '<li role="option" data-i="' + i + '" class="' + (i === sel ? "sel" : "") + '">' + esc(e.name) + '</li>').join("");
  };
  inp.addEventListener("input", () => { items = suggestions(inp.value); sel = -1; pick.innerHTML = ""; show(); });
  inp.addEventListener("keydown", e => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); show(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(-1, sel - 1); show(); e.preventDefault(); }
    else if (e.key === "Escape") { items = []; show(); }
    else if (e.key === "Enter" && sel >= 0) { inp.value = items[sel].name; items = []; show(); e.preventDefault(); }
  });
  list.addEventListener("pointerdown", e => {
    const li = e.target.closest("li"); if (!li) return;
    e.preventDefault();
    inp.value = items[+li.dataset.i].name; items = []; show(); inp.focus();
  });
  inp.addEventListener("blur", () => setTimeout(() => { items = []; show(); }, 150));
  document.getElementById("gform").onsubmit = e => {
    e.preventDefault();
    items = []; show();
    const val = inp.value.trim();
    if (!val) return;
    const exact = exactMatches(val);
    if (exact.length === 1) { shoot(exact[0]); return; }
    let options = exact.length ? exact : fuzzyMatches(val);
    const title = exact.length ? "Which one?" : options.length ? "Did you mean…" : "";
    if (!options.length) {
      pick.innerHTML = '<div class="err">No NBA player called "' + esc(val) + '". Check the spelling.</div>';
      const f = document.getElementById("gform"); f.classList.remove("shake"); void f.offsetWidth; f.classList.add("shake");
      return;
    }
    options = options.slice(0, 6);
    pick.innerHTML = '<div class="pick"><div class="kicker">' + title + '</div>' +
      options.map((o, i) => '<button type="button" class="opt" data-i="' + i + '">' + esc(o.name) + '</button>').join("") +
      '<div class="hint">Tapping a name shoots it.</div></div>';
    pick.querySelectorAll(".opt").forEach(b => b.onclick = () => shoot(options[+b.dataset.i]));
  };
  setTimeout(() => inp.focus({ preventScroll: true }), 30);
}

function refresh(view, g, myRes) {
  const ro = document.getElementById("roster"), bo = document.getElementById("board");
  if (view === "lobby") {
    if (ro) ro.innerHTML = rosterHTML(g, "lobby");
    const h = document.getElementById("lobbyH"), n = activePlayers().length;
    if (h) h.textContent = mode === "solo" ? "Solo practice" : n + (n === 1 ? " player in the gym" : " players in the gym");
  }
  if (view === "round") {
    if (ro) ro.innerHTML = rosterHTML(g, "round");
    const w = document.getElementById("worth"); if (w) w.textContent = myRes ? (myRes.ok ? pts(myRes.c) : 0) : pts(g.clue);
    const cl = document.getElementById("clues"), p = MYSTERY[g.order[g.round]];
    if (cl && lastClueShown !== g.clue) {
      cl.innerHTML = p.clues.slice(0, g.clue + 1).map((c, i) => '<li' + (i === g.clue && i > 0 ? ' class="new"' : '') + '><span class="n">' + (i + 1) + '</span><span>' + esc(c) + '</span></li>').join("") +
        (g.clue < 5 ? '<li class="locked"><span class="n">' + (g.clue + 2) + '</span><span>Next clue incoming…</span></li>' : '');
      lastClueShown = g.clue;
    }
    const sh = document.getElementById("shot");
    if (sh) sh.style.transform = "scaleX(" + Math.max(0, Math.min(1, (now() - g.at) / (g.clue < 5 ? CLUE_MS : GRACE_MS))) + ")";
  }
  if (view === "reveal") {
    if (ro) ro.innerHTML = rosterHTML(g, "reveal");
    if (bo) bo.innerHTML = rosterHTML(g, "score");
    const sh = document.getElementById("shot"); if (sh) sh.style.transform = "scaleX(" + Math.max(0, Math.min(1, (now() - g.at) / REVEAL_MS)) + ")";
  }
  if (view === "final") {
    if (bo) bo.innerHTML = rosterHTML(g, "score");
    const c = document.getElementById("champ");
    const list = playerList().sort((a, b) => scoreOf(b, g) - scoreOf(a, g));
    if (c && list[0]) c.textContent = list.length === 1 ? "You scored " + scoreOf(list[0], g) + " of " + g.rounds * 600 : String(list[0].name).slice(0, 16) + " wins it";
  }
}

function floatEmoji(e, name, color) {
  const el = document.createElement("div");
  el.className = "floater";
  el.style.left = (12 + Math.random() * 76) + "%";
  el.innerHTML = '<span class="fe">' + esc(e) + '</span><span class="fn" style="color:' + safeColor(color) + '">' + esc(String(name || "").slice(0, 16)) + '</span>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// Start: rejoin the last game after a refresh, if it still exists.
const savedCode = store.get("mp-code");
if (savedCode && db && me.name) { rejoining = true; goJoin(savedCode, true); }
paint(true);
