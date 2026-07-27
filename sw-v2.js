const CACHE = 'rain-guard-v6';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './precision.js', './manifest.webmanifest', './icons/rain-guard.svg'];
const DB_NAME = 'rain-guard-db';
const DB_STORE = 'kv';
const BG_TAG = 'rain-guard-check';
const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const WET_CONFIRM_SLOTS = 2;
const DRY_CONFIRM_SLOTS = 3;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.url.includes('api.open-meteo.com')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }))
  );
});

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, 'readonly');
    const request = transaction.objectStore(DB_STORE).get(key);
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
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

function points(config) {
  const result = [{ id: 'center', direction: '中心', ring: 0, distance: 0, lat: config.latitude, lon: config.longitude }];
  [0.5, 1].forEach(ring => {
    BEARINGS.forEach((bearing, index) => {
      const distance = Math.max(0.5, config.radius * ring);
      result.push({
        id: `${ring}-${bearing}`,
        direction: DIRS[index],
        ring,
        distance,
        ...dest(config.latitude, config.longitude, bearing, distance)
      });
    });
  });
  return result;
}

function clock(timestamp) {
  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp * 1000));
}

function precipitationAt(series, index) {
  return +(series?.precipitation?.[index] || 0);
}

function currentSlotIndex(series, now) {
  let index = series.time.findIndex(time => time > now);
  if (index < 0) return series.time.length - 1;
  return Math.max(0, index - 1);
}

function sustainedWet(series, index, threshold) {
  if (index < 0 || precipitationAt(series, index) < threshold) return false;
  const values = [0, 1, 2].map(offset => precipitationAt(series, index + offset));
  return values.filter(value => value >= threshold).length >= WET_CONFIRM_SLOTS ||
    Math.max(...values, 0) >= Math.max(0.5, threshold * 3);
}

function findWetStart(series, startIndex, threshold) {
  for (let index = startIndex; index < series.time.length; index += 1) {
    if (sustainedWet(series, index, threshold)) return index;
  }
  return -1;
}

function findDryStart(series, startIndex, threshold) {
  const dryThreshold = Math.max(0.02, threshold * 0.6);
  for (let index = startIndex + 1; index <= series.time.length - DRY_CONFIRM_SLOTS; index += 1) {
    let dry = true;
    for (let offset = 0; offset < DRY_CONFIRM_SLOTS; offset += 1) {
      if (precipitationAt(series, index + offset) >= dryThreshold) {
        dry = false;
        break;
      }
    }
    if (dry) return index;
  }
  return -1;
}

function analyze(data, meta, threshold, now) {
  const series = data?.minutely_15;
  if (!series?.time?.length) return { ...meta, current: false, next: null };
  const currentIndex = currentSlotIndex(series, now);
  const currentMm = precipitationAt(series, currentIndex);
  const current = currentMm >= threshold;
  const nextIndex = current ? currentIndex : findWetStart(series, currentIndex, threshold);
  return {
    ...meta,
    current,
    currentMm,
    currentTime: series.time[currentIndex],
    next: nextIndex >= 0 ? series.time[nextIndex] : null,
    mm: nextIndex >= 0 ? precipitationAt(series, nextIndex) : 0,
    series,
    currentIndex
  };
}

function directionTrend(all, centerTime = null) {
  const candidates = [];
  DIRS.forEach(direction => {
    const inner = all.find(item => item.direction === direction && item.ring === 0.5);
    const outer = all.find(item => item.direction === direction && item.ring === 1);
    if (!inner || !outer) return;
    const outerTime = outer.current ? outer.currentTime : outer.next;
    const innerTime = inner.current ? inner.currentTime : inner.next;
    if (!outerTime || !innerTime) return;
    const deltaSeconds = innerTime - outerTime;
    if (deltaSeconds < 5 * 60 || deltaSeconds > 120 * 60) return;
    const speedKmh = (outer.distance - inner.distance) / (deltaSeconds / 3600);
    if (speedKmh < 1 || speedKmh > 100) return;
    const projected = innerTime + (inner.distance / speedKmh) * 3600;
    if (centerTime && Math.abs(projected - centerTime) > 45 * 60) return;
    candidates.push({ direction, projected, inner, outer });
  });
  return candidates.sort((a, b) => a.projected - b.projected)[0] || null;
}

