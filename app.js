'use strict';

const $ = id => document.getElementById(id);
const dirs = ['中心', '北', '東北', '東', '東南', '南', '西南', '西', '西北'];
const bearings = [null, 0, 45, 90, 135, 180, 225, 270, 315];
const DB_NAME = 'rain-guard-db';
const DB_STORE = 'kv';
const BG_TAG = 'rain-guard-check';
const DRY_CONFIRM_SLOTS = 2;

const state = {
  pos: null,
  watch: null,
  timer: null,
  sw: null,
  lastAlert: localStorage.rainGuardLastAlert || '',
  radius: +(localStorage.rainGuardRadius || 5),
  threshold: +(localStorage.rainGuardThreshold || 0.1),
  lead: +(localStorage.rainGuardLead || 60),
  autoLocate: localStorage.rainGuardAutoLocate !== '0'
};

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const clock = timestamp => new Intl.DateTimeFormat('zh-TW', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}).format(new Date(timestamp * 1000));

function message(text, error = false) {
  $('msg').textContent = text;
  $('msg').style.color = error ? '#ffaaaa' : '';
}

function setState(id, text, kind = 'wait') {
  const el = $(id);
  el.textContent = text;
  el.className = `state ${kind}`;
}

function setMetricLabels({ arrival = '預估抵達', direction = '最早方向', rain = '預估雨量', probability = '信心參考' } = {}) {
  $('arrivalLabel').textContent = arrival;
  $('directionLabel').textContent = direction;
  $('rainLabel').textContent = rain;
  $('probLabel').textContent = probability;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, 'readwrite');
    transaction.objectStore(DB_STORE).put(value, key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function dest(lat, lon, bearing, km) {
  const earthRadius = 6371;
  const distance = km / earthRadius;
  const theta = bearing * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const lambda = lon * Math.PI / 180;
  const phi2 = Math.asin(
    Math.sin(phi) * Math.cos(distance) +
    Math.cos(phi) * Math.sin(distance) * Math.cos(theta)
  );
  const lambda2 = lambda + Math.atan2(
    Math.sin(theta) * Math.sin(distance) * Math.cos(phi),
    Math.cos(distance) - Math.sin(phi) * Math.sin(phi2)
  );
  return {
    lat: phi2 * 180 / Math.PI,
    lon: ((lambda2 * 180 / Math.PI + 540) % 360) - 180
  };
}

function points() {
  const result = [{ lat: state.pos.latitude, lon: state.pos.longitude }];
  bearings.slice(1).forEach(bearing => {
    result.push(dest(state.pos.latitude, state.pos.longitude, bearing, state.radius));
  });
  return result;
}

function nearestProbability(hourly, timestamp) {
  if (!hourly?.time?.length) return null;
  let bestIndex = 0;
  let bestDiff = Infinity;
  hourly.time.forEach((time, index) => {
    const diff = Math.abs(time - timestamp);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  });
  return hourly.precipitation_probability?.[bestIndex] ?? null;
}

function findDryStart(series, startIndex) {
  for (let index = startIndex + 1; index <= series.time.length - DRY_CONFIRM_SLOTS; index += 1) {
    let dry = true;
    for (let offset = 0; offset < DRY_CONFIRM_SLOTS; offset += 1) {
      if (+(series.precipitation[index + offset] || 0) >= state.threshold) {
        dry = false;
        break;
      }
    }
    if (dry) return index;
  }
  return -1;
}

function analyze(data, index) {
  const series = data.minutely_15;
  if (!series?.time?.length) {
    return { index, direction: dirs[index], next: null, current: false, stop: null, data };
  }

  const now = Date.now() / 1000;
  let currentIndex = series.time.findIndex(time => time > now);
  if (currentIndex < 0) currentIndex = series.time.length - 1;
  else currentIndex = Math.max(0, currentIndex - 1);

  const currentMm = +(series.precipitation[currentIndex] || 0);
  const current = currentMm >= state.threshold;
  const dryIndex = current ? findDryStart(series, currentIndex) : -1;
  const stop = dryIndex >= 0 ? series.time[dryIndex] : null;

  let nextIndex = currentIndex;
  if (!current) {
    nextIndex = series.time.findIndex((time, itemIndex) => (
      itemIndex >= currentIndex && time >= now - 60 && +(series.precipitation[itemIndex] || 0) >= state.threshold
    ));
  }

  const next = nextIndex >= 0 ? series.time[nextIndex] : null;
  const probabilityTime = current ? series.time[currentIndex] : next;

  return {
    index,
    direction: dirs[index],
    current,
    currentMm,
    currentTime: series.time[currentIndex],
    stop,
    stopMinutes: stop ? Math.max(0, Math.round((stop * 1000 - Date.now()) / 60000)) : null,
    next,
    minutes: next ? Math.max(0, Math.round((next * 1000 - Date.now()) / 60000)) : null,
    mm: nextIndex >= 0 ? +(series.precipitation[nextIndex] || 0) : 0,
    probability: probabilityTime ? nearestProbability(data.hourly, probabilityTime) : null,
    data
  };
}

function renderDots(all, focus) {
  const positions = [[50, 50], [50, 15], [75, 25], [85, 50], [75, 75], [50, 85], [25, 75], [15, 50], [25, 25]];
  $('samples').innerHTML = positions.map(([x, y], index) => {
    const sample = all[index];
    const wet = sample?.current || sample?.next;
    const urgent = sample?.current || (focus?.index === index && focus?.minutes <= state.lead);
    let title = `${dirs[index]} 無雨`;
    if (sample?.current) {
      title = sample.stop
        ? `${dirs[index]} 正在下雨，預估 ${clock(sample.stop)} 雨停`
        : `${dirs[index]} 正在下雨，暫無明確雨停時間`;
    } else if (sample?.next) {
      title = `${dirs[index]} ${clock(sample.next)} 可能下雨`;
    }
    return `<span class="sample${wet ? ' wet' : ''}${urgent ? ' urgent' : ''}" style="left:${x}%;top:${y}%" title="${title}"></span>`;
  }).join('');
}

function renderTimeline(data) {
  const series = data?.minutely_15;
  if (!series?.time) {
    $('timeline').textContent = '暫無資料';
    return;
  }
  const now = Date.now() / 1000 - 60;
  const items = series.time
    .map((time, index) => ({ time, index }))
    .filter(item => item.time >= now)
    .slice(0, 12);
  const max = Math.max(0.5, ...items.map(item => +(series.precipitation[item.index] || 0)));
  $('timeline').innerHTML = items.map(item => {
    const mm = +(series.precipitation[item.index] || 0);
    const height = Math.max(2, Math.round(mm / max * 52));
    return `<div class="slot"><div class="barwrap"><div class="bar" style="height:${height}px;opacity:${mm ? 1 : 0.18}"></div></div><strong>${clock(item.time)}</strong><span>${mm.toFixed(2)} mm</span></div>`;
  }).join('');
}

async function saveBackgroundConfig() {
  if (!state.pos) return;
  await dbSet('config', {
    latitude: state.pos.latitude,
    longitude: state.pos.longitude,
    radius: state.radius,
    threshold: state.threshold,
    lead: state.lead,
    updatedAt: Date.now()
  });
}

async function showNotification(title, body, tag = 'rain-guard') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const registration = state.sw || await navigator.serviceWorker?.ready;
  if (registration) {
    await registration.showNotification(title, {
      body,
      icon: './icons/rain-guard.svg',
      badge: './icons/rain-guard.svg',
      tag,
      renotify: true,
      data: { url: './' }
    });
  } else {
    new Notification(title, { body });
  }
  return true;
}

