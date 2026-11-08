/* The page is bootstrapped with the official Stellarium Web frontend assets. */
(function () {
  'use strict';
  var latest = null;
  var engine = null;
  var groups = new Set();
  var appliedTime = '';
  var appliedLocation = '';
  var cameraSerial = -1;
  var pendingSerial = -1;
  var readySent = false;
  var labelRenderer = null;
  var start = Date.now();
  var DEG = Math.PI / 180;

  function send(type, value) {
    parent.postMessage(Object.assign({ type: type }, value || {}), location.origin);
  }

  function moduleNamed(name) {
    return engine[name] || (engine.core && engine.core[name]);
  }

  function setIfPresent(target, key, value) {
    if (target && key in target && target[key] !== value) target[key] = value;
  }

  function settings(state) {
    var constellations = moduleNamed('constellations');
    setIfPresent(constellations, 'visible', state.lines || state.labels);
    setIfPresent(constellations, 'lines_visible', state.lines);
    // CJK labels are drawn by labels.js using the engine's observed coordinates.
    setIfPresent(constellations, 'labels_visible', false);
    setIfPresent(constellations, 'images_visible', false);
    setIfPresent(constellations, 'show_only_pointed', false);
    setIfPresent(moduleNamed('stars'), 'hints_visible', false);
    setIfPresent(moduleNamed('planets'), 'hints_visible', false);
    setIfPresent(moduleNamed('minor_planets'), 'hints_visible', false);
    setIfPresent(moduleNamed('comets'), 'hints_visible', false);
    setIfPresent(moduleNamed('satellites'), 'hints_visible', false);
    setIfPresent(moduleNamed('cardinals'), 'visible', false);
    setIfPresent(moduleNamed('atmosphere'), 'visible', state.ground);
    setIfPresent(moduleNamed('landscapes'), 'visible', state.ground);
    setIfPresent(moduleNamed('grid_equatorial'), 'visible', state.grid);
    setIfPresent(moduleNamed('dsos'), 'hints_visible', false);
    engine.core.projection = 2;
    engine.core.mount_frame = engine.FRAME_OBSERVED;
    engine.core.roll = 0;
    engine.core.margin_top = 0;
    engine.core.margin_right = 0;
    engine.core.margin_bottom = 0;
    engine.core.margin_left = 0;
  }

  function resolveTarget(id) {
    if (typeof engine.getObj === 'function') return engine.getObj(id);
    if (id.indexOf('CON ') === 0) return engine.resolveObjByUri('constellations::' + id);
    if (id.indexOf('NAME ') === 0) return engine.resolveObjByUri('planets::' + id);
    var aliases = {
      'HIP 11767': 'Polaris', 'HIP 57632': 'Denebola', 'HIP 84345': 'Rasalgethi',
      'HIP 59774': 'Megrez', 'HIP 80763': 'Antares', 'HIP 102618': 'Albali',
      'HIP 17702': 'Alcyone', 'HIP 46390': 'Alphard'
    };
    if (aliases[id]) {
      var object = engine.resolveObjByUri('stars:minimal.4:NAME ' + aliases[id]);
      if (object && object.jsonData.names.indexOf(id) >= 0) return object;
      if (object) object.destroy();
    }
    return null;
  }

  function moveCamera(state) {
    if (cameraSerial === state.camera_serial || pendingSerial === state.camera_serial) return;
    pendingSerial = state.camera_serial;
    var wanted = state.camera_serial;
    var tries = 0;
    function attempt() {
      if (!latest || latest.camera_serial !== wanted) {
        if (pendingSerial === wanted) pendingSerial = -1;
        return;
      }
      try {
        if (state.focus) {
          var object = resolveTarget(state.focus.object);
          if (!object) {
            if (++tries < 160) return setTimeout(attempt, 250);
            throw new Error('目标星官尚未载入，可再次点击定位。');
          }
          engine.pointAndLock(object, 0.8);
          engine.zoomTo(state.focus.fov * DEG, 0.8);
          if (typeof object.destroy === 'function') object.destroy();
        } else if (state.camera) {
          setIfPresent(engine.core, 'lock', null);
          engine.core.yaw = state.camera.az * DEG;
          engine.core.pitch = state.camera.alt * DEG;
          engine.core.fov = state.camera.fov * DEG;
        }
        cameraSerial = wanted;
        pendingSerial = -1;
        send('gx-camera-applied', { serial: wanted });
      } catch (error) {
        pendingSerial = -1;
        cameraSerial = wanted;
        send('gx-warning', { message: error.message });
      }
    }
    attempt();
  }

  function apply(state) {
    latest = state;
    if (!engine) return;
    try {
      var culture = moduleNamed('skycultures');
      var id = 'gx_' + state.group;
      if (!groups.has(id)) {
        culture.addDataSource({ url: location.origin + '/culture/' + id, key: id });
        groups.add(id);
      }
      if (culture.current_id !== id) culture.current_id = id;
      var locKey = JSON.stringify(state.location);
      if (locKey !== appliedLocation ||
          Math.abs(engine.core.latitude - state.location.lat * DEG) > 1e-8 ||
          Math.abs(engine.core.longitude - state.location.lng * DEG) > 1e-8 ||
          Math.abs(engine.core.elevation - state.location.elev) > 0.1) {
        var loc = state.location;
        engine.setLocation(loc.lat * DEG, loc.lng * DEG, loc.elev);
        appliedLocation = locKey;
      }
      var timeKey = JSON.stringify(state.time);
      var milliseconds = state.time.mode === 'realtime' ? Date.now() : Date.parse(state.time.iso);
      var wantedMJD = milliseconds / 86400000 + 40587;
      var tolerance = state.time.mode === 'realtime' ? 2 / 86400 : 0.1 / 86400;
      if (timeKey !== appliedTime || Math.abs(engine.core.utc - wantedMJD) > tolerance) {
        engine.setTime(wantedMJD);
        appliedTime = timeKey;
      }
      engine.core.time_speed = state.time.mode === 'realtime' ? 1 : 0;
      settings(state);
      moveCamera(state);
      if (!readySent && labelRenderer && labelRenderer.ready()) {
        readySent = true;
        send('gx-engine-ready');
      }
    } catch (error) {
      send('gx-warning', { message: error.message });
    }
  }

  window.gxApply = apply;
  window.gxSnapshot = function () {
    if (!engine) return null;
    return {
      az: ((engine.core.yaw / DEG) % 360 + 360) % 360,
      alt: engine.core.pitch / DEG,
      fov: engine.core.fov / DEG
    };
  };
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || event.source !== parent) return;
    if (event.data && event.data.type === 'gx-state') apply(event.data.state);
  });
  document.addEventListener('keydown', function (event) {
    if (/^[0-5pPmMtT]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send('gx-key', { key: event.key.toLowerCase() });
    }
  }, true);

  var timer = setInterval(function () {
    if (!engine && window._stel) {
      engine = window._stel;
      window.gxEngine = engine;
      send('gx-bridge-ready');
    }
    if (engine && !labelRenderer && window.GXLabels) {
      labelRenderer = new window.GXLabels(engine, function () { return latest; });
      window.gxLabels = labelRenderer;
    }
    if (engine && latest) apply(latest);
    if (!engine && Date.now() - start > 45000) {
      send('gx-warning', { message: 'Stellarium 引擎尚未载入，请检查到官方 CDN 的网络连接后刷新页面。' });
      clearInterval(timer);
    }
  }, 500);
}());
