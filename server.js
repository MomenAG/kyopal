const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'tournament.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
// Data Persistence
// ═══════════════════════════════════════════

function defaultTournament() {
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: '',
    adminToken: crypto.randomUUID().slice(0, 12),
    players: [],
    rounds: [],
    currentRound: 0,
    totalRounds: 0,
    started: false,
    registrationLocked: false,
    topCutEnabled: false,
    topCutSize: 4,
    topCutPhase: false,
    topCutBracket: [],
    finished: false,
    createdAt: new Date().toISOString(),
  };
}

function loadTournament() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load error:', e); }
  return null;
}

function saveTournament(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════
// Swiss Engine
// ═══════════════════════════════════════════

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPlayerRecord(tournament, playerId) {
  let wins = 0, losses = 0, byes = 0;
  const opponents = [];
  const lostRounds = [];

  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.player1 === playerId || match.player2 === playerId) {
        const isP1 = match.player1 === playerId;
        const opp = isP1 ? match.player2 : match.player1;

        if (match.bye) {
          if (match.player1 === playerId) { wins++; byes++; }
          continue;
        }

        opponents.push(opp);

        if (match.reported) {
          if (match.result === 'dl') {
            losses++;
            lostRounds.push(round.round);
          } else if ((match.result === 'p1' && isP1) || (match.result === 'p2' && !isP1)) {
            wins++;
          } else {
            losses++;
            lostRounds.push(round.round);
          }
        }
      }
    }
  }

  const matchPoints = wins * 3;
  const matchesPlayed = wins + losses;
  const matchWinPct = matchesPlayed > 0 ? Math.max(matchPoints / (matchesPlayed * 3), 1 / 3) : 1 / 3;
  const gameWinPct = matchesPlayed > 0 ? Math.max(wins / matchesPlayed, 1 / 3) : 1 / 3;

  return { wins, losses, byes, matchPoints, matchWinPct, gameWinPct, opponents, matchesPlayed, lostRounds };
}

function getOppWinPct(tournament, playerId) {
  const record = getPlayerRecord(tournament, playerId);
  const oppPcts = record.opponents.map(opp => getPlayerRecord(tournament, opp).matchWinPct);
  // Each bye counts as a virtual opponent at 1/3 win rate (standard TCG tiebreaker convention)
  for (let i = 0; i < record.byes; i++) oppPcts.push(1 / 3);
  if (oppPcts.length === 0) return 1 / 3;
  return oppPcts.reduce((a, b) => a + b, 0) / oppPcts.length;
}

function getOppOppWinPct(tournament, playerId) {
  const record = getPlayerRecord(tournament, playerId);
  if (record.opponents.length === 0) return 1 / 3;
  const oppOppPcts = record.opponents.map(opp => getOppWinPct(tournament, opp));
  return oppOppPcts.reduce((a, b) => a + b, 0) / oppOppPcts.length;
}

function getTiebreakerNumber(tournament, playerId) {
  const rec = getPlayerRecord(tournament, playerId);
  const owp = getOppWinPct(tournament, playerId);
  const oowp = getOppOppWinPct(tournament, playerId);
  const aa = rec.matchPoints;
  const bbb = Math.round(owp * 1000);
  const ccc = Math.round(oowp * 1000);
  const ddd = rec.lostRounds.reduce((sum, r) => sum + r * r, 0);
  return aa * 1_000_000_000 + bbb * 1_000_000 + ccc * 1_000 + ddd;
}

function getStandings(tournament) {
  return tournament.players.map(p => {
    const rec = getPlayerRecord(tournament, p.id);
    const owp = getOppWinPct(tournament, p.id);
    const oowp = getOppOppWinPct(tournament, p.id);
    const tb = getTiebreakerNumber(tournament, p.id);
    const ddd = rec.lostRounds.reduce((sum, r) => sum + r * r, 0);
    return { ...p, ...rec, oppWinPct: owp, oppOppWinPct: oowp, tiebreaker: tb, lostRoundSqSum: ddd };
  }).sort((a, b) => {
    if (b.tiebreaker !== a.tiebreaker) return b.tiebreaker - a.tiebreaker;
    return a.name.localeCompare(b.name);
  });
}

function havePlayed(tournament, p1, p2) {
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.bye) continue;
      if ((match.player1 === p1 && match.player2 === p2) ||
          (match.player1 === p2 && match.player2 === p1)) return true;
    }
  }
  return false;
}

