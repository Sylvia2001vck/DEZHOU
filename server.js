import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const SEATS = 10;

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

// Serve the single-page frontend
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/readyz", (_req, res) => res.status(200).json({ ok: true }));

// Minimal request logging (helps debug Railway "failed to respond")
app.use((req, _res, next) => {
  // avoid noisy logs for socket polling
  if (!req.path.startsWith("/socket.io")) {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(__dirname));

/** @type {Map<string, Room>} */
const rooms = new Map();

function now() {
  return Date.now();
}

async function releaseRoom(room) {
  const rid = room.roomId;
  if (room.closeTimer) {
    try { clearTimeout(room.closeTimer); } catch (_) {}
    room.closeTimer = null;
  }
  try {
    // Evict all connected sockets from this room so they don't see stale state.
    const sockets = await io.in(rid).fetchSockets();
    for (const s of sockets) {
      try {
        s.data.roomId = null;
        s.data.seatIdx = null;
        s.data.voiceJoined = false;
        s.emit("room_closed", { roomId: rid, reason: "match_over" });
        s.leave(rid);
      } catch (_) {}
    }
  } catch (e) {
    console.warn("[releaseRoom] fetchSockets failed:", e?.message || e);
  }
  rooms.delete(rid);
}

function makeRoom(roomId) {
  /** @type {Room} */
  const room = {
    roomId,
    createdAt: now(),
    hostSocketId: null,
    seats: Array.from({ length: SEATS }, () => null),
    started: false,

    // settings (host-controlled)
    totalHands: 5,
    initialChips: 1000,
    smallBlind: 50,
    bigBlind: 100,

    // game state
    handNum: 0,
    dealerSeatIdx: 0,
    sbSeatIdx: null,
    bbSeatIdx: null,
    pot: 0,
    round: "WAITING", // WAITING | PRE-FLOP | FLOP | TURN | RIVER | SHOWDOWN
    communityCards: [],
    deck: [],
    currentMaxBet: 0,
    minRaise: 100,
    activeSeatIdx: null,
    pendingActionSeats: new Set(), // seatIdx that still must act to close action
    players: new Map(), // seatIdx -> PlayerState

    // processing
    turnNonce: 0,
    aiTimer: null,
    lastActorSeatIdx: null,

    // voice (signaling only; media is P2P)
    voice: {
      participants: new Map() // socketId -> { socketId, seatIdx, name }
    },

    // match summary
    handHistory: [], // [{handNum, winners:[{seatIdx,name}], desc}]
    closing: false,
    closeTimer: null,
    expectedAcks: new Set(),
    matchAcks: new Set()
  };
  return room;
}

function buildStandings(room) {
  const out = [];
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const p = getPlayer(room, i);
    const buyIn = p && Number.isFinite(p.totalBuyIn) ? p.totalBuyIn : (Number.isFinite(room.initialChips) ? room.initialChips : 1000);
    const chips = p ? p.chips : 0;
    out.push({
      seatIdx: i,
      type: seat.type,
      name: seat.name,
      chips,
      buyIn,
      net: chips - buyIn
    });
  }
  out.sort((a, b) => (b.chips || 0) - (a.chips || 0));
  return out;
}

async function emitMatchOverAndEnterClosing(room, reason) {
  // If already closing, don't re-emit
  if (room.closing) return;

  // stop any pending AI timers
  try { clearTimeout(room.aiTimer); } catch (_) {}
  room.aiTimer = null;

  if (reason) {
    try { broadcastActivity(room, String(reason)); } catch (_) {}
  }
  broadcastActivity(room, "Match over.");

  const standings = buildStandings(room);
  const hands = Array.isArray(room.handHistory) ? room.handHistory.slice(0) : [];
  io.to(room.roomId).emit("match_over", {
    roomId: room.roomId,
    totalHands: room.totalHands, // scheduled
    scheduledHands: room.totalHands,
    playedHands: hands.length,
    standings,
    hands
  });

  room.closing = true;
  room.started = false;
  room.round = "WAITING";
  room.activeSeatIdx = null;
  room.pendingActionSeats = new Set();

  // Track currently connected sockets for ack-based release
  room.expectedAcks = new Set();
  room.matchAcks = new Set();
  try {
    const socks = await io.in(room.roomId).fetchSockets();
    room.expectedAcks = new Set(socks.map((s) => s.id));
  } catch (_) {}
}

function seatToPublic(seat, seatIdx) {
  if (!seat) return null;
  if (seat.type === "ai") return { type: "ai", seatIdx, name: seat.name };
  return { type: "player", seatIdx, name: seat.name };
}

function getRoomSummary(room, forSocketId) {
  const hostSeatIdx = room.seats.findIndex(
    (s) => s && s.type === "player" && s.socketId === room.hostSocketId
  );
  return {
    roomId: room.roomId,
    hostSocketId: room.hostSocketId,
    hostSeatIdx: hostSeatIdx >= 0 ? hostSeatIdx : null,
    // broadcast 时不携带真假（否则会把 host 的 UI 覆盖成 false）；客户端用 hostSocketId vs socket.id 自行计算
    isHost: forSocketId ? forSocketId === room.hostSocketId : null,
    started: room.started,
    seats: room.seats.map((s, i) => seatToPublic(s, i)),
    settings: { totalHands: room.totalHands, initialChips: room.initialChips }
  };
}

function isSeatOccupied(room, seatIdx) {
  return !!room.seats[seatIdx];
}

function getPlayer(room, seatIdx) {
  return room.players.get(seatIdx) || null;
}

function isSeatEligible(room, seatIdx) {
  const seat = room.seats[seatIdx];
  if (!seat) return false;
  const p = getPlayer(room, seatIdx);
  if (!p) return false;
  return !p.isBankrupt && p.chips > 0;
}

function getInHandSeats(room) {
  const out = [];
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const p = getPlayer(room, i);
    if (!p) continue;
    if (!p.isFolded && !p.isBankrupt) out.push(i);
  }
  return out;
}

