import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kickoffMs, buildRounds, dueReminder, playersMissingPredictions, buildEmail, HOUR, MINUTE } from './reminders.js';

const teams = { 1: { name: 'Arsenal' }, 2: { name: 'Celtic' }, 3: { name: 'FC Porto' }, 4: { name: 'AS Roma' } };
const league = {
  10: { matchday: 5, datetime: '2026-11-24 18:45', home_id: 1, away_id: 2, home_goals: '', away_goals: '' },
  11: { matchday: 5, datetime: '2026-11-25 21:00', home_id: 3, away_id: 4, home_goals: '', away_goals: '' },
  12: { matchday: 6, datetime: '2026-12-09 21:00', home_id: 2, away_id: 3, home_goals: '', away_goals: '' },
};
const knockout = [null, { round: 'Round of 16', leg: '1st leg', datetime: '2027-03-09 21:00', home_id: '', away_id: '' }];
const players = [{ uid: 'a', name: 'Ana' }, { uid: 'b', name: 'Bogdan' }];
const md5Start = kickoffMs('2026-11-24 18:45');

test('kickoff converts CET to UTC (winter = UTC+1, summer = UTC+2)', () => {
  assert.equal(new Date(kickoffMs('2026-11-24 18:45')).toISOString(), '2026-11-24T17:45:00.000Z');
  assert.equal(new Date(kickoffMs('2026-09-16 21:00')).toISOString(), '2026-09-16T19:00:00.000Z');
});

test('groups by matchday and knockout round + leg', () => {
  const rounds = buildRounds({ league, knockout }, teams);
  assert.deepEqual(rounds.map(r => r.label), ['Matchday 5', 'Matchday 6', 'Round of 16 · 1st leg']);
  assert.equal(rounds[0].firstKickoff, md5Start);
  assert.equal(rounds[0].matches.length, 2);
});

test('due reminder windows', () => {
  const r = { firstKickoff: md5Start };
  assert.equal(dueReminder(r, md5Start - 25 * HOUR), null);
  assert.equal(dueReminder(r, md5Start - 24 * HOUR), '24h');
  assert.equal(dueReminder(r, md5Start - 2 * HOUR), '24h');
  assert.equal(dueReminder(r, md5Start - 60 * MINUTE), '1h');
  assert.equal(dueReminder(r, md5Start - 1 * MINUTE), '1h');
  assert.equal(dueReminder(r, md5Start), null);
});

test('round does not restart after its first match is played', () => {
  const played = { ...league, 10: { ...league[10], home_goals: '2', away_goals: '1' } };
  const [md5] = buildRounds({ league: played }, teams);
  assert.equal(md5.firstKickoff, md5Start);
  assert.equal(dueReminder(md5, md5Start + HOUR), null);
});

test('finds players missing at least one prediction', () => {
  const [md5] = buildRounds({ league }, teams);
  const preds = { matches: { 10: { a: { home_goals: 1, away_goals: 0 }, b: { home_goals: 2, away_goals: 2 } }, 11: { a: { home_goals: 0, away_goals: 0 } } } };
  const missing = playersMissingPredictions(md5, players, preds, md5Start - HOUR);
  assert.deepEqual(missing.map(p => [p.name, p.missing.map(m => m.id)]), [['Bogdan', ['11']]]);
  assert.equal(playersMissingPredictions(md5, players, undefined, md5Start - HOUR).length, 2);
});

test('matches with unknown teams are not counted as missing', () => {
  const rounds = buildRounds({ knockout }, teams);
  assert.equal(playersMissingPredictions(rounds[0], players, {}, 0).length, 0);
});

test('email lists the missing matches', () => {
  const [md5] = buildRounds({ league }, teams);
  const [player] = playersMissingPredictions(md5, players.slice(0, 1), {}, md5Start - HOUR);
  const template = 'Subject: {round} — {count} missing, {name}\n\nHi <{name}>,\n\n{matches}\n\nGo: {link}\n\n{link}\n';
  const mail = buildEmail({ player, round: md5, template, siteUrl: 'https://x.test/', timeZone: 'Europe/Paris,Europe/Bucharest' });
  assert.equal(mail.subject, 'Matchday 5 — 2 predictions missing, Ana');
  assert.match(mail.text, /^Hi <Ana>,/);
  assert.match(mail.text, /  • Arsenal vs Celtic — Tue 24 Nov, 18:45 CET \/ 19:45 EET/);
  assert.match(mail.text, /Go: https:\/\/x\.test\//);
  assert.match(mail.html, /Hi &lt;Ana&gt;,/);
  assert.match(mail.html, /<li[^>]*>FC Porto vs AS Roma/);
  assert.match(mail.html, /Go: <a href="https:\/\/x\.test\/">/);
  assert.match(mail.html, /Make my predictions/);
});

test('Romanian emails get Romanian placeholders and button', () => {
  const [md5] = buildRounds({ league }, teams);
  const [player] = playersMissingPredictions(md5, players.slice(0, 1), {}, md5Start - HOUR);
  const mail = buildEmail({ player, round: md5, reminder: '24h', lang: 'ro', template: '{round}: {count} ({start})\n\n{matches}\n\n{link}', siteUrl: 'https://x.test/', timeZone: 'Europe/Paris,Europe/Bucharest' });
  assert.equal(mail.subject, '⏰ Etapa 5 incepe maine — 2 predictii lipsa');
  assert.match(mail.text, /^Etapa 5: 2 predictii \(marți, 24 noiembrie, 18:45 CET \/ 19:45 EET\)/);
  assert.match(mail.text, /  • Arsenal - Celtic, marți, 24 noiembrie, 18:45 CET \/ 19:45 EET/);
  assert.match(mail.html, /Baga predictiile/);
});

test('knockout round names stay as on the site in every language', () => {
  const [r16] = buildRounds({ knockout: { 5: { round: 'Round of 16', leg: '1st leg', datetime: '2027-03-09 21:00', home_id: 1, away_id: 2 } } }, teams);
  const [player] = playersMissingPredictions(r16, players.slice(0, 1), {}, 0);
  const mail = buildEmail({ player, round: r16, reminder: '1h', lang: 'ro', template: '{round}', siteUrl: '', timeZone: 'UTC' });
  assert.equal(mail.text, 'Round of 16 · 1st leg');
});

test('template without a Subject line uses the default subject and keeps the whole body', () => {
  const [md5] = buildRounds({ league }, teams);
  const [player] = playersMissingPredictions(md5, players.slice(0, 1), {}, md5Start - HOUR);
  const mail = buildEmail({ player, round: md5, reminder: '1h', template: 'Hi {name}\n\n{matches}', siteUrl: '', timeZone: 'UTC' });
  assert.equal(mail.subject, '🚨 Matchday 5 kicks off in 1 hour — 2 predictions missing');
  assert.match(mail.text, /^Hi Ana\n/);
});
