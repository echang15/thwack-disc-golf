/* THWACK! — a timing-based disc golf game.
   Everything is static: no build step, no dependencies, no network. */

(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const W = 1400, H = 700;              // world == canvas pixels
  const HOLES = 5;
  const THROWS_PER_HOLE = 3;
  const DRAG = 0.985;                   // per-frame velocity decay
  const V_STOP = 0.55;                  // disc is down when it drops below this
  const REACH = 1 / (1 - DRAG);         // ~66.7 : distance = (v0 - V_STOP) * REACH
  const MIN_V0 = 1.2, MAX_V0 = 21;      // reach: ~43px (tap-in) .. ~1360px (max drive)
  const DISC_R = 7;
  const BASKET_R = 28;                  // chains catch radius
  const CATCH_V = 1.7;                  // arrive faster than this and you blow through
  const OVERSHOOT = 1.35;               // power bar tops out at 135% of the shot needed

  // Meter geometry. Two different things are marked on the power bar:
  //   PIN_PX      — the exact power that stops the disc on the basket.
  //   POWER_WINDOW— the wider "sweet spot" that earns perfect-throw credit.
  // The perfect windows are what the drawing uses, so the player is graded on
  // exactly the zones they can see. They are ~3 frames of meter travel wide;
  // any tighter and a perfect throw needs frame-perfect input, which makes the
  // Grumby reward unreachable in practice.
  const BAR_W = 620;
  const PIN_PX = 14;                    // half-width of the white on-the-pin box
  const POWER_WINDOW = 0.07;            // half-width, in bar units (0..1)
  const CURVE_WINDOW = 0.13;            // half-width, in curve units (-1..1)
  const PERFECTS_FOR_GRUMBY = 3;
  const NAME_POOL = ['The Lumberjack', 'Double Doink', 'Fucking Dave', 'Thwap! Fuck!', 'He With Opinions'];

  // Courses: same five-hole structure, different knobs. treeCountMul/treeSizeMul
  // thicken the timber, speedMul speeds up every meter, windowMul shrinks the
  // perfect-throw credit (and the pin box stays put, so "lands on the basket"
  // never changes — only how forgiving "perfect" is does).
  const COURSES = [
    {
      id: 'breezy', name: 'Breezy Pines', tag: 'EASY', seed: 0xC0FFEE,
      treeCountMul: 0.6, treeSizeMul: 0.85, speedMul: 0.8, windowMul: 1.3,
      blurb: 'Open fairways, forgiving timing.'
    },
    {
      id: 'thwack', name: 'THWACK Classic', tag: 'MEDIUM', seed: 0xFACADE,
      treeCountMul: 1, treeSizeMul: 1, speedMul: 1, windowMul: 1,
      blurb: 'The original five. Balanced and fair.'
    },
    {
      id: 'deadfall', name: 'Deadfall Ridge', tag: 'HARD', seed: 0xBADA55,
      treeCountMul: 1.5, treeSizeMul: 1.15, speedMul: 1.25, windowMul: 0.7,
      blurb: 'Dense timber, faster meters, tight windows.'
    }
  ];

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const el = {
    player: document.getElementById('playerName'),
    hole: document.getElementById('holeInfo'),
    throw: document.getElementById('throwInfo'),
    dist: document.getElementById('distInfo'),
    streak: document.getElementById('streakInfo'),
    points: document.getElementById('pointsInfo'),
    hint: document.getElementById('hint'),
    action: document.getElementById('actionBtn'),
    mute: document.getElementById('muteBtn')
  };

  // ------------------------------------------------------------------ helpers
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const feet = px => Math.round(px * 0.55);      // purely cosmetic unit

  // Deterministic RNG so every player faces the identical hole layout.
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // -------------------------------------------------------------------- audio
  const audio = {
    on: true,
    ac: null,
    ctxOk() {
      if (!this.on) return false;
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ac = new AC();
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return true;
    },
    blip(freq, dur, type = 'sine', gain = 0.06) {
      if (!this.ctxOk()) return;
      const t = this.ac.currentTime;
      const osc = this.ac.createOscillator();
      const g = this.ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.ac.destination);
      osc.start(t);
      osc.stop(t + dur);
    },
    tick() { this.blip(880, 0.05, 'square', 0.03); },
    whoosh() { this.blip(320, 0.35, 'triangle', 0.05); },
    thwack() {
      this.blip(140, 0.25, 'sawtooth', 0.12);
      setTimeout(() => this.blip(90, 0.2, 'square', 0.08), 40);
    },
    chains() {
      [1200, 1500, 1800, 1350].forEach((f, i) =>
        setTimeout(() => this.blip(f, 0.18, 'triangle', 0.05), i * 55));
    },
    boo() { this.blip(190, 0.4, 'sawtooth', 0.08); },
    doink() {
      [660, 520, 660, 880].forEach((f, i) =>
        setTimeout(() => this.blip(f, 0.16, 'square', 0.07), i * 90));
    },
    fanfare() {
      [523, 659, 784, 1046, 1319].forEach((f, i) =>
        setTimeout(() => this.blip(f, 0.42, 'triangle', 0.07), i * 110));
    },
    grumby() {
      [392, 523, 659, 880, 1175].forEach((f, i) =>
        setTimeout(() => this.blip(f, 0.5, 'sine', 0.06), i * 85));
    }
  };

  // ------------------------------------------------------------- hole builder
  function buildHole(index) {
    const course = G.course || COURSES[1];
    const rng = makeRng(course.seed + index * 7919);
    const tee = { x: 110, y: H / 2 + (rng() - 0.5) * 220 };
    const basket = {
      x: 1010 + rng() * 250,
      y: 120 + rng() * (H - 240)
    };

    const trees = [];
    const wanted = Math.max(6, Math.round((11 + index * 3) * course.treeCountMul));
    let guard = 0;
    while (trees.length < wanted && guard++ < 4000) {
      const t = {
        x: 260 + rng() * (W - 380),
        y: 50 + rng() * (H - 100),
        r: (17 + rng() * 13) * course.treeSizeMul
      };
      if (dist(t, tee) < 150) continue;
      if (dist(t, basket) < 95) continue;
      if (trees.some(o => dist(o, t) < o.r + t.r + 26)) continue;
      trees.push(t);
    }

    // A few decorative bushes that don't block anything.
    const bushes = [];
    for (let i = 0; i < 18; i++) {
      bushes.push({ x: rng() * W, y: rng() * H, r: 6 + rng() * 9 });
    }

    return { index, tee, basket, trees, bushes, par: index < 2 ? 2 : 3 };
  }

  // ----------------------------------------------------------- path planning
  // Used only by the Grumby shot. A grid A* is overkill for a dozen trees, but
  // it is complete: if a gap exists the disc will find it, which matters when
  // the reward is billed as "avoids all obstacles".
  const CELL = 14;
  const GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);

  function planPath(from, to, trees) {
    // After a bounce the disc sits flush against a trunk, which is inside the
    // grid's blocked zone. Step it radially out into clear air first, otherwise
    // the opening leg of every such route clips the tree it is resting on.
    const resting = trees.find(t => Math.hypot(t.x - from.x, t.y - from.y) < t.r + DISC_R + 5);
    if (resting) {
      const others = trees.filter(t => t !== resting);
      const a = Math.atan2(from.y - resting.y, from.x - resting.x);
      const out = resting.r + DISC_R + 9;
      // Straight out is ideal, but a neighbouring trunk can be sitting there.
      // Fan out around the radial direction and take the roomiest option.
      let esc = null, best = -Infinity, bestP = null;
      for (let k = 0; k < 21; k++) {
        const off = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.1;   // 0, ±0.1 … ±1.0
        const p = {
          x: clamp(resting.x + Math.cos(a + off) * out, 16, W - 16),
          y: clamp(resting.y + Math.sin(a + off) * out, 16, H - 16)
        };
        const room = others.length
          ? Math.min(...others.map(t => Math.hypot(t.x - p.x, t.y - p.y) - t.r))
          : Infinity;
        if (room > DISC_R + 5 && clearLine(from, p, others)) { esc = p; break; }
        if (room > best) { best = room; bestP = p; }
      }
      return [{ ...from }].concat(planGrid(esc || bestP, to, trees));
    }
    return planGrid(from, to, trees);
  }

  function planGrid(from, to, trees) {
    const cx = p => clamp(Math.floor(p.x / CELL), 0, GW - 1);
    const cy = p => clamp(Math.floor(p.y / CELL), 0, GH - 1);
    const startI = cy(from) * GW + cx(from);
    const goalI = cy(to) * GW + cx(to);

    // Cells whose centre is inside a tree (plus disc radius and a margin) are
    // walls. The start cell is always walkable — the disc may be resting on a
    // trunk after a bounce.
    const blocked = new Uint8Array(GW * GH);
    for (const t of trees) {
      const pad = t.r + DISC_R + 4;
      const x0 = Math.max(0, Math.floor((t.x - pad) / CELL));
      const x1 = Math.min(GW - 1, Math.floor((t.x + pad) / CELL));
      const y0 = Math.max(0, Math.floor((t.y - pad) / CELL));
      const y1 = Math.min(GH - 1, Math.floor((t.y + pad) / CELL));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const px = gx * CELL + CELL / 2, py = gy * CELL + CELL / 2;
          if (Math.hypot(px - t.x, py - t.y) < pad) blocked[gy * GW + gx] = 1;
        }
      }
    }
    blocked[startI] = 0;
    blocked[goalI] = 0;

    const g = new Float32Array(GW * GH).fill(Infinity);
    const cameFrom = new Int32Array(GW * GH).fill(-1);
    const open = [startI];
    const f = new Float32Array(GW * GH).fill(Infinity);
    const hEst = i => {
      const dx = (i % GW) - (goalI % GW), dy = ((i / GW) | 0) - ((goalI / GW) | 0);
      return Math.hypot(dx, dy);
    };
    g[startI] = 0;
    f[startI] = hEst(startI);

    const seen = new Uint8Array(GW * GH);
    while (open.length) {
      // Small maps, so a linear scan for the best node is plenty fast.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === goalI) break;
      seen[cur] = 1;

      const gx = cur % GW, gy = (cur / GW) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const ni = ny * GW + nx;
          if (blocked[ni] || seen[ni]) continue;
          // No cutting diagonally through a corner gap.
          if (dx && dy && (blocked[gy * GW + nx] || blocked[ny * GW + gx])) continue;
          const step = g[cur] + (dx && dy ? 1.414 : 1);
          if (step < g[ni]) {
            g[ni] = step;
            f[ni] = step + hEst(ni);
            cameFrom[ni] = cur;
            if (!open.includes(ni)) open.push(ni);
          }
        }
      }
    }

    if (cameFrom[goalI] === -1 && startI !== goalI) return [{ ...from }, { ...to }];

    const cells = [];
    for (let i = goalI; i !== -1 && i !== startI; i = cameFrom[i]) cells.push(i);
    cells.reverse();
    const pts = [{ ...from }].concat(
      cells.map(i => ({ x: (i % GW) * CELL + CELL / 2, y: ((i / GW) | 0) * CELL + CELL / 2 }))
    );
    pts[pts.length - 1] = { ...to };
    return smoothPath(pts, trees);
  }

  // String-pulling: drop any waypoint we can see past, so the disc flies long
  // clean lines instead of tracing the grid staircase.
  function smoothPath(pts, trees) {
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) if (clearLine(pts[i], pts[j], trees)) break;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  function clearLine(a, b, trees) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const steps = Math.ceil(len / 6);
    for (const t of trees) {
      const pad = t.r + DISC_R + 3;
      for (let s = 0; s <= steps; s++) {
        const x = a.x + dx * (s / steps), y = a.y + dy * (s / steps);
        if (Math.hypot(x - t.x, y - t.y) < pad) return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------- game state
  const G = {
    phase: 'title',      // title | aim | power | curve | flight | throwResult | holeBoard | gameOver
    players: [],
    hole: null,
    holeIndex: 0,
    turn: 0,             // index into players
    disc: { x: 0, y: 0 },
    lies: [],            // previous landing spots this hole
    throwNo: 1,
    aim: 0, power: 0, curve: 0,
    meterT: 0,
    flight: null,
    message: null,       // { title, lines[], tone }
    floaters: [],
    fx: {},              // doink / steak / grumby overlays, each { t, life }
    shake: 0,
    t: 0
  };

  function newGame(playerCount) {
    const names = shuffle(NAME_POOL).slice(0, playerCount);
    G.players = names.map(n => ({ name: n, points: 0, holes: [], streak: 0, grumby: false }));
    G.course = COURSES[G.courseIndex];
    G.fx = {};
    G.holeIndex = 0;
    G.turn = 0;
    startHole();
  }

  function startHole() {
    G.hole = buildHole(G.holeIndex);
    G.turn = 0;
    startTurn();
  }

  function startTurn() {
    const h = G.hole;
    G.disc = { x: h.tee.x, y: h.tee.y };
    G.lies = [];
    G.throwNo = 1;
    G.holeStartPoints = player().points;
    beginAim();
  }

  function beginAim() {
    // Three perfect throws in a row and the next one throws itself.
    if (player().grumby) {
      G.phase = 'grumbyIntro';
      G.fx.grumby = { t: 0, life: 96 };
      audio.grumby();
      syncHud();
      el.hint.textContent = 'ONLY GRUMBY. Sit back.';
      return;
    }
    G.phase = 'aim';
    G.meterT = 0;
    G.aim = 0; G.power = 0; G.curve = 0;
    syncHud();
    el.hint.textContent = 'AIM — press when the arrow points where you want it.';
  }

  function launchGrumby() {
    const p = player();
    p.grumby = false;
    p.streak = 0;
    G.flight = {
      x: G.disc.x, y: G.disc.y,
      heading: 0,
      v: 0, v0: 1,
      trail: [],
      treeHits: 0,
      bounceLock: 0,
      ob: false,
      holed: false,
      perfect: false,
      frames: 0,
      guided: { path: planPath(G.disc, G.hole.basket, G.hole.trees), leg: 1, speed: 7 }
    };
    G.phase = 'flight';
    audio.whoosh();
    syncHud();
    el.hint.textContent = '…';
  }

  const player = () => G.players[G.turn];

  function syncHud() {
    if (!G.players.length) return;
    el.player.textContent = player().name;
    el.hole.textContent = `${G.holeIndex + 1} / ${HOLES} · ${G.course.tag}`;
    el.throw.textContent = `${Math.min(G.throwNo, THROWS_PER_HOLE)} of ${THROWS_PER_HOLE}`;
    el.dist.textContent = G.hole ? `${feet(dist(G.disc, G.hole.basket))} ft` : '—';
    el.points.textContent = player().points;

    const p = player();
    if (p.grumby) {
      el.streak.textContent = 'ONLY GRUMBY';
      el.streak.className = 'grumby-lit';
    } else {
      const n = p.streak || 0;
      el.streak.textContent = '●'.repeat(n) + '○'.repeat(PERFECTS_FOR_GRUMBY - n);
      el.streak.className = n ? 'streak-lit' : '';
    }
  }

  // ------------------------------------------------------------------- meters
  // Aim sweeps ±42° around the straight line to the basket.
  const AIM_SPAN = 32 * Math.PI / 180;
  function meterSpeed() { return (1 + G.holeIndex * 0.08) * (G.course ? G.course.speedMul : 1); }
  function effPowerWindow() { return POWER_WINDOW * (G.course ? G.course.windowMul : 1); }
  function effCurveWindow() { return CURVE_WINDOW * (G.course ? G.course.windowMul : 1); }

  function aimAngle() {
    const base = Math.atan2(G.hole.basket.y - G.disc.y, G.hole.basket.x - G.disc.x);
    return base + Math.sin(G.meterT * 1.5 * meterSpeed()) * AIM_SPAN;
  }

  function powerValue() {
    const p = (G.meterT * 0.75 * meterSpeed()) % 2;
    return p < 1 ? p : 2 - p;                     // triangle wave 0..1
  }

  function curveValue() {
    return Math.sin(G.meterT * 2.4 * meterSpeed());
  }

  // Launch speed that would stop the disc exactly on the basket.
  function neededV0() {
    return dist(G.disc, G.hole.basket) / REACH + V_STOP;
  }

  // The bar is scaled to the shot: a 30 ft putt gets a fine-grained bar, a
  // 600 ft drive gets the whole range. Without this, one frame of timing error
  // on a putt would be wider than the basket itself.
  function shotMaxV0() {
    return clamp(neededV0() * OVERSHOOT, 3, MAX_V0);
  }

  // Where the marker sits on that bar (>1 means the basket is out of reach).
  function idealPower() {
    return (neededV0() - MIN_V0) / (shotMaxV0() - MIN_V0);
  }

  // -------------------------------------------------------------------- input
  function press() {
    audio.ctxOk();
    switch (G.phase) {
      case 'title':
        newGame(G.pendingPlayers || 5);
        break;
      case 'aim':
        G.aim = aimAngle();
        audio.tick();
        G.phase = 'power';
        el.hint.textContent = 'POWER — stop the bar on the marker to land on the basket.';
        break;
      case 'power':
        G.power = powerValue();
        audio.tick();
        G.phase = 'curve';
        el.hint.textContent = 'RELEASE — dead centre flies straight. Off centre hooks.';
        break;
      case 'curve':
        G.curve = curveValue();
        launch();
        break;
      case 'throwResult':
        dismissResult();
        break;
      case 'holeBoard':
        advanceHole();
        break;
      case 'gameOver':
        G.phase = 'title';
        el.hint.textContent = 'Press to begin.';
        break;
    }
  }

  // ------------------------------------------------------------------- flight
  function launch() {
    audio.whoosh();
    const v0 = MIN_V0 + G.power * (shotMaxV0() - MIN_V0);
    G.flight = {
      x: G.disc.x, y: G.disc.y,
      heading: G.aim,
      v: v0, v0,
      trail: [],
      treeHits: 0,
      bounceLock: 0,
      ob: false,
      holed: false,
      perfect: isPerfectRelease(),
      frames: 0
    };
    G.phase = 'flight';
    el.hint.textContent = '…';
  }

  // Both meters stopped inside the windows drawn on screen: the power marker's
  // white box and the release bar's green centre. Aim is deliberately excluded —
  // the player picks their own line around the trees, so there is no "correct"
  // angle to grade them against.
  function isPerfectRelease() {
    const ideal = idealPower();
    const powerOk = ideal > 1 ? G.power >= 0.97 : Math.abs(G.power - ideal) <= effPowerWindow();
    return powerOk && Math.abs(G.curve) <= effCurveWindow();
  }

  function stepFlight() {
    const f = G.flight;
    const h = G.hole;

    if (f.guided) return stepGuided(f);

    // Fade: the slower the disc, the harder the release error bites.
    const fade = 0.4 + 1.3 * (1 - f.v / f.v0);
    f.heading += G.curve * 0.0105 * fade;

    f.x += Math.cos(f.heading) * f.v;
    f.y += Math.sin(f.heading) * f.v;
    f.v *= DRAG;
    f.frames++;

    f.trail.push({ x: f.x, y: f.y });
    if (f.trail.length > 46) f.trail.shift();

    // Trees. The disc reflects off the trunk like a ball off a cushion: the
    // surface normal points out from the tree centre, so a square hit comes
    // straight back and dies, while a glancing hit skips away with most of
    // its pace intact.
    if (f.bounceLock > 0) f.bounceLock--;
    else for (const t of h.trees) {
      const d = Math.hypot(t.x - f.x, t.y - f.y);
      if (d >= t.r + DISC_R) continue;

      const nx = (f.x - t.x) / (d || 1), ny = (f.y - t.y) / (d || 1);
      const dx = Math.cos(f.heading), dy = Math.sin(f.heading);
      const dot = dx * nx + dy * ny;              // ≈ -1 square on, ≈ 0 glancing

      // Sit the disc on the trunk surface so it can't tunnel through.
      f.x = t.x + nx * (t.r + DISC_R + 0.5);
      f.y = t.y + ny * (t.r + DISC_R + 0.5);

      // Reflect the heading about the surface normal.
      const rx = dx - 2 * dot * nx, ry = dy - 2 * dot * ny;
      const glance = clamp(1 - Math.abs(dot), 0, 1);
      f.heading = Math.atan2(ry, rx) + (Math.random() - 0.5) * 0.14 * (1 - glance);
      f.v *= 0.16 + 0.66 * glance;

      f.treeHits++;
      f.bounceLock = 4;                            // no re-hit while leaving
      G.shake = 10 + 10 * (1 - glance);
      audio.thwack();

      if (f.treeHits === 2) {
        startDoink(f.x, f.y);
      } else {
        addFloater(f.x, f.y,
          glance > 0.55 ? 'SKIP!' : f.treeHits > 2 ? 'THWACK!' : 'THWAP! FUCK!',
          glance > 0.55 ? '#ffd75e' : '#ff6b5e');
      }
      break;
    }

    // Chains: you have to arrive slow enough for them to hold you.
    const dBasket = Math.hypot(h.basket.x - f.x, h.basket.y - f.y);
    if (dBasket < BASKET_R) {
      if (f.v < CATCH_V) {
        f.holed = true;
        audio.chains();
        return endFlight();
      }
      addFloater(f.x, f.y, 'SPIT OUT', '#ffd75e');   // too hot — blows through
    }

    // Out of bounds.
    if (f.x < 8 || f.x > W - 8 || f.y < 8 || f.y > H - 8) {
      f.ob = true;
      f.x = clamp(f.x, 30, W - 30);
      f.y = clamp(f.y, 30, H - 30);
      audio.boo();
      return endFlight();
    }

    if (f.v < V_STOP || f.frames > 900) endFlight();
  }

  // The Grumby shot flies the planned polyline and holes out. No drag, no
  // fade, no trees — that is the whole point of earning it.
  function stepGuided(f) {
    const g = f.guided;
    const target = g.path[g.leg];
    f.frames++;

    const dx = target.x - f.x, dy = target.y - f.y;
    const d = Math.hypot(dx, dy);
    f.heading = Math.atan2(dy, dx);
    f.v = g.speed;

    if (d <= g.speed) {
      f.x = target.x;
      f.y = target.y;
      g.leg++;
      if (g.leg >= g.path.length) {
        f.holed = true;
        audio.chains();
        return endFlight();
      }
    } else {
      f.x += (dx / d) * g.speed;
      f.y += (dy / d) * g.speed;
    }

    f.trail.push({ x: f.x, y: f.y });
    if (f.trail.length > 70) f.trail.shift();
    if (f.frames > 1200) { f.holed = true; return endFlight(); }
  }

  function endFlight() {
    const f = G.flight;
    const h = G.hole;
    G.lies.push({ x: G.disc.x, y: G.disc.y });
    G.disc = { x: f.x, y: f.y };

    let delta = 0;
    const lines = [];

    if (f.treeHits === 2) {
      delta -= 8;
      lines.push('DOUBLE DOINK — 8 pts');
    } else if (f.treeHits) {
      delta -= 4 * f.treeHits;
      lines.push(`${f.treeHits} tree${f.treeHits > 1 ? 's' : ''} — ${4 * f.treeHits} pts`);
    }
    if (f.ob) {
      delta -= 8;
      lines.push('Out of bounds — 8 pts');
    }

    // A perfect throw is a clean one: both meters nailed and no timber.
    const p = player();
    if (!f.guided) {
      if (f.perfect && !f.treeHits && !f.ob) {
        p.streak = (p.streak || 0) + 1;
        addFloater(f.x, f.y - 26, 'PERFECT!', '#5ad07a');
        if (p.streak >= PERFECTS_FOR_GRUMBY) p.grumby = true;
      } else {
        p.streak = 0;
      }
    }

    let title, tone = 'plain', done = false;

    if (f.holed) {
      const bonus = [0, 120, 70, 40][G.throwNo] || 40;
      delta += bonus;
      title = f.guided ? 'ONLY GRUMBY.' : G.throwNo === 1 ? 'ACE! CHAINS!' : 'IN THE BASKET!';
      lines.push(`Holed in ${G.throwNo} — +${bonus} pts`);
      tone = 'good';
      done = true;
      if (G.throwNo === 1) startSteaks();
    } else if (G.throwNo >= THROWS_PER_HOLE) {
      const d = dist(G.disc, h.basket);
      const prox = Math.max(0, Math.round(45 - d / 7));
      delta += prox;
      title = 'OUT OF THROWS';
      lines.push(`${feet(d)} ft from the basket — +${prox} pts`);
      tone = prox >= 25 ? 'good' : 'bad';
      done = true;
    } else {
      const d = dist(G.disc, h.basket);
      title = f.ob ? 'OB — take the lie'
        : f.treeHits === 2 ? 'DOUBLE DOINK'
        : f.treeHits ? 'Blocked by timber'
        : f.perfect ? 'PERFECT THROW' : 'Nice look';
      lines.push(`${feet(d)} ft out, ${THROWS_PER_HOLE - G.throwNo} throw${THROWS_PER_HOLE - G.throwNo > 1 ? 's' : ''} left`);
    }

    player().points += delta;
    G.lastDelta = delta;
    G.holeDone = done;
    G.message = { title, lines, tone, delta };
    G.phase = 'throwResult';
    G.flight = null;
    syncHud();
    el.hint.textContent = done ? 'Press to continue.' : 'Press to line up the next throw.';
  }

  function dismissResult() {
    G.message = null;
    if (!G.holeDone) {
      G.throwNo++;
      beginAim();
      return;
    }
    player().holes.push(player().points - G.holeStartPoints);
    if (G.turn < G.players.length - 1) {
      G.turn++;
      startTurn();
    } else {
      G.phase = 'holeBoard';
      el.hint.textContent = G.holeIndex + 1 >= HOLES
        ? 'Press for the final card.'
        : 'Press to walk to the next tee.';
    }
  }

  function advanceHole() {
    G.holeIndex++;
    if (G.holeIndex >= HOLES) {
      G.phase = 'gameOver';
      el.hint.textContent = 'Press to play a new round.';
    } else {
      startHole();
    }
  }

  // ----------------------------------------------------------------- floaters
  function addFloater(x, y, text, color) {
    G.floaters.push({ x, y, text, color, life: 60 });
  }

  // ---------------------------------------------------------------------- fx
  // Two trees in one throw. Named for the man himself.
  function startDoink(x, y) {
    G.fx.doink = { t: 0, life: 105, x, y };
    G.shake = 26;
    audio.doink();
  }

  // Ace celebration: a parade of steaks, because that is what was asked for.
  function startSteaks() {
    const rows = [];
    for (let i = 0; i < 7; i++) {
      rows.push({
        y: 70 + i * 88 + (Math.random() - 0.5) * 26,
        speed: 5.5 + Math.random() * 5,
        offset: Math.random() * W,
        dir: i % 2 ? 1 : -1,
        size: 42 + Math.random() * 26
      });
    }
    G.fx.steak = { t: 0, life: 240, rows };
    audio.fanfare();
  }

  function drawDoink() {
    const fx = G.fx.doink;
    const p = fx.t / fx.life;

    // Shockwave rings off the second trunk.
    for (let i = 0; i < 3; i++) {
      const rp = clamp(p * 2.4 - i * 0.16, 0, 1);
      if (rp <= 0 || rp >= 1) continue;
      ctx.strokeStyle = `rgba(255,215,94,${(1 - rp) * 0.7})`;
      ctx.lineWidth = 6 * (1 - rp);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, 18 + rp * 190, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Text pinballs in, overshoots, then wobbles to a stop.
    const pop = p < 0.22
      ? (p / 0.22) * 1.35
      : 1 + 0.35 * Math.cos((p - 0.22) * 26) * Math.exp(-(p - 0.22) * 7);
    const wob = Math.sin(p * 21) * Math.exp(-p * 3.4) * 0.16;
    const fade = p > 0.82 ? 1 - (p - 0.82) / 0.18 : 1;

    ctx.save();
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.translate(W / 2, H / 2 - 40);
    ctx.rotate(wob);
    ctx.scale(pop, pop);
    ctx.textAlign = 'center';

    ctx.font = '900 78px "Trebuchet MS", sans-serif';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText('DOUBLE DOINK!', 0, 0);
    const g = ctx.createLinearGradient(0, -50, 0, 30);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(0.5, '#ffd75e');
    g.addColorStop(1, '#ff9a3d');
    ctx.fillStyle = g;
    ctx.fillText('DOUBLE DOINK!', 0, 0);

    ctx.font = '800 26px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ff6b5e';
    ctx.fillText('TWO TREES. ONE THROW.', 0, 42);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  function drawGrumby() {
    const fx = G.fx.grumby;
    const p = fx.t / fx.life;
    const fade = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
    const slide = p < 0.2 ? (1 - p / 0.2) ** 2 : 0;

    ctx.save();
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.translate(W / 2 + slide * W, H / 2 - 30);
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(10,16,10,0.72)';
    ctx.fillRect(-W / 2, -70, W, 150);

    // Sweeping shine across the letters.
    ctx.font = '900 86px "Trebuchet MS", sans-serif';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText('ONLY GRUMBY', 0, 0);
    const shine = (p * 2 % 1) * 900 - 450;
    const g = ctx.createLinearGradient(shine - 200, 0, shine + 200, 0);
    g.addColorStop(0, '#c9a227');
    g.addColorStop(0.5, '#fff6cf');
    g.addColorStop(1, '#c9a227');
    ctx.fillStyle = g;
    ctx.fillText('ONLY GRUMBY', 0, 0);

    ctx.font = '700 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.fillText('THREE PERFECT THROWS — THIS ONE THROWS ITSELF', 0, 44);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  function drawSteaks() {
    const fx = G.fx.steak;
    const p = fx.t / fx.life;
    const fade = p > 0.8 ? 1 - (p - 0.8) / 0.2 : 1;

    ctx.save();
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.fillStyle = 'rgba(20,8,4,0.35)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const row of fx.rows) {
      const span = row.size * 2.6;
      const shift = (fx.t * row.speed + row.offset) * row.dir;
      for (let i = -1; i < W / span + 2; i++) {
        let x = i * span + (shift % span) - (row.dir < 0 ? span : 0);
        x = ((x % (W + span * 2)) + W + span * 2) % (W + span * 2) - span;
        ctx.font = `${row.size}px "Segoe UI Emoji", sans-serif`;
        ctx.fillText('🥩', x, row.y);
      }
    }
    ctx.textBaseline = 'alphabetic';

    const pop = clamp(p * 6, 0, 1);
    ctx.translate(W / 2, H / 2);
    ctx.scale(0.8 + pop * 0.2, 0.8 + pop * 0.2);
    ctx.rotate(Math.sin(fx.t * 0.08) * 0.03);
    ctx.font = '900 92px "Trebuchet MS", sans-serif';
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText('HOLE IN ONE!', 0, 0);
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('HOLE IN ONE!', 0, 0);
    ctx.font = '800 30px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ffb4a2';
    ctx.fillText('WELL DONE, THAT MAN', 0, 52);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  // ------------------------------------------------------------------ drawing
  function draw() {
    ctx.save();
    if (G.shake > 0) {
      ctx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake);
      G.shake *= 0.86;
      if (G.shake < 0.4) G.shake = 0;
    }

    drawGround();

    if (G.phase === 'title') { ctx.restore(); drawTitle(); return; }
    if (G.phase === 'gameOver') { ctx.restore(); drawFinal(); return; }

    const h = G.hole;
    h.bushes.forEach(drawBush);
    drawBasket(h.basket);
    G.lies.forEach(drawLie);
    h.trees.forEach(drawTree);

    if (G.phase === 'aim') drawAimArrow();
    if (G.flight && G.flight.guided) drawGuidedPath();
    if (G.flight) drawFlight();
    else drawDisc(G.disc.x, G.disc.y);

    drawFloaters();
    ctx.restore();

    if (G.phase === 'power' || G.phase === 'curve') drawMeters();
    if (G.phase === 'throwResult' && G.message) drawMessage();
    if (G.phase === 'holeBoard') drawHoleBoard();
    drawTag();

    // Celebrations sit on top of everything, including the result panel.
    if (G.fx.doink) drawDoink();
    if (G.fx.grumby) drawGrumby();
    if (G.fx.steak) drawSteaks();
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3f6b39');
    g.addColorStop(0.5, '#4a7a41');
    g.addColorStop(1, '#375f33');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Mowing stripes.
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let x = 0; x < W; x += 120) ctx.fillRect(x, 0, 60, H);

    // Rough at the edges = out of bounds.
    ctx.strokeStyle = 'rgba(20,40,18,0.55)';
    ctx.lineWidth = 24;
    ctx.strokeRect(12, 12, W - 24, H - 24);
    ctx.setLineDash([14, 12]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.setLineDash([]);
  }

  function drawBush(b) {
    ctx.fillStyle = 'rgba(30,60,28,0.5)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTree(t) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(t.x + 7, t.y + 9, t.r * 1.05, t.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1d3d1c';
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2c5a29';
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.18, t.y - t.r * 0.18, t.r * 0.72, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#3d7a37';
    ctx.beginPath();
    ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.32, t.r * 0.38, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#4a3524';
    ctx.beginPath();
    ctx.arc(t.x, t.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBasket(b) {
    // Range rings.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    [60, 110, 170].forEach(r => {
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(b.x + 6, b.y + 8, 26, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#8d8f93';
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, 24, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#54585c';
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, 17, 9.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Chains, seen from above.
    ctx.strokeStyle = 'rgba(225,232,235,0.85)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + G.t * 0.01;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + Math.cos(a) * 13, b.y + Math.sin(a) * 8);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLie(p) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawDisc(x, y) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x + 3, y + 4, DISC_R, DISC_R * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    ctx.ellipse(x, y, DISC_R, DISC_R * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffd0a8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, DISC_R * 0.55, DISC_R * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawFlight() {
    const f = G.flight;
    const gold = !!f.guided;
    ctx.lineWidth = gold ? 5 : 3;
    for (let i = 1; i < f.trail.length; i++) {
      const a = (i / f.trail.length) * (gold ? 0.85 : 0.35);
      ctx.strokeStyle = gold ? `rgba(255,215,94,${a})` : `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.moveTo(f.trail[i - 1].x, f.trail[i - 1].y);
      ctx.lineTo(f.trail[i].x, f.trail[i].y);
      ctx.stroke();
    }
    if (gold) {
      ctx.fillStyle = 'rgba(255,215,94,0.25)';
      ctx.beginPath();
      ctx.arc(f.x, f.y, 16 + Math.sin(G.t * 0.3) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    drawDisc(f.x, f.y);
  }

  function drawGuidedPath() {
    const path = G.flight.guided.path;
    ctx.strokeStyle = 'rgba(255,215,94,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawAimArrow() {
    const a = aimAngle();
    const len = 210;
    const x = G.disc.x, y = G.disc.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeStyle = 'rgba(255,215,94,0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 9]);
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath();
    ctx.moveTo(len + 16, 0);
    ctx.lineTo(len - 6, -10);
    ctx.lineTo(len - 6, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    for (const fl of G.floaters) {
      const a = clamp(fl.life / 40, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = '800 26px "Trebuchet MS", sans-serif';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(fl.text, fl.x, fl.y - (60 - fl.life) * 0.9);
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, fl.x, fl.y - (60 - fl.life) * 0.9);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }

  // Power / release meters, drawn along the bottom of the course.
  function drawMeters() {
    const bw = BAR_W, bh = 30, bx = (W - bw) / 2, by = H - 74;

    panel(bx - 16, by - 34, bw + 32, 96);

    ctx.font = '700 14px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.textAlign = 'left';

    if (G.phase === 'power') {
      ctx.fillText('POWER', bx, by - 12);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx, by, bw, bh);

      const p = powerValue();
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#5ad07a');
      grad.addColorStop(0.6, '#ffd75e');
      grad.addColorStop(1, '#ff6b5e');
      ctx.fillStyle = grad;
      ctx.fillRect(bx, by, bw * p, bh);

      const ideal = idealPower();
      if (ideal <= 1) {
        const mx = bx + bw * clamp(ideal, 0, 1);
        // Outer band = perfect-throw credit; inner box = lands on the pin.
        ctx.fillStyle = 'rgba(90,208,122,0.28)';
        ctx.fillRect(mx - effPowerWindow() * bw, by, effPowerWindow() * bw * 2, bh);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(mx - PIN_PX, by, PIN_PX * 2, bh);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(mx, by - 8);
        ctx.lineTo(mx, by + bh + 8);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#ff9a4d';
        ctx.textAlign = 'right';
        ctx.fillText('OUT OF RANGE — lay up', bx + bw, by - 12);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
    } else {
      ctx.fillText('RELEASE', bx, by - 12);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx, by, bw, bh);

      // Centre = clean release, and the width that earns perfect credit.
      const half = effCurveWindow() * (bw / 2);
      ctx.fillStyle = 'rgba(90,208,122,0.35)';
      ctx.fillRect(bx + bw / 2 - half, by, half * 2, bh);

      const c = curveValue();
      const cx = bx + bw / 2 + (bw / 2 - 6) * c;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 4, by - 6, 8, bh + 12);

      ctx.fillStyle = '#8fa389';
      ctx.textAlign = 'left';
      ctx.fillText('◀ HOOK LEFT', bx + 6, by + bh + 20);
      ctx.textAlign = 'right';
      ctx.fillText('HOOK RIGHT ▶', bx + bw - 6, by + bh + 20);

      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
    }
    ctx.textAlign = 'left';
  }

  function panel(x, y, w, h, alpha = 0.72) {
    ctx.fillStyle = `rgba(10,16,10,${alpha})`;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const r = 14;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawMessage() {
    const m = G.message;
    const w = 620, h = 104 + m.lines.length * 28;
    const x = (W - w) / 2, y = H / 2 - h / 2;
    panel(x, y, w, h, 0.85);

    ctx.textAlign = 'center';
    ctx.font = '800 34px "Trebuchet MS", sans-serif';
    ctx.fillStyle = m.tone === 'good' ? '#5ad07a' : m.tone === 'bad' ? '#ff6b5e' : '#ffd75e';
    ctx.fillText(m.title, W / 2, y + 46);

    ctx.font = '600 19px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#e8f0e4';
    m.lines.forEach((ln, i) => ctx.fillText(ln, W / 2, y + 84 + i * 28));

    ctx.font = '700 17px "Trebuchet MS", sans-serif';
    ctx.fillStyle = m.delta >= 0 ? '#5ad07a' : '#ff6b5e';
    ctx.fillText(`${m.delta >= 0 ? '+' : ''}${m.delta} this throw`, W / 2, y + h - 20);
    ctx.textAlign = 'left';
  }

  function drawHoleBoard() {
    const rows = G.players.length;
    const w = 640, h = 130 + rows * 40;
    const x = (W - w) / 2, y = H / 2 - h / 2;
    panel(x, y, w, h, 0.88);

    ctx.textAlign = 'center';
    ctx.font = '800 32px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(`HOLE ${G.holeIndex + 1} COMPLETE`, W / 2, y + 46);

    const sorted = G.players.slice().sort((a, b) => b.points - a.points);
    ctx.font = '700 20px "Trebuchet MS", sans-serif';
    sorted.forEach((p, i) => {
      const ry = y + 92 + i * 40;
      const last = p.holes[p.holes.length - 1] ?? 0;
      ctx.textAlign = 'left';
      ctx.fillStyle = i === 0 ? '#5ad07a' : '#e8f0e4';
      ctx.fillText(`${i + 1}. ${p.name}`, x + 40, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = last >= 0 ? '#8fa389' : '#ff6b5e';
      ctx.fillText(`${last >= 0 ? '+' : ''}${last}`, x + w - 130, ry);
      ctx.fillStyle = i === 0 ? '#5ad07a' : '#e8f0e4';
      ctx.fillText(`${p.points}`, x + w - 40, ry);
    });

    ctx.textAlign = 'center';
    ctx.font = '600 16px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.fillText(G.holeIndex + 1 >= HOLES ? 'Press for the final card' : 'Press to head to the next tee',
      W / 2, y + h - 20);
    ctx.textAlign = 'left';
  }

  function drawTitle() {
    ctx.fillStyle = 'rgba(8,14,8,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    ctx.font = '900 80px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('THWACK!', W / 2, 150);

    ctx.font = '700 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#e8f0e4';
    ctx.fillText('Timing-based disc golf. Five holes, three throws each.', W / 2, 190);

    ctx.font = '600 18px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#b9cbb2';
    [
      '1. AIM — stop the sweeping arrow on your line',
      '2. POWER — stop the bar on the white marker to reach the basket',
      '3. RELEASE — dead centre flies straight, off centre hooks and fades',
      '',
      'Discs ricochet off trunks — square on kills it, a glancing skip runs on.',
      'Nail both meters 3 throws running and ONLY GRUMBY throws the next one for you.'
    ].forEach((t, i) => ctx.fillText(t, W / 2, 232 + i * 26));

    const course = COURSES[G.courseIndex];
    ctx.font = '700 18px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.fillText('Course (press ◀ ▶ to change)', W / 2, 438);
    ctx.font = '900 32px "Trebuchet MS", sans-serif';
    ctx.fillStyle = course.tag === 'EASY' ? '#5ad07a' : course.tag === 'HARD' ? '#ff6b5e' : '#ffd75e';
    ctx.fillText(`${course.name} — ${course.tag}`, W / 2, 474);
    ctx.font = '600 16px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#b9cbb2';
    ctx.fillText(course.blurb, W / 2, 498);

    const n = G.pendingPlayers || 5;
    ctx.font = '700 20px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.fillText('Players (press 1–5 to change)', W / 2, 544);
    ctx.font = '900 38px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#5ad07a';
    ctx.fillText(`${n}`, W / 2, 586);

    ctx.font = '700 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = Math.floor(G.t / 30) % 2 ? '#ffffff' : '#ffd75e';
    ctx.fillText('PRESS SPACE / TAP TO TEE OFF', W / 2, 636);
    ctx.textAlign = 'left';
  }

  function drawFinal() {
    ctx.fillStyle = 'rgba(8,14,8,0.7)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    const sorted = G.players.slice().sort((a, b) => b.points - a.points);
    ctx.font = '900 64px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('FINAL CARD', W / 2, 130);

    ctx.font = '800 30px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#5ad07a';
    ctx.fillText(`${sorted[0].name} wins with ${sorted[0].points}`, W / 2, 182);

    ctx.font = '700 26px "Trebuchet MS", sans-serif';
    sorted.forEach((p, i) => {
      const y = 260 + i * 52;
      ctx.textAlign = 'left';
      ctx.fillStyle = i === 0 ? '#ffd75e' : '#e8f0e4';
      ctx.fillText(`${i + 1}. ${p.name}`, W / 2 - 260, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${p.points} pts`, W / 2 + 260, y);
    });

    ctx.textAlign = 'center';
    ctx.font = '700 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = Math.floor(G.t / 30) % 2 ? '#ffffff' : '#8fa389';
    ctx.fillText('PRESS TO PLAY AGAIN', W / 2, H - 90);
    ctx.textAlign = 'left';
  }

  function drawTag() {
    if (G.phase === 'title' || G.phase === 'gameOver' || !G.hole) return;
    ctx.font = '700 15px "Trebuchet MS", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`${G.course.name} · HOLE ${G.holeIndex + 1} · PAR ${G.hole.par} · ${feet(dist(G.hole.tee, G.hole.basket))} ft`, 26, 40);
  }

  // -------------------------------------------------------------------- loop
  function tick() {
    G.t++;

    for (const key of Object.keys(G.fx)) {
      const fx = G.fx[key];
      if (++fx.t >= fx.life) delete G.fx[key];
    }

    // The Grumby banner plays, then the shot launches itself.
    if (G.phase === 'grumbyIntro' && !G.fx.grumby) launchGrumby();

    if (G.phase === 'aim' || G.phase === 'power' || G.phase === 'curve') {
      G.meterT += 1 / 60;
    }
    if (G.phase === 'flight') {
      for (let i = 0; i < 2; i++) {          // 2 sim steps/frame keeps flights snappy
        if (G.phase !== 'flight') break;
        stepFlight();
      }
      if (G.hole) el.dist.textContent = G.flight
        ? `${feet(Math.hypot(G.hole.basket.x - G.flight.x, G.hole.basket.y - G.flight.y))} ft`
        : el.dist.textContent;
    }

    G.floaters = G.floaters.filter(f => --f.life > 0);

    draw();
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------- wiring
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      press();
    } else if (G.phase === 'title' && /^Digit[1-5]$/.test(e.code)) {
      G.pendingPlayers = Number(e.code.slice(5));
    } else if (G.phase === 'title' && e.code === 'ArrowLeft') {
      G.courseIndex = (G.courseIndex - 1 + COURSES.length) % COURSES.length;
    } else if (G.phase === 'title' && e.code === 'ArrowRight') {
      G.courseIndex = (G.courseIndex + 1) % COURSES.length;
    }
  });

  canvas.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
  el.action.addEventListener('click', press);

  el.mute.addEventListener('click', () => {
    audio.on = !audio.on;
    el.mute.textContent = audio.on ? '🔊' : '🔇';
    el.mute.setAttribute('aria-pressed', String(!audio.on));
  });

  G.pendingPlayers = 5;
  G.courseIndex = 1;
  tick();
})();
