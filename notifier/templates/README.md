# Email templates

One folder per language: `en/` and `ro/`. In each, `24h.txt` is sent 24h before the player's earliest game without a
prediction and `1h.txt` 1h before it (so someone who predicted Tuesday but not Wednesday gets them before Wednesday). Who gets which language is set in `../languages.json`
(players listed by their name on the site, case and accents don't matter; everyone not listed gets the `default` language).

- Optional: if the first line starts with `Subject:`, that's the email subject. Otherwise a default subject is used
  (en: `⏰ Matchday 4 starts tomorrow — 2 predictions missing`, ro: `⏰ Etapa 4 incepe maine — 2 predictii lipsa`).
- Write normal text; empty lines separate paragraphs.
- Placeholders (filled in per player, in their language):

| Placeholder | English | Romanian |
|---|---|---|
| `{name}` | the player's name | same |
| `{round}` | `Matchday 4`; knockouts: `Round of 16 · 1st leg` | `Etapa 4`; knockouts: same as English |
| `{start}` (kick-off of their earliest unpredicted game) | `Tue 3 Nov, 18:45 CET / 19:45 EET` | `marți, 3 noiembrie, 18:45 CET / 19:45 EET` |
| `{count}` | `2 predictions` | `2 predictii` |
| `{matches}` | every game in that matchday they still haven't predicted (put it on its own line) | same |
| `{link}` | on its own line: green "Make my predictions" button; inside a sentence: a normal link | button says "Baga predictiile" |

Preview without sending anything: `npm run preview` (from the `notifier` folder).
