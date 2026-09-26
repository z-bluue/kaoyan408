/* ===========================================================
   Service Worker —— 应用外壳离线可用，题库走网络优先
   改动静态资源后，把 VERSION 加一即可让手机端拿到新版本
   =========================================================== */
const VERSION = 'v1.2.2';
const SHELL_CACHE = `kaoyan408-shell-${VERSION}`;
const DATA_CACHE = `kaoyan408-data-${VERSION}`;
// 配图单独放一个不跟版本号走的缓存：图片基本不变，版本升级不该让用户重下 8.8 MB。
// 真要强制换图（比如书里改了图），把这里的 v1 加一即可。
const FIG_CACHE = 'kaoyan408-figures-v1';
const FIGURE_LIST = './data/figures.json';   // 由 tools/bank_tool.py build 生成

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
  // app.js 会静态 import 这两个模块，不预缓存的话首次离线启动会白屏
  './js/ai.js',
  './js/autoai.js',
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
    self.skipWaiting();              // 外壳就绪就立刻激活，不被配图拖住
    await precacheFigures();         // 再慢慢补配图（可中断，下次接着补）
  })());
});

/**
 * 把题库里引用到的插图全部抓进图库。
 * 已缓存的不再下 → 重复安装/中断后继续都是廉价的；限并发，避免手机一次性开几百个连接。
 */
async function precacheFigures() {
  let files = [];
  try {
    const res = await fetch(FIGURE_LIST, { cache: 'no-cache' });
    if (!res.ok) return;
    files = (await res.json()).files || [];
  } catch (_) {
    return;                        // 拿不到清单就算了，看图时还会按需缓存
  }

  const cache = await caches.open(FIG_CACHE);
  const todo = [];
  for (const f of files) {
    const url = new URL(f, self.location).href;
    if (!(await cache.match(url))) todo.push(url);
  }
  if (!todo.length) return;

  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const url = todo[i++];
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (_) { /* 单张失败不影响其它 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('kaoyan408-') && k !== SHELL_CACHE && k !== DATA_CACHE && k !== FIG_CACHE)
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

  // 配图：缓存优先（预缓存过的直接命中，不断网也秒开）
  if (req.destination === 'image' || /\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname)) {
    event.respondWith(cacheFirstFigure(req));
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

/** 图片：图库 → 外壳缓存 → 网络，命中就不请求网络 */
async function cacheFirstFigure(req) {
  const fig = await caches.open(FIG_CACHE);
  const hit = await fig.match(req);
  if (hit) return hit;

  const shell = await caches.open(SHELL_CACHE);
  const shellHit = await shell.match(req);
  if (shellHit) return shellHit;

  try {
    const res = await fetch(req);
    if (res && res.ok) await fig.put(req, res.clone());
    return res;
  } catch (_) {
    return Response.error();
  }
}
