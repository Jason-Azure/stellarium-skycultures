/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Live console: every control writes the shared state; the preview and the OBS program page
 * follow it. With "跟随预览" off, camera moves stay in the preview until "切出".
 */
(function () {
  'use strict';
  var state = null, catalog = null, program = null, autoGround = false;
  var $ = function (id) { return document.getElementById(id); };
  var preview = $('preview');
  var PLACES = [
    { name: '洛阳', lat: 34.62, lng: 112.45, elev: 150 },
    { name: '登封观星台', lat: 34.40, lng: 113.14, elev: 280 },
    { name: '陶寺', lat: 35.88, lng: 111.50, elev: 580 },
    { name: '西安', lat: 34.26, lng: 108.94, elev: 400 },
    { name: '北京', lat: 39.90, lng: 116.40, elev: 50 },
    { name: '上海', lat: 31.23, lng: 121.47, elev: 10 }
  ];
  var GLYPH = { all: '全', mansions: '宿', ziwei: '紫', taiwei: '太', tianshi: '市', beidou: '斗',
    dragon: '龙', tortoise: '武', tiger: '虎', bird: '雀' };
  var ORDER = ['ziwei', 'taiwei', 'tianshi', 'beidou', 'mansions', 'dragon', 'tortoise', 'tiger', 'bird', 'all'];
  var EVENT_MS = Date.parse('2026-11-24T18:30:00+08:00');

  // ---------------------------------------------------------------- helpers
  var sayTimer = 0;
  function say(text, error) {
    var el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!error);
    el.classList.add('show');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () { el.classList.remove('show'); }, error ? 6000 : 2600);
  }
  function patch(value) {
    return fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || '设置未生效'); return body; }); })
      .then(function (body) { state = body; render(); return body; })
      .catch(function (error) { say(error.message, true); });
  }
  function sky() { return preview.contentWindow && preview.contentWindow.gx; }
  function portrait() { return aspect() === '9:16'; }
  function aspect() {
    if (program && program.age < 6 && program.w && program.h) return program.h > program.w ? '9:16' : '16:9';
    return state ? state.view.aspect : '16:9';
  }
  function skyMs() {
    var t = state.time;
    return t.live ? Date.now() : t.t0 + (Date.now() - t.w0) * t.rate;
  }
  function beijingParts(ms) {
    var d = new Date(ms + 8 * 3600e3), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var y = d.getUTCFullYear();
    return { date: (y > 0 ? y + '年' : '公元前' + (1 - y) + '年') + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日',
      time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()),
      input: String(y).padStart(4, '0') + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) };
  }
  function title(text) { return $('auto-title').checked ? { title: text } : {}; }

  // Camera: through the shared state when following, otherwise only into the preview.
  function shoot(camera, extra) {
    camera.motion = camera.motion || 'glide';
    camera.source = 'console';
    var body = Object.assign({}, extra || {});
    if (state.follow) body.camera = camera;
    else if (sky() && sky().go) sky().go(camera);
    return patch(body);
  }
  function lookToward(az, alt, name) {
    shoot({ kind: 'altaz', az: az, alt: alt, fov: portrait() ? 80 : 100 }, Object.assign(groundBack(), title(name)));
  }
  function groundBack() {
    clearTimeout(recheck);
    if (autoGround && state.view.ground === 'none') { autoGround = false; return { view: { ground: 'ink' } }; }
    return {};
  }
  // Below the horizon right now? Switch to the full sphere so the asterism stays visible.
  function altitudeOf(target, hips) {
    if (!sky() || !sky().altitude) return null;
    var alt = sky().altitude(target);
    // an asterism outside the current group has no engine object yet; its stars always do
    for (var i = 0; alt === null && hips && i < hips.length; i++) alt = sky().altitude('HIP ' + hips[i]);
    return alt;
  }
  var recheck = 0;
  function groundFor(target, hips) {
    var alt = altitudeOf(target, hips);
    clearTimeout(recheck);
    if (alt === null) {
      // not resolvable until the preview has loaded that part of the sky: look again once the camera arrives
      recheck = setTimeout(function () {
        var later = altitudeOf(target, hips);
        if (later !== null && later < 6 && state.view.ground !== 'none') {
          autoGround = true;
          patch({ view: { ground: 'none' } });
          say('目标此刻在地平线下，已切到全天球');
        }
      }, 2300);
    }
    if (alt !== null && alt < 6 && state.view.ground !== 'none') {
      autoGround = true;
      say('目标此刻在地平线下，已切到全天球');
      return { view: { ground: 'none' } };
    }
    if (alt !== null && alt > 12) return groundBack();
    return {};
  }
  function selectGroup(key) {
    var g = catalog.groups.find(function (x) { return x.key === key; });
    var extra = Object.assign({ group: key }, title(g.name));
    if (g.hip) {
      Object.assign(extra, groundFor('HIP ' + g.hip));
      return shoot({ kind: 'object', object: 'HIP ' + g.hip, fov: g.fov * (portrait() ? 0.85 : 1) }, extra);
    }
    Object.assign(extra, groundBack());
    return shoot({ kind: 'altaz', az: 180, alt: portrait() ? 36 : 32, fov: key === 'mansions' ? 120 : 100 }, extra);
  }
  function findAsterism(name) {
    name = (name || '').trim();
    var hit = catalog.asterisms.find(function (a) { return a.name === name; }) ||
      catalog.asterisms.find(function (a) { return a.name.indexOf(name) === 0; });
    if (!name || !hit) { say('没有找到“' + name + '”，请从列表里选星官名', true); return; }
    var extra = title(hit.name);
    var inGroup = state.group === 'all' || (state.group === 'mansions' && hit.rank === 1);
    if (!inGroup) extra.group = 'all';
    Object.assign(extra, groundFor('CON ' + hit.suffix, hit.hips));
    shoot({ kind: 'object', object: 'CON ' + hit.suffix, fov: 0 }, extra);
    $('search').value = '';
  }
  function focusMoon() {
    shoot({ kind: 'object', object: 'NAME Moon', fov: portrait() ? 7 : 9 }, Object.assign(title('月亮'), groundFor('NAME Moon')));
  }

  // ---------------------------------------------------------------- time
  function setTime(ms, rate) {
    return patch({ time: { live: false, t0: ms, w0: Date.now(), rate: rate } });
  }
  function goLive() { return patch({ time: { live: true, t0: Date.now(), w0: Date.now(), rate: 1 } }); }
  var lastRate = 600;
  function togglePause() {
    var t = state.time;
    if (!t.live && t.rate === 0) setTime(skyMs(), lastRate);
    else { if (!t.live) lastRate = t.rate; setTime(skyMs(), 0); }
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!state) return;
    document.querySelectorAll('[data-view]').forEach(function (input) {
      var key = input.dataset.view;
      input.checked = key === 'classic' ? state.view.planets === 'classic' : !!state.view[key];
    });
    $('follow').checked = state.follow;
    $('take').disabled = state.follow;
    document.querySelectorAll('[data-ground]').forEach(function (b) { b.classList.toggle('active', b.dataset.ground === state.view.ground); });
    var locked = !!(program && program.age < 6 && program.w);
    $('aspect').classList.toggle('locked', locked);
    document.querySelectorAll('[data-aspect]').forEach(function (b) { b.classList.toggle('active', b.dataset.aspect === aspect()); });
    document.querySelectorAll('#groups [data-group]').forEach(function (b) { b.classList.toggle('active', b.dataset.group === state.group); });
    document.querySelectorAll('#places button').forEach(function (b) { b.classList.toggle('active', b.textContent === state.location.name); });
    var t = state.time;
    $('live').classList.toggle('active', t.live);
    document.querySelectorAll('[data-rate]').forEach(function (b) { b.classList.toggle('active', !t.live && Number(b.dataset.rate) === t.rate); });
    $('pause').textContent = !t.live && t.rate === 0 ? '▶' : '❚❚';
    if (document.activeElement !== $('title')) $('title').value = state.title;
    if (document.activeElement !== $('caption')) $('caption').value = state.caption;
    var L = state.location;
    if (!$('place').matches(':focus')) {
      $('place').value = L.name; $('lat').value = L.lat; $('lng').value = L.lng; $('elev').value = L.elev;
    }
    layout();
    tick();
  }
  function tick() {
    if (!state) return;
    var parts = beijingParts(skyMs()), t = state.time;
    $('sky-clock').textContent = parts.date + ' ' + parts.time;
    var mode = t.live ? '此刻' : t.rate === 0 ? '定格' : (t.rate < 0 ? '倒放 ×' : '快进 ×') + Math.abs(t.rate);
    if (!t.live && t.rate === 1) mode = '演示时间 · 正常走时';
    $('sky-meta').textContent = '北京时间 · ' + state.location.name + ' · ' + mode;
  }
  function layout() {
    var stage = $('stage'), frame = $('frame');
    var W = stage.clientWidth - 44, H = stage.clientHeight - 44;
    var ratio = aspect() === '9:16' ? 9 / 16 : 16 / 9;
    var w = Math.min(W, H * ratio), h = w / ratio;
    frame.style.width = Math.floor(w) + 'px';
    frame.style.height = Math.floor(h) + 'px';
  }
  function showProgram() {
    var el = $('program-status');
    var on = program && program.age !== null && program.age < 6;
    el.classList.toggle('on', !!on);
    el.textContent = on ? '播出画面 ' + program.w + '×' + program.h + ' · ' + program.fps + ' fps' : 'OBS 播出画面未连接';
  }

  // ---------------------------------------------------------------- build
  function build() {
    ORDER.forEach(function (key) {
      var g = catalog.groups.find(function (x) { return x.key === key; });
      var b = document.createElement('button');
      b.dataset.group = key;
      b.innerHTML = '<b>' + GLYPH[key] + '</b><small>' + (key === 'all' ? '全天星官' : g.name) + '</small>';
      b.addEventListener('click', function () { selectGroup(key); });
      $('groups').appendChild(b);
    });
    [['昴', '昴宿', function () { findAsterism('昴宿'); }], ['月', '月亮', focusMoon]].forEach(function (item) {
      var b = document.createElement('button');
      b.innerHTML = '<b>' + item[0] + '</b><small>' + item[1] + '</small>';
      b.addEventListener('click', item[2]);
      $('groups').appendChild(b);
    });
    catalog.asterisms.slice().sort(function (a, b) { return a.rank - b.rank || b.stars - a.stars; }).forEach(function (a) {
      var o = document.createElement('option');
      o.value = a.name;
      $('asterism-names').appendChild(o);
    });
    PLACES.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p.name;
      b.addEventListener('click', function () { patch({ location: p }); });
      $('places').appendChild(b);
    });
    $('data-info').textContent = catalog.asterism_count + ' 个星官、' + catalog.star_name_count + ' 个星名；数据版本 ' + catalog.revision.slice(0, 10) + '。';
    $('source-link').href = catalog.source_url;
    $('program-url').textContent = location.origin + '/program';
  }

  document.querySelectorAll('#directions [data-az]').forEach(function (b) {
    b.addEventListener('click', function () {
      lookToward(Number(b.dataset.az), portrait() ? 36 : 32, '望' + b.textContent + '方');
    });
  });
  document.querySelector('[data-zenith]').addEventListener('click', function () {
    shoot({ kind: 'altaz', az: 180, alt: 89.9, fov: portrait() ? 120 : 150 }, title('头顶的天空'));
  });
  $('find').addEventListener('click', function () { findAsterism($('search').value); });
  $('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') findAsterism(e.target.value); });
  $('event-pleiades').addEventListener('click', function () {
    var suffix = catalog.asterisms.find(function (a) { return a.name === '昴宿'; }).suffix;
    patch({ location: PLACES[0], group: 'all', title: '月过昴宿', view: { ground: 'ink' },
      time: { live: false, t0: EVENT_MS, w0: Date.now(), rate: 0 } }).then(function () {
      shoot({ kind: 'object', object: 'CON ' + suffix, fov: portrait() ? 9 : 12 });
    });
    $('demo-time').value = beijingParts(EVENT_MS).input;
  });
  document.querySelectorAll('[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      setTime(skyMs() + Number(b.dataset.step) * 1000, state.time.live ? 0 : state.time.rate);
    });
  });
  document.querySelectorAll('[data-rate]').forEach(function (b) {
    b.addEventListener('click', function () { lastRate = Number(b.dataset.rate); setTime(skyMs(), lastRate); });
  });
  $('pause').addEventListener('click', togglePause);
  $('live').addEventListener('click', goLive);
  $('time-apply').addEventListener('click', function () {
    var v = $('demo-time').value;
    if (!v) return say('先填写演示时间', true);
    setTime(Date.parse(v + ':00+08:00'), 0);
  });
  $('tonight').addEventListener('click', function () {
    var day = beijingParts(Date.now()).input.slice(0, 10);
    $('demo-time').value = day + 'T20:00';
    setTime(Date.parse(day + 'T20:00:00+08:00'), 0);
  });
  $('place-apply').addEventListener('click', function () {
    patch({ location: { name: $('place').value, lat: Number($('lat').value), lng: Number($('lng').value), elev: Number($('elev').value) } });
  });
  document.querySelectorAll('[data-view]').forEach(function (input) {
    input.addEventListener('change', function () {
      var key = input.dataset.view, view = {};
      if (key === 'classic') view.planets = input.checked ? 'classic' : 'modern';
      else view[key] = input.checked;
      patch({ view: view });
    });
  });
  document.querySelectorAll('[data-ground]').forEach(function (b) {
    b.addEventListener('click', function () { autoGround = false; patch({ view: { ground: b.dataset.ground } }); });
  });
  document.querySelectorAll('[data-aspect]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (program && program.age < 6 && program.w) return say('画幅跟随已连接的 OBS 画面');
      patch({ view: { aspect: b.dataset.aspect } });
    });
  });
  ['title', 'caption'].forEach(function (id) {
    var input = $(id);
    var commit = function () { var v = {}; v[id] = input.value; if (input.value !== state[id]) patch(v); };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { commit(); input.blur(); } });
  });
  $('follow').addEventListener('change', function () { patch({ follow: $('follow').checked }); });
  $('take').addEventListener('click', take);
  function take() {
    var cam = sky() && sky().take && sky().take();
    if (!cam) return say('预览还没准备好', true);
    patch({ camera: Object.assign(cam, { motion: 'glide', source: 'console' }) }).then(function () { say('已切出到播出画面'); });
  }

  function hotkey(key) {
    if (!catalog || !state) return;
    var groups = { 1: 'ziwei', 2: 'taiwei', 3: 'tianshi', 4: 'mansions', 5: 'beidou', 0: 'all' };
    var k = key.length === 1 ? key.toLowerCase() : key;
    if (groups[k] !== undefined) selectGroup(groups[k]);
    else if (k === 'p') findAsterism('昴宿');
    else if (k === 'm') focusMoon();
    else if (k === 't') goLive();
    else if (k === ' ') togglePause();
    else if (k === 'f') patch({ follow: !state.follow });
    else if (k === 'Enter' && !state.follow) take();
  }
  document.addEventListener('keydown', function (e) {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[0-9pmtfPMTF ]$/.test(e.key) || e.key === 'Enter') { e.preventDefault(); hotkey(e.key); }
  });
  addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== preview.contentWindow) return;
    if (e.data && e.data.type === 'gx-key') hotkey(e.data.key);
  });
  addEventListener('resize', layout);

  // ---------------------------------------------------------------- start
  fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (data) {
    catalog = data;
    build();
    var source = new EventSource('/api/events');
    source.onmessage = function (e) { state = JSON.parse(e.data); render(); };
    source.onerror = function () { say('本地服务未连接：请重新运行 Start-ChineseSky', true); };
    source.onopen = function () { say('已连接本地服务'); };
    $('demo-time').value = beijingParts(Date.now()).input.slice(0, 10) + 'T20:00';
  }).catch(function () { say('本地服务未连接：请重新运行 Start-ChineseSky', true); });
  function pollProgram() {
    fetch('/api/program').then(function (r) { return r.json(); }).then(function (p) {
      var before = aspect();
      program = p && p.seen ? p : null;
      showProgram();
      if (state && before !== aspect()) render();
    }).catch(function () {});
  }
  pollProgram();
  setInterval(pollProgram, 2000);
  setInterval(tick, 250);
}());
