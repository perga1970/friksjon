/* Friksjonsmåler – app-logikk (sensorer, tilstander, UI, logg) */
(function () {
  'use strict';
  const C = window.FrikCore, G = C.G, V = C.vec;
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now() / 1000;
  const fmt = (x, d = 2) => (x == null || !isFinite(x) ? '–' : x.toFixed(d).replace('.', ','));

  // ---------- Lagring ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('frik.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('frik.' + k, JSON.stringify(v)); } catch (e) { /* full eller blokkert */ } },
  };
  const S = {
    settings: Object.assign({ readyKmh: 40, minKmh: 35, slopePct: null, pitch: true, voice: true, weather: true, hook: '', tire: 'Piggdekk' }, store.get('settings', {})),
    cal: store.get('cal', null),
    log: store.get('log', []),
    mbuf: [], gbuf: [], hasGyro: false, sensorsOn: false,
    phase: 'idle', calibrating: null, ev: null, armedUntil: 0, lastResultAt: 0, readySince: 0,
    hb: null, mlp: 0, aboveSince: null, lastT: null, rate: 0, rateCnt: 0, rateT0: 0, wakeLock: null, lastSpokenReady: 0,
  };
  const saveSettings = () => store.set('settings', S.settings);
  const saveLog = () => store.set('log', S.log);

  // ---------- Tale ----------
  function speak(text) {
    if (!S.settings.voice || !('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'nb-NO'; u.rate = 1.0; speechSynthesis.speak(u); } catch (e) { }
  }
  function beep(f = 880, ms = 150) {
    try { const ac = S.ac || (S.ac = new (window.AudioContext || window.webkitAudioContext)()); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; o.connect(g); g.connect(ac.destination); g.gain.value = 0.15; o.start(); o.stop(ac.currentTime + ms / 1000); } catch (e) { }
  }

  // ---------- Skjermlås (hold skjermen våken) ----------
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !S.wakeLock) { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; }); } } catch (e) { }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.sensorsOn) keepAwake(); });

  // ---------- Sensorer ----------
  async function startSensors() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const p = await DeviceMotionEvent.requestPermission();
        if (p !== 'granted') { alert('Tilgang til bevegelsessensorer ble avslått. Gå til Innstillinger > Safari og tillat «Bevegelse og retning», og prøv igjen.'); return; }
      }
    } catch (e) { alert('Kunne ikke be om sensortilgang: ' + e.message); return; }
    if (!window.isSecureContext) alert('Appen må åpnes via https:// for at sensorer og GPS skal virke.');
    window.addEventListener('devicemotion', onMotion);
    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition(onGps, (err) => { $('chipGps').className = 'chip bad'; $('chipGps').textContent = 'GPS: ' + (err.code === 1 ? 'avslått' : 'feil'); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    } else alert('Denne nettleseren støtter ikke GPS.');
    S.sensorsOn = true; S.rateT0 = now();
    keepAwake();
    speak(' '); // låser opp tale på iOS (må skje etter et trykk)
    $('btnStart').textContent = '✓ Sensorer startet'; $('btnStart').disabled = true;
    $('btnCal').disabled = false; $('btnCal2').disabled = !S.cal;
    setTimeout(() => { if (!S.mbuf.length) { $('chipSensor').className = 'chip bad'; $('chipSensor').textContent = 'Ingen sensordata'; } }, 2500);
    setPhase(S.cal ? 'wait' : 'uncal');
  }

  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const t = now();
    const f = [a.x, a.y, a.z];
    const r = e.rotationRate;
    const hasG = !!(r && r.alpha != null && r.beta != null);
    const w = hasG ? [r.beta * Math.PI / 180, r.gamma * Math.PI / 180, r.alpha * Math.PI / 180] : [0, 0, 0];
    if (hasG) S.hasGyro = true;
    const s = { t, f, w, hasGyro: hasG };
    S.mbuf.push(s);
    if (S.mbuf.length > 6000 || (S.mbuf.length % 200 === 0 && t - S.mbuf[0].t > 40)) S.mbuf = S.mbuf.filter((x) => t - x.t <= 40);
    S.rateCnt++;
    if (t - S.rateT0 >= 2) { S.rate = S.rateCnt / (t - S.rateT0); S.rateCnt = 0; S.rateT0 = t; }
    if (S.calibrating) S.calibrating.samples.push(s);
    if (S.cal && !S.calibrating) liveDetect(s);
    S.lastT = t;
  }

  // Sanntidsdeteksjon av oppbremsing (grov – nøyaktig analyse gjøres etterpå)
  function liveDetect(s) {
    const U0 = S.cal.U0, dt = S.lastT ? Math.min(0.1, Math.max(0.001, s.t - S.lastT)) : 0.016;
    const h = V.sub(s.f, V.mul(U0, V.dot(s.f, U0)));
    if (!S.hb) S.hb = h;
    if (!S.ev) S.hb = V.add(S.hb, V.mul(V.sub(h, S.hb), dt / 4));
    const m = V.norm(V.sub(h, S.hb));
    S.mlp += (m - S.mlp) * Math.min(1, dt / 0.1);
    const armed = s.t < S.armedUntil;
    if (!S.ev) {
      if (S.mlp > 0.12 * G && (S.phase === 'ready' || armed)) {
        if (S.aboveSince == null) S.aboveSince = s.t;
        if (s.t - S.aboveSince >= 0.15) {
          S.ev = { onsetT: S.aboveSince, lastAbove: s.t };
          setPhase('measuring'); beep(660, 80);
        }
      } else S.aboveSince = null;
    } else if (S.phase === 'measuring') {
      if (S.mlp > 0.05 * G) S.ev.lastAbove = s.t;
      if (s.t - S.ev.lastAbove > 0.6 || s.t - S.ev.onsetT > 15) {
        const ev = S.ev; setPhase('processing');
        setTimeout(() => processEvent(ev), 1600); // vent på siste GPS-punkter
      }
    }
  }

  function onGps(p) {
    const c = p.coords;
    let t = (p.timestamp - performance.timeOrigin) / 1000;
    if (!isFinite(t) || Math.abs(t - now()) > 5) t = now();
    const fix = { t, lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, speed: c.speed, heading: c.heading, altAcc: c.altitudeAccuracy };
    const prev = S.gbuf[S.gbuf.length - 1];
    if (prev && t - prev.t > 0.3) {
      const d = C.haversine(prev, fix), dtt = t - prev.t;
      if (fix.speed == null || isNaN(fix.speed)) fix.speed = dtt < 4 ? d / dtt : null;
      if ((fix.heading == null || isNaN(fix.heading)) && d > 3) {
        const y = Math.sin((fix.lon - prev.lon) * Math.PI / 180) * Math.cos(fix.lat * Math.PI / 180);
        const x = Math.cos(prev.lat * Math.PI / 180) * Math.sin(fix.lat * Math.PI / 180) - Math.sin(prev.lat * Math.PI / 180) * Math.cos(fix.lat * Math.PI / 180) * Math.cos((fix.lon - prev.lon) * Math.PI / 180);
        fix.heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      }
    }
    if (prev && t <= prev.t) return;
    S.gbuf.push(fix);
    S.gbuf = S.gbuf.filter((g) => t - g.t < 180);
    const chip = $('chipGps');
    chip.textContent = 'GPS ±' + Math.round(c.accuracy) + ' m';
    chip.className = 'chip ' + (c.accuracy <= 15 ? 'ok' : c.accuracy <= 30 ? 'warn' : 'bad');
  }

  // ---------- Klar-indikator ----------
  function readyState() {
    const t = now(), fx = S.gbuf.filter((g) => t - g.t <= 3.5);
    const last = S.gbuf[S.gbuf.length - 1];
    const cur = last && t - last.t < 2.5 ? last.speed : null;
    const res = { ready: false, speedKmh: cur != null ? cur * 3.6 : null, why: '' };
    if (!S.cal) { res.why = 'Kalibrer først'; return res; }
    if (cur == null) { res.why = 'Venter på GPS-fart'; return res; }
    if (fx.length < 2) { res.why = 'Venter på GPS'; return res; }
    const sp = fx.map((g) => g.speed).filter((x) => x != null);
    const minS = Math.min(...sp) * 3.6, maxS = Math.max(...sp) * 3.6;
    if (minS < S.settings.readyKmh) { res.why = 'Kjør opp i minst ' + S.settings.readyKmh + ' km/t på rett vei'; return res; }
    if (maxS - minS > 8) { res.why = 'Hold jevn fart'; return res; }
    const hs = fx.map((g) => g.heading).filter((x) => x != null && isFinite(x));
    if (hs.length >= 2) {
      let maxd = 0;
      for (const h of hs) { const d = Math.abs(((h - hs[0] + 540) % 360) - 180); maxd = Math.max(maxd, d); }
      if (maxd > 8) { res.why = 'Vent til du er på en rett strekning'; return res; }
    }
    res.ready = true; return res;
  }

  // ---------- Tilstander og visning ----------
  function setPhase(p) { S.phase = p; render(); }
  function setStatus(cls, title, big, sub) {
    const el = $('status'); el.className = cls;
    $('stTitle').textContent = title; $('stBig').innerHTML = big; $('stSub').textContent = sub;
  }
  function render() {
    const rs = readyState();
    const sp = rs.speedKmh != null ? Math.round(rs.speedKmh) + '<small> km/t</small>' : '–';
    switch (S.phase) {
      case 'idle': setStatus('st-setup', 'Velkommen', '❄️', 'Trykk «Start sensorer» for å begynne'); break;
      case 'uncal': setStatus('st-setup', 'Steg 1: Kalibrer', '🎯', 'Stå stille på flatt underlag og trykk «Kalibrer»'); break;
      case 'calibrating': setStatus('st-processing', 'Kalibrerer …', '⏳', 'Hold bilen helt i ro'); break;
      case 'wait': setStatus('st-setup', 'Kjøremodus', sp, rs.why); break;
      case 'ready': setStatus('st-ready', 'Klar til bremsetest', sp, 'Sjekk speil og trafikk – brems hardt til ABS slår inn'); break;
      case 'measuring': setStatus('st-measuring', 'Måler …', '⏺', 'Hold bremsen inne i 2–3 sekunder'); break;
      case 'processing': setStatus('st-processing', 'Beregner …', '⚙️', 'Behandler sensordata'); break;
      case 'result': {
        const r = S.lastRes;
        if (!r) break;
        if (r.valid) setStatus('st-' + r.klass.cls, r.klass.label + ' · Godkjent måling', 'μ ' + fmt(r.mu), r.klass.text);
        else setStatus('st-invalid', 'Ugyldig måling', isFinite(r.mu) ? 'μ ' + fmt(r.mu) : '✕', r.reasons[0] || '');
        break;
      }
    }
  }

  // Hovedløkke: oppdater klar-status og sanntidsverdier
  setInterval(() => {
    if (!S.sensorsOn) return;
    const t = now(), rs = readyState();
    if (rs.ready) S.armedUntil = t + 5;
    if (S.phase === 'wait' && rs.ready) {
      setPhase('ready'); beep(990, 120);
      if (t - S.lastSpokenReady > 20) { speak('Klar til bremsetest'); S.lastSpokenReady = t; }
    } else if (S.phase === 'ready' && !rs.ready) setPhase('wait');
    else if (S.phase === 'result') {
      // Gå automatisk tilbake til kjøremodus når bilen igjen holder jevn fart
      if (rs.ready) { if (!S.readySince) S.readySince = t; } else S.readySince = 0;
      if (S.readySince && t - S.readySince > 4 && t - S.lastResultAt > 8) { S.readySince = 0; setPhase('wait'); }
    } else if (S.phase === 'wait' || S.phase === 'ready') render();
    // sanntidsverdier
    $('lvSpeed').textContent = rs.speedKmh != null ? Math.round(rs.speedKmh) + ' km/t' : '–';
    $('lvDec').textContent = S.cal ? fmt(S.mlp / G, 2) + ' g' : '–';
    const last = S.gbuf[S.gbuf.length - 1];
    $('lvAcc').textContent = last ? '±' + Math.round(last.acc) + ' m' : '–';
    $('lvHead').textContent = last && last.heading != null && isFinite(last.heading) ? Math.round(last.heading) + '°' : '–';
    $('lvRate').textContent = S.rate ? Math.round(S.rate) + ' Hz' : '–';
    $('lvGyro').textContent = S.mbuf.length ? (S.hasGyro ? 'Ja' : 'Nei') : '–';
    const cs = $('chipSensor');
    if (S.mbuf.length && t - S.lastT < 1) { cs.className = 'chip ' + (S.rate >= 45 ? 'ok' : 'warn'); cs.textContent = 'Sensor ' + Math.round(S.rate || 0) + ' Hz'; }
  }, 250);

  // ---------- Kalibrering ----------
  function calibrate(second) {
    if (!S.sensorsOn) return;
    if (second && !S.cal) return;
    S.calibrating = { samples: [], second };
    setPhase('calibrating');
    let n = 3;
    $('calInfo').textContent = 'Kalibrerer … ' + n;
    const iv = setInterval(() => { n--; $('calInfo').textContent = n > 0 ? 'Kalibrerer … ' + n : 'Beregner …'; }, 1000);
    setTimeout(() => {
      clearInterval(iv);
      const samples = S.calibrating.samples; S.calibrating = null;
      const c = C.computeCalibration(samples);
      if (!c.ok) { $('calInfo').textContent = '⚠️ ' + c.msg; speak('Kalibrering mislyktes'); setPhase(S.cal ? 'wait' : 'uncal'); return; }
      let cal = c;
      if (second && S.cal) cal = C.combineCalibration(S.cal, c);
      if (!S.hasGyro) cal.hasGyro = false;
      S.cal = cal; store.set('cal', cal); S.hb = null;
      $('btnCal2').disabled = false;
      updateCalInfo();
      speak(second ? 'Kalibrering fullført med snuing' : 'Kalibrering fullført');
      beep(880, 100);
      setPhase('wait');
    }, 3000);
  }
  function updateCalInfo() {
    const c = S.cal;
    if (!c) { $('calInfo').textContent = 'Fest telefonen i en stiv holder. Kalibrer mens bilen står stille på flatt underlag.'; $('chipCal').className = 'chip bad'; $('chipCal').textContent = 'Ikke kal.'; $('calDetail').textContent = 'Ikke kalibrert.'; return; }
    const d = new Date(c.time).toLocaleString('nb-NO');
    const txt = '✓ Kalibrert ' + d + (c.passes === 2 ? ' (med snuing, skråning på stedet ' + fmt(c.siteTiltDeg, 1) + '°)' : ' (én retning)') + '. Kalibrer på nytt hvis telefonen flyttes i holderen.';
    $('calInfo').textContent = txt;
    $('calDetail').textContent = txt + ' Gyroskop: ' + (c.hasGyro ? 'ja' : 'nei') + ', samplerate ' + Math.round(c.rate) + ' Hz.';
    $('chipCal').className = 'chip ok'; $('chipCal').textContent = 'Kalibrert';
  }

  // ---------- Behandling av en bremsetest ----------
  function processEvent(ev, simData) {
    let r, data;
    const opts = { pitchCorr: S.settings.pitch, minSpeedKmh: S.settings.minKmh, manualSlopePct: S.settings.slopePct, sim: !!simData };
    try {
      data = simData || { samples: S.mbuf.slice(), gps: S.gbuf.slice(), cal: S.cal, onsetT: ev.onsetT, endT: ev.lastAbove };
      r = C.processBrake(Object.assign({}, data, { opts }));
    } catch (e) { r = { valid: false, reasons: ['Beregningsfeil: ' + e.message], warnings: [] }; }
    S.ev = null; S.aboveSince = null; S.hb = null;
    S.lastRes = r; S.lastResultAt = now(); S.readySince = 0;
    const fix = C.nearestFix(data.gps || [], r.tRs != null ? r.tRs : data.onsetT);
    const rec = {
      id: Date.now(), time: new Date().toISOString(), sim: !!simData, tire: S.settings.tire,
      lat: fix ? fix.lat : null, lon: fix ? fix.lon : null, alt: fix ? fix.alt : null, gpsAcc: fix ? fix.acc : null,
      mu: r.mu, muCtrl: r.muCtrl, aBrems: r.aBrems, v0Kmh: r.v0Kmh, v1Kmh: r.v1Kmh, slopePct: r.slopePct, slopeSrc: r.slopeSrc,
      slopeGpsPct: r.tRs != null ? C.gpsSlope(data.gps || [], r.tRs, 20) : null,
      sAcc: r.sAcc, sGps: r.sGps, s50: r.s50, plateauS: r.plateauS, riseS: r.riseS, cv: r.cv, absRatio: r.absRatio,
      pitchDeg: r.pitchDeg, yawDeg: r.yawDeg, valid: r.valid, cls: r.valid && r.klass ? r.klass.cls : 'invalid',
      status: r.valid ? 'Godkjent måling' : 'Ugyldig: ' + (r.reasons[0] || ''), reasons: r.reasons, warnings: r.warnings,
      calPasses: S.cal ? S.cal.passes : null, weather: null, synced: false,
    };
    S.log.unshift(rec); saveLog();
    setPhase('result');
    showResult(r, rec);
    // tale
    if (r.valid) speak('Friksjon ' + fmt(r.mu) + '. ' + r.klass.label + '. ' + (r.klass.cls === 'green' ? 'Godkjent.' : r.klass.cls === 'yellow' ? 'Glatt føre.' : 'Svært glatt føre.'));
    else speak('Ugyldig måling. ' + (r.reasons[0] || ''));
    if ('vibrate' in navigator) navigator.vibrate(r.valid ? [80, 60, 80] : [300]);
    // vær og synk
    (async () => {
      if (S.settings.weather && rec.lat != null && !rec.sim) { rec.weather = await fetchWeather(rec.lat, rec.lon); saveLog(); renderLog(); }
      await syncOne(rec);
    })();
    renderLog();
  }

  function showResult(r, rec) {
    $('resultCard').classList.remove('hide');
    const msgs = [];
    msgs.push(r.valid ? '<div class="msg ok">✓ Godkjent måling' + (rec.sim ? ' (simulert)' : '') + '</div>' : r.reasons.map((x) => '<div class="msg err">✕ Ugyldig: ' + x + '</div>').join(''));
    (r.warnings || []).forEach((w) => msgs.push('<div class="msg warn">⚠ ' + w + '</div>'));
    $('resMsgs').innerHTML = msgs.join('');
    const rows = [
      ['Friksjonskoeffisient μ (akselerometer)', fmt(r.mu)],
      ['μ kontroll (GPS fart/strekning)', fmt(r.muCtrl)],
      ['Klassifisering', r.klass ? r.klass.label : '–'],
      ['Retardasjon a<sub>brems</sub>', r.aBrems != null ? fmt(r.aBrems, 2) + ' m/s²' : '–'],
      ['Utgangsfart', r.v0Kmh != null ? fmt(r.v0Kmh, 0) + ' km/t' : '–'],
      ['Sluttfart', r.v1Kmh != null ? fmt(r.v1Kmh, 0) + ' km/t' : '–'],
      ['Strekning under bremsing (målt)', r.sAcc != null ? fmt(r.sAcc, 1) + ' m' : '–'],
      ['Ekv. bremsestrekning fra 50 km/t', r.s50 != null ? fmt(r.s50, 1) + ' m' : '–'],
      ['Stigning (' + (r.slopeSrc || '–') + ')', r.slopePct != null ? fmt(r.slopePct, 1) + ' %' : '–'],
      ['Stigning (GPS-høyde)', rec.slopeGpsPct != null ? fmt(rec.slopeGpsPct, 1) + ' %' : '–'],
      ['Stabil bremsefase', r.plateauS != null ? fmt(r.plateauS, 1) + ' s' : '–'],
      ['Innbremsingstid', r.riseS != null ? fmt(r.riseS, 2) + ' s' : '–'],
      ['ABS-indikasjon', r.absRatio != null ? (r.absRatio >= 2 ? 'Tydelig' : r.absRatio >= 1.3 ? 'Svak' : 'Ikke påvist') + ' (' + fmt(r.absRatio, 1) + ')' : '–'],
      ['Nikk (pitch) korrigert', r.pitchDeg != null ? fmt(r.pitchDeg, 1) + '°' : '–'],
      ['Dekktype', rec.tire],
    ];
    $('resTable').innerHTML = rows.map((x) => '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td></tr>').join('');
    drawPlot(r);
  }

  function drawPlot(r) {
    const cv = $('plot'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!r.series || !r.series.length) return;
    const xs = r.series.map((p) => p[0]), x0 = Math.min(...xs), x1 = Math.max(...xs);
    const ymax = Math.max(0.35, ...r.series.map((p) => p[1])) * 1.1, ymin = Math.min(-0.05, ...r.series.map((p) => p[1]));
    const L = 50, B = 30, T = 10, Rr = 10;
    const X = (x) => L + (x - x0) / (x1 - x0 || 1) * (W - L - Rr), Y = (y) => T + (ymax - y) / (ymax - ymin) * (H - T - B);
    ctx.fillStyle = 'rgba(74,163,255,.18)';
    if (r.plateau) ctx.fillRect(X(r.plateau[0]), T, X(r.plateau[1]) - X(r.plateau[0]), H - T - B);
    ctx.strokeStyle = '#334'; ctx.fillStyle = '#93a4b5'; ctx.font = '20px sans-serif'; ctx.lineWidth = 1;
    for (let y = 0; y <= ymax; y += 0.1) { ctx.beginPath(); ctx.moveTo(L, Y(y)); ctx.lineTo(W - Rr, Y(y)); ctx.stroke(); ctx.fillText(y.toFixed(1), 4, Y(y) + 6); }
    for (let x = Math.ceil(x0); x <= x1; x++) ctx.fillText(x + ' s', X(x) - 10, H - 6);
    ctx.setLineDash([8, 6]);
    [[0.25, '#1f9d55'], [0.20, '#e0b400']].forEach(([y, c]) => { ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(L, Y(y)); ctx.lineTo(W - Rr, Y(y)); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.strokeStyle = '#e8eef4'; ctx.lineWidth = 3; ctx.beginPath();
    r.series.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.stroke();
  }

  // ---------- Vær (MET Norge) ----------
  async function fetchWeather(lat, lon) {
    const la = lat.toFixed(4), lo = lon.toFixed(4);
    try {
      const r = await fetch('https://api.met.no/weatherapi/nowcast/2.0/complete?lat=' + la + '&lon=' + lo);
      if (r.ok) { const j = await r.json(); const d = j.properties.timeseries[0].data; return { src: 'MET nowcast', temp: d.instant.details.air_temperature, precip: d.instant.details.precipitation_rate, wind: d.instant.details.wind_speed, symbol: d.next_1_hours && d.next_1_hours.summary.symbol_code }; }
    } catch (e) { }
    try {
      const r = await fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + la + '&lon=' + lo);
      if (r.ok) { const j = await r.json(); const d = j.properties.timeseries[0].data; return { src: 'MET locationforecast', temp: d.instant.details.air_temperature, precip: d.next_1_hours ? d.next_1_hours.details.precipitation_amount : null, wind: d.instant.details.wind_speed, symbol: d.next_1_hours && d.next_1_hours.summary.symbol_code }; }
    } catch (e) { }
    return null;
  }

  // ---------- Synkronisering ----------
  async function syncOne(rec) {
    const url = (S.settings.hook || '').trim();
    if (!url || rec.synced) return false;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
      if (r.ok || r.type === 'opaque') { rec.synced = true; saveLog(); renderLog(); return true; }
    } catch (e) { }
    return false;
  }
  async function syncAll() {
    if (!(S.settings.hook || '').trim()) { alert('Legg inn en webhook-URL under Innstillinger først.'); return; }
    let n = 0; for (const rec of S.log) if (!rec.synced && await syncOne(rec)) n++;
    alert(n + ' måling(er) synkronisert. ' + S.log.filter((x) => !x.synced).length + ' gjenstår.');
  }
  window.addEventListener('online', () => { if (S.settings.hook) S.log.forEach((r) => syncOne(r)); });

  // ---------- Logg ----------
  function renderLog() {
    const list = $('logList');
    if (!S.log.length) { list.innerHTML = '<p class="mut">Ingen målinger ennå.</p>'; $('logSummary').textContent = ''; return; }
    const valid = S.log.filter((r) => r.valid && !r.sim);
    $('logSummary').textContent = S.log.length + ' målinger, ' + valid.length + ' godkjente (ekskl. simulerte).' + (S.settings.hook ? ' Usynkronisert: ' + S.log.filter((r) => !r.synced).length : '');
    list.innerHTML = S.log.slice(0, 300).map((r) => {
      const d = new Date(r.time).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
      const map = r.lat != null ? ' · <a href="https://www.openstreetmap.org/?mlat=' + r.lat + '&mlon=' + r.lon + '#map=16/' + r.lat + '/' + r.lon + '" target="_blank" rel="noopener">kart</a>' : '';
      const w = r.weather && r.weather.temp != null ? ' · ' + fmt(r.weather.temp, 1) + ' °C' : '';
      return '<div class="logitem"><div class="dot ' + r.cls + '">' + (isFinite(r.mu) && r.mu != null ? fmt(r.mu) : '✕') + '</div><div class="info"><b>' + d + (r.sim ? ' · SIM' : '') + '</b><br>' + r.status + '<br>' +
        (r.v0Kmh != null ? fmt(r.v0Kmh, 0) + ' km/t' : '') + (r.slopePct != null ? ' · stigning ' + fmt(r.slopePct, 1) + ' %' : '') + ' · ' + r.tire + w + map + (r.synced ? ' · ☁' : '') + '</div></div>';
    }).join('');
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const file = typeof File !== 'undefined' ? new File([blob], name, { type }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => { }); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const cols = ['time', 'lat', 'lon', 'alt', 'gpsAcc', 'tire', 'mu', 'muCtrl', 'cls', 'valid', 'status', 'v0Kmh', 'v1Kmh', 'aBrems', 'slopePct', 'slopeSrc', 'slopeGpsPct', 'sAcc', 's50', 'plateauS', 'riseS', 'absRatio', 'pitchDeg', 'sim'];
  function exportCsv() {
    const num = (v) => (typeof v === 'number' ? String(+v.toFixed(6)).replace('.', ',') : v == null ? '' : String(v).replace(/[;\n]/g, ','));
    const head = [...cols, 'lufttemp', 'nedbor', 'advarsler'].join(';');
    const lines = S.log.map((r) => [...cols.map((c) => num(r[c])), num(r.weather && r.weather.temp), num(r.weather && r.weather.precip), num((r.warnings || []).join(' | '))].join(';'));
    download('friksjonsmalinger_' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + head + '\n' + lines.join('\n'), 'text/csv');
  }
  function exportGeo() {
    const fc = { type: 'FeatureCollection', features: S.log.filter((r) => r.lat != null).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: Object.assign({}, ...cols.map((c) => ({ [c]: r[c] })), { weather: r.weather, warnings: r.warnings }) })) };
    download('friksjonsmalinger_' + new Date().toISOString().slice(0, 10) + '.geojson', JSON.stringify(fc, null, 1), 'application/geo+json');
  }

  // ---------- Simulering ----------
  function runSim() {
    const p = { mu: parseFloat($('simMu').value) || 0.22, slopePct: parseFloat($('simSlope').value) || 0, v0Kmh: parseFloat($('simV').value) || 60, seed: Math.floor(Math.random() * 1e6), gyroFlip: Math.random() < 0.5, mount: [Math.random() * 6, -1.4 + Math.random(), Math.random() - 0.5] };
    const sim = C.simulate(p);
    const savedCal = S.cal;
    S.lastRes = null;
    showView('v-measure');
    setPhase('processing');
    setTimeout(() => { processEvent(null, sim); S.cal = savedCal; }, 600);
  }

  // ---------- Navigasjon og innstillinger ----------
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.v === id));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.v)));

  function bindSettings() {
    const s = S.settings;
    $('tire').value = s.tire; $('setReady').value = s.readyKmh; $('setMin').value = s.minKmh;
    $('setSlope').value = s.slopePct != null ? s.slopePct : ''; $('setPitch').checked = s.pitch; $('setVoice').checked = s.voice;
    $('setWeather').checked = s.weather; $('setHook').value = s.hook;
    $('tire').onchange = () => { s.tire = $('tire').value; saveSettings(); };
    $('setReady').onchange = () => { s.readyKmh = Math.max(20, +$('setReady').value || 40); saveSettings(); };
    $('setMin').onchange = () => { s.minKmh = Math.max(15, +$('setMin').value || 35); saveSettings(); };
    $('setSlope').onchange = () => { const v = $('setSlope').value.trim().replace(',', '.'); s.slopePct = v === '' ? null : parseFloat(v); saveSettings(); };
    $('setPitch').onchange = () => { s.pitch = $('setPitch').checked; saveSettings(); };
    $('setVoice').onchange = () => { s.voice = $('setVoice').checked; saveSettings(); };
    $('setWeather').onchange = () => { s.weather = $('setWeather').checked; saveSettings(); };
    $('setHook').onchange = () => { s.hook = $('setHook').value.trim(); saveSettings(); renderLog(); };
  }

  $('btnStart').onclick = startSensors;
  $('btnCal').onclick = () => calibrate(false);
  $('btnCal2').onclick = () => { alert('Snu bilen 180° på samme sted, stå helt stille og trykk OK.'); calibrate(true); };
  $('btnNew').onclick = () => { $('resultCard').classList.add('hide'); setPhase(S.sensorsOn ? (S.cal ? 'wait' : 'uncal') : 'idle'); };
  $('status').onclick = () => { if (S.phase === 'result') $('btnNew').onclick(); };
  $('btnCsv').onclick = exportCsv; $('btnGeo').onclick = exportGeo; $('btnSync').onclick = syncAll;
  $('btnClear').onclick = () => { if (confirm('Slette alle målinger i loggen? Dette kan ikke angres.')) { S.log = []; saveLog(); renderLog(); } };
  $('btnResetCal').onclick = () => { if (confirm('Nullstille kalibreringen?')) { S.cal = null; store.set('cal', null); updateCalInfo(); if (S.sensorsOn) setPhase('uncal'); } };
  $('btnSim').onclick = runSim;

  bindSettings(); updateCalInfo(); renderLog(); render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