function getActableSeats(room) {
  const out = [];
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const p = getPlayer(room, i);
    if (!p) continue;
    if (!p.isFolded && !p.isBankrupt && p.chips > 0) out.push(i);
  }
  return out;
}

function nextSeatClockwise(room, fromSeatIdx, predicate) {
  for (let step = 1; step <= SEATS; step++) {
    const idx = (fromSeatIdx + step) % SEATS;
    if (predicate(idx)) return idx;
  }
  return null;
}

function getActiveOffset(room, startSeatIdx, offset) {
  let count = 0;
  let idx = startSeatIdx;
  let loops = 0;
  const maxLoops = SEATS * 3;
  while (count < offset && loops < maxLoops) {
    idx = (idx + 1) % SEATS;
    if (isSeatEligible(room, idx)) count++;
    loops++;
  }
  return idx;
}

function broadcastRoom(room) {
  io.to(room.roomId).emit("room_state", getRoomSummary(room, null));
}

function broadcastActivity(room, msg) {
  io.to(room.roomId).emit("activity", msg);
}

function broadcastPlayerAction(room, seatIdx, text) {
  io.to(room.roomId).emit("player_action", { seatIdx, text });
}

function broadcastGame(room) {
  const state = getPublicGameState(room);
  io.to(room.roomId).emit("game_state", state);
}

function getPublicGameState(room) {
  const players = [];
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const p = getPlayer(room, i);
    if (!p) continue;
    players.push({
      seatIdx: i,
      name: seat.name,
      type: seat.type,
      chips: p.chips,
      currentBet: p.currentBet,
      isFolded: p.isFolded,
      isBankrupt: p.isBankrupt,
      totalBuyIn: Number.isFinite(p.totalBuyIn) ? p.totalBuyIn : (Number.isFinite(room.initialChips) ? room.initialChips : 1000)
    });
  }
  return {
    roomId: room.roomId,
    started: room.started,
    settings: { totalHands: room.totalHands, initialChips: room.initialChips, smallBlind: room.smallBlind, bigBlind: room.bigBlind },
    handNum: room.handNum,
    dealerSeatIdx: room.dealerSeatIdx,
    sbSeatIdx: room.sbSeatIdx,
    bbSeatIdx: room.bbSeatIdx,
    activeSeatIdx: room.activeSeatIdx,
    pot: room.pot,
    round: room.round,
    communityCards: room.communityCards,
    currentMaxBet: room.currentMaxBet,
    minRaise: room.minRaise,
    players
  };
}

// --- Cards / Hand evaluation (ported from your frontend) ---
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["hearts", "diamonds", "clubs", "spades"];

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ s, r, v: RANKS.indexOf(r) });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function combinations(arr, k) {
  const results = [];
  const combine = (start, combo) => {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  };
  combine(0, []);
  return results;
}

function evaluate5(cards) {
  const sorted = [...cards].sort((a, b) => b.v - a.v);
  const ranks = sorted.map((c) => c.v);
  const suits = sorted.map((c) => c.s);
  const isFlush = suits.every((s) => s === suits[0]);

  // straight (with wheel)
  let isStraight = false;
  let straightMax = 0;
  const uniqueRanks = [...new Set(ranks)];
  if (uniqueRanks.length === 5) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true;
      straightMax = ranks[0];
    } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) {
      isStraight = true;
      straightMax = 5;
    }
  }

  const counts = {};
  ranks.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
  const freq = Object.values(counts).sort((a, b) => b - a);
  const rankByFreq = Object.keys(counts)
    .map(Number)
    .sort((a, b) => {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return b - a;
    });

  if (isFlush && isStraight) {
    if (straightMax === 14) return { rank: 10, value: [14], desc: "Royal Flush" };
    return { rank: 9, value: [straightMax], desc: "Straight Flush" };
  }
  if (freq[0] === 4) return { rank: 8, value: [rankByFreq[0], rankByFreq[1]], desc: "Four of a Kind" };
  if (freq[0] === 3 && freq[1] === 2) return { rank: 7, value: [rankByFreq[0], rankByFreq[1]], desc: "Full House" };
  if (isFlush) return { rank: 6, value: ranks, desc: "Flush" };
  if (isStraight) return { rank: 5, value: [straightMax], desc: "Straight" };
  if (freq[0] === 3) return { rank: 4, value: [rankByFreq[0], rankByFreq[1], rankByFreq[2]], desc: "Three of a Kind" };
  if (freq[0] === 2 && freq[1] === 2) return { rank: 3, value: [rankByFreq[0], rankByFreq[1], rankByFreq[2]], desc: "Two Pair" };
  if (freq[0] === 2) return { rank: 2, value: [rankByFreq[0], rankByFreq[1], rankByFreq[2], rankByFreq[3]], desc: "One Pair" };
  return { rank: 1, value: ranks, desc: "High Card" };
}

