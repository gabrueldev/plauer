// Service worker: deixa o app abrir sem internet.
// Arquivos do site: rede primeiro (sempre a versão mais nova), cache se estiver offline.
// Capas e fontes: cache primeiro (não mudam).
const SHELL = "shell-v2", COVERS = "covers-v1", FONTS = "fonts-v1";
const SHELL_FILES = ["./", "style.css", "app.js"];
const MAX_COVERS = 400;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![SHELL, COVERS, FONTS].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith("/search")) return; // busca nunca vai para o cache
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (url.hostname === "i.ytimg.com") e.respondWith(cacheFirst(req, COVERS, MAX_COVERS));
  else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(cacheFirst(req, FONTS));
  // o resto (player do YouTube, busca) vai direto para a rede
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("./")) ?? Response.error();
    return Response.error();
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // só guarda respostas CORS (as opacas ocupam ~7 MB cada na cota do navegador)
    if (res.ok) {
      await cache.put(req, res.clone());
      if (max) trim(cache, max);
    }
    return res;
  } catch {
    return Response.error();
  }
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
}
