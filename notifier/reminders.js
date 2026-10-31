// Pure logic for prediction reminders: no Firebase, no email, easy to test.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

// Ordered from latest to earliest; a round only ever gets the most urgent one that is due.
export const REMINDERS = [
  { key: '1h', before: 1 * HOUR },
  { key: '24h', before: 24 * HOUR },
];

// Same rules as the website (index.html): match datetimes are stored in CET/CEST.
// Last Sunday of March → last Sunday of October is CEST (UTC+2), otherwise CET (UTC+1).
export function cetOffset(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const lastSunday = (year, month) => {
    const last = new Date(Date.UTC(year, month, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  if (m > 3 && m < 10) return 2;
  if (m < 3 || m > 10) return 1;
  if (m === 3) return d >= lastSunday(y, 3) ? 2 : 1;
  return d < lastSunday(y, 10) ? 2 : 1;
}

export function kickoffMs(datetime) {
  const r = String(datetime || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!r) return null;
  const [, year, month, day, hour, minute] = r.map(Number);
  return Date.UTC(year, month - 1, day, hour - cetOffset(String(datetime)), minute, 0);
}

const isBlank = v => v === '' || v === null || v === undefined;
export const isPlayed = m => !isBlank(m.home_goals) && !isBlank(m.away_goals);

// Firebase keys cannot contain . # $ [ ] /
const safeKey = s => String(s).replace(/[.#$[\]/\s]+/g, '-');

// Everything in the emails that isn't written in the templates, per language.
// Knockout rounds keep their names from the site in every language, e.g. "Round of 16 · 1st leg".
export const LANGUAGES = {
  en: {
    dateLocale: 'en-GB',
    dateFormat: { weekday: 'short', day: 'numeric', month: 'short' },   // Tue 3 Nov
    matchday: n => `Matchday ${n}`,
    count: n => `${n} prediction${n === 1 ? '' : 's'}`,
    match: (m, when) => `${m.home} vs ${m.away} — ${when}`,
    button: 'Make my predictions',
    subjects: {
      '24h': '⏰ {round} starts tomorrow — {count} missing',
      '1h': '🚨 {round} kicks off in 1 hour — {count} missing',
    },
  },
  ro: {
    dateLocale: 'ro-RO',
    dateFormat: { weekday: 'long', day: 'numeric', month: 'long' },     // marți, 3 noiembrie
    matchday: n => `Etapa ${n}`,
    count: n => (n === 1 ? '1 predictie' : `${n}${n >= 20 ? ' de' : ''} predictii`),
    match: (m, when) => `${m.home} - ${m.away}, ${when}`,
    button: 'Baga predictiile',
    subjects: {
      '24h': '⏰ {round} incepe maine — {count} lipsa',
      '1h': '🚨 {round} incepe intr-o ora — {count} lipsa',
    },
  },
};

export function roundName(round, lang = 'en') {
  return round.stage === 'league' ? LANGUAGES[lang].matchday(round.matchday) : round.label;
}

// label is the English name, used in logs
function roundOf(match, stage) {
  if (stage === 'league') {
    return { id: `league_MD${match.matchday}`, label: `Matchday ${match.matchday}`, matchday: match.matchday };
  }
  const parts = [match.round, match.leg].filter(Boolean);
  return { id: safeKey(`${stage}_${parts.join('_')}`), label: parts.join(' · ') };
}

/**
 * Groups matches into "rounds" (league matchday, or knockout round + leg).
 * @param {Object<string, Object|Array>} matchesByStage  e.g. { league: {...}, knockout: {...} } as stored in Firebase
 * @param {Object} teams  teams as stored in Firebase (id → { name, ... })
 */
export function buildRounds(matchesByStage, teams) {
  const rounds = {};
  for (const [stage, raw] of Object.entries(matchesByStage)) {
    for (const [key, m] of Object.entries(raw || {})) {
      if (!m) continue;
      const kickoff = kickoffMs(m.datetime);
      if (kickoff === null) continue;
      if (stage === 'league' && isBlank(m.matchday)) continue;
      if (stage !== 'league' && isBlank(m.round)) continue;

      const { id, label, matchday } = roundOf(m, stage);
      const round = (rounds[id] ||= { id, stage, label, matchday, firstKickoff: Infinity, matches: [] });
      // The first kickoff counts played matches too, so a round doesn't "restart" once its opener is over.
      round.firstKickoff = Math.min(round.firstKickoff, kickoff);
      round.matches.push({
        id: String(parseInt(key, 10)),
        kickoff,
        played: isPlayed(m),
        home: teams?.[m.home_id]?.name ?? null,
        away: teams?.[m.away_id]?.name ?? null,
      });
    }
  }
  for (const r of Object.values(rounds)) r.matches.sort((a, b) => a.kickoff - b.kickoff);
  return Object.values(rounds).sort((a, b) => a.firstKickoff - b.firstKickoff);
}

/** Which reminder ('1h' | '24h') is due for a round right now, or null. */
export function dueReminder(round, now) {
  const left = round.firstKickoff - now;
  if (left <= 0) return null;
  return REMINDERS.find(r => left <= r.before)?.key ?? null;
}

/**
 * Players who are missing at least one prediction for a round, with the matches they're missing.
 * Only matches that are still open (not started, not played, both teams known) count.
 * @param {Array<{uid:string,name:string}>} players
 * @param {Object} predictions  predictions/<stage> as stored in Firebase: { matches: { matchId: { uid: {...} } } }
 */
export function playersMissingPredictions(round, players, predictions, now) {
  const open = round.matches.filter(m => !m.played && m.kickoff > now && m.home && m.away);
  const byMatch = predictions?.matches || {};
  return players
    .map(p => ({ ...p, missing: open.filter(m => !byMatch[m.id]?.[p.uid]) }))
    .filter(p => p.missing.length > 0);
}

// timeZones: one or more IANA zones (array or comma-separated), e.g. "Europe/Paris,Europe/Bucharest"
// → en: "Tue 3 Nov, 18:45 CET / 19:45 EET", ro: "marți, 3 noiembrie, 18:45 CET / 19:45 EET"
// (the date comes from the first zone)
export function formatKickoff(ms, timeZones, lang = 'en') {
  const { dateLocale, dateFormat } = LANGUAGES[lang];
  const zones = (Array.isArray(timeZones) ? timeZones : String(timeZones).split(','))
    .map(z => z.trim()).filter(Boolean);
  const date = new Date(ms);
  const day = new Intl.DateTimeFormat(dateLocale, { timeZone: zones[0], ...dateFormat }).format(date);
  const times = zones.map(timeZone => new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date));
  return `${day}, ${times.join(' / ')}`;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Fills in an email template (see templates/README.md).
 * Optional first line "Subject: ...", then the body. Placeholders: {name} {round} {start} {count} {matches} {link}
 * lang ('en' | 'ro') decides the language of the placeholders, the button and the default subject.
 */
export function buildEmail({ player, round, reminder, template, siteUrl, timeZone, lang = 'en' }) {
  const L = LANGUAGES[lang];
  if (!L) throw new Error(`Unknown language "${lang}"`);
  const lines = template.replace(/\r\n/g, '\n').split('\n');
  const subjectMatch = lines[0].match(/^\s*subject\s*:\s*(.*)$/i);
  const subjectTemplate = subjectMatch ? subjectMatch[1] : L.subjects[reminder];
  const bodyLines = subjectMatch ? lines.slice(1) : lines;

  const vars = {
    name: player.name,
    round: roundName(round, lang),
    start: formatKickoff(round.firstKickoff, timeZone, lang),
    count: L.count(player.missing.length),
  };
  const matches = player.missing.map(m => L.match(m, formatKickoff(m.kickoff, timeZone, lang)));
  const fill = (s, esc = x => x) => s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? esc(vars[k]) : all));

  const subject = fill(subjectTemplate).trim();
  const body = bodyLines.join('\n').trim();

  const text = fill(body)
    .replace(/^[ \t]*\{matches\}[ \t]*$/gm, matches.map(l => `  • ${l}`).join('\n'))
    .replace(/\{matches\}/g, matches.join(', '))
    .replace(/\{link\}/g, siteUrl);

  const button = `<a href="${escapeHtml(siteUrl)}" style="display:inline-block;background:#00d26a;color:#000;font-weight:bold;text-decoration:none;padding:10px 18px;border-radius:8px">${escapeHtml(L.button)}</a>`;
  const list = `<ul style="padding-left:20px;margin:0">${matches.map(l => `<li style="margin:4px 0">${escapeHtml(l)}</li>`).join('')}</ul>`;
  const paragraphs = body.split(/\n\s*\n/).map(par => {
    const p = par.trim();
    if (p === '{matches}') return list;
    if (p === '{link}') return `<p>${button}</p>`;
    const inner = fill(escapeHtml(p), escapeHtml)
      .replace(/\{matches\}/g, escapeHtml(matches.join(', ')))
      .replace(/\{link\}/g, `<a href="${escapeHtml(siteUrl)}">${escapeHtml(siteUrl)}</a>`)
      .replace(/\n/g, '<br>');
    return `<p>${inner}</p>`;
  });
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:520px">\n${paragraphs.join('\n')}\n</div>`;

  return { subject, text, html };
}
