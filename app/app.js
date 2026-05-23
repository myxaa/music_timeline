/*
 * Music Timeline PWA.
 *
 * Three modes:
 *   1) Pass-and-play game on one device. State in localStorage.
 *   2) Multiplayer game across phones via WebRTC (PeerJS). The host
 *      runs audio + authoritative state; players send inputs and
 *      receive filtered state broadcasts so they can't peek at the
 *      answer before reveal.
 *   3) Free play — scan a printed QR or hit "random".
 *
 * Audio plays through a YouTube IFrame positioned off-screen so the
 * title and thumbnail never leak before the player reveals.
 */

// Resolved at call-time so it follows the current language.
function regionLabel(code) {
  return (typeof t === "function") ? t("region." + code) : code;
}

const STORAGE_KEY = "mt.game.v1";

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

let songs = [];                // full DB
let verifiedSongs = [];        // subset with youtube_id
let songsById = new Map();
let ytPlayer = null;           // game-mode hidden player
let freeYtPlayer = null;       // free-play hidden player
// (Live QR scanner state lives in _scanStream/_scanVideo/_scanLoop below.)

let game = null;               // current game state (or null)

// ─── Screens + URL routing ──────────────────────────────────────────────────
// Friendly hash slugs so a browser refresh lands the user on the same
// screen. Hash-only (no path changes) keeps GitHub Pages happy without
// needing a 404.html SPA fallback.
const SCREEN_TO_HASH = {
  home: "",
  gameSetup:     "new",
  passPhone:     "pass",
  gameTurn:      "play",
  gameReveal:    "reveal",
  gameOver:      "win",
  mpJoin:        "join",
  mpHostLobby:   "host",
  mpPlayerLobby: "lobby",
  mpTurn:        "mp-play",
  mpReveal:      "mp-reveal",
  mpOver:        "mp-win",
  scanner:       "scan",
  freePlayer:    "free",
  printScreen:   "print",
};
const HASH_TO_SCREEN = Object.fromEntries(
  Object.entries(SCREEN_TO_HASH).map(([k, v]) => [v, k])
);

function showScreen(name, opts) {
  // Safety net — never leave the app with nothing visible. If the caller
  // passed an unknown screen id (e.g. a stale URL hash from a previous
  // version, or an unhandled popstate target), fall back to home.
  const screens = $$(".screen");
  if (!screens.some((s) => s.id === name)) name = "home";
  screens.forEach((s) => s.classList.toggle("active", s.id === name));
  if (name !== "scanner") stopScanner();
  if (name !== "gameTurn") {
    // pause the game player when leaving the turn screen, but don't destroy it
    if (ytPlayer && ytPlayer.pauseVideo) try { ytPlayer.pauseVideo(); } catch {}
  }
  if (name !== "freePlayer") {
    if (freeYtPlayer && freeYtPlayer.stopVideo) try { freeYtPlayer.stopVideo(); } catch {}
  }
  // Sync the URL hash unless this call is itself a reaction to back/forward
  // navigation (opts.fromPop) — pushing the same state again would otherwise
  // pile up duplicate history entries.
  if (!(opts && opts.fromPop)) syncRouteFromScreen(name);
}

