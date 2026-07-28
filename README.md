# THWACK! — Timing Disc Golf

A browser disc golf game built on throw timing. Five holes, up to four players,
three throws each. No dependencies, no build step — three static files that drop
straight onto GitHub Pages.

## How it plays

Every throw is three timed presses of **SPACE** (or a tap / click):

1. **AIM** — an arrow sweeps ±32° around the line to the basket. Stop it on your line.
2. **POWER** — a bar fills and drains. A white marker shows the power that lands
   exactly on the basket; the bar is scaled to the shot, so putts get fine control
   and drives use the whole range. If the basket is beyond your maximum, the bar
   says `OUT OF RANGE` and you lay up.
3. **RELEASE** — a marker sweeps across a bar. Dead centre flies straight;
   off centre hooks, and the hook bites harder as the disc slows and fades.

The disc then flies out under drag. Where it stops is where you throw from next,
just like the real thing.

## Scoring

| Event | Points |
| --- | --- |
| Ace (holed on throw 1) | +120 |
| Holed on throw 2 | +70 |
| Holed on throw 3 | +40 |
| Out of throws | +45 minus 1 per 7px of distance (max ~45, zero past ~170 ft) |
| Hit a tree | −4 each |
| Out of bounds | −8 |

Trees punish you twice: the points and the distance, since a `THWAP! FUCK!` kills
almost all your speed and kicks the disc off at a random angle.

Players are drawn at random from a fixed roster: **The Lumberjack**, **Double
Doink**, **Fucking Dave**, and **Thwap! Fuck!** Each plays a hole out in full
before the next one tees off, and every player faces an identical layout — the
courses are generated from a fixed seed per hole.

## Controls

- **SPACE** / **ENTER** / tap / click — advance the current phase
- **1–4** on the title screen — number of players
- 🔊 button — mute

## Running it locally

Any static file server works. For example:

```bash
python -m http.server 8123
```

Then open `http://localhost:8123`. Opening `index.html` directly via `file://`
also works in most browsers.

## Hosting on GitHub Pages

The repo root is already the site root, so no workflow or build is needed.

```bash
git init && git add . && git commit -m "THWACK! disc golf"
```

Push it to a GitHub repo, then in **Settings → Pages** set **Source** to
*Deploy from a branch*, pick your default branch and the `/ (root)` folder.
The game will be live at `https://<user>.github.io/<repo>/` within a minute or two.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, HUD, and controls |
| `styles.css` | Layout and theming |
| `game.js` | Course generation, flight physics, scoring, rendering |
| `.claude/launch.json` | Local dev server config — not needed for hosting |

## Tuning notes

The flight model is `pos += v` with `v *= 0.985` per frame, so a throw's reach is
`(v0 − 0.55) / 0.015` pixels. The power marker inverts that exactly, which is why
perfect timing lands within a pixel of the pin. The basket catches the disc
within 28px if it arrives slower than 1.7 units/frame — arrive hot and it spits
out. Meter speeds scale up ~8% per hole.
