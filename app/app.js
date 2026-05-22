/*
 * Music Timeline PWA.
 *
 * Two modes:
 *   1) Pass-and-play game (no printed cards needed). State lives in
 *      localStorage so accidental refreshes don't lose progress.
 *   2) Free play — scan a printed QR or hit "random". Same hidden player.
 *
 * Audio plays through a YouTube IFrame positioned off-screen so the title
 * and thumbnail never leak before the player reveals.
 */

const REGION_LABEL = {
  world:  "World",
  ussr:   "USSR",
  russia: "Russia",
  israel: "Israel",
};

const STORAGE_KEY = "mt.game.v1";

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

let songs = [];                // full DB
let verifiedSongs = [];        // subset with youtube_id
let songsById = new Map();
let ytPlayer = null;           // game-mode hidden player
let freeYtPlayer = null;       // free-play hidden player
let qrScanner = null;

let game = null;               // current game state (or null)

// ─── Screens ────────────────────────────────────────────────────────────────
function showScreen(name) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === name));
  if (name !== "scanner") stopScanner();
  if (name !== "gameTurn") {
    // pause the game player when leaving the turn screen, but don't destroy it
    if (ytPlayer && ytPlayer.pauseVideo) try { ytPlayer.pauseVideo(); } catch {}
  }
  if (name !== "freePlayer") {
    if (freeYtPlayer && freeYtPlayer.stopVideo) try { freeYtPlayer.stopVideo(); } catch {}
  }
}

// ─── Songs ──────────────────────────────────────────────────────────────────
async function loadSongs() {
  const res = await fetch("../data/songs.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Failed to load songs.json");
  songs = await res.json();
  songsById = new Map(songs.map((s) => [s.id, s]));
  verifiedSongs = songs.filter((s) => s.youtube_id);
  $("#dbStatus").textContent = `${songs.length} songs (${verifiedSongs.length} verified)`;
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
  const btn = $("#playPauseBtn");
  if (!btn) return;
  if (e.data === YT.PlayerState.PLAYING) btn.textContent = "⏸";
  else                                    btn.textContent = "▶";
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
    tl.appendChild(makeSlotEl(0, "Place anywhere (first card is always correct)"));
    return;
  }

  // Slot before first
  tl.appendChild(makeSlotEl(0, `Before ${cards[0].year}`));
  for (let i = 0; i < cards.length; i++) {
    tl.appendChild(makeCardEl(cards[i]));
    const label = i < cards.length - 1
      ? `Between ${cards[i].year} and ${cards[i + 1].year}`
      : `After ${cards[i].year}`;
    tl.appendChild(makeSlotEl(i + 1, label));
  }
}

function makeSlotEl(index, label) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "slot" + (game.selectedSlot === index ? " selected" : "");
  el.textContent = label;
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
  el.innerHTML = `
    <div class="y">${card.year}</div>
    <div class="meta">
      <strong>${escapeHtml(card.artist)}</strong>
      <span class="muted">${escapeHtml(card.title)}</span>
    </div>`;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function describePlacement() {
  if (game.selectedSlot === null) return "Pick a slot, then reveal.";
  const cards = game.players[game.turnIdx].timeline;
  if (cards.length === 0) return "Anywhere works for the first card.";
  const i = game.selectedSlot;
  if (i === 0) return `You think it's before ${cards[0].year}.`;
  if (i === cards.length) return `You think it's after ${cards[cards.length - 1].year}.`;
  return `You think it's between ${cards[i - 1].year} and ${cards[i].year}.`;
}

function revealAndScore() {
  if (game.selectedSlot === null || !game.currentSong) return;
  if (ytPlayer && ytPlayer.pauseVideo) try { ytPlayer.pauseVideo(); } catch {}

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
  $("#revealRegion").textContent = REGION_LABEL[game.currentSong.region] || game.currentSong.region;
  const rr = $("#revealResult");
  rr.textContent = correct ? `✓ ${me.name} keeps the card` : `✗ ${me.name} misses`;
  rr.classList.toggle("good", correct);
  rr.classList.toggle("bad", !correct);

  // Win condition?
  if (me.timeline.length >= game.targetScore) {
    game.winner = me.name;
    game.phase = "over";
    saveGame();
  }

  showScreen("gameReveal");
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
  saveGame();
  showScreen("gameTurn");
  drawForCurrentPlayer();
}

function finishGame() {
  game.phase = "over";
  if (!game.winner) {
    // Triggered by pool exhaustion — pick highest score (ties → first wins).
    let best = -1, name = "Nobody";
    for (const p of game.players) {
      if (p.timeline.length > best) { best = p.timeline.length; name = p.name; }
    }
    game.winner = name;
  }
  saveGame();
  $("#winnerName").textContent = game.winner;
  const fs = $("#finalScores");
  fs.innerHTML = "";
  const sorted = [...game.players].sort((a, b) => b.timeline.length - a.timeline.length);
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(p.name)}</span><strong>${p.timeline.length}</strong>`;
    fs.appendChild(row);
  }
  showScreen("gameOver");
}

function quitGame() {
  if (!confirm("Quit this game? Progress will be lost.")) return;
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
    const row = document.createElement("div");
    row.className = "player-row";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(name)}" placeholder="Player ${idx + 1}" />
      <button class="del" aria-label="Remove">−</button>`;
    const input = row.querySelector("input");
    input.addEventListener("input", () => { setupState.players[idx] = input.value; });
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
  players: ["Player 1", "Player 2"],
};

