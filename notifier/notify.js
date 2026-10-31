// Sends "you haven't predicted yet" emails 24h and 1h before the first match of each matchday / round.
// Meant to be run every ~10-15 minutes (cron-job.org → GitHub Actions). Safe to run as often as you like:
// every email that goes out is recorded in Firebase, so nobody gets the same reminder twice.
//
// Environment:
//   MODE                      dry-run (default) | test | prod
//                               dry-run: only prints who would get what, sends nothing, writes nothing
//                               test:    sends every email to TEST_EMAIL instead of the real player
//                               prod:    sends to the players
//   TEST_EMAIL                where emails go in test mode
//   NOW                       optional, pretend it's this time (e.g. 2026-11-04T16:30:00Z) to test a reminder
//                             window. When set, the "already sent" records are ignored and not written.
//   FIREBASE_SERVICE_ACCOUNT  service account JSON (the whole file content) or a path to the .json file
//   GMAIL_USER, GMAIL_APP_PASSWORD   Gmail account + app password used to send (not needed for dry-run)
//   ONLY_PLAYER               optional, only handle this one player (by name), e.g. for testing
//   SITE_URL, DISPLAY_TZ      optional overrides

import { readFileSync } from 'node:fs';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getAuth } from 'firebase-admin/auth';
import nodemailer from 'nodemailer';
import { buildRounds, dueReminder, playersMissingPredictions, buildEmail, formatKickoff, LANGUAGES } from './reminders.js';

const readLocal = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// TEMPLATES.ro['24h'], TEMPLATES.en['1h'], ...
const TEMPLATES = Object.fromEntries(Object.keys(LANGUAGES).map(lang =>
  [lang, Object.fromEntries(['24h', '1h'].map(k => [k, readLocal(`./templates/${lang}/${k}.txt`)]))]));

// Player names are compared ignoring case and accents ("calin" = "Călin")
const nameKey = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Who gets which language: languages.json lists players by name (as on the site) per language.
const LANG_CONFIG = JSON.parse(readLocal('./languages.json'));
const DEFAULT_LANG = LANG_CONFIG.default || 'ro';
const LANG_BY_NAME = {};
for (const [lang, names] of Object.entries(LANG_CONFIG)) {
  if (lang === 'default' || !Array.isArray(names)) continue;
  if (!LANGUAGES[lang]) throw new Error(`languages.json: unknown language "${lang}"`);
  names.forEach(n => { LANG_BY_NAME[nameKey(n)] = lang; });
}
const langOf = player => LANG_BY_NAME[nameKey(player.name)] || DEFAULT_LANG;

const DB_URL ='https://champions-league-2026-default-rtdb.europe-west1.firebasedatabase.app';
const DB_ROOT = 'ucl2026';
// Firebase path of the matches → stage name used under predictions/
const STAGES = { group: 'league', knockout: 'knockout' };

const MODE = (process.env.MODE || 'dry-run').trim();
const TEST_EMAIL = process.env.TEST_EMAIL?.trim();
const NOW_OVERRIDE = process.env.NOW?.trim();
const SITE_URL = process.env.SITE_URL?.trim() || 'https://calin2110.github.io/football-predictor/';
const DISPLAY_TZ = process.env.DISPLAY_TZ?.trim() || 'Europe/Paris,Europe/Bucharest';
// Optional: only handle this one player (name as shown on the site, case-insensitive). Handy for testing.
const ONLY_PLAYER = process.env.ONLY_PLAYER ? nameKey(process.env.ONLY_PLAYER) : "";

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

if (!['dry-run', 'test', 'prod'].includes(MODE)) fail(`MODE must be dry-run, test or prod (got "${MODE}")`);
if (MODE === 'test' && !TEST_EMAIL) fail('MODE=test needs TEST_EMAIL');
if (MODE !== 'dry-run' && !(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)) {
  fail(`MODE=${MODE} needs GMAIL_USER and GMAIL_APP_PASSWORD`);
}

const now = NOW_OVERRIDE ? Date.parse(NOW_OVERRIDE) : Date.now();
if (Number.isNaN(now)) fail(`NOW is not a valid date: "${NOW_OVERRIDE}"`);
const simulated = Boolean(NOW_OVERRIDE);
// Test runs keep their own "sent" records so they never block the real reminders.
const SENT_ROOT = MODE === 'prod' ? 'notifications' : 'notifications_test';
const recordSends = MODE !== 'dry-run' && !simulated;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) fail('FIREBASE_SERVICE_ACCOUNT is not set');
  try {
    return JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'));
  } catch (e) {
    fail(`could not read FIREBASE_SERVICE_ACCOUNT: ${e.message}`);
  }
}

