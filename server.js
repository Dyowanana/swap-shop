const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

// Every item that can be in a game. The host picks which ones and how many of each.
const CATALOG = [
  { e: '🍎', name: 'Apple' }, { e: '🐟', name: 'Fish' }, { e: '🌽', name: 'Corn' },
  { e: '🍯', name: 'Honey' }, { e: '🥚', name: 'Egg' }, { e: '🧶', name: 'Wool' },
  { e: '🪵', name: 'Wood' }, { e: '🐔', name: 'Chicken' }, { e: '💎', name: 'Diamond' },
  { e: '🪙', name: 'Gold' }, { e: '🐄', name: 'Cow' }, { e: '🥛', name: 'Milk' },
];
const ITEMS = CATALOG.map((c) => c.e);
const PER_PLAYER = 8; // used by "auto" to size the item pool to the class
const START_CASH = 20;
const setPoints = (n) => (n >= 2 ? (5 * n * (n - 1)) / 2 : 0); // 2=5, 3=15, 4=30, 5=50, 6=75...
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 300;

const rooms = {}; // code -> room

const rand = (n) => Math.floor(Math.random() * n);
const newCode = () => {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do c = Array.from({ length: 4 }, () => L[rand(L.length)]).join('');
  while (rooms[c]);
  return c;
};
const uid = () => Math.random().toString(36).slice(2, 10);

function score(p, withCash) {
  const counts = {};
  p.hand.forEach((i) => (counts[i] = (counts[i] || 0) + 1));
  let s = 0;
  for (const n of Object.values(counts)) s += setPoints(n);
  return s + (withCash ? p.cash : 0);
}

function autoCounts(room) {
  // spread PER_PLAYER items per player evenly across the items the host has switched on
  const on = ITEMS.filter((e) => room.settings.on[e]);
  const total = Math.max(1, Object.keys(room.players).length) * PER_PLAYER;
  const counts = {};
  on.forEach((e, i) => (counts[e] = Math.floor(total / on.length) + (i < total % on.length ? 1 : 0)));
  return counts;
}
function itemCounts(room) {
  return room.settings.auto ? autoCounts(room) : room.settings.counts;
}

function deal(room) {
  const counts = itemCounts(room);
  const pool = [];
  for (const [e, n] of Object.entries(counts)) if (room.settings.on[e]) for (let i = 0; i < n; i++) pool.push(e);
  for (let i = pool.length - 1; i > 0; i--) { const j = rand(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ps = Object.values(room.players);
  ps.forEach((p) => { p.hand = []; });
  pool.forEach((e, i) => ps[i % ps.length].hand.push(e));
  for (const p of ps) {
    p.cash = room.round === 2 ? START_CASH : 0;
    p.startScore = score(p, room.round === 2);
    p.trades = 0;
  }
  room.offers = {};
}

function publicState(room) {
  const money = room.round === 2;
  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    bot: !!p.bot,
    online: p.online,
    hand: p.hand,
    cash: p.cash,
    score: score(p, money),
    gain: score(p, money) - p.startScore,
    trades: p.trades,
  }));
  return {
    code: room.code,
    phase: room.phase, // lobby | playing | between | done
    round: room.round,
    endsAt: room.endsAt,
    players,
    history: room.history,
    tradeCount: room.tradeCount,
    catalog: CATALOG,
    settings: { auto: room.settings.auto, on: room.settings.on, counts: itemCounts(room) },
  };
}

function broadcast(room) {
  const st = publicState(room);
  io.to(room.code).emit('state', st);
  // each player also gets the offers that involve them
  for (const p of Object.values(room.players)) {
    if (!p.socketId) continue;
    const mine = Object.values(room.offers).filter((o) => o.from === p.id || o.to === p.id);
    io.to(p.socketId).emit('offers', mine);
  }
}

function endRound(room) {
  if (room.phase !== 'playing') return;
  clearTimeout(room.timer);
  const money = room.round === 2;
  const ps = Object.values(room.players);
  const avg = (f) => (ps.length ? Math.round((ps.reduce((a, p) => a + f(p), 0) / ps.length) * 10) / 10 : 0);
  room.history.push({
    round: room.round,
    label: money ? 'Money' : 'Barter',
    trades: room.tradeCount,
    avgStart: avg((p) => p.startScore),
    avgEnd: avg((p) => score(p, money)),
    avgGain: avg((p) => score(p, money) - p.startScore),
  });
  room.offers = {};
  room.phase = room.round === 1 ? 'between' : 'done';
  broadcast(room);
}

function startRound(room, round) {
  room.round = round;
  room.phase = 'playing';
  room.tradeCount = 0;
  deal(room);
  room.endsAt = Date.now() + ROUND_SECONDS * 1000;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), ROUND_SECONDS * 1000);
  broadcast(room);
}

