"use strict";

// A busca (/search) mora no mesmo Worker que serve o site.
// Só quando a página vem de outro servidor local (ex.: python na 5391) ela aponta para o Worker local.
const SEARCH_URL = location.hostname.endsWith("localhost") && location.port !== "8788" ? "http://localhost:8788" : "";

/* ---------- Estado (localStorage) ---------- */
// Toda leitura/escrita passa por aqui; o resto do app não sabe onde os dados ficam.
const KEY = "player:v1";
const EMPTY = () => ({ lib: [], queue: [], current: null, volume: 80, muted: false, repeat: "off", showVideo: null });
const store = {
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (!s || !Array.isArray(s.lib)) return EMPTY();
      return {
        lib: s.lib,
        queue: Array.isArray(s.queue) ? s.queue : [],
        current: s.current ?? null,
        volume: Number.isFinite(s.volume) ? s.volume : 80,
        muted: !!s.muted,
        repeat: ["all", "one"].includes(s.repeat) ? s.repeat : "off",
        showVideo: typeof s.showVideo === "boolean" ? s.showVideo : null, // null = decide pelo tamanho da tela
      };
    } catch { return EMPTY(); }
  },
  save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} },
};

let state = store.load();
const save = () => store.save(state);
const byId = id => state.lib.find(t => t.id === id);
const cur = () => byId(state.current);

/* ---------- DOM ---------- */
const $ = s => document.querySelector(s);
const root = document.documentElement;
const device = $("#device"), well = $("#well"), wellImg = $("#wellImg"), auraImg = $("#auraImg");
const playBtn = $("#playBtn"), prevBtn = $("#prevBtn"), nextBtn = $("#nextBtn"), repeatBtn = $("#repeatBtn");
const muteBtn = $("#muteBtn"), volumeEl = $("#volume");
const tab = $("#tab"), qCount = $("#qCount"), queueList = $("#queueList"), queueEmpty = $("#queueEmpty");
const titleEl = $("#title"), artistEl = $("#artist");
const progress = $("#progress"), timeCur = $("#timeCur"), timeDur = $("#timeDur");
const libList = $("#libList"), libEmpty = $("#libEmpty");
const addBtn = $("#addBtn"), dialog = $("#addDialog"), form = $("#addForm");
const linkInput = $("#linkInput"), nameInput = $("#nameInput"), formErr = $("#formErr");
const searchStatus = $("#searchStatus"), resultsEl = $("#results");
const saveBtn = $("#saveBtn"), cancelBtn = $("#cancelBtn");
const exportBtn = $("#exportBtn"), importBtn = $("#importBtn"), importFile = $("#importFile");
const toastEl = $("#toast");

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const wait = ms => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const thumb = vid => `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;

/* ---------- YouTube: ID e metadados ---------- */
function parseId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : "https://" + s);
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    let id = null;
    if (h === "youtu.be") id = u.pathname.slice(1, 12);
    else if (h.endsWith("youtube.com") || h.endsWith("youtube-nocookie.com")) {
      id = u.searchParams.get("v") ?? u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/)?.[2];
    }
    return /^[\w-]{11}$/.test(id ?? "") ? id : null;
  } catch { return null; }
}

const metaCache = new Map();
async function fetchMeta(vid) {
  if (metaCache.has(vid)) return metaCache.get(vid);
  const url = encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`);
  for (const ep of [`https://www.youtube.com/oembed?format=json&url=${url}`, `https://noembed.com/embed?url=${url}`]) {
    try {
      const r = await fetch(ep);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.title) {
        const meta = { title: j.title, author: j.author_name ?? "" };
        metaCache.set(vid, meta);
        return meta;
      }
    } catch {}
  }
  return null;
}