function compareHands(h1, h2) {
  if (h1.rank !== h2.rank) return h1.rank - h2.rank;
  for (let i = 0; i < h1.value.length; i++) {
    if (h1.value[i] !== h2.value[i]) return h1.value[i] - h2.value[i];
  }
  return 0;
}

function getBestHand(sevenCards) {
  const combos = combinations(sevenCards, 5);
  let best = null;
  for (const combo of combos) {
    const evalResult = evaluate5(combo);
    if (!best || compareHands(evalResult, best) > 0) best = evalResult;
  }
  return best;
}

// --- Game mechanics ---
function resetHand(room) {
  room.handNum += 1;
  room.pot = 0;
  room.round = "PRE-FLOP";
  room.communityCards = [];
  room.deck = freshDeck();
  room.currentMaxBet = 0;
  room.pendingActionSeats = new Set();
  room.turnNonce += 1;

  // Reset players
  for (const [seatIdx, p] of room.players.entries()) {
    p.hand = [];
    p.currentBet = 0;
    p.isFolded = p.chips <= 0;
    p.isBankrupt = p.chips <= 0;
  }
}

function ensurePlayersMap(room) {
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    if (!room.players.has(i)) {
      room.players.set(i, {
        seatIdx: i,
        chips: Number.isFinite(room.initialChips) ? room.initialChips : 1000,
        currentBet: 0,
        isFolded: false,
        isBankrupt: false,
        hand: [],
        totalBuyIn: Number.isFinite(room.initialChips) ? room.initialChips : 1000,
        pendingRebuy: 0
      });
    }
  }
  // Backfill fields for older rooms/players
  for (const p of room.players.values()) {
    if (!Number.isFinite(p.totalBuyIn)) p.totalBuyIn = Number.isFinite(room.initialChips) ? room.initialChips : 1000;
    if (!Number.isFinite(p.pendingRebuy)) p.pendingRebuy = 0;
  }
  // Remove players for emptied seats
  for (const seatIdx of [...room.players.keys()]) {
    if (!room.seats[seatIdx]) room.players.delete(seatIdx);
  }
}

function applyPendingRebuys(room) {
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat || seat.type !== "player") continue;
    const p = getPlayer(room, i);
    if (!p) continue;
    const pend = Number(p.pendingRebuy || 0);
    if (!Number.isFinite(pend) || pend <= 0) continue;
    p.chips += pend;
    p.pendingRebuy = 0;
    p.isBankrupt = false;
    p.isFolded = false;
    p.currentBet = 0;
    p.hand = [];
    broadcastActivity(room, `${seat.name} rebuys $${pend}.`);
  }
}

function postBlind(room, seatIdx, amount) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isBankrupt) return 0;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const real = Math.min(amt, p.chips);
  p.chips -= real;
  p.currentBet += real;
  room.pot += real;
  room.currentMaxBet = Math.max(room.currentMaxBet, p.currentBet);
  return real;
}

function dealHoleCards(room) {
  const eligibleSeats = [];
  for (let i = 0; i < SEATS; i++) {
    const seatIdx = (room.dealerSeatIdx + 1 + i) % SEATS;
    if (isSeatEligible(room, seatIdx)) eligibleSeats.push(seatIdx);
  }
  for (let round = 0; round < 2; round++) {
    for (const seatIdx of eligibleSeats) {
      const p = getPlayer(room, seatIdx);
      if (!p) continue;
      const card = room.deck.pop();
      p.hand.push(card);
    }
  }
}

function initPendingAction(room, startSeatIdx) {
  const actable = getActableSeats(room);
  room.pendingActionSeats = new Set(actable);
  room.activeSeatIdx = startSeatIdx;
}

function removeIneligibleFromPending(room) {
  for (const seatIdx of [...room.pendingActionSeats]) {
    const p = getPlayer(room, seatIdx);
    if (!p || p.isFolded || p.isBankrupt || p.chips <= 0) room.pendingActionSeats.delete(seatIdx);
  }
}

function chooseNextActor(room, fromSeatIdx) {
  removeIneligibleFromPending(room);
  if (room.pendingActionSeats.size === 0) return null;
  const nxt = nextSeatClockwise(room, fromSeatIdx, (idx) => room.pendingActionSeats.has(idx));
  return nxt;
}

