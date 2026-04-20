# srvx — Free Subdomain & Minecraft SRV Service

Claim a free subdomain or Minecraft SRV record under `srvx.dev`, `serververs.com`, or `srv.cx`.  
Powered by Cloudflare DNS + Node.js + SQLite.

## Stack
- **Frontend** — Vanilla HTML/CSS/JS (dark glassmorphism UI)
- **Backend** — Node.js + Express
- **Database** — SQLite via better-sqlite3
- **DNS** — Cloudflare API (CNAME + SRV records)
- **Hosting** — Self-hosted via Cloudflare Tunnel

## Setup

```bash
git clone https://github.com/YOURNAME/srvx.git
cd srvx
npm install
cp .env.example .env
# Fill in your CF_TOKEN and CF_ZONE_ID
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `CF_TOKEN` | Cloudflare API token (Zone DNS Edit) |
| `CF_ZONE_ID` | Zone ID for srvx.dev |
| `CF_ZONE_SERVERVERS` | Zone ID for serververs.com (optional, falls back to CF_ZONE_ID) |
| `CF_ZONE_SRVCX` | Zone ID for srv.cx (optional) |
| `PORT` | Server port (default: 3000) |

## API

```
GET  /api/check?name=myproject&domain=srvx.dev&type=web
POST /api/claim  { name, type, domain, mcHost?, mcPort?, mcPriority?, mcWeight? }
GET  /api/recent
```

## Adding a new domain

1. Add the domain to `ALLOWED_DOMAINS` in `server.js`
2. Add its zone ID as an env variable
3. Add the option to the `<select>` in `index.html`

## Minecraft SRV

Creates a `_minecraft._tcp.name.srvx.dev` SRV record pointing to your server host + port.  
Players can connect using just `name.srvx.dev` without specifying a port.
