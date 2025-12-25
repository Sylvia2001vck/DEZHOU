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
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(__dirname));

/** @type {Map<string, Room>} */
const rooms = new Map();

function now() {
  return Date.now();
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

    // game state
    handNum: 0,
    dealerSeatIdx: 0,
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
    aiTimer: null
  };
  return room;
}

function seatToPublic(seat, seatIdx) {
  if (!seat) return null;
  if (seat.type === "ai") return { type: "ai", seatIdx, name: seat.name };
  return { type: "player", seatIdx, name: seat.name };
}

function getRoomSummary(room, forSocketId) {
  return {
    roomId: room.roomId,
    hostSocketId: room.hostSocketId,
    isHost: forSocketId === room.hostSocketId,
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
      isBankrupt: p.isBankrupt
    });
  }
  return {
    roomId: room.roomId,
    started: room.started,
    settings: { totalHands: room.totalHands, initialChips: room.initialChips },
    handNum: room.handNum,
    dealerSeatIdx: room.dealerSeatIdx,
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
        chips: room.initialChips,
        currentBet: 0,
        isFolded: false,
        isBankrupt: false,
        hand: []
      });
    }
  }
  // Remove players for emptied seats
  for (const seatIdx of [...room.players.keys()]) {
    if (!room.seats[seatIdx]) room.players.delete(seatIdx);
  }
}

function postBlind(room, seatIdx, amount) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isBankrupt) return 0;
  const real = Math.min(amount, p.chips);
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
  resetHand(room);

  const activeEligible = [];
  for (let i = 0; i < SEATS; i++) if (isSeatEligible(room, i)) activeEligible.push(i);
  if (activeEligible.length < 2) {
    room.round = "WAITING";
    room.started = false;
    broadcastActivity(room, "Not enough players with chips to continue.");
    broadcastRoom(room);
    broadcastGame(room);
    return;
  }

  const sbSeat = getActiveOffset(room, room.dealerSeatIdx, 1);
  const bbSeat = getActiveOffset(room, room.dealerSeatIdx, 2);
  const utgSeat = getActiveOffset(room, room.dealerSeatIdx, 3);

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
  const inHand = getInHandSeats(room);
  if (inHand.length === 0) {
    broadcastActivity(room, "Hand ended (no active players).");
    room.pot = 0;
    broadcastGame(room);
    return;
  }
  if (inHand.length === 1) {
    const winnerSeat = inHand[0];
    const wp = getPlayer(room, winnerSeat);
    wp.chips += room.pot;
    broadcastActivity(room, `Game Over. ${room.seats[winnerSeat].name} wins (all others folded)!`);
    room.pot = 0;
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
  if (!room.activeSeatIdx || !room.pendingActionSeats.has(room.activeSeatIdx)) {
    const any = chooseNextActor(room, room.activeSeatIdx ?? room.dealerSeatIdx);
    room.activeSeatIdx = any;
  }
  if (!room.activeSeatIdx) {
    proceedToNextStreet(room);
    return;
  }

  broadcastGame(room);

  const seat = room.seats[room.activeSeatIdx];
  if (seat && seat.type === "ai") {
    room.aiTimer = setTimeout(() => {
      aiAct(room, room.activeSeatIdx);
    }, 700);
  } else {
    // human: client will send action
    io.to(room.roomId).emit("turn", { activeSeatIdx: room.activeSeatIdx, turnNonce: room.turnNonce });
  }
}

function placeBet(room, seatIdx, amount) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isFolded || p.isBankrupt) return 0;
  const real = Math.min(amount, p.chips);
  p.chips -= real;
  p.currentBet += real;
  room.pot += real;
  return real;
}

function handleAction(room, seatIdx, action) {
  const p = getPlayer(room, seatIdx);
  if (!p || p.isFolded || p.isBankrupt) return;
  if (room.activeSeatIdx !== seatIdx) return;

  const callAmt = Math.max(0, room.currentMaxBet - p.currentBet);
  const actType = action.type;

  if (actType === "fold") {
    p.isFolded = true;
    broadcastActivity(room, `${room.seats[seatIdx].name} Folds.`);
    room.pendingActionSeats.delete(seatIdx);
  } else if (actType === "check") {
    if (callAmt !== 0) return;
    broadcastActivity(room, `${room.seats[seatIdx].name} Checks.`);
    room.pendingActionSeats.delete(seatIdx);
  } else if (actType === "call") {
    if (callAmt > 0) {
      placeBet(room, seatIdx, callAmt);
      broadcastActivity(room, `${room.seats[seatIdx].name} Calls.`);
    } else {
      broadcastActivity(room, `${room.seats[seatIdx].name} Checks.`);
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
      } else {
        broadcastActivity(room, `${room.seats[seatIdx].name} is ALL-IN!`);
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

  socket.on("join_room", ({ roomId, name }) => {
    const rid = String(roomId || "").trim();
    const nm = String(name || "").trim() || "Player";
    if (!rid) return;

    let room = rooms.get(rid);
    if (!room) {
      room = makeRoom(rid);
      rooms.set(rid, room);
    }
    if (!room.hostSocketId) room.hostSocketId = socket.id;

    socket.join(rid);
    socket.data.roomId = rid;
    socket.data.name = nm;

    socket.emit("room_state", getRoomSummary(room, socket.id));
    broadcastRoom(room);
    broadcastGame(room);
  });

  socket.on("take_seat", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || room.started) return;

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
    ensurePlayersMap(room);
    broadcastRoom(room);
    broadcastGame(room);
  });

  socket.on("toggle_ai", ({ seatIdx }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || room.started) return;
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

  socket.on("start_game", ({ totalHands, initialChips }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;
    if (room.started) return;

    const occ = room.seats.filter(Boolean).length;
    if (occ < 3) {
      socket.emit("error_msg", { msg: "At least 3 players (including AI) are needed to start!" });
      return;
    }

    room.totalHands = Math.max(1, Math.min(50, Number(totalHands || 5)));
    room.initialChips = Math.max(1000, Number(initialChips || 1000));
    room.started = true;
    room.handNum = 0;
    room.dealerSeatIdx = 0;
    ensurePlayersMap(room);
    broadcastRoom(room);

    broadcastActivity(room, `--- HAND 1 / ${room.totalHands} ---`);
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

  socket.on("next_hand", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room || !room.started) return;
    if (socket.id !== room.hostSocketId) return;

    if (room.pot !== 0) return;
    if (room.handNum >= room.totalHands) {
      broadcastActivity(room, "Match over.");
      room.started = false;
      room.round = "WAITING";
      broadcastRoom(room);
      broadcastGame(room);
      return;
    }

    room.dealerSeatIdx = (room.dealerSeatIdx + 1) % SEATS;
    broadcastActivity(room, `--- HAND ${room.handNum + 1} / ${room.totalHands} ---`);
    startHand(room);
  });

  socket.on("disconnect", () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

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

server.listen(PORT, () => {
  console.log(`nebula-poker listening on :${PORT}`);
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


