/* Friksjonsmåler – beregningskjerne
 * Ren matematikk uten DOM-avhengigheter, slik at den kan testes separat.
 * Koordinater: telefonens egne akser (W3C DeviceMotion). Alle vektorer [x,y,z].
 */
(function (root) {
  'use strict';
  const G = 9.81;

  // ---------- Vektorhjelpere ----------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => Math.sqrt(dot(a, a));
  const unit = (a) => { const n = norm(a) || 1; return mul(a, 1 / n); };
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
  const meanVec = (list) => { let s = [0, 0, 0]; for (const v of list) s = add(s, v); return mul(s, 1 / (list.length || 1)); };
  const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map((x) => (x - m) ** 2))); };
  const rms = (arr) => Math.sqrt(mean(arr.map((x) => x * x)));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function quantile(arr, q) {
    const s = [...arr].sort((a, b) => a - b);
    if (!s.length) return NaN;
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }
  function trimmedMean(arr, p) {
    const s = [...arr].sort((a, b) => a - b);
    const k = Math.floor(s.length * p);
    const t = s.slice(k, s.length - k);
    return mean(t.length ? t : s);
  }

  // ---------- Signalbehandling ----------
  // Lineær resampling av ujevnt samplede sensordata til fast rate
  function resample(samples, fs) {
    const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
    const n = Math.floor((t1 - t0) * fs) + 1;
    const T = new Array(n), F = new Array(n), W = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / fs;
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[Math.min(j + 1, samples.length - 1)];
      const u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
      T[i] = t;
      F[i] = add(mul(a.f, 1 - u), mul(b.f, u));
      W[i] = add(mul(a.w, 1 - u), mul(b.w, u));
    }
    return { t: T, f: F, w: W };
  }

  // 2. ordens Butterworth lavpass (RBJ biquad)
  function biquadLP(fc, fs) {
    const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), s = Math.sin(w0), Q = Math.SQRT1_2;
    const al = s / (2 * Q), a0 = 1 + al;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  function filt(c, x) {
    const y = new Array(x.length);
    let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
    for (let i = 0; i < x.length; i++) {
      const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  // Nullfase-filtrering (forover + bakover) med kantutfylling
  function filtfilt(c, x, pad) {
    pad = pad || 100;
    const p = [...new Array(pad).fill(x[0]), ...x, ...new Array(pad).fill(x[x.length - 1])];
    const y = filt(c, filt(c, p).reverse()).reverse();
    return y.slice(pad, pad + x.length);
  }

  // ---------- Kalibrering ----------
  function computeCalibration(samples) {
    if (samples.length < 30) return { ok: false, msg: 'For få sensordata – prøv igjen.' };
    const mags = samples.map((s) => norm(s.f));
    const sd = std(mags), m = mean(mags);
    if (sd > 0.35) return { ok: false, msg: 'For mye bevegelse eller vibrasjon under kalibreringen. Stå stille (eller trill helt jevnt) og prøv igjen.' };
    if (Math.abs(m - G) > 0.8) return { ok: false, msg: 'Uventet tyngdeakselerasjon (' + m.toFixed(2) + ' m/s²). Sjekk at telefonen har akselerometer.' };
    const U0 = unit(meanVec(samples.map((s) => s.f)));
    const hasGyro = samples.some((s) => s.hasGyro);
    const gyroBias = hasGyro ? meanVec(samples.map((s) => s.w)) : [0, 0, 0];
    const dur = samples[samples.length - 1].t - samples[0].t;
    return { ok: true, U0, Ua: U0, gyroBias, hasGyro, rate: (samples.length - 1) / dur, time: Date.now(), passes: 1, noise: sd };
  }
  // Snu-kalibrering: snitt av to målinger med bilen snudd 180° fjerner feil fra skrå oppstillingsplass
  function combineCalibration(a, b) {
    const ang = Math.acos(clamp(dot(a.Ua, b.U0), -1, 1));
    return Object.assign({}, b, {
      U0: unit(add(a.Ua, b.U0)), Ua: a.Ua, passes: 2,
      gyroBias: mul(add(a.gyroBias, b.gyroBias), 0.5),
      siteTiltDeg: ang / 2 * 180 / Math.PI,
    });
  }

  // ---------- GPS-hjelpere ----------
  function speedAt(gps, t) {
    if (!gps.length) return null;
    if (t <= gps[0].t) return gps[0].t - t < 1.5 && gps[0].speed != null ? gps[0].speed : null;
    const last = gps[gps.length - 1];
    if (t >= last.t) return t - last.t < 1.5 && last.speed != null ? last.speed : null;
    for (let i = 0; i < gps.length - 1; i++) {
      const a = gps[i], b = gps[i + 1];
      if (t >= a.t && t <= b.t) {
        if (a.speed == null || b.speed == null) return null;
        if (b.t - a.t > 3) return null;
        const u = (t - a.t) / (b.t - a.t || 1);
        return a.speed * (1 - u) + b.speed * u;
      }
    }
    return null;
  }
  function nearestFix(gps, t) {
    let best = null, bd = Infinity;
    for (const g of gps) { const d = Math.abs(g.t - t); if (d < bd) { bd = d; best = g; } }
    return bd < 5 ? best : null;
  }
  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Stigning fra GPS-høyde (lineær regresjon høyde mot tilbakelagt distanse). Positiv = oppover.
  function gpsSlope(gps, tEnd, lookback) {
    const fx = gps.filter((g) => g.t <= tEnd && g.t >= tEnd - (lookback || 20) && g.alt != null);
    if (fx.length < 5) return null;
    let d = 0; const X = [0], Y = [fx[0].alt];
    for (let i = 1; i < fx.length; i++) { d += haversine(fx[i - 1], fx[i]); X.push(d); Y.push(fx[i].alt); }
    if (d < 80) return null;
    const mx = mean(X), my = mean(Y);
    let num = 0, den = 0;
    for (let i = 0; i < X.length; i++) { num += (X[i] - mx) * (Y[i] - my); den += (X[i] - mx) ** 2; }
    return den > 0 ? (num / den) * 100 : null;
  }

  // ---------- Klassifisering ----------
  function classify(mu) {
    if (mu >= 0.25) return { cls: 'green', label: 'Grønn', text: 'Tilfredsstiller normalt krav til vinterfriksjon' };
    if (mu >= 0.20) return { cls: 'yellow', label: 'Gul', text: 'Glatt føre – under normalt kontraktskrav. Vurder strøing/salting' };
    return { cls: 'red', label: 'Rød', text: 'Svært glatt føre – kritisk lav friksjon. Tiltak bør prioriteres umiddelbart' };
  }
  const stopDist = (vKmh, mu) => (vKmh / 3.6) ** 2 / (2 * G * mu);

  // ---------- Segmentering av bremsekurven ----------
  function segment(alp, base, evS, evE, fs) {
    const d = alp.map((x) => x - base);
    const p90 = quantile(d.slice(evS, evE + 1), 0.9);
    let on = -1;
    for (let k = evS; k <= evE; k++) if (d[k] >= 0.5 * p90) { on = k; break; }
    if (on < 0) return null;
    let end = on;
    for (let k = evE; k >= on; k--) if (d[k] >= 0.5 * p90) { end = k; break; }
    let rs = on; while (rs > 0 && d[rs] > 0.1 * p90) rs--;
    let r80 = on; while (r80 < end && d[r80] < 0.8 * p90) r80++;
    return { p90, on, end, rs, r80, riseTime: (r80 - rs) / fs };
  }

  // Integrer en kroppsfast vektor gjennom gyroskopets rotasjon: dv/dt = -ω × v
  function integrateFrames(W, U0, rear, i0, sign, dt) {
    const N = W.length, Nn = new Array(N), Rr = new Array(N);
    let n = U0.slice(), r = unit(sub(rear, mul(U0, dot(rear, U0))));
    for (let k = 0; k < N; k++) {
      if (k > i0) {
        const w = mul(W[k - 1], sign);
        n = unit(sub(n, mul(cross(w, n), dt)));
        r = sub(r, mul(cross(w, r), dt));
        r = unit(sub(r, mul(n, dot(r, n))));
      }
      Nn[k] = n; Rr[k] = r;
    }
    return { Nn, Rr };
  }

  // ---------- Hovedberegning av en bremsetest ----------
  function processBrake(inp) {
    const o = Object.assign({ pitchCorr: true, minSpeedKmh: 35, manualSlopePct: null, sim: false }, inp.opts || {});
    const { gps, cal, onsetT, endT } = inp;
    const res = { valid: false, reasons: [], warnings: [], diag: {} };
    const fs = 100, dt = 1 / fs;
    const win = inp.samples.filter((s) => s.t >= onsetT - 3 && s.t <= endT + 1);
    if (win.length < 60) { res.reasons.push('For få sensordata i måleperioden'); return res; }
    const R = resample(win, fs), N = R.t.length;
    const idxOf = (t) => clamp(Math.round((t - R.t[0]) * fs), 0, N - 1);
    const U0 = cal.U0, bias = cal.gyroBias || [0, 0, 0];
    const W = R.w.map((w) => sub(w, bias));
    const lp = biquadLP(5, fs); // avskjæring 5 Hz
    const evS = idxOf(onsetT - 0.5), evE = idxOf(endT + 0.5);

    // Pass 1: uten pitch-korreksjon – finn bremseretning i bilens plan
    const H0 = R.f.map((f) => sub(f, mul(U0, dot(f, U0))));
    let preE = idxOf(onsetT - 0.4);
    if (preE < fs * 0.5) res.warnings.push('Kort registrering før bremsing – helning er usikker');
    preE = Math.max(preE, 10);
    const basePre = meanVec(H0.slice(0, preE));
    const dmag = filtfilt(lp, H0.map((h) => norm(sub(h, basePre))));
    const p90m = quantile(dmag.slice(evS, evE + 1), 0.9);
    if (!(p90m > 0.05 * G)) { res.reasons.push('Ingen tydelig oppbremsing registrert'); return res; }
    const strong = [];
    for (let k = evS; k <= evE; k++) if (dmag[k] > 0.6 * p90m) strong.push(H0[k]);
    const rear = unit(sub(meanVec(strong), basePre)); // bakover-retning i bilens lengdeakse
    const a1 = filtfilt(lp, H0.map((h) => dot(h, rear)));
    const seg1 = segment(a1, mean(a1.slice(0, preE)), evS, evE, fs);
    if (!seg1) { res.reasons.push('Fant ikke bremsefasen i signalet'); return res; }

    // Pass 2: pitch-korreksjon med gyroskop (bilens nikk ved oppbremsing)
    const i0 = Math.max(0, seg1.rs - Math.round(0.2 * fs));
    let frames = null, gyroSign = 1, pitchDeg = 0, pitchUsed = false;
    if (o.pitchCorr && cal.hasGyro) {
      const diveOf = (fr) => mean(fr.Rr.slice(seg1.r80, seg1.end + 1).map((r) => dot(r, U0)));
      frames = integrateFrames(W, U0, rear, i0, 1, dt);
      let dive = diveOf(frames);
      // Fysisk kontroll: bilen dykker alltid med fronten ned ved bremsing. Gir +1 «nese opp», er fortegnet speilvendt.
      if (dive > 0.003) { gyroSign = -1; frames = integrateFrames(W, U0, rear, i0, -1, dt); dive = diveOf(frames); }
      pitchDeg = Math.asin(clamp(-dive, -1, 1)) * 180 / Math.PI;
      if (Math.abs(pitchDeg) > 8) {
        res.warnings.push('Urimelig stor nikkvinkel fra gyroskop – pitch-korreksjon slått av for denne målingen');
        frames = null; pitchDeg = 0;
      } else pitchUsed = true;
    }
    if (!frames) {
      const r0 = unit(sub(rear, mul(U0, dot(rear, U0))));
      frames = { Nn: new Array(N).fill(U0), Rr: new Array(N).fill(r0) };
    }
    const along = R.f.map((f, k) => dot(f, frames.Rr[k]));
    const lat = R.f.map((f, k) => dot(f, cross(frames.Nn[k], frames.Rr[k])));
    const alp = filtfilt(lp, along), latlp = filtfilt(lp, lat);
    const preE2 = Math.max(10, Math.min(preE, seg1.rs - Math.round(0.3 * fs)));
    const baseAlong = mean(alp.slice(0, preE2));
    const sg = segment(alp, baseAlong, evS, evE, fs);
    if (!sg) { res.reasons.push('Fant ikke bremsefasen i signalet'); return res; }

    // Stabilt platå: etter at demperne har satt seg, før «rykk-stoppet»
    const ps = sg.rs + Math.round(Math.max(0.7, sg.riseTime + 0.3) * fs);
    const pe = sg.end - Math.round(0.4 * fs);
    const plateauS = (pe - ps) / fs;
    const plat = pe > ps ? alp.slice(ps, pe + 1) : [];
    const aAlong = plat.length ? trimmedMean(plat, 0.1) : NaN;
    const cv = plat.length ? std(plat) / Math.abs(aAlong) : NaN;

    // Helning. sinθ > 0 betyr nedoverbakke (fall). Akselerometermetoden måler friksjonskraften direkte i veiplanet.
    let sinT, slopeSrc;
    if (o.manualSlopePct != null && isFinite(o.manualSlopePct)) { sinT = -Math.sin(Math.atan(o.manualSlopePct / 100)); slopeSrc = 'manuell'; }
    else { sinT = clamp(baseAlong / G, -0.2, 0.2); slopeSrc = 'akselerometer'; }
    const cosT = Math.sqrt(1 - sinT * sinT), tanT = sinT / cosT;
    const aBrems = aAlong - G * sinT; // kinematisk retardasjon langs veien
    const mu = (aBrems + G * sinT) / (G * cosT); // = a/g ± tanθ (eksakt form)

    // ABS-indikasjon: høyfrekvent energi i bremsefasen sammenlignet med før bremsing
    const hf = along.map((x, k) => x - alp[k]);
    const absRatio = plat.length ? rms(hf.slice(ps, pe + 1)) / Math.max(rms(hf.slice(0, preE2)), 0.05) : NaN;
    // Svingbevegelse og sidekrefter
    let yaw = 0;
    if (cal.hasGyro) for (let k = sg.rs; k <= sg.end; k++) yaw += dot(W[k], frames.Nn[k]) * dt;
    const yawDeg = Math.abs(yaw) * 180 / Math.PI;
    const latPre = mean(latlp.slice(0, preE2));
    const latG = plat.length ? mean(latlp.slice(ps, pe + 1).map((x) => Math.abs(x - latPre))) / G : 0;

    // GPS: utgangsfart og kontrollmetoden
    const tRs = R.t[sg.rs], tEnd = R.t[sg.end];
    const v0 = speedAt(gps, tRs), v1 = speedAt(gps, tEnd);
    let sGps = null, muCtrl = null;
    if (v0 != null && v1 != null) {
      let s = 0, okInt = true;
      for (let t = tRs; t < tEnd; t += 0.05) { const v = speedAt(gps, t); if (v == null) { okInt = false; break; } s += v * 0.05; }
      if (okInt && s > 3) { sGps = s; muCtrl = ((v0 * v0 - v1 * v1) / (2 * s) + G * sinT) / (G * cosT); }
    }
    // Bedre kontroll når flere GPS-fartsmålinger ligger inne i selve bremsefasen: helning av v(t)
    const inFix = gps.filter((g) => g.speed != null && g.t >= R.t[Math.min(ps, sg.end)] - 0.2 && g.t <= tEnd && g.speed > 0.5);
    if (inFix.length >= 2) {
      const mt = mean(inFix.map((g) => g.t)), mv = mean(inFix.map((g) => g.speed));
      let num = 0, den = 0;
      for (const g of inFix) { num += (g.t - mt) * (g.speed - mv); den += (g.t - mt) ** 2; }
      if (den > 0.5) muCtrl = (-num / den + G * sinT) / (G * cosT);
    }
    // Bremsestrekning fra akselerometer (integrert fra GPS-startfart)
    let sAcc = null, v1Acc = null;
    if (v0 != null) {
      let v = v0, s = 0;
      for (let k = sg.rs; k <= sg.end; k++) { const a = alp[k] - G * sinT; v = Math.max(0, v - a * dt); s += v * dt; }
      sAcc = s; v1Acc = v;
    }

    // ---------- Gyldighetskontroll ----------
    const v0k = v0 != null ? v0 * 3.6 : null;
    if (v0k == null && !o.sim) res.reasons.push('Mangler GPS-hastighet ved bremsestart');
    if (v0k != null && v0k < o.minSpeedKmh) res.reasons.push('For lav utgangshastighet (' + v0k.toFixed(0) + ' km/t < ' + o.minSpeedKmh + ' km/t)');
    if (!(plateauS >= 0.8)) res.reasons.push('For kort bremsing – stabil bremsefase under 0,8 s');
    if (sg.riseTime > 1.5) res.reasons.push('For svak bremsing – bremsen ble trykket inn for sakte');
    if (yawDeg > 6 || latG > 0.1) res.reasons.push('Sving eller sideskrens under bremsing');
    if (cv > 0.4) res.reasons.push('Ustabilt bremseforløp');
    if (isFinite(mu) && (mu < 0.05 || mu > 1.2)) res.reasons.push('Urealistisk verdi – sjekk montering og kalibrering');
    if (sg.riseTime > 0.8 && sg.riseTime <= 1.5) res.warnings.push('Bremsen ble trykket inn litt sakte – μ kan være underestimert');
    if (plateauS >= 0.8 && plateauS < 1.2) res.warnings.push('Kort stabil bremsefase – brems gjerne i 2–3 s');
    if (isFinite(absRatio) && absRatio < 1.3) res.warnings.push('ABS-vibrasjon ikke tydelig påvist – var bremsingen hard nok?');
    if (muCtrl != null && Math.abs(muCtrl - mu) > 0.08) res.warnings.push('Avvik mellom akselerometer og GPS-kontroll (' + muCtrl.toFixed(2) + ')');
    if (cv > 0.25 && cv <= 0.4) res.warnings.push('Noe ujevnt bremseforløp');
    if (!pitchUsed && o.pitchCorr && !cal.hasGyro) res.warnings.push('Gyroskop ikke tilgjengelig – uten pitch-korreksjon');

    res.valid = res.reasons.length === 0;
    Object.assign(res, {
      mu, muCtrl, aBrems, aAlong, v0Kmh: v0k, v1Kmh: v1 != null ? v1 * 3.6 : null, v1AccKmh: v1Acc != null ? v1Acc * 3.6 : null,
      sGps, sAcc, slopePct: -tanT * 100, slopeSrc, s50: isFinite(mu) && mu > 0 ? stopDist(50, mu) : null,
      plateauS, riseS: sg.riseTime, cv, absRatio, pitchDeg, yawDeg, latG, tRs, tEnd,
      klass: isFinite(mu) ? classify(mu) : null,
    });
    res.diag = { gyroSign, pitchUsed, samples: win.length, rateHz: (win.length - 1) / (win[win.length - 1].t - win[0].t) };
    const series = [];
    for (let k = Math.max(0, sg.rs - fs); k <= Math.min(N - 1, sg.end + fs); k += 2) series.push([R.t[k] - tRs, alp[k] / G]);
    res.series = series;
    res.plateau = [R.t[ps] - tRs, R.t[pe] - tRs];
    return res;
  }

  // ---------- Simulator (for demo og testing uten bil) ----------
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function rotMat(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    return [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr], [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr], [-sp, cp * sr, cp * cr]];
  }
  const mT = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];

  function simulate(p) {
    p = Object.assign({ mu: 0.22, slopePct: 0, v0Kmh: 60, brakeDur: 3, mount: [0.4, -1.2, 0.25], seed: 1, gyroFlip: false }, p || {});
    const R = rng(p.seed);
    const randn = () => { const u = R() || 1e-9, v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const M = rotMat(p.mount[0], p.mount[1], p.mount[2]);
    const bias = [0.004, -0.003, 0.002];
    const gs = p.gyroFlip ? -1 : 1;
    const sth = Math.sin(-Math.atan(p.slopePct / 100)), cth = Math.cos(Math.atan(p.slopePct / 100));
    const aB = p.mu * G * cth - G * sth;
    // Kalibrering: står stille på flat plass
    const calS = [];
    for (let t = 0; t < 2.5; t += 1 / 60) {
      const fb = [randn() * 0.05, randn() * 0.05, G + randn() * 0.05];
      calS.push({ t, f: mT(M, fb), w: add(bias, [randn() * 0.002, randn() * 0.002, randn() * 0.002]), hasGyro: true });
    }
    const cal = computeCalibration(calS);
    // Kjøring + bremsing
    const samples = [], gpsFix = [];
    const tb = 6, T = tb + p.brakeDur + 4;
    let v = p.v0Kmh / 3.6, dist = 0, phi = 0, dphi = 0, t = 0, braking = false, stopped = false, tRel = null, endT = null, lastGps = -1;
    const hd = 30 * Math.PI / 180, lat0 = 60.39, lon0 = 5.32;
    while (t < T) {
      const dt = 1 / 60 + (R() - 0.5) * 0.004;
      let a = 0;
      if (t >= tb && !stopped && tRel == null) {
        braking = true;
        a = aB * Math.min(1, (t - tb) / 0.25);
        if (t > tb + p.brakeDur) { tRel = t; endT = t; }
      }
      if (tRel != null && !stopped) { a = aB * Math.max(0, 1 - (t - tRel) / 0.3); braking = a > 0; }
      if (braking && !stopped && v - a * dt <= 0) { v = 0; stopped = true; braking = false; endT = t; a = 0; }
      if (stopped) a = 0;
      v = Math.max(0, v - a * dt); dist += v * dt;
      const phiT = 0.087 * a / G, w0 = 2 * Math.PI * 1.2;
      dphi += (w0 * w0 * (phiT - phi) - 2 * 0.5 * w0 * dphi) * dt; phi += dphi * dt;
      const absOsc = braking && a > 0.5 * aB ? 0.06 * G * Math.sin(2 * Math.PI * 7 * t) : 0;
      const fr = [-(a + absOsc + G * sth), 0, G * cth];
      const c = Math.cos(phi), s = Math.sin(phi);
      let fb = [fr[0] * c - fr[2] * s, fr[1], fr[0] * s + fr[2] * c];
      const vib = v > 0.5 ? 0.3 * Math.sin(2 * Math.PI * 22 * t) : 0;
      fb = add(fb, [randn() * 0.2, randn() * 0.2, randn() * 0.2 + vib]);
      const wb = [0, dphi, 0];
      const wp = add(mul(mT(M, wb), gs), add(bias, [randn() * 0.004, randn() * 0.004, randn() * 0.004]));
      samples.push({ t, f: mT(M, fb), w: wp, hasGyro: true });
      if (t - lastGps >= 1) {
        lastGps = t;
        gpsFix.push({ t, speed: Math.max(0, v + randn() * 0.1), lat: lat0 + dist * Math.cos(hd) / 111320, lon: lon0 + dist * Math.sin(hd) / (111320 * Math.cos(lat0 * Math.PI / 180)), alt: 100 - sth * dist + randn() * 0.5, acc: 4, heading: 30 });
      }
      t += dt;
    }
    return { samples, gps: gpsFix, cal, onsetT: tb + 0.1, endT: endT || tb + p.brakeDur, truth: { mu: p.mu, slopePct: p.slopePct } };
  }

  root.FrikCore = { G, computeCalibration, combineCalibration, processBrake, classify, stopDist, speedAt, nearestFix, gpsSlope, haversine, simulate, vec: { dot, add, sub, mul, norm, unit, cross } };
})(typeof window !== 'undefined' ? window : globalThis);
