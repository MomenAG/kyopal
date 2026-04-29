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
          } else if ((match.result === 'p1' && isP1) || (match.result === 'p2' && !isP1)) {
            wins++;
          } else {
            losses++;
          }
        }
      }
    }
  }

  const matchPoints = wins * 3;
  const matchesPlayed = wins + losses;
  const matchWinPct = matchesPlayed > 0 ? Math.max(matchPoints / (matchesPlayed * 3), 0.25) : 0.25;
  const gameWinPct = matchesPlayed > 0 ? Math.max(wins / matchesPlayed, 0.25) : 0.25;

  return { wins, losses, byes, matchPoints, matchWinPct, gameWinPct, opponents, matchesPlayed };
}

function getOppWinPct(tournament, playerId) {
  const record = getPlayerRecord(tournament, playerId);
  if (record.opponents.length === 0) return 0.25;
  const oppPcts = record.opponents.map(opp => getPlayerRecord(tournament, opp).matchWinPct);
  return oppPcts.reduce((a, b) => a + b, 0) / oppPcts.length;
}

function getOppOppWinPct(tournament, playerId) {
  const record = getPlayerRecord(tournament, playerId);
  if (record.opponents.length === 0) return 0.25;
  const oppOppPcts = record.opponents.map(opp => getOppWinPct(tournament, opp));
  return oppOppPcts.reduce((a, b) => a + b, 0) / oppOppPcts.length;
}

function getTiebreakerNumber(tournament, playerId) {
  const rec = getPlayerRecord(tournament, playerId);
  const owp = getOppWinPct(tournament, playerId);
  const oowp = getOppOppWinPct(tournament, playerId);
  const xx = rec.matchPoints;
  const yyy = Math.round(owp * 1000);
  const zzz = Math.round(oowp * 1000);
  return xx * 1000000 + yyy * 1000 + zzz;
}

function getStandings(tournament) {
  return tournament.players.map(p => {
    const rec = getPlayerRecord(tournament, p.id);
    const owp = getOppWinPct(tournament, p.id);
    const oowp = getOppOppWinPct(tournament, p.id);
    const tb = getTiebreakerNumber(tournament, p.id);
    return { ...p, ...rec, oppWinPct: owp, oppOppWinPct: oowp, tiebreaker: tb };
  }).sort((a, b) => b.tiebreaker - a.tiebreaker);
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
    playerList = shuffle(tournament.players);
  } else {
    playerList = [...getStandings(tournament)];
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

// Remove a player (before tournament starts)
app.post('/api/admin/remove-player', requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.started) return res.status(400).json({ error: 'Cannot remove after start' });

  const { playerId } = req.body;
  t.players = t.players.filter(p => p.id !== playerId);
  saveTournament(t);
  res.json({ players: t.players });
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

// Reset tournament
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const t = defaultTournament();
  saveTournament(t);
  res.json({ tournamentId: t.id, adminToken: t.adminToken });
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