// Validate a side of an offer: {item: '🍎'} or {cash: 5}
function validSide(side, money) {
  if (!side || typeof side !== 'object') return false;
  if (typeof side.item === 'string' && ITEMS.includes(side.item) && side.cash === undefined) return true;
  if (money && side.item === undefined && Number.isInteger(side.cash) && side.cash > 0 && side.cash <= 1000) return true;
  return false;
}
function has(p, side) {
  return side.item ? p.hand.includes(side.item) : p.cash >= side.cash;
}
function move(from, to, side) {
  if (side.item) {
    from.hand.splice(from.hand.indexOf(side.item), 1);
    to.hand.push(side.item);
  } else {
    from.cash -= side.cash;
    to.cash += side.cash;
  }
}

function makeOffer(room, me, { to, give, get }) {
  if (room.phase !== 'playing') return { error: 'No round running' };
  const other = room.players[to];
  const money = room.round === 2;
  if (!other || other === me) return { error: 'Pick a player' };
  if (!validSide(give, money) || !validSide(get, money)) return { error: 'Invalid offer' };
  if (give.cash && get.cash) return { error: 'Cash for cash? Nice try' };
  if (!has(me, give)) return { error: "You don't have that" };
  if (!has(other, get)) return { error: "They don't have that" };
  if (Object.values(room.offers).filter((o) => o.from === me.id).length >= 5) return { error: 'Max 5 open offers' };
  const id = uid();
  room.offers[id] = { id, from: me.id, fromName: me.name, to, toName: other.name, give, get, at: Date.now() };
  broadcast(room);
  return { ok: true };
}

function acceptOffer(room, me, id) {
  const o = room.offers[id];
  if (!o || o.to !== me.id || room.phase !== 'playing') return { error: 'Offer gone' };
  const from = room.players[o.from];
  delete room.offers[id];
  if (!from || !has(from, o.give) || !has(me, o.get)) {
    broadcast(room);
    return { error: 'Trade no longer possible' };
  }
  move(from, me, o.give);
  move(me, from, o.get);
  from.trades++;
  me.trades++;
  room.tradeCount++;
  // drop other offers that are no longer affordable
  for (const [oid, x] of Object.entries(room.offers)) {
    const a = room.players[x.from], b = room.players[x.to];
    if (!a || !b || !has(a, x.give) || !has(b, x.get)) delete room.offers[oid];
  }
  io.to(room.code).emit('trade', { a: from.name, b: me.name, give: o.give, get: o.get });
  broadcast(room);
  return { ok: true };
}

// ---------- demo bots ----------
const BOT_NAMES = ['Robo Rita', 'Bot Bao', 'Chip', 'Beep Bella', 'Sprocket', 'Gizmo', 'Byte', 'Pixel'];
function addBots(room, n) {
  for (let i = 0; i < n; i++) {
    const name = BOT_NAMES.find((b) => !Object.values(room.players).some((p) => p.name === b));
    if (!name) return;
    const id = uid();
    room.players[id] = { id, name, bot: true, online: true, hand: [], cash: 0, startScore: 0, trades: 0 };
  }
}
function botTick(room, b) {
  const money = room.round === 2;
  const worth = (hand, cash) => score({ hand, cash }, money);
  // answer offers sent to me (wait a moment so it feels human)
  for (const o of Object.values(room.offers).filter((o) => o.to === b.id && Date.now() - o.at > 1500)) {
    let h = [...b.hand], cash = b.cash;
    if (o.get.item) h.splice(h.indexOf(o.get.item), 1); else cash -= o.get.cash;
    if (o.give.item) h.push(o.give.item); else cash += o.give.cash;
    // barter: only say yes if it actually helps me (that's what makes barter hard)
    if (worth(h, cash) > worth(b.hand, b.cash)) acceptOffer(room, b, o.id);
    else { delete room.offers[o.id]; broadcast(room); }
    return;
  }
  if (Math.random() < 0.5 || Object.values(room.offers).some((o) => o.from === b.id)) return;
  const counts = {};
  b.hand.forEach((i) => (counts[i] = (counts[i] || 0) + 1));
  const kinds = Object.keys(counts).sort((x, y) => counts[y] - counts[x]);
  const want = kinds[Math.floor(Math.random() * Math.min(2, kinds.length))];
  const sellers = Object.values(room.players).filter((p) => p.id !== b.id && p.hand.includes(want));
  if (!want || !sellers.length) return;
  const t = sellers[Math.floor(Math.random() * sellers.length)];
  const spare = kinds.filter((i) => counts[i] === 1 && i !== want);
  let give = null;
  if (money && b.cash >= 2) give = { cash: Math.min(b.cash, 2 + Math.floor(Math.random() * 5)) };
  else if (spare.length) give = { item: spare[Math.floor(Math.random() * spare.length)] };
  if (give) makeOffer(room, b, { to: t.id, give, get: { item: want } });
}
setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.phase !== 'playing') continue;
    for (const b of Object.values(room.players).filter((p) => p.bot)) botTick(room, b);
  }
}, 1200);

