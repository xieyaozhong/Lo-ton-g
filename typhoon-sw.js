const CACHE_PREFIX='typhoon-pwa-';
const CACHE_NAME=CACHE_PREFIX+'v1';
const CORE=['./typhoon.html','./typhoon.webmanifest','./icons/typhoon-eye.svg','./typhoon-version.json'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE)).catch(()=>{}).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

async function networkFirst(request){
  try{
    const fresh=await fetch(request,{cache:'no-store'});
    if(fresh&&fresh.ok){const cache=await caches.open(CACHE_NAME);cache.put(request,fresh.clone()).catch(()=>{});}
    return fresh;
  }catch(err){
    const cached=await caches.match(request,{ignoreSearch:true});
    if(cached)return cached;
    throw err;
  }
}

async function cacheFirst(request){
  const cached=await caches.match(request,{ignoreSearch:true});
  if(cached)return cached;
  const fresh=await fetch(request);
  if(fresh&&fresh.ok){const cache=await caches.open(CACHE_NAME);cache.put(request,fresh.clone()).catch(()=>{});}
  return fresh;
}

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  const p=url.pathname;
  if(p.endsWith('/typhoon.html')||p.endsWith('/data/typhoon-dashboard.json')||p.endsWith('/typhoon-version.json')||p.endsWith('/typhoon.webmanifest')){
    event.respondWith(networkFirst(req));
    return;
  }
  if(p.includes('/icons/typhoon-'))event.respondWith(cacheFirst(req));
});

self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