/* ---------- Cor da capa ---------- */
// 1) cor que mais aparece (histograma de matiz, priorizando cores vivas)
// 2) capa quase sem cor → média da borda da imagem
// 3) canvas bloqueado → proxy com CORS; se nada der, cor derivada do ID
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function boost(r, g, b) {
  let [h, s, l] = rgbToHsl(r, g, b);
  s = s < .08 ? .06 : Math.max(s, .55); // cinza continua cinza, cor ganha força
  l = Math.min(Math.max(l, .38), .6);
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function dominantColor(d, w, h) {
  const N = 24, bins = Array.from({ length: N }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (s < .2 || l < .12 || l > .9) continue;
    const wt = s * (1 - Math.abs(l - .5) * 1.4);
    const bin = bins[Math.floor(hh / (360 / N)) % N];
    bin.w += wt; bin.r += d[i] * wt; bin.g += d[i + 1] * wt; bin.b += d[i + 2] * wt;
    total += wt;
  }
  if (total / (w * h) < .05) return null;
  let best = 0, bestScore = -1;
  for (let i = 0; i < N; i++) {
    const score = bins[i].w + .5 * (bins[(i + N - 1) % N].w + bins[(i + 1) % N].w);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  let r = 0, g = 0, b = 0, ww = 0;
  for (const j of [best - 1, best, best + 1]) {
    const x = bins[(j + N) % N];
    r += x.r; g += x.g; b += x.b; ww += x.w;
  }
  return boost(r / ww, g / ww, b / ww);
}

function edgeColor(d, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x > 1 && x < w - 2 && y > 1 && y < h - 2) continue;
    const i = (y * w + x) * 4;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  return boost(r / n, g / n, b / n);
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function fallbackColor(vid) {
  let h = 0;
  for (const c of vid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 50%)`;
}

async function getColor(vid) {
  const sources = [thumb(vid), `https://images.weserv.nl/?url=i.ytimg.com/vi/${vid}/mqdefault.jpg&w=64`];
  for (const src of sources) {
    try {
      const img = await loadImg(src);
      const w = 48, h = 27;
      const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data; // lança erro se o canvas estiver bloqueado
      return dominantColor(d, w, h) ?? edgeColor(d, w, h);
    } catch {}
  }
  return fallbackColor(vid);
}

const NEUTRAL = "hsl(240 6% 62%)";
const applyAccent = t => root.style.setProperty("--accent", t?.color ?? NEUTRAL);

/* ---------- Player invisível (IFrame API) ---------- */
let player, ready = false, wantPlay = false;

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("yt", {
    width: "100%", height: "100%",
    playerVars: { playsinline: 1, controls: 0, rel: 0, disablekb: 1, iv_load_policy: 3 },
    events: {
      onReady: () => {
        ready = true;
        applyVolume();
        const t = cur();
        if (!t) return;
        if (wantPlay) player.loadVideoById(t.vid);
        else player.cueVideoById(t.vid);
        wantPlay = false;
      },
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING) setPlaying(true);
        if (e.data === YT.PlayerState.PAUSED) setPlaying(false);
        if (e.data === YT.PlayerState.ENDED) {
          if (state.repeat === "one") { player.seekTo(0, true); player.playVideo(); }
          else next();
        }
      },
      onError: e => {
        // sem internet o vídeo falha, mas não está bloqueado: não pula a fila
        if (!navigator.onLine) { wantPlay = true; setPlaying(false); return toast(OFFLINE_MSG); }
        toast([101, 150].includes(e.data) ? "Esse vídeo não permite tocar fora do YouTube" : "Não deu para tocar esse vídeo");
        setTimeout(() => next(false), 1200); // não devolve à fila, senão o "repetir fila" ficaria preso nele
      },
    },
  });
};
// chamado depois de definir o callback, para não ter corrida; offline, tenta de novo quando a rede voltar
function loadYT() {
  if (window.YT?.Player || document.getElementById("yt-api")) return;
  const tag = Object.assign(document.createElement("script"), { id: "yt-api", src: "https://www.youtube.com/iframe_api" });
  tag.onerror = () => tag.remove();
  document.head.append(tag);
}
loadYT();

