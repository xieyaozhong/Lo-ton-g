const CACHE_PREFIX='typhoon-pwa-';
const CACHE_NAME=CACHE_PREFIX+'v2';
const CORE=['./typhoon.html','./typhoon.webmanifest','./icons/typhoon-eye.svg','./typhoon-version.json'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(CORE)).catch(()=>{}).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

function transformTyphoonHtml(html){
  // PWA icon is reserved for install / launch metadata only. The live dashboard
  // uses an independent animated cyclone visual and never reuses the static icon.
  html=html.replace(/<link rel="icon" href="\.\/icons\/typhoon-eye\.svg" type="image\/svg\+xml">\s*/,'');
  html=html.replace(/\.brand img\{[^}]*\}/,
    '.brand-mark{width:50px;height:50px;border-radius:16px;display:grid;place-items:center;position:relative;overflow:hidden;background:linear-gradient(145deg,rgba(114,231,255,.18),rgba(28,77,106,.13));border:1px solid rgba(114,231,255,.28);box-shadow:0 0 38px rgba(48,188,231,.14)}.brand-mark:before{content:"";width:29px;height:29px;border-radius:50%;background:conic-gradient(from 10deg,transparent 0 9%,rgba(117,235,255,.98) 15% 27%,transparent 34% 49%,rgba(117,235,255,.76) 57% 70%,transparent 77% 89%,rgba(117,235,255,.54) 94%);animation:spin 4.2s linear infinite}.brand-mark:after{content:"";position:absolute;width:7px;height:7px;border-radius:50%;background:#f4fdff;border:2px solid #0c617d;box-shadow:0 0 0 5px rgba(115,231,255,.13),0 0 18px rgba(115,231,255,.75)}');
  html=html.replace(/\.typhoon-eye\{[^}]*\}/,
    '.typhoon-eye{position:relative;width:42px;height:42px;border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(244,253,255,.12) 0 13%,rgba(15,102,132,.16) 14% 23%,transparent 24%),radial-gradient(circle,rgba(48,188,231,.11),transparent 66%);filter:drop-shadow(0 0 11px rgba(114,231,255,.68));animation:stormFloat 2.35s ease-in-out infinite}.typhoon-eye:before{content:"";position:absolute;inset:1px;border-radius:50%;background:conic-gradient(from 6deg,transparent 0 9%,rgba(134,240,255,.98) 14% 26%,transparent 33% 49%,rgba(89,218,247,.82) 56% 69%,transparent 76% 88%,rgba(151,245,255,.62) 93%);mask:radial-gradient(circle,transparent 0 18%,#000 20% 100%);animation:spin 3.35s linear infinite}.typhoon-eye:after{content:"";position:absolute;left:50%;top:50%;width:9px;height:9px;border-radius:50%;transform:translate(-50%,-50%);background:#f7feff;border:2px solid #0b6682;box-shadow:0 0 0 5px rgba(115,231,255,.16),0 0 21px rgba(115,231,255,.94),0 0 36px rgba(48,188,231,.38)}');
  html=html.replace('@keyframes livePulse','@keyframes spin{to{transform:rotate(360deg)}}@keyframes livePulse');
  html=html.replace('.brand img{width:42px;height:42px}','.brand-mark{width:42px;height:42px}');
  html=html.replace('<img src="./icons/typhoon-eye.svg" alt="">','<div class="brand-mark" aria-hidden="true"></div>');
  return html;
}

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

async function dashboardShell(request){
  let source;
  try{
    source=await fetch(request,{cache:'no-store'});
    if(source&&source.ok){const cache=await caches.open(CACHE_NAME);cache.put(request,source.clone()).catch(()=>{});}
  }catch(err){
    source=await caches.match(request,{ignoreSearch:true});
    if(!source)throw err;
  }
  const text=transformTyphoonHtml(await source.text());
  const headers=new Headers(source.headers);
  headers.set('content-type','text/html; charset=utf-8');
  headers.set('cache-control','no-store');
  return new Response(text,{status:source.status,statusText:source.statusText,headers});
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
  if(p.endsWith('/typhoon.html')){
    event.respondWith(dashboardShell(req));
    return;
  }
  if(p.endsWith('/data/typhoon-dashboard.json')||p.endsWith('/typhoon-version.json')||p.endsWith('/typhoon.webmanifest')){
    event.respondWith(networkFirst(req));
    return;
  }
  if(p.includes('/icons/typhoon-'))event.respondWith(cacheFirst(req));
});

self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
