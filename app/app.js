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
let mpGame = null;     // { role, peer, ... } — populated on host or join
let mpYtPlayer = null; // host-only audio player (separate iframe)

function randomCode(len = 4) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

// ─── HOST ───
async function startHosting() {
  const code = randomCode();
  const peerId = MP_PREFIX + code;
  const peer = new Peer(peerId, { debug: 1 });

  mpGame = {
    role: "host",
    peer,
    code,
    myPeerId: peerId,
    hostPeerId: peerId,
    connections: new Map(), // peerId -> DataConnection (excludes host self)
    players: [], // will include host as first entry once we know host name
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

  $("#mpHostCode").textContent = "…";
  showScreen("mpHostLobby");

  peer.on("open", (id) => {
    $("#mpHostCode").textContent = code;
    // Ask host for their name (use a default for now — they can edit it).
    const hostName = prompt("Your name (host):", "Host") || "Host";
    mpGame.players.push({
      peerId: id,
      name: hostName,
      timeline: [],
      isHost: true,
    });
    renderMpHostLobby();
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      // ~1/500k odds even after collision-prone chars excluded, but handle it.
      alert(`Code ${code} is taken — picking a new one.`);
      peer.destroy();
      mpGame = null;
      startHosting();
      return;
    }
    console.warn("PeerJS host error:", err);
    alert("Connection error: " + (err.type || err.message || err));
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
      // Add player if not already present (might be a re-join).
      if (!mpGame.players.find((p) => p.peerId === conn.peer)) {
        mpGame.players.push({ peerId: conn.peer, name, timeline: [] });
      }
      renderMpHostLobby();
      mpBroadcast();
      break;
    }
    case "lockIn": {
      // Only honour from the player whose turn it is.
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
  };
}

async function mpStartGame() {
  if (mpGame.players.length < 2) {
    alert("Need at least 2 players to start.");
    return;
  }
  mpGame.targetScore = parseInt($("#mpTargetScore").value, 10);
  mpGame.regions = $$("#mpRegionGrid input:checked").map((cb) => cb.value);
  if (mpGame.regions.length === 0) {
    alert("Pick at least one region.");
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
  mpBroadcast();
  if (mpYtPlayer && mpYtPlayer.loadVideoById) {
    try { mpYtPlayer.loadVideoById({ videoId: song.youtube_id }); } catch {}
    try { mpYtPlayer.unMute(); mpYtPlayer.setVolume(80); } catch {}
  }
}

function mpRevealAndScore() {
  if (mpGame.role !== "host") return;
  if (!mpGame.currentSong) return;
  if (mpYtPlayer && mpYtPlayer.pauseVideo) try { mpYtPlayer.pauseVideo(); } catch {}

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
    let best = -1, name = "Nobody";
    for (const p of mpGame.players) {
      if (p.timeline.length > best) { best = p.timeline.length; name = p.name; }
    }
    mpGame.winner = name;
  }
  mpGame.phase = "over";
  mpBroadcast();
}

function mpHostQuit() {
  if (!confirm("End the multiplayer game?")) return;
  if (mpGame && mpGame.peer) try { mpGame.peer.destroy(); } catch {}
  if (mpYtPlayer && mpYtPlayer.stopVideo) try { mpYtPlayer.stopVideo(); } catch {}
  mpGame = null;
  showScreen("home");
}

// ─── PLAYER ───
async function joinAsPlayer() {
  const codeInput = $("#mpCodeInput").value.trim().toUpperCase();
  const name = $("#mpNameInput").value.trim() || "Player";
  if (!/^[A-Z]{4}$/.test(codeInput)) {
    $("#mpJoinStatus").textContent = "Code should be 4 letters.";
    return;
  }
  $("#mpJoinStatus").textContent = "Connecting…";
  const targetId = MP_PREFIX + codeInput;
  const peer = new Peer(undefined, { debug: 1 }); // random self ID

  peer.on("open", (myId) => {
    const conn = peer.connect(targetId, { reliable: true });
    let opened = false;
    const timeout = setTimeout(() => {
      if (!opened) {
        $("#mpJoinStatus").textContent = "Couldn't reach host. Check the code.";
        try { conn.close(); } catch {}
        try { peer.destroy(); } catch {}
      }
    }, 8000);
    conn.on("open", () => {
      opened = true;
      clearTimeout(timeout);
      mpGame = {
        role: "player",
        peer,
        hostConn: conn,
        myPeerId: myId,
        hostPeerId: targetId,
        code: codeInput,
        phase: "lobby",
        players: [],
        targetScore: 10,
        turnIdx: 0,
        revealedSong: null,
        lastCorrect: null,
        winner: null,
        myName: name,
        selectedSlot: null, // local only
      };
      conn.send({ type: "join", name });
      showScreen("mpPlayerLobby");
      renderMpScreen();
    });
    conn.on("data", (msg) => handleMessageFromHost(msg));
    conn.on("close", () => {
      alert("Host disconnected.");
      mpGame = null;
      showScreen("home");
    });
    conn.on("error", (e) => {
      console.warn("conn error", e);
      $("#mpJoinStatus").textContent = "Connection error: " + (e.type || e.message);
    });
  });

  peer.on("error", (err) => {
    $("#mpJoinStatus").textContent = "Error: " + (err.type || err.message);
    if (err.type === "peer-unavailable") {
      $("#mpJoinStatus").textContent = "No game with that code is running.";
    }
  });
}

function handleMessageFromHost(msg) {
  if (!mpGame || mpGame.role !== "player") return;
  if (msg.type === "state") {
    const prevPhase = mpGame.phase;
    Object.assign(mpGame, msg.state);
    // When the turn changes back to "place", clear our local selection.
    if (msg.state.phase === "place" && prevPhase !== "place") {
      mpGame.selectedSlot = null;
    }
    renderMpScreen();
  }
}

function mpPlayerQuit() {
  if (!confirm("Leave the game?")) return;
  if (mpGame && mpGame.peer) try { mpGame.peer.destroy(); } catch {}
  mpGame = null;
  showScreen("home");
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
      <span class="role">${p.isHost ? "host" : ""}${p.peerId === mpGame.myPeerId ? " · you" : ""}</span>`;
    list.appendChild(row);
  }
  $("#mpStartBtn").disabled = mpGame.players.length < 2;
  $("#mpTargetScoreVal").textContent = $("#mpTargetScore").value;
}

function renderMpPlayerLobby() {
  $("#mpYouAre").textContent = mpGame.myName ? `You: ${mpGame.myName}` : "Connected";
  const list = $("#mpClientPlayers");
  list.innerHTML = "";
  for (const p of mpGame.players) {
    const row = document.createElement("div");
    row.className = "player-row" + (p.peerId === mpGame.myPeerId ? " you" : "");
    row.innerHTML = `
      <span style="flex:1">${escapeHtml(p.name)}</span>
      <span class="role">${p.isHost ? "host" : ""}${p.peerId === mpGame.myPeerId ? " · you" : ""}</span>`;
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
    ? "Tap where this song fits in your timeline."
    : `Waiting for ${cur ? cur.name : "…"} to place the card.`;

  // Each phone always shows ITS OWN timeline. When it's not your turn the
  // slot buttons are inert — you're just watching.
  const me = mpGame.players.find((p) => p.peerId === mpGame.myPeerId);
  const tl = me ? me.timeline : [];
  const slotsClickable = isMyTurn;

  const tlEl = $("#mpTimeline");
  tlEl.innerHTML = "";
  if (tl.length === 0) {
    tlEl.appendChild(mpMakeSlotEl(0, "Place anywhere (first card is always correct)", slotsClickable));
  } else {
    tlEl.appendChild(mpMakeSlotEl(0, `Before ${tl[0].year}`, slotsClickable));
    for (let i = 0; i < tl.length; i++) {
      tlEl.appendChild(mpMakeCardEl(tl[i]));
      const label = i < tl.length - 1
        ? `Between ${tl[i].year} and ${tl[i + 1].year}`
        : `After ${tl[i].year}`;
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
  el.innerHTML = `
    <div class="y">${card.year}</div>
    <div class="meta">
      <strong>${escapeHtml(card.artist)}</strong>
      <span class="muted">${escapeHtml(card.title)}</span>
    </div>`;
  return el;
}

function mpDescribePlacement(tl) {
  if (mpGame.selectedSlot === null) return "Pick a slot, then lock in.";
  if (tl.length === 0) return "Anywhere works for the first card.";
  const i = mpGame.selectedSlot;
  if (i === 0) return `You think it's before ${tl[0].year}.`;
  if (i === tl.length) return `You think it's after ${tl[tl.length - 1].year}.`;
  return `You think it's between ${tl[i - 1].year} and ${tl[i].year}.`;
}

function renderMpReveal() {
  const cur = mpGame.players[mpGame.turnIdx];
  const song = (mpGame.role === "host") ? mpGame.currentSong : mpGame.revealedSong;
  if (!song) return; // shouldn't happen
  $("#mpRevealYear").textContent   = song.year;
  $("#mpRevealArtist").textContent = song.artist;
  $("#mpRevealTitle").textContent  = song.title;
  $("#mpRevealRegion").textContent = REGION_LABEL[song.region] || song.region;
  const rr = $("#mpRevealResult");
  const correct = mpGame.lastCorrect;
  rr.textContent = correct ? `✓ ${cur.name} keeps the card` : `✗ ${cur.name} misses`;
  rr.classList.toggle("good", correct);
  rr.classList.toggle("bad", !correct);
  const isHost = mpGame.role === "host";
  $("#mpContinueBtn").classList.toggle("hidden", !isHost);
  $("#mpContinueWait").classList.toggle("hidden", isHost);
}

function renderMpOver() {
  $("#mpWinnerName").textContent = mpGame.winner || "Nobody";
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
  $("#hostBtn").addEventListener("click", startHosting);
  $("#joinBtn").addEventListener("click", () => {
    $("#mpJoinStatus").textContent = "";
    $("#mpCodeInput").value = "";
    $("#mpNameInput").value = "";
    showScreen("mpJoin");
  });
  $("#mpJoinBtn").addEventListener("click", joinAsPlayer);
  $("#mpStartBtn").addEventListener("click", mpStartGame);
  $("#mpTargetScore").addEventListener("input", (e) => {
    $("#mpTargetScoreVal").textContent = e.target.value;
  });
  $("#mpHostQuitBtn").addEventListener("click", mpHostQuit);
  $("#mpPlayerQuitBtn").addEventListener("click", mpPlayerQuit);
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
