# THWACK! — Timing Disc Golf

A browser disc golf game built on throw timing. Five holes, up to five players,
three throws each. No dependencies, no build step — three static files that drop
straight onto GitHub Pages.

**Play it: https://echang15.github.io/thwack-disc-golf/**

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

## Trees, and what happens when you find them

Discs **ricochet** off trunks rather than simply dying. The disc reflects about
the surface normal, so the angle you strike at decides everything:

| Impact | Deflection | Speed kept |
| --- | --- | --- |
| Dead centre | ~180° — straight back at you | 10% |
| Half a radius out | ~90° | 21% |
| Fine graze | ~3° | 50% |

A square hit stops you dead. A glancing one is a **skip** that keeps running.

Clip **two trees on one throw** and it's a **DOUBLE DOINK** — shockwave rings,
a screen shake, and the disc's namesake plastered across the fairway.

## Perfect throws and ONLY GRUMBY

The power bar carries two zones: a narrow white box (the power that stops the
disc on the basket) and a wider green **sweet spot**. Stop the power in the green
band *and* the release dead centre, with no tree contact and no OB, and the throw
is graded **perfect** — tracked by the pips in the header.

Three perfect throws in a row and the next throw **throws itself**: the disc
routes around every tree on a planned path and drops into the chains, guaranteed.
Aim isn't graded, by the way — you pick your own line around the timber, so there
is no "correct" angle to mark you against.

A **hole in one** is met with the celebration it deserves: a parade of steaks.

## Scoring

| Event | Points |
| --- | --- |
| Ace (holed on throw 1) | +120 |
| Holed on throw 2 | +70 |
| Holed on throw 3 | +40 |
| Out of throws | +45 minus 1 per 7px of distance (max ~45, zero past ~170 ft) |
| Hit a tree | −4 each |
| Double doink (two trees, one throw) | −8 |
| Out of bounds | −8 |

Trees punish you twice: the points and the distance you lose to the ricochet.

Players are drawn at random from a fixed roster: **The Lumberjack**, **Double
Doink**, **Fucking Dave**, **Thwap! Fuck!**, and **He With Opinions**. Each plays a hole out in full
before the next one tees off, and every player faces an identical layout — the
courses are generated from a fixed seed per hole.

## Courses

Three courses, same five-hole structure, different knobs:

| Course | Difficulty | What changes |
| --- | --- | --- |
| Breezy Pines | Easy | Fewer, smaller trees · slower meters · wider perfect-throw windows |
| THWACK Classic | Medium | The original layout and tuning |
| Deadfall Ridge | Hard | More, bigger trees · faster meters · tight perfect-throw windows |

Each course has its own fixed seed, so every player on a given course still
faces an identical layout. Pick one from the title screen before teeing off.

## Controls

- **SPACE** / **ENTER** / tap / click — advance the current phase
- **1–5** on the title screen — number of players
- **◀ / ▶** on the title screen — change course
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

The perfect-throw windows are ~3 frames of meter travel wide (±47ms on power,
±54ms on release). They were originally set to the width of the drawn pin box,
which is ±0.9 frames — tighter than frame-perfect, which made the Grumby reward
effectively unreachable.

The Grumby shot plans its route with a grid A* (14px cells, trees dilated by the
disc radius) and then string-pulls the result so the disc flies long clean lines
instead of a grid staircase. A* is overkill for a dozen obstacles but it is
*complete*: if a gap exists it will be found, which is what lets the reward
promise a guaranteed hole-out.