function startHand(room) {
  ensurePlayersMap(room);
  applyPendingRebuys(room);

  const activeEligible = [];
  for (let i = 0; i < SEATS; i++) if (isSeatEligible(room, i)) activeEligible.push(i);
  if (activeEligible.length < 2) {
    // End match early (e.g. only one player has chips). Show summary instead of getting stuck in WAITING.
    void emitMatchOverAndEnterClosing(room, "Not enough players with chips to continue.");
    return;
  }

  resetHand(room); // increments handNum; only do this once we're sure the hand will actually start
  broadcastActivity(room, `--- HAND ${room.handNum} / ${room.totalHands} ---`);

  const sbSeat = getActiveOffset(room, room.dealerSeatIdx, 1);
  const bbSeat = getActiveOffset(room, room.dealerSeatIdx, 2);
  const utgSeat = getActiveOffset(room, room.dealerSeatIdx, 3);
  room.sbSeatIdx = sbSeat;
  room.bbSeatIdx = bbSeat;

  // blinds
  postBlind(room, sbSeat, room.smallBlind);
  postBlind(room, bbSeat, room.bigBlind);

  broadcastActivity(room, `${room.seats[sbSeat].name} posts SB $${room.smallBlind}`);
  broadcastActivity(room, `${room.seats[bbSeat].name} posts BB $${room.bigBlind}`);

  // deal
  dealHoleCards(room);

  // send private cards
  for (let i = 0; i < SEATS; i++) {
    const seat = room.seats[i];
    if (!seat || seat.type !== "player") continue;
    const p = getPlayer(room, i);
    if (!p) continue;
    io.to(seat.socketId).emit("private_hand", { seatIdx: i, hand: p.hand });
  }

  // betting setup
  room.currentMaxBet = Math.max(room.bigBlind, ...[...room.players.values()].map((p) => p.currentBet));
  room.minRaise = room.bigBlind;
  initPendingAction(room, utgSeat);

  broadcastGame(room);
  requestTurn(room);
}

function canAdvanceStreet(room) {
  removeIneligibleFromPending(room);
  if (room.pendingActionSeats.size !== 0) return false;
  return true;
}

function dealCommunity(room, n) {
  for (let i = 0; i < n; i++) {
    room.communityCards.push(room.deck.pop());
  }
}

function proceedToNextStreet(room) {
  // reset bets
  for (const p of room.players.values()) p.currentBet = 0;
  room.currentMaxBet = 0;

  if (room.round === "PRE-FLOP") {
    room.round = "FLOP";
    dealCommunity(room, 3);
  } else if (room.round === "FLOP") {
    room.round = "TURN";
    dealCommunity(room, 1);
  } else if (room.round === "TURN") {
    room.round = "RIVER";
    dealCommunity(room, 1);
  } else {
    room.round = "SHOWDOWN";
  }

  if (room.round === "SHOWDOWN") {
    finishHand(room);
    return;
  }

  // first to act postflop: seat after dealer
  const first = getActiveOffset(room, room.dealerSeatIdx, 1);
  initPendingAction(room, first);
  broadcastGame(room);
  requestTurn(room);
}

function finishHand(room) {
  // stop any pending AI timers
  clearTimeout(room.aiTimer);
  room.aiTimer = null;

  // freeze betting loop
  room.pendingActionSeats = new Set();
  room.activeSeatIdx = null;

  const inHand = getInHandSeats(room);
  const showdownHands = inHand
    .map((seatIdx) => {
      const p = getPlayer(room, seatIdx);
      const seat = room.seats[seatIdx];
      const hand = Array.isArray(p?.hand) ? p.hand.slice(0, 2) : [];
      return { seatIdx, name: seat?.name || `Seat-${seatIdx}`, hand };
    })
    .filter((x) => Array.isArray(x.hand) && x.hand.length >= 2);
  if (inHand.length === 0) {
    // This shouldn't normally happen; prefer awarding pot to last actor to avoid dead-end states.
    const fallbackSeat = Number.isInteger(room.lastActorSeatIdx) ? room.lastActorSeatIdx : null;
    const fallbackSeatValid =
      fallbackSeat !== null &&
      fallbackSeat !== undefined &&
      room.seats[fallbackSeat] &&
      getPlayer(room, fallbackSeat);

    if (fallbackSeatValid) {
      const wp = getPlayer(room, fallbackSeat);
      wp.chips += room.pot;
      const winnerName = room.seats[fallbackSeat].name;
      broadcastActivity(room, `Game Over. ${winnerName} wins (fallback: no active players).`);
      room.pot = 0;
      room.round = "HAND_OVER";
      io.to(room.roomId).emit("hand_over", {
        handNum: room.handNum,
        totalHands: room.totalHands,
        winners: [{ seatIdx: fallbackSeat, name: winnerName }],
        desc: "No active players (fallback)",
        showdownHands: showdownHands
      });
      room.handHistory.push({ handNum: room.handNum, winners: [{ seatIdx: fallbackSeat, name: winnerName }], desc: "No active players (fallback)" });
      broadcastGame(room);
      return;
    }

    broadcastActivity(room, "Hand ended (no active players).");
    room.pot = 0;
    room.round = "HAND_OVER";
    io.to(room.roomId).emit("hand_over", { handNum: room.handNum, totalHands: room.totalHands, winners: [], desc: "No active players" });
    room.handHistory.push({ handNum: room.handNum, winners: [], desc: "No active players" });
    broadcastGame(room);
    return;
  }
  if (inHand.length === 1) {
    const winnerSeat = inHand[0];
    const wp = getPlayer(room, winnerSeat);
    wp.chips += room.pot;
    const winnerName = room.seats[winnerSeat].name;
    broadcastActivity(room, `Game Over. ${winnerName} wins (all others folded)!`);
    room.pot = 0;
    room.round = "HAND_OVER";
    io.to(room.roomId).emit("hand_over", {
      handNum: room.handNum,
      totalHands: room.totalHands,
      winners: [{ seatIdx: winnerSeat, name: winnerName }],
      desc: "All others folded",
      showdownHands: showdownHands
    });
    room.handHistory.push({ handNum: room.handNum, winners: [{ seatIdx: winnerSeat, name: winnerName }], desc: "All others folded" });
    broadcastGame(room);
    return;
  }

  // if showdown but not 5 cards, deal remaining
  while (room.communityCards.length < 5) dealCommunity(room, 1);

  const evals = inHand.map((seatIdx) => {
    const p = getPlayer(room, seatIdx);
    return { seatIdx, best: getBestHand([...p.hand, ...room.communityCards]) };
  });
  evals.sort((a, b) => compareHands(b.best, a.best));
  const best = evals[0].best;
  const winners = evals.filter((e) => compareHands(e.best, best) === 0);
  const winAmount = Math.floor(room.pot / winners.length);
  for (const w of winners) {
    const wp = getPlayer(room, w.seatIdx);
    wp.chips += winAmount;
  }
  broadcastActivity(room, `Game Over. ${winners.map((w) => room.seats[w.seatIdx].name).join(" & ")} wins with ${best.desc}!`);
  room.pot = 0;
  room.round = "HAND_OVER";
  io.to(room.roomId).emit("hand_over", {
    handNum: room.handNum,
    totalHands: room.totalHands,
    winners: winners.map((w) => ({ seatIdx: w.seatIdx, name: room.seats[w.seatIdx].name })),
    desc: best.desc,
    showdownHands: showdownHands
  });
  room.handHistory.push({
    handNum: room.handNum,
    winners: winners.map((w) => ({ seatIdx: w.seatIdx, name: room.seats[w.seatIdx].name })),
    desc: best.desc
  });
  broadcastGame(room);
}

