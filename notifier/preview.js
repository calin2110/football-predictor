// Shows what the reminder emails look like, using made-up matches. Sends nothing, needs no keys.
// Usage: npm run preview   → prints every email as text and writes preview-<lang>-<reminder>.html to open in a browser
import { readFileSync, writeFileSync } from 'node:fs';
import { buildRounds, playersMissingPredictions, buildEmail, HOUR, LANGUAGES } from './reminders.js';

const teams = { 1: { name: 'Arsenal FC' }, 2: { name: 'Celtic' }, 3: { name: 'FC Porto' }, 4: { name: 'AS Roma' } };
const league = {
  1: { matchday: 4, datetime: '2026-11-03 18:45', home_id: 1, away_id: 2 },
  2: { matchday: 4, datetime: '2026-11-04 21:00', home_id: 3, away_id: 4 },
};
const [round] = buildRounds({ league }, teams);
const [player] = playersMissingPredictions(round, [{ uid: 'x', name: 'Tudor' }], {}, round.firstKickoff - 2 * HOUR);

for (const lang of Object.keys(LANGUAGES)) {
  for (const reminder of ['24h', '1h']) {
    const template = readFileSync(new URL(`./templates/${lang}/${reminder}.txt`, import.meta.url), 'utf8');
    const mail = buildEmail({ player, round, reminder, lang, template, siteUrl: 'https://calin2110.github.io/football-predictor/', timeZone: 'Europe/Paris,Europe/Bucharest' });
    const file = `preview-${lang}-${reminder}.html`;
    writeFileSync(new URL(`./${file}`, import.meta.url), `<meta charset="utf-8"><title>${mail.subject}</title><p><b>Subject:</b> ${mail.subject}</p><hr>${mail.html}`);
    console.log(`===== ${lang.toUpperCase()} · ${reminder} reminder  (open notifier/${file} for the formatted version) =====`);
    console.log(`Subject: ${mail.subject}\n\n${mail.text}\n`);
  }
}
