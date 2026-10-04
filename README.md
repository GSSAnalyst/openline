# Openline (working name)

Random 1-to-1 video chat for verified adults (18+). Video and audio go directly
between the two browsers over WebRTC and are encrypted (DTLS-SRTP). The server
only introduces people and relays connection setup messages; it never receives media.

## Run it locally

```bash
npm install
npm start      # needs Node 22.13+ (uses the built-in SQLite)
npm run dev    # same, but restarts when you edit server.js
# open http://localhost:3000 in two different browsers (or one normal + one private window)
```

Browsers only allow camera access on `localhost` or HTTPS.

## How it works

1. **Account.** People sign up with email and password, then log in and log out. Passwords are hashed with scrypt. Logging in sets an `HttpOnly`, `SameSite=Lax` session cookie (30 days); only a SHA-256 hash of the session id is stored. Logging out deletes the session and closes that browser's call.
2. **Age gate.** Each account must pass an 18+ check once before it can be matched.
3. **Auth.** The WebSocket is authenticated by the same session cookie. Sockets from other sites (wrong `Origin`) are refused, as are cross-site POSTs. Not logged in, not verified, or suspended means no matchmaking.
4. **Matching.** Verified users join one queue and are paired at random. People who reported each other are never re-matched.
5. **Call setup.** The server relays the WebRTC offer/answer and ICE candidates between the pair only.
6. **Call.** Media flows peer to peer, encrypted end to end between the two browsers.
7. **Safety.** Report ends the call and blocks the pair. An "appears under 18" report suspends the account immediately; 3 reports from different people for other reasons also suspend it. Skipping is rate-limited.
8. **Interests.** People can list up to 5 interests. Someone with interests waits up to 5 seconds for a person who shares one, then is matched with anyone. Shared interests are shown when the call starts.
9. **Text chat.** Messages go over a WebRTC data channel, so they travel peer to peer inside the same encrypted connection as the video. The server never sees them.
10. **Safety code.** Both people see a 6-digit code made from the two connection fingerprints. If the codes match, the signaling server didn't swap in its own keys.
11. **Account settings.** Change password (logs out other devices), log out everywhere, delete account. Each asks for the current password. Suspended accounts can't be deleted while under review.
12. **Extras.** Live online count, <kbd>Esc</kbd> for next, <kbd>/</kbd> to jump to chat, and a heartbeat that drops dead connections every 30 seconds.

## What is stubbed and must change before launch

| Area | Now (dev) | Production |
|---|---|---|
| Age verification | Self-typed date of birth | Real provider (Yoti, Persona, Veriff). Store the provider's stable person id on the account and refuse to verify a second account for the same person, so bans can't be dodged by signing up again. The dev route is disabled when `NODE_ENV=production`. |
| Accounts | Email + password, no email confirmation or password reset | Add email confirmation and "forgot password" (needs an email sender) |
| Storage | SQLite file in `data/` (users, sessions, reports, blocked pairs, suspensions); live queue in memory | Fine for one server. For several servers, move to Postgres and share the queue via Redis |
| Login throttling | In memory, per IP | Shared store (Redis) once you run more than one server |
| Reports | Logged to console | Moderation queue with human review, appeals, and a path to report child-safety material to NCMEC |
| Connectivity | Public STUN only | Your own TURN server (coturn); roughly 10-20% of users can't connect without it |
| Transport | HTTP on localhost | HTTPS/WSS behind a reverse proxy |

## Known limits of the encryption

- The call is encrypted between the two browsers, but the signaling server
  could in theory swap in its own keys (man in the middle). The safety code on
  screen catches this, but only if the two people compare codes out loud.
- Because you can't see calls, moderation depends on reports, verification, and bans.

## Before you launch

Talk to a lawyer about terms of service, a privacy policy, data retention for
verification records, and obligations in the places you'll operate.
