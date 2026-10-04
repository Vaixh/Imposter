const express = require("express");
const http = require("http");
const os = require("os");
const { Server } = require("socket.io");
const WORDS = require("./words");

const PORT = 3000;
const CUSTOM = "Eigene Wörter";
const BOOT_ID = Date.now().toString(36); // ändert sich bei jedem Serverstart
const HOST_GRACE_MS = 30000; // so lange darf die Spielleitung weg sein, bevor jemand anderes übernimmt

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

// ---------- Spielzustand ----------

const game = {
  phase: "lobby", // lobby | clues | voting | guess | result
  players: [], // { id, name, socketId, connected }
  hostId: null,
  settings: {
    imposters: 1,
    hint: true,
    categories: Object.keys(WORDS),
    customWords: [],
  },
  round: null,
  usedWords: new Set(),
};

const findPlayer = (id) => game.players.find((p) => p.id === id);
const connectedPlayers = () => game.players.filter((p) => p.connected);
const isHost = (id) => id === game.hostId;
const cleanText = (t) => String(t || "").trim().slice(0, 40);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Fairer Zufall ----------
// Reiner Zufall fühlt sich bei wenigen Spielern unfair an, weil oft dieselbe Person drankommt.
// Deshalb merken wir uns, wie oft jemand Imposter bzw. Startspieler war, verglichen damit,
// wie oft es bei reinem Zufall zu erwarten wäre. Wer "zu oft" dran war, wird seltener gezogen,
// wer "zu selten" dran war, häufiger. Ausgeschlossen wird niemand, es bleibt also überraschend.

const stats = new Map(); // playerId -> { impExpected, impActual, startExpected, startActual }
const FAIRNESS = 3; // höher = gleichmäßiger, 1 = reiner Zufall

function statOf(id) {
  if (!stats.has(id)) stats.set(id, { impExpected: 0, impActual: 0, startExpected: 0, startActual: 0 });
  return stats.get(id);
}

function weightedPick(ids, weightOf) {
  const weights = ids.map(weightOf);
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return ids[i];
  }
  return ids[ids.length - 1];
}

function pickImposters(participants, count) {
  const pool = [...participants];
  const chosen = [];
  for (let i = 0; i < count; i++) {
    const id = weightedPick(pool, (pid) => {
      const st = statOf(pid);
      return Math.pow(FAIRNESS, st.impExpected - st.impActual);
    });
    chosen.push(id);
    pool.splice(pool.indexOf(id), 1);
  }
  for (const id of participants) {
    const st = statOf(id);
    st.impExpected += count / participants.length;
    if (chosen.includes(id)) st.impActual++;
  }
  return chosen;
}

function pickStarter(crew) {
  const id = weightedPick(crew, (pid) => {
    const st = statOf(pid);
    return Math.pow(FAIRNESS, st.startExpected - st.startActual);
  });
  for (const pid of crew) {
    const st = statOf(pid);
    st.startExpected += 1 / crew.length;
    if (pid === id) st.startActual++;
  }
  return id;
}

function pickWord() {
  const pool = [];
  for (const cat of game.settings.categories) {
    const words = cat === CUSTOM ? game.settings.customWords : WORDS[cat] || [];
    for (const word of words) pool.push({ word, category: cat });
  }
  if (pool.length === 0) return null;

  let fresh = pool.filter((e) => !game.usedWords.has(e.word));
  if (fresh.length === 0) {
    game.usedWords.clear(); // alle Wörter durch, von vorne anfangen
    fresh = pool;
  }
  const entry = fresh[Math.floor(Math.random() * fresh.length)];
  game.usedWords.add(entry.word);
  return entry;
}

let roundCounter = 0;

function startRound() {
  const participants = connectedPlayers().map((p) => p.id);
  if (participants.length < 3) return "Ihr braucht mindestens 3 Mitspieler.";

  const entry = pickWord();
  if (!entry) return "Wähle mindestens eine Kategorie mit Wörtern aus.";

  const count = Math.max(1, Math.min(game.settings.imposters, participants.length - 2));
  const imposterIds = pickImposters(participants, count);

  // Reihenfolge: Ein Imposter fängt nie an, das wäre zu unfair.
  const starter = pickStarter(participants.filter((id) => !imposterIds.includes(id)));
  const order = [starter, ...shuffle(participants.filter((id) => id !== starter))];

  game.round = {
    id: ++roundCounter, // damit die Handys erkennen, wann eine neue Runde beginnt
    word: entry.word,
    category: entry.category,
    hint: game.settings.hint,
    imposterIds,
    participants,
    order,
    turn: 0, // Index in order: wer gerade ein Wort sagen muss
    lap: 1, // wie oft die Reihe schon durch ist
    clues: [], // { playerId, text, lap, stage }
    stage: 0, // zählt die Abstimmungen dieser Runde
    out: [], // rausgewählte Spieler
    news: null, // was bei der letzten Abstimmung passiert ist
    votes: {}, // voterId -> targetId
    voteResult: null, // { tally, eliminatedId } der letzten Abstimmung
    guess: null, // { imposterId, type: "early" | "last" }
    result: null,
  };
  game.phase = "clues";
  return null;
}