function syncRouteFromScreen(name) {
  const target = SCREEN_TO_HASH[name];
  if (target === undefined) return;
  const currentSlug = (location.hash || "").replace(/^#/, "");
  if (currentSlug === target) return;
  const newUrl = target
    ? "#" + target
    : location.pathname + location.search;
  try {
    history.pushState({ screen: name }, "", newUrl);
  } catch {
    // pushState can throw on file:// or in some sandboxed contexts;
    // fall back to the assignment, which still updates the bar.
    if (target) location.hash = target;
  }
}

// Belt-and-suspenders: when the page is shown (initial load, tab switch,
// back-forward cache restore), make sure something is visible.
window.addEventListener("pageshow", () => {
  const anyActive = $$(".screen").some((s) => s.classList.contains("active"));
  if (!anyActive) showScreen("home");
});

// Browser back/forward — re-derive the screen from the URL.
//
// If the user back-swipes past every pushState entry (which on Firefox
// Mobile PWA can briefly show a blank white screen before the app exits),
// rewrite the URL to a clean home state so the next interaction starts
// from a known-good place rather than a stale unknown hash.
window.addEventListener("popstate", () => {
  const slug = (location.hash || "").replace(/^#/, "");
  const target = HASH_TO_SCREEN[slug];
  if (!target || target === "home") {
    // Rewrite history so the bar matches what we're about to show.
    try {
      history.replaceState({ screen: "home" }, "",
        location.pathname + location.search);
    } catch {}
    showScreen("home", { fromPop: true });
    return;
  }
  showScreen(target, { fromPop: true });
});

// On a fresh load, dispatch the URL hash to the right setup function.
// Most screens are "just show it", but a few need state plumbing first
// (openSetup primes the new-game form; printScreen needs its summary
// rendered; game-phase screens need a saved game to be meaningful).
function openRoutedScreen(name) {
  switch (name) {
    case "gameSetup":
      openSetup();
      return true;
    case "scanner":
      // Don't auto-start the camera — user gesture is required on mobile.
      showScreen("scanner");
      return true;
    case "printScreen":
      renderPrintScreen();
      showScreen("printScreen");
      return true;
    case "mpJoin":
      showScreen("mpJoin");
      return true;
    case "gameTurn":
    case "gameReveal":
    case "gameOver":
    case "passPhone": {
      const saved = loadGameFromStorage();
      if (saved && saved.phase !== "over") {
        resumeGame();
        return true;
      }
      return false;
    }
    case "mpHostLobby":
    case "mpTurn":
    case "mpReveal":
    case "mpOver": {
      const hostSaved = loadMpSaved("host");
      if (hostSaved && hostSaved.phase !== "over") {
        resumeHostedGame();
        return true;
      }
      return false;
    }
    case "mpPlayerLobby": {
      const playerSaved = loadMpSaved("player");
      if (playerSaved && playerSaved.phase !== "over") {
        resumePlayerGame();
        return true;
      }
      return false;
    }
    case "freePlayer":
      // Free-play needs a song; without ?id=… we can't recover, so let the
      // caller fall through to home.
      return false;
    case "home":
      showScreen("home");
      return true;
    default:
      return false;
  }
}

// ─── Songs ──────────────────────────────────────────────────────────────────
async function loadSongs() {
  const res = await fetch("../data/songs.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Failed to load songs.json");
  songs = await res.json();
  songsById = new Map(songs.map((s) => [s.id, s]));
  verifiedSongs = songs.filter((s) => s.youtube_id);
  $("#dbStatus").textContent = t("home.dbStatus", { n: songs.length, v: verifiedSongs.length });
}

// ─── YouTube IFrame loader (shared) ─────────────────────────────────────────
let ytApiPromise = null;
function loadYouTubeAPI() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

function makePlayer(divId, onStateChange) {
  return new Promise((resolve) => {
    const p = new YT.Player(divId, {
      width: "200",
      height: "120",
      playerVars: {
        autoplay: 1, controls: 0, disablekb: 1,
        modestbranding: 1, playsinline: 1, rel: 0, iv_load_policy: 3,
      },
      events: {
        onReady:        () => resolve(p),
        onStateChange:  onStateChange || (() => {}),
        onError:        (e) => console.warn("YT error", e),
      },
    });
  });
}

// ─── Pass-and-play game ─────────────────────────────────────────────────────
function newGameState({ playerNames, targetScore, regions }) {
  return {
    players: playerNames.map((name) => ({ name, timeline: [] })),
    targetScore,
    regions,
    used: [],            // song ids consumed (no repeats)
    turnIdx: 0,
    currentSong: null,
    selectedSlot: null,  // 0..timeline.length
    phase: "draw",       // "draw" | "place" | "reveal" | "over"
    winner: null,
    startedAt: Date.now(),
  };
}

function saveGame() {
  if (game) localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
}
function loadGameFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSavedGame() { localStorage.removeItem(STORAGE_KEY); }

function pickNextSong() {
  const pool = verifiedSongs.filter(
    (s) => game.regions.includes(s.region) && !game.used.includes(s.id)
  );
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function startGame(opts) {
  game = newGameState(opts);
  saveGame();
  await ensureGamePlayer();
  await drawForCurrentPlayer();
}

async function ensureGamePlayer() {
  if (ytPlayer) return ytPlayer;
  await loadYouTubeAPI();
  ytPlayer = await makePlayer("yt", onGamePlayerStateChange);
  return ytPlayer;
}

function onGamePlayerStateChange(e) {
  const playing = e.data === YT.PlayerState.PLAYING;
  setPlayIcon($("#playPauseBtn"), playing);
  setPlayIcon($("#playPauseInlineBtn"), playing);
  const wf = $("#gameWaveform");
  if (wf) wf.classList.toggle("paused", !playing);
}

// SVG glyphs for play/pause — keep them tiny inline rather than fetching.
const PAUSE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
const PLAY_SVG  = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const PAUSE_SVG_LG = '<svg width="20" height="20" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
const PLAY_SVG_LG  = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';

function setPlayIcon(btn, playing) {
  if (!btn) return;
  const lg = btn.classList.contains("play-btn");
  btn.innerHTML = playing
    ? (lg ? PAUSE_SVG_LG : PAUSE_SVG)
    : (lg ? PLAY_SVG_LG  : PLAY_SVG);
}

async function drawForCurrentPlayer() {
  const song = pickNextSong();
  if (!song) {
    // Pool exhausted — declare highest score the winner.
    finishGame();
    return;
  }
  game.currentSong = song;
  game.selectedSlot = null;
  game.phase = "place";
  game.used.push(song.id);
  saveGame();
  renderTurn();
  if (ytPlayer && ytPlayer.loadVideoById) {
    try { ytPlayer.loadVideoById({ videoId: song.youtube_id }); } catch {}
    try { ytPlayer.unMute(); ytPlayer.setVolume(80); } catch {}
  }
}

function renderTurn() {
  const me = game.players[game.turnIdx];
  $("#turnPlayerName").textContent = me.name;
  $("#turnPlayerScore").textContent = me.timeline.length;
  $("#turnPlayerTarget").textContent = game.targetScore;
  $("#lockInBtn").disabled = game.selectedSlot === null;
  $("#placementHint").textContent = describePlacement();

  const tl = $("#timeline");
  tl.innerHTML = "";
  const cards = me.timeline; // already sorted by year (we keep it sorted)

  if (cards.length === 0) {
    // Empty timeline → single "anywhere" slot, always correct.
    tl.appendChild(makeSlotEl(0, t("game.slot.empty")));
    return;
  }

  // Slot before first
  tl.appendChild(makeSlotEl(0, t("game.slot.before", { year: cards[0].year })));
  for (let i = 0; i < cards.length; i++) {
    tl.appendChild(makeCardEl(cards[i]));
    const label = i < cards.length - 1
      ? t("game.slot.between", { y1: cards[i].year, y2: cards[i + 1].year })
      : t("game.slot.after", { year: cards[i].year });
    tl.appendChild(makeSlotEl(i + 1, label));
  }
}

function makeSlotEl(index, label) {
  // Keep `label` for screen readers; the visible text follows the mockup
  // ("TAP TO PLACE" / "PLACE HERE" with an arrow), while the descriptive
  // placement string ("Before 1985", etc.) appears in #placementHint.
  const el = document.createElement("button");
  el.type = "button";
  const active = game.selectedSlot === index;
  el.className = "slot" + (active ? " selected" : "");
  el.dataset.slot = index;
  el.setAttribute("aria-label", label);
  el.innerHTML = slotInnerHTML(active);
  el.addEventListener("click", () => {
    game.selectedSlot = index;
    saveGame();
    renderTurn();
  });
  return el;
}

function makeCardEl(card) {
  const el = document.createElement("div");
  el.className = "tlcard";
  if (card.region) el.dataset.region = card.region;
  el.innerHTML = `
    <div class="y">${card.year}</div>
    <div class="divider-v"></div>
    <div class="meta">
      <strong>${escapeHtml(card.title || "—")}</strong>
      <span>${escapeHtml(card.artist || " ")}</span>
    </div>
    <div class="dot"></div>`;
  return el;
}

// Inner HTML for a timeline slot button. Matches the mockup's two states.
function slotInnerHTML(active) {
  if (active) {
    return (
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">'
      + '<path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>'
      + '<span>PLACE HERE</span>'
    );
  }
  return '<span>TAP TO PLACE</span>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function describePlacement() {
  if (game.selectedSlot === null) return t("game.pickSlot");
  const cards = game.players[game.turnIdx].timeline;
  if (cards.length === 0) return t("game.anywhereFirst");
  const i = game.selectedSlot;
  if (i === 0) return t("game.thinkBefore", { year: cards[0].year });
  if (i === cards.length) return t("game.thinkAfter", { year: cards[cards.length - 1].year });
  return t("game.thinkBetween", { y1: cards[i - 1].year, y2: cards[i].year });
}

function revealAndScore() {
  if (game.selectedSlot === null || !game.currentSong) return;
  // Music keeps playing through the reveal screen.

  const me = game.players[game.turnIdx];
  const tl = me.timeline;
  const i = game.selectedSlot;
  const y = game.currentSong.year;

  // Correct if the chosen slot is consistent with chronological order.
  // We allow ties on either side (same year is fine).
  let correct;
  if (tl.length === 0) {
    correct = true;
  } else if (i === 0) {
    correct = y <= tl[0].year;
  } else if (i === tl.length) {
    correct = y >= tl[tl.length - 1].year;
  } else {
    correct = y >= tl[i - 1].year && y <= tl[i].year;
  }

  if (correct) {
    tl.splice(i, 0, {
      id: game.currentSong.id,
      year: y,
      artist: game.currentSong.artist,
      title: game.currentSong.title,
      region: game.currentSong.region,
    });
    // keep sorted (in case of ties the splice spot was equal — order doesn't matter)
    tl.sort((a, b) => a.year - b.year);
  }

  game.phase = "reveal";
  game.lastCorrect = correct;
  saveGame();

  // Render reveal screen.
  $("#revealYear").textContent = y;
  $("#revealArtist").textContent = game.currentSong.artist;
  $("#revealTitle").textContent  = game.currentSong.title;
  $("#revealRegion").textContent = regionLabel(game.currentSong.region);
  // Result line is replaced by the CORRECT/MISSED stamp overlay; keep the
  // element empty so the screen layout stays the same.
  const rr = $("#revealResult");
  rr.textContent = "";
  rr.classList.remove("good", "bad");

  // Win condition?
  if (me.timeline.length >= game.targetScore) {
    game.winner = me.name;
    game.phase = "over";
    saveGame();
  }

  // Continue button label reflects outcome.
  const cont = $("#continueBtn");
  cont.textContent = correct
    ? t("game.keepCardN", { n: me.timeline.length, target: game.targetScore })
    : t("game.passNext");

  showScreen("gameReveal");
  slapStamp($(".reveal-stage", $("#gameReveal")), correct);
}

// Drop the CORRECT / MISSED ink stamp on top of the given container after
// a short delay so it lands AFTER the card flip-in animation completes.
function slapStamp(container, correct) {
  if (!container) return;
  container.querySelectorAll(".inkstamp").forEach((el) => el.remove());
  setTimeout(() => {
    const st = document.createElement("div");
    st.className = "inkstamp " + (correct ? "good" : "bad");
    st.innerHTML =
      '<div class="label">' + (correct ? "CORRECT" : "MISSED") + '</div>' +
      '<div class="sub">' + (correct ? "+1 CARD" : "PASS PHONE") + '</div>';
    container.appendChild(st);
  }, 600);
}

function continueToNextTurn() {
  if (game.phase === "over") {
    finishGame();
    return;
  }
  game.turnIdx = (game.turnIdx + 1) % game.players.length;
  game.phase = "draw";
  game.selectedSlot = null;
  game.currentSong = null;
  // Stop the previous song before the next player picks up the phone.
  if (ytPlayer && ytPlayer.stopVideo) try { ytPlayer.stopVideo(); } catch {}
  saveGame();
  showPassThenDraw();
}

function finishGame() {
  game.phase = "over";
  if (!game.winner) {
    // Triggered by pool exhaustion — pick highest score (ties → first wins).
    let best = -1, name = t("game.nobody");
    for (const p of game.players) {
      if (p.timeline.length > best) { best = p.timeline.length; name = p.name; }
    }
    game.winner = name;
  }
  saveGame();
  const winner = game.players.find((p) => p.name === game.winner) || game.players[0];
  renderWinnerStack({
    nameEl: $("#winnerName"),
    crownEl: $("#winnerCrown"),
    tallyEl: $("#winnerTally"),
    tickerEl: $("#finalScores"),
    name: winner.name,
    timeline: winner.timeline,
  });
  showScreen("gameOver");
}

// Mockup-faithful winner panel: crown + big italic name + year-chip ticker.
function renderWinnerStack({ nameEl, crownEl, tallyEl, tickerEl, name, timeline }) {
  nameEl.textContent = name;
  crownEl.innerHTML = CROWN_SVG;
  tallyEl.textContent = t("game.winnerCards", { n: timeline.length });
  tickerEl.innerHTML = "";
  for (const c of timeline.slice(0, 10)) {
    const chip = document.createElement("div");
    chip.className = "yc";
    chip.textContent = c.year;
    tickerEl.appendChild(chip);
  }
}

// Crown — pixel-faithful port of the SVG in screens-2.jsx WinScreen.
const CROWN_SVG = (
  '<svg width="200" height="120" viewBox="0 0 200 120" style="position:absolute;top:-78px;left:50%;transform:translateX(-50%);pointer-events:none">'
  + '<defs><radialGradient id="gem-a" cx="50%" cy="40%" r="60%">'
  + '<stop offset="0%" stop-color="var(--accent)" stop-opacity="1"/>'
  + '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.4"/>'
  + '</radialGradient></defs>'
  + '<path d="M30 95 L 35 50 L 60 78 L 80 30 L 100 70 L 120 30 L 140 78 L 165 50 L 170 95 Z" fill="var(--ink)" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>'
  + '<rect x="30" y="92" width="140" height="9" rx="2" fill="var(--ink)"/>'
  + '<circle cx="60" cy="96" r="3.5" fill="url(#gem-a)"/>'
  + '<circle cx="100" cy="96" r="4" fill="url(#gem-a)"/>'
  + '<circle cx="140" cy="96" r="3.5" fill="url(#gem-a)"/>'
  + '<circle cx="80" cy="28" r="5" fill="var(--accent)"/>'
  + '<circle cx="120" cy="28" r="5" fill="var(--accent)"/>'
  + '<circle cx="35" cy="48" r="4" fill="var(--accent)"/>'
  + '<circle cx="165" cy="48" r="4" fill="var(--accent)"/>'
  + '<circle cx="100" cy="68" r="4" fill="var(--accent)"/>'
  + '</svg>'
);

function quitGame() {
  if (!confirm(t("game.quitConfirm"))) return;
  clearSavedGame();
  game = null;
  if (ytPlayer && ytPlayer.stopVideo) try { ytPlayer.stopVideo(); } catch {}
  showScreen("home");
  refreshResumeButton();
}

// ─── Setup screen wiring ────────────────────────────────────────────────────
function renderPlayersList() {
  const list = $("#playersList");
  list.innerHTML = "";
  const names = setupState.players;
  names.forEach((name, idx) => {
    const initial = ((name || "").trim().charAt(0) || (idx + 1).toString()).toUpperCase();
    const color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <div class="avatar" style="background:${color}">${escapeHtml(initial)}</div>
      <input type="text" value="${escapeHtml(name)}" placeholder="Player ${idx + 1}" />
      <button class="del" aria-label="Remove">×</button>`;
    const input = row.querySelector("input");
    const avatar = row.querySelector(".avatar");
    input.addEventListener("input", () => {
      setupState.players[idx] = input.value;
      const ch = (input.value.trim().charAt(0) || (idx + 1).toString()).toUpperCase();
      avatar.textContent = ch;
    });
    row.querySelector(".del").addEventListener("click", () => {
      if (setupState.players.length <= 2) return;
      setupState.players.splice(idx, 1);
      renderPlayersList();
    });
    list.appendChild(row);
  });
  $("#addPlayerBtn").style.display = names.length >= 6 ? "none" : "";
}

const setupState = {
  players: [],
};

function openSetup() {
  setupState.players = [t("game.playerDefault", { n: 1 }), t("game.playerDefault", { n: 2 })];
  renderPlayersList();
  $("#targetScore").value = 10;
  updateTargetScoreLabel("targetScoreLabel", 10);
  $$("#regionGrid input").forEach((cb) => { cb.checked = true; });
  showScreen("gameSetup");
}

function updateTargetScoreLabel(elId, value) {
  // Render plain text — losing bold styling on the number, but works in every
  // script and is safe across translations whose grammar changes word order.
  const el = document.getElementById(elId);
  if (el) el.textContent = t("setup.targetScore", { n: value });
}

function readRegionsFromUI() {
  return $$("#regionGrid input:checked").map((cb) => cb.value);
}

async function onStartGameTap() {
  const playerNames = setupState.players.map((n) => n.trim()).filter(Boolean);
  if (playerNames.length < 2) {
    alert(t("setup.needTwo"));
    return;
  }
  const regions = readRegionsFromUI();
  if (regions.length === 0) {
    alert(t("setup.pickRegion"));
    return;
  }
  const targetScore = parseInt($("#targetScore").value, 10);
  if (verifiedSongs.filter((s) => regions.includes(s.region)).length < targetScore * playerNames.length) {
    if (!confirm(t("setup.lowSongs"))) return;
  }
  // Initialize state first so the pass screen knows who's up. Then show pass;
  // when the player taps "Start my turn" we draw + flip to gameTurn.
  game = newGameState({ playerNames, targetScore, regions });
  saveGame();
  showPassThenDraw();
}

// Single-device flow only — between turns and at game start, show the
// "pass the phone" interstitial so the next player has a moment to grab the
// device. Multiplayer phones don't need it (each phone is one player).
function showPassThenDraw() {
  renderPass();
  showScreen("passPhone");
}

function renderPass() {
  if (!game) return;
  const me = game.players[game.turnIdx];
  const color = PLAYER_COLORS[game.turnIdx % PLAYER_COLORS.length];
  const avatar = $("#passAvatar");
  avatar.textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  avatar.style.background = color;
  $("#passWho").textContent = me.name;
  $("#passProgress").textContent =
    `${me.timeline.length} / ${game.targetScore} ` +
    (game.targetScore === 1 ? "card" : "cards");
  const mini = $("#passMini");
  mini.innerHTML = "";
  if (!me.timeline.length) {
    const empty = document.createElement("div");
    empty.className = "mini-empty";
    empty.textContent = t("pass.noCards");
    mini.appendChild(empty);
  } else {
    for (const c of me.timeline) {
      const chip = document.createElement("div");
      chip.className = "year-chip";
      chip.textContent = c.year;
      mini.appendChild(chip);
    }
  }
  // Button label "I'm Mara — start my turn"
  $("#passStartLabel").textContent = t("pass.startWithName", { name: me.name });
}

const PLAYER_COLORS = [
  "#c9a04a", "#c84e2c", "#6b8e4e", "#a78bfa", "#5b8db8", "#d97b8e",
];

function refreshResumeButton() {
  const saved = loadGameFromStorage();
  $("#resumeBtn").classList.toggle("hidden", !saved || saved.phase === "over");
  const hostSaved = loadMpSaved("host");
  $("#resumeHostBtn").classList.toggle(
    "hidden", !hostSaved || hostSaved.phase === "over"
  );
  const playerSaved = loadMpSaved("player");
  $("#resumePlayerBtn").classList.toggle(
    "hidden", !playerSaved || playerSaved.phase === "over"
  );
}

async function resumeHostedGame() {
  const snap = loadMpSaved("host");
  if (!snap) return;
  startHosting(snap);
}

async function resumePlayerGame() {
  const snap = loadMpSaved("player");
  if (!snap) return;
  // Restore state visually first so the user sees their timeline; the
  // join handshake will refresh it from the (possibly new) host.
  mpGame = { ...snap, role: "player", peer: null, hostConn: null };
  renderMpScreen();
  joinAsPlayer({ code: snap.code, name: snap.myName || "Player", isResume: true });
}

async function resumeGame() {
  const saved = loadGameFromStorage();
  if (!saved) return;
  game = saved;
  if (game.phase === "over") {
    finishGame();
    return;
  }
  if (game.phase === "reveal") {
    showScreen("gameReveal");
    return;
  }
  if (game.phase === "place" && game.currentSong) {
    showScreen("gameTurn");
    await ensureGamePlayer();
    if (ytPlayer && ytPlayer.loadVideoById) {
      try { ytPlayer.loadVideoById({ videoId: game.currentSong.youtube_id }); } catch {}
    }
    renderTurn();
    return;
  }
  // phase === "draw" or anything else → show pass interstitial first.
  await ensureGamePlayer();
  showPassThenDraw();
}

// ─── Multiplayer (WebRTC via PeerJS) ────────────────────────────────────────
//
// Host's phone is the authoritative game state and the only one with audio.
// Players send inputs ("I picked slot N, reveal it") and receive filtered
// state broadcasts. The current song is *never* shipped to non-host phones
// until the reveal phase — otherwise players could peek at the answer in
// devtools.
//
// Peer IDs are 4-char codes prefixed with "mt-" to namespace within the
// PeerJS public cloud (avoiding global ID collisions with other apps).

const MP_PREFIX = "mt-";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no O/I — too easy to confuse
const MP_HOST_KEY = "mt.mp.host.v1";   // saved host game state
const MP_PLAYER_KEY = "mt.mp.player.v1"; // saved player mirror state
const MP_PLAYER_PEER_KEY = "mt.mp.peerId"; // stable per-device peer ID
const SAVE_TTL_MS = 30 * 60 * 1000;    // resume button shows for 30 min
const HOST_DEAD_AFTER_MS = 90 * 1000;  // after 90s no broadcast, election starts
const ELECTION_STEP_MS = 15 * 1000;    // each rank waits an extra 15s

let mpGame = null;     // { role, peer, ... } — populated on host or join
let mpYtPlayer = null; // host-only audio player (separate iframe)
let mpReconnectTimer = null;
let mpElectionTimer = null;

function randomCode(len = 4) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

function getStablePeerId() {
  // Random per-device ID so a player who reloads keeps the same peer
  // identity — lets the host recognise them as the same slot, and lets
  // the election algorithm produce stable rankings across reloads.
  let id = localStorage.getItem(MP_PLAYER_PEER_KEY);
  if (!id) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    id = MP_PREFIX + "p-" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(MP_PLAYER_PEER_KEY, id);
  }
  return id;
}

function saveMpState() {
  if (!mpGame) return;
  const snap = {
    savedAt: Date.now(),
    role: mpGame.role,
    code: mpGame.code,
    hostPeerId: mpGame.hostPeerId,
    myPeerId: mpGame.myPeerId,
    myName: mpGame.myName,
    targetScore: mpGame.targetScore,
    regions: mpGame.regions,
    used: mpGame.used,
    turnIdx: mpGame.turnIdx,
    phase: mpGame.phase,
    players: mpGame.players,
    // host-only: full current song; player-only: lastHostMsgAt
    currentSong: mpGame.currentSong || null,
    selectedSlot: mpGame.selectedSlot ?? null,
    lastCorrect: mpGame.lastCorrect ?? null,
    winner: mpGame.winner ?? null,
    revealedSong: mpGame.revealedSong || null,
    lastHostMsgAt: mpGame.lastHostMsgAt || null,
  };
  try {
    localStorage.setItem(
      mpGame.role === "host" ? MP_HOST_KEY : MP_PLAYER_KEY,
      JSON.stringify(snap)
    );
  } catch (e) {
    console.warn("save failed", e);
  }
}

function loadMpSaved(role) {
  const key = role === "host" ? MP_HOST_KEY : MP_PLAYER_KEY;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap.savedAt || Date.now() - snap.savedAt > SAVE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return snap;
  } catch { return null; }
}

function clearMpSaved(role) {
  localStorage.removeItem(role === "host" ? MP_HOST_KEY : MP_PLAYER_KEY);
}

function joinUrlFor(code) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("join", code);
  return u.toString();
}

function isLocalhost() {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function setupShareUI(code) {
  const url = joinUrlFor(code);

  // Display the URL as text only — not a navigable link.
  const linkEl = $("#mpShareLink");
  linkEl.textContent = url;
  linkEl.dataset.url = url;          // store for copy/share
  $("#mpShareLinkRow").classList.remove("hidden");

  // Render QR
  const canvas = $("#mpQrCanvas");
  if (window.QrCreator && canvas) {
    try {
      const ctx = canvas.getContext("2d");
      ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.QrCreator.render({
        text: url, radius: 0, ecLevel: "M",
        fill: "#000000", background: "#ffffff", size: 200,
      }, canvas);
      canvas.classList.remove("hidden");
    } catch (e) {
      console.warn("QR generation failed:", e);
    }
  }

  // Show native share button on phones
  if (navigator.share) $("#mpShareBtn").classList.remove("hidden");

  // When running on localhost the QR link can't be opened on other devices.
  // Show a small warning so the host knows to use the deployed URL instead.
  let warn = $("#mpLocalhostWarn");
  if (isLocalhost()) {
    if (!warn) {
      warn = document.createElement("p");
      warn.id = "mpLocalhostWarn";
      warn.className = "muted small localhost-warn";
      warn.textContent = "⚠ localhost — phones on your network can't open this link. Use the deployed URL instead, or access this page via your machine's LAN IP.";
      $("#mpShareLinkRow").insertAdjacentElement("afterend", warn);
    }
    warn.style.display = "";
  } else if (warn) {
    warn.style.display = "none";
  }
}

async function shareJoinUrl() {
  const url = $("#mpShareLink").dataset.url;
  if (!url) return;
  try {
    await navigator.share({
      title: t("home.title"),
      text: t("mp.host.share.text", { code: mpGame.code }),
      url,
    });
  } catch (e) {
    // user cancelled, ignore
  }
}

async function copyJoinUrl() {
  const url = $("#mpShareLink").dataset.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const btn = $("#mpCopyLinkBtn");
    const orig = btn.textContent;
    btn.textContent = t("mp.host.copied");
    setTimeout(() => { btn.textContent = orig; }, 1200);
  } catch {
    // clipboard API blocked (e.g., HTTP origin) — select-all so user can copy
    const input = $("#mpShareLink");
    input.focus();
    input.select();
  }
}

// ─── HOST ───
async function startHosting(resumeSnap = null) {
  // Use a stable peer ID for the host slot too so resume → same code.
  const code = resumeSnap?.code || randomCode();
  const peerId = MP_PREFIX + code;
  const peer = new Peer(peerId, { debug: 1 });

  if (resumeSnap) {
    mpGame = {
      role: "host",
      peer,
      code,
      myPeerId: peerId,
      hostPeerId: peerId,
      connections: new Map(),
      players: resumeSnap.players || [],
      targetScore: resumeSnap.targetScore || 10,
      regions: resumeSnap.regions || ["world", "ussr", "russia", "israel"],
      phase: resumeSnap.phase || "lobby",
      used: resumeSnap.used || [],
      turnIdx: resumeSnap.turnIdx || 0,
      currentSong: resumeSnap.currentSong || null,
      selectedSlot: resumeSnap.selectedSlot ?? null,
      lastCorrect: resumeSnap.lastCorrect ?? null,
      winner: resumeSnap.winner || null,
    };
  } else {
    mpGame = {
      role: "host",
      peer,
      code,
      myPeerId: peerId,
      hostPeerId: peerId,
      connections: new Map(),
      players: [],
      targetScore: 10,
      regions: ["world", "ussr", "russia", "israel"],
      phase: "lobby",
      used: [],
      turnIdx: 0,
      currentSong: null,
      selectedSlot: null,
      lastCorrect: null,
      winner: null,
    };
  }

  $("#mpHostCode").textContent = "…";
  showScreen("mpHostLobby");

  peer.on("open", async (id) => {
    $("#mpHostCode").textContent = code;
    if (resumeSnap) {
      // Resuming a saved game — host slot already in players list. If we're
      // mid-game, reload the current song so audio comes back.
      setupShareUI(code);
      if (mpGame.currentSong && (mpGame.phase === "place" || mpGame.phase === "reveal")) {
        await mpEnsureHostPlayer();
        try { mpYtPlayer.loadVideoById({ videoId: mpGame.currentSong.youtube_id }); } catch {}
      }
      renderMpScreen();
      mpBroadcast(); // anyone who reconnects will get fresh state
    } else {
      const hostName = prompt(t("mp.host.namePrompt"), t("mp.host.defaultName")) || t("mp.host.defaultName");
      mpGame.players.push({
        peerId: id,
        name: hostName,
        timeline: [],
        isHost: true,
      });
      setupShareUI(code);
      renderMpHostLobby();
      saveMpState();
    }
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      // ~1/500k odds even after collision-prone chars excluded, but handle it.
      alert(t("mp.host.codeTaken", { code }));
      peer.destroy();
      mpGame = null;
      startHosting();
      return;
    }
    console.warn("PeerJS host error:", err);
    alert(t("mp.host.connectionError", { msg: err.type || err.message || err }));
  });

  peer.on("connection", (conn) => {
    // A player connected. They'll send a 'join' message next.
    mpGame.connections.set(conn.peer, conn);
    conn.on("data", (msg) => handleMessageFromPlayer(conn, msg));
    conn.on("close", () => {
      mpGame.connections.delete(conn.peer);
      mpGame.players = mpGame.players.filter((p) => p.peerId !== conn.peer);
      renderMpHostLobby();
      mpBroadcast();
    });
    conn.on("error", (e) => console.warn("conn error", e));
  });
}

function handleMessageFromPlayer(conn, msg) {
  if (!mpGame || mpGame.role !== "host") return;
  switch (msg.type) {
    case "join": {
      const name = (msg.name || "Player").slice(0, 20);
      // Returning player? Match by stable peerId first, then by name (in
      // case they got a new peer ID for some reason). Either way, their
      // existing timeline + slot in turn order are preserved.
      let existing = mpGame.players.find((p) => p.peerId === conn.peer);
      if (!existing) {
        existing = mpGame.players.find(
          (p) => !p.isHost && p.name === name && !mpGame.connections.has(p.peerId)
        );
        if (existing) existing.peerId = conn.peer; // refresh ID
      }
      if (!existing) {
        mpGame.players.push({ peerId: conn.peer, name, timeline: [] });
      }
      renderMpHostLobby();
      renderMpScreen();
      mpBroadcast();
      break;
    }
    case "lockIn": {
      const cur = mpGame.players[mpGame.turnIdx];
      if (!cur || cur.peerId !== conn.peer) return;
      if (mpGame.phase !== "place") return;
      mpGame.selectedSlot = msg.slotIndex;
      mpRevealAndScore();
      break;
    }
  }
}

function mpBroadcast() {
  if (!mpGame || mpGame.role !== "host") return;
  const pub = mpPublicState(mpGame);
  for (const conn of mpGame.connections.values()) {
    try { conn.send({ type: "state", state: pub }); } catch (e) {
      console.warn("send failed", e);
    }
  }
  // Host's own UI re-renders directly from its full state.
  renderMpScreen();
  saveMpState();
}

function mpPublicState(g) {
  const inReveal = g.phase === "reveal" || g.phase === "over";
  return {
    code: g.code,
    phase: g.phase,
    players: g.players.map((p) => ({
      peerId: p.peerId,
      name: p.name,
      timeline: p.timeline,
      isHost: !!p.isHost,
    })),
    targetScore: g.targetScore,
    turnIdx: g.turnIdx,
    hostPeerId: g.hostPeerId,
    // Reveal the song only after lockIn. Until then players see only that
    // a turn is in progress; the host's phone plays the audio.
    revealedSong: inReveal && g.currentSong ? {
      year: g.currentSong.year,
      artist: g.currentSong.artist,
      title: g.currentSong.title,
      region: g.currentSong.region,
    } : null,
    lastCorrect: g.lastCorrect,
    winner: g.winner,
    // Sent to players so they can run an election + carry on as host if
    // the original host disappears. These don't leak the current song.
    regions: g.regions,
    used: g.used,
  };
}

async function mpStartGame() {
  if (mpGame.players.length < 2) {
    alert(t("setup.needTwo"));
    return;
  }
  mpGame.targetScore = parseInt($("#mpTargetScore").value, 10);
  mpGame.regions = $$("#mpRegionGrid input:checked").map((cb) => cb.value);
  if (mpGame.regions.length === 0) {
    alert(t("setup.pickRegion"));
    return;
  }
  await mpEnsureHostPlayer();
  await mpDrawNext();
}

function mpPickNextSong() {
  const pool = verifiedSongs.filter(
    (s) => mpGame.regions.includes(s.region) && !mpGame.used.includes(s.id)
  );
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function mpEnsureHostPlayer() {
  if (mpYtPlayer) return mpYtPlayer;
  await loadYouTubeAPI();
  mpYtPlayer = await makePlayer("mpYt", (e) => {
    const playing = e.data === YT.PlayerState.PLAYING;
    setPlayIcon($("#mpPlayPauseBtn"), playing);
    setPlayIcon($("#mpPlayPauseInlineBtn"), playing);
    const wf = $("#mpWaveform");
    if (wf) wf.classList.toggle("paused", !playing);
  });
  return mpYtPlayer;
}

async function mpDrawNext() {
  const song = mpPickNextSong();
  if (!song) { mpFinishGame(); return; }
  mpGame.currentSong = song;
  mpGame.selectedSlot = null;
  mpGame.lastCorrect = null;
  mpGame.phase = "place";
  mpGame.used.push(song.id);
  // Ensure we're on the turn screen even if we just promoted from the
  // election or are resuming from a fresh state.
  showScreen("mpTurn");
  mpBroadcast();
  if (mpYtPlayer && mpYtPlayer.loadVideoById) {
    try { mpYtPlayer.loadVideoById({ videoId: song.youtube_id }); } catch {}
    try { mpYtPlayer.unMute(); mpYtPlayer.setVolume(80); } catch {}
  }
}

function mpRevealAndScore() {
  if (mpGame.role !== "host") return;
  if (!mpGame.currentSong) return;
  // Don't pause — players keep listening to the song through the reveal
  // screen until the host advances to the next turn (which loads a new
  // video and naturally replaces the audio).

  const cur = mpGame.players[mpGame.turnIdx];
  const tl = cur.timeline;
  const i = mpGame.selectedSlot;
  const y = mpGame.currentSong.year;

  let correct;
  if (tl.length === 0)              correct = true;
  else if (i === 0)                 correct = y <= tl[0].year;
  else if (i === tl.length)         correct = y >= tl[tl.length - 1].year;
  else                              correct = y >= tl[i - 1].year && y <= tl[i].year;

  if (correct) {
    tl.splice(i, 0, {
      id: mpGame.currentSong.id,
      year: y,
      artist: mpGame.currentSong.artist,
      title: mpGame.currentSong.title,
      region: mpGame.currentSong.region,
    });
    tl.sort((a, b) => a.year - b.year);
  }

  mpGame.lastCorrect = correct;
  mpGame.phase = "reveal";

  if (cur.timeline.length >= mpGame.targetScore) {
    mpGame.winner = cur.name;
    mpGame.phase = "over";
  }
  mpBroadcast();
}

function mpContinue() {
  if (mpGame.role !== "host") return;
  if (mpGame.phase === "over") {
    mpFinishGame();
    return;
  }
  mpGame.turnIdx = (mpGame.turnIdx + 1) % mpGame.players.length;
  mpGame.phase = "place";
  mpGame.currentSong = null;
  mpGame.selectedSlot = null;
  mpGame.lastCorrect = null;
  mpBroadcast();
  mpDrawNext();
}

function mpFinishGame() {
  if (!mpGame.winner) {
    // Pool exhausted — top score wins.
    let best = -1, name = t("game.nobody");
    for (const p of mpGame.players) {
      if (p.timeline.length > best) { best = p.timeline.length; name = p.name; }
    }
    mpGame.winner = name;
  }
  mpGame.phase = "over";
  mpBroadcast();
  // Don't keep the saved game once it's clearly over — the Resume button
  // would otherwise drop people back into a finished session.
  clearMpSaved("host");
  clearMpSaved("player");
}

function mpHostQuit() {
  if (!confirm(t("mp.host.endConfirm"))) return;
  clearMpSaved("host");
  if (mpReconnectTimer) { clearInterval(mpReconnectTimer); mpReconnectTimer = null; }
  if (mpElectionTimer) { clearInterval(mpElectionTimer); mpElectionTimer = null; }
  if (mpGame && mpGame.peer) try { mpGame.peer.destroy(); } catch {}
  if (mpYtPlayer && mpYtPlayer.stopVideo) try { mpYtPlayer.stopVideo(); } catch {}
  mpGame = null;
  showScreen("home");
  refreshResumeButton();
}

// ─── PLAYER ───
async function joinAsPlayer(opts = {}) {
  const codeInput = (opts.code || $("#mpCodeInput").value).trim().toUpperCase();
  const name = (opts.name || $("#mpNameInput").value).trim() || "Player";
  const isResume = !!opts.isResume;
  if (!/^[A-Z]{4}$/.test(codeInput)) {
    $("#mpJoinStatus").textContent = t("mp.join.invalidCode");
    return;
  }
  $("#mpJoinStatus").textContent = t("mp.join.connecting");
  const targetId = MP_PREFIX + codeInput;
  const myId = getStablePeerId();
  const peer = new Peer(myId, { debug: 1 });

  let usedStableId = true;
  peer.on("error", (err) => {
    if (err.type === "unavailable-id" && usedStableId) {
      usedStableId = false;
      try { peer.destroy(); } catch {}
      const fallback = new Peer(undefined, { debug: 1 });
      attachPlayerHandlers(fallback, codeInput, targetId, name, isResume);
      return;
    }
    if (!isResume) {
      $("#mpJoinStatus").textContent = t("mp.join.error", { msg: err.type || err.message });
      if (err.type === "peer-unavailable") {
        $("#mpJoinStatus").textContent = t("mp.join.notFound");
      }
    }
    // For resume: silently retry via the reconnect timer.
  });
  attachPlayerHandlers(peer, codeInput, targetId, name, isResume);
}

function attachPlayerHandlers(peer, code, hostPeerId, name, isResume = false) {
  peer.on("open", (myId) => {
    const conn = peer.connect(hostPeerId, { reliable: true });
    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      try { conn.close(); } catch {}
      if (isResume) {
        // Host not online yet — keep the peer alive so the reconnect
        // timer can keep trying.
        mpGame = mpGame || {};
        Object.assign(mpGame, {
          role: "player", peer, hostConn: null,
          myPeerId: myId, hostPeerId, code, myName: name,
        });
        $("#mpJoinStatus").textContent = t("mp.join.waiting");
        attemptPlayerReconnect();
      } else {
        $("#mpJoinStatus").textContent = t("mp.join.timeout");
        try { peer.destroy(); } catch {}
      }
    }, 8000);
    conn.on("open", () => {
      opened = true;
      clearTimeout(timeout);
      mpGame = mpGame && mpGame.role === "player" ? mpGame : {};
      Object.assign(mpGame, {
        role: "player",
        peer,
        hostConn: conn,
        myPeerId: myId,
        hostPeerId,
        code,
        myName: name,
        // Phase + players fill in when the host broadcasts state. Until
        // then assume lobby with empty list.
        phase: mpGame.phase || "lobby",
        players: mpGame.players || [],
        targetScore: mpGame.targetScore || 10,
        turnIdx: mpGame.turnIdx || 0,
        regions: mpGame.regions || ["world", "ussr", "russia", "israel"],
        used: mpGame.used || [],
        revealedSong: null,
        lastCorrect: null,
        winner: null,
        selectedSlot: null,
        lastHostMsgAt: Date.now(),
      });
      conn.send({ type: "join", name });
      $("#mpJoinStatus").textContent = "";
      renderMpScreen();
      saveMpState();
      ensureElectionTimer();
    });
    conn.on("data", (msg) => handleMessageFromHost(msg));
    conn.on("close", () => {
      console.log("conn closed — auto-reconnect");
      attemptPlayerReconnect();
    });
    conn.on("error", (e) => {
      console.warn("conn error", e);
    });
  });
}

function attemptPlayerReconnect() {
  if (!mpGame || mpGame.role !== "player") return;
  // Don't bail home — re-establish the connection. The host might have
  // reloaded (in which case they come back at the same peer ID) or be
  // momentarily offline.
  $("#mpJoinStatus").textContent = t("mp.reconnecting");
  if (mpReconnectTimer) return; // already trying
  let attempts = 0;
  mpReconnectTimer = setInterval(() => {
    if (!mpGame || mpGame.role !== "player") {
      clearInterval(mpReconnectTimer); mpReconnectTimer = null; return;
    }
    attempts += 1;
    try {
      const conn = mpGame.peer.connect(mpGame.hostPeerId, { reliable: true });
      conn.on("open", () => {
        mpGame.hostConn = conn;
        mpGame.lastHostMsgAt = Date.now();
        clearInterval(mpReconnectTimer); mpReconnectTimer = null;
        conn.send({ type: "join", name: mpGame.myName });
        conn.on("data", (msg) => handleMessageFromHost(msg));
        conn.on("close", () => attemptPlayerReconnect());
      });
      conn.on("error", () => { try { conn.close(); } catch {} });
    } catch (e) {
      console.warn("reconnect attempt failed", e);
    }
    // Election kicks in below via the dedicated timer.
  }, 5000);
}

function handleMessageFromHost(msg) {
  if (!mpGame || mpGame.role !== "player") return;
  if (msg.type === "state") {
    const prevPhase = mpGame.phase;
    Object.assign(mpGame, msg.state);
    mpGame.lastHostMsgAt = Date.now();
    if (msg.state.phase === "place" && prevPhase !== "place") {
      mpGame.selectedSlot = null;
    }
    renderMpScreen();
    saveMpState();
  }
}

function mpPlayerQuit() {
  if (!confirm(t("mp.leaveConfirm"))) return;
  if (mpReconnectTimer) { clearInterval(mpReconnectTimer); mpReconnectTimer = null; }
  if (mpElectionTimer) { clearInterval(mpElectionTimer); mpElectionTimer = null; }
  clearMpSaved("player");
  if (mpGame && mpGame.peer) try { mpGame.peer.destroy(); } catch {}
  mpGame = null;
  showScreen("home");
}

// ─── Host election ──────────────────────────────────────────────────────────
function ensureElectionTimer() {
  if (mpElectionTimer) return;
  mpElectionTimer = setInterval(checkElection, 10 * 1000);
}

function checkElection() {
  if (!mpGame || mpGame.role !== "player") {
    if (mpElectionTimer) { clearInterval(mpElectionTimer); mpElectionTimer = null; }
    return;
  }
  const elapsed = Date.now() - (mpGame.lastHostMsgAt || 0);
  if (elapsed < HOST_DEAD_AFTER_MS) return;

  // Sort active non-host players by peerId; my rank determines my delay.
  const candidates = (mpGame.players || [])
    .filter((p) => !p.isHost)
    .map((p) => p.peerId)
    .sort();
  const myRank = candidates.indexOf(mpGame.myPeerId);
  if (myRank === -1) return; // we're not in the player list — skip
  const myDelay = HOST_DEAD_AFTER_MS + myRank * ELECTION_STEP_MS;
  if (elapsed < myDelay) return;

  // It's my turn to attempt takeover.
  if (mpElectionTimer) { clearInterval(mpElectionTimer); mpElectionTimer = null; }
  attemptHostTakeover();
}

async function attemptHostTakeover() {
  const code = mpGame.code;
  const savedPlayers = mpGame.players || [];
  const savedRegions = mpGame.regions || ["world", "ussr", "russia", "israel"];
  const savedUsed = mpGame.used || [];
  const savedTarget = mpGame.targetScore || 10;
  const savedTurn = mpGame.turnIdx || 0;
  const myPeerId = mpGame.myPeerId;
  const myName = mpGame.myName;

  // Tear down player-side peer first; PeerJS won't let one Peer instance
  // host and connect at once for the same ID.
  if (mpReconnectTimer) { clearInterval(mpReconnectTimer); mpReconnectTimer = null; }
  try { if (mpGame.peer) mpGame.peer.destroy(); } catch {}

  const hostPeerId = MP_PREFIX + code;
  const peer = new Peer(hostPeerId, { debug: 1 });

  // Map the saved roster onto a fresh host state. The promoted player
  // becomes the new "host" slot (so they get to advance turns and
  // control audio), but the old host's slot stays in the roster so they
  // can rejoin later as a regular player.
  const newPlayers = savedPlayers.map((p) => ({
    peerId: p.peerId,
    name: p.name,
    timeline: p.timeline || [],
    // Tag the new host. Anyone who was previously isHost is demoted.
    isHost: p.peerId === myPeerId,
  }));
  // If the previous host wasn't in the list (shouldn't happen but
  // defensive), ensure we appear.
  if (!newPlayers.find((p) => p.peerId === myPeerId)) {
    newPlayers.push({ peerId: myPeerId, name: myName || "Host", timeline: [], isHost: true });
  }

  mpGame = {
    role: "host",
    peer,
    code,
    myPeerId: hostPeerId,
    hostPeerId,
    connections: new Map(),
    players: newPlayers,
    targetScore: savedTarget,
    regions: savedRegions,
    phase: "place",   // resume mid-game; song will reload below
    used: savedUsed,
    turnIdx: savedTurn,
    currentSong: null,    // old current song is lost; pick a new one
    selectedSlot: null,
    lastCorrect: null,
    winner: null,
  };

  peer.on("open", async () => {
    $("#mpHostCode").textContent = code;
    setupShareUI(code);
    showScreen("mpHostLobby"); // briefly show lobby; we'll move to turn
    renderMpHostLobby();
    saveMpState();
    // Pick a new song and resume play.
    await mpEnsureHostPlayer();
    await mpDrawNext();
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      // The original host came back, or another player won the election.
      // Fall back to rejoining as a regular player.
      alert(t("mp.takeoverFailed"));
      mpGame = null;
      // Show join screen with code prefilled so they can re-enter quickly.
      showScreen("mpJoin");
      $("#mpCodeInput").value = code;
      $("#mpNameInput").value = myName || "";
      return;
    }
    console.warn("takeover error", err);
  });

  peer.on("connection", (conn) => {
    mpGame.connections.set(conn.peer, conn);
    conn.on("data", (msg) => handleMessageFromPlayer(conn, msg));
    conn.on("close", () => {
      mpGame.connections.delete(conn.peer);
      renderMpHostLobby();
      mpBroadcast();
    });
    conn.on("error", (e) => console.warn("conn error", e));
  });
}

// ─── Rendering (shared) ───
function renderMpScreen() {
  if (!mpGame) return;
  if (mpGame.phase === "lobby") {
    if (mpGame.role === "host") {
      showScreen("mpHostLobby");
      renderMpHostLobby();
    } else {
      showScreen("mpPlayerLobby");
      renderMpPlayerLobby();
    }
    return;
  }
  if (mpGame.phase === "place") {
    showScreen("mpTurn");
    renderMpTurn();
    return;
  }
  if (mpGame.phase === "reveal") {
    showScreen("mpReveal");
    renderMpReveal();
    return;
  }
  if (mpGame.phase === "over") {
    showScreen("mpOver");
    renderMpOver();
  }
}

function mpPlayerRowHTML(p, idx, myPeerId) {
  const initial = ((p.name || "?").trim().charAt(0) || "?").toUpperCase();
  const color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
  const isMe = p.peerId === myPeerId;
  const roleBits = [];
  if (p.isHost) roleBits.push(escapeHtml(t("mp.lobby.role.host")));
  if (isMe)     roleBits.push(escapeHtml(t("mp.lobby.you")));
  const role = roleBits.join(" · ");
  return `
      <div class="avatar" style="width:28px;height:28px;font-size:14px;background:${color}">${escapeHtml(initial)}</div>
      <span style="flex:1">${escapeHtml(p.name)}</span>
      <span class="role">${role}</span>`;
}

function renderMpHostLobby() {
  const list = $("#mpHostPlayers");
  list.innerHTML = "";
  mpGame.players.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "player-row" + (p.peerId === mpGame.myPeerId ? " you" : "");
    row.innerHTML = mpPlayerRowHTML(p, idx, mpGame.myPeerId);
    list.appendChild(row);
  });
  $("#mpStartBtn").disabled = mpGame.players.length < 2;
  updateTargetScoreLabel("mpTargetScoreLabel", $("#mpTargetScore").value);
}

function renderMpPlayerLobby() {
  $("#mpYouAre").textContent = mpGame.myName ? t("mp.lobby.youAre", { name: mpGame.myName }) : t("mp.lobby.connected");
  const list = $("#mpClientPlayers");
  list.innerHTML = "";
  mpGame.players.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "player-row" + (p.peerId === mpGame.myPeerId ? " you" : "");
    row.innerHTML = mpPlayerRowHTML(p, idx, mpGame.myPeerId);
    list.appendChild(row);
  });
}

function renderMpTurn() {
  const cur = mpGame.players[mpGame.turnIdx];
  const isMyTurn = cur && cur.peerId === mpGame.myPeerId;
  const isHost = mpGame.role === "host";

  $("#mpTurnPlayerName").textContent = cur ? cur.name : "—";
  $("#mpTurnPlayerScore").textContent = cur ? cur.timeline.length : 0;
  $("#mpTurnPlayerTarget").textContent = mpGame.targetScore;

  // The header play/pause stays hidden — the inline one in the now-playing
  // card is the visible control. Non-host phones don't have audio, so we
  // hide their inline button too.
  $("#mpPlayPauseBtn").classList.add("hidden");
  $("#mpPlayPauseInlineBtn").classList.toggle("hidden", !isHost);
  $("#mpLockInBtn").classList.toggle("hidden", !isMyTurn);
  $("#mpTurnHint").textContent = isMyTurn
    ? t("game.tapWhere")
    : t("game.waitingPlacement", { name: cur ? cur.name : "…" });

  // Each phone always shows ITS OWN timeline. When it's not your turn the
  // slot buttons are inert — you're just watching.
  const me = mpGame.players.find((p) => p.peerId === mpGame.myPeerId);
  const tl = me ? me.timeline : [];
  const slotsClickable = isMyTurn;

  const tlEl = $("#mpTimeline");
  tlEl.innerHTML = "";
  if (tl.length === 0) {
    tlEl.appendChild(mpMakeSlotEl(0, t("game.slot.empty"), slotsClickable));
  } else {
    tlEl.appendChild(mpMakeSlotEl(0, t("game.slot.before", { year: tl[0].year }), slotsClickable));
    for (let i = 0; i < tl.length; i++) {
      tlEl.appendChild(mpMakeCardEl(tl[i]));
      const label = i < tl.length - 1
        ? t("game.slot.between", { y1: tl[i].year, y2: tl[i + 1].year })
        : t("game.slot.after", { year: tl[i].year });
      tlEl.appendChild(mpMakeSlotEl(i + 1, label, slotsClickable));
    }
  }

  $("#mpLockInBtn").disabled = mpGame.selectedSlot === null;
  $("#mpPlacementHint").textContent = isMyTurn
    ? mpDescribePlacement(tl)
    : "";
}

function mpMakeSlotEl(index, label, clickable) {
  const el = document.createElement("button");
  el.type = "button";
  const active = mpGame.selectedSlot === index;
  el.className = "slot" + (active ? " selected" : "");
  el.dataset.slot = index;
  el.setAttribute("aria-label", label);
  el.innerHTML = slotInnerHTML(active);
  el.disabled = !clickable;
  if (clickable) {
    el.addEventListener("click", () => {
      mpGame.selectedSlot = index;
      renderMpTurn();
    });
  }
  return el;
}

function mpMakeCardEl(card) {
  const el = document.createElement("div");
  el.className = "tlcard";
  if (card.region) el.dataset.region = card.region;
  el.innerHTML = `
    <div class="y">${card.year}</div>
    <div class="divider-v"></div>
    <div class="meta">
      <strong>${escapeHtml(card.title || "—")}</strong>
      <span>${escapeHtml(card.artist || " ")}</span>
    </div>
    <div class="dot"></div>`;
  return el;
}

function mpDescribePlacement(tl) {
  if (mpGame.selectedSlot === null) return t("game.pickSlotLockIn");
  if (tl.length === 0) return t("game.anywhereFirst");
  const i = mpGame.selectedSlot;
  if (i === 0) return t("game.thinkBefore", { year: tl[0].year });
  if (i === tl.length) return t("game.thinkAfter", { year: tl[tl.length - 1].year });
  return t("game.thinkBetween", { y1: tl[i - 1].year, y2: tl[i].year });
}

function renderMpReveal() {
  const cur = mpGame.players[mpGame.turnIdx];
  const song = (mpGame.role === "host") ? mpGame.currentSong : mpGame.revealedSong;
  if (!song) return; // shouldn't happen
  $("#mpRevealYear").textContent   = song.year;
  $("#mpRevealArtist").textContent = song.artist;
  $("#mpRevealTitle").textContent  = song.title;
  $("#mpRevealRegion").textContent = regionLabel(song.region);
  // Result line is empty — stamp overlay carries the verdict.
  const rr = $("#mpRevealResult");
  rr.textContent = "";
  rr.classList.remove("good", "bad");
  const correct = mpGame.lastCorrect;
  const isHost = mpGame.role === "host";
  $("#mpContinueBtn").classList.toggle("hidden", !isHost);
  $("#mpContinueWait").classList.toggle("hidden", isHost);
  slapStamp($(".reveal-stage", $("#mpReveal")), correct);
}

function renderMpOver() {
  const winnerName = mpGame.winner || t("game.nobody");
  const winner = mpGame.players.find((p) => p.name === winnerName) || { name: winnerName, timeline: [] };
  renderWinnerStack({
    nameEl: $("#mpWinnerName"),
    crownEl: $("#mpWinnerCrown"),
    tallyEl: $("#mpWinnerTally"),
    tickerEl: $("#mpFinalScores"),
    name: winner.name,
    timeline: winner.timeline,
  });
}

// ─── Free-play scanner + player ─────────────────────────────────────────────
function parseQrPayload(text) {
  if (!text) return null;
  text = text.trim();
  if (text.startsWith("mt:")) return text.slice(3);
  try {
    const u = new URL(text);
    const id = u.searchParams.get("id");
    if (id) return id;
    const join = u.searchParams.get("join");
    if (join) return null; // join URL, not a song card — ignore in free play
  } catch {}
  if (/^[wri]\d{3}$/i.test(text) || /^o\d{3}$/i.test(text)) return text;
  return null;
}

function onQrDecoded(decoded) {
  const id = parseQrPayload(decoded);
  if (!id) return;
  const song = songsById.get(id);
  if (!song) { alert(t("mp.unknownCard", { id })); return; }
  stopScanner();
  freePlay(song);
}

// ─── Camera debug helpers ────────────────────────────────────────────────────
let _dbgLines = [];
function dbg(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  _dbgLines.push(`[${ts}] ${msg}`);
  const el = document.getElementById("cameraDebugLog");
  if (el) el.textContent = _dbgLines.slice(-30).join("\n");
  console.log("[cam]", msg);
}

function logCameraEnv() {
  // Synchronous-only env dump. Anything that involves await would burn the
  // user gesture's transient activation before we get to getUserMedia, which
  // makes Firefox Mobile reject the camera request with NotAllowedError.
  dbg(`UA: ${navigator.userAgent.slice(0, 80)}`);
  dbg(`mediaDevices: ${"mediaDevices" in navigator ? "YES" : "NO"}`);
  dbg(`getUserMedia: ${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? "YES" : "NO"}`);
  dbg(`jsQR: ${typeof window.jsQR === "function" ? "YES" : "NO"}`);
  dbg(`protocol: ${location.protocol}  hostname: ${location.hostname}`);
}

// Live-scan state — replaces the old html5-qrcode-based qrScanner.
let _scanStream = null;
let _scanVideo = null;
let _scanLoop = null;

async function startScanner() {
  // EVERYTHING up to the first `await` must be synchronous so Firefox
  // Mobile still has the click's transient activation when we call
  // getUserMedia. stopScanner() used to be async — calling it through
  // `await` introduced a microtask hop that FF treated as activation
  // expiry, rejecting with NotAllowedError "in the current context".
  showScreen("scanner");
  stopScanner();
  $("#qrFileFallback").classList.add("hidden");
  $("#scanHint").textContent = t("free.cameraRetrying");
  _dbgLines = [];
  logCameraEnv();

  // ONE getUserMedia call. We attach the resulting stream to our own
  // video element and decode frames with jsQR. The previous flow called
  // getUserMedia twice (probe, release, html5-qrcode.start), which on
  // mobile Chrome silently hung and on FF Mobile failed with
  // NotAllowedError because the user gesture had already expired.
  const attempts = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } },
    { video: { facingMode: "environment" } },
    { video: { facingMode: "user" } },
    { video: true },
  ];

  let stream = null;
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const c = attempts[i];
    dbg(`getUserMedia attempt ${i + 1}/${attempts.length}: ${JSON.stringify(c)}`);
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      const track = stream.getVideoTracks()[0];
      const settings = (track && track.getSettings) ? track.getSettings() : {};
      dbg(`✓ track: ${track?.label || "(no label)"} ${settings.width || "?"}x${settings.height || "?"}`);
      break;
    } catch (e) {
      lastErr = e;
      dbg(`✗ ${e.name}: ${e.message}`);
      if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError" ||
          e.name === "SecurityError") {
        // Tell apart "previously denied" from "user dismissed the prompt"
        // so we can give actionable instructions to FF Mobile users.
        await reportCameraBlocked(e);
        return;
      }
      // OverconstrainedError etc. → try the next constraint.
    }
  }

  if (!stream) {
    dbg("All getUserMedia attempts failed → showing file fallback");
    $("#scanHint").textContent = t("free.cameraError", {
      msg: lastErr ? lastErr.name : "No camera found"
    });
    $("#qrFileFallback").classList.remove("hidden");
    return;
  }

  _scanStream = stream;

  const reader = $("#reader");
  reader.innerHTML = "";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.muted = true;
  video.autoplay = true;
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.objectFit = "cover";
  video.srcObject = stream;
  reader.appendChild(video);
  _scanVideo = video;

  try {
    await video.play();
    dbg("✓ video.play()");
  } catch (e) {
    dbg(`video.play warn: ${e.name}: ${e.message}`);
  }

  $("#scanHint").textContent = t("free.scanHint");

  // Decode loop — sample at ~6fps. Center-crop the frame to a square that
  // roughly matches the viewfinder so jsQR has less data to chew through
  // on phones.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  _scanLoop = setInterval(() => {
    if (!_scanVideo || _scanVideo.readyState < 2 || typeof jsQR !== "function") return;
    const vw = _scanVideo.videoWidth, vh = _scanVideo.videoHeight;
    if (!vw || !vh) return;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    canvas.width = side;
    canvas.height = side;
    try {
      ctx.drawImage(_scanVideo, sx, sy, side, side, 0, 0, side, side);
      const data = ctx.getImageData(0, 0, side, side);
      const code = jsQR(data.data, side, side, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        dbg(`✓ decoded: ${code.data.slice(0, 60)}`);
        onQrDecoded(code.data);
      }
    } catch (e) {
      // drawImage / getImageData can throw on transient video glitches;
      // safest to ignore and try next tick.
    }
  }, 160);
}

// Synchronous on purpose — see comment in startScanner about transient
// activation. Nothing in here actually needs to await anything.
function stopScanner() {
  if (_scanLoop) { clearInterval(_scanLoop); _scanLoop = null; }
  if (_scanVideo) {
    try { _scanVideo.pause(); } catch {}
    try { _scanVideo.srcObject = null; } catch {}
    _scanVideo.remove();
    _scanVideo = null;
  }
  if (_scanStream) {
    _scanStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    _scanStream = null;
  }
}

// After getUserMedia rejects with a permission-class error, query the
// Permissions API to differentiate "previously denied" (user must reset
// site settings) from "prompt dismissed" (user can just try again).
async function reportCameraBlocked(err) {
  let state = "unknown";
  if (navigator.permissions) {
    try {
      const p = await navigator.permissions.query({ name: "camera" });
      state = p.state;
    } catch {}
  }
  dbg(`permission state after error: ${state}`);
  const hint = $("#scanHint");
  if (state === "denied") {
    hint.textContent = t("free.cameraDenied");
  } else if (err.name === "SecurityError") {
    hint.textContent = t("free.cameraInsecure");
  } else {
    hint.textContent = t("free.cameraDismissed");
  }
  $("#qrFileFallback").classList.remove("hidden");
}

// File-input fallback: decode a QR from a chosen image with jsQR.
async function handleQrFile(file) {
  if (!file) return;
  if (typeof jsQR !== "function") {
    alert("QR decoder not loaded — refresh and try again.");
    return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const code = jsQR(data.data, canvas.width, canvas.height);
    if (code && code.data) {
      onQrDecoded(code.data);
    } else {
      alert(t("free.cameraError", { msg: "No QR code in image" }));
    }
  } catch (e) {
    alert(t("free.cameraError", { msg: e.message }));
  }
}

async function ensureFreePlayer() {
  if (freeYtPlayer) return freeYtPlayer;
  await loadYouTubeAPI();
  freeYtPlayer = await makePlayer("freeYt", (e) => {
    const v = $("#freeVinyl");
    const btn = $("#freePlayPauseBtn");
    const playing = e.data === YT.PlayerState.PLAYING;
    if (playing) {
      v && v.classList.remove("paused");
      btn && (btn.textContent = t("common.pause"));
    } else {
      v && v.classList.add("paused");
      btn && (btn.textContent = t("common.play"));
    }
  });
  return freeYtPlayer;
}

let freeCurrentSong = null;
async function freePlay(song) {
  freeCurrentSong = song;
  $("#freeAnswer").classList.add("hidden");
  showScreen("freePlayer");
  if (!song.youtube_id) {
    alert(t("free.unverified"));
    return;
  }
  const p = await ensureFreePlayer();
  try { p.loadVideoById({ videoId: song.youtube_id }); } catch {}
  try { p.unMute(); p.setVolume(80); } catch {}
}

function freeReveal() {
  if (!freeCurrentSong) return;
  $("#freeAnsYear").textContent  = freeCurrentSong.year;
  $("#freeAnsArtist").textContent = freeCurrentSong.artist;
  $("#freeAnsTitle").textContent  = freeCurrentSong.title;
  $("#freeAnsRegion").textContent = regionLabel(freeCurrentSong.region);
  $("#freeAnswer").classList.remove("hidden");
}

function pickRandomVerified() {
  if (verifiedSongs.length === 0) {
    alert(t("free.noVerified"));
    return null;
  }
  return verifiedSongs[Math.floor(Math.random() * verifiedSongs.length)];
}

// ─── In-browser PDF card printing ───────────────────────────────────────────
//
// Print PDFs are pre-generated server-side (scripts/make_cards.py) and served
// as static files. The download links in the HTML point directly to them.

function updatePrintBadges() {
  function count(regions) { return verifiedSongs.filter((s) => regions.includes(s.region)).length; }
  const allCount = verifiedSongs.length;
  const worldCount = count(["world"]);
  const russiaCount = count(["russia", "ussr"]);
  const israelCount = count(["israel"]);

  function badge(btn, n) {
    if (!btn) return;
    // Strip any existing badge then re-add
    const existing = btn.querySelector(".print-badge");
    if (existing) existing.remove();
    const span = document.createElement("span");
    span.className = "print-badge";
    span.textContent = n;
    btn.appendChild(span);
  }
  badge($("#printAllBtn"), allCount);
  badge($("#printWorldBtn"), worldCount);
  badge($("#printRussiaBtn"), russiaCount);
  badge($("#printIsraelBtn"), israelCount);
}

// ─── Wire-up ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Translate every [data-i18n] element in the static HTML before anything
  // else runs — the rest of the app then operates on translated DOM.
  if (typeof applyI18n === "function") applyI18n(document);
  // Initialize target-score labels (HTML doesn't know the current language).
  updateTargetScoreLabel("targetScoreLabel", $("#targetScore").value);
  updateTargetScoreLabel("mpTargetScoreLabel", $("#mpTargetScore").value);

  try { await loadSongs(); }
  catch (e) { $("#dbStatus").textContent = t("home.dbError", { msg: e.message }); }

  refreshResumeButton();
  updatePrintBadges();

  $("#gameBtn").addEventListener("click", openSetup);
  $("#resumeBtn").addEventListener("click", resumeGame);
  $("#resumeHostBtn").addEventListener("click", resumeHostedGame);
  $("#resumePlayerBtn").addEventListener("click", resumePlayerGame);
  $("#hostBtn").addEventListener("click", () => startHosting());
  $("#joinBtn").addEventListener("click", () => {
    $("#mpJoinStatus").textContent = "";
    $("#mpCodeInput").value = "";
    $("#mpNameInput").value = "";
    showScreen("mpJoin");
  });
  $("#mpJoinBtn").addEventListener("click", joinAsPlayer);
  $("#mpStartBtn").addEventListener("click", mpStartGame);
  $("#mpTargetScore").addEventListener("input", (e) => {
    updateTargetScoreLabel("mpTargetScoreLabel", e.target.value);
  });
  $("#mpHostQuitBtn").addEventListener("click", mpHostQuit);
  $("#mpPlayerQuitBtn").addEventListener("click", mpPlayerQuit);
  $("#mpCopyLinkBtn").addEventListener("click", copyJoinUrl);
  $("#mpShareBtn").addEventListener("click", shareJoinUrl);
  $("#mpQuitTurnBtn").addEventListener("click", () => {
    if (mpGame && mpGame.role === "host") mpHostQuit();
    else mpPlayerQuit();
  });
  $("#mpLockInBtn").addEventListener("click", () => {
    if (!mpGame || mpGame.selectedSlot === null) return;
    if (mpGame.role === "host") {
      mpRevealAndScore();
    } else {
      try { mpGame.hostConn.send({ type: "lockIn", slotIndex: mpGame.selectedSlot }); } catch {}
    }
  });
  $("#mpContinueBtn").addEventListener("click", mpContinue);
  $("#mpPlayPauseBtn").addEventListener("click", () => {
    if (!mpYtPlayer) return;
    const s = mpYtPlayer.getPlayerState && mpYtPlayer.getPlayerState();
    if (s === 1) mpYtPlayer.pauseVideo();
    else         mpYtPlayer.playVideo();
  });
  $("#scanBtn")?.addEventListener("click", startScanner);
  $("#qrFileInput")?.addEventListener("change", (e) => handleQrFile(e.target.files[0]));
  // "Play a random song" is no longer on the home screen — guard for null.
  $("#randomBtn")?.addEventListener("click", () => {
    const s = pickRandomVerified();
    if (s) freePlay(s);
  });

  // New design: pass-the-phone interstitial.
  $("#passStartBtn")?.addEventListener("click", async () => {
    showScreen("gameTurn");
    if (game?.phase === "draw" || !game?.currentSong) {
      await ensureGamePlayer();
      await drawForCurrentPlayer();
    } else if (game?.phase === "place" && game.currentSong) {
      await ensureGamePlayer();
      renderTurn();
      if (ytPlayer && ytPlayer.loadVideoById) {
        try { ytPlayer.loadVideoById({ videoId: game.currentSong.youtube_id }); } catch {}
      }
    }
  });

  // New design: dedicated print screen (replaces the old <details> on home).
  $("#openPrintBtn")?.addEventListener("click", () => {
    renderPrintScreen();
    showScreen("printScreen");
  });

  // Inline play/pause buttons inside the "now playing" card.
  $("#playPauseInlineBtn")?.addEventListener("click", () => {
    if (!ytPlayer) return;
    const s = ytPlayer.getPlayerState && ytPlayer.getPlayerState();
    if (s === 1) ytPlayer.pauseVideo();
    else         ytPlayer.playVideo();
  });
  $("#mpPlayPauseInlineBtn")?.addEventListener("click", () => {
    if (!mpYtPlayer || mpGame?.role !== "host") return;
    const s = mpYtPlayer.getPlayerState && mpYtPlayer.getPlayerState();
    if (s === 1) mpYtPlayer.pauseVideo();
    else         mpYtPlayer.playVideo();
  });

  // Theme toggle (cycles system → light → dark → system).
  $("#themeToggle")?.addEventListener("click", cycleTheme);
  refreshThemeIcon();

  // Build waveform bars once.
  buildWaveform($("#gameWaveform"));
  buildWaveform($("#mpWaveform"));

  // Region-grid chips toggle an `.on` class on their label for visuals.
  $$("#regionGrid input, #mpRegionGrid input").forEach((cb) => {
    const lbl = cb.closest("label");
    if (lbl) lbl.classList.toggle("on", cb.checked);
    cb.addEventListener("change", () => {
      if (lbl) lbl.classList.toggle("on", cb.checked);
    });
  });

  $("#addPlayerBtn").addEventListener("click", () => {
    if (setupState.players.length >= 6) return;
    setupState.players.push(t("game.playerDefault", { n: setupState.players.length + 1 }));
    renderPlayersList();
  });
  $("#targetScore").addEventListener("input", (e) => {
    updateTargetScoreLabel("targetScoreLabel", e.target.value);
  });
  $("#startGameBtn").addEventListener("click", onStartGameTap);

  $("#playPauseBtn").addEventListener("click", () => {
    if (!ytPlayer) return;
    const s = ytPlayer.getPlayerState && ytPlayer.getPlayerState();
    if (s === 1) ytPlayer.pauseVideo();
    else         ytPlayer.playVideo();
  });
  $("#lockInBtn").addEventListener("click", revealAndScore);
  $("#continueBtn").addEventListener("click", continueToNextTurn);
  $("#quitGameBtn").addEventListener("click", quitGame);
  $("#playAgainBtn").addEventListener("click", () => {
    clearSavedGame();
    game = null;
    openSetup();
  });

  $("#freePlayPauseBtn").addEventListener("click", () => {
    if (!freeYtPlayer) return;
    const s = freeYtPlayer.getPlayerState && freeYtPlayer.getPlayerState();
    if (s === 1) freeYtPlayer.pauseVideo();
    else         freeYtPlayer.playVideo();
  });
  $("#freeRevealBtn").addEventListener("click", freeReveal);

  $$("[data-screen]").forEach((el) => {
    el.addEventListener("click", () => showScreen(el.dataset.screen));
  });

  // Pick the screen to land on. Priority:
  //   1. Explicit query-string deep links (?id=…, ?join=…)
  //   2. URL hash route (so refreshing keeps the same screen)
  //   3. Auto-resume of an in-progress multiplayer or single-device game
  //   4. Home
  const params = new URLSearchParams(location.search);
  const linkedId = params.get("id");
  const joinCode = (params.get("join") || "").trim().toUpperCase();
  const isJoinDeepLink = /^[A-Z]{4}$/.test(joinCode);

  let handled = false;

  if (linkedId) {
    const song = songsById.get(linkedId);
    if (song) { freePlay(song); handled = true; }
  }

  if (!handled && isJoinDeepLink) {
    showScreen("mpJoin");
    $("#mpCodeInput").value = joinCode;
    // Focus the name field — they only need to fill that in.
    setTimeout(() => $("#mpNameInput").focus(), 50);
    handled = true;
  }

  if (!handled) {
    const slug = (location.hash || "").replace(/^#/, "");
    const target = HASH_TO_SCREEN[slug];
    if (target && target !== "home") {
      handled = openRoutedScreen(target);
    }
  }

  if ("serviceWorker" in navigator) {
    // updateViaCache:"none" → the browser never serves sw.js from HTTP
    // cache, so we can always ship a new SW by pushing a new sw.js.
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});

    // When a brand-new SW (one with new behavior) takes over this tab,
    // reload so the user actually sees the fresh shell. The first install
    // case — where `controller` was null and the SW is just claiming an
    // uncontrolled tab — isn't a "user-facing update," so skip it.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  // Auto-resume only kicks in if no explicit deep link or hash already
  // chose a screen — otherwise the user's URL wins.
  if (!handled) {
    const hostSaved = loadMpSaved("host");
    const playerSaved = loadMpSaved("player");
    if (hostSaved && hostSaved.phase !== "over") {
      // Defer slightly so the home screen flashes briefly — gives the
      // user a chance to bail out by tapping anywhere else first.
      setTimeout(() => resumeHostedGame(), 100);
    } else if (playerSaved && playerSaved.phase !== "over") {
      setTimeout(() => resumePlayerGame(), 100);
    }
  }
});

// ─── Theme toggle ───────────────────────────────────────────────────────────
// Cycles system → light → dark → system. Saved to localStorage so it sticks
// across reloads; "system" follows prefers-color-scheme.
const THEME_KEY = "mt.theme";
function readTheme() {
  try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; }
}
function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("theme-light", "theme-dark", "theme-system");
  html.classList.add("theme-" + (theme === "dark" || theme === "light" ? theme : "system"));
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  refreshThemeIcon();
}
function cycleTheme() {
  const order = ["system", "light", "dark"];
  const cur = readTheme();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
}
function refreshThemeIcon() {
  const icon = $("#themeToggleIcon");
  if (!icon) return;
  const cur = readTheme();
  icon.textContent = cur === "light" ? "☀" : cur === "dark" ? "☾" : "◐";
}

// ─── Waveform bars ──────────────────────────────────────────────────────────
// Stable "seeded" heights so the visualizer looks organic but doesn't
// re-shuffle every render.
function buildWaveform(el, bars = 26) {
  if (!el) return;
  el.innerHTML = "";
  for (let i = 0; i < bars; i++) {
    const seed = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 0.3));
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = (seed * 100).toFixed(0) + "%";
    bar.style.animationDuration = (0.5 + (i % 7) * 0.07).toFixed(2) + "s";
    bar.style.animationDelay = ((i % 5) * 0.06).toFixed(2) + "s";
    el.appendChild(bar);
  }
}

// ─── Print screen ──────────────────────────────────────────────────────────
// The downloads themselves are static PDFs; this just keeps the summary
// numbers honest based on the loaded song database.
function renderPrintScreen() {
  function countRegions(regions) {
    return verifiedSongs.filter((s) => regions.includes(s.region)).length;
  }
  const total = verifiedSongs.length;
  const pages = Math.max(1, Math.ceil(total / 20));
  const totalEl = $("#printSummaryTotal");
  const packEl = $("#printSummaryPacks");
  if (totalEl) totalEl.textContent = t("print.cardCount", { n: total, p: pages });
  if (packEl) packEl.textContent = total ? "4" : "0";

  // Set per-button counts as right-aligned badges.
  function setBadge(href, n) {
    const a = $(`.print-buttons a[href="${href}"]`);
    if (!a) return;
    a.querySelectorAll(".print-badge").forEach((el) => el.remove());
    const span = document.createElement("span");
    span.className = "print-badge";
    span.textContent = n;
    a.appendChild(span);
  }
  setBadge("../cards/cards-all.pdf",    total);
  setBadge("../cards/cards-world.pdf",  countRegions(["world"]));
  setBadge("../cards/cards-russia.pdf", countRegions(["russia", "ussr"]));
  setBadge("../cards/cards-israel.pdf", countRegions(["israel"]));
}
