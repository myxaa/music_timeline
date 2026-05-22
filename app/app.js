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
  if (card.region) el.dataset.region = card.region;
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
  const rr = $("#revealResult");
  rr.textContent = correct ? t("game.keepsCard", { name: me.name }) : t("game.misses", { name: me.name });
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
    let best = -1, name = t("game.nobody");
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
  showScreen("gameTurn");
  await startGame({ playerNames, targetScore, regions });
}

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
    const btn = $("#mpPlayPauseBtn");
    if (!btn) return;
    btn.textContent = (e.data === YT.PlayerState.PLAYING) ? "⏸" : "▶";
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

function renderMpHostLobby() {
  const list = $("#mpHostPlayers");
  list.innerHTML = "";
  for (const p of mpGame.players) {
    const row = document.createElement("div");
    row.className = "player-row" + (p.peerId === mpGame.myPeerId ? " you" : "");
    row.innerHTML = `
      <span style="flex:1">${escapeHtml(p.name)}</span>
      <span class="role">${p.isHost ? escapeHtml(t("mp.lobby.role.host")) : ""}${p.peerId === mpGame.myPeerId ? " · " + escapeHtml(t("mp.lobby.you")) : ""}</span>`;
    list.appendChild(row);
  }
  $("#mpStartBtn").disabled = mpGame.players.length < 2;
  updateTargetScoreLabel("mpTargetScoreLabel", $("#mpTargetScore").value);
}

function renderMpPlayerLobby() {
  $("#mpYouAre").textContent = mpGame.myName ? t("mp.lobby.youAre", { name: mpGame.myName }) : t("mp.lobby.connected");
  const list = $("#mpClientPlayers");
  list.innerHTML = "";
  for (const p of mpGame.players) {
    const row = document.createElement("div");
    row.className = "player-row" + (p.peerId === mpGame.myPeerId ? " you" : "");
    row.innerHTML = `
      <span style="flex:1">${escapeHtml(p.name)}</span>
      <span class="role">${p.isHost ? escapeHtml(t("mp.lobby.role.host")) : ""}${p.peerId === mpGame.myPeerId ? " · " + escapeHtml(t("mp.lobby.you")) : ""}</span>`;
    list.appendChild(row);
  }
}

function renderMpTurn() {
  const cur = mpGame.players[mpGame.turnIdx];
  const isMyTurn = cur && cur.peerId === mpGame.myPeerId;
  const isHost = mpGame.role === "host";

  $("#mpTurnPlayerName").textContent = cur ? cur.name : "—";
  $("#mpTurnPlayerScore").textContent = cur ? cur.timeline.length : 0;
  $("#mpTurnPlayerTarget").textContent = mpGame.targetScore;

  $("#mpPlayPauseBtn").classList.toggle("hidden", !isHost);
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
  el.className = "slot" + (mpGame.selectedSlot === index ? " selected" : "");
  el.textContent = label;
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
    <div class="meta">
      <strong>${escapeHtml(card.artist)}</strong>
      <span class="muted">${escapeHtml(card.title)}</span>
    </div>`;
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
  const rr = $("#mpRevealResult");
  const correct = mpGame.lastCorrect;
  rr.textContent = correct ? t("game.keepsCard", { name: cur.name }) : t("game.misses", { name: cur.name });
  rr.classList.toggle("good", correct);
  rr.classList.toggle("bad", !correct);
  const isHost = mpGame.role === "host";
  $("#mpContinueBtn").classList.toggle("hidden", !isHost);
  $("#mpContinueWait").classList.toggle("hidden", isHost);
}

function renderMpOver() {
  $("#mpWinnerName").textContent = mpGame.winner || t("game.nobody");
  const fs = $("#mpFinalScores");
  fs.innerHTML = "";
  const sorted = [...mpGame.players].sort((a, b) => b.timeline.length - a.timeline.length);
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span>${escapeHtml(p.name)}</span><strong>${p.timeline.length}</strong>`;
    fs.appendChild(row);
  }
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

async function runCameraEnvCheck() {
  _dbgLines = [];
  dbg(`UA: ${navigator.userAgent.slice(0, 80)}`);
  dbg(`mediaDevices: ${"mediaDevices" in navigator ? "YES" : "NO"}`);
  dbg(`getUserMedia: ${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? "YES" : "NO"}`);
  if (navigator.permissions) {
    try {
      const p = await navigator.permissions.query({ name: "camera" });
      dbg(`permissions API camera: ${p.state}`);
    } catch (e) {
      dbg(`permissions API: ${e.name} (${e.message})`);
    }
  } else {
    dbg("permissions API: not supported");
  }
  dbg(`protocol: ${location.protocol}`);
  dbg(`hostname: ${location.hostname}`);
}