// ---------- Wer ist noch dabei? ----------

// Noch im Spiel: Teil der Runde, nicht rausgewählt und nicht entfernt
const isAlive = (r, id) => r.participants.includes(id) && !r.out.includes(id) && !!findPlayer(id);
const alive = (r) => r.participants.filter((id) => isAlive(r, id));
const aliveImposters = (r) => alive(r).filter((id) => r.imposterIds.includes(id));
const aliveCrew = (r) => alive(r).filter((id) => !r.imposterIds.includes(id));

// ---------- Wortrunde ----------

const currentTurnId = (r) => r.order[r.turn];

function advanceTurn(r) {
  for (let i = 0; i < r.order.length; i++) {
    r.turn = (r.turn + 1) % r.order.length;
    if (r.turn === 0) r.lap++;
    if (isAlive(r, r.order[r.turn])) return; // Rausgewählte und Entfernte überspringen
  }
}

function ensureTurnAlive(r) {
  if (!isAlive(r, currentTurnId(r))) advanceTurn(r);
}

// Seit der letzten Abstimmung muss jeder, der noch dabei ist, mindestens ein Wort gesagt haben.
function everyoneGaveClue(r) {
  return alive(r).every((id) => r.clues.some((c) => c.playerId === id && c.stage === r.stage));
}

// ---------- Abstimmung & Auflösung ----------

function endRound(result) {
  const r = game.round;
  game.round.result = { ...result, out: [...r.out], vote: r.voteResult };
  game.phase = "result";
}

// Nach einer Abstimmung (oder einer falschen Vermutung) geht die Runde weiter,
// außer die Imposter sind schon mindestens so viele wie die übrigen Crewmates.
function continueOrEnd(news) {
  const r = game.round;
  if (aliveImposters(r).length === 0) {
    return endRound({ reason: "all-caught", imposterWins: false });
  }
  if (aliveImposters(r).length >= aliveCrew(r).length) {
    return endRound({ reason: "survived", imposterWins: true, news });
  }
  r.news = { ...news, at: Date.now() };
  r.stage++;
  r.votes = {};
  r.guess = null;
  ensureTurnAlive(r);
  game.phase = "clues";
}

function finishVoting() {
  const r = game.round;
  const tally = {};
  for (const target of Object.values(r.votes)) tally[target] = (tally[target] || 0) + 1;

  let max = 0;
  let top = [];
  for (const [id, n] of Object.entries(tally)) {
    if (n > max) {
      max = n;
      top = [id];
    } else if (n === max) {
      top.push(id);
    }
  }
  const eliminatedId = top.length === 1 ? top[0] : null; // Gleichstand = niemand fliegt
  r.voteResult = { tally, eliminatedId };
  r.votes = {};

  if (!eliminatedId) return continueOrEnd({ type: "tie" });

  r.out.push(eliminatedId);
  if (r.imposterIds.includes(eliminatedId)) {
    // Imposter erwischt: er darf noch einmal raten
    r.guess = { imposterId: eliminatedId, type: "last" };
    game.phase = "guess";
  } else {
    continueOrEnd({ type: "innocent", playerId: eliminatedId });
  }
}

function checkAllVoted() {
  const r = game.round;
  if (game.phase !== "voting" || !r) return;
  const voters = alive(r);
  if (voters.length > 0 && voters.every((id) => r.votes[id])) finishVoting();
}

function removePlayer(id) {
  const r = game.round;
  const wasTurn = game.phase === "clues" && r && currentTurnId(r) === id;
  game.players = game.players.filter((p) => p.id !== id);
  if (game.hostId === id) {
    game.hostId = connectedPlayers()[0]?.id || game.players[0]?.id || null;
  }
  if (wasTurn) advanceTurn(r);
  checkAllVoted();
}