/* ---------- Offline ---------- */
const OFFLINE_MSG = "Sem internet: o som do YouTube volta quando a conexão voltar";
const netPill = $("#netPill");
const renderNet = () => { netPill.hidden = navigator.onLine; };
addEventListener("offline", renderNet);
addEventListener("online", () => {
  renderNet();
  loadYT();
  if (ready && wantPlay && cur()) { wantPlay = false; player.loadVideoById(cur().vid); }
});
renderNet();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

function setPlaying(v) {
  root.classList.toggle("is-playing", v);
  playBtn.setAttribute("aria-label", v ? "Pausar" : "Tocar");
}

function togglePlay() {
  if (!state.current) { if (state.queue.length) next(); return; }
  if (!navigator.onLine) return toast(OFFLINE_MSG);
  if (!ready) { wantPlay = !wantPlay; return; }
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
  else player.playVideo();
}

/* ---------- Fila ---------- */
function playNow(t) {
  state.current = t.id; save();
  applyAccent(t);
  renderAll();
  if (!navigator.onLine) { wantPlay = true; toast(OFFLINE_MSG); }
  else if (ready) player.loadVideoById(t.vid);
  else wantPlay = true;
}

function enqueue(t) {
  if (!state.current) return playNow(t);
  state.queue.push(t.id); save();
  renderQueue(); renderLibrary();
}

// requeue: no "repetir fila", a música atual volta para o fim da fila
function next(requeue = true) {
  if (requeue && state.repeat === "all" && state.current) state.queue.push(state.current);
  let id;
  while ((id = state.queue.shift()) && !byId(id));
  if (id) return playNow(byId(id));
  state.current = null; save();
  if (ready) player.stopVideo();
  setPlaying(false);
  applyAccent(null);
  renderAll();
}

function restart() {
  if (ready && state.current) player.seekTo(0, true);
}

function removeTrack(id) {
  state.lib = state.lib.filter(t => t.id !== id);
  state.queue = state.queue.filter(q => q !== id);
  if (state.current === id) return next(false);
  save(); renderAll();
}

/* ---------- Repetir ---------- */
const REPEAT_NEXT = { off: "all", all: "one", one: "off" };
const REPEAT_LABEL = { off: "Repetir desligado", all: "Repetir fila", one: "Repetir esta música" };
function renderRepeat() {
  repeatBtn.dataset.mode = state.repeat;
  repeatBtn.setAttribute("aria-pressed", state.repeat !== "off");
  repeatBtn.setAttribute("aria-label", REPEAT_LABEL[state.repeat]);
  repeatBtn.title = REPEAT_LABEL[state.repeat];
}
repeatBtn.addEventListener("click", () => {
  state.repeat = REPEAT_NEXT[state.repeat];
  save(); renderRepeat();
  toast(REPEAT_LABEL[state.repeat]);
});

/* ---------- Volume ---------- */
function applyVolume() {
  const v = state.muted ? 0 : state.volume;
  volumeEl.style.setProperty("--p", v / 100);
  volumeEl.setAttribute("aria-valuenow", v);
  volumeEl.setAttribute("aria-valuetext", `${v}%`);
  muteBtn.dataset.level = v === 0 ? "mute" : v < 50 ? "low" : "high";
  muteBtn.setAttribute("aria-label", v === 0 ? "Ativar som" : "Silenciar");
  if (!ready) return;
  player.setVolume(state.volume);
  state.muted ? player.mute() : player.unMute();
}
function setVolume(v, persist = true) {
  state.volume = Math.round(Math.min(100, Math.max(0, v)));
  state.muted = state.volume === 0;
  applyVolume();
  if (persist) save();
}
muteBtn.addEventListener("click", () => {
  if (state.muted || state.volume === 0) {
    state.muted = false;
    if (!state.volume) state.volume = 50;
  } else state.muted = true;
  applyVolume(); save();
});

/* ---------- Render ---------- */
function setCover(img, vid) {
  if (img.dataset.vid === vid) return;
  img.dataset.vid = vid;
  // tenta a capa grande; se não existir (404 ou placeholder 120×90), usa a média
  img.onload = () => { if (img.naturalWidth === 120) { img.onload = null; img.src = thumb(vid); } };
  img.onerror = () => { img.onerror = null; img.src = thumb(vid); };
  img.src = `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`;
}

