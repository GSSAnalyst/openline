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
- **Feedback button** in the call screen. Read messages with `npm run admin -- feedback`.
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

## Share from your Mac (quick test with friends)

A free Cloudflare "quick tunnel" gives the app running on your computer a
public HTTPS link, with no account, domain or router setup:

```
friend's browser → https://random-words.trycloudflare.com → Cloudflare → tunnel → your Mac (localhost:3000)
```

Video calls don't pass through the tunnel or your Mac; once matched, friends
connect directly to each other. The tunnel only carries the site, logins and
matchmaking.

**One-time setup:** download `cloudflared` (Apple Silicon shown; use
`cloudflared-darwin-amd64.tgz` on Intel Macs, or `brew install cloudflared`
if you have Homebrew):

```bash
curl -L -o /tmp/cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
tar -xzf /tmp/cf.tgz -C ~ && ~/cloudflared --version
```

**Each time**, in two Terminal tabs:

```bash
# Tab 1: the app. TRUST_PROXY=1 makes rate limits see each friend's own IP
# instead of treating everyone as one visitor coming through the tunnel.
cd ~/Desktop/openline && TRUST_PROXY=1 npm start

# Tab 2: the tunnel. Prints the public link to share.
~/cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Things to know:

- **The link is temporary.** If your Mac sleeps or the Wi-Fi drops, Cloudflare
  deletes the tunnel and the link stops working for good. Run the tunnel
  command again for a new link, and send it to your friends.
- **Keep the Mac awake** while people use it: plug it in and run
  `caffeinate -dis` in a third tab.
- **Accounts persist** in `data/openline.db`, so friends can log back in on a
  new link.
- For a link that never changes and doesn't depend on your Mac, deploy it
  instead (see [Going live](#going-live)).

## Configuration

Set these as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (hosts usually set this for you) |
| `NODE_ENV` | (unset) | `production` for the live site: HTTPS-only cookies, HSTS, and the age check rules below |
| `DB_PATH` | `data/openline.db` | Where the SQLite database is stored. On a host, point this at a persistent disk |
| `ALLOW_SELF_DECLARED_AGE` | (unset) | In production, `true` lets people verify by typing their date of birth. Without it (and without a verification provider) nobody can get past the age step |
| `TURN_URLS` | (unset) | Comma-separated TURN server addresses, e.g. `turn:host:3478,turns:host:443?transport=tcp` |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | (unset) | TURN login. Only sent to verified, logged-in users |
| `STUN_URLS` | Google's public STUN | Comma-separated STUN servers |
| `TRUST_PROXY` | `1` in production, else `0` | How many reverse proxies sit in front of the app, so rate limits see real visitor IPs |

The database holds users' emails and password hashes. `data/` is in
`.gitignore`. Never commit it.

## Project layout

```
server.js            HTTP API, accounts, sessions, matchmaking, WebSocket signaling
scripts/admin.js     Moderation tool (npm run admin)
public/index.html    Page markup
public/app.js        Client: accounts UI, WebRTC call, chat, safety code
public/styles.css    Styles
public/terms.html    Terms of Service (draft, fill in placeholders)
public/privacy.html  Privacy Policy (draft, fill in placeholders)
render.yaml          Render deployment blueprint
data/                SQLite database (created on first run, not committed)
```

## Moderation

Reports are saved in the database. Review them with the admin tool. It runs
against the same database, also while the server is running (on Render: the
service's **Shell** tab).

```bash
npm run admin -- stats
npm run admin -- reports 50          # newest reports, with emails
npm run admin -- suspended           # accounts waiting for review
npm run admin -- user someone@example.com
npm run admin -- unsuspend someone@example.com   # after review; old reports stop counting
npm run admin -- suspend someone@example.com
npm run admin -- delete someone@example.com
npm run admin -- feedback             # messages sent with the Feedback button
npm run admin -- backup /path/to/backup.db
```

Check `suspended` regularly. An "appears under 18" report suspends someone
immediately, so a false report locks out an innocent person until you lift it.

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

## Going live

### 1. Decide on age verification

| Option | Cost | Strength |
|---|---|---|
| **Self-declared** (`ALLOW_SELF_DECLARED_AGE=true`): people type their date of birth | Free | Weak: anyone can lie. Same approach Omegle used. Some countries (e.g. the UK under the Online Safety Act) require stronger checks for adult-only services |
| **Verification provider** (Yoti, Persona, Veriff): ID or face age estimate | Roughly $0.10-$1.50 per check | Strong, and bans follow the person, not the email. Needs code to connect the provider |

### 2. Get a TURN server

Without one, about 1 in 6 calls fails to connect. Hosted options with free
tiers: [Metered](https://www.metered.ca/stun-turn), [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/),
or run your own [coturn](https://github.com/coturn/coturn) on a small VPS.
Copy the server addresses, username and credential for step 4.

### 3. Fill in the legal pages

Replace every highlighted `[placeholder]` in `public/terms.html` and
`public/privacy.html` (your name, contact email, country, dates), and have a
lawyer review them. They link from the sign-up form.

### 4. Deploy on Render

1. Sign in to [render.com](https://render.com) with GitHub.
2. **New > Blueprint**, choose this repo. Render reads `render.yaml`.
3. Enter the values it asks for: `ALLOW_SELF_DECLARED_AGE`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
4. Create. The first deploy takes a few minutes. Your site is at `https://openline-xxxx.onrender.com`.

The blueprint uses the **Starter** plan (about $7/month) plus a 1 GB disk
(about $0.25/month), because the free plan has no disk: every account would
vanish on each deploy, and free services sleep when idle, dropping calls.
After this, every push to `main` redeploys automatically.

Other hosts work too (Railway, Fly.io, a VPS with Caddy or nginx), as long as
they run a long-lived Node process with WebSockets, serve HTTPS, and give you a
persistent disk for `DB_PATH`. Serverless platforms (like Vercel functions)
won't work.

### 5. Optional: your own domain

Buy a domain (about $10-15/year), add it under the service's **Settings >
Custom Domains** in Render, and follow the DNS instructions. HTTPS is set up
for you.

### 6. After launch

- Check `npm run admin -- suspended` and `reports` often.
- Back up the database: Render keeps daily disk snapshots on paid plans. For an extra copy, run `npm run admin -- backup /var/data/backup.db` from the Shell.
- Still to build: email confirmation and "forgot password" (needs an email service such as Resend or Postmark), and a review process for appeals.

## Limits

- The safety code only helps if the two people compare it, for example by reading it out loud.
- Calls can't be seen by the server, so moderation depends on reports, verification and bans.
- Peer-to-peer calls let each person see the other's IP address (the Privacy Policy says so).
- For more than one server: Postgres instead of SQLite, and Redis for the queue and rate limits.
- Talk to a lawyer before launch about the terms, privacy policy, and the rules where you'll operate.
