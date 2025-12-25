## Nebula Poker (Multiplayer)

### Local run

1. Install Node.js 18+
2. Install deps:

```bash
npm install
```

3. Start server:

```bash
npm start
```

Open: `http://localhost:3000`

### Deploy (Railway / Render)

- Push this repo to GitHub (must include `index.html`, `server.js`, `package.json`)
- Create a new project on Railway/Render and import from GitHub
- It will run `npm install` and `npm start` automatically
- Share the deployed URL with friends

### How multiplayer works

- Server (`server.js`) hosts rooms + seats (3–10) and runs the **authoritative** hand loop using Socket.io.
- Clients join by Room ID, select seats, host starts the match, and all actions are sent as events.