async function startScanner() {
  showScreen("scanner");
  if (qrScanner) await stopScanner();
  $("#qrFileFallback").classList.add("hidden");
  $("#scanHint").textContent = t("free.cameraRetrying");

  await runCameraEnvCheck();

  // Step 1: use the native getUserMedia to get the browser to show its
  // camera permission prompt. html5-qrcode.start() silently resolves on
  // Firefox Mobile even when it didn't actually open the camera, so we
  // can't rely on it for the prompt.
  const attempts = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } },
    { video: { facingMode: "user" } },
    { video: true },
  ];

  let stream = null;
  for (let i = 0; i < attempts.length; i++) {
    const c = attempts[i];
    dbg(`getUserMedia attempt ${i + 1}/${attempts.length}: ${JSON.stringify(c)}`);
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      dbg(`✓ getUserMedia success — tracks: ${stream.getTracks().map(t => t.kind + "/" + t.label).join(", ")}`);
      break;
    } catch (e) {
      dbg(`✗ ${e.name}: ${e.message}`);
      if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        $("#scanHint").textContent = t("free.cameraError", { msg: "Camera access denied" });
        $("#qrFileFallback").classList.remove("hidden");
        return;
      }
    }
  }

  if (!stream) {
    dbg("All getUserMedia attempts failed → showing file fallback");
    $("#scanHint").textContent = t("free.cameraError", { msg: "No camera found" });
    $("#qrFileFallback").classList.remove("hidden");
    return;
  }

  // Step 2: permission confirmed — release probe stream, let html5-qrcode take over.
  stream.getTracks().forEach((t) => t.stop());
  dbg("Probe stream released. Starting html5-qrcode…");

  qrScanner = new Html5Qrcode("reader");
  try {
    await qrScanner.start(
      { facingMode: { ideal: "environment" } },
      { fps: 12, qrbox: { width: 240, height: 240 } },
      onQrDecoded,
      () => {}
    );
    dbg("✓ html5-qrcode started");
    $("#scanHint").textContent = t("free.scanHint");
  } catch (e) {
    dbg(`✗ html5-qrcode.start: ${e.name}: ${e.message}`);
    $("#scanHint").textContent = t("free.cameraError", { msg: e.message });
    $("#qrFileFallback").classList.remove("hidden");
    qrScanner = null;
  }
}

async function stopScanner() {
  if (!qrScanner) return;
  try { await qrScanner.stop(); } catch {}
  try { await qrScanner.clear(); } catch {}
  qrScanner = null;
}

// File-input fallback: decode a QR from a chosen image using Html5Qrcode.
async function handleQrFile(file) {
  if (!file) return;
  try {
    const result = await Html5Qrcode.scanFile(file, /* showImage= */ false);
    onQrDecoded(result);
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
    if (e.data === YT.PlayerState.PLAYING) {
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
  const worldCount = countPrintable(["world"]);
  const russiaCount = countPrintable(["russia", "ussr"]);
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
  $("#scanBtn").addEventListener("click", startScanner);
  $("#qrFileInput").addEventListener("change", (e) => handleQrFile(e.target.files[0]));
  $("#randomBtn").addEventListener("click", () => {
    const s = pickRandomVerified();
    if (s) freePlay(s);
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

  // Deep links:
  //   ?id=<song-id>  → free-play a specific song (scan flow w/ native camera)
  //   ?join=<code>   → jump straight to the join screen with the code prefilled
  const params = new URLSearchParams(location.search);
  const linkedId = params.get("id");
  if (linkedId) {
    const song = songsById.get(linkedId);
    if (song) freePlay(song);
  }
  const joinCode = (params.get("join") || "").trim().toUpperCase();
  if (/^[A-Z]{4}$/.test(joinCode)) {
    showScreen("mpJoin");
    $("#mpCodeInput").value = joinCode;
    // Focus the name field — they only need to fill that in.
    setTimeout(() => $("#mpNameInput").focus(), 50);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Auto-resume on reload. Deep-link join (?join=…) wins over auto-resume.
  if (!linkedId && !/^[A-Z]{4}$/.test(joinCode)) {
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