const app = initializeApp({ credential: cert(loadServiceAccount()), databaseURL: DB_URL });
const db = getDatabase(app);
const ref = path => db.ref(`${DB_ROOT}/${path}`);
const read = async path => (await ref(path).once('value')).val();

const mailer = MODE === 'dry-run' ? null : nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function emailsByUid(uids) {
  const out = {};
  for (let i = 0; i < uids.length; i += 100) {
    const { users } = await getAuth(app).getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
    users.forEach(u => { out[u.uid] = u.email; });
  }
  return out;
}

async function main() {
  console.log(`Mode: ${MODE}${MODE === 'test' ? ` (all emails → ${TEST_EMAIL})` : ''}`);
  console.log(`Now:  ${new Date(now).toISOString()}${simulated ? ' (simulated, "already sent" records ignored)' : ''}`);

  const [teams, usersRaw, predictions, ...matchLists] = await Promise.all([
    read('teams'), read('users'), read('predictions'),
    ...Object.keys(STAGES).map(path => read(`${path}/matches`)),
  ]);
  const matchesByStage = Object.fromEntries(Object.values(STAGES).map((stage, i) => [stage, matchLists[i]]));
  const allPlayers = Object.entries(usersRaw || {}).map(([uid, name]) => ({ uid, name: String(name) }));
  // Catch typos in languages.json
  const knownNames = new Set(allPlayers.map(p => nameKey(p.name)));
  Object.keys(LANG_BY_NAME).filter(n => !knownNames.has(n))
    .forEach(n => console.warn(`! languages.json: "${n}" doesn't match any player name — they'll get the default language`));

  const players = allPlayers.filter(p => !ONLY_PLAYER || nameKey(p.name) === ONLY_PLAYER);
  if (ONLY_PLAYER && !players.length) fail(`ONLY_PLAYER "${process.env.ONLY_PLAYER}" doesn't match any player`);
  const rounds = buildRounds(matchesByStage, teams);

  const upcoming = rounds.filter(r => r.firstKickoff > now).slice(0, 3);
  console.log(`Players: ${players.map(p => `${p.name} (${langOf(p)})`).join(', ')}`);
  console.log(`Next rounds: ${upcoming.map(r => `${r.label} (${formatKickoff(r.firstKickoff, DISPLAY_TZ)})`).join(', ') || 'none'}`);

  let sent = 0, failed = 0;
  for (const round of rounds) {
    const reminder = dueReminder(round, now);
    if (!reminder) continue;

    const sentPath = `${SENT_ROOT}/${round.id}/${reminder}`;
    const alreadySent = simulated ? {} : (await read(sentPath)) || {};
    const todo = playersMissingPredictions(round, players, predictions?.[round.stage], now)
      .filter(p => !alreadySent[p.uid]);

    console.log(`\n${round.label} — ${reminder} reminder: ${todo.length} player(s) to remind`);
    if (!todo.length) continue;

    const emails = await emailsByUid(todo.map(p => p.uid));
    for (const player of todo) {
      const realEmail = emails[player.uid];
      const to = MODE === 'test' ? TEST_EMAIL : realEmail;
      const lang = langOf(player);
      const msg = buildEmail({ player, round, reminder, lang, template: TEMPLATES[lang][reminder], siteUrl: SITE_URL, timeZone: DISPLAY_TZ });
      const subject = MODE === 'prod' ? msg.subject : `[TEST → ${player.name}] ${msg.subject}`;
      console.log(`  • ${player.name} <${realEmail ?? 'no email!'}> [${lang}]: missing ${player.missing.length}`);

      if (MODE === 'dry-run') continue;
      if (!to) { console.warn('    ! skipped: no email address on this account'); failed++; continue; }
      try {
        await mailer.sendMail({ from: `"UCL Predictions" <${process.env.GMAIL_USER}>`, to, subject, text: msg.text, html: msg.html });
        sent++;
        console.log(`    ✓ sent to ${to}`);
        if (recordSends) await ref(`${sentPath}/${player.uid}`).set(Date.now());
      } catch (e) {
        failed++;
        console.error(`    ✖ failed: ${e.message}`);
      }
    }
  }

  console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
  return failed;
}

let failed = 1;
try {
  failed = await main();
} catch (e) {
  console.error(e);
} finally {
  mailer?.close();
  await deleteApp(app);
}
process.exit(failed ? 1 : 0);