function renderWell() {
  const t = cur();
  well.classList.toggle("empty", !t);
  device.classList.toggle("has-track", !!t);
  videoDock.classList.toggle("has-track", !!t);
  if (t) {
    setCover(wellImg, t.vid);
    setCover(auraImg, t.vid);
    titleEl.textContent = t.name;
    artistEl.textContent = t.author || " ";
  } else {
    delete wellImg.dataset.vid;
    titleEl.textContent = "Nada tocando";
    artistEl.textContent = " ";
    setProgress(0, 0, 0);
  }
}

function renderLibrary() {
  const pos = {};
  state.queue.forEach((id, i) => { pos[id] ??= i + 1; });
  libEmpty.hidden = state.lib.length > 0;
  libList.innerHTML = state.lib.map(t => `
    <li class="cover-item${t.id === state.current ? " current" : ""}" data-id="${t.id}">
      <button class="cover" aria-label="${esc(t.name)}" title="${esc(t.name)}">
        <img src="${thumb(t.vid)}" crossorigin="anonymous" alt="" width="100" height="100" loading="lazy">
      </button>
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
      ${pos[t.id] ? `<span class="badge">${pos[t.id]}</span>` : ""}
      <button class="remove liquid-glass liquid-glass--round" aria-label="Remover ${esc(t.name)}">×</button>
    </li>`).join("");
}

function queueRow(t, i) {
  return `<li data-i="${i}">
    <img class="q-thumb" src="${thumb(t.vid)}" crossorigin="anonymous" alt="">
    <span>${esc(t.name)}</span>
    <button class="q-remove" aria-label="Tirar da fila">×</button>
  </li>`;
}

function renderQueue() {
  queueList.innerHTML = state.queue.map((id, i) => byId(id) ? queueRow(byId(id), i) : "").join("");
  queueEmpty.hidden = state.queue.length > 0;
  qCount.textContent = state.queue.length;
}

function renderAll() { renderWell(); renderLibrary(); renderQueue(); }

/* ---------- Vídeo no canto ---------- */
// Visível por padrão; em tela estreita começa recolhido para não cobrir os controles.
const videoDock = $("#videoDock"), dockTab = $("#dockTab");
const narrowScreen = matchMedia("(max-width: 1100px)");
const videoShown = () => state.showVideo ?? !narrowScreen.matches;
function renderDock() {
  const shown = videoShown();
  videoDock.classList.toggle("collapsed", !shown);
  dockTab.setAttribute("aria-expanded", shown);
  dockTab.setAttribute("aria-label", shown ? "Esconder vídeo" : "Mostrar vídeo");
  dockTab.title = shown ? "Esconder vídeo" : "Mostrar vídeo";
}
dockTab.addEventListener("click", () => { state.showVideo = !videoShown(); save(); renderDock(); });
narrowScreen.addEventListener("change", renderDock);
renderDock();

/* ---------- Gaveta ---------- */
let drawerPinned = false, drawerTimer;
function openDrawer(pinned = false) {
  clearTimeout(drawerTimer);
  drawerPinned ||= pinned;
  device.classList.add("open");
  tab.setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  device.classList.remove("open");
  drawerPinned = false;
  tab.setAttribute("aria-expanded", "false");
}
tab.addEventListener("click", () => device.classList.contains("open") ? closeDrawer() : openDrawer(true));

// linha fantasma no fim da fila: é o destino da capa voando
function nextSlotRect() {
  queueEmpty.hidden = true;
  queueList.insertAdjacentHTML("beforeend", `<li class="ghost"><span class="q-thumb"></span><span></span></li>`);
  queueList.scrollTop = queueList.scrollHeight;
  return queueList.lastElementChild.querySelector(".q-thumb").getBoundingClientRect();
}