function findBestPairing(tournament, ids) {
  let bestResult = null;
  let bestRematches = Infinity;

  function backtrack(remaining, currentPairs, rematches) {
    if (rematches >= bestRematches) return;

    if (remaining.length === 0) {
      if (rematches < bestRematches) {
        bestRematches = rematches;
        bestResult = [...currentPairs];
      }
      return;
    }

    const first = remaining[0];
    const rest = remaining.slice(1);

    const candidates = rest.map((id, idx) => ({
      id, idx,
      isRematch: havePlayed(tournament, first, id)
    }));
    candidates.sort((a, b) => a.isRematch - b.isRematch);

    for (const candidate of candidates) {
      const newRemaining = rest.filter((_, idx) => idx !== candidate.idx);
      const newRematches = rematches + (candidate.isRematch ? 1 : 0);
      if (newRematches >= bestRematches) continue;

      currentPairs.push([first, candidate.id]);
      backtrack(newRemaining, currentPairs, newRematches);
      currentPairs.pop();

      if (bestRematches === 0) return;
    }
  }

  backtrack(ids, [], 0);
  return bestResult || [];
}

function generatePairings(tournament) {
  const isFirstRound = tournament.rounds.length === 0;
  let playerList;

  if (isFirstRound) {
    playerList = shuffle(tournament.players.filter(p => !p.kicked));
  } else {
    playerList = getStandings(tournament).filter(p => !p.kicked);
  }

  const matches = [];

  if (playerList.length % 2 !== 0) {
    for (let i = playerList.length - 1; i >= 0; i--) {
      if (getPlayerRecord(tournament, playerList[i].id).byes === 0) {
        const byePlayer = playerList.splice(i, 1)[0];
        matches.push({
          id: crypto.randomUUID(),
          player1: byePlayer.id, player2: null,
          result: 'p1', reported: true, bye: true,
        });
        break;
      }
    }
  }

  const ids = playerList.map(p => p.id);
  const bestPairing = findBestPairing(tournament, ids);

  for (const [id1, id2] of bestPairing) {
    matches.push({
      id: crypto.randomUUID(),
      player1: id1, player2: id2,
      result: null, reported: false, bye: false,
    });
  }

  return matches;
}

function pairRemainingPlayers(tournament, uncoveredIds, isFirstRound) {
  const matches = [];
  if (uncoveredIds.length === 0) return matches;

  let ids = isFirstRound
    ? shuffle([...uncoveredIds])
    : getStandings(tournament).map(p => p.id).filter(id => uncoveredIds.includes(id));

  if (ids.length % 2 !== 0) {
    let byeIdx = ids.length - 1;
    for (let i = ids.length - 1; i >= 0; i--) {
      if (getPlayerRecord(tournament, ids[i]).byes === 0) { byeIdx = i; break; }
    }
    const byeId = ids.splice(byeIdx, 1)[0];
    matches.push({ id: crypto.randomUUID(), player1: byeId, player2: null, result: 'p1', reported: true, bye: true });
  }

  for (const [id1, id2] of findBestPairing(tournament, ids)) {
    matches.push({ id: crypto.randomUUID(), player1: id1, player2: id2, result: null, reported: false, bye: false });
  }
  return matches;
}

function getRecommendedRounds(n) {
  if (n <= 4) return 3;
  if (n <= 8) return 3;
  if (n <= 16) return 4;
  if (n <= 32) return 5;
  if (n <= 64) return 6;
  return 7;
}

// ═══════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════

// Middleware: check admin token
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  const t = loadTournament();
  if (!t || t.adminToken !== token) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  req.tournament = t;
  next();
}

// ── Public Routes ──

// Get tournament state (player view)
app.get('/api/tournament', (req, res) => {
  const t = loadTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });

  // Strip admin token
  const { adminToken, ...publicData } = t;
  const standings = getStandings(t);
  res.json({ ...publicData, standings });
});