// Jeder bekommt eine eigene Sicht: Wort und Rolle sieht nur, wen es betrifft.
function viewFor(playerId) {
  const r = game.round;
  const view = {
    you: playerId,
    phase: game.phase,
    hostId: game.hostId,
    players: game.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    settings: game.settings,
    allCategories: [...Object.keys(WORDS), CUSTOM],
    round: null,
  };
  if (r) {
    const inRound = r.participants.includes(playerId);
    const imposter = r.imposterIds.includes(playerId);
    view.round = {
      id: r.id,
      inRound,
      participants: r.participants,
      order: r.order,
      alive: alive(r),
      out: r.out,
      amOut: r.out.includes(playerId),
      imposterCount: r.imposterIds.length,
      aliveImposterCount: aliveImposters(r).length,
      role: inRound
        ? {
            imposter,
            word: imposter ? null : r.word,
            category: !imposter || r.hint ? r.category : null,
          }
        : null,
      clues: r.clues,
      stage: r.stage,
      news: r.news,
      turnId: game.phase === "clues" ? currentTurnId(r) : null,
      allGaveClue: everyoneGaveClue(r),
      myVote: r.votes[playerId] || null,
      votedCount: Object.keys(r.votes).length,
      guess: r.guess,
      result:
        game.phase === "result"
          ? { ...r.result, word: r.word, category: r.category, imposterIds: r.imposterIds }
          : null,
    };
  }
  return view;
}

function broadcast() {
  for (const p of game.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", viewFor(p.id));
  }
}

// ---------- Verbindungen ----------