/* ---------- Animação: capa voando ---------- */
async function fly(fromEl, toRect, src) {
  if (reducedMotion.matches) return null;
  const a = fromEl.getBoundingClientRect();
  const clone = Object.assign(document.createElement("img"), { crossOrigin: "anonymous", src, alt: "" });
  Object.assign(clone.style, {
    position: "fixed", left: a.left + "px", top: a.top + "px",
    width: a.width + "px", height: a.height + "px", margin: 0,
    objectFit: "cover", borderRadius: "16px", zIndex: 100, pointerEvents: "none",
    transformOrigin: "top left", boxShadow: "0 20px 50px rgba(17,17,22,.35)",
  });
  document.body.append(clone);
  const dx = toRect.left - a.left, dy = toRect.top - a.top;
  const s = toRect.width / a.width;
  await clone.animate([
    { transform: "translate(0,0) scale(1)" },
    { transform: `translate(${dx * .5}px, ${dy * .5 - 80}px) scale(${(1 + s) / 2}) rotate(-6deg)`, offset: .5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
  ], { duration: 700, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }).finished;
  return clone;
}

let flying = false;
async function onCoverClick(t, el) {
  if (state.current === t.id) return togglePlay();
  if (flying) return;
  flying = true;
  try {
    if (!state.current) {
      const clone = await fly(el, well.getBoundingClientRect(), thumb(t.vid));
      playNow(t);
      await wellImg.decode?.().catch(() => {});
      clone?.remove();
    } else {
      const wasOpen = device.classList.contains("open");
      openDrawer();
      if (!wasOpen && !reducedMotion.matches) await wait(450); // espera a gaveta abrir
      const clone = await fly(el, nextSlotRect(), thumb(t.vid));
      enqueue(t);
      clone?.remove();
      if (!drawerPinned) drawerTimer = setTimeout(closeDrawer, 1200);
    }
  } finally { flying = false; }
}

/* ---------- Eventos ---------- */
libList.addEventListener("click", e => {
  const item = e.target.closest(".cover-item");
  const t = item && byId(item.dataset.id);
  if (!t) return;
  if (e.target.closest(".remove")) return removeTrack(t.id);
  if (e.target.closest(".cover")) onCoverClick(t, item.querySelector(".cover img"));
});

queueList.addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  const i = +li.dataset.i;
  const [id] = state.queue.splice(i, 1);
  if (e.target.closest(".q-remove")) { save(); renderQueue(); renderLibrary(); return; }
  const t = byId(id);
  t ? playNow(t) : (save(), renderAll());
});

playBtn.addEventListener("click", togglePlay);
prevBtn.addEventListener("click", restart);
nextBtn.addEventListener("click", () => { if (state.current || state.queue.length) next(); });

document.addEventListener("keydown", e => {
  if (e.target.closest("input, textarea, dialog[open]")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) togglePlay();
  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.target.closest("[role=slider]")) {
    e.preventDefault();
    setVolume((state.muted ? 0 : state.volume) + (e.key === "ArrowUp" ? 5 : -5));
  }
});
document.addEventListener("keyup", e => {
  if (e.code === "Space" && !e.target.closest("input, textarea, dialog[open]")) e.preventDefault();
});