function requestTurn(room) {
  clearTimeout(room.aiTimer);

  // if only one left
  const inHand = getInHandSeats(room);
  if (inHand.length <= 1) {
    finishHand(room);
    return;
  }

  // if nobody can act (everyone all-in), fast-forward streets to showdown
  const actable = getActableSeats(room);
  if (actable.length === 0) {
    room.round = "SHOWDOWN";
    finishHand(room);
    return;
  }

  // ensure current active is something that still needs to act
  removeIneligibleFromPending(room);
  if (room.activeSeatIdx === null || room.activeSeatIdx === undefined || !room.pendingActionSeats.has(room.activeSeatIdx)) {
    const any = chooseNextActor(room, room.activeSeatIdx ?? room.dealerSeatIdx);
    room.activeSeatIdx = any;
  }
  if (room.activeSeatIdx === null || room.activeSeatIdx === undefined) {
    proceedToNextStreet(room);
    return;
  }

  broadcastGame(room);

  const seat = room.seats[room.activeSeatIdx];
  if (seat && seat.type === "ai") {
    // CRITICAL: capture seatIdx now; do NOT reference room.activeSeatIdx inside timeout
    const aiSeatIdx = room.activeSeatIdx;
    room.aiTimer = setTimeout(() => {
      // only act if it's still this AI's turn and seat is still AI
      if (room.activeSeatIdx !== aiSeatIdx) return;
      const s = room.seats[aiSeatIdx];
      if (!s || s.type !== "ai") return;
      aiAct(room, aiSeatIdx);
    }, 700);
  } else {
    // human: client will send action
    io.to(room.roomId).emit("turn", { activeSeatIdx: room.activeSeatIdx, turnNonce: room.turnNonce });
  }
}

function placeBet(room, seatIdx, amount) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isFolded || p.isBankrupt) return 0;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const real = Math.min(amt, p.chips);
  p.chips -= real;
  p.currentBet += real;
  room.pot += real;
  return real;
}