// Player self-register
app.post('/api/tournament/join', (req, res) => {
  const t = loadTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  if (t.registrationLocked) return res.status(400).json({ error: 'Registration is locked' });
  if (t.started) return res.status(400).json({ error: 'Tournament already started' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const trimmed = name.trim();
  if (t.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(400).json({ error: 'Name already taken' });
  }

  const player = { id: crypto.randomUUID(), name: trimmed };
  t.players.push(player);
  saveTournament(t);

  res.json({ player, playerCount: t.players.length });
});

// Player self-report match result
app.post('/api/player/report', (req, res) => {
  const t = loadTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  if (!t.started) return res.status(400).json({ error: 'Tournament not started' });

  const { matchId, result, playerId } = req.body;

  if (!playerId) return res.status(400).json({ error: 'Player ID required' });
  if (!['win', 'loss', 'dl'].includes(result)) return res.status(400).json({ error: 'Invalid result' });

  const player = t.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let match = null;
  if (t.topCutPhase) {
    for (const br of t.topCutBracket) {
      const m = br.matches.find(m => m.id === matchId);
      if (m) { match = m; break; }
    }
  } else {
    for (const round of t.rounds) {
      const m = round.matches.find(m => m.id === matchId);
      if (m) { match = m; break; }
    }
  }

  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.reported) return res.status(400).json({ error: 'Match already reported — contact admin to correct' });
  if (match.player1 !== playerId && match.player2 !== playerId) {
    return res.status(403).json({ error: 'You are not in this match' });
  }

  const isP1 = match.player1 === playerId;
  let matchResult;
  if (result === 'dl') {
    matchResult = 'dl';
  } else if (result === 'win') {
    matchResult = isP1 ? 'p1' : 'p2';
  } else {
    matchResult = isP1 ? 'p2' : 'p1';
  }

  match.result = matchResult;
  match.reported = true;
  saveTournament(t);

  const standings = getStandings(t);
  res.json({ success: true, standings });
});

// Player self-remove
app.post('/api/tournament/leave', (req, res) => {
  const t = loadTournament();
  if (!t) return res.status(404).json({ error: 'No tournament' });
  if (t.started) return res.status(400).json({ error: 'Tournament already started' });

  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: 'Player ID required' });

  t.players = t.players.filter(p => p.id !== playerId);
  saveTournament(t);
  res.json({ success: true, playerCount: t.players.length });
});

// ── Admin Routes ──

// Create new tournament (resets everything)
app.post('/api/admin/create', (req, res) => {
  const { name, adminPassword } = req.body;

  // Simple password protection for creating tournaments
  const envPassword = process.env.ADMIN_PASSWORD || 'kyopal';
  if (adminPassword !== envPassword) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }

  const t = defaultTournament();
  t.name = name || 'Tournament';
  saveTournament(t);

  res.json({ tournamentId: t.id, adminToken: t.adminToken, name: t.name });
});

// Get full tournament state (admin view with token)
app.get('/api/admin/tournament', requireAdmin, (req, res) => {
  const standings = getStandings(req.tournament);
  res.json({ ...req.tournament, standings });
});

// Lock/unlock registration
app.post('/api/admin/lock-registration', requireAdmin, (req, res) => {
  const t = req.tournament;
  t.registrationLocked = !t.registrationLocked;
  saveTournament(t);
  res.json({ registrationLocked: t.registrationLocked });
});

// Kick a player during the tournament
app.post('/api/admin/kick-player', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (!t.started) return res.status(400).json({ error: 'Tournament not started' });
  if (t.finished) return res.status(400).json({ error: 'Tournament already finished' });

  const { playerId } = req.body;
  const player = t.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.kicked) return res.status(400).json({ error: 'Player already kicked' });

  player.kicked = true;

  // Auto-report their current unreported match — opponent wins
  const allRounds = t.topCutPhase ? t.topCutBracket : t.rounds;
  for (const round of allRounds) {
    const match = round.matches.find(m =>
      !m.reported && (m.player1 === playerId || m.player2 === playerId)
    );
    if (match) {
      match.reported = true;
      match.result = match.player1 === playerId ? 'p2' : 'p1';
      break;
    }
  }

  saveTournament(t);
  const standings = getStandings(t);
  res.json({ success: true, standings });
});

// Reinstate a kicked player
app.post('/api/admin/reinstate-player', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (!t.started) return res.status(400).json({ error: 'Tournament not started' });
  if (t.finished) return res.status(400).json({ error: 'Tournament already finished' });

  const { playerId } = req.body;
  const player = t.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (!player.kicked) return res.status(400).json({ error: 'Player is not kicked' });

  player.kicked = false;
  saveTournament(t);
  const standings = getStandings(t);
  res.json({ success: true, standings });
});

// Remove a player (before tournament starts)
app.post('/api/admin/remove-player', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.started) return res.status(400).json({ error: 'Cannot remove after start' });

  const { playerId } = req.body;
  t.players = t.players.filter(p => p.id !== playerId);
  saveTournament(t);
  res.json({ players: t.players });
});