async function alertWeather(status) {
  if (!status || !('Notification' in window) || Notification.permission !== 'granted') return;

  let key;
  let title;
  let body;

  if (status.current) {
    key = `stop-${status.stop || 'unknown'}-${status.currentMm.toFixed(2)}`;
    title = status.stop ? `預計 ${clock(status.stop)} 左右雨停` : '目前正在下雨';
    body = status.stop
      ? `中心點目前約 ${status.currentMm.toFixed(2)} mm／15 分鐘，預估 ${status.stopMinutes} 分鐘後雨勢降到門檻以下。`
      : `中心點目前約 ${status.currentMm.toFixed(2)} mm／15 分鐘，預報時段內尚無明確雨停時間。`;
  } else {
    if (status.minutes > state.lead) return;
    key = `arrival-${status.next}-${status.direction}`;
    title = status.minutes ? `約 ${status.minutes} 分鐘後可能下雨` : '目前偵測到降雨';
    body = `${status.direction}方向，預估 ${status.mm.toFixed(2)} mm／15 分鐘`;
  }

  if (key === state.lastAlert) return;
  await showNotification(title, body);
  state.lastAlert = key;
  localStorage.rainGuardLastAlert = key;
  try {
    if ('setAppBadge' in navigator) await navigator.setAppBadge(1);
  } catch {}
}

