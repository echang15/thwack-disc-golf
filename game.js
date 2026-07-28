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
  const NAME_POOL = ['The Lumberjack', 'Double Doink', 'Fucking Dave', 'Thwap! Fuck!'];

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const el = {
    player: document.getElementById('playerName'),
    hole: document.getElementById('holeInfo'),
    throw: document.getElementById('throwInfo'),
    dist: document.getElementById('distInfo'),
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
    boo() { this.blip(190, 0.4, 'sawtooth', 0.08); }
  };

  // ------------------------------------------------------------- hole builder
  function buildHole(index) {
    const rng = makeRng(0xC0FFEE + index * 7919);
    const tee = { x: 110, y: H / 2 + (rng() - 0.5) * 220 };
    const basket = {
      x: 1010 + rng() * 250,
      y: 120 + rng() * (H - 240)
    };

    const trees = [];
    const wanted = 11 + index * 3;
    let guard = 0;
    while (trees.length < wanted && guard++ < 4000) {
      const t = {
        x: 260 + rng() * (W - 380),
        y: 50 + rng() * (H - 100),
        r: 17 + rng() * 13
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
    shake: 0,
    t: 0
  };

  function newGame(playerCount) {
    const names = shuffle(NAME_POOL).slice(0, playerCount);
    G.players = names.map(n => ({ name: n, points: 0, holes: [] }));
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
    G.phase = 'aim';
    G.meterT = 0;
    G.aim = 0; G.power = 0; G.curve = 0;
    syncHud();
    el.hint.textContent = 'AIM — press when the arrow points where you want it.';
  }

  const player = () => G.players[G.turn];

  function syncHud() {
    if (!G.players.length) return;
    el.player.textContent = player().name;
    el.hole.textContent = `${G.holeIndex + 1} / ${HOLES}`;
    el.throw.textContent = `${Math.min(G.throwNo, THROWS_PER_HOLE)} of ${THROWS_PER_HOLE}`;
    el.dist.textContent = G.hole ? `${feet(dist(G.disc, G.hole.basket))} ft` : '—';
    el.points.textContent = player().points;
  }

  // ------------------------------------------------------------------- meters
  // Aim sweeps ±42° around the straight line to the basket.
  const AIM_SPAN = 32 * Math.PI / 180;
  function meterSpeed() { return 1 + G.holeIndex * 0.08; }

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
        newGame(G.pendingPlayers || 4);
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
      ob: false,
      holed: false,
      frames: 0
    };
    G.phase = 'flight';
    el.hint.textContent = '…';
  }

  function stepFlight() {
    const f = G.flight;
    const h = G.hole;

    // Fade: the slower the disc, the harder the release error bites.
    const fade = 0.4 + 1.3 * (1 - f.v / f.v0);
    f.heading += G.curve * 0.0105 * fade;

    f.x += Math.cos(f.heading) * f.v;
    f.y += Math.sin(f.heading) * f.v;
    f.v *= DRAG;
    f.frames++;

    f.trail.push({ x: f.x, y: f.y });
    if (f.trail.length > 46) f.trail.shift();

    // Trees.
    for (const t of h.trees) {
      if (Math.hypot(t.x - f.x, t.y - f.y) < t.r + DISC_R) {
        f.treeHits++;
        audio.thwack();
        G.shake = 14;
        addFloater(f.x, f.y, f.treeHits > 1 ? 'THWACK!' : 'THWAP! FUCK!', '#ff6b5e');
        // Kick back out of the trunk and kill most of the speed.
        const away = Math.atan2(f.y - t.y, f.x - t.x);
        f.x = t.x + Math.cos(away) * (t.r + DISC_R + 1);
        f.y = t.y + Math.sin(away) * (t.r + DISC_R + 1);
        f.heading = away + (Math.random() - 0.5) * 1.1;
        f.v *= 0.18;
        break;
      }
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

  function endFlight() {
    const f = G.flight;
    const h = G.hole;
    G.lies.push({ x: G.disc.x, y: G.disc.y });
    G.disc = { x: f.x, y: f.y };

    let delta = 0;
    const lines = [];

    if (f.treeHits) {
      delta -= 4 * f.treeHits;
      lines.push(`${f.treeHits} tree${f.treeHits > 1 ? 's' : ''} — ${4 * f.treeHits} pts`);
    }
    if (f.ob) {
      delta -= 8;
      lines.push('Out of bounds — 8 pts');
    }

    let title, tone = 'plain', done = false;

    if (f.holed) {
      const bonus = [0, 120, 70, 40][G.throwNo] || 40;
      delta += bonus;
      title = G.throwNo === 1 ? 'ACE! CHAINS!' : 'IN THE BASKET!';
      lines.push(`Holed in ${G.throwNo} — +${bonus} pts`);
      tone = 'good';
      done = true;
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
      title = f.ob ? 'OB — take the lie' : f.treeHits ? 'Blocked by timber' : 'Nice look';
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
    if (G.flight) drawFlight();
    else drawDisc(G.disc.x, G.disc.y);

    drawFloaters();
    ctx.restore();

    if (G.phase === 'power' || G.phase === 'curve') drawMeters();
    if (G.phase === 'throwResult' && G.message) drawMessage();
    if (G.phase === 'holeBoard') drawHoleBoard();
    drawTag();
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
    ctx.lineWidth = 3;
    for (let i = 1; i < f.trail.length; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${(i / f.trail.length) * 0.35})`;
      ctx.beginPath();
      ctx.moveTo(f.trail[i - 1].x, f.trail[i - 1].y);
      ctx.lineTo(f.trail[i].x, f.trail[i].y);
      ctx.stroke();
    }
    drawDisc(f.x, f.y);
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
    const bw = 620, bh = 30, bx = (W - bw) / 2, by = H - 74;

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
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(mx - 14, by, 28, bh);          // "on the pin" window
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

      // Centre = clean release.
      ctx.fillStyle = 'rgba(90,208,122,0.35)';
      ctx.fillRect(bx + bw / 2 - 26, by, 52, bh);

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

    ctx.font = '900 92px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('THWACK!', W / 2, 190);

    ctx.font = '700 26px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#e8f0e4';
    ctx.fillText('Timing-based disc golf. Five holes, three throws each.', W / 2, 238);

    ctx.font = '600 20px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#b9cbb2';
    [
      '1. AIM — stop the sweeping arrow on your line',
      '2. POWER — stop the bar on the white marker to reach the basket',
      '3. RELEASE — dead centre flies straight, off centre hooks and fades',
      '',
      'Closer to the basket = more points. Trees cost you 4. Out of bounds costs 8.'
    ].forEach((t, i) => ctx.fillText(t, W / 2, 300 + i * 34));

    const n = G.pendingPlayers || 4;
    ctx.font = '700 22px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#8fa389';
    ctx.fillText('Players (press 1–4 to change)', W / 2, 520);
    ctx.font = '900 46px "Trebuchet MS", sans-serif';
    ctx.fillStyle = '#5ad07a';
    ctx.fillText(`${n}`, W / 2, 570);

    ctx.font = '700 24px "Trebuchet MS", sans-serif';
    ctx.fillStyle = Math.floor(G.t / 30) % 2 ? '#ffffff' : '#ffd75e';
    ctx.fillText('PRESS SPACE / TAP TO TEE OFF', W / 2, 630);
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
    ctx.fillText(`HOLE ${G.holeIndex + 1} · PAR ${G.hole.par} · ${feet(dist(G.hole.tee, G.hole.basket))} ft`, 26, 40);
  }

  // -------------------------------------------------------------------- loop
  function tick() {
    G.t++;

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
    } else if (G.phase === 'title' && /^Digit[1-4]$/.test(e.code)) {
      G.pendingPlayers = Number(e.code.slice(5));
    }
  });

  canvas.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
  el.action.addEventListener('click', press);

  el.mute.addEventListener('click', () => {
    audio.on = !audio.on;
    el.mute.textContent = audio.on ? '🔊' : '🔇';
    el.mute.setAttribute('aria-pressed', String(!audio.on));
  });

  G.pendingPlayers = 4;
  tick();
})();