function openSetup() {
  setupState.players = ["Player 1", "Player 2"];
  renderPlayersList();
  $("#targetScore").value = 10;
  $("#targetScoreVal").textContent = 10;
  $$("#regionGrid input").forEach((cb) => { cb.checked = true; });
  showScreen("gameSetup");
}

function readRegionsFromUI() {
  return $$("#regionGrid input:checked").map((cb) => cb.value);
}

async function onStartGameTap() {
  const playerNames = setupState.players.map((n) => n.trim()).filter(Boolean);
  if (playerNames.length < 2) {
    alert("Need at least 2 players.");
    return;
  }
  const regions = readRegionsFromUI();
  if (regions.length === 0) {
    alert("Pick at least one region.");
    return;
  }
  const targetScore = parseInt($("#targetScore").value, 10);
  if (verifiedSongs.filter((s) => regions.includes(s.region)).length < targetScore * playerNames.length) {
    if (!confirm("There aren't many verified songs in this region mix. The game may run out before anyone wins. Continue?")) return;
  }
  showScreen("gameTurn");
  await startGame({ playerNames, targetScore, regions });
}

function refreshResumeButton() {
  const saved = loadGameFromStorage();
  $("#resumeBtn").classList.toggle("hidden", !saved || saved.phase === "over");
}

async function resumeGame() {
  const saved = loadGameFromStorage();
  if (!saved) return;
  game = saved;
  showScreen("gameTurn");
  await ensureGamePlayer();
  if (game.phase === "place" && game.currentSong && ytPlayer && ytPlayer.loadVideoById) {
    try { ytPlayer.loadVideoById({ videoId: game.currentSong.youtube_id }); } catch {}
  } else if (game.phase === "draw") {
    drawForCurrentPlayer();
  } else if (game.phase === "reveal") {
    showScreen("gameReveal");
  } else if (game.phase === "over") {
    finishGame();
  }
  renderTurn();
}

// ─── Free-play scanner + player (unchanged behaviour, separate iframe) ──────
function parseQrPayload(text) {
  if (!text) return null;
  text = text.trim();
  if (text.startsWith("mt:")) return text.slice(3);
  try {
    const u = new URL(text);
    const id = u.searchParams.get("id");
    if (id) return id;
  } catch {}
  if (/^[wri]\d{3}$/i.test(text) || /^o\d{3}$/i.test(text)) return text;
  return null;
}

async function startScanner() {
  showScreen("scanner");
  if (qrScanner) await stopScanner();
  qrScanner = new Html5Qrcode("reader");
  const config = { fps: 12, qrbox: { width: 240, height: 240 } };
  try {
    await qrScanner.start(
      { facingMode: "environment" },
      config,
      (decoded) => {
        const id = parseQrPayload(decoded);
        if (!id) return;
        const song = songsById.get(id);
        if (!song) { alert(`Unknown card id: ${id}`); return; }
        stopScanner();
        freePlay(song);
      },
      () => {}
    );
  } catch (e) {
    alert("Camera unavailable: " + e.message);
    showScreen("home");
  }
}

async function stopScanner() {
  if (!qrScanner) return;
  try { await qrScanner.stop(); } catch {}
  try { await qrScanner.clear(); } catch {}
  qrScanner = null;
}

async function ensureFreePlayer() {
  if (freeYtPlayer) return freeYtPlayer;
  await loadYouTubeAPI();
  freeYtPlayer = await makePlayer("freeYt", (e) => {
    const v = $("#freeVinyl");
    const btn = $("#freePlayPauseBtn");
    if (e.data === YT.PlayerState.PLAYING) {
      v && v.classList.remove("paused");
      btn && (btn.textContent = "⏸ Pause");
    } else {
      v && v.classList.add("paused");
      btn && (btn.textContent = "▶ Play");
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
    alert("This song isn't verified yet.");
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
  $("#freeAnsRegion").textContent = REGION_LABEL[freeCurrentSong.region] || freeCurrentSong.region;
  $("#freeAnswer").classList.remove("hidden");
}

function pickRandomVerified() {
  if (verifiedSongs.length === 0) {
    alert("No verified songs yet — run scripts/verify.py first.");
    return null;
  }
  return verifiedSongs[Math.floor(Math.random() * verifiedSongs.length)];
}

// ─── Wire-up ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  try { await loadSongs(); }
  catch (e) { $("#dbStatus").textContent = "Failed to load songs.json — " + e.message; }

  refreshResumeButton();

  $("#gameBtn").addEventListener("click", openSetup);
  $("#resumeBtn").addEventListener("click", resumeGame);
  $("#scanBtn").addEventListener("click", startScanner);
  $("#randomBtn").addEventListener("click", () => {
    const s = pickRandomVerified();
    if (s) freePlay(s);
  });

  $("#addPlayerBtn").addEventListener("click", () => {
    if (setupState.players.length >= 6) return;
    setupState.players.push(`Player ${setupState.players.length + 1}`);
    renderPlayersList();
  });
  $("#targetScore").addEventListener("input", (e) => {
    $("#targetScoreVal").textContent = e.target.value;
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

  // ?id=… deep-link still works for free play (scanning through native camera).
  const params = new URLSearchParams(location.search);
  const linkedId = params.get("id");
  if (linkedId) {
    const song = songsById.get(linkedId);
    if (song) freePlay(song);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
