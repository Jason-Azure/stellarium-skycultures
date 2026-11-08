(function () {
  'use strict';
  var isProgram = location.pathname.indexOf('/program') === 0;
  if (isProgram) document.body.classList.add('program');
  var frame = document.getElementById('sky');
  var state = null;
  var catalog = null;
  var pendingSettings = {};
  var clock = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var cities = {
    luoyang: { name: '洛阳', lat: 34.62, lng: 112.45, elev: 150 },
    beijing: { name: '北京', lat: 39.90, lng: 116.40, elev: 50 },
    shanghai: { name: '上海', lat: 31.23, lng: 121.47, elev: 10 }
  };
  function byId(id) { return document.getElementById(id); }
  function report(message, error) {
    var el = byId('control-status');
    el.textContent = message;
    el.classList.toggle('error', !!error);
  }
  function chinaDay() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function sendState() {
    if (state) frame.contentWindow.postMessage({ type: 'gx-state', state: state }, location.origin);
  }
  function render() {
    if (!state) return;
    window.gxState = state;
    byId('sky-title').textContent = state.title;
    byId('view-mode').textContent = state.ground ? '计算星空 · 地面仰观' : '计算星空 · 全天球讲解 · 仰观';
    var when = state.time.mode === 'realtime' ? new Date() : new Date(state.time.iso);
    byId('sky-meta').textContent = state.location.name + ' · ' + clock.format(when) + ' 北京时间' + (state.time.mode === 'realtime' ? ' · 实时计算' : ' · 演示时间');
    document.querySelectorAll('[data-group]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.group === state.group);
    });
    document.querySelectorAll('[data-setting]').forEach(function (input) {
      var key = input.dataset.setting;
      input.checked = Object.prototype.hasOwnProperty.call(pendingSettings, key) ? pendingSettings[key] : state[key];
    });
    if (document.activeElement.tagName !== 'INPUT') {
      byId('place').value = state.location.name;
      byId('lat').value = state.location.lat;
      byId('lng').value = state.location.lng;
      byId('elev').value = state.location.elev;
      byId('title').value = state.title;
    }
    sendState();
  }
  async function patch(value) {
    Object.keys(value).forEach(function (key) {
      if (typeof value[key] === 'boolean') pendingSettings[key] = value[key];
    });
    try {
      var response = await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || '设置未能应用');
      if (!state || result.version >= state.version) state = result;
      Object.keys(value).forEach(function (key) {
        if (pendingSettings[key] === value[key]) delete pendingSettings[key];
      });
      render();
      report('设置已同步至直播画面');
    } catch (error) {
      Object.keys(value).forEach(function (key) {
        if (pendingSettings[key] === value[key]) delete pendingSettings[key];
      });
      render();
      report(error.message, true);
    }
  }
  async function poll() {
    try {
      var response = await fetch('/api/state');
      if (!response.ok) throw new Error('本地服务未连接');
      var result = await response.json();
      if (!state || state.version !== result.version) {
        state = result;
        render();
      }
    } catch (error) { report('本地服务未连接，请重新运行启动脚本。', true); }
  }
  function focusObject(object, title, fov, group, ground) {
    return patch({ group: group || 'all', title: title, ground: !!ground, focus: { object: object, fov: fov } });
  }
  function selectGroup(entry) {
    var change = { group: entry.key, title: entry.name };
    if (entry.key !== 'all') change.ground = false;
    if (entry.hip) change.focus = { object: 'HIP ' + entry.hip, fov: entry.fov };
    else change.camera = { az: 90, alt: 30, fov: entry.fov };
    patch(change);
  }
  function hotkey(key) {
    if (isProgram || !catalog) return;
    var keys = { '0': 'all', '1': 'ziwei', '2': 'taiwei', '3': 'tianshi', '4': 'mansions', '5': 'beidou' };
    if (keys[key]) selectGroup(catalog.groups.find(function (entry) { return entry.key === keys[key]; }));
    else if (key === 'p') findAsterism('昴宿');
    else if (key === 'm') byId('moon').click();
    else if (key === 't') byId('realtime').click();
  }
  function findAsterism(name) {
    var item = catalog.names.find(function (entry) { return entry.name === name; });
    if (!item) { report('请输入列表中的完整星官名，例如“昴宿”。', true); return; }
    focusObject('CON gx_all ' + item.suffix, item.name, item.name === '昴宿' ? 15 : 50);
  }
  frame.addEventListener('load', sendState);
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    var message = event.data || {};
    if (message.type === 'gx-bridge-ready') sendState();
    if (message.type === 'gx-key') hotkey(message.key);
    if (message.type === 'gx-engine-ready') {
      byId('loading').hidden = true;
      report('中文星图已载入');
    }
    if (message.type === 'gx-warning') {
      report(message.message, true);
      if (!byId('loading').hidden) byId('loading').textContent = message.message;
    }
  });

  async function init() {
    try {
      var response = await fetch('/api/catalog');
      if (!response.ok) throw new Error('星官目录未载入');
      catalog = await response.json();
      window.gxCatalog = catalog;
      catalog.groups.forEach(function (entry) {
        var button = document.createElement('button');
        button.textContent = entry.name;
        button.dataset.group = entry.key;
        button.addEventListener('click', function () { selectGroup(entry); });
        byId('group-buttons').appendChild(button);
      });
      catalog.names.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); }).forEach(function (entry) {
        var option = document.createElement('option');
        option.value = entry.name;
        byId('asterism-names').appendChild(option);
      });
      byId('source-link').href = catalog.source_url;
      byId('data-info').textContent = catalog.asterisms + ' 个原始星官条目、' + catalog.star_names + ' 个星名条目。版本：' + catalog.revision.slice(0, 12) + '。';
      byId('program-link').href = location.origin + '/program';
      byId('demo-time').value = chinaDay() + 'T20:00';
      await poll();
      report('已连接本地控制服务，等待星图引擎…');
    } catch (error) { report(error.message, true); }
  }
  byId('find').addEventListener('click', function () { findAsterism(byId('search').value.trim()); });
  byId('search').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') findAsterism(event.target.value.trim());
  });
  byId('pleiades').addEventListener('click', function () { findAsterism('昴宿'); });
  byId('moon').addEventListener('click', function () { focusObject('NAME Moon', '月亮', 12, 'all', true); });
  byId('event').addEventListener('click', function () {
    byId('demo-time').value = '2026-11-24T18:30';
    patch({ group: 'mansions', title: '月过昴星团', time: { mode: 'paused', iso: '2026-11-24T18:30:00+08:00' }, focus: { object: 'HIP 17702', fov: 12 }, ground: true });
  });
  document.querySelectorAll('[data-city]').forEach(function (button) {
    button.addEventListener('click', function () { patch({ location: cities[button.dataset.city] }); });
  });
  byId('location-apply').addEventListener('click', function () {
    patch({ location: { name: byId('place').value, lat: Number(byId('lat').value), lng: Number(byId('lng').value), elev: Number(byId('elev').value) } });
  });
  byId('time-apply').addEventListener('click', function () {
    if (!byId('demo-time').value) return report('请先填写演示时间', true);
    patch({ time: { mode: 'paused', iso: byId('demo-time').value + '+08:00' } });
  });
  byId('realtime').addEventListener('click', function () { patch({ time: { mode: 'realtime', iso: '' } }); });
  byId('tonight').addEventListener('click', function () {
    byId('demo-time').value = chinaDay() + 'T20:00';
    patch({ time: { mode: 'paused', iso: byId('demo-time').value + '+08:00' } });
  });
  document.querySelectorAll('[data-setting]').forEach(function (input) {
    input.addEventListener('change', function () { var value = {}; value[input.dataset.setting] = input.checked; patch(value); });
  });
  byId('title-apply').addEventListener('click', function () { patch({ title: byId('title').value }); });
  byId('camera-sync').addEventListener('click', function () {
    var snapshot = frame.contentWindow.gxSnapshot && frame.contentWindow.gxSnapshot();
    if (!snapshot) return report('星图引擎还未载入', true);
    patch({ camera: snapshot });
  });
  byId('reset').addEventListener('click', function () { patch({ camera: { az: 90, alt: 30, fov: 120 } }); });
  document.addEventListener('keydown', function (event) {
    if (!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && !event.ctrlKey && !event.altKey && !event.metaKey) hotkey(event.key.toLowerCase());
  });
  init();
  setInterval(poll, 500);
  setInterval(render, 1000);
}());
