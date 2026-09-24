/* ===========================================================
   Service Worker —— 应用外壳离线可用，题库走网络优先
   改动静态资源后，把 VERSION 加一即可让手机端拿到新版本
   =========================================================== */
const VERSION = 'v1.0.4';
const SHELL_CACHE = `kaoyan408-shell-${VERSION}`;
const DATA_CACHE = `kaoyan408-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/store.js',
  './js/srs.js',
  './js/bank.js',
  './js/recommend.js',
  './js/stats.js',
  './js/sync.js',
  './data/subjects.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个缓存，缺哪个图标都不至于让整个安装失败
    await Promise.all(SHELL_ASSETS.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { /* 忽略缺失资源 */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('kaoyan408-') && k !== SHELL_CACHE && k !== DATA_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域（GitHub API / CDN）交给浏览器

  // 题库文件：网络优先，保证推送到 GitHub 的新题目能及时生效
  if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // 页面导航：网络优先，失败回落缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', res.clone());
        return res;
      } catch (_) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 其它静态资源：缓存优先 + 后台更新
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    const shell = await caches.open(SHELL_CACHE);
    const fallback = await shell.match(req);
    if (fallback) return fallback;
    return new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fetching) || Response.error();
}
