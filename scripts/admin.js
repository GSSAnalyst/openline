#!/usr/bin/env node
// Openline moderation tool. Works on the same database as the server, and is
// safe to run while the server is up.
//
//   npm run admin -- stats
//   npm run admin -- reports [count]        newest reports, with emails
//   npm run admin -- suspended              accounts under review
//   npm run admin -- user <email>           one account and the reports against it
//   npm run admin -- suspend <email>
//   npm run admin -- unsuspend <email>      lift a suspension after review
//   npm run admin -- delete <email>         remove an account (reports are kept)
//   npm run admin -- feedback [count]       newest feedback messages
//   npm run admin -- backup <file>          consistent copy of the database
//
// Changes apply right away for new connections. Someone already online is
// disconnected the next time they press Start or Next.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'openline.db');
const db = new DatabaseSync(DB_PATH);
const [cmd, arg] = process.argv.slice(2);

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const userByEmail = (email) => {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!u) { console.error(`No account with email ${email}`); process.exit(1); }
  return u;
};

switch (cmd) {
  case 'stats': {
    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    console.table({
      accounts: one('SELECT COUNT(*) FROM users'),
      verified: one('SELECT COUNT(*) FROM users WHERE verified_at IS NOT NULL'),
      suspended: one('SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL'),
      'reports (7 days)': one(`SELECT COUNT(*) FROM reports WHERE at > ${Date.now() - 7 * 864e5}`),
      'active sessions': one(`SELECT COUNT(*) FROM sessions WHERE expires_at > ${Date.now()}`),
    });
    break;
  }
  case 'reports': {
    const rows = db.prepare(`
      SELECT r.at, r.reason, rep.email AS reporter, tgt.email AS target, tgt.suspended_at
      FROM reports r
      LEFT JOIN users rep ON rep.id = r.reporter
      LEFT JOIN users tgt ON tgt.id = r.target
      ORDER BY r.at DESC LIMIT ?`).all(Number(arg) || 50);
    console.table(rows.map((r) => ({
      when: when(r.at), reason: r.reason,
      reporter: r.reporter || '(deleted)', target: r.target || '(deleted)',
      'target suspended': r.suspended_at ? 'yes' : '',
    })));
    break;
  }
  case 'suspended': {
    const rows = db.prepare(`
      SELECT u.email, u.suspended_at,
        (SELECT COUNT(*) FROM reports WHERE target = u.id) AS reports,
        (SELECT GROUP_CONCAT(DISTINCT reason) FROM reports WHERE target = u.id) AS reasons
      FROM users u WHERE u.suspended_at IS NOT NULL ORDER BY u.suspended_at DESC`).all();
    console.table(rows.map((r) => ({ email: r.email, since: when(r.suspended_at), reports: r.reports, reasons: r.reasons })));
    break;
  }
  case 'user': {
    const u = userByEmail(arg);
    console.table({
      email: u.email, created: when(u.created_at), verified: when(u.verified_at),
      suspended: when(u.suspended_at), 'last cleared': when(u.cleared_at),
    });
    const rows = db.prepare(`
      SELECT r.at, r.reason, rep.email AS reporter FROM reports r
      LEFT JOIN users rep ON rep.id = r.reporter WHERE r.target = ? ORDER BY r.at DESC`).all(u.id);
    console.log(`Reports against ${u.email}:`);
    console.table(rows.map((r) => ({ when: when(r.at), reason: r.reason, reporter: r.reporter || '(deleted)' })));
    break;
  }
  case 'suspend': {
    const u = userByEmail(arg);
    // Sessions are kept so the app can show them the suspension notice.
    db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(Date.now(), u.id);
    console.log(`Suspended ${u.email}.`);
    break;
  }
  case 'unsuspend': {
    const u = userByEmail(arg);
    db.prepare('UPDATE users SET suspended_at = NULL, cleared_at = ? WHERE id = ?').run(Date.now(), u.id);
    console.log(`Lifted suspension for ${u.email}. Earlier reports no longer count toward a new automatic suspension.`);
    break;
  }
  case 'delete': {
    const u = userByEmail(arg);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(`Deleted ${u.email}. Their reports and blocks are kept.`);
    break;
  }
  case 'feedback': {
    const browser = (ua) => {
      const s = String(ua || '');
      const name = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
        : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Other';
      const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS/.test(s) ? 'Mac'
        : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '?';
      return `${name} / ${os}`;
    };
    const rows = db.prepare(`
      SELECT f.at, f.message, f.user_agent, u.email FROM feedback f
      LEFT JOIN users u ON u.id = f.user_id ORDER BY f.at DESC LIMIT ?`).all(Number(arg) || 30);
    if (!rows.length) console.log('No feedback yet.');
    for (const r of rows) {
      console.log(`\n${when(r.at)}  ${r.email || '(deleted)'}  [${browser(r.user_agent)}]`);
      console.log('  ' + r.message.replace(/\n/g, '\n  '));
    }
    break;
  }
  case 'backup': {
    if (!arg) { console.error('Give a file name, e.g. backup-2026-01-31.db'); process.exit(1); }
    const fs = require('fs');
    if (fs.existsSync(arg)) { console.error(`${arg} already exists`); process.exit(1); }
    db.exec(`VACUUM INTO '${arg.replace(/'/g, "''")}'`);
    console.log(`Backed up to ${arg}`);
    break;
  }
  default: {
    const fs = require('fs');
    const usage = fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//   npm')).map((l) => l.slice(5));
    console.log('Usage:\n' + usage.join('\n'));
    process.exit(cmd ? 1 : 0);
  }
}
db.close();
