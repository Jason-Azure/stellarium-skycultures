/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Engine host for the OBS program (?role=program) and the console preview (?role=preview).
 * The official Stellarium Web bundle boots the engine and exposes it as window._stel; this
 * script follows the shared live state, drives the engine and draws the broadcast graphics.
 */
(function () {
  'use strict';
  var D = Math.PI / 180;
  var ROLE = new URLSearchParams(location.search).get('role') === 'preview' ? 'preview' : 'program';
  var ID = ROLE + '-' + Math.random().toString(36).slice(2, 9);
  var engine = null, state = null, catalog = null, labels = null;
  var cultures = new Set(), maintained = 0, maintainedVersion = -1;
  var cam = { serial: -1, pending: null, tries: 0, first: true };
  var clock = { key: '', holdUntil: 0 };
  var fps = { frames: 0, since: performance.now(), value: 0 };
  var perf = window.gxPerf = { draw: 0 };
  var user = { down: false, last: 0, sent: 0, cam: null };
  var staged = null;   // last camera command shown here; what the console takes to air
  var started = performance.now(), fontsReady = false, revealed = false, reserved = [], reservedAt = 0;

  // ---------------------------------------------------------------- graphics
  var host = document.createElement('div');
  host.id = 'gx-root';
  var root = host.attachShadow({ mode: 'open' });
  var CREDIT = '星图 Stellarium Web · 星官 Stellarium 中国星空文化（CC BY-SA）';
  root.innerHTML = '<link rel="stylesheet" href="/web/hud.css"><div class="shade"></div><canvas></canvas>' +
    '<div class="hud">' +
    '<div class="block"><img class="seal" src="/web/brand/seal.png" alt=""><div class="text">' +
    '<h1></h1><p class="meta"><span class="place"></span><span class="sep">·</span><span class="clock"></span>' +
    '<span class="badge"></span></p><p class="caption"></p><p class="credit inline"></p></div></div>' +
    '<p class="credit bottom"></p>' +
    '<div class="safe top"><span>视频号顶栏</span></div><div class="safe bottom"><span>评论与按钮区</span></div></div>' +
    '<div class="veil"><img src="/web/brand/seal.png" alt=""><span>星图载入中</span></div>';
  document.body.appendChild(host);
  var $ = function (sel) { return root.querySelector(sel); };
  var canvas = $('canvas'), ctx = canvas.getContext('2d');
  var hud = $('.hud'), veil = $('.veil');
  root.querySelectorAll('.credit').forEach(function (el) { el.textContent = CREDIT; });
  if (ROLE === 'preview') hud.classList.add('preview');

  Promise.all([
    document.fonts.load('600 40px "GX Sky Serif"', '观象星宿'),
    document.fonts.load('40px "GX Sky Kai"', '观象星宿')
  ]).then(function () { fontsReady = true; }, function () { fontsReady = true; });

  // ---------------------------------------------------------------- time
  function skyMs(t, now) { return t.live ? now : t.t0 + (now - t.w0) * t.rate; }
  function beijing(ms, seconds) {
    var d = new Date(ms + 8 * 3600e3), y = d.getUTCFullYear();
    var year = y > 0 ? y + '年' : '公元前' + (1 - y) + '年';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return year + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + pad(d.getUTCHours()) + ':' +
      pad(d.getUTCMinutes()) + (seconds ? ':' + pad(d.getUTCSeconds()) : '');
  }
  function rateText(rate) {
    if (rate === 0) return '演示 · 定格';
    var abs = Math.abs(rate), dirText = rate < 0 ? '倒放' : '快进';
    if (abs === 1) return rate < 0 ? '演示 · 倒放' : '演示';
    return '演示 · ' + dirText + ' ×' + abs;
  }

  // ---------------------------------------------------------------- state
  function connect() {
    var source = new EventSource('/api/events');
    source.onmessage = function (event) {
      state = JSON.parse(event.data);
      maintainedVersion = -1;
      renderHud(true);
    };
  }
  fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (data) { catalog = data; });
  connect();

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- engine
  function set(target, key, value) {
    if (target && key in target && target[key] !== value) target[key] = value;
  }
  function maintain(now) {
    if (maintainedVersion === state.version && now - maintained < 1000) return;
    maintained = now; maintainedVersion = state.version;
    var e = engine, v = state.view;
    var id = 'gx_' + state.group;
    if (!cultures.has(id)) {
      e.skycultures.addDataSource({ url: location.origin + '/culture/' + id, key: id });
      cultures.add(id);
    }
    set(e.skycultures, 'current_id', id);
    var L = state.location;
    if (Math.abs(e.core.latitude - L.lat * D) > 1e-7 || Math.abs(e.core.longitude - L.lng * D) > 1e-7 ||
        Math.abs(e.core.elevation - L.elev) > 0.5) e.setLocation(L.lat * D, L.lng * D, L.elev);
    var C = e.constellations;
    set(C, 'visible', true); set(C, 'lines_visible', v.lines); set(C, 'labels_visible', false);
    set(C, 'images_visible', false); set(C, 'bounds_visible', false); set(C, 'show_only_pointed', false);
    ['stars', 'planets', 'dsos', 'minor_planets', 'comets'].forEach(function (m) { set(e[m], 'hints_visible', false); });
    // no satellites, probe models or simulated meteors on air: viewers would take them for the real sky
    set(e.satellites, 'visible', false);
    set(e.space_probes, 'visible', false);
    set(e.meteors, 'visible', false);
    set(e.cardinals, 'visible', false);
    set(e.atmosphere, 'visible', v.atmosphere && v.ground !== 'none');   // the full sphere reads as a dark star chart
    set(e.landscapes, 'visible', v.ground === 'field');
    set(e.landscapes, 'fog_visible', v.ground === 'field');
    set(e.grid_equatorial, 'visible', v.grid);
    set(e.core, 'projection', 2);
    set(e.core, 'mount_frame', e.FRAME_OBSERVED);
    set(e.core, 'roll', 0);
    set(e.core, 'star_linear_scale', 0.92);
    ['margin_top', 'margin_right', 'margin_bottom', 'margin_left'].forEach(function (k) { set(e.core, k, 0); });
  }

  function applyTime(now) {
    var e = engine, t = state.time, key = JSON.stringify(t);
    var speed = t.live ? 1 : t.rate;
    var mjdAt = function (ms) { return skyMs(t, ms) / 864e5 + 40587; };
    if (key !== clock.key) {
      var jump = Math.abs(e.core.utc - mjdAt(Date.now()));
      var sweep = clock.key && jump > 60 / 86400 && jump < 1.05;   // glide through jumps of up to a day
      clock.key = key;
      if (sweep) {
        e.core.time_speed = 0;
        e.setTime(mjdAt(Date.now() + 1500), 1.5);
        clock.holdUntil = now + 1600;
      } else {
        e.setTime(mjdAt(Date.now()));
        clock.holdUntil = 0;
      }
      return;
    }
    if (now < clock.holdUntil) return;
    set(e.core, 'time_speed', speed);
    var tolerance = Math.max(1.5, Math.abs(speed) * 0.3) / 86400;
    if (Math.abs(e.core.utc - mjdAt(Date.now())) > tolerance) e.setTime(mjdAt(Date.now()));
  }

  function resolve(id) {
    var e = engine;
    if (id.indexOf('CON ') === 0) {
      // the current group first; any culture that carries the same asterism number will do for a position
      var ids = ['gx_' + state.group, 'gx_all', 'chinese'];
      for (var i = 0; i < ids.length; i++) {
        var hit = e.resolveObjByUri('constellations::CON ' + ids[i] + ' ' + id.slice(4));
        if (hit) return hit;
      }
      return null;
    }
    if (id.indexOf('NAME ') === 0) return e.resolveObjByUri('planets::' + id);
    if (id.indexOf('HIP ') === 0) return e.resolveObjByUri('stars::' + id);
    return e.resolveObjByUri(id);
  }
  function applyCamera() {
    var c = state.camera;
    if (c.serial !== cam.serial) {
      cam.serial = c.serial;
      if (c.source !== ID) { cam.pending = c; cam.tries = 0; }
    }
    if (!cam.pending) return;
    c = cam.pending;
    staged = { kind: c.kind, object: c.object, az: c.az, alt: c.alt, fov: c.fov };
    var e = engine, dur = cam.first || c.motion === 'cut' ? 0 : c.motion === 'track' ? 0.35 : 1.8;
    if (c.kind === 'object') {
      var obj = resolve(c.object);
      if (!obj) {
        if (++cam.tries > 900) cam.pending = null;
        return;
      }
      var fov = c.fov;
      if (!fov) {
        var r = obj.getAngularRadius(e.observer) || 0;
        fov = r > 0.6 * D ? Math.min(120, Math.max(10, 2 * r / D * 1.9)) : 30;
      }
      e.pointAndLock(obj, dur);
      e.zoomTo(fov * D, dur);
      obj.destroy();
    } else {
      set(e.core, 'lock', null);
      e.lookAt(e.s2c(c.az * D, c.alt * D), dur);
      e.zoomTo(c.fov * D, dur);
    }
    cam.pending = null;
    cam.first = false;
  }

  function currentCamera() {
    var c = engine.core;
    return { az: ((c.yaw / D) % 360 + 360) % 360, alt: c.pitch / D, fov: c.fov / D };
  }

  // Preview only: a drag or wheel in the preview becomes the live camera when following.
  ['pointerdown', 'wheel', 'touchstart'].forEach(function (type) {
    window.addEventListener(type, function () {
      user.last = performance.now();
      if (type !== 'wheel') user.down = true;
    }, true);
  });
  ['pointerup', 'pointercancel', 'touchend'].forEach(function (type) {
    window.addEventListener(type, function () { user.down = false; user.last = performance.now(); }, true);
  });
  function watchUser(now) {
    if (!(user.down || now - user.last < 800) || now - user.sent < 110) return;
    var c = currentCamera(), p = user.cam;
    if (p && Math.abs(p.az - c.az) < 0.02 && Math.abs(p.alt - c.alt) < 0.02 && Math.abs(p.fov - c.fov) < 0.02) return;
    user.cam = c; user.sent = now; staged = null;
    if (state && state.follow) {
      post('/api/state', { camera: { kind: 'altaz', az: c.az, alt: c.alt, fov: c.fov, motion: 'track', source: ID } });
    }
    parent.postMessage({ type: 'gx-preview-camera', camera: c }, location.origin);
  }
  if (ROLE === 'preview') {
    document.addEventListener('keydown', function (event) {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (/^[0-9pmtfPMTF ]$/.test(event.key) || event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        parent.postMessage({ type: 'gx-key', key: event.key }, location.origin);
      }
    }, true);
  }

  // ---------------------------------------------------------------- hud
  function renderHud(full) {
    if (!state) return;
    var w = innerWidth, h = innerHeight;
    host.style.setProperty('--u', (Math.min(w, h) / 100) + 'px');
    hud.classList.toggle('portrait', h > w * 1.05);
    hud.classList.toggle('off', !state.view.hud);
    $('.shade').classList.toggle('off', !state.view.hud);
    $('.shade').classList.toggle('portrait', h > w * 1.05);
    var now = Date.now(), t = state.time;
    if (full) {
      $('h1').textContent = state.title;
      $('.caption').textContent = state.caption || '';
      $('.place').textContent = state.location.name;
    }
    $('.clock').textContent = beijing(skyMs(t, now), false);
    var badge = $('.badge');
    badge.textContent = t.live ? '此刻' : rateText(t.rate);
    badge.classList.toggle('live', !!t.live);
  }
  function updateReserved(now) {
    if (now - reservedAt < 500) return;
    reservedAt = now;
    reserved = [];
    if (!state) return;
    // 视频号竖屏直播间顶栏盖住上沿约 11%，那里不放星名
    if (innerHeight > innerWidth * 1.05) reserved.push({ x: 0, y: 0, w: innerWidth, h: innerHeight * 0.105 });
    if (!state.view.hud) return;
    root.querySelectorAll('.block .text, .block .seal, .credit.bottom').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width && r.height) reserved.push({ x: r.left - 8, y: r.top - 8, w: r.width + 16, h: r.height + 16 });
    });
  }

  // ---------------------------------------------------------------- loop
  function frame(now) {
    requestAnimationFrame(frame);
    fps.frames++;
    if (now - fps.since > 1000) { fps.value = fps.frames * 1000 / (now - fps.since); fps.frames = 0; fps.since = now; }
    if (!engine) {
      if (window._stel && window._stel.core) { engine = window._stel; window.gxEngine = engine; }
      else if (now - started > 45000 && !veil.classList.contains('error')) {
        veil.classList.add('error');
        veil.querySelector('span').textContent = '无法载入 Stellarium 星图：检查网络后刷新本页';
      }
      return;
    }
    if (!state || !catalog) return;
    try {
      maintain(now);
      applyTime(now);
      applyCamera();
    } catch (error) { console.warn('[gx] engine', error); }
    if (!labels && fontsReady) { labels = new window.GXLabels(engine, catalog); window.gxLabels = labels; }
    var rect = engine.canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    var w = rect.width, h = rect.height;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
      canvas.style.left = rect.left + 'px'; canvas.style.top = rect.top + 'px';
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      renderHud(true);
    }
    updateReserved(now);
    if (labels) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      try {
        var t0 = performance.now();
        labels.draw(ctx, w, h, { state: state, reserved: reserved, focus: focusSuffix() });
        perf.draw = perf.draw * 0.95 + (performance.now() - t0) * 0.05;
      } catch (error) { console.warn('[gx] labels', error); }
    }
    if (!revealed && labels && (labels.ready() || now - started > 15000)) {
      revealed = true;
      setTimeout(function () { veil.classList.add('gone'); }, 400);
    }
    if (ROLE === 'preview') watchUser(now);
  }
  function focusSuffix() {
    var c = state.camera;
    return c.kind === 'object' && c.object && c.object.indexOf('CON ') === 0 ? c.object.slice(4) : null;
  }
  requestAnimationFrame(frame);
  setInterval(function () { renderHud(false); }, 250);
  addEventListener('resize', function () { renderHud(true); });
  if (ROLE === 'program') {
    setInterval(function () {
      post('/api/program', { w: innerWidth, h: innerHeight, fps: fps.value, ready: revealed });
    }, 2000);
  }

  // Same-origin helpers for the console.
  window.gx = {
    camera: function () { return engine ? currentCamera() : null; },
    altitude: function (id) {
      if (!engine || !state) return null;
      var obj = resolve(id);
      if (!obj) return null;
      var p = obj.getPosIcrf(engine.observer);
      obj.destroy();
      if (!p) return null;
      var v = engine.convertFrame(engine.observer, 'ICRF', 'OBSERVED', p);
      return Math.asin(v[2] / Math.hypot(v[0], v[1], v[2])) / D;
    },
    ready: function () { return revealed; },
    go: function (camera) { cam.pending = camera; cam.tries = 0; },
    take: function () {
      if (!engine) return null;
      if (staged) return Object.assign({}, staged);
      var c = currentCamera();
      return { kind: 'altaz', az: c.az, alt: c.alt, fov: c.fov };
    }
  };
}());
