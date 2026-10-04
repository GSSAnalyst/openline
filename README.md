# Openline

Random 1-to-1 video chat for verified adults (18+), with accounts.

Video, audio and text chat go directly between the two browsers over WebRTC and
are encrypted (DTLS-SRTP). The server handles accounts and introduces people;
it never receives the call or the chat messages.

## Features

- **Accounts.** Sign up, log in and log out with email and password. Sessions last 30 days.
- **18+ gate.** Each account passes an age check once before it can be matched.
- **Random video calls.** Press Start to be paired with someone, and Next (or <kbd>Esc</kbd>) to skip.
- **Text chat** next to the video, with a typing indicator. Sent peer to peer, never through the server.
- **Interests.** List up to 5. You're matched with someone who shares one, or with anyone after 5 seconds.
- **Safety code.** Both people see a 6-digit code. If the codes match, nobody is intercepting the call.
- **Reporting.** Ends the call and blocks the pair. Accounts are suspended automatically on serious reports.
- **Account settings.** Change password, log out everywhere, delete account.
- **Live online count** and keyboard shortcuts (<kbd>Esc</kbd> next, <kbd>/</kbd> focus chat).

## Run it locally

Needs **Node 22.13 or newer** (it uses Node's built-in SQLite, so there's no database to install).

```bash
npm install
npm start          # or: npm run dev  (restarts when you edit server.js)
```

Open http://localhost:3000 in two different browsers, or one normal and one
private window, and sign up with a different email in each. Browsers only allow
camera access on `localhost` or HTTPS.

## Configuration

Set these as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `NODE_ENV` | (unset) | Set to `production` to turn off the dev age check, require HTTPS cookies, and trust one reverse proxy |
| `DB_PATH` | `data/openline.db` | Where the SQLite database is stored. On a host, point this at a persistent disk |

The database holds users' emails and password hashes. `data/` is in
`.gitignore`. Never commit it.

## Project layout

```
server.js           HTTP API, accounts, sessions, matchmaking, WebSocket signaling
public/index.html   Page markup
public/app.js       Client: accounts UI, WebRTC call, chat, safety code
public/styles.css   Styles
data/               SQLite database (created on first run, not committed)
```

## How it works

1. **Account.** Passwords are hashed with scrypt. Logging in sets an `HttpOnly`, `SameSite=Lax` session cookie; only a SHA-256 hash of the session id is stored, so a leaked database can't be used to log in.
2. **Age gate.** An account must be verified as 18+ before it can connect for matching.
3. **Signaling.** The browser opens a WebSocket, authenticated by the same session cookie. Sockets and POST requests from other sites are refused.
4. **Matching.** Verified users wait in one queue. People with shared interests are paired first; otherwise anyone after 5 seconds. People who reported each other are never matched again.
5. **Call setup.** The server relays the WebRTC offer/answer and ICE candidates between the pair only.
6. **Call.** Video, audio and the chat data channel flow peer to peer, encrypted between the two browsers.
7. **Safety code.** Both browsers hash the two DTLS fingerprints into a 6-digit code. If the server swapped in its own keys, the codes would differ.
8. **Reports.** A report ends the call, blocks the pair, and is saved in the database. An "appears under 18" report suspends the account immediately; 3 reports from different people for other reasons also suspend it.

## Security

- Strict Content Security Policy (scripts only from this site), no framing, `nosniff`, no referrer, HSTS in production
- Rate limits: failed logins (10 per IP per 15 minutes), new accounts (5 per IP per hour), skips (20 per minute)
- Password re-check for changing password and deleting the account; changing it logs out other devices
- Heartbeat drops dead connections every 30 seconds

Found a security problem? Please report it privately to the maintainer instead of opening a public issue.

## Before launch

What's a stand-in today, and what production needs:

| Area | Now | Production |
|---|---|---|
| Age verification | Self-typed date of birth | A real provider (Yoti, Persona, Veriff). Store the provider's person id on the account and refuse to verify a second account for the same person, so bans can't be dodged by signing up again. The dev route is off when `NODE_ENV=production`. |
| Accounts | No email confirmation or password reset | Add both (needs an email sending service) |
| Moderation | Reports saved in the `reports` table | A review queue with human moderators, appeals, and a path to report child-safety material to NCMEC |
| Connectivity | Public STUN only | Your own TURN server (coturn); roughly 10-20% of users can't connect without it |
| Transport | HTTP on localhost | HTTPS/WSS behind a reverse proxy |
| Scale | One server: SQLite, queue and rate limits in memory | For several servers: Postgres, and Redis for the queue and rate limits |

## Deploying

Any host that runs a long-lived Node process with WebSockets works (Render,
Railway, Fly.io, or a VPS behind nginx or Caddy). It needs:

1. HTTPS, so browsers allow the camera.
2. `NODE_ENV=production`.
3. A persistent disk, with `DB_PATH` pointing to it, or accounts are lost on every redeploy.

Serverless platforms (like Vercel functions) won't work, because the WebSocket
connection has to stay open.

## Limits

- The safety code only helps if the two people compare it, for example by reading it out loud.
- Calls can't be seen by the server, so moderation depends on reports, verification and bans.
- Talk to a lawyer before launch about terms of service, a privacy policy, retention of verification records, and the rules where you'll operate.
