/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Chinese labels use positions computed by Stellarium, with its stereographic
 * projection. The system font supplies CJK glyphs independently of its font atlas.
 */
(function () {
  'use strict';
  var PLANETS = {
    'NAME Sun': '太阳', 'NAME Moon': '月亮', 'NAME Mercury': '水星',
    'NAME Venus': '金星', 'NAME Mars': '火星', 'NAME Jupiter': '木星',
    'NAME Saturn': '土星', 'NAME Uranus': '天王星', 'NAME Neptune': '海王星'
  };
  var CARDINALS = [
    { name: '北', pos: [1, 0, 0] }, { name: '东', pos: [0, 1, 0] },
    { name: '南', pos: [-1, 0, 0] }, { name: '西', pos: [0, -1, 0] }
  ];

  function release(rows) {
    rows.forEach(function (row) { row.object.destroy(); });
  }

  function normalize(vector) {
    var length = Math.hypot(vector[0], vector[1], vector[2]);
    if (!length || !Number.isFinite(length)) return null;
    return vector.map(function (value) { return value / length; });
  }

  function projectObserved(pos, core, width, height) {
    var p = normalize(pos);
    if (!p) return null;
    var y = core.yaw, a = core.pitch, sy = Math.sin(y), cy = Math.cos(y);
    var sa = Math.sin(a), ca = Math.cos(a);
    var x = -p[0] * sy + p[1] * cy;
    var up = -p[0] * sa * cy - p[1] * sa * sy + p[2] * ca;
    var forward = p[0] * ca * cy + p[1] * ca * sy + p[2] * sa;
    var denominator = 1 + forward;
    if (denominator <= 0.000001) return null;
    var scale = Math.min(width, height) / (2 * Math.tan(core.fov / 4));
    return { x: width / 2 + x * scale / denominator, y: height / 2 - up * scale / denominator, altitude: Math.asin(p[2]) };
  }

  window.GXLabels = function (engine, getState) {
    var canvas = document.createElement('canvas');
    canvas.id = 'gx-chinese-labels';
    canvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:30;visibility:visible;';
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var asterisms = [], planets = [], stars = [], starNames = {};
    var group = null, lastRefresh = 0, ready = false;
    var debug = { drawn: [], engineCulture: '', objectCount: 0 };

    fetch('/api/label-data').then(function (response) { return response.json(); }).then(function (data) {
      starNames = data.stars;
    });

    function refresh(state) {
      var wanted = 'gx_' + state.group;
      if (group !== wanted) {
        var prefix = 'CON ' + wanted + ' ';
        var seen = new Set();
        var children = engine.constellations.listChildren(99, function (object) {
          var id = object.jsonData.names.find(function (name) { return name.indexOf(prefix) === 0; });
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (children.length) {
          release(asterisms);
          asterisms = children.map(function (object) {
            var data = object.jsonData;
            var name = data.names.find(function (value) { return value.indexOf('NAME ') === 0; }).slice(5);
            return { object: object, name: name, priority: /垣$/.test(name) && !/左垣|右垣/.test(name) ? 0 : /宿$/.test(name) ? 1 : 2 };
          });
          group = wanted;
        }
      }
      if (!planets.length) {
        var planetSeen = new Set();
        planets = engine.planets.listChildren(99, function (object) {
          var id = object.jsonData.names[0];
          if (!PLANETS[id] || planetSeen.has(id)) return false;
          planetSeen.add(id);
          return true;
        }).map(function (object) {
          return { object: object, name: PLANETS[object.jsonData.names[0]], priority: 0 };
        });
      }
      if (state.star_labels && Object.keys(starNames).length) {
        var starSeen = new Set();
        release(stars);
        stars = engine.stars.listChildren(engine.core.fov < 0.35 ? 6 : 4.2, function (object) {
          var hip = object.jsonData.names.find(function (name) { return !!starNames[name]; });
          if (!hip || starSeen.has(hip)) return false;
          starSeen.add(hip);
          return true;
        }).map(function (object) {
          var hip = object.jsonData.names.find(function (name) { return !!starNames[name]; });
          return { object: object, name: starNames[hip], priority: 4 };
        });
      }
      if (!state.star_labels && stars.length) { release(stars); stars = []; }
    }

    function pointForObject(row, state, width, height) {
      var core = engine.core;
      var interval = core.fov < 0.035 ? 0.04 : 0.25;
      if (!row.observed || Math.abs(core.utc - row.utc) * 86400 > interval ||
          row.latitude !== core.latitude || row.longitude !== core.longitude) {
        var pos = row.object.getPosIcrf(engine.observer);
        if (!pos) return null;
        row.observed = engine.convertFrame(engine.observer, 'ICRF', 'OBSERVED', pos);
        row.utc = core.utc; row.latitude = core.latitude; row.longitude = core.longitude;
      }
      var point = projectObserved(row.observed, core, width, height);
      if (!point || state.ground && point.altitude < 0) return null;
      return point;
    }

    function paint(state, width, height) {
      ctx.clearRect(0, 0, width, height);
      if (asterisms.length && !asterisms[0].observed) pointForObject(asterisms[0], state, width, height);
      var portrait = height > width * 1.3;
      var fontSize = Math.max(24, Math.min(36, height * 0.028));
      var candidates = [];
      if (state.labels) candidates = candidates.concat(asterisms);
      candidates = candidates.concat(planets);
      if (state.star_labels) candidates = candidates.concat(stars);
      candidates.sort(function (a, b) { return a.priority - b.priority; });
      var boxes = [];
      var drawn = [];
      // Reserve the broadcast title and the lower caption area.
      boxes.push({ x: 0, y: 0, w: width * 0.7, h: height * (portrait ? 0.18 : 0.23) });
      boxes.push({ x: 0, y: height * (portrait ? 0.72 : 0.93), w: width, h: height });
      function overlaps(box) {
        return boxes.some(function (other) {
          return box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y;
        });
      }
      candidates.forEach(function (row) {
        var point = pointForObject(row, state, width, height);
        if (!point || point.x < 10 || point.x > width - 10 || point.y < 10 || point.y > height - 10) return;
        if (row.priority === 0 && row.name !== '月亮' && row.name !== '太阳' && row.object.getVMag(engine.observer) > 6) return;
        var size = row.priority === 0 ? fontSize * 1.1 : row.priority === 4 ? fontSize * 0.85 : fontSize;
        ctx.font = '500 ' + size + 'px "Microsoft YaHei","Noto Sans CJK SC","PingFang SC",sans-serif';
        var textWidth = ctx.measureText(row.name).width;
        var placements = [
          { x: point.x + 9, y: point.y - size - 6 },
          { x: point.x - textWidth - 12, y: point.y + 10 },
          { x: point.x + 9, y: point.y + 10 },
          { x: point.x - textWidth - 12, y: point.y - size - 6 }
        ];
        var box = null;
        placements.some(function (placement) {
          var candidate = { x: placement.x, y: placement.y, w: textWidth + 8, h: size + 9 };
          if (candidate.x < 5 || candidate.x + candidate.w > width - 5 ||
              candidate.y < 5 || candidate.y + candidate.h > height - 5 || overlaps(candidate)) return false;
          box = candidate;
          return true;
        });
        if (!box) return;
        boxes.push(box);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.92)';
        ctx.fillStyle = row.priority === 0 ? '#f0d69a' : row.priority === 4 ? '#c0cadd' : '#ddd2b4';
        ctx.strokeText(row.name, box.x, box.y + size);
        ctx.fillText(row.name, box.x, box.y + size);
        drawn.push({ name: row.name, x: point.x, y: point.y });
      });
      CARDINALS.forEach(function (cardinal) {
        var point = projectObserved(cardinal.pos, engine.core, width, height);
        if (!point || point.x < 15 || point.x > width - 15 || point.y < 15 || point.y > height - 15) return;
        ctx.font = '600 ' + fontSize + 'px "Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#d49385';
        ctx.strokeText(cardinal.name, point.x, point.y + fontSize);
        ctx.fillText(cardinal.name, point.x, point.y + fontSize);
        ctx.textAlign = 'left';
      });
      ready = asterisms.some(function (row) { return row.observed && normalize(row.observed); });
      debug.drawn = drawn;
      debug.engineCulture = group;
      debug.objectCount = asterisms.length;
    }

    function tick() {
      var state = getState();
      if (!state) return;
      try {
        if (Date.now() - lastRefresh > 1000) { refresh(state); lastRefresh = Date.now(); }
        var rect = engine.canvas.getBoundingClientRect();
        var width = rect.width, height = rect.height, ratio = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
          canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
          canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
          canvas.style.left = rect.left + 'px'; canvas.style.top = rect.top + 'px';
          ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
        paint(state, width, height);
      } catch (error) { debug.error = error.message; }
    }
    var interval = setInterval(tick, 33);
    this.ready = function () { return ready; };
    this.debug = debug;
    this.projectObserved = projectObserved;
    window.addEventListener('pagehide', function () {
      clearInterval(interval);
      release(asterisms); release(planets); release(stars);
    });
  };
}());
