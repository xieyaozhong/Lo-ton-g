'use strict';

// Accuracy layer: keeps the existing UI, but replaces the rain-arrival logic.
(() => {
  const P_DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
  const P_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
  const WET_SLOTS = 2;
  const DRY_SLOTS = 3;
  const pClamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function km(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r;
    const dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function buildSamples() {
    const list = [{ id: 'center', direction: '中心', bearing: null, ring: 0, distance: 0,
      lat: state.pos.latitude, lon: state.pos.longitude }];
    [0.5, 1].forEach(ring => P_BEARINGS.forEach((bearing, i) => {
      const distance = Math.max(0.5, state.radius * ring);
      list.push({ id: `${ring}-${bearing}`, direction: P_DIRS[i], bearing, ring, distance,
        ...dest(state.pos.latitude, state.pos.longitude, bearing, distance) });
    }));
    return list;
  }

  const mmAt = (series, i) => +(series?.precipitation?.[i] || 0);
  function slotIndex(series, now) {
    let i = series.time.findIndex(t => t > now);
    return i < 0 ? series.time.length - 1 : Math.max(0, i - 1);
  }
  function sustained(series, i) {
    if (i < 0 || mmAt(series, i) < state.threshold) return false;
    const values = [0, 1, 2].map(o => mmAt(series, i + o));
    return values.filter(v => v >= state.threshold).length >= WET_SLOTS ||
      Math.max(...values, 0) >= Math.max(0.5, state.threshold * 3);
  }
  function wetStart(series, start) {
    for (let i = start; i < series.time.length; i += 1) if (sustained(series, i)) return i;
    return -1;
  }
  function dryStart(series, start) {
    const dryThreshold = Math.max(0.02, state.threshold * 0.6);
    for (let i = start + 1; i <= series.time.length - DRY_SLOTS; i += 1) {
      let dry = true;
      for (let o = 0; o < DRY_SLOTS; o += 1) if (mmAt(series, i + o) >= dryThreshold) dry = false;
      if (dry) return i;
    }
    return -1;
  }

  analyze = function precisionAnalyze(data, meta) {
    const series = data?.minutely_15;
    if (!series?.time?.length) return { ...meta, current: false, next: null, stop: null, data };
    const now = Date.now() / 1000;
    const currentIndex = slotIndex(series, now);
    const currentMm = mmAt(series, currentIndex);
    const current = currentMm >= state.threshold;
    const nextIndex = current ? currentIndex : wetStart(series, currentIndex);
    const next = nextIndex >= 0 ? series.time[nextIndex] : null;
    const dryIndex = current ? dryStart(series, currentIndex) : -1;
    const stop = dryIndex >= 0 ? series.time[dryIndex] : null;
    const target = current ? series.time[currentIndex] : next;
    return { ...meta, current, currentMm, currentTime: series.time[currentIndex], nextIndex, next,
      minutes: next ? Math.max(0, Math.round((next * 1000 - Date.now()) / 60000)) : null,
      mm: nextIndex >= 0 ? mmAt(series, nextIndex) : 0, stop,
      stopMinutes: stop ? Math.max(0, Math.round((stop * 1000 - Date.now()) / 60000)) : null,
      probability: nearestProbability(data.hourly, target),
      gridOffsetKm: Number.isFinite(data.latitude) ? km(meta.lat, meta.lon, data.latitude, data.longitude) : null,
      data };
  };

  function trend(all, centerTime) {
    const found = [];
    P_DIRS.forEach(direction => {
      const inner = all.find(x => x.direction === direction && x.ring === 0.5);
      const outer = all.find(x => x.direction === direction && x.ring === 1);
      if (!inner || !outer) return;
      const outerTime = outer.current ? outer.currentTime : outer.next;
      const innerTime = inner.current ? inner.currentTime : inner.next;
      if (!outerTime || !innerTime) return;
      const dt = innerTime - outerTime;
      if (dt < 300 || dt > 7200) return;
      const speed = (outer.distance - inner.distance) / (dt / 3600);
      if (speed < 1 || speed > 100) return;
      const projected = innerTime + inner.distance / speed * 3600;
      const difference = centerTime ? Math.abs(projected - centerTime) / 60 : 0;
      if (centerTime && difference > 45) return;
      found.push({ direction, inner, outer, projected,
        score: 60 - difference + Math.max(inner.probability || 0, outer.probability || 0) * 0.2 });
    });
    return found.sort((a, b) => b.score - a.score)[0] || null;
  }

  function support(all, time) {
    const hits = all.slice(1).filter(x => {
      const t = x.current ? x.currentTime : x.next;
      return t && Math.abs(t - time) <= 1800;
    });
    const cells = new Set(hits.map(x => Number.isFinite(x.data?.latitude)
      ? `${x.data.latitude.toFixed(3)},${x.data.longitude.toFixed(3)}` : x.id));
    return { count: hits.length, cells: cells.size };
  }

  function confidence(center, all, movement, projected = false) {
    const target = center?.current ? center.currentTime : center?.next || movement?.projected;
    const s = support(all, target);
    const probability = center?.probability ?? Math.max(movement?.inner?.probability || 0, movement?.outer?.probability || 0);
    let score = projected ? 30 : 45;
    score += Math.min(25, (probability || 0) * 0.25) + Math.min(15, s.count * 1.8) + Math.min(8, s.cells * 1.5);
    if (movement) score += 10;
    if (center?.nextIndex >= 0 && sustained(center.data.minutely_15, center.nextIndex)) score += 8;
    if ((center?.gridOffsetKm || 0) > 2) score -= Math.min(15, (center.gridOffsetKm - 2) * 4);
    if ((state.pos?.accuracy || 0) > 200) score -= Math.min(15, (state.pos.accuracy - 200) / 100);
    if (projected) score = Math.min(score, 68);
    return Math.round(pClamp(score, 15, 95));
  }
  const confidenceText = score => score >= 78 ? `高 ${score}%` : score >= 55 ? `中 ${score}%` : `低 ${score}%`;

  renderDots = function precisionDots(all, focus) {
    $('samples').innerHTML = all.map(x => {
      const theta = (x.bearing || 0) * Math.PI / 180;
      const radius = x.ring === 0 ? 0 : x.ring === 0.5 ? 20 : 35;
      const left = 50 + Math.sin(theta) * radius;
      const top = 50 - Math.cos(theta) * radius;
      const wet = x.current || x.next;
      const urgent = x.current || focus?.id === x.id;
      let title = `${x.direction}：無明顯降雨`;
      if (x.current) title = `${x.direction}正在下雨${x.stop ? `，約 ${clock(x.stop)} 轉乾` : ''}`;
      else if (x.next) title = `${x.direction}約 ${clock(x.next)} 出現降雨`;
      return `<span class="sample${wet ? ' wet' : ''}${urgent ? ' urgent' : ''}" style="left:${left}%;top:${top}%" title="${title}"></span>`;
    }).join('');
  };

  saveBackgroundConfig = async function precisionSaveConfig() {
    if (!state.pos) return;
    await dbSet('config', { latitude: state.pos.latitude, longitude: state.pos.longitude,
      accuracy: state.pos.accuracy, radius: state.radius, threshold: state.threshold,
      lead: state.lead, updatedAt: Date.now() });
  };

  forecast = async function precisionForecast(silent = false) {
    if (!state.pos) return;
    if (!silent) message('正在更新 17 點降雨預報…');
    try {
      const samples = buildSamples();
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', samples.map(p => p.lat.toFixed(5)).join(','));
      url.searchParams.set('longitude', samples.map(p => p.lon.toFixed(5)).join(','));
      url.searchParams.set('minutely_15', 'precipitation,weather_code');
      url.searchParams.set('hourly', 'precipitation_probability');
      url.searchParams.set('forecast_minutely_15', '24');
      url.searchParams.set('forecast_hours', '8');
      url.searchParams.set('past_minutely_15', '1');
      url.searchParams.set('timeformat', 'unixtime');
      url.searchParams.set('timezone', 'auto');
      url.searchParams.set('cell_selection', 'nearest');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`氣象服務回應 ${response.status}`);
      const raw = await response.json();
      const sets = Array.isArray(raw) ? raw : [raw];
      if (sets.length !== samples.length) throw new Error('氣象取樣資料不完整');
      const all = sets.map((data, i) => analyze(data, samples[i]));
      const center = all[0];
      const movement = trend(all, center?.next);
      const nearby = all.slice(1).filter(x => x.current || x.next)
        .sort((a, b) => (a.current ? 0 : a.next) - (b.current ? 0 : b.next))[0];
      const score = confidence(center, all, movement);
      renderTimeline(center?.data);
      $('updated').textContent = `更新於 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;

      if (center.current) {
        renderDots(all, center);
        setMetricLabels({ arrival: '預估雨停', direction: '目前位置', rain: '目前雨量', probability: '信心參考' });
        $('dot').className = 'dot danger';
        $('headline').textContent = center.stop ? `預計 ${center.stopMinutes} 分鐘後雨停` : '目前正在下雨';
        $('sub').textContent = center.stop ? '需連續 45 分鐘低於乾燥門檻才判定雨停，避免短暫雨歇誤報。' : '尚未出現穩定的連續乾燥訊號。';
        $('arrival').textContent = center.stop ? clock(center.stop) : '預報外';
        $('direction').textContent = '中心';
        $('rain').textContent = `${center.currentMm.toFixed(2)} mm`;
        $('prob').textContent = confidenceText(score);
        await alertWeather(center);
      } else if (center.next) {
        const arrival = movement ? pClamp((center.next * 2 + movement.projected) / 3, center.next - 900, center.next + 900) : center.next;
        const minutes = Math.max(0, Math.round((arrival * 1000 - Date.now()) / 60000));
        renderDots(all, movement?.inner || center);
        setMetricLabels();
        $('dot').className = `dot ${minutes <= state.lead ? 'danger' : 'warn'}`;
        $('headline').textContent = minutes <= 0 ? '目前可能開始下雨' : `約 ${minutes} 分鐘後可能下雨`;
        $('sub').textContent = movement ? `中心預報與「${movement.direction}外圈 → 內圈」時序一致；時間解析度約 ±15 分鐘。` : '抵達時間以目前位置中心格點為主；周圍尚無明確移動方向。';
        $('arrival').textContent = `${clock(arrival)} ±15分`;
        $('direction').textContent = movement?.direction || '未明';
        $('rain').textContent = `${center.mm.toFixed(2)} mm`;
        $('prob').textContent = confidenceText(score);
        await alertWeather({ ...center, next: arrival, minutes, direction: movement?.direction || '未明' });
      } else {
        const projected = trend(all, null);
        if (projected) {
          const pScore = confidence(center, all, projected, true);
          const minutes = Math.max(0, Math.round((projected.projected * 1000 - Date.now()) / 60000));
          renderDots(all, projected.inner);
          setMetricLabels({ arrival: '可能接近', direction: '推測方向', rain: '鄰近雨量', probability: '信心參考' });
          $('dot').className = 'dot warn';
          $('headline').textContent = `雨勢可能由${projected.direction}接近`;
          $('sub').textContent = '外圈到內圈出現合理時間差，但中心尚未預報降雨，因此只列為提前提示。';
          $('arrival').textContent = `${clock(projected.projected)} 前後`;
          $('direction').textContent = projected.direction;
          $('rain').textContent = `${Math.max(projected.inner.mm || 0, projected.outer.mm || 0).toFixed(2)} mm`;
          $('prob').textContent = confidenceText(pScore);
          if (minutes <= state.lead && pScore >= 55) await alertWeather({ next: projected.projected, minutes,
            direction: projected.direction, mm: Math.max(projected.inner.mm || 0, projected.outer.mm || 0) });
        } else if (nearby) {
          renderDots(all, nearby);
          setMetricLabels({ arrival: '中心抵達', direction: '附近方向', rain: '鄰近雨量', probability: '判定' });
          $('dot').className = 'dot warn';
          $('headline').textContent = '附近有雨，中心尚未確認';
          $('sub').textContent = '沒有足夠的內移時序證據；不再把附近降雨直接當成會抵達你的位置。';
          $('arrival').textContent = '尚未確認';
          $('direction').textContent = nearby.direction;
          $('rain').textContent = `${(nearby.current ? nearby.currentMm : nearby.mm).toFixed(2)} mm`;
          $('prob').textContent = '僅附近提示';
        } else {
          renderDots(all, null);
          setMetricLabels();
          $('dot').className = 'dot safe';
          $('headline').textContent = '目前範圍內無明顯降雨';
          $('sub').textContent = '中心與內外雙圈共 17 點皆未達穩定降雨門檻。';
          clearMetrics();
        }
      }
      await saveBackgroundConfig();
      if (!silent) message('偵測完成；中心抵達、雙圈方向與信心已交叉驗證。');
    } catch (error) {
      $('dot').className = 'dot danger';
      $('headline').textContent = '預報取得失敗';
      $('sub').textContent = '請檢查網路後再試一次。';
      message(error.message || '未知錯誤', true);
    }
  };

  got = async function precisionGot(position) {
    const candidate = { latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: Math.round(position.coords.accuracy || 9999), timestamp: position.timestamp || Date.now() };
    const old = state.pos;
    if (old && Date.now() - old.timestamp < 120000 && candidate.accuracy > Math.max(1000, old.accuracy * 1.8)) return;
    state.pos = candidate;
    $('position').textContent = `${candidate.latitude.toFixed(4)}, ${candidate.longitude.toFixed(4)}（定位精度約 ${candidate.accuracy} m）`;
    setState('locationState', candidate.accuracy <= 100 ? '高精度' : '已開啟', candidate.accuracy <= 300 ? 'on' : 'wait');
    await saveBackgroundConfig();
    const moved = old ? km(old.latitude, old.longitude, candidate.latitude, candidate.longitude) : Infinity;
    const threshold = Math.max(0.3, ((old?.accuracy || 0) + candidate.accuracy) / 2000);
    if (!old || moved >= threshold || candidate.accuracy < old.accuracy * 0.65) forecast();
  };

  start = function precisionStart(automatic = false) {
    if (!navigator.geolocation) return positionError({ code: 2 });
    message(automatic ? '正在自動取得高精度位置…' : '正在重新取得高精度位置…');
    if (state.watch !== null) navigator.geolocation.clearWatch(state.watch);
    state.watch = navigator.geolocation.watchPosition(got, positionError, {
      enableHighAccuracy: true, maximumAge: 15000, timeout: 25000
    });
    clearInterval(state.timer);
    state.timer = setInterval(() => forecast(true), 300000);
    $('start').textContent = '重新定位';
  };

  const originalSync = sync;
  sync = function precisionSync() {
    originalSync();
    $('badge').textContent = `半徑 ${state.radius} km・17 點`;
  };
  sync();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then(() => navigator.serviceWorker.register('./sw-v2.js'))
      .then(() => navigator.serviceWorker.ready)
      .then(registration => { state.sw = registration; })
      .catch(console.warn);
  }
})();
