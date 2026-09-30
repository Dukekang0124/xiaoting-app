// 墨小溟 · Service Worker（离线缓存）
// 版本号位置 2/5：改版本须与 index.html 的 APP_VERSION、manifest、package.json、js/app.js 兜底同步
// （见作品集 00-文档写作与版本约定 §2.2）
const CACHE = 'xiaoting-v1.1.2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/app.js',
  './js/store.js',
  './js/ip.js',
  './js/ai.js',
  './js/api.js',
  './js/llm.js',
  './js/asr.js',
  './js/config.js',
  './js/router.js',
  './js/prompts.js',
  './js/update.js',
  './js/voice.js',
  './js/native-asr.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 只接管本站静态资源。两类例外一律直连网络：
  //   ① 数据面 /.cloud/**（模型目录 /models 是 GET）—— 缓存住就看不到服务端换模型，且等于绕过服务端；
  //   ② 自建后端 /api/**（/api/health、/api/stats）—— 缓存住会让"能不能用语音"的判断永远停在旧结果。
  // 两者都靠 CACHE 名失效，没有 TTL，所以必须显式排除而不是指望它过期。
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.cloud/') || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
