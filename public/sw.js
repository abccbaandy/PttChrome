// 開站快取（docs/open-cache.md）：Service Worker，只做兩件事。
//
//   1. 網頁本身（導航請求）：一律先問網路（navigation preload 跟 SW 開機並行），拿到就用、
//      順手存一份；網路斷了或回 5xx 才拿存的那份 ⇒ 每次開到的都是最新版，不需要「有新版
//      請重新整理」的提示。
//   2. 網頁列出的帶 hash 檔（Vite 產的 assets/<名>-<hash>.<副檔名>）：檔名一樣內容就一定一樣
//      ⇒ 有就直接用、一個都不問；沒有才下載並存起來。
//
// 其他請求（manifest、圖示、sw.js 自己、跨站的圖床／Firebase／WebSocket）一律不碰，交給瀏覽器。
//
// GitHub Pages 只給 `Cache-Control: max-age=600` 而且改不了 ⇒ 不靠 SW 的話，過了 10 分鐘
// 每次開站都要逐檔問「有沒有變」，而且是串連的（網頁 → 主 JS → 轉碼表／字型）。
//
// 清理：網頁列出的檔案清單換了（新 build）才清，清掉「新網頁沒列出」的檔。lazy chunk 不在
// 網頁清單裡，所以每次部署後第一次用到會再下載一次（換一次而已，不會每次開站都下載）。
//
// 開關（pref enableOpenCache）在頁面端：關掉＝unregister＋刪掉 CACHE_PREFIX 開頭的 cache
// （src/js/open_cache.js）。dev server 不註冊。
//
// 這支檔案是 classic script（不經 Vite 打包，public/ 原樣複製）；行為守護在
// tests/unit/open_cache_sw.test.js（node vm 裡載入本檔，假的 caches／fetch）。

/* eslint-env serviceworker */

var CACHE_PREFIX = 'pttchrome-open-cache-';
var CACHE_NAME = CACHE_PREFIX + 'v1';
// 存「上次看到的網頁列出哪些檔」，用來判斷換 build 了沒。不是真的網址，只拿來當 key。
var BUILD_KEY = '__pttchrome_open_cache_build__';
// Vite 預設 assetFileNames／chunkFileNames：assets/<名>-<8 字 hash>.<副檔名>。
// `.js.map` 這類多段副檔名不吃（只有開發者工具會抓），交給瀏覽器。
var ASSET_RE = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
// 比對一律忽略 Vary：同一個帶 hash 的檔，頁面的 crossorigin 請求會帶 Origin、這裡自己補抓的
// 不帶；伺服器只要回 `Vary: Origin`（vite preview 就是）兩邊就永遠對不上，每次都重抓。
// 檔名已經決定內容，Vary 對這些檔沒有意義。
var MATCH = { cacheName: CACHE_NAME, ignoreVary: true };

function scopeUrl() {
  return self.registration.scope;
}

// scope 底下的相對路徑；不在 scope 底下回 null。
function relPath(url) {
  var scope = scopeUrl();
  var href = url.split('#')[0].split('?')[0];
  if (href.indexOf(scope) !== 0) return null;
  return href.slice(scope.length);
}

function isAssetPath(rel) {
  return rel != null && ASSET_RE.test(rel);
}

function isPagePath(rel) {
  return rel === '' || rel === 'index.html';
}

// 網頁裡 src／href 指到的帶 hash 檔（相對 scope 的路徑），去重、照出現順序。
function listedAssets(html) {
  var out = [];
  var re = /\s(?:src|href)="(?:\.\/)?(assets\/[^"]+)"/g;
  var m;
  while ((m = re.exec(html))) {
    if (isAssetPath(m[1]) && out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

function usable(res) {
  return !!res && res.ok && res.type === 'basic';
}

// 網頁換成 html 這一版：補存它列出、還沒存的檔；清單跟上次不同（新 build）才清掉舊檔。
// 任何一步失敗都只是少存一點，不影響這次開站。
function syncBuild(html) {
  var assets = listedAssets(html);
  if (!assets.length) return Promise.resolve();
  var scope = scopeUrl();
  var signature = assets.join('\n');
  return caches.open(CACHE_NAME).then(function(cache) {
    return cache.match(scope + BUILD_KEY)
      .then(function(prev) { return prev ? prev.text() : null; })
      .then(function(prevSignature) {
        var prune = prevSignature !== null && prevSignature !== signature
          ? cache.keys().then(function(keys) {
            return Promise.all(keys.map(function(req) {
              var rel = relPath(req.url);
              if (isAssetPath(rel) && assets.indexOf(rel) < 0) return cache.delete(req);
              return null;
            }));
          })
          : Promise.resolve();
        return prune;
      })
      .then(function() {
        return Promise.all(assets.map(function(rel) {
          var url = scope + rel;
          return cache.match(url, MATCH).then(function(hit) {
            if (hit) return null;
            return fetch(url).then(function(res) {
              if (usable(res)) return cache.put(url, res);
              return null;
            });
          }).catch(function() {});
        }));
      })
      .then(function() {
        return cache.put(scope + BUILD_KEY, new Response(signature));
      });
  }).catch(function() {});
}

function handlePage(event) {
  var scope = scopeUrl();
  var network = Promise.resolve(event.preloadResponse)
    .then(function(preloaded) { return preloaded || fetch(event.request); });
  return network.then(function(res) {
    if (usable(res)) {
      var copy = res.clone();
      event.waitUntil(copy.text().then(function(html) {
        return caches.open(CACHE_NAME)
          .then(function(cache) { return cache.put(scope, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })); })
          .then(function() { return syncBuild(html); });
      }).catch(function() {}));
      return res;
    }
    // 4xx 照原樣給（網址打錯不該拿首頁蓋過去）；5xx（Pages 掛了）才退回存的那份。
    if (res && res.status < 500) return res;
    return caches.match(scope, MATCH).then(function(cached) { return cached || res; });
  }, function(err) {
    return caches.match(scope, MATCH).then(function(cached) {
      if (cached) return cached;
      throw err;
    });
  });
}

function handleAsset(request) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return cache.match(request, MATCH).then(function(hit) {
      if (hit) return hit;
      return fetch(request).then(function(res) {
        if (usable(res)) cache.put(request, res.clone()).catch(function() {});
        return res;
      });
    });
  });
}

self.addEventListener('install', function(event) {
  self.skipWaiting();
  // 第一次裝好時，這一頁的檔案都已經在瀏覽器的 HTTP 快取裡 ⇒ 照網頁清單存一份，
  // 下一次開站就直接用。
  event.waitUntil(
    fetch(scopeUrl())
      .then(function(res) { return usable(res) ? res.text() : null; })
      .then(function(html) { return html ? syncBuild(html) : null; })
      .catch(function() {})
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(Promise.all([
    // 網頁請求跟 SW 開機並行，不用等 SW 醒來才開始下載。
    self.registration.navigationPreload
      ? self.registration.navigationPreload.enable().catch(function() {})
      : null,
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) {
        if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME) return caches.delete(name);
        return null;
      }));
    }),
  ]).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var rel = relPath(request.url);
  if (rel == null) return;
  if (request.mode === 'navigate') {
    if (isPagePath(rel)) event.respondWith(handlePage(event));
    return;
  }
  if (isAssetPath(rel) && !request.headers.get('range')) event.respondWith(handleAsset(request));
});