io.on('connection', (socket) => {
  let room = null;
  let me = null; // player object, or null for host

  socket.on('host:create', (_, cb) => {
    if (room) socket.leave(room.code);
    const code = newCode();
    room = rooms[code] = {
      code, phase: 'lobby', round: 0, players: {}, offers: {}, history: [], tradeCount: 0,
      hostToken: uid(), createdAt: Date.now(),
      settings: { auto: true, on: Object.fromEntries(ITEMS.map((e) => [e, true])), counts: {} },
    };
    socket.join(code);
    cb({ code, hostToken: room.hostToken });
    broadcast(room);
  });

  socket.on('host:resume', ({ code, hostToken }, cb) => {
    const r = rooms[code];
    if (!r || r.hostToken !== hostToken) return cb({ error: 'Game not found' });
    room = r;
    socket.join(code);
    cb({ code });
    broadcast(room);
  });

  const isHost = (token) => room && room.hostToken === token;
  socket.on('host:start', ({ hostToken, round }) => {
    if (!isHost(hostToken)) return;
    if (!((round === 1 && room.phase === 'lobby') || (round === 2 && room.phase === 'between'))) return;
    if (Object.keys(room.players).length < 2) return;
    if (!ITEMS.some((e) => room.settings.on[e] && itemCounts(room)[e] > 0)) return;
    startRound(room, round);
  });
  socket.on('host:settings', ({ hostToken, auto, on, counts }) => {
    if (!isHost(hostToken) || room.phase === 'playing') return;
    const st = room.settings;
    if (on && typeof on === 'object') for (const e of ITEMS) if (e in on) st.on[e] = !!on[e];
    if (auto) { st.auto = true; }
    else if (counts && typeof counts === 'object') {
      if (st.auto) { st.counts = autoCounts(room); st.auto = false; } // start editing from the auto numbers
      for (const e of ITEMS) {
        const n = Number(counts[e]);
        if (e in counts && Number.isInteger(n)) st.counts[e] = Math.max(0, Math.min(500, n));
      }
    }
    broadcast(room);
  });
  socket.on('host:bots', ({ hostToken, n }) => {
    if (!isHost(hostToken) || room.phase === 'playing') return;
    addBots(room, Math.max(1, Math.min(8, Number(n) || 5)));
    broadcast(room);
  });
  socket.on('host:end', ({ hostToken }) => isHost(hostToken) && endRound(room));
  socket.on('host:kick', ({ hostToken, playerId }) => {
    if (!isHost(hostToken) || !room.players[playerId]) return;
    const p = room.players[playerId];
    if (p.socketId) io.to(p.socketId).emit('kicked');
    delete room.players[playerId];
    for (const [id, o] of Object.entries(room.offers)) if (o.from === playerId || o.to === playerId) delete room.offers[id];
    broadcast(room);
  });

  socket.on('player:join', ({ code, name, playerId }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const r = rooms[code];
    if (!r) return cb({ error: 'No game with that code' });
    if (playerId && r.players[playerId]) {
      me = r.players[playerId];
    } else {
      name = String(name || '').trim().slice(0, 16);
      if (!name) return cb({ error: 'Enter a name' });
      if (r.phase !== 'lobby' && r.phase !== 'between') return cb({ error: 'Round in progress — wait for the next one' });
      if (Object.values(r.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) return cb({ error: 'Name taken' });
      me = { id: uid(), name, hand: [], cash: 0, startScore: 0, trades: 0 };
      r.players[me.id] = me;
    }
    room = r;
    me.socketId = socket.id;
    me.online = true;
    socket.join(code);
    cb({ playerId: me.id, code });
    broadcast(room);
  });

  socket.on('offer:make', (o, cb = () => {}) => {
    if (!room || !me) return cb({ error: 'No round running' });
    cb(makeOffer(room, me, o || {}));
  });

  socket.on('offer:cancel', ({ id }) => {
    const o = room && room.offers[id];
    if (!o || !me || (o.from !== me.id && o.to !== me.id)) return;
    delete room.offers[id];
    broadcast(room);
  });

  socket.on('offer:accept', ({ id }, cb = () => {}) => {
    if (!room || !me) return cb({ error: 'Offer gone' });
    cb(acceptOffer(room, me, id));
  });

  socket.on('disconnect', () => {
    if (me && room) {
      me.online = false;
      me.socketId = null;
      broadcast(room);
    }
  });
});

// Clean up games older than 6 hours
setInterval(() => {
  for (const [c, r] of Object.entries(rooms)) if (Date.now() - r.createdAt > 6 * 3600e3) delete rooms[c];
}, 600e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Barter game on http://localhost:${PORT}`));