// Admin add player (works before and during tournament)
app.post('/api/admin/add-player', requireAdmin, (req, res) => {
  const t = req.tournament;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const trimmed = name.trim();
  if (t.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(400).json({ error: 'Name already taken' });
  }

  const player = { id: crypto.randomUUID(), name: trimmed };
  t.players.push(player);
  saveTournament(t);

  res.json({ player, playerCount: t.players.length });
});

// Update tournament settings
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.started) return res.status(400).json({ error: 'Cannot change settings after start' });

  const { name, totalRounds, topCutEnabled, topCutSize } = req.body;
  if (name !== undefined) t.name = name;
  if (totalRounds !== undefined) t.totalRounds = totalRounds;
  if (topCutEnabled !== undefined) t.topCutEnabled = topCutEnabled;
  if (topCutSize !== undefined) t.topCutSize = topCutSize;
  saveTournament(t);
  res.json({ success: true });
});

// Start tournament with custom round 1 pairings
app.post('/api/admin/custom-start', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.started) return res.status(400).json({ error: 'Already started' });
  if (t.players.length < 4) return res.status(400).json({ error: 'Need at least 4 players' });

  const { matches, byePlayerId } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'matches must be an array' });

  const allPlayerIds = t.players.map(p => p.id);
  const covered = new Set();

  if (byePlayerId) {
    if (!allPlayerIds.includes(byePlayerId))
      return res.status(400).json({ error: 'Bye player is not a registered player' });
    covered.add(byePlayerId);
  }

  for (const m of matches) {
    if (!m.player1 || !m.player2) return res.status(400).json({ error: 'Each match needs two players' });
    if (!allPlayerIds.includes(m.player1) || !allPlayerIds.includes(m.player2))
      return res.status(400).json({ error: 'Invalid player in match' });
    if (m.player1 === m.player2) return res.status(400).json({ error: 'Player cannot play themselves' });
    if (covered.has(m.player1) || covered.has(m.player2))
      return res.status(400).json({ error: 'Player assigned to multiple matches' });
    covered.add(m.player1);
    covered.add(m.player2);
  }

  if (!t.totalRounds) t.totalRounds = getRecommendedRounds(t.players.length);
  t.started = true;
  t.registrationLocked = true;
  t.currentRound = 1;

  const roundMatches = [];
  if (byePlayerId) {
    roundMatches.push({
      id: crypto.randomUUID(), player1: byePlayerId, player2: null,
      result: 'p1', reported: true, bye: true,
    });
  }
  for (const m of matches) {
    roundMatches.push({
      id: crypto.randomUUID(), player1: m.player1, player2: m.player2,
      result: null, reported: false, bye: false,
    });
  }
  const uncoveredStart = allPlayerIds.filter(id => !covered.has(id));
  roundMatches.push(...pairRemainingPlayers(t, uncoveredStart, true));

  t.rounds = [{ round: 1, matches: roundMatches }];
  saveTournament(t);
  const standings = getStandings(t);
  res.json({ ...t, standings, adminToken: undefined });
});

// Start tournament
app.post('/api/admin/start', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.started) return res.status(400).json({ error: 'Already started' });
  if (t.players.length < 4) return res.status(400).json({ error: 'Need at least 4 players' });

  if (!t.totalRounds) t.totalRounds = getRecommendedRounds(t.players.length);
  t.started = true;
  t.registrationLocked = true;
  t.currentRound = 1;
  t.rounds = [{ round: 1, matches: generatePairings(t) }];
  saveTournament(t);

  const standings = getStandings(t);
  res.json({ ...t, standings, adminToken: undefined });
});

// Report match result
app.post('/api/admin/report', requireAdmin, (req, res) => {
  const t = req.tournament;
  const { matchId, result } = req.body; // result: 'p1', 'p2', 'dl'

  if (!['p1', 'p2', 'dl'].includes(result)) {
    return res.status(400).json({ error: 'Invalid result' });
  }

  // Search in current round
  let found = false;
  if (t.topCutPhase) {
    for (const br of t.topCutBracket) {
      const match = br.matches.find(m => m.id === matchId);
      if (match) {
        match.result = result;
        match.reported = true;
        found = true;
        break;
      }
    }
  } else {
    for (const round of t.rounds) {
      const match = round.matches.find(m => m.id === matchId);
      if (match) {
        match.result = result;
        match.reported = true;
        found = true;
        break;
      }
    }
  }

  if (!found) return res.status(404).json({ error: 'Match not found' });
  saveTournament(t);

  const standings = getStandings(t);
  res.json({ success: true, standings });
});

