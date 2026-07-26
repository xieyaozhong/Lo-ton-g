const CACHE = 'rain-guard-v5';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/rain-guard.svg'];
const DB_NAME = 'rain-guard-db';
const DB_STORE = 'kv';
const BG_TAG = 'rain-guard-check';
const DIRS = ['中心', '北', '東北', '東', '東南', '南', '西南', '西', '西北'];
const BEARINGS = [null, 0, 45, 90, 135, 180, 225, 270, 315];
const DRY_CONFIRM_SLOTS = 2;

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
  const result = [{ lat: config.latitude, lon: config.longitude }];
  BEARINGS.slice(1).forEach(bearing => result.push(dest(config.latitude, config.longitude, bearing, config.radius)));
  return result;
}

function clock(timestamp) {
  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp * 1000));
}

function findDryStart(series, startIndex, threshold) {
  for (let index = startIndex + 1; index <= series.time.length - DRY_CONFIRM_SLOTS; index += 1) {
    let dry = true;
    for (let offset = 0; offset < DRY_CONFIRM_SLOTS; offset += 1) {
      if (+(series.precipitation[index + offset] || 0) >= threshold) {
        dry = false;
        break;
      }
    }
    if (dry) return index;
  }
  return -1;
}

async function backgroundRainCheck() {
  const config = await dbGet('config');
  if (!config || Date.now() - config.updatedAt > 24 * 60 * 60 * 1000) return;

  const samples = points(config);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', samples.map(point => point.lat.toFixed(5)).join(','));
  url.searchParams.set('longitude', samples.map(point => point.lon.toFixed(5)).join(','));
  url.searchParams.set('minutely_15', 'precipitation');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('timezone', 'auto');

  const response = await fetch(url);
  if (!response.ok) return;

  const raw = await response.json();
  const sets = Array.isArray(raw) ? raw : [raw];
  const now = Date.now() / 1000;
  const center = sets[0]?.minutely_15;

  if (center?.time?.length) {
    let currentIndex = center.time.findIndex(time => time > now);
    if (currentIndex < 0) currentIndex = center.time.length - 1;
    else currentIndex = Math.max(0, currentIndex - 1);
    const currentMm = +(center.precipitation[currentIndex] || 0);

    if (currentMm >= config.threshold) {
      const dryIndex = findDryStart(center, currentIndex, config.threshold);
      const stop = dryIndex >= 0 ? center.time[dryIndex] : null;
      const stopMinutes = stop ? Math.max(0, Math.round((stop * 1000 - Date.now()) / 60000)) : null;
      const key = `stop-${stop || 'unknown'}-${currentMm.toFixed(2)}`;
      const last = await dbGet('lastAlert');
      if (key === last) return;

      await self.registration.showNotification(
        stop ? `預計 ${clock(stop)} 左右雨停` : '目前正在下雨',
        {
          body: stop
            ? `中心點目前約 ${currentMm.toFixed(2)} mm／15 分鐘，預估 ${stopMinutes} 分鐘後雨勢低於門檻。`
            : `中心點目前約 ${currentMm.toFixed(2)} mm／15 分鐘，預報時段內尚無明確雨停時間。`,
          icon: './icons/rain-guard.svg',
          badge: './icons/rain-guard.svg',
          tag: 'rain-guard',
          renotify: true,
          data: { url: './' }
        }
      );
      await dbSet('lastAlert', key);
      return;
    }
  }

  const rainy = sets.map((data, index) => {
    const series = data.minutely_15;
    if (!series?.time) return null;
    const nextIndex = series.time.findIndex((time, itemIndex) => (
      time >= now - 60 && +(series.precipitation[itemIndex] || 0) >= config.threshold
    ));
    if (nextIndex < 0) return null;
    const next = series.time[nextIndex];
    return {
      direction: DIRS[index],
      next,
      minutes: Math.max(0, Math.round((next * 1000 - Date.now()) / 60000)),
      mm: +(series.precipitation[nextIndex] || 0)
    };
  }).filter(Boolean).sort((a, b) => a.next - b.next);

  const winner = rainy[0];
  if (!winner || winner.minutes > config.lead) return;

  const key = `arrival-${winner.next}-${winner.direction}`;
  const last = await dbGet('lastAlert');
  if (key === last) return;

  await self.registration.showNotification(
    winner.minutes ? `約 ${winner.minutes} 分鐘後可能下雨` : '目前偵測到降雨',
    {
      body: `${winner.direction}方向，預估 ${winner.mm.toFixed(2)} mm／15 分鐘（背景使用最後已知位置）`,
      icon: './icons/rain-guard.svg',
      badge: './icons/rain-guard.svg',
      tag: 'rain-guard',
      renotify: true,
      data: { url: './' }
    }
  );
  await dbSet('lastAlert', key);
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