function handleAction(room, seatIdx, action) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isFolded || p.isBankrupt) return;
  if (room.activeSeatIdx !== seatIdx) return;

  // track last valid actor (used as a fallback in rare edge cases)
  room.lastActorSeatIdx = seatIdx;

  const callAmt = Math.max(0, room.currentMaxBet - p.currentBet);
  const actType = action.type;

  if (actType === "fold") {
    p.isFolded = true;
    broadcastActivity(room, `${room.seats[seatIdx].name} Folds.`);
    broadcastPlayerAction(room, seatIdx, "FOLD");
    room.pendingActionSeats.delete(seatIdx);
  } else if (actType === "check") {
    if (callAmt !== 0) return;
    broadcastActivity(room, `${room.seats[seatIdx].name} Checks.`);
    broadcastPlayerAction(room, seatIdx, "CHECK");
    room.pendingActionSeats.delete(seatIdx);
  } else if (actType === "call") {
    if (callAmt > 0) {
      placeBet(room, seatIdx, callAmt);
      broadcastActivity(room, `${room.seats[seatIdx].name} Calls.`);
      broadcastPlayerAction(room, seatIdx, `CALL ${callAmt}`);
    } else {
      broadcastActivity(room, `${room.seats[seatIdx].name} Checks.`);
      broadcastPlayerAction(room, seatIdx, "CHECK");
    }
    room.pendingActionSeats.delete(seatIdx);
  } else if (actType === "raise") {
    const raiseBy = Math.max(room.minRaise, Number(action.raiseBy || room.minRaise));
    const totalToPut = callAmt + raiseBy;
    placeBet(room, seatIdx, totalToPut);
    room.currentMaxBet = p.currentBet;
    // reset pending to everyone eligible except raiser
    const actable = getActableSeats(room);
    room.pendingActionSeats = new Set(actable);
    room.pendingActionSeats.delete(seatIdx);
    broadcastActivity(room, `${room.seats[seatIdx].name} Raises to ${p.currentBet}.`);
    broadcastPlayerAction(room, seatIdx, `RAISE ${p.currentBet}`);
  } else if (actType === "allin") {
    const all = p.chips;
    if (all <= 0) {
      room.pendingActionSeats.delete(seatIdx);
    } else {
      placeBet(room, seatIdx, all);
      if (p.currentBet > room.currentMaxBet) {
        room.currentMaxBet = p.currentBet;
        const actable = getActableSeats(room);
        room.pendingActionSeats = new Set(actable);
        room.pendingActionSeats.delete(seatIdx);
        broadcastActivity(room, `${room.seats[seatIdx].name} ALL-IN to ${p.currentBet}.`);
        broadcastPlayerAction(room, seatIdx, `ALL-IN ${p.currentBet}`);
      } else {
        broadcastActivity(room, `${room.seats[seatIdx].name} is ALL-IN!`);
        broadcastPlayerAction(room, seatIdx, "ALL-IN");
        room.pendingActionSeats.delete(seatIdx);
      }
    }
  }

  // if only one left, end immediately
  const inHand = getInHandSeats(room);
  if (inHand.length <= 1) {
    finishHand(room);
    return;
  }

  // remove ineligible pending and decide next
  removeIneligibleFromPending(room);
  if (canAdvanceStreet(room)) {
    proceedToNextStreet(room);
    return;
  }

  const next = chooseNextActor(room, seatIdx);
  room.activeSeatIdx = next;
  requestTurn(room);
}

function aiAct(room, seatIdx) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isFolded || p.isBankrupt) {
    room.pendingActionSeats.delete(seatIdx);
    const next = chooseNextActor(room, seatIdx);
    room.activeSeatIdx = next;
    requestTurn(room);
    return;
  }
  const callAmt = Math.max(0, room.currentMaxBet - p.currentBet);
  const r = Math.random();
  if (callAmt > 0 && r > 0.85) {
    handleAction(room, seatIdx, { type: "fold" });
    return;
  }
  if (r > 0.7 && p.chips > callAmt + room.minRaise) {
    handleAction(room, seatIdx, { type: "raise", raiseBy: room.minRaise });
    return;
  }
  if (callAmt > 0) handleAction(room, seatIdx, { type: "call" });
  else handleAction(room, seatIdx, { type: "check" });
}