io.on("connection", (socket) => {
  let playerId = null;
  socket.emit("boot", BOOT_ID); // Handys laden neu, wenn der Server neu gestartet wurde

  socket.on("join", (data = {}) => {
    const name = String(data.name || "").trim().slice(0, 20);
    const id = String(data.id || "").slice(0, 64);
    if (!id || !name) return socket.emit("problem", "Bitte gib einen Namen ein.");

    let player = findPlayer(id);
    if (player) {
      // Wiederverbinden, z. B. nach Bildschirmsperre
      player.name = name;
      player.socketId = socket.id;
      player.connected = true;
    } else {
      const taken = game.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
      if (taken) return socket.emit("problem", "Diesen Namen gibt es schon. Nimm bitte einen anderen.");
      player = { id, name, socketId: socket.id, connected: true };
      game.players.push(player);
    }
    playerId = id;
    if (!findPlayer(game.hostId)) game.hostId = id;
    broadcast();
  });

  // Nur die Spielleitung darf diese Aktionen auslösen
  const hostOnly = (fn) => (...args) => {
    if (!playerId || !isHost(playerId)) return;
    fn(...args);
    broadcast();
  };

  socket.on("settings", hostOnly((s = {}) => {
    if (game.phase !== "lobby") return;
    const all = [...Object.keys(WORDS), CUSTOM];
    const imposters = parseInt(s.imposters, 10);
    game.settings.imposters = Math.min(3, Math.max(1, Number.isNaN(imposters) ? 1 : imposters));
    game.settings.hint = !!s.hint;
    game.settings.categories = (Array.isArray(s.categories) ? s.categories : []).filter((c) => all.includes(c));
    game.settings.customWords = (Array.isArray(s.customWords) ? s.customWords : [])
      .map((w) => String(w).trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 300);
  }));

  socket.on("start", hostOnly(() => {
    if (game.phase !== "lobby" && game.phase !== "result") return;
    const problem = startRound();
    if (problem) socket.emit("problem", problem);
  }));

  socket.on("skip", hostOnly(() => {
    if (game.phase === "clues" && game.round) advanceTurn(game.round);
  }));

  // Nur die Spielleitung startet die Abstimmung, sobald alle ein Wort gesagt haben.
  socket.on("startVoting", hostOnly(() => {
    const r = game.round;
    if (game.phase !== "clues" || !r) return;
    if (!everyoneGaveClue(r)) return socket.emit("problem", "Noch nicht alle haben ein Wort gesagt.");
    game.phase = "voting";
  }));

  socket.on("endVoting", hostOnly(() => {
    if (game.phase === "voting") finishVoting();
  }));

  socket.on("toLobby", hostOnly(() => {
    game.phase = "lobby";
    game.round = null;
  }));

  socket.on("kick", hostOnly((id) => {
    if (id === playerId) return;
    const p = findPlayer(id);
    if (!p) return;
    if (p.connected) io.to(p.socketId).emit("kicked");
    removePlayer(id);
  }));

  // Die Spieler sagen ihr Wort laut, die Spielleitung trägt es für die Person ein, die dran ist.
  socket.on("clue", hostOnly((text) => {
    const r = game.round;
    if (game.phase !== "clues" || !r) return;
    const t = cleanText(text);
    if (!t) return socket.emit("problem", "Bitte gib ein Wort ein.");
    r.clues.push({ playerId: currentTurnId(r), text: t, lap: r.lap, stage: r.stage });
    advanceTurn(r);
  }));

  socket.on("vote", (targetId) => {
    const r = game.round;
    if (game.phase !== "voting" || !r || !isAlive(r, playerId)) return;
    if (targetId === playerId || !isAlive(r, targetId)) return;
    r.votes[playerId] = targetId;
    checkAllVoted();
    broadcast();
  });

  // Der Imposter sagt laut, dass er auflösen will, und die Spielleitung drückt den Knopf.
  // Bei nur einem Imposter weiß der Server selbst, wer das ist. Nur bei mehreren
  // Impostern muss die Spielleitung auswählen, wer von ihnen auflöst.
  socket.on("guess", hostOnly((targetId) => {
    const r = game.round;
    if (!r || (game.phase !== "clues" && game.phase !== "voting")) return;
    const imps = aliveImposters(r);
    if (imps.length === 1) targetId = imps[0];
    if (!isAlive(r, targetId)) return;
    if (r.imposterIds.includes(targetId)) {
      r.guess = { imposterId: targetId, type: "early" };
      game.phase = "guess";
    } else {
      r.news = { type: "not-imposter", playerId: targetId, at: Date.now() };
    }
  }));

  // Crewmates, die noch dabei sind, bewerten die Vermutung. Die erste Antwort zählt.
  socket.on("judge", (correct) => {
    const r = game.round;
    if (game.phase !== "guess" || !r?.guess) return;
    if (!isAlive(r, playerId) || r.imposterIds.includes(playerId)) return;
    const { imposterId, type } = r.guess;

    if (correct) {
      endRound({ reason: `${type}-right`, imposterWins: true, guesserId: imposterId, judgeId: playerId });
    } else {
      // Falsch geraten: Dieser Imposter ist raus. Gibt es noch weitere, geht es weiter.
      if (!r.out.includes(imposterId)) r.out.push(imposterId);
      if (aliveImposters(r).length === 0) {
        endRound({ reason: `${type}-wrong`, imposterWins: false, guesserId: imposterId, judgeId: playerId });
      } else {
        continueOrEnd({ type: "wrong-guess", playerId: imposterId });
      }
    }
    broadcast();
  });

  socket.on("leave", () => {
    if (!playerId) return;
    removePlayer(playerId);
    playerId = null;
    broadcast();
  });

  socket.on("disconnect", () => {
    const p = findPlayer(playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;

    if (isHost(p.id)) {
      setTimeout(() => {
        const host = findPlayer(game.hostId);
        const next = connectedPlayers()[0];
        if (host && !host.connected && next) {
          game.hostId = next.id;
          broadcast();
        }
      }, HOST_GRACE_MS);
    }
    broadcast();
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("");
    console.log(`Port ${PORT} ist schon belegt. Wahrscheinlich läuft der Imposter-Server bereits,`);
    console.log("z. B. im Terminal von VS Code oder in einem anderen Fenster.");
    console.log("Schließe den anderen Server und starte dann neu.");
    console.log("");
    process.exit(1);
  }
  throw err;
});

// Sucht die Adresse, unter der die Handys den PC im WLAN erreichen.
// Heimnetze nutzen fast immer 192.168.x.x, deshalb wird die bevorzugt.
function lanAddresses() {
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const a of entries || []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal) list.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}

function printQr(url) {
  let qrcode;
  try {
    qrcode = require("qrcode-terminal");
  } catch {
    console.log("(Für einen QR-Code einmal \"npm install qrcode-terminal\" im Projektordner ausführen.)");
    return;
  }
  qrcode.generate(url, { small: true }, (code) => console.log(code));
}

server.listen(PORT, "0.0.0.0", () => {
  const [main, ...others] = lanAddresses();
  console.log("");
  console.log("Imposter läuft!");
  console.log("");
  if (main) {
    const url = `http://${main}:${PORT}`;
    console.log("Mit der Handykamera scannen:");
    console.log("");
    printQr(url);
    console.log(`Oder im Handy-Browser eingeben: ${url}`);
    for (const ip of others) console.log(`Falls das nicht klappt, probiere: http://${ip}:${PORT}`);
  } else {
    console.log("Keine WLAN-Verbindung gefunden. Ist der PC mit dem Netzwerk verbunden?");
  }
  console.log(`Am PC selbst: http://localhost:${PORT}`);
  console.log("");
  console.log("Dieses Fenster offen lassen, solange ihr spielt.");
});