/* ---------- Sliders (progresso e volume) ---------- */
function slider(el, { enabled = () => true, onScrub, onCommit }) {
  let active = false, p = 0;
  const at = e => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  el.addEventListener("pointerdown", e => {
    if (!enabled()) return;
    active = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    onScrub(p = at(e));
  });
  el.addEventListener("pointermove", e => { if (active) onScrub(p = at(e)); });
  const end = () => {
    if (!active) return;
    active = false;
    el.classList.remove("dragging");
    onCommit?.(p);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  return { get active() { return active; } };
}

slider(volumeEl, {
  onScrub: p => setVolume(p * 100, false),
  onCommit: () => save(),
});
volumeEl.addEventListener("keydown", e => {
  const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
  if (!step) return;
  e.preventDefault();
  setVolume((state.muted ? 0 : state.volume) + step);
});
volumeEl.addEventListener("wheel", e => {
  e.preventDefault();
  setVolume((state.muted ? 0 : state.volume) + (e.deltaY < 0 ? 5 : -5));
}, { passive: false });

/* ---------- Progresso ---------- */
function setProgress(p, t, d) {
  progress.style.setProperty("--p", p);
  progress.setAttribute("aria-valuenow", Math.round(p * 100));
  progress.setAttribute("aria-valuetext", `${fmt(t)} de ${fmt(d)}`);
  timeCur.textContent = fmt(t);
  timeDur.textContent = fmt(d);
}

setInterval(() => {
  if (!ready || seekBar.active || !state.current || !player.getDuration) return;
  const d = player.getDuration() || 0, t = player.getCurrentTime() || 0;
  setProgress(d ? t / d : 0, t, d);
}, 250);

const seekBar = slider(progress, {
  enabled: () => ready && !!state.current,
  onScrub: p => { const d = player.getDuration() || 0; setProgress(p, p * d, d); },
  onCommit: p => player.seekTo(p * player.getDuration(), true),
});
progress.addEventListener("keydown", e => {
  if (!ready || !state.current || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  player.seekTo(Math.max(0, player.getCurrentTime() + (e.key === "ArrowRight" ? 5 : -5)), true);
});

/* ---------- Modal adicionar ---------- */
async function addTrack({ vid, name, author = "" }) {
  const existing = state.lib.find(t => t.vid === vid);
  if (existing) return existing;
  const t = { id: uid(), vid, name, author, color: await getColor(vid) };
  state.lib.push(t);
  save(); renderLibrary();
  libList.lastElementChild?.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "nearest", inline: "nearest" });
  return t;
}

// modo do modal: "link" (colou um link), "search" (digitou texto) ou "" (vazio)
const setMode = m => { dialog.dataset.mode = m; };
const looksLikeLink = s => /[/.]/.test(s) || (/^[\w-]{11}$/.test(s) && /[\d_-]/.test(s));

addBtn.addEventListener("click", () => {
  form.reset();
  setMode("");
  formErr.textContent = "";
  searchStatus.textContent = "";
  resultsEl.innerHTML = "";
  saveBtn.disabled = false;
  saveBtn.textContent = "Adicionar";
  dialog.showModal();
  linkInput.focus();
});
cancelBtn.addEventListener("click", () => dialog.close());

/* ---------- Pesquisa (Worker da pasta worker/) ---------- */
let searchTimer, searchSeq = 0, lastResults = [];
const searchCache = new Map();

async function searchYouTube(q) {
  const key = q.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);
  const r = await fetch(`${SEARCH_URL}/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`busca ${r.status}`);
  const { results } = await r.json();
  searchCache.set(key, results);
  return results;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  searchStatus.textContent = "Buscando…";
  try {
    const results = await searchYouTube(q);
    if (seq !== searchSeq) return; // chegou resposta de uma busca antiga
    searchStatus.textContent = results.length ? "" : "Nada encontrado";
    renderResults(results);
  } catch {
    if (seq !== searchSeq) return;
    searchStatus.textContent = navigator.onLine ? "Busca indisponível. O Worker de busca está rodando?" : "Sem internet para pesquisar";
    renderResults([]);
  }
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`;
const ICON_ADD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const ICON_OK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderResults(list) {
  lastResults = list;
  const have = new Set(state.lib.map(t => t.vid));
  resultsEl.innerHTML = list.map((r, i) => {
    const inLib = have.has(r.vid);
    return `<li data-i="${i}">
      <img src="${thumb(r.vid)}" crossorigin="anonymous" alt="" width="64" height="36" loading="lazy">
      <div class="r-text">
        <span class="r-title">${esc(r.title)}</span>
        <span class="r-sub">${esc([r.author, r.duration ?? "ao vivo"].filter(Boolean).join(" · "))}</span>
      </div>
      <button type="button" class="r-btn liquid-glass liquid-glass--round" data-act="play" aria-label="Tocar agora" title="Tocar agora">${ICON_PLAY}</button>
      <button type="button" class="r-btn liquid-glass liquid-glass--round" data-act="add" ${inLib ? "disabled" : ""}
        aria-label="${inLib ? "Já está na biblioteca" : "Adicionar à biblioteca"}" title="${inLib ? "Já está na biblioteca" : "Adicionar à biblioteca"}">${inLib ? ICON_OK : ICON_ADD}</button>
    </li>`;
  }).join("");
}

resultsEl.addEventListener("click", async e => {
  const btn = e.target.closest("[data-act]");
  const r = btn && lastResults[+btn.closest("li").dataset.i];
  if (!r) return;
  btn.disabled = true;
  const t = await addTrack({ vid: r.vid, name: r.title, author: r.author });
  if (btn.dataset.act === "play") { dialog.close(); playNow(t); }
  else renderResults(lastResults);
});

linkInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  formErr.textContent = "";
  const raw = linkInput.value.trim();
  if (!raw) { setMode(""); searchStatus.textContent = ""; resultsEl.innerHTML = ""; return; }
  if (looksLikeLink(raw)) { setMode("link"); searchStatus.textContent = ""; return; }
  setMode("search");
  if (raw.length >= 2) searchTimer = setTimeout(() => runSearch(raw), 450);
});