async function notifyOnce(key, title, body) {
  const last = await dbGet('lastAlert');
  if (key === last) return;
  await self.registration.showNotification(title, {
    body,
    icon: './icons/rain-guard.svg',
    badge: './icons/rain-guard.svg',
    tag: 'rain-guard',
    renotify: true,
    data: { url: './' }
  });
  await dbSet('lastAlert', key);
}

async function backgroundRainCheck() {
  const config = await dbGet('config');
  if (!config || Date.now() - config.updatedAt > 24 * 60 * 60 * 1000) return;

  const samples = points(config);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', samples.map(point => point.lat.toFixed(5)).join(','));
  url.searchParams.set('longitude', samples.map(point => point.lon.toFixed(5)).join(','));
  url.searchParams.set('minutely_15', 'precipitation');
  url.searchParams.set('forecast_minutely_15', '24');
  url.searchParams.set('past_minutely_15', '1');
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('cell_selection', 'nearest');

  const response = await fetch(url);
  if (!response.ok) return;
  const raw = await response.json();
  const sets = Array.isArray(raw) ? raw : [raw];
  if (sets.length !== samples.length) return;

  const now = Date.now() / 1000;
  const all = sets.map((data, index) => analyze(data, samples[index], config.threshold, now));
  const center = all[0];

  if (center.current) {
    const dryIndex = findDryStart(center.series, center.currentIndex, config.threshold);
    const stop = dryIndex >= 0 ? center.series.time[dryIndex] : null;
    const stopMinutes = stop ? Math.max(0, Math.round((stop * 1000 - Date.now()) / 60000)) : null;
    const key = `stop-${stop || 'unknown'}-${center.currentMm.toFixed(2)}`;
    await notifyOnce(
      key,
      stop ? `預計 ${clock(stop)} 左右雨停` : '目前正在下雨',
      stop
        ? `目前約 ${center.currentMm.toFixed(2)} mm／15 分鐘；連續 45 分鐘低於乾燥門檻後判定雨停，約 ${stopMinutes} 分鐘。`
        : `目前約 ${center.currentMm.toFixed(2)} mm／15 分鐘，暫無穩定雨停訊號。`
    );
    return;
  }

  if (center.next) {
    const trend = directionTrend(all, center.next);
    const minutes = Math.max(0, Math.round((center.next * 1000 - Date.now()) / 60000));
    if (minutes > config.lead) return;
    const direction = trend?.direction || '未明';
    const key = `arrival-${Math.round(center.next / 900)}-${direction}`;
    await notifyOnce(
      key,
      minutes ? `約 ${minutes} 分鐘後可能下雨` : '目前可能開始下雨',
      `${direction === '未明' ? '' : `${direction}方向，`}中心點預估 ${center.mm.toFixed(2)} mm／15 分鐘（背景使用最後已知位置）。`
    );
    return;
  }

  const trend = directionTrend(all, null);
  if (!trend) return;
  const minutes = Math.max(0, Math.round((trend.projected * 1000 - Date.now()) / 60000));
  if (minutes > config.lead) return;
  const key = `projected-${Math.round(trend.projected / 900)}-${trend.direction}`;
  await notifyOnce(
    key,
    `雨勢可能由${trend.direction}接近`,
    '外圈到內圈出現合理時序，但中心格點尚未確認降雨；此為低信心提前提示。'
  );
}

self.addEventListener('periodicsync', event => {
  if (event.tag === BG_TAG) event.waitUntil(backgroundRainCheck());
});

self.addEventListener('sync', event => {
  if (event.tag === BG_TAG) event.waitUntil(backgroundRainCheck());
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { body: event.data?.text() || '偵測到新的降雨資訊。' };
  }
  event.waitUntil(self.registration.showNotification(data.title || '雨境降雨預警', {
    body: data.body || '請開啟雨境查看最新預報。',
    icon: './icons/rain-guard.svg',
    badge: './icons/rain-guard.svg',
    tag: data.tag || 'rain-guard-push',
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) {
        client.navigate?.(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});