// Unreport match
app.post('/api/admin/unreport', requireAdmin, (req, res) => {
  const t = req.tournament;
  const { matchId } = req.body;

  if (t.topCutPhase) {
    for (const br of t.topCutBracket) {
      const match = br.matches.find(m => m.id === matchId);
      if (match) {
        match.reported = false;
        match.result = null;
        // If unreporting a semi, clear finals
        if (t.topCutSize === 4 && br === t.topCutBracket[0]) {
          const finals = t.topCutBracket[1].matches[0];
          finals.player1 = null;
          finals.player2 = null;
          finals.result = null;
          finals.reported = false;
        }
        break;
      }
    }
  } else {
    for (const round of t.rounds) {
      const match = round.matches.find(m => m.id === matchId);
      if (match) {
        match.reported = false;
        match.result = null;
        break;
      }
    }
  }

  saveTournament(t);
  res.json({ success: true });
});

// Next round
app.post('/api/admin/next-round', requireAdmin, (req, res) => {
  const t = req.tournament;

  // Verify all matches reported
  const current = t.rounds[t.currentRound - 1];
  if (!current || !current.matches.every(m => m.reported)) {
    return res.status(400).json({ error: 'Not all matches reported' });
  }

  if (t.currentRound >= t.totalRounds) {
    return res.status(400).json({ error: 'All swiss rounds complete' });
  }

  t.currentRound++;
  t.rounds.push({ round: t.currentRound, matches: generatePairings(t) });
  saveTournament(t);

  const standings = getStandings(t);
  res.json({ ...t, standings, adminToken: undefined });
});

// Start top cut
app.post('/api/admin/start-top-cut', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (!t.topCutEnabled) return res.status(400).json({ error: 'Top cut not enabled' });

  const standings = getStandings(t);
  const cutPlayers = standings.slice(0, t.topCutSize);

  t.topCutPhase = true;
  t.topCutBracket = [];

  if (t.topCutSize === 4) {
    t.topCutBracket.push({
      name: 'Semi-Finals',
      matches: [
        { id: crypto.randomUUID(), player1: cutPlayers[0].id, player2: cutPlayers[3].id, result: null, reported: false, bye: false },
        { id: crypto.randomUUID(), player1: cutPlayers[1].id, player2: cutPlayers[2].id, result: null, reported: false, bye: false },
      ]
    });
    t.topCutBracket.push({
      name: 'Finals',
      matches: [
        { id: crypto.randomUUID(), player1: null, player2: null, result: null, reported: false, bye: false },
      ]
    });
  } else {
    t.topCutBracket.push({
      name: 'Finals',
      matches: [
        { id: crypto.randomUUID(), player1: cutPlayers[0].id, player2: cutPlayers[1].id, result: null, reported: false, bye: false },
      ]
    });
  }

  saveTournament(t);
  res.json({ success: true });
});

// Custom round — admin-defined pairings instead of Swiss algorithm
app.post('/api/admin/custom-round', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (!t.started || t.topCutPhase || t.finished)
    return res.status(400).json({ error: 'Cannot custom-pair in current state' });

  const current = t.rounds[t.currentRound - 1];
  if (!current || !current.matches.every(m => m.reported))
    return res.status(400).json({ error: 'Not all matches in current round are reported' });
  if (t.currentRound >= t.totalRounds)
    return res.status(400).json({ error: 'All Swiss rounds complete' });

  const { matches, byePlayerId } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'matches must be an array' });

  const activePlayers = t.players.filter(p => !p.kicked).map(p => p.id);
  const covered = new Set();

  if (byePlayerId) {
    if (!activePlayers.includes(byePlayerId))
      return res.status(400).json({ error: 'Bye player is not an active player' });
    covered.add(byePlayerId);
  }

  for (const m of matches) {
    if (!m.player1 || !m.player2) return res.status(400).json({ error: 'Each match needs two players' });
    if (!activePlayers.includes(m.player1) || !activePlayers.includes(m.player2))
      return res.status(400).json({ error: 'Invalid player in match' });
    if (m.player1 === m.player2) return res.status(400).json({ error: 'Player cannot play themselves' });
    if (covered.has(m.player1) || covered.has(m.player2))
      return res.status(400).json({ error: 'Player assigned to multiple matches' });
    covered.add(m.player1);
    covered.add(m.player2);
  }

  const roundMatches = [];
  if (byePlayerId) {
    roundMatches.push({
      id: crypto.randomUUID(), player1: byePlayerId, player2: null,
      result: 'p1', reported: true, bye: true,
    });
  }
  for (const m of matches) {
    roundMatches.push({
      id: crypto.randomUUID(), player1: m.player1, player2: m.player2,
      result: null, reported: false, bye: false,
    });
  }
  const uncoveredRound = activePlayers.filter(id => !covered.has(id));
  roundMatches.push(...pairRemainingPlayers(t, uncoveredRound, false));

  t.currentRound++;
  t.rounds.push({ round: t.currentRound, matches: roundMatches });
  saveTournament(t);
  const standings = getStandings(t);
  res.json({ ...t, standings, adminToken: undefined });
});