async function autofillName() {
  const raw = linkInput.value.trim();
  if (!raw || dialog.dataset.mode !== "link") return;
  const vid = parseId(raw);
  if (!vid) { formErr.textContent = "Link do YouTube inválido"; return; }
  formErr.textContent = "";
  if (nameInput.value.trim()) return;
  nameInput.placeholder = "Buscando nome…";
  const meta = await fetchMeta(vid);
  if (meta && !nameInput.value.trim() && parseId(linkInput.value) === vid) nameInput.value = meta.title;
  nameInput.placeholder = "Nome da música";
}
linkInput.addEventListener("paste", () => setTimeout(autofillName, 0));
linkInput.addEventListener("blur", autofillName);

form.addEventListener("submit", async e => {
  e.preventDefault();
  if (dialog.dataset.mode === "search") { // Enter na pesquisa: busca na hora
    clearTimeout(searchTimer);
    runSearch(linkInput.value.trim());
    return;
  }
  const vid = parseId(linkInput.value);
  if (!vid) { formErr.textContent = "Link do YouTube inválido"; linkInput.focus(); return; }
  saveBtn.disabled = true;
  saveBtn.textContent = "Adicionando…";
  const meta = await fetchMeta(vid);
  const name = nameInput.value.trim() || meta?.title;
  if (!name) {
    formErr.textContent = "Dê um nome para a música";
    saveBtn.disabled = false; saveBtn.textContent = "Adicionar";
    nameInput.focus();
    return;
  }
  if (state.lib.some(t => t.vid === vid)) toast("Essa música já está na biblioteca");
  await addTrack({ vid, name, author: meta?.author ?? "" });
  dialog.close();
});

/* ---------- Exportar / importar ---------- */
exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "plauer.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.lib)) throw 0;
    const have = new Set(state.lib.map(t => t.vid));
    const fresh = data.lib.filter(t => t && /^[\w-]{11}$/.test(t.vid) && !have.has(t.vid))
      .map(t => ({ id: uid(), vid: t.vid, name: String(t.name || t.vid), author: String(t.author || ""), color: t.color || fallbackColor(t.vid) }));
    state.lib.push(...fresh);
    save(); renderLibrary();
    toast(fresh.length ? `${fresh.length} música${fresh.length > 1 ? "s" : ""} importada${fresh.length > 1 ? "s" : ""}` : "Nenhuma música nova no arquivo");
  } catch { toast("Arquivo inválido"); }
});

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

/* ---------- Início ---------- */
state.queue = state.queue.filter(byId);
if (!cur()) state.current = null;
save();
applyAccent(cur());
applyVolume();
renderRepeat();
renderAll();

// músicas antigas sem cor calculada
(async () => {
  let changed = false;
  for (const t of state.lib.filter(t => !t.color)) { t.color = await getColor(t.vid); changed = true; }
  if (changed) { save(); applyAccent(cur()); }
})();
