/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Chinese labels, cardinal points and the ink-wash horizon, drawn on a 2D canvas over
 * the Stellarium canvas. Stellarium supplies every sky position; this file projects them
 * the way the engine does (stereographic, fov across the shorter side) and lays out text.
 * The engine's own font has no CJK glyphs, which is why the labels live here.
 */
(function () {
  'use strict';
  var D = Math.PI / 180;
  var PLANETS = {
    'NAME Sun': ['太阳', '太阳'], 'NAME Moon': ['月亮', '月亮'], 'NAME Mercury': ['水星', '辰星'],
    'NAME Venus': ['金星', '太白'], 'NAME Mars': ['火星', '荧惑'], 'NAME Jupiter': ['木星', '岁星'],
    'NAME Saturn': ['土星', '填星'], 'NAME Uranus': ['天王星', '天王星'], 'NAME Neptune': ['海王星', '海王星']
  };
  var CARDINALS = [['北', 0, 1], ['东北', 45, 0], ['东', 90, 1], ['东南', 135, 0],
    ['南', 180, 1], ['西南', 225, 0], ['西', 270, 1], ['西北', 315, 0]];
  // size in --u (1% of the shorter side), rgb, opacity
  var STYLE = {
    region: [3.3, '238,214,152', 1, '0.3em'], focus: [3.2, '255,228,166', 1, '0.16em'],
    mansion: [2.85, '240,228,198', 0.97, '0.12em'], major: [2.55, '224,214,188', 0.92, '0.08em'],
    minor: [2.4, '206,199,180', 0.8, '0.06em'], star: [2.25, '188,203,226', 0.9, '0.04em'],
    planet: [2.7, '247,229,186', 1, '0.1em']
  };

  function dir(az, alt) {
    var c = Math.cos(alt);
    return [c * Math.cos(az), c * Math.sin(az), Math.sin(alt)];
  }
  function norm(v) {
    var l = Math.hypot(v[0], v[1], v[2]);
    return l && isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
  }
  // Saemundsson's formula, the same order of correction the engine applies near the horizon.
  function refract(v) {
    var h = Math.asin(Math.max(-1, Math.min(1, v[2]))) / D;
    if (h < -2) return v;
    var r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D) / 60;
    return dir(Math.atan2(v[1], v[0]), (h + r) * D);
  }

  function Projector(core, w, h) {
    var y = core.yaw, p = core.pitch;
    this.sy = Math.sin(y); this.cy = Math.cos(y); this.sp = Math.sin(p); this.cp = Math.cos(p);
    this.w = w; this.h = h; this.cx = w / 2; this.cyy = h / 2;
    this.fov = core.fov;
    this.scale = Math.min(w, h) / (2 * Math.tan(core.fov / 4));
    this.limit = 30 * Math.max(w, h);
  }
  Projector.prototype.project = function (v) {
    var x = -v[0] * this.sy + v[1] * this.cy;
    var up = -v[0] * this.sp * this.cy - v[1] * this.sp * this.sy + v[2] * this.cp;
    var fwd = v[0] * this.cp * this.cy + v[1] * this.cp * this.sy + v[2] * this.sp;
    var den = 1 + fwd;
    if (den < 1e-9) return null;
    var px = x * this.scale / den, py = -up * this.scale / den;
    var r = Math.hypot(px, py);
    if (r > this.limit) { px *= this.limit / r; py *= this.limit / r; }
    return { x: this.cx + px, y: this.cyy + py, far: r > 3 * Math.max(this.w, this.h) };
  };

  // ---------------------------------------------------------------- ink horizon
  function rng(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }
  // Periodic value noise around the horizon; "ridged" folds each octave so crests come to a point.
  function ridge(seed, bumps, octaves, base, amp, sharp, ridged) {
    var r = rng(seed), layers = [];
    for (var k = 0; k < octaves; k++) {
      var n = bumps << k, knots = [];
      for (var i = 0; i < n; i++) knots.push(r());
      layers.push(knots);
    }
    return function (az) {
      var t = ((az % 360) + 360) % 360 / 360, sum = 0, weight = 0;
      layers.forEach(function (knots, k) {
        var f = t * knots.length, i = Math.floor(f), u = f - i;
        var a = knots[i % knots.length], b = knots[(i + 1) % knots.length];
        var s = (1 - Math.cos(u * Math.PI)) / 2;
        var wk = Math.pow(0.5, k), n = a + (b - a) * s;
        sum += (ridged ? 1 - Math.abs(2 * n - 1) : n) * wk; weight += wk;
      });
      return base + amp * Math.pow(sum / weight, sharp);
    };
  }
  var FAR = ridge(20261124, 7, 4, 0.7, 8.5, 2.4, true);
  var MID = ridge(5150, 12, 4, 0.45, 4.6, 2.1, true);
  var NEAR = ridge(77, 20, 3, 0.3, 1.6, 1.3, false);
  // 登封观星台：台身、台顶两小室与北面石圭（量天尺），落在近处山脊上，方位 203°。
  var TOWER = { az: 203, w: 1.3 };
  function tower(az) {
    var d = ((az - TOWER.az + 540) % 360) - 180;
    if (d < -TOWER.w || d > 7) return 0;
    if (d > TOWER.w) return 0.55;                                   // 石圭
    var body = 2.75 - (Math.abs(d) / TOWER.w) * 0.55;               // 收分的台身
    var room = Math.abs(d) > 0.28 && Math.abs(d) < 0.9 ? 0.42 : 0;  // 两侧小室，中间是凹槽
    return Math.abs(d) < 0.98 ? body + room : body;
  }
  var TOWER_BASE = NEAR(TOWER.az);
  function nearGround(az) {
    var t = tower(az);
    return t ? Math.max(NEAR(az), TOWER_BASE + t) : NEAR(az);
  }
  function groundAt(az) {
    return Math.max(FAR(az), MID(az), nearGround(az));
  }
  // far peaks fade into a pale mist at their feet, the way ink landscapes leave the valley blank
  var LAYERS = [
    { f: FAR, top: '#161c27', base: '#2b3444', span: 8 },
    { f: MID, top: '#0f141c', base: '#1a212c', span: 4 },
    { f: nearGround, top: '#07090d', base: '#0b0e14', span: 2, below: '#040507' }
  ];

  function inside(pts, x, y) {
    var hit = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  }
  // The region below a horizon profile, filled in the projected plane. The profile is cut
  // at the azimuth opposite the view so a horizon that runs through infinity (camera at the
  // horizon) closes around the side holding the nadir.
  function groundPath(P, profile) {
    var start = Math.atan2(P.sy, P.cy) / D + 180, pts = [];
    for (var a = 0.6; a <= 359.4;) {
      var az = start + a, q = P.project(dir(az * D, profile(az) * D));
      if (q) pts.push(q);
      var d = ((az - TOWER.az + 540) % 360) - 180;
      a += d > -2 && d < 8 ? 0.04 : 0.4;   // fine steps across the observatory's straight edges
    }
    if (pts.length < 3) return null;
    var nadir = P.project([0, 0, -1]);
    var A = pts[0], B = pts[pts.length - 1];
    if (A.far && B.far) {
      var R = P.limit, ta = Math.atan2(A.y - P.cyy, A.x - P.cx), tb = Math.atan2(B.y - P.cyy, B.x - P.cx);
      for (var sense = 1; sense >= -1; sense -= 2) {
        var span = ((sense * (ta - tb)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        var loop = pts.slice();
        for (var s = 0; s <= 24; s++) {
          var t = tb + sense * span * s / 24;
          loop.push({ x: P.cx + R * Math.cos(t), y: P.cyy + R * Math.sin(t) });
        }
        if (nadir && inside(loop, nadir.x, nadir.y)) return { pts: loop, invert: false };
      }
      return { pts: pts, invert: false };
    }
    return { pts: pts, invert: !(nadir && inside(pts, nadir.x, nadir.y)) };
  }
  function fillGround(ctx, P, layer) {
    var g = groundPath(P, layer.f);
    if (!g) return;
    ctx.beginPath();
    if (g.invert) {
      // the outer edge must enclose the whole loop, or the part of the loop beyond it gets filled
      var x0 = -10, y0 = -10, x1 = P.w + 10, y1 = P.h + 10;
      g.pts.forEach(function (q) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); });
      ctx.rect(x0 - 50, y0 - 50, x1 - x0 + 100, y1 - y0 + 100);
    }
    g.pts.forEach(function (q, i) { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    var az = Math.atan2(P.sy, P.cy);
    var top = P.project(dir(az, layer.span * D)), foot = P.project(dir(az, 0));
    var fill = layer.top;
    if (top && foot && Math.abs(foot.y - top.y) > 2) {
      fill = ctx.createLinearGradient(0, top.y, 0, foot.y + (layer.below ? (foot.y - top.y) * 6 : 0));
      fill.addColorStop(0, layer.top);
      fill.addColorStop(layer.below ? 0.14 : 1, layer.base);
      if (layer.below) fill.addColorStop(1, layer.below);
    }
    ctx.fillStyle = fill;
    ctx.fill(g.invert ? 'evenodd' : 'nonzero');
  }

  // ---------------------------------------------------------------- renderer
  window.GXLabels = function (engine, catalog) {
    var self = this;
    var names = {};
    catalog.asterisms.forEach(function (a) { names[a.suffix] = a; });
    var asterisms = [], culture = '', pendingCulture = [], planets = [], stars = [], regions = [];
    var lastStars = 0, lastPlanets = 0, fade = new Map(), lastAt = new Map(), widths = new Map(), clock = performance.now();
    var matrix = null;

    function release(list) { list.forEach(function (row) { if (row.obj) row.obj.destroy(); row.obj = null; }); }
    function icrfOf(obj) {
      var p = obj.getPosIcrf(engine.observer);
      return p ? norm(p) : null;
    }

    function syncCulture(group) {
      var id = 'gx_' + group;
      if (culture === id && !pendingCulture.length) return;
      if (culture !== id) {
        var prefix = 'CON ' + id + ' ';
        var seen = new Set();
        var found = engine.constellations.listChildren(99, function (o) {
          var key = o.jsonData.names.find(function (n) { return n.indexOf(prefix) === 0; });
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!found.length) return;
        release(asterisms); release(pendingCulture);
        asterisms = [];
        pendingCulture = found.map(function (o) {
          var key = o.jsonData.names.find(function (n) { return n.indexOf(prefix) === 0; });
          var suffix = key.slice(prefix.length), meta = names[suffix];
          return { obj: o, suffix: suffix, name: meta ? meta.label : '', rank: meta ? meta.rank : 4, stars: meta ? meta.stars : 1 };
        }).filter(function (row) { if (!row.name) row.obj.destroy(); return !!row.name; });
        culture = id;
      }
      pendingCulture = pendingCulture.filter(function (row) {
        var v = icrfOf(row.obj);
        if (!v) return true;
        row.icrf = v;
        row.radius = row.obj.getAngularRadius(engine.observer) || 0;
        row.obj.destroy(); row.obj = null;
        asterisms.push(row);
        return false;
      });
    }

    function syncRegions() {
      if (regions.length === catalog.regions.length) return;
      regions = catalog.regions.map(function (r) {
        var o = engine.resolveObjByUri('stars::HIP ' + r.hip);
        if (!o) return null;
        var v = icrfOf(o); o.destroy();
        return v ? { key: r.key, name: r.name, icrf: v } : null;
      }).filter(Boolean);
      if (regions.length !== catalog.regions.length) regions = [];
    }

    function syncPlanets(now) {
      if (planets.length && now - lastPlanets < 1000) return;
      lastPlanets = now;
      if (!planets.length) {
        var seen = new Set();
        planets = engine.planets.listChildren(99, function (o) {
          var id = o.jsonData.names[0];
          if (!PLANETS[id] || seen.has(id)) return false;
          seen.add(id);
          return true;
        }).map(function (o) { return { obj: o, id: o.jsonData.names[0] }; });
      }
      planets.forEach(function (row) { row.vmag = row.obj.getVMag(engine.observer); });
    }

    function syncStars(on, fov, now) {
      if (!on) { stars = []; return; }
      if (now - lastStars < 1500) return;
      lastStars = now;
      var limit = fov > 100 * D ? 1.6 : fov > 50 * D ? 2.6 : fov > 20 * D ? 3.6 : 4.8;
      var seen = new Set(), next = [];
      engine.stars.listChildren(limit, function (o) {
        var hip = o.jsonData.names.find(function (n) { return n.indexOf('HIP ') === 0 && catalog.stars[n]; });
        if (hip && !seen.has(hip)) {
          seen.add(hip);
          var v = icrfOf(o);
          if (v) next.push({ hip: hip, icrf: v, names: catalog.stars[hip], vmag: o.getVMag(engine.observer) });
        }
        return false;
      });
      stars = next;
    }

    function observed(icrf, M) {
      var v = [
        M[0][0] * icrf[0] + M[1][0] * icrf[1] + M[2][0] * icrf[2],
        M[0][1] * icrf[0] + M[1][1] * icrf[1] + M[2][1] * icrf[2],
        M[0][2] * icrf[0] + M[1][2] * icrf[1] + M[2][2] * icrf[2]
      ];
      return refract(v);
    }

    function measure(ctx, text, font, spacing) {
      var key = font + spacing + text;
      if (!widths.has(key)) {
        ctx.font = font;
        if ('letterSpacing' in ctx) ctx.letterSpacing = spacing;
        widths.set(key, ctx.measureText(text).width);
      }
      return widths.get(key);
    }

    function step(key, target, dt) {
      var a = fade.get(key) || 0;
      a += (target - a) * (1 - Math.exp(-dt * 7));
      if (target === 0 && a < 0.01) fade.delete(key); else fade.set(key, a);
      return a;
    }

    this.ready = function () { return asterisms.length > 0 && !pendingCulture.length; };
    this.groundAt = groundAt;

    this.draw = function (ctx, w, h, opt) {
      var now = performance.now(), dt = Math.min(0.1, (now - clock) / 1000);
      clock = now;
      var s = opt.state, view = s.view, core = engine.core;
      ctx.clearRect(0, 0, w, h);
      self.debug = [];
      syncCulture(s.group);
      syncRegions();
      syncPlanets(now);
      syncStars(view.stars && view.labels !== false, core.fov, now);
      var o = engine.observer;
      matrix = [engine.convertFrame(o, 'ICRF', 'OBSERVED_GEOM', [1, 0, 0]),
        engine.convertFrame(o, 'ICRF', 'OBSERVED_GEOM', [0, 1, 0]),
        engine.convertFrame(o, 'ICRF', 'OBSERVED_GEOM', [0, 0, 1])];
      var P = new Projector(core, w, h), u = Math.min(w, h) / 100;

      // ground and horizon
      if (view.ground === 'ink') LAYERS.forEach(function (layer) { fillGround(ctx, P, layer); });
      if (view.ground === 'none') {
        ctx.save(); ctx.beginPath();
        var first = true;
        for (var a = 0; a <= 360; a += 1) {
          var q = P.project(dir(a * D, 0));
          if (!q || q.far) { first = true; continue; }
          if (first) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
          first = false;
        }
        ctx.strokeStyle = 'rgba(214,170,110,0.45)'; ctx.lineWidth = Math.max(1, u * 0.12);
        ctx.setLineDash([u * 0.8, u * 0.6]); ctx.stroke(); ctx.restore();
      }
      function hidden(v) {
        if (view.ground === 'none') return false;
        var alt = Math.asin(v[2]) / D;
        if (view.ground === 'field') return alt < 0.3;
        return alt < groundAt(Math.atan2(v[1], v[0]) / D) + 0.2;
      }

      // candidates
      var fov = core.fov / D, rows = [];
      var focus = opt.focus;
      if (view.labels) {
        var narrowGroup = s.group !== 'all';
        asterisms.forEach(function (row) {
          var isFocus = focus === row.suffix;
          if (!narrowGroup && !isFocus) {
            if (row.rank === 2 && fov > 150) return;
            if (row.rank === 3 && fov > 85) return;
            if (row.rank === 4 && fov > 45) return;
          }
          var style = isFocus ? 'focus' : row.rank === 1 ? 'mansion' : row.rank === 2 ? 'major' : 'minor';
          rows.push({ key: 'a' + row.suffix, text: row.name, v: observed(row.icrf, matrix), style: style,
            order: isFocus ? -1 : row.rank, weight: row.stars, mode: row.stars <= 2 ? 'below' : 'center',
            radius: 2 * Math.tan(row.radius / 2) * P.scale });
        });
        if (s.group === 'all' || ['ziwei', 'taiwei', 'tianshi'].indexOf(s.group) >= 0) {
          regions.forEach(function (r) {
            if (s.group !== 'all' && s.group !== r.key) return;
            rows.push({ key: 'r' + r.key, text: r.name, v: observed(r.icrf, matrix), style: 'region', order: 0, weight: 99, mode: 'above' });
          });
        }
        var shown = new Set(asterisms.map(function (a) { return a.name; }));
        stars.forEach(function (st) {
          if (shown.has(st.names[0])) return;   // a one-star asterism already carries this name
          var order = st.vmag < 1 ? 1.5 : st.vmag < 2 ? 2.5 : 5;
          rows.push({ key: 's' + st.hip, text: st.names[0], v: observed(st.icrf, matrix), style: 'star', order: order,
            weight: -st.vmag, mode: 'right' });
        });
      }
      planets.forEach(function (row) {
        if (row.id !== 'NAME Sun' && row.id !== 'NAME Moon' && !(row.vmag < 6)) return;
        if ((row.id === 'NAME Uranus' || row.id === 'NAME Neptune') && fov > 30) return;
        var p = row.obj.getPosIcrf(o), v = p && norm(p);
        if (!v) return;
        var r = 2 * Math.tan((row.obj.getAngularRadius(o) || 0) / 2) * P.scale;
        // the drawn disk plus its glow: the Sun's glare is far wider than the disk
        r = Math.max(r, u * (row.id === 'NAME Sun' ? 3.4 : row.id === 'NAME Moon' ? 1.2 : 0.8));
        var label = PLANETS[row.id][view.planets === 'classic' ? 1 : 0];
        rows.push({ key: 'p' + row.id, text: label, v: observed(v, matrix), style: 'planet', order: 0.5, weight: 50,
          mode: 'planet', radius: r });
      });

      rows.forEach(function (row) { row.was = (fade.get(row.key) || 0) > 0.5; });
      rows.sort(function (a, b) {
        return (a.order - (a.was ? 0.6 : 0)) - (b.order - (b.was ? 0.6 : 0)) || b.weight - a.weight;
      });
      var boxes = (opt.reserved || []).slice(), drawn = 0, live = new Set();
      // keep text off the Moon and planet disks
      rows.forEach(function (row) {
        if (row.style !== 'planet') return;
        var q = P.project(row.v);
        if (q) boxes.push({ x: q.x - row.radius, y: q.y - row.radius, w: row.radius * 2, h: row.radius * 2 });
      });
      var budget = fov > 110 ? 24 : fov > 70 ? 30 : fov > 35 ? 40 : 56;
      function free(b) {
        if (b.x < u || b.y < u || b.x + b.w > w - u || b.y + b.h > h - u) return false;
        for (var i = 0; i < boxes.length; i++) {
          var c = boxes[i];
          if (b.x < c.x + c.w && b.x + b.w > c.x && b.y < c.y + c.h && b.y + b.h > c.y) return false;
        }
        return true;
      }
      rows.forEach(function (row) {
        var q = row.v && !hidden(row.v) ? P.project(row.v) : null;
        if (!q || q.x < -w * 0.2 || q.x > w * 1.2 || q.y < -h * 0.2 || q.y > h * 1.2) return;
        var st = STYLE[row.style], size = st[0] * u * (w > h ? 0.88 : 1);
        var font = '600 ' + size.toFixed(1) + 'px "GX Sky Serif","Noto Serif SC",serif';
        var tw = measure(ctx, row.text, font, st[3]), th = size * 1.25, pad = size * 0.25;
        var gap = row.mode === 'planet' ? Math.max(row.radius, u * 0.5) + u * 0.9 : u * 1.0;
        // a compact asterism keeps its stars visible: the name goes under it
        var mode = row.mode === 'center' && row.radius < u * 9 ? 'under' : row.mode;
        var drop = Math.max(row.radius || 0, u) + th * 0.6;
        var side = tw / 2 + gap + (row.radius || 0);
        var ring = function (d, x) { return [[0, d], [0, -d], [x, 0], [-x, 0]]; };
        var spots = {
          center: [[0, 0], [0, th * 0.95], [0, -th * 0.95]].concat(ring(drop, side), ring(drop + th, side + tw / 2)),
          under: ring(drop, side).concat(ring(drop + th, side + tw / 2)),
          below: [[0, th * 0.85], [0, -th * 0.85]].concat(ring(th * 1.8, tw / 2 + gap)),
          above: [[0, -th * 1.05], [0, th * 1.05], [0, -th * 2], [0, th * 2]],
          right: [[tw / 2 + gap, 0], [-tw / 2 - gap, 0], [0, -th * 0.8], [0, th * 0.8]],
          planet: [[tw / 2 + gap, 0], [-tw / 2 - gap, 0], [0, -(row.radius + th * 0.75)], [0, row.radius + th * 0.75],
            [0, -(row.radius + th * 1.7)], [0, row.radius + th * 1.7]]
        }[mode];
        var placed = null;
        if (drawn < budget) {
          for (var i = 0; i < spots.length && !placed; i++) {
            var box = { x: q.x + spots[i][0] - tw / 2 - pad, y: q.y + spots[i][1] - th / 2, w: tw + pad * 2, h: th };
            if (free(box)) placed = { x: q.x + spots[i][0], y: q.y + spots[i][1], box: box };
          }
        }
        if (placed) {
          boxes.push({ x: placed.box.x - u * 0.5, y: placed.box.y - u * 0.3, w: placed.box.w + u, h: placed.box.h + u * 0.6 });
          drawn++;
          lastAt.set(row.key, { dx: placed.x - q.x, dy: placed.y - q.y });
        }
        live.add(row.key);
        var alpha = step(row.key, placed ? 1 : 0, dt);
        var off = lastAt.get(row.key);
        var at = placed || (off && { x: q.x + off.dx, y: q.y + off.dy });
        if (!at || alpha < 0.02) return;
        ctx.save();
        ctx.font = font;
        if ('letterSpacing' in ctx) ctx.letterSpacing = st[3];
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = alpha * st[2];
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = size * 0.45;
        ctx.fillStyle = 'rgb(' + st[1] + ')';
        ctx.fillText(row.text, at.x, at.y);
        self.debug.push([row.key, row.text, Math.round(at.x), Math.round(at.y), +alpha.toFixed(2), !!placed]);
        ctx.shadowBlur = size * 0.15;
        ctx.fillText(row.text, at.x, at.y);
        ctx.restore();
      });
      fade.forEach(function (_, key) { if (!live.has(key)) step(key, 0, dt); });
      lastAt.forEach(function (_, key) { if (!fade.has(key)) lastAt.delete(key); });

      // cardinal points sit just under the horizon line
      var calt = view.ground === 'ink' ? -1.6 : view.ground === 'field' ? -0.8 : 0.9;
      CARDINALS.forEach(function (c) {
        var q = P.project(dir(c[1] * D, calt * D));
        if (!q || q.x < u * 2 || q.x > w - u * 2 || q.y < u * 2 || q.y > h - u * 2) return;
        var size = (c[2] ? 3.0 : 2.1) * u;
        ctx.save();
        ctx.font = '600 ' + size.toFixed(1) + 'px "GX Sky Serif","Noto Serif SC",serif';
        ctx.textAlign = 'center'; ctx.textBaseline = view.ground === 'none' ? 'bottom' : 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = size * 0.4;
        ctx.fillStyle = c[2] ? 'rgba(226,122,98,0.95)' : 'rgba(196,170,132,0.75)';
        ctx.fillText(c[0], q.x, q.y);
        ctx.restore();
      });
    };

    this.altitudeOf = function (icrfVector) {
      if (!matrix) return null;
      var v = observed(norm(icrfVector), matrix);
      return Math.asin(v[2]) / D;
    };

    this.dispose = function () { release(pendingCulture); release(planets); };
    window.addEventListener('pagehide', function () { self.dispose(); });
  };
}());