// Custom top cut — admin defines bracket seeding instead of auto-seeding
app.post('/api/admin/custom-top-cut', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (!t.topCutEnabled || t.topCutPhase || t.finished)
    return res.status(400).json({ error: 'Cannot set custom top cut in current state' });

  const { matches } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'matches must be an array' });

  const cutPlayerIds = getStandings(t).filter(p => !p.kicked).slice(0, t.topCutSize).map(p => p.id);
  const covered = new Set();

  for (const m of matches) {
    if (!cutPlayerIds.includes(m.player1) || !cutPlayerIds.includes(m.player2))
      return res.status(400).json({ error: 'Players must be from the top cut standings' });
    if (m.player1 === m.player2) return res.status(400).json({ error: 'Player cannot play themselves' });
    if (covered.has(m.player1) || covered.has(m.player2))
      return res.status(400).json({ error: 'Player assigned twice' });
    covered.add(m.player1);
    covered.add(m.player2);
  }

  if (covered.size !== t.topCutSize)
    return res.status(400).json({ error: `All ${t.topCutSize} top cut players must be assigned` });

  t.topCutPhase = true;
  t.topCutBracket = [];

  if (t.topCutSize === 4) {
    if (matches.length !== 2) return res.status(400).json({ error: 'Need exactly 2 semi-final matches' });
    t.topCutBracket.push({
      name: 'Semi-Finals',
      matches: matches.map(m => ({
        id: crypto.randomUUID(), player1: m.player1, player2: m.player2,
        result: null, reported: false, bye: false,
      })),
    });
    t.topCutBracket.push({
      name: 'Finals',
      matches: [{ id: crypto.randomUUID(), player1: null, player2: null, result: null, reported: false, bye: false }],
    });
  } else {
    t.topCutBracket.push({
      name: 'Finals',
      matches: [{ id: crypto.randomUUID(), player1: matches[0].player1, player2: matches[0].player2, result: null, reported: false, bye: false }],
    });
  }

  saveTournament(t);
  res.json({ success: true });
});

// Advance to finals
app.post('/api/admin/advance-finals', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.topCutSize !== 4) return res.status(400).json({ error: 'N/A' });

  const semis = t.topCutBracket[0];
  const finals = t.topCutBracket[1];

  const getWinner = (m) => {
    if (!m.reported) return null;
    if (m.result === 'p1') return m.player1;
    if (m.result === 'p2') return m.player2;
    return null;
  };

  const w1 = getWinner(semis.matches[0]);
  const w2 = getWinner(semis.matches[1]);
  if (!w1 || !w2) return res.status(400).json({ error: 'Semis not complete' });

  finals.matches[0].player1 = w1;
  finals.matches[0].player2 = w2;
  saveTournament(t);
  res.json({ success: true });
});

// Finish tournament
app.post('/api/admin/finish', requireAdmin, (req, res) => {
  const t = req.tournament;
  t.finished = true;
  saveTournament(t);
  res.json({ success: true });
});

// Cancel tournament (delete entirely)
app.post('/api/admin/cancel', requireAdmin, (req, res) => {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  res.json({ success: true });
});

// Reset tournament — keep players/IDs/links, wipe all rounds and results
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const t = req.tournament;
  t.rounds = [];
  t.currentRound = 0;
  t.totalRounds = 0;
  t.started = false;
  t.registrationLocked = false;
  t.topCutPhase = false;
  t.topCutBracket = [];
  t.finished = false;
  saveTournament(t);
  const standings = getStandings(t);
  res.json({ ...t, standings, adminToken: undefined });
});

// ── Page Routes ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/t/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.listen(PORT, () => {
  console.log(`Kyopal running on port ${PORT}`);
  const t = loadTournament();
  if (t) {
    console.log(`Active tournament: ${t.name} (${t.players.length} players)`);
    console.log(`Admin token: ${t.adminToken}`);
  } else {
    console.log('No active tournament. Create one via the admin panel.');
  }
});
