# Kyopal — YGO Tournament Manager

A Swiss-pairing tournament manager built for Yu-Gi-Oh! locals. Supports live multiplayer — the TO manages everything from the admin panel while players track their matches from their phones.

## Features

- **Swiss pairing** with backtracking algorithm (no duplicate pairings)
- **Konami tiebreaker** system (XXYYYZZZ composite number)
- **Win / Loss / Double Loss** reporting (no score tracking needed)
- **Top Cut** bracket (Top 4 or Top 2)
- **Player registration** via shared link
- **Live updates** — player view auto-refreshes every 5 seconds
- **Mobile-first** dark UI designed for phone screens

## How It Works

1. **TO** opens `/admin` and creates a tournament
2. **TO** shares the player link (`/`) with participants
3. **Players** open the link and enter their name to register
4. **TO** locks registration and starts the tournament
5. **Players** see their table assignment and opponent on their phone
6. **TO** reports results after each match
7. **Players** see updated standings and round history in real time

## Deploy to Render (Free)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) and create a **New Web Service**
3. Connect your repo
4. Render will auto-detect `render.yaml` and configure everything
5. Set the `ADMIN_PASSWORD` environment variable to something secure

Or click **New Web Service → Build and deploy from a Git repository** and point it at your repo.

## Deploy to Railway (Free)

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub repo
4. Add environment variable: `ADMIN_PASSWORD=your_password`
5. Railway auto-detects Node.js and deploys

## Run Locally

```bash
npm install
ADMIN_PASSWORD=mypassword node server.js
```

Then open:
- Admin: `http://localhost:3000/admin`
- Players: `http://localhost:3000/`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `ADMIN_PASSWORD` | kyopal | Password to create tournaments |

## URLs

| Path | Who | What |
|------|-----|------|
| `/` | Players | Join tournament, view matches & standings |
| `/admin` | TO | Create, manage, report results |

## Tech Stack

- Node.js + Express
- Vanilla JS frontend (no build step)
- JSON file storage (no database needed)
- Zero dependencies beyond Express