function clearMetrics() {
  $('arrival').textContent = '—';
  $('direction').textContent = '—';
  $('rain').textContent = '—';
  $('prob').textContent = '—';
}

async function forecast(silent = false) {
  if (!state.pos) return;
  if (!silent) message('正在更新降雨預報…');

  try {
    const samples = points();
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', samples.map(point => point.lat.toFixed(5)).join(','));
    url.searchParams.set('longitude', samples.map(point => point.lon.toFixed(5)).join(','));
    url.searchParams.set('minutely_15', 'precipitation,weather_code');
    url.searchParams.set('hourly', 'precipitation_probability');
    url.searchParams.set('forecast_days', '2');
    url.searchParams.set('timeformat', 'unixtime');
    url.searchParams.set('timezone', 'auto');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`氣象服務回應 ${response.status}`);

    const raw = await response.json();
    const sets = Array.isArray(raw) ? raw : [raw];
    const all = sets.map(analyze);
    const center = all[0];
    const upcoming = all
      .filter(item => !item.current && item.next)
      .sort((a, b) => a.next - b.next)[0];
    const focus = center?.current ? center : upcoming;

    renderDots(all, focus);
    renderTimeline(center?.data);
    $('updated').textContent = `更新於 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;

    if (center?.current) {
      setMetricLabels({
        arrival: '預估雨停',
        direction: '目前位置',
        rain: '目前雨量',
        probability: '降雨機率'
      });
      $('dot').className = 'dot danger';
      if (center.stop) {
        $('headline').textContent = center.stopMinutes <= 0
          ? '雨勢可能即將停止'
          : `預計 ${center.stopMinutes} 分鐘後雨停`;
        $('sub').textContent = `預估 ${clock(center.stop)} 起，中心點會連續至少 30 分鐘低於設定門檻。`;
        $('arrival').textContent = clock(center.stop);
      } else {
        $('headline').textContent = '目前正在下雨';
        $('sub').textContent = '目前預報時段內，尚未出現連續 30 分鐘低於設定門檻的時段。';
        $('arrival').textContent = '預報外';
      }
      $('direction').textContent = '中心';
      $('rain').textContent = `${center.currentMm.toFixed(2)} mm`;
      $('prob').textContent = center.probability == null ? '模式雨量' : `${center.probability}%`;
      await alertWeather(center);
    } else if (upcoming) {
      setMetricLabels();
      $('dot').className = `dot ${upcoming.minutes <= state.lead ? 'danger' : 'warn'}`;
      $('headline').textContent = upcoming.minutes <= 0
        ? '目前偵測到鄰近降雨'
        : `約 ${upcoming.minutes} 分鐘後可能下雨`;
      $('sub').textContent = `雨勢最早由${upcoming.direction}方向進入 ${state.radius} 公里範圍。`;
      $('arrival').textContent = clock(upcoming.next);
      $('direction').textContent = upcoming.direction;
      $('rain').textContent = `${upcoming.mm.toFixed(2)} mm`;
      $('prob').textContent = upcoming.probability == null ? '模式雨量' : `${upcoming.probability}%`;
      await alertWeather(upcoming);
    } else {
      setMetricLabels();
      $('dot').className = 'dot safe';
      $('headline').textContent = '目前範圍內無明顯降雨';
      $('sub').textContent = '目前預報時段尚未達到設定門檻。';
      clearMetrics();
      try {
        if ('clearAppBadge' in navigator) await navigator.clearAppBadge();
      } catch {}
    }

    await saveBackgroundConfig();
    if (!silent) message('偵測完成；頁面開啟時每 5 分鐘更新。');
  } catch (error) {
    $('dot').className = 'dot danger';
    $('headline').textContent = '預報取得失敗';
    $('sub').textContent = '請檢查網路後再試一次。';
    message(error.message || '未知錯誤', true);
  }
}

async function got(position) {
  const old = state.pos;
  state.pos = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude
  };
  $('position').textContent = `${state.pos.latitude.toFixed(4)}, ${state.pos.longitude.toFixed(4)}（精度約 ${Math.round(position.coords.accuracy)} m）`;
  setState('locationState', '已開啟', 'on');
  await saveBackgroundConfig();
  if (!old || Math.hypot(old.latitude - state.pos.latitude, old.longitude - state.pos.longitude) > 0.0045) {
    forecast();
  }
}

function positionError(error) {
  const messages = {
    1: '位置權限被拒絕，請到瀏覽器或系統設定允許定位。',
    2: '目前無法判定位置，請確認定位服務已開啟。',
    3: '取得位置逾時，請再試一次。'
  };
  message(messages[error.code] || '取得位置失敗。', true);
  $('headline').textContent = '無法取得位置';
  setState('locationState', error.code === 1 ? '已拒絕' : '取得失敗', 'off');
}

function start(automatic = false) {
  if (!navigator.geolocation) return positionError({ code: 2 });
  message(automatic ? '正在自動取得位置…' : '正在重新取得位置…');
  if (state.watch !== null) navigator.geolocation.clearWatch(state.watch);
  state.watch = navigator.geolocation.watchPosition(got, positionError, {
    enableHighAccuracy: true,
    maximumAge: 60000,
    timeout: 20000
  });
  clearInterval(state.timer);
  state.timer = setInterval(() => forecast(true), 300000);
  $('start').textContent = '重新定位';
}

async function registerBackgroundCheck() {
  if (!state.sw) return 'unsupported';
  try {
    if ('periodicSync' in state.sw) {
      await state.sw.periodicSync.register(BG_TAG, { minInterval: 15 * 60 * 1000 });
      return 'periodic';
    }
    if ('sync' in state.sw) {
      await state.sw.sync.register(BG_TAG);
      return 'once';
    }
    return 'unsupported';
  } catch (error) {
    console.warn(error);
    return 'blocked';
  }
}

function updatePermissionUI(mode) {
  if (!('Notification' in window)) {
    setState('notificationState', '不支援', 'off');
    setState('backgroundState', '不支援', 'off');
    return;
  }

  if (Notification.permission === 'granted') {
    setState('notificationState', '已開啟', 'on');
    $('notify').textContent = '背景通知已授權';
  } else if (Notification.permission === 'denied') {
    setState('notificationState', '已拒絕', 'off');
    $('notify').textContent = '通知已被封鎖';
  } else {
    setState('notificationState', '尚未授權', 'wait');
  }

  if (mode === 'periodic') setState('backgroundState', '定期檢查已註冊', 'on');
  else if (mode === 'once') setState('backgroundState', '支援單次同步', 'wait');
  else if (mode === 'blocked') setState('backgroundState', '系統未允許', 'off');
  else if (isIOS) setState('backgroundState', isStandalone ? '需雲端推播' : '請先加到主畫面', 'wait');
  else setState('backgroundState', '前景通知', 'wait');

  if (isIOS && !isStandalone) {
    $('permissionHelp').textContent = 'iPhone：請先在 Safari 按分享 → 加入主畫面，再從主畫面開啟雨境並按「啟用背景通知」。';
  } else if (isIOS) {
    $('permissionHelp').textContent = 'iPhone 已以主畫面 App 開啟。真正關閉 App 後仍能收到通知，需要後續接上 Web Push 伺服器；目前會在 App 開啟時通知。';
  } else {
    $('permissionHelp').textContent = '支援 Periodic Background Sync 的瀏覽器會以最後已知位置做背景檢查；系統可能延後或限制執行頻率。';
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return message('此瀏覽器不支援通知。', true);
  if (isIOS && !isStandalone) {
    updatePermissionUI();
    return message('iPhone 請先把網站加入主畫面，再從主畫面開啟。', true);
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    updatePermissionUI();
    return message('通知權限未開啟；若已拒絕，請到系統設定解除封鎖。', true);
  }

  localStorage.rainGuardNotifications = '1';
  await saveBackgroundConfig();
  const mode = await registerBackgroundCheck();
  updatePermissionUI(mode);
  await showNotification(
    '雨境通知已啟用',
    mode === 'periodic' ? '已註冊最佳可用的背景降雨檢查。' : '頁面開啟時會依設定發出降雨預警。',
    'rain-guard-test'
  );
  message(mode === 'periodic'
    ? '背景檢查已註冊；實際執行頻率由系統決定。'
    : '通知已開啟；此裝置未提供可靠的定期背景同步。');
}

async function testNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return enableNotifications();
  await showNotification('雨境測試通知', '通知功能正常。若目前正在下雨，會改為顯示預估雨停時間。', 'rain-guard-test');
  message('測試通知已送出。');
}

function sync() {
  state.autoLocate = localStorage.rainGuardAutoLocate !== '0';
  $('autoLocate').checked = state.autoLocate;
  $('radius').value = state.radius;
  $('threshold').value = state.threshold;
  $('lead').value = state.lead;
  $('radiusText').textContent = `${state.radius} km`;
  $('badge').textContent = `半徑 ${state.radius} km`;
  $('thresholdText').textContent = `${state.threshold.toFixed(2)} mm / 15 分鐘`;
  $('leadText').textContent = `${state.lead} 分鐘`;
}

[['radius', 'radius', 'rainGuardRadius'], ['threshold', 'threshold', 'rainGuardThreshold'], ['lead', 'lead', 'rainGuardLead']]
  .forEach(([id, key, store]) => {
    $(id).addEventListener('input', event => {
      state[key] = +event.target.value;
      localStorage[store] = state[key];
      sync();
    });
    $(id).addEventListener('change', async () => {
      await saveBackgroundConfig();
      if (state.pos) forecast();
    });
  });

$('autoLocate').addEventListener('change', event => {
  state.autoLocate = event.target.checked;
  localStorage.rainGuardAutoLocate = state.autoLocate ? '1' : '0';
  message(state.autoLocate ? '下次開啟會自動定位。' : '已關閉自動定位。');
});

$('start').onclick = () => start(false);
$('refresh').onclick = () => forecast();
$('refreshSettings').onclick = () => forecast();
$('notify').onclick = enableNotifications;
$('testNotify').onclick = testNotification;

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (state.autoLocate && state.watch === null) start(true);
    else if (state.pos) forecast(true);
  } else {
    try {
      await saveBackgroundConfig();
      if (state.sw && 'sync' in state.sw) await state.sw.sync.register(BG_TAG);
    } catch {}
  }
});

window.addEventListener('online', () => {
  if (state.pos) forecast(true);
});

(async function boot() {
  sync();
  if ('serviceWorker' in navigator) {
    try {
      state.sw = await navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready);
    } catch (error) {
      console.warn(error);
    }
  }
  updatePermissionUI();
  if ('Notification' in window && Notification.permission === 'granted') {
    const mode = await registerBackgroundCheck();
    updatePermissionUI(mode);
  }
  if (state.autoLocate) {
    setTimeout(() => start(true), 250);
  } else {
    $('headline').textContent = '自動定位已關閉';
    $('sub').textContent = '按「重新定位」開始偵測。';
    $('position').textContent = '等待手動定位';
  }
})();