// --- Socket.io wiring ---
io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.data.seatIdx = null;
  socket.data.name = null;
  socket.data.voiceJoined = false;

  function emitYouState(room) {
    if (!room) return;
    socket.emit("you_state", {
      roomId: room.roomId,
      seatIdx: Number.isInteger(socket.data.seatIdx) ? socket.data.seatIdx : -1,
      isHost: socket.id === room.hostSocketId
    });
  }

  socket.on("join_room", ({ roomId, name }) => {
    const rid = String(roomId || "").trim();
    const nm = String(name || "").trim() || "Player";
    if (!rid) return;

    let room = rooms.get(rid);
    if (!room) {
      room = makeRoom(rid);
      rooms.set(rid, room);
    }
    if (room.closing) {
      socket.emit("error_msg", { msg: "This room has ended and is closing. Please rejoin in a moment (or use a new Room ID)." });
      return;
    }
    // If a match is already running in this room, do not allow new joins.
    if (room.started) {
      socket.emit("error_msg", { msg: "Game already started in this room. Please wait for it to finish or use a new Room ID." });
      return;
    }
    // host 选举：如果没有 host 或 host socket 已不在线，则把当前加入者设为 host
    const hostOnline = room.hostSocketId && io.sockets.sockets.has(room.hostSocketId);
    if (!room.hostSocketId || !hostOnline) room.hostSocketId = socket.id;

    socket.join(rid);
    socket.data.roomId = rid;
    socket.data.name = nm;

    socket.emit("room_state", getRoomSummary(room, socket.id));
    emitYouState(room);
    broadcastRoom(room);
    broadcastGame(room);
  });

  // ---- Voice signaling (WebRTC; audio is P2P) ----
  socket.on("voice_join", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    // Require seat to join voice to avoid spectators joining voice channel.
    const seatIdx = socket.data.seatIdx;
    if (!Number.isInteger(seatIdx) || seatIdx < 0 || seatIdx >= SEATS) return;
    const seat = room.seats[seatIdx];
    if (!seat || seat.type !== "player" || seat.socketId !== socket.id) return;

    const name = socket.data.name || seat.name || "Player";
    room.voice.participants.set(socket.id, { socketId: socket.id, seatIdx, name });
    socket.data.voiceJoined = true;

    const peers = [...room.voice.participants.values()].filter((p) => p.socketId !== socket.id);
    socket.emit("voice_peers", { peers });
    socket.to(rid).emit("voice_peer_joined", { peer: { socketId: socket.id, seatIdx, name } });
  });

  socket.on("voice_leave", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (!room.voice.participants.has(socket.id)) return;
    room.voice.participants.delete(socket.id);
    socket.data.voiceJoined = false;
    socket.to(rid).emit("voice_peer_left", { socketId: socket.id });
  });

  socket.on("voice_signal", ({ to, data }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (!socket.data.voiceJoined) return;
    if (!room.voice.participants.has(socket.id)) return;
    if (!to || typeof to !== "string") return;
    if (!room.voice.participants.has(to)) return;
    io.to(to).emit("voice_signal", { from: socket.id, data });
  });

  socket.on("take_seat", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || room.started || room.closing) return;

    const idx = Number(seatIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
    if (isSeatOccupied(room, idx) && room.seats[idx]?.socketId !== socket.id) return;

    // clear old seat
    for (let i = 0; i < SEATS; i++) {
      const s = room.seats[i];
      if (s && s.type === "player" && s.socketId === socket.id) room.seats[i] = null;
    }

    room.seats[idx] = { type: "player", socketId: socket.id, name: socket.data.name || "Player" };
    socket.data.seatIdx = idx;
    socket.emit("seat_taken", { seatIdx: idx });
    emitYouState(room);
    ensurePlayersMap(room);
    broadcastRoom(room);
    broadcastGame(room);
  });

  socket.on("toggle_ai", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || room.started || room.closing) return;
    if (socket.id !== room.hostSocketId) return;

    const idx = Number(seatIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
    const seat = room.seats[idx];
    if (seat && seat.type === "player") return;
    if (seat && seat.type === "ai") {
      room.seats[idx] = null;
      room.players.delete(idx);
    } else {
      room.seats[idx] = { type: "ai", name: `AI-${idx}` };
      ensurePlayersMap(room);
    }
    broadcastRoom(room);
    broadcastGame(room);
  });

  socket.on("kick_seat", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;
    if (room.started || room.closing) return; // 只允许在等待/选座阶段踢人

    const idx = Number(seatIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
    const seat = room.seats[idx];
    if (!seat || seat.type !== "player") return;

    // 通知被踢的人（如果还在线）
    if (seat.socketId && io.sockets.sockets.has(seat.socketId)) {
      io.to(seat.socketId).emit("kicked", { seatIdx: idx });
    }

    room.seats[idx] = null;
    room.players.delete(idx);

    broadcastRoom(room);
    broadcastGame(room);
  });

  socket.on("start_game", ({ totalHands, initialChips }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;
    if (room.started || room.closing) return;

    const occ = room.seats.filter(Boolean).length;
    if (occ < 3) {
      socket.emit("error_msg", { msg: "At least 3 players (including AI) are needed to start!" });
      return;
    }

    room.totalHands = Math.max(1, Math.min(50, Number(totalHands || 5)));
    room.initialChips = Math.max(1000, Number(initialChips || 1000));
    if (!Number.isFinite(room.totalHands)) room.totalHands = 5;
    if (!Number.isFinite(room.initialChips)) room.initialChips = 1000;
    room.started = true;
    room.handNum = 0;
    room.dealerSeatIdx = 0;
    ensurePlayersMap(room);
    broadcastRoom(room);
    startHand(room);
  });

  socket.on("action", (payload) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started) return;
    const seatIdx = socket.data.seatIdx;
    if (seatIdx === null || seatIdx === undefined) return;
    handleAction(room, seatIdx, payload || {});
  });

  // ---- Rebuy (players can request; host approves) ----
  // Fast rebuy: player directly adds pending chips for next hand (no host approval).
  // This matches the UX: busted player sees a prompt, enters amount, re-enters next hand.
  socket.on("rebuy", ({ amount }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started || room.closing) return;
    const seatIdx = socket.data.seatIdx;
    if (!Number.isInteger(seatIdx) || seatIdx < 0 || seatIdx >= SEATS) return;
    const seat = room.seats[seatIdx];
    if (!seat || seat.type !== "player" || seat.socketId !== socket.id) return;
    const p = getPlayer(room, seatIdx);
    if (!p) return;
    if (p.chips > 0) return; // only when busted

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 1000 || amt % 50 !== 0) {
      socket.emit("error_msg", { msg: "Rebuy amount must be >= 1000 and a multiple of 50." });
      return;
    }

    p.pendingRebuy = Number(p.pendingRebuy || 0) + amt;
    p.totalBuyIn = Number(p.totalBuyIn || (Number.isFinite(room.initialChips) ? room.initialChips : 1000)) + amt;
    broadcastActivity(room, `${seat.name} rebuys $${amt} (applies next hand).`);
    broadcastGame(room);
  });

  socket.on("rebuy_request", ({ amount }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started || room.closing) return;
    const seatIdx = socket.data.seatIdx;
    if (!Number.isInteger(seatIdx) || seatIdx < 0 || seatIdx >= SEATS) return;
    const seat = room.seats[seatIdx];
    if (!seat || seat.type !== "player" || seat.socketId !== socket.id) return;
    const p = getPlayer(room, seatIdx);
    if (!p) return;
    if (p.chips > 0) return; // only when busted

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 1000 || amt % 50 !== 0) {
      socket.emit("error_msg", { msg: "Rebuy amount must be >= 1000 and a multiple of 50." });
      return;
    }
    if (!room.hostSocketId || !io.sockets.sockets.has(room.hostSocketId)) {
      socket.emit("error_msg", { msg: "Host is offline. Cannot approve rebuy right now." });
      return;
    }
    io.to(room.hostSocketId).emit("rebuy_requested", { seatIdx, name: seat.name, amount: amt });
  });

  socket.on("rebuy_approve", ({ seatIdx, amount }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started || room.closing) return;
    if (socket.id !== room.hostSocketId) return;
    const idx = Number(seatIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
    const seat = room.seats[idx];
    if (!seat || seat.type !== "player") return;
    const p = getPlayer(room, idx);
    if (!p) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 1000 || amt % 50 !== 0) return;

    p.pendingRebuy = Number(p.pendingRebuy || 0) + amt;
    p.totalBuyIn = Number(p.totalBuyIn || (Number.isFinite(room.initialChips) ? room.initialChips : 1000)) + amt;
    broadcastActivity(room, `${seat.name} rebuy approved: $${amt} (applies next hand).`);
    broadcastGame(room);
  });

  socket.on("rebuy_deny", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started || room.closing) return;
    if (socket.id !== room.hostSocketId) return;
    const idx = Number(seatIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
    const seat = room.seats[idx];
    if (!seat || seat.type !== "player") return;
    if (seat.socketId && io.sockets.sockets.has(seat.socketId)) {
      io.to(seat.socketId).emit("rebuy_denied", { msg: "Rebuy denied by host." });
    }
    broadcastActivity(room, `${seat.name} rebuy denied.`);
  });

  socket.on("next_hand", async () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started) return;
    if (socket.id !== room.hostSocketId) return;

    if (room.pot !== 0) return;
    if (room.handNum >= room.totalHands) {
      await emitMatchOverAndEnterClosing(room);
      return;
    }

    room.dealerSeatIdx = (room.dealerSeatIdx + 1) % SEATS;
    startHand(room);
  });

  socket.on("ack_match_over", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.closing) return;
    room.matchAcks.add(socket.id);
    // If all currently-connected sockets acknowledged, release immediately.
    let all = true;
    for (const sid of room.expectedAcks) {
      if (!room.matchAcks.has(sid)) {
        all = false;
        break;
      }
    }
    if (all) {
      releaseRoom(room);
    }
  });

  socket.on("disconnect", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    // match-over ack set maintenance
    if (room.closing && room.expectedAcks?.has(socket.id)) {
      room.expectedAcks.delete(socket.id);
      room.matchAcks.delete(socket.id);
      // if no one left to ack, release now
      if (room.expectedAcks.size === 0) {
        releaseRoom(room);
        return;
      }
    }

    // voice cleanup
    if (room.voice?.participants?.has(socket.id)) {
      room.voice.participants.delete(socket.id);
      socket.to(rid).emit("voice_peer_left", { socketId: socket.id });
    }

    // free seat
    for (let i = 0; i < SEATS; i++) {
      const s = room.seats[i];
      if (s && s.type === "player" && s.socketId === socket.id) {
        room.seats[i] = null;
        room.players.delete(i);
      }
    }

    // host migration
    if (room.hostSocketId === socket.id) {
      const nextHost = room.seats.find((s) => s && s.type === "player");
      room.hostSocketId = nextHost ? nextHost.socketId : null;
    }

    if (room.seats.every((s) => !s)) {
      rooms.delete(rid);
      return;
    }

    broadcastRoom(room);
    broadcastGame(room);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`nebula-poker listening on 0.0.0.0:${PORT}`);
});

/**
 * @typedef {{type:'player', socketId:string, name:string} | {type:'ai', name:string} | null} Seat
 * @typedef {{seatIdx:number, chips:number, currentBet:number, isFolded:boolean, isBankrupt:boolean, hand:Array<any>}} PlayerState
 * @typedef {{
 *   roomId:string,
 *   createdAt:number,
 *   hostSocketId:string|null,
 *   seats:Seat[],
 *   started:boolean,
 *   totalHands:number,
 *   initialChips:number,
 *   handNum:number,
 *   dealerSeatIdx:number,
 *   pot:number,
 *   round:string,
 *   communityCards:any[],
 *   deck:any[],
 *   currentMaxBet:number,
 *   minRaise:number,
 *   activeSeatIdx:number|null,
 *   pendingActionSeats:Set<number>,
 *   players:Map<number, PlayerState>,
 *   turnNonce:number,
 *   aiTimer:any
 * }} Room
 */


