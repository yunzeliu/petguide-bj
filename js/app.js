// ===== state =====
const STATE = {
  routes: [],       // route metadata list
  routesById: {},   // id -> route
  pois: {},         // id -> poi
  cities: [],       // [{key, name, count}]
  mdCache: {},      // slug -> markdown string
  loaded: false,
  userLoc: null,    // {lat, lng} once geolocation granted
};

// ===== geolocation =====
const BEIJING_CENTER = { lat: 39.905, lng: 116.397 };  // 默认锚点：天安门
function loadUserLoc() {
  try {
    const s = sessionStorage.getItem('user-loc');
    if (s) STATE.userLoc = JSON.parse(s);
  } catch (e) {}
}
function requestLocation(force) {
  if (!navigator.geolocation) return Promise.resolve(null);
  if (!force && STATE.userLoc) return Promise.resolve(STATE.userLoc);
  if (!force && sessionStorage.getItem('loc-denied')) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        STATE.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        sessionStorage.setItem('user-loc', JSON.stringify(STATE.userLoc));
        sessionStorage.removeItem('loc-denied');
        resolve(STATE.userLoc);
      },
      err => {
        sessionStorage.setItem('loc-denied', '1');
        resolve(null);
      },
      { timeout: 8000, maximumAge: 600000, enableHighAccuracy: false }
    );
  });
}
function distanceKm(p) {
  if (!STATE.userLoc || typeof p.lat !== 'number') return null;
  return haversineKm(STATE.userLoc, p);
}
function formatKm(km) {
  if (km == null) return '';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
function formatDriveMin(km) {
  // city driving ~25 km/h, road factor 1.4, + 5 min buffer (parking/pickup)
  if (km == null) return '';
  const m = Math.round(km * 1.4 / 25 * 60 + 5);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60 ? (m % 60) + ' 分' : ''}`.trim();
}
function distancePillHtml(p) {
  const km = distanceKm(p);
  if (km == null) return '';
  const drive = formatDriveMin(km);
  return `<span class="dist-pill">📍 ${formatKm(km)} · 🚗 ${drive}</span>`;
}

function currentCity() {
  return localStorage.getItem('city') || 'beijing';
}
function setCity(key) {
  localStorage.setItem('city', key);
}
function cityName(key) {
  const c = (STATE.cities || []).find(x => x.key === key);
  return c ? c.name : '北京';
}
const CITY_CENTER = {
  beijing:  { center: [39.93, 116.40], zoom: 10 },
  shanghai: { center: [31.23, 121.47], zoom: 10 },
  hangzhou: { center: [30.27, 120.15], zoom: 11 },
};

// ===== utils =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const toast = (msg) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
};

// ===== cover styling per category =====
const COVER = {
  season:     ['#FFD4B8', '#FF9F66', '🌸'],
  district:   ['#C8E6FF', '#8AB8FF', '🗺️'],
  'dog-type': ['#FFD9E6', '#FF99B8', '🐶'],
  cat:        ['#D4F5E1', '#7FCFA0', '☕'],
  default:    ['#FFE0D0', '#FFB890', '🐾'],
};
const SEASON_EMOJI = {
  spring: '🌸', summer: '🌊', autumn: '🍁', winter: '❄️',
  rainy: '🌧️', camping: '⛺', picnic: '🧺', morning: '🌅',
};
const CAT_EMOJI = {
  cafe: '☕', restaurant: '🍽️', hotel: '🏨', mall: '🛍️',
  petpark: '🐾', hike: '⛰️', water: '🌊', vet: '🏥', camp: '⛺',
};
const POI_ICON = {
  park: '🌳', cafe: '☕', restaurant: '🍽️', hotel: '🏨',
  petpark: '🐾', mall: '🛍️', hike: '⛰️', water: '🌊', vet: '🏥', camp: '⛺',
};
function coverFor(route) {
  const conf = COVER[route.category] || COVER.default;
  let emoji = conf[2];
  if (route.category === 'season') emoji = SEASON_EMOJI[route.dim] || emoji;
  if (route.category === 'cat')    emoji = CAT_EMOJI[route.dim] || emoji;
  return { from: conf[0], to: conf[1], emoji };
}

// ===== data loading =====
async function loadData() {
  if (STATE.loaded) return;
  const [routes, pois, citiesResp] = await Promise.all([
    fetch('data/routes.json').then(r => r.json()),
    fetch('data/pois.json').then(r => r.json()),
    fetch('data/cities.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  STATE.routes = routes;
  STATE.routesById = Object.fromEntries(routes.map(r => [r.id, r]));
  STATE.pois = pois;
  STATE.cities = citiesResp;
  STATE.loaded = true;
}

// Return only routes/pois belonging to the current city.
function cityRoutes() {
  const city = currentCity();
  return STATE.routes.filter(r => (r.city || 'beijing') === city);
}
function cityPois() {
  const city = currentCity();
  const out = {};
  for (const id in STATE.pois) {
    if ((STATE.pois[id].city || 'beijing') === city) out[id] = STATE.pois[id];
  }
  return out;
}
async function loadMd(slug) {
  if (STATE.mdCache[slug]) return STATE.mdCache[slug];
  const res = await fetch(`data/routes/${slug}.md`);
  if (!res.ok) return '';
  const text = await res.text();
  STATE.mdCache[slug] = text;
  return text;
}

// ===== POI cover image system =====
// 按 category 精选 Unsplash 真实照片（每个 POI 按 id 哈希确定性选一张）
// 全部为商业 free-to-use 的 CC0 图片
const COVER_PHOTOS = {
  park: [
    'photo-1517423440428-a5a00ad493e8', 'photo-1505761671935-60b3a7427bad',
    'photo-1500382017468-9049fed747ef', 'photo-1502318217862-8b9f08e1ed3a',
    'photo-1469474968028-56623f02e42e', 'photo-1441974231531-c6227db76b6e',
  ],
  cafe: [
    'photo-1495474472287-4d71bcdd2085', 'photo-1554118811-1e0d58224f24',
    'photo-1521017432531-fbd92d768814', 'photo-1453614512568-c4024d13c247',
    'photo-1559925393-8be0ec4767c8', 'photo-1442512595331-e89e73853f31',
  ],
  restaurant: [
    'photo-1517248135467-4c7edcad34c4', 'photo-1414235077428-338989a2e8c0',
    'photo-1555396273-367ea4eb4db5', 'photo-1559339352-11d035aa65de',
    'photo-1424847651672-bf20a4b0982b', 'photo-1592861956120-e524fc739696',
  ],
  hotel: [
    'photo-1455587734955-081b22074882', 'photo-1611892440504-42a792e24d32',
    'photo-1582719508461-905c673771fd', 'photo-1564501049412-61c2a3083791',
    'photo-1551776235-dde6d482980b', 'photo-1566073771259-6a8506099945',
  ],
  petpark: [
    'photo-1601758228041-f3b2795255f1', 'photo-1583512603805-3cc6b41f3edb',
    'photo-1530281700549-e82e7bf110d6', 'photo-1561037404-61cd46aa615b',
    'photo-1450778869180-41d0601e046e', 'photo-1568572933382-74d440642117',
  ],
  mall: [
    'photo-1568667056549-094345857637', 'photo-1481437156560-3205f6a55735',
    'photo-1519567241046-7f570eee3ce6', 'photo-1542222024-c39e2281f121',
    'photo-1546552768-9e3a94b38a59',
  ],
  hike: [
    'photo-1551632811-561732d1e306', 'photo-1465056836041-7f43ac27dcb5',
    'photo-1464822759023-fed622ff2c3b', 'photo-1486870591958-9b9d0d1dda99',
    'photo-1551632811-561732d1e306', 'photo-1551632811-561732d1e306',
  ],
  water: [
    'photo-1500382017468-9049fed747ef', 'photo-1505144808419-1957a94ca61e',
    'photo-1439066615861-d1af74d74000', 'photo-1559827260-dc66d52bef19',
    'photo-1551731409-43eb3e517a1a', 'photo-1503602642458-232111445657',
  ],
  vet: [
    'photo-1583337130417-3346a1be7dee', 'photo-1612531386530-97286d97c2d2',
    'photo-1576201836106-db1758fd1c97', 'photo-1583337130417-3346a1be7dee',
    'photo-1583337130417-3346a1be7dee', 'photo-1583337130417-3346a1be7dee',
  ],
  camp: [
    'photo-1504280390367-361c6d9f38f4', 'photo-1487730116645-74489c95b41b',
    'photo-1455763916899-e8b50eca9967', 'photo-1496080174650-637e3f22fa03',
    'photo-1444930694458-01babe71870e', 'photo-1496080174650-637e3f22fa03',
  ],
};

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function coverImageUrl(poi, w) {
  // 只用真实门店照片；没有就返回 null，前端走 emoji + 渐变（不放误导性占位图）
  return poi.photo_url || null;
}

// 8 套养宠人友好的暖色渐变，每个 POI 按 id 哈希确定性挑一套
const POI_PALETTES = [
  { from: '#FFD9C2', to: '#FF9F66' },   // 暖橙
  { from: '#FFEBC7', to: '#FFCB7A' },   // 蜂蜜黄
  { from: '#FFD5D8', to: '#FF95A2' },   // 樱花粉
  { from: '#FFE0CC', to: '#FFAA82' },   // 桃肉
  { from: '#E2F1D6', to: '#A6CC8B' },   // 抹茶绿
  { from: '#D9EBFF', to: '#92B8E8' },   // 雾蓝
  { from: '#EDDDFF', to: '#BFA0EE' },   // 薰衣紫
  { from: '#FFE5BC', to: '#F0B26C' },   // 焦糖
];
function poiPalette(poi) {
  return POI_PALETTES[hashCode(poi.id) % POI_PALETTES.length];
}
// 每个 category 对应的大插画 emoji（比小 icon 更出彩）
const CATEGORY_BIG = {
  park:       '🌳', water: '🏞️', hike: '⛰️', camp: '🏕️',
  cafe:       '☕', restaurant: '🍽️', hotel: '🏡', mall: '🛍️',
  petpark:    '🐕', vet: '🩺',
};
function bigCategoryGlyph(poi) {
  return CATEGORY_BIG[poi.category] || '🐾';
}

// ===== pet feature → display tags =====
const PET_FACILITY_LABEL = {
  grass_area:       '🌿 草坪',
  fenced_area:      '🚧 围栏',
  swimming_pool:    '🏊 宠物泳池',
  indoor_pet_zone:  '🏠 室内宠物区',
  outdoor_seating:  '🌳 户外位',
  pet_bathroom:     '🚽 宠物厕所',
  shower:           '🚿 冲洗',
  large_open_space: '🌅 大开放空间',
  tree_shade:       '🌴 树荫',
};
const PET_SERVICE_LABEL = {
  water_bowl:       '💧 水碗',
  free_treats:      '🦴 免费狗零食',
  pet_menu:         '🍽 宠物餐单',
  pet_dessert:      '🍰 宠物甜品',
  grooming_onsite:  '✂️ 美容',
  pet_sitter:       '👥 寄养',
  pet_photo:        '📷 宠物摄影',
};
function petTagsHtml(p, max) {
  if (max == null) max = 5;
  const f = p.pet_features;
  if (!f) return '';
  const tags = [];
  if (f.size_limit && f.size_limit.large_dog_allowed === true)  tags.push('🐕 大型犬OK');
  if (f.size_limit && f.size_limit.large_dog_allowed === false) tags.push('🐕 仅小中型');
  (f.facilities || []).forEach(k => { if (PET_FACILITY_LABEL[k]) tags.push(PET_FACILITY_LABEL[k]); });
  (f.services   || []).forEach(k => { if (PET_SERVICE_LABEL[k])  tags.push(PET_SERVICE_LABEL[k]); });
  if (f.access && f.access.diaper_required)     tags.push('🩴 需穿尿不湿');
  if (f.access && f.access.vaccination_proof)   tags.push('🆔 需免疫本');
  if (f.access && f.access.carrier_required)    tags.push('🎒 需航空箱');
  return tags.slice(0, max).map(t => `<span class="pet-tag">${escapeHtml(t)}</span>`).join('');
}
function petHookHtml(p) {
  const h = p.pet_features && p.pet_features.pet_hook;
  if (!h) return '';
  return `<div class="pet-hook">★ ${escapeHtml(h)}</div>`;
}

function petFeaturesHtml(p) {
  const f = p.pet_features;
  if (!f) return '';
  const rows = [];

  // facilities
  const fac = (f.facilities || []).map(k => PET_FACILITY_LABEL[k]).filter(Boolean);
  if (fac.length) rows.push(['🏗 设施', fac.join(' · ')]);

  // services
  const svc = (f.services || []).map(k => PET_SERVICE_LABEL[k]).filter(Boolean);
  if (svc.length) rows.push(['🐾 服务', svc.join(' · ')]);

  // size limit
  const sz = f.size_limit || {};
  const szParts = [];
  if (sz.large_dog_allowed === true) szParts.push('大型犬可');
  else if (sz.large_dog_allowed === false) szParts.push('仅小中型');
  if (sz.max_shoulder_height_cm) szParts.push(`肩高≤${sz.max_shoulder_height_cm}cm`);
  if (sz.banned_breeds && sz.banned_breeds.length) szParts.push(`禁: ${sz.banned_breeds.join('/')}`);
  if (szParts.length) rows.push(['🐕 体型政策', szParts.join(' · ')]);

  // access rules
  const a = f.access || {};
  const ruleParts = [];
  if (a.indoor_allowed === false || a.outdoor_only) ruleParts.push('仅户外');
  if (a.leash_required) ruleParts.push('必牵绳');
  if (a.diaper_required) ruleParts.push('需穿尿不湿');
  if (a.carrier_required) ruleParts.push('需航空箱');
  if (a.vaccination_proof) ruleParts.push('查免疫本');
  if (ruleParts.length) rows.push(['⚠ 准入规则', ruleParts.join(' · ')]);

  // fees
  const fees = f.fees || {};
  if (fees.pet_extra_fee && fees.pet_extra_fee !== 'null') {
    rows.push(['💰 宠物相关费用', String(fees.pet_extra_fee)]);
  }
  if (fees.sterilization_required) {
    rows.push(['ℹ️ 其它', '需绝育']);
  }

  // best / not for
  if (f.best_for && f.best_for.length) rows.push(['✅ 适合', f.best_for.join(' · ')]);
  if (f.not_for && f.not_for.length)   rows.push(['🚫 不适合', f.not_for.join(' · ')]);

  if (rows.length === 0) return '';
  return `
    <div class="section-title">宠物友好详情</div>
    <div class="md-body pet-features">
      ${rows.map(([k, v]) => `<div class="pf-row"><span class="pf-key">${escapeHtml(k)}</span><span class="pf-val">${escapeHtml(v)}</span></div>`).join('')}
    </div>
  `;
}

// ===== geo helpers =====
function haversineKm(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return 0;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ===== recommendation helpers =====
function parseYM(s) {
  // "2026-05" -> [2026, 5]; fallback to [0, 0]
  if (!s) return [0, 0];
  const m = String(s).match(/^(\d{4})-(\d{1,2})/);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}
function ymScore(s) {
  // higher = more recent
  const [y, m] = parseYM(s);
  return y * 12 + m;
}
function currentSeason() {
  // Beijing month → season
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5)  return { key: 'spring', cn: '春' };
  if (m >= 6 && m <= 8)  return { key: 'summer', cn: '夏' };
  if (m >= 9 && m <= 11) return { key: 'autumn', cn: '秋' };
  return { key: 'winter', cn: '冬' };
}
function getHotPois(n) {
  if (n == null) n = 12;
  return Object.values(STATE.pois)
    .filter(function(p) { return p.freshness && p.freshness.status === 'open' && p.freshness.latest_mention; })
    .map(function(p) {
      return {
        p: p,
        score: ymScore(p.freshness.latest_mention) * 10 + ((p.sources && p.sources.length) || 0) + ((p.route_slugs && p.route_slugs.length) || 0),
      };
    })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, n)
    .map(function(x) { return x.p; });
}
function getRecentlyOpened(n) {
  if (n == null) n = 12;
  const newRouteIds = new Set(
    cityRoutes()
      .filter(function(r) { return r.id.indexOf('new-') === 0 || r.id === 'xhs-trending-2025'; })
      .map(function(r) { return r.id; })
  );
  return Object.values(STATE.pois)
    .filter(function(p) { return (p.route_slugs || []).some(function(s) { return newRouteIds.has(s); }); })
    .sort(function(a, b) {
      const am = (a.freshness && a.freshness.latest_mention) || '';
      const bm = (b.freshness && b.freshness.latest_mention) || '';
      return ymScore(bm) - ymScore(am);
    })
    .slice(0, n);
}
function getSeasonalRoutes(n = 6) {
  const seasonCn = currentSeason().cn;
  return cityRoutes()
    .filter(r => r.verified !== false)
    .filter(r => (r.best_seasons || []).includes(seasonCn) || (r.tags || []).some(t => t.includes(seasonCn)))
    .slice(0, n);
}
function isRecentlyMentioned(p, monthsAgo) {
  if (monthsAgo == null) monthsAgo = 3;
  if (!p.freshness || !p.freshness.latest_mention) return false;
  const ym = parseYM(p.freshness.latest_mention);
  if (!ym[0]) return false;
  const target = new Date(ym[0], ym[1] - 1, 1);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);
  return target >= cutoff;
}

// ===== favorites (localStorage) =====
const favs = {
  get() { try { return JSON.parse(localStorage.getItem('favs') || '[]'); } catch { return []; } },
  set(arr) { localStorage.setItem('favs', JSON.stringify(arr)); },
  has(id) { return this.get().indexOf(id) >= 0; },
  toggle(id) {
    const arr = this.get();
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else arr.unshift(id);
    this.set(arr);
    return i < 0;
  },
};

// ===== router =====
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query] = h.split('?');
  const params = {};
  if (query) {
    for (const kv of query.split('&')) {
      const [k, v] = kv.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, params };
}

const ROUTES = [
  { match: /^\/$/,                  page: 'home',        render: renderHome },
  { match: /^\/route\/([\w-]+)$/,   page: 'collections', render: (m) => renderRouteDetail(m[1]) },
  { match: /^\/poi\/([\w-]+)$/,     page: 'home',        render: (m) => renderPoiDetail(m[1]) },
  { match: /^\/map$/,               page: 'map',         render: renderMap },
  { match: /^\/collections$/,       page: 'collections', render: renderCollections },
  { match: /^\/search$/,            page: 'home',        render: renderSearch },
  { match: /^\/personalize$/,       page: 'personalize', render: renderPersonalize },
  { match: /^\/favs$/,              page: 'profile',     render: renderFavs },
  { match: /^\/profile$/,           page: 'profile',     render: renderProfile },
  { match: /^\/about$/,             page: 'profile',     render: renderAbout },
];

async function route() {
  await loadData();
  const { path } = parseHash();
  let matched;
  for (const r of ROUTES) {
    const m = path.match(r.match);
    if (m) { matched = { r, m }; break; }
  }
  // update active nav
  $$('.topnav a').forEach(a => a.classList.remove('active'));
  const navMap = { home: 'home', map: 'map', collections: 'collections', personalize: 'personalize', profile: 'profile' };
  if (matched && navMap[matched.r.page]) {
    const link = $(`.topnav a[data-route="${navMap[matched.r.page]}"]`);
    if (link) link.classList.add('active');
  }
  // render
  const app = $('#app');
  app.innerHTML = '';
  if (matched) {
    try { await matched.r.render(matched.m); }
    catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty-state"><div class="emoji">😢</div><div class="text">页面加载出错：${escapeHtml(e.message || e)}</div></div>`;
    }
  } else {
    app.innerHTML = `<div class="empty-state"><div class="emoji">🐾</div><div class="text">页面不存在</div></div>`;
  }
  window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { loadUserLoc(); route(); });

// ===== Service Worker registration =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // 监听更新
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // 已经有一个 controller 在跑，说明这是更新
            const el = document.createElement('div');
            el.className = 'toast';
            el.innerHTML = '内容已更新 · <span style="text-decoration:underline;cursor:pointer;">刷新</span>';
            el.querySelector('span').addEventListener('click', () => location.reload());
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 8000);
          }
        });
      });
    }).catch(err => console.warn('SW reg failed:', err));
  });
}

// ===== "Add to Home Screen" prompt =====
let _installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installEvent = e;
  // 在 about 页（如有）和首屏底部展示一个轻量提示
  setTimeout(() => {
    if (sessionStorage.getItem('install-prompt-shown')) return;
    sessionStorage.setItem('install-prompt-shown', '1');
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.bottom = '70px';
    el.innerHTML = '把北京宠物路书加到主屏？ <span id="do-install" style="text-decoration:underline;cursor:pointer;margin-left:8px;">安装</span>';
    document.body.appendChild(el);
    el.querySelector('#do-install').addEventListener('click', async () => {
      el.remove();
      if (_installEvent) {
        _installEvent.prompt();
        await _installEvent.userChoice;
        _installEvent = null;
      }
    });
    setTimeout(() => el.remove(), 10000);
  }, 4000);
});

// ===== components =====
function routeCardHtml(r) {
  const c = coverFor(r);
  const tags = (r.tags || []).slice(0, 3);
  return `
    <a class="route-card" href="#/route/${r.id}">
      <div class="route-cover" style="background: linear-gradient(135deg, ${c.from}, ${c.to})">
        <span class="route-cover-glyph">${c.emoji}</span>
      </div>
      <div class="route-body">
        <h3 class="route-title">${escapeHtml(r.title)}</h3>
        <p class="route-summary">${escapeHtml(r.summary || '')}</p>
        <div class="route-meta">
          ${r.duration_hours ? `<span>⏱ ${r.duration_hours}h</span>` : ''}
          ${r.transport ? `<span>🚗 ${escapeHtml(r.transport)}</span>` : ''}
          ${r.poi_count ? `<span>📍 ${r.poi_count}个地点</span>` : ''}
        </div>
        <div>${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      </div>
    </a>
  `;
}

const FRESHNESS_PILL = {
  open:           { label: '✓ 最近确认在营', color: '#4FB5A5', bg: '#E5F5F1' },
  policy_changed: { label: '⚠️ 政策有变', color: '#C77800', bg: '#FFF1D6' },
  closed:         { label: '✕ 可能已关停', color: '#B23A3A', bg: '#FBE3E3' },
  unclear:        { label: '? 信息较旧', color: '#777',     bg: '#EEE' },
};
function freshnessPillHtml(p) {
  const f = p.freshness;
  if (!f) return '';
  const conf = FRESHNESS_PILL[f.status] || FRESHNESS_PILL.unclear;
  const mention = f.latest_mention ? ` · ${escapeHtml(f.latest_mention)}` : '';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${conf.bg};color:${conf.color};margin-top:4px;">${conf.label}${mention}</span>`;
}

function dedupeSourcesByHost(sources) {
  const seen = new Set();
  const out = [];
  for (const s of (sources || [])) {
    let host = '';
    try { host = new URL(s.url).host; } catch (e) {}
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(s);
  }
  return out;
}

function poiCardHtml(p) {
  const icon = POI_ICON[p.category] || '📍';
  const tags = petTagsHtml(p, 3);
  const hook = (p.pet_features && p.pet_features.pet_hook) || p.why_friendly || '';
  const km = distanceKm(p);
  const distText = km != null ? `📍 ${formatKm(km)}` : '';
  const drive = km != null ? formatDriveMin(km) : '';
  const photo = coverImageUrl(p, 400);
  const pal = poiPalette(p);
  const bigGlyph = bigCategoryGlyph(p);
  const coverStyle = photo ? '' : `style="background: linear-gradient(135deg, ${pal.from}, ${pal.to});"`;
  return `
    <a class="poi-card" href="#/poi/${p.id}">
      <div class="poi-cover ${photo ? '' : 'cover-illus'}" ${coverStyle}>
        ${photo
          ? `<img src="${escapeHtml(photo)}" loading="lazy" decoding="async" alt="${escapeHtml(p.name)}" onerror="this.style.display='none';this.parentElement.classList.add('cover-illus');this.parentElement.style.background='linear-gradient(135deg, ${pal.from}, ${pal.to})';">`
          : `<div class="poi-cover-glyph">${bigGlyph}</div>`}
        <div class="poi-cover-icon">${icon}</div>
        ${p.pet_features && p.pet_features.size_limit && p.pet_features.size_limit.large_dog_allowed === true
          ? '<div class="poi-cover-badge">🐕 大型犬OK</div>'
          : ''}
        ${distText ? `<div class="poi-cover-dist">${distText}${drive ? ` · ${drive}` : ''}</div>` : ''}
      </div>
      <div class="poi-body">
        <div class="poi-name">${escapeHtml(p.name)}</div>
        ${p.district ? `<div class="poi-district-tag">${escapeHtml(p.district)}${POI_CAT_LABEL[p.category] ? ' · ' + POI_CAT_LABEL[p.category] : ''}</div>` : ''}
        ${hook ? `<p class="poi-hook-text">${escapeHtml(hook)}</p>` : ''}
        ${tags ? `<div class="pet-tags">${tags}</div>` : ''}
        ${freshnessPillHtml(p)}
      </div>
    </a>
  `;
}

// ===== home recommendation sections =====
function poiMiniCardHtml(p) {
  const icon = POI_ICON[p.category] || '📍';
  const recent = isRecentlyMentioned(p, 3);
  const mention = (p.freshness && p.freshness.latest_mention) || '';
  return `
    <a class="mini-card" href="#/poi/${p.id}">
      <div class="mini-icon">${icon}</div>
      <div class="mini-name">${escapeHtml(p.name)}</div>
      <div class="mini-meta">${escapeHtml(p.district || '')} · ${escapeHtml(POI_CAT_LABEL[p.category] || '')}</div>
      ${mention ? `<div class="mini-mention">${recent ? '🔥 ' : ''}${escapeHtml(mention)} 提到</div>` : ''}
    </a>
  `;
}
function routeMiniCardHtml(r) {
  const c = coverFor(r);
  return `
    <a class="mini-card mini-route" href="#/route/${r.id}" style="background: linear-gradient(135deg, ${c.from}, ${c.to});">
      <div class="mini-emoji">${c.emoji}</div>
      <div class="mini-route-title">${escapeHtml(r.title)}</div>
    </a>
  `;
}

function recommendationsHtml() {
  const hot = getHotPois(10);
  const newOpened = getRecentlyOpened(10);
  const seasonal = getSeasonalRoutes(6);
  const season = currentSeason();
  const seasonEmoji = { spring: '🌸', summer: '🌊', autumn: '🍁', winter: '❄️' }[season.key];

  return `
    ${hot.length ? `
      <div class="rec-section">
        <div class="rec-head"><span>🔥</span> <strong>最近热议</strong> <span class="muted small">网友提到最多的地点</span></div>
        <div class="hscroll">${hot.map(poiMiniCardHtml).join('')}</div>
      </div>
    ` : ''}

    ${seasonal.length ? `
      <div class="rec-section">
        <div class="rec-head"><span>${seasonEmoji}</span> <strong>本月适合（${season.cn}季）</strong> <span class="muted small">应季路书</span></div>
        <div class="hscroll">${seasonal.map(routeMiniCardHtml).join('')}</div>
      </div>
    ` : ''}

    ${newOpened.length ? `
      <div class="rec-section">
        <div class="rec-head"><span>🆕</span> <strong>近期新开</strong> <span class="muted small">2025 年新涌现 / 升级</span></div>
        <div class="hscroll">${newOpened.map(poiMiniCardHtml).join('')}</div>
      </div>
    ` : ''}
  `;
}

// ===== home (feed) =====
// ===== HOME — POI-first feed =====
async function renderHome() {
  document.title = 'PawsPath · 爪迹';

  const filter = JSON.parse(sessionStorage.getItem('home-pf') || '{}');
  const district = filter.district || '';
  const category = filter.category || '';
  const pet = new Set(filter.pet || []);
  const maxKm = parseFloat(filter.maxKm) || 0;   // 0 = unlimited
  const sort = filter.sort || (STATE.userLoc ? 'distance' : 'recent');

  const allPois = Object.values(cityPois());

  // Compute candidates with filters
  const matchPet = (p, key) => {
    const f = p.pet_features;
    if (!f) return false;
    switch (key) {
      case 'large_dog':  return f.size_limit && f.size_limit.large_dog_allowed === true;
      case 'grass':      return (f.facilities || []).includes('grass_area');
      case 'fenced':     return (f.facilities || []).includes('fenced_area');
      case 'pool':       return (f.facilities || []).includes('swimming_pool');
      case 'indoor':     return f.access && f.access.indoor_allowed === true;
      case 'water_bowl': return (f.services || []).includes('water_bowl');
      case 'pet_menu':   return (f.services || []).includes('pet_menu');
      case 'free_treats':return (f.services || []).includes('free_treats');
    }
    return false;
  };

  let list = allPois.filter(p => {
    if (district && p.district !== district) return false;
    if (category && p.category !== category) return false;
    if (pet.size && ![...pet].every(k => matchPet(p, k))) return false;
    if (maxKm > 0) {
      const km = distanceKm(p);
      if (km == null || km > maxKm) return false;
    }
    return true;
  });

  // Sort
  if (sort === 'distance' && STATE.userLoc) {
    list.sort((a, b) => (distanceKm(a) || 1e9) - (distanceKm(b) || 1e9));
  } else if (sort === 'recent') {
    list.sort((a, b) => {
      const am = (a.freshness && a.freshness.latest_mention) || '';
      const bm = (b.freshness && b.freshness.latest_mention) || '';
      return ymScore(bm) - ymScore(am);
    });
  }

  const districts = [...new Set(allPois.map(p => p.district).filter(Boolean))].sort();
  const categoryOpts = [
    ['', '全部'], ['park','🌳 公园'], ['cafe','☕ 咖啡馆'],
    ['restaurant','🍽 餐厅'], ['petpark','🐾 宠物乐园'],
    ['hotel','🏨 民宿'], ['mall','🛍 商场'],
    ['hike','⛰️ 徒步'], ['water','🌊 水边'],
    ['camp','⛺ 营地'], ['vet','🏥 宠物医院'],
  ];
  const petChips = [
    ['large_dog',   '🐕 大型犬OK'],
    ['indoor',      '🏠 室内可'],
    ['grass',       '🌿 草坪'],
    ['fenced',      '🚧 围栏'],
    ['water_bowl',  '💧 水碗'],
    ['pet_menu',    '🍽 宠物餐'],
    ['free_treats', '🦴 免费零食'],
    ['pool',        '🏊 宠物泳池'],
  ];
  const kmChips = [['0','不限'],['3','3km 内'],['5','5km 内'],['10','10km 内'],['30','30km 内']];

  const haveLoc = !!STATE.userLoc;

  $('#app').innerHTML = `
    <section class="hero hero-paws">
      <h1>本地带宠物去哪玩</h1>
      <p>${allPois.length} 个已核验地点 · 每个 POI 都附设施 / 政策 / 距离</p>
      <div class="hero-cta">
        <button class="badge ${haveLoc ? 'badge-on' : ''}" id="loc-btn">${haveLoc ? '✓ 已定位 · 点击更新' : '📍 定位我，按距离排序'}</button>
        <a href="#/map" class="badge">🗺️ 地图视图</a>
      </div>
    </section>

    <div class="filter-row" id="cat-row">
      ${categoryOpts.map(([v, l]) => `<div class="chip ${v === category ? 'active' : ''}" data-cat="${v}">${l}</div>`).join('')}
    </div>

    <div class="filter-row" id="pet-row">
      ${petChips.map(([k, l]) => `<div class="chip ${pet.has(k) ? 'active' : ''}" data-pet="${k}">${l}</div>`).join('')}
    </div>

    <div class="filter-row" id="km-row" style="${haveLoc ? '' : 'display:none;'}">
      ${kmChips.map(([k, l]) => `<div class="chip ${(maxKm + '') === k ? 'active' : ''}" data-km="${k}">${l}</div>`).join('')}
    </div>

    <div class="filter-row" id="district-row">
      <div class="chip ${!district ? 'active' : ''}" data-district="">全部区域</div>
      ${districts.map(d => `<div class="chip ${district === d ? 'active' : ''}" data-district="${d}">${d}</div>`).join('')}
    </div>

    <div class="sort-row">
      <span class="muted small">共 ${list.length} 个 · 排序：</span>
      <span class="sort-chip ${sort === 'distance' ? 'active' : ''} ${haveLoc ? '' : 'disabled'}" data-sort="distance">距离最近</span>
      <span class="sort-chip ${sort === 'recent' ? 'active' : ''}" data-sort="recent">最近被提及</span>
    </div>

    <div id="poi-feed">
      ${list.length
        ? `<div class="poi-list">${list.map(poiCardHtml).join('')}</div>`
        : `<div class="empty-state"><div class="emoji">🐾</div><div class="text">没有符合的地点</div><div class="muted small">换个筛选条件试试</div></div>`}
    </div>
  `;

  // Filter clicks
  $('#cat-row').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    setFilter({ category: c.dataset.cat });
  });
  $('#pet-row').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const s = new Set(pet);
    s.has(c.dataset.pet) ? s.delete(c.dataset.pet) : s.add(c.dataset.pet);
    setFilter({ pet: [...s] });
  });
  const kmRow = $('#km-row');
  if (kmRow) kmRow.addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    setFilter({ maxKm: c.dataset.km });
  });
  $('#district-row').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    setFilter({ district: c.dataset.district });
  });
  $$('.sort-chip').forEach(s => {
    s.addEventListener('click', () => {
      if (s.classList.contains('disabled')) return;
      setFilter({ sort: s.dataset.sort });
    });
  });

  // Locate button
  $('#loc-btn').addEventListener('click', async () => {
    const btn = $('#loc-btn');
    btn.textContent = '定位中…';
    btn.disabled = true;
    const loc = await requestLocation(true);
    if (loc) {
      toast('定位成功');
      setFilter({ sort: 'distance' });
    } else {
      toast('定位失败，浏览器可能拒绝了');
      btn.disabled = false;
      btn.textContent = '📍 定位我，按距离排序';
    }
  });

  function setFilter(patch) {
    const next = { district, category, pet: [...pet], maxKm, sort, ...patch };
    sessionStorage.setItem('home-pf', JSON.stringify(next));
    renderHome();
  }
}

// ===== route detail =====
async function renderRouteDetail(slug) {
  const r = STATE.routesById[slug];
  if (!r) {
    $('#app').innerHTML = `<div class="empty-state"><div class="emoji">🐾</div><div class="text">路书不存在</div></div>`;
    return;
  }
  document.title = `${r.title} · 北京宠物路书`;

  const pois = (r.poi_ids || []).map(id => STATE.pois[id]).filter(Boolean);
  const isFav = favs.has(slug);
  const sizeLabel = { small: '小型犬', medium: '中型犬', large: '大型犬' };
  const fitSizes = (r.fit_dog_size || []).map(s => sizeLabel[s] || s).join('、');

  $('#app').innerHTML = `
    <section class="route-detail-head">
      <h1>${escapeHtml(r.title)}</h1>
      <p class="route-detail-summary">${escapeHtml(r.summary || '')}</p>
      <div class="route-detail-meta">
        ${r.duration_hours ? `<span>⏱ 推荐 ${r.duration_hours} 小时</span>` : ''}
        ${r.transport ? `<span>🚗 ${escapeHtml(r.transport)}</span>` : ''}
        ${fitSizes ? `<span>🐕 ${escapeHtml(fitSizes)}</span>` : ''}
        ${r.best_seasons && r.best_seasons.length ? `<span>🌤 ${r.best_seasons.map(escapeHtml).join('/')}</span>` : ''}
      </div>
      <div>
        ${(r.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="actions">
        <button class="btn btn-ghost" id="fav-btn">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="btn btn-primary" id="share-btn">📤 复制分享链接</button>
      </div>
    </section>

    <div class="section-title">推荐地点 · ${pois.length}</div>
    <div class="muted small" style="margin: -8px 4px 12px;">所有展示的地点均经近期网络证据核验仍宠物友好。文章正文中可能提到更多商家，但仅展示已确认的卡片。</div>
    <div class="poi-list">
      ${pois.map(poiCardHtml).join('')}
    </div>

    <div class="section-title">详细路书</div>
    <article class="md-body" id="md-body">加载中…</article>

    ${(r.checklist && r.checklist.length) ? `
      <div class="section-title">出行清单</div>
      <div class="md-body">
        <ul>${r.checklist.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
      </div>
    ` : ''}

    ${(r.warnings && r.warnings.length) ? `
      <div class="section-title">红线提醒</div>
      <div class="md-body" style="background: #FFF5EB;">
        <ul>${r.warnings.map(w => `<li>⚠️ ${escapeHtml(w)}</li>`).join('')}</ul>
      </div>
    ` : ''}
  `;

  // load md
  const md = await loadMd(slug);
  $('#md-body').innerHTML = marked.parse(md, { breaks: false, gfm: true });
  // open links new tab
  $$('#md-body a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });

  $('#fav-btn').addEventListener('click', () => {
    const now = favs.toggle(slug);
    $('#fav-btn').textContent = now ? '★ 已收藏' : '☆ 收藏';
    toast(now ? '已收藏' : '已取消');
  });
  $('#share-btn').addEventListener('click', () => {
    const url = location.href;
    navigator.clipboard.writeText(url).then(() => toast('链接已复制'));
  });
}

// ===== poi detail =====
function renderPoiDetail(id) {
  const p = STATE.pois[id];
  if (!p) {
    $('#app').innerHTML = `<div class="empty-state"><div class="emoji">🐾</div><div class="text">地点不存在</div></div>`;
    return;
  }
  document.title = `${p.name} · PawsPath`;

  const icon = POI_ICON[p.category] || '📍';
  const relRoutes = (p.route_slugs || []).map(s => STATE.routesById[s]).filter(Boolean);
  const distPill = distancePillHtml(p);
  const isFav = favs.has(id);

  // 地图链接（外部跳转）
  const mapLinks = (typeof p.lat === 'number') ? `
    <div class="map-jump">
      <a class="jump-btn" target="_blank" rel="noopener" href="https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(p.name)}">高德导航</a>
      <a class="jump-btn" target="_blank" rel="noopener" href="https://api.map.baidu.com/marker?location=${p.lat},${p.lng}&title=${encodeURIComponent(p.name)}&content=${encodeURIComponent(p.name)}&output=html&coord_type=wgs84">百度地图</a>
      <a class="jump-btn" target="_blank" rel="noopener" href="https://maps.google.com/?q=${p.lat},${p.lng}">Google Maps</a>
    </div>
  ` : '';

  $('#app').innerHTML = `
    <section class="poi-banner ${coverImageUrl(p, 1200) ? '' : 'banner-fallback'}"${coverImageUrl(p, 1200) ? '' : ` style="background: linear-gradient(135deg, ${poiPalette(p).from}, ${poiPalette(p).to});"`}>
      ${coverImageUrl(p, 1200)
        ? `<img class="poi-banner-img" src="${escapeHtml(coverImageUrl(p, 1200))}" loading="eager" decoding="async" alt="${escapeHtml(p.name)}" onerror="this.style.display='none'">`
        : `<div class="poi-banner-emoji">${bigCategoryGlyph(p)}</div>`}
      <div class="poi-banner-overlay"></div>
      <div class="poi-banner-info">
        <div class="poi-banner-cat">${icon} ${escapeHtml(POI_CAT_LABEL[p.category] || '')}</div>
        <h1 class="poi-banner-name">${escapeHtml(p.name)}</h1>
        <div class="poi-banner-loc">${p.district ? escapeHtml(p.district) + '区' : ''}${p.address_hint ? ' · ' + escapeHtml(p.address_hint) : ''}</div>
        ${distPill ? `<div class="poi-banner-dist">${distPill}</div>` : ''}
      </div>
    </section>

    <div class="poi-actions-row">
      <button class="btn btn-ghost" id="fav-poi-btn">${isFav ? '★ 已收藏' : '☆ 收藏'}</button>
      <button class="btn btn-primary" id="share-poi-btn">📤 复制链接</button>
    </div>
    ${p.photo_attribution ? `<div class="photo-attribution">照片 by ${escapeHtml(p.photo_attribution)} via Google Maps</div>` : ''}

    ${petHookHtml(p) ? `<div class="md-body">${petHookHtml(p)}</div>` : ''}

    ${petFeaturesHtml(p)}

    ${(p.why_friendly || p.price_hint || p.tips) ? `
      <div class="section-title">其它信息</div>
      <div class="md-body">
        ${p.why_friendly ? `<p>${escapeHtml(p.why_friendly)}</p>` : ''}
        ${p.price_hint ? `<p>💰 ${escapeHtml(p.price_hint)}</p>` : ''}
        ${p.tips ? `<p style="color:#b76a2a;">⚠️ ${escapeHtml(p.tips)}</p>` : ''}
      </div>
    ` : ''}

    ${p.freshness ? `
      <div class="section-title">实时核验</div>
      <div class="md-body">
        <div style="padding:12px 14px;border-radius:8px;background:${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).bg};">
          <div style="font-weight:600;color:${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).color};font-size:13px;">
            ${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).label}
            ${p.freshness.latest_mention ? `· 最新提到 ${escapeHtml(p.freshness.latest_mention)}` : ''}
          </div>
          ${p.freshness.note ? `<div style="font-size:13px;margin-top:4px;color:#374151;">${escapeHtml(p.freshness.note)}</div>` : ''}
          ${p.freshness.checked_at ? `<div style="font-size:11px;color:#9CA3AF;margin-top:4px;">PawsPath 核验于 ${escapeHtml(p.freshness.checked_at)}</div>` : ''}
        </div>
      </div>
    ` : ''}

    ${mapLinks ? `<div class="section-title">导航前往</div>${mapLinks}` : ''}

    ${(p.sources && p.sources.length) ? `
      <div class="section-title">网友实测来源</div>
      <div class="md-body">
        ${dedupeSourcesByHost(p.sources).map(s => `
          <p>
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name || '原文')} ↗</a>
            <br>
            <span class="small muted" style="word-break: break-all;">${escapeHtml(s.url)}</span>
          </p>
        `).join('')}
      </div>
    ` : ''}

    ${relRoutes.length ? `
      <div class="section-title">出现在以下专题</div>
      <div class="grid">${relRoutes.map(routeCardHtml).join('')}</div>
    ` : ''}
  `;

  $('#fav-poi-btn').addEventListener('click', () => {
    const now = favs.toggle(id);
    $('#fav-poi-btn').textContent = now ? '★ 已收藏' : '☆ 收藏';
    toast(now ? '已收藏' : '已取消');
  });
  $('#share-poi-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => toast('链接已复制'));
  });
}

// ===== search =====
function renderSearch() {
  const params = parseHash().params;
  const q = params.q || '';
  document.title = '搜索 · 北京宠物路书';

  $('#app').innerHTML = `
    <div class="search-bar">
      <input class="search-input" id="search-input" placeholder="搜路书 / 公园 / 餐厅 / 民宿..." value="${escapeHtml(q)}">
      <button class="search-btn" id="search-btn">搜索</button>
    </div>
    <div id="search-result"></div>
  `;

  const doSearch = () => {
    const v = $('#search-input').value.trim();
    if (!v) {
      $('#search-result').innerHTML = `
        <div class="section-title">热门搜索</div>
        <div class="chip-grid">
          ${['露营', '咖啡馆', '海淀', '大型犬', '雨天', '银杏', '民宿', '宠物乐园'].map(t => `<div class="chip" data-q="${t}">${t}</div>`).join('')}
        </div>
      `;
      $$('#search-result .chip').forEach(c => c.addEventListener('click', () => {
        $('#search-input').value = c.dataset.q;
        doSearch();
      }));
      return;
    }
    const lo = v.toLowerCase();
    const test = (s) => (s || '').toLowerCase().includes(lo);
    const routeHits = cityRoutes().filter(r =>
      test(r.title) || test(r.summary) || (r.tags || []).some(test) || (r.districts || []).some(test)
    );
    const poiHits = Object.values(cityPois()).filter(p =>
      test(p.name) || test(p.why_friendly) || test(p.tips) || test(p.district)
    );
    location.hash = `#/search?q=${encodeURIComponent(v)}`;
    $('#search-result').innerHTML = `
      ${routeHits.length ? `
        <div class="section-title">路书 · ${routeHits.length}</div>
        <div class="grid">${routeHits.map(routeCardHtml).join('')}</div>
      ` : ''}
      ${poiHits.length ? `
        <div class="section-title">地点 · ${poiHits.length}</div>
        <div class="poi-list">${poiHits.slice(0, 30).map(poiCardHtml).join('')}</div>
      ` : ''}
      ${!routeHits.length && !poiHits.length
        ? `<div class="empty-state"><div class="emoji">🔍</div><div class="text">没搜到内容，换个词试试</div></div>`
        : ''}
    `;
  };

  $('#search-btn').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  doSearch();
}

// ===== personalize (Gemini) =====
function renderPersonalize() {
  document.title = '定制路书 · 北京宠物路书';

  const proxyUrl = (window.PETGUIDE_CONFIG && window.PETGUIDE_CONFIG.geminiProxy && window.PETGUIDE_CONFIG.geminiProxy.url) || '';
  const fallbackKey = (window.PETGUIDE_CONFIG && window.PETGUIDE_CONFIG.gemini && window.PETGUIDE_CONFIG.gemini.fallbackKey) || '';
  const userKey = localStorage.getItem('gemini-key') || '';
  const effectiveKey = userKey || fallbackKey;
  const needKey = !proxyUrl && !effectiveKey;

  $('#app').innerHTML = `
    <section class="hero" style="background: linear-gradient(135deg, #E1F0FF 0%, #B8DCFF 100%); color: #1a3a5e;">
      <h1>告诉我你的需求 ✨</h1>
      <p>基于站内 ${Object.keys(STATE.pois).length} 个地点，几秒生成专属路书</p>
    </section>

    ${needKey ? `
      <div class="form-card" style="border: 2px dashed #FFB892;background:#FFF7EE;">
        <div class="form-label" style="color: var(--primary-deep);">🛠️ 该功能正在升级中</div>
        <p class="muted small">编辑团队正在为定制路书功能升级后台批处理流程，预计很快上线。你可以先：</p>
        <ul style="font-size:13px;color:var(--text-soft);line-height:1.7;margin:6px 0 0 16px;">
          <li>在 <a href="#/">发现页</a>按主题 / 区域 / 季节翻路书</li>
          <li>在 <a href="#/map">地图页</a>看你附近的宠物友好地点</li>
          <li>把心仪的路书<a href="#/favs">收藏</a>起来</li>
        </ul>
      </div>
    ` : ''}

    <div class="form-card">
      <div class="form-row">
        <label class="form-label">狗狗名字</label>
        <input class="form-input" id="f-name" placeholder="选填，例如：豆豆">
      </div>
      <div class="form-row">
        <label class="form-label">体型</label>
        <div class="seg" id="f-size">
          <div class="seg-item" data-v="small">小型</div>
          <div class="seg-item active" data-v="medium">中型</div>
          <div class="seg-item" data-v="large">大型</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">时长</label>
        <div class="seg" id="f-when">
          <div class="seg-item active" data-v="halfday">半日</div>
          <div class="seg-item" data-v="fullday">一日</div>
          <div class="seg-item" data-v="two_day">两日</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">区域偏好</label>
        <select class="form-select" id="f-district">
          ${['不限','朝阳','海淀','通州','大兴','顺义','昌平','门头沟','房山','丰台','石景山'].map(d => `<option>${d}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label class="form-label">交通</label>
        <div class="seg" id="f-transport">
          <div class="seg-item active" data-v="self_drive">自驾</div>
          <div class="seg-item" data-v="taxi">携宠网约车</div>
          <div class="seg-item" data-v="walk">步行</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">兴趣 (可多选)</label>
        <div class="chip-grid" id="f-interests">
          ${[
            ['nature','🌳 自然/公园'], ['cafe','☕ 咖啡馆'],
            ['restaurant','🍽️ 餐厅'], ['camping','⛺ 露营'],
            ['mall','🛍️ 商场'], ['hike','⛰️ 徒步'],
            ['water','🌊 水边'], ['petpark','🐾 宠物乐园'],
          ].map(([v,l]) => `<div class="chip" data-v="${v}">${l}</div>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">备注</label>
        <textarea class="form-textarea" id="f-notes" placeholder="比如：怕热 / 不喜欢人多 / 想看花..."></textarea>
      </div>
      <button class="btn btn-primary" id="gen-btn">${needKey ? '功能升级中' : '生成路书'}</button>
    </div>

    <div id="gen-result"></div>
  `;

  if (needKey) {
    // 升级中：禁用生成按钮
    $('#gen-btn').disabled = true;
    $('#gen-btn').style.opacity = '0.5';
    $('#gen-btn').textContent = '功能升级中';
  }

  // seg select helpers
  ['f-size', 'f-when', 'f-transport'].forEach(id => {
    $('#' + id).addEventListener('click', e => {
      const it = e.target.closest('.seg-item');
      if (!it) return;
      it.parentElement.querySelectorAll('.seg-item').forEach(x => x.classList.remove('active'));
      it.classList.add('active');
    });
  });
  // interests multi
  const interestsState = new Set(['nature', 'cafe']);
  $$('#f-interests .chip').forEach(c => {
    if (interestsState.has(c.dataset.v)) c.classList.add('active');
    c.addEventListener('click', () => {
      const v = c.dataset.v;
      if (interestsState.has(v)) { interestsState.delete(v); c.classList.remove('active'); }
      else { interestsState.add(v); c.classList.add('active'); }
    });
  });

  $('#gen-btn').addEventListener('click', async () => {
    const key = localStorage.getItem('gemini-key');
    if (!proxyUrl && !key) { toast('请先填写 API key'); return; }
    if (interestsState.size === 0) { toast('至少选一项兴趣'); return; }

    const form = {
      name: $('#f-name').value.trim(),
      size: $('#f-size .active').dataset.v,
      when: $('#f-when .active').dataset.v,
      district: $('#f-district').value,
      transport: $('#f-transport .active').dataset.v,
      interests: [...interestsState],
      notes: $('#f-notes').value.trim(),
    };

    $('#gen-btn').disabled = true;
    $('#gen-btn').textContent = '生成中…';
    $('#gen-result').innerHTML = `<div class="loading-screen"><div class="spinner"></div>正在为你梳理路线…</div>`;
    try {
      const { markdown, usedPois } = await callGemini(form, key, proxyUrl);
      const plans = parsePlans(markdown);

      if (plans.length < 2) {
        // 不到两个方案：fallback 单方案渲染
        $('#gen-result').innerHTML = `
          <div class="section-title">为你生成</div>
          <article class="md-body">${marked.parse(markdown, { breaks: false, gfm: true })}</article>
          ${usedPois.length ? `<div class="section-title">用到的地点</div><div class="poi-list">${usedPois.map(poiCardHtml).join('')}</div>` : ''}
          <div class="muted center-text small" style="margin-top: 20px;">仅供参考 · 请向商家电话确认细节</div>
        `;
      } else {
        // 多方案：tab 切换
        $('#gen-result').innerHTML = `
          <div class="section-title">为你生成 · ${plans.length} 个方案 (点击切换)</div>
          <div class="plan-tabs" id="plan-tabs">
            ${plans.map((p, i) => `<div class="plan-tab ${i === 0 ? 'active' : ''}" data-i="${i}">${escapeHtml(p.letter)} · ${escapeHtml(p.title)}</div>`).join('')}
          </div>
          <article class="md-body" id="plan-body">${marked.parse(plans[0].body, { breaks: false, gfm: true })}</article>
          ${usedPois.length ? `
            <div class="section-title">所有方案涉及的地点</div>
            <div class="poi-list">${usedPois.map(poiCardHtml).join('')}</div>
          ` : ''}
          <div class="muted center-text small" style="margin-top: 20px;">仅供参考 · 请向商家电话确认细节</div>
        `;
        const bodyEls = plans.map(p => marked.parse(p.body, { breaks: false, gfm: true }));
        $$('#plan-tabs .plan-tab').forEach(t => {
          t.addEventListener('click', () => {
            $$('#plan-tabs .plan-tab').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            const i = parseInt(t.dataset.i, 10) || 0;
            $('#plan-body').innerHTML = bodyEls[i];
            $$('#plan-body a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
          });
        });
      }
      $$('#gen-result .md-body a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    } catch (e) {
      console.error(e);
      $('#gen-result').innerHTML = `<div class="empty-state"><div class="emoji">😢</div><div class="text">生成失败：${escapeHtml(e.message)}</div></div>`;
    }
    $('#gen-btn').disabled = false;
    $('#gen-btn').textContent = '生成路书';
  });
}

// ===== parse plans from Gemini output =====
function parsePlans(md) {
  // 按 "## 方案 X" 切片。允许格式 "## 方案 A · 标题" / "## 方案 A 标题"
  const lines = md.split(/\r?\n/);
  const plans = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s*方案\s*([A-Za-z0-9])[\s·.：:、]+(.+?)\s*$/);
    if (m) {
      if (current) plans.push(current);
      current = { letter: m[1].toUpperCase(), title: m[2].trim().replace(/^[·•:：\s]+/, ''), body: '' };
      continue;
    }
    if (current) {
      // 跳过文末的 "---" 分隔符行
      if (line.trim() === '---') continue;
      current.body += line + '\n';
    }
  }
  if (current) plans.push(current);
  return plans;
}

// ===== call gemini =====
async function callGemini(form, apiKey, proxyUrl) {
  const catMap = {
    nature: ['park', 'water'],
    cafe: ['cafe'],
    restaurant: ['restaurant'],
    camping: ['camp'],
    mall: ['mall'],
    hike: ['hike'],
    water: ['water'],
    petpark: ['petpark'],
  };
  const wantCats = new Set(form.interests.flatMap(i => catMap[i] || []));
  let pool = Object.values(cityPois());
  if (wantCats.size) pool = pool.filter(p => wantCats.has(p.category));
  if (form.district && form.district !== '不限') pool = pool.filter(p => p.district === form.district);
  if (form.size === 'large') {
    pool = pool.filter(p => {
      if (p.category === 'mall') return false;
      const sl = p.pet_features && p.pet_features.size_limit;
      if (sl && sl.large_dog_allowed === false) return false;
      return true;
    });
  }
  // 必须有坐标，否则无法算通勤
  pool = pool.filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');

  // 通勤估算：自驾/打车 25km/h + 15分钟缓冲；步行 4km/h
  const speedKmH = form.transport === 'walk' ? 4 : 25;
  const bufferMin = form.transport === 'walk' ? 0 : 15;
  // 步行偏好下，限制候选 POI 在 3km 圈内（避免选远的）
  // 这里取 pool 的中位 POI 作为锚，挑离它最近的 N 个
  if (form.transport === 'walk' && pool.length > 8) {
    const anchor = pool[Math.floor(pool.length / 2)];
    pool.sort((a, b) => haversineKm(anchor, a) - haversineKm(anchor, b));
    pool = pool.slice(0, 12);
  } else {
    pool = pool.slice(0, 30);
  }

  // 每种 POI 的默认停留分钟数
  const STAY_MIN = {
    park: 90, water: 75, hike: 150, camp: 180,
    cafe: 60, restaurant: 80, bakery: 45,
    mall: 90, petpark: 100, hotel: 0, vet: 30,
  };

  const pickedPool = pool.map(p => {
    const f = p.pet_features || {};
    const compact = {
      id: p.id, name: p.name, category: p.category, district: p.district,
      address: p.address_hint, why: p.why_friendly, tips: p.tips, price: p.price_hint,
      lat: p.lat, lng: p.lng,
      stay_min: STAY_MIN[p.category] || 60,
    };
    // 把 pet_features 压成"扁平特征"字段，节省 token
    if (f.pet_hook) compact.pet_hook = f.pet_hook;
    if (f.facilities && f.facilities.length) compact.facilities = f.facilities;
    if (f.services && f.services.length) compact.services = f.services;
    if (f.size_limit) {
      if (f.size_limit.large_dog_allowed != null) compact.large_dog_ok = f.size_limit.large_dog_allowed;
    }
    if (f.access) {
      if (f.access.indoor_allowed === false || f.access.outdoor_only) compact.outdoor_only = true;
      if (f.access.diaper_required) compact.diaper_required = true;
    }
    if (f.best_for && f.best_for.length) compact.best_for = f.best_for;
    return compact;
  });

  const sizeLabel = { small: '小型', medium: '中型', large: '大型' }[form.size] || form.size;
  const whenScaffold = {
    halfday:  '3-4 个节点，覆盖约 4 小时（一个上午或一个下午）',
    fullday:  '5-6 个节点，覆盖约 8 小时（上午到晚餐）',
    two_day:  '两天每天 4 个节点，给出 Day 1 + Day 2 结构',
  }[form.when] || '4 个节点，覆盖一个半日';

  // 当前时间上下文
  const now = new Date();
  const month = now.getMonth() + 1;
  const dow = now.getDay();              // 0=日, 6=六
  const isWeekend = dow === 0 || dow === 6;
  const dowName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dow];
  const seasonName = month >= 3 && month <= 5 ? '春季' : (month >= 6 && month <= 8 ? '夏季' : (month >= 9 && month <= 11 ? '秋季' : '冬季'));
  const hour = now.getHours();
  const startHint = hour < 11
    ? '今天才上午，可以从早安排到傍晚'
    : (hour < 14 ? '今天已经过午，建议从下午开始的半日行程' : '今天已近傍晚，给一份明天的计划');

  const prompt = `你是北京养狗人的周末路书规划师。基于下面候选地点库，给一份**轻量化、亮点优先 + 时间合理**的路书。

# 今日上下文（影响时段 / 人流 / 天气建议）
- 日期：${now.toISOString().slice(0,10)}（${dowName}，${isWeekend ? '周末' : '工作日'}）
- 季节：${seasonName}（北京 ${month} 月）
- 当前时间：${hour}:00 — ${startHint}
- ${isWeekend ? '周末提示：热门地点会拥挤，可往京郊或冷门时段走（如 9 点前或 16 点后）' : '工作日提示：人流量小，热门店内可坐，停车也方便'}
- 季节专属提示：${seasonName === '夏季' ? '正午高温，避开 11-15 点暴晒，水边/树荫优先' : seasonName === '冬季' ? '室内段加重，户外段控制在 1 小时内' : seasonName === '秋季' ? '光线短，下午活动 16 点前要结束' : '春季多风，户外活动注意防风沙'}

# 用户
- 狗狗：${form.name || '未命名'}（${sizeLabel}型犬）
- 行程：${whenScaffold}
- 区域偏好：${form.district}
- 交通：${form.transport}（${form.transport === 'walk' ? '步行 4km/h' : form.transport === 'taxi' ? '携宠网约车 ~25km/h + 等车 15 分钟' : '自驾 ~25km/h 城区 + 停车 15 分钟'}）
- 兴趣：${form.interests.join(' / ')}
- 备注：${form.notes || '无'}

# 候选地点库（${pickedPool.length} 个，已含 lat/lng 和默认停留分钟，**只能从这里选**）
${JSON.stringify(pickedPool, null, 2)}

# 关键约束 —— 时间与通勤
1. **每个 POI 在时间线里至多出现一次**。不要把同一个地点拆成两段（如"上午公园 + 下午公园同一个"），中间也别写通勤。
2. **通勤估算**：两点 lat/lng 直线距离 × 1.4 = 实际公里数 ÷ 速度 = 通勤分钟。两点超过 30 分钟通勤的不要相邻放。
3. **优先地理相邻**：严格挑同一片区域（同区或邻区），不东西跨城。
4. **停留时间用候选库里的 stay_min 字段**为基准，可±15 分钟。
5. **时间链必须连贯**：上一个结束 → 通勤 → 下一个开始时间对得上，不要有 30 分钟以上的空白。
6. **结合今日上下文**：考虑${dowName}的人流、${seasonName}的天气、起始时间的合理性。

# 输出格式（严格）

**给 2~3 个不同方案让用户选**，每个方案聚焦不同角度（例如：A=城区轻松、B=京郊野趣、C=文艺漫步；或 A=低强度遛弯、B=社交撒欢、C=室内享受）。方案之间地点和风格**必须明显不同**。

## 方案 A · 短标题（≤8 字，画面感）
（路线亮点：≤30 字一句话差异化）

### 时间线
- **HH:MM-HH:MM · 地点名** \`(POI:id)\` — 亮点（≤15 字）
- 🚗 通勤 X 分钟
- **HH:MM-HH:MM · 地点名** \`(POI:id)\` — 亮点
- （重复每个节点；同 POI 不要重复也不要写通勤）

### 提醒
（≤40 字一句话）

---

## 方案 B · 短标题

（同样结构）

---

## 方案 C · 短标题（可选，如果候选库够丰富就给）

（同样结构）

# 写作要求
- 每个方案 ≤250 字
- 方案之间地点不重叠（不同 POI），style 不一样
- "亮点"不写通用形容（如"草坪宽敞""环境优美"）
- 所有地点必须带 \`(POI:id)\`，id 严格使用候选库里的
- 不写"作为编辑"等开场
- 候选不够就给 2 个方案；宁缺毋滥
- 不要写候选库以外的地点
- 用 \`---\` 分隔每个方案`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      // 关掉 Gemini 2.5 的 thinking 模式（不然思考过程吃光 token，输出被截断）
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 4096,  // 给输出充裕空间，~300 字中文绰绰有余
    },
  };
  let url;
  if (proxyUrl) {
    // proxy 模式：发请求体 + model 字段给 worker，由 worker 拼 upstream URL 并加 key
    body.model = 'gemini-2.5-flash';
    url = proxyUrl;
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const cand = (data.candidates && data.candidates[0]) || {};
  const finishReason = cand.finishReason || '';
  const parts = (cand.content && cand.content.parts) || [];
  let text = parts.map(p => p.text || '').join('');
  // If hit MAX_TOKENS we may have a dangling sentence — trim to last complete bullet/paragraph
  if (finishReason === 'MAX_TOKENS') {
    // Trim to last full markdown bullet or newline that ends with sentence punctuation
    const lastNL = Math.max(text.lastIndexOf('\n- '), text.lastIndexOf('\n\n'));
    if (lastNL > 200) text = text.slice(0, lastNL).trim() + '\n\n*（输出被长度限制截断）*';
  }
  // extract POI ids used
  const ids = [...new Set((text.match(/POI:p_[a-z0-9]+/g) || []).map(m => m.replace('POI:', '')))];
  const usedPois = ids.map(id => STATE.pois[id]).filter(Boolean);

  return { markdown: text, usedPois };
}

// ===== favorites page =====
// ===== collections (themed routes, secondary entry) =====
function renderCollections() {
  document.title = '专题 · PawsPath';

  const filter = JSON.parse(sessionStorage.getItem('coll-filter') || '{}');
  const cat = filter.category || '';
  let list = cityRoutes().filter(r => r.verified !== false);
  if (cat) list = list.filter(r => r.category === cat);

  const categoryOpts = [
    ['', '全部'], ['season', '🌸 季节'], ['district', '🗺 区域'],
    ['dog-type', '🐶 犬种'], ['cat', '☕ 品类'],
  ];

  $('#app').innerHTML = `
    <section class="hero hero-paws">
      <h1>专题清单</h1>
      <p>${list.length} 个主题清单 · 按场景/区域/犬种/品类组织 · 每个清单含 6+ 个 POI</p>
    </section>

    <div class="filter-row" id="coll-cat-row">
      ${categoryOpts.map(([v, l]) => `<div class="chip ${v === cat ? 'active' : ''}" data-v="${v}">${l}</div>`).join('')}
    </div>

    ${list.length
      ? `<div class="grid">${list.map(routeCardHtml).join('')}</div>`
      : `<div class="empty-state"><div class="emoji">📚</div><div class="text">没有匹配的专题</div></div>`}
  `;

  $('#coll-cat-row').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sessionStorage.setItem('coll-filter', JSON.stringify({ category: c.dataset.v }));
    renderCollections();
  });
}

// ===== profile (我的：收藏 + 设置) =====
function renderProfile() {
  document.title = '我的 · PawsPath';
  const favIds = favs.get();
  const favPois = favIds.map(id => STATE.pois[id]).filter(Boolean);
  const favRoutes = favIds.map(id => STATE.routesById[id]).filter(Boolean);
  const haveLoc = !!STATE.userLoc;

  $('#app').innerHTML = `
    <section class="hero hero-paws">
      <h1>我的 PawsPath</h1>
      <p>本地宠物 POI 数据库 · 你的收藏与设置</p>
    </section>

    <div class="section-title">设置</div>
    <div class="card menu">
      <div class="menu-item flex-between">
        <span>地理位置</span>
        <span class="muted small">${haveLoc ? `${STATE.userLoc.lat.toFixed(3)}, ${STATE.userLoc.lng.toFixed(3)}` : '未授权'}</span>
      </div>
      <div class="divider"></div>
      <div class="menu-item" id="profile-loc-btn">${haveLoc ? '🔄 重新定位' : '📍 开启定位（按距离推荐）'}</div>
      <div class="divider"></div>
      <div class="menu-item" id="clear-favs">清空本地收藏</div>
    </div>

    ${favPois.length ? `
      <div class="section-title">收藏的地点 · ${favPois.length}</div>
      <div class="poi-list">${favPois.map(poiCardHtml).join('')}</div>
    ` : ''}

    ${favRoutes.length ? `
      <div class="section-title">收藏的专题 · ${favRoutes.length}</div>
      <div class="grid">${favRoutes.map(routeCardHtml).join('')}</div>
    ` : ''}

    ${!favPois.length && !favRoutes.length ? `
      <div class="empty-state"><div class="emoji">⭐</div><div class="text">还没收藏任何地点</div></div>
    ` : ''}

    <div class="section-title">关于</div>
    <div class="md-body">
      <p><strong>PawsPath · 爪迹</strong> 是面向养狗人的本地宠物友好 POI 查询工具，聚焦"带狗去哪玩"这一刚需。</p>
      <p>每个 POI 都包含：设施清单 / 准入规则 / 大型犬支持 / 距离与驾车时间 / 网友实测来源 / 近期核验状态。</p>
      <p>数据基于公开互联网（小红书 / 大众点评 / 北京旅游网等）聚合 + 编辑团队人工核查，每日自动更新。</p>
      <p>地图数据 © OpenStreetMap · 出行前请向商家电话确认 · 文明遛狗 / 全程牵绳 / 清理粪便。</p>
    </div>
  `;

  $('#profile-loc-btn').addEventListener('click', async () => {
    const btn = $('#profile-loc-btn');
    btn.textContent = '定位中…';
    const loc = await requestLocation(true);
    if (loc) {
      toast('定位成功');
      renderProfile();
    } else {
      toast('定位失败');
      renderProfile();
    }
  });
  $('#clear-favs').addEventListener('click', () => {
    if (confirm('清空所有本地收藏？')) {
      favs.set([]);
      toast('已清空');
      renderProfile();
    }
  });
}

function renderFavs() {
  document.title = '我的收藏 · 北京宠物路书';
  const ids = favs.get();
  const list = ids.map(id => STATE.routesById[id]).filter(Boolean);
  $('#app').innerHTML = `
    <h2 style="margin-top:8px;">我的收藏 · ${list.length}</h2>
    ${list.length === 0
      ? `<div class="empty-state"><div class="emoji">⭐</div><div class="text">还没收藏路书<br><a href="#/">去发现页看看</a></div></div>`
      : `<div class="grid">${list.map(routeCardHtml).join('')}</div>`}
  `;
}

// ===== map =====
const POI_COLOR = {
  park: '#4FB5A5', cafe: '#C08552', restaurant: '#E15554',
  hotel: '#7768AE', petpark: '#FF7A3D', mall: '#3A86FF',
  hike: '#5A8F3E', water: '#3A86FF', vet: '#E15554', camp: '#5A8F3E',
};
const POI_CAT_LABEL = {
  park: '公园', cafe: '咖啡馆', restaurant: '餐厅',
  hotel: '酒店民宿', petpark: '宠物乐园', mall: '商场',
  hike: '徒步', water: '水边', vet: '宠物医院', camp: '营地',
};

let _mapInstance = null;
let _mapLayers = {};   // category -> Leaflet LayerGroup

function renderMap() {
  document.title = '地图 · 北京宠物路书';

  const city = currentCity();
  const cityPoiMap = cityPois();

  // Filter chips (category)
  const cats = Object.keys(POI_CAT_LABEL);
  const filter = JSON.parse(sessionStorage.getItem('map-filter') || '{"cats":[],"district":"","pet":[]}');
  const activeCats = new Set(filter.cats || []);
  const activeDistrict = filter.district || '';
  const activePet = new Set(filter.pet || []);   // 例如：'large_dog' 'grass' 'pet_menu' 'indoor'

  const districts = [...new Set(Object.values(cityPoiMap).map(p => p.district).filter(Boolean))].sort();

  const heatMode = sessionStorage.getItem('map-heat') === '1';

  $('#app').innerHTML = `
    <div style="margin: -8px -4px 12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <h2 style="margin: 8px 4px 4px;">${cityName(city)}宠物友好地图 · ${Object.keys(cityPoiMap).length} 个地点</h2>
        <div class="seg" style="flex: 0 0 auto;">
          <div class="seg-item ${!heatMode ? 'active' : ''}" data-mode="dots">📍 散点</div>
          <div class="seg-item ${heatMode ? 'active' : ''}" data-mode="heat">🔥 热力</div>
        </div>
      </div>
      <p class="muted small" style="margin: 0 4px 12px;">${heatMode ? '颜色越红的区域，宠物友好密度越高' : '每一个点都点开看看，详情有完整来源链接'}</p>

      <div class="filter-row">
        <div class="chip ${activeCats.size === 0 ? 'active' : ''}" data-all="1">全部 · ${Object.keys(cityPoiMap).length}</div>
        ${cats.map(c => {
          const n = Object.values(cityPoiMap).filter(p => p.category === c).length;
          if (n === 0) return '';
          return `<div class="chip ${activeCats.has(c) ? 'active' : ''}" data-cat="${c}" style="${activeCats.has(c) ? `background:${POI_COLOR[c]};border-color:${POI_COLOR[c]}` : ''}">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${POI_COLOR[c]};margin-right:6px;vertical-align:middle;"></span>
            ${POI_CAT_LABEL[c]} · ${n}
          </div>`;
        }).join('')}
      </div>

      <div class="filter-row">
        <div class="chip ${!activeDistrict ? 'active' : ''}" data-district="">全部区域</div>
        ${districts.map(d => `<div class="chip ${activeDistrict === d ? 'active' : ''}" data-district="${d}">${d}</div>`).join('')}
      </div>

      <div class="filter-row">
        ${[
          ['large_dog',   '🐕 大型犬OK'],
          ['grass',       '🌿 草坪'],
          ['indoor',      '🏠 室内可'],
          ['water_bowl',  '💧 水碗'],
          ['pet_menu',    '🍽 宠物餐'],
          ['fenced',      '🚧 围栏'],
          ['pool',        '🏊 宠物泳池'],
        ].map(([k, l]) => `<div class="chip ${activePet.has(k) ? 'active' : ''}" data-pet="${k}">${l}</div>`).join('')}
      </div>
    </div>

    <div id="map" style="height: 70vh; min-height: 480px; border-radius: 14px; overflow: hidden; box-shadow: var(--shadow); position: relative;">
      <div class="loading-screen" style="position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <div class="spinner"></div>
        <div>地图加载中…</div>
      </div>
    </div>

    <p class="muted small center-text" style="margin-top: 16px;">
      地图数据 © OpenStreetMap contributors · 标点位置由 Photon 地理编码自动获取，部分点可能落在大致区位上，以现场实际为准
    </p>
  `;

  // Filter handlers
  const updateFilter = (next) => {
    sessionStorage.setItem('map-filter', JSON.stringify(next));
    renderMap();
  };
  $$('.filter-row .chip').forEach(c => {
    c.addEventListener('click', () => {
      const base = { cats: [...activeCats], district: activeDistrict, pet: [...activePet] };
      if (c.dataset.all === '1') return updateFilter({ ...base, cats: [] });
      if (c.dataset.cat) {
        const s = new Set(activeCats);
        s.has(c.dataset.cat) ? s.delete(c.dataset.cat) : s.add(c.dataset.cat);
        return updateFilter({ ...base, cats: [...s] });
      }
      if (c.dataset.district !== undefined) {
        return updateFilter({ ...base, district: c.dataset.district });
      }
      if (c.dataset.pet) {
        const s = new Set(activePet);
        s.has(c.dataset.pet) ? s.delete(c.dataset.pet) : s.add(c.dataset.pet);
        return updateFilter({ ...base, pet: [...s] });
      }
    });
  });

  // Mode (dots/heat) toggle
  $$('.seg-item[data-mode]').forEach(it => {
    it.addEventListener('click', () => {
      sessionStorage.setItem('map-heat', it.dataset.mode === 'heat' ? '1' : '0');
      renderMap();
    });
  });

  // Build markers
  const matchPet = (p, key) => {
    const f = p.pet_features;
    if (!f) return false;
    switch (key) {
      case 'large_dog':  return f.size_limit && f.size_limit.large_dog_allowed === true;
      case 'grass':      return (f.facilities || []).includes('grass_area');
      case 'fenced':     return (f.facilities || []).includes('fenced_area');
      case 'pool':       return (f.facilities || []).includes('swimming_pool');
      case 'indoor':     return f.access && f.access.indoor_allowed === true;
      case 'water_bowl': return (f.services || []).includes('water_bowl');
      case 'pet_menu':   return (f.services || []).includes('pet_menu');
    }
    return false;
  };
  const points = Object.values(cityPoiMap).filter(p => {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (activeCats.size && !activeCats.has(p.category)) return false;
    if (activeDistrict && p.district !== activeDistrict) return false;
    if (activePet.size && ![...activePet].every(k => matchPet(p, k))) return false;
    return true;
  });

  // ensure Leaflet is loaded
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<div class="empty-state"><div class="text">地图库加载失败</div></div>';
    return;
  }

  setTimeout(() => {
    // remove any prior map
    const mapEl = $('#map');
    mapEl.innerHTML = '';

    const cityCfg = CITY_CENTER[city] || CITY_CENTER.beijing;
    const map = L.map(mapEl, {
      center: cityCfg.center,
      zoom: cityCfg.zoom,
      scrollWheelZoom: true,
      zoomControl: true,
    });
    _mapInstance = map;

    // Tile layer: CartoDB Voyager (works in China-ish, English+CJK labels)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap contributors © CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    if (points.length === 0) {
      mapEl.insertAdjacentHTML('beforeend', '<div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:20px;border-radius:12px;"><div class="emoji">📍</div><div class="text">没有符合条件的地点</div></div>');
      return;
    }

    const bounds = [];

    if (heatMode && typeof L.heatLayer === 'function') {
      // Heatmap mode
      const heatPoints = points.map(p => [p.lat, p.lng, 0.7]);
      L.heatLayer(heatPoints, {
        radius: 28,
        blur: 22,
        maxZoom: 14,
        gradient: { 0.3: '#4FB5A5', 0.55: '#FFC93C', 0.75: '#FF7A3D', 1: '#E15554' },
      }).addTo(map);
      points.forEach(p => bounds.push([p.lat, p.lng]));
    } else {
      // Dot mode
      const makeIcon = (color) => L.divIcon({
        className: '',
        html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      points.forEach(p => {
        const color = POI_COLOR[p.category] || '#FF7A3D';
        const marker = L.marker([p.lat, p.lng], { icon: makeIcon(color) }).addTo(map);
        const sources = (p.sources || []).slice(0, 2).map(s =>
          `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:#FF7A3D;font-size:11px;margin-right:6px;">${escapeHtml(s.name || '来源')}</a>`
        ).join('');
        marker.bindPopup(`
          <div style="min-width:200px;font-family:inherit;">
            <div style="font-weight:600;font-size:14px;color:#1F2937;margin-bottom:4px;">
              ${escapeHtml(p.name)}
            </div>
            <div style="font-size:12px;color:#6B7280;margin-bottom:6px;">
              ${escapeHtml(POI_CAT_LABEL[p.category] || p.category)}${p.district ? ' · ' + escapeHtml(p.district) : ''}
            </div>
            ${p.why_friendly ? `<div style="font-size:12px;color:#374151;line-height:1.5;margin-bottom:6px;">${escapeHtml(p.why_friendly)}</div>` : ''}
            ${p.price_hint ? `<div style="font-size:12px;color:#9CA3AF;">💰 ${escapeHtml(p.price_hint)}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
              <a href="#/poi/${p.id}" style="font-size:12px;background:#FF7A3D;color:#fff;padding:3px 10px;border-radius:12px;text-decoration:none;">详情 →</a>
              ${sources}
            </div>
          </div>
        `, { maxWidth: 280 });
        bounds.push([p.lat, p.lng]);
      });
    }

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    } else {
      map.setView(bounds[0], 14);
    }
  }, 50);
}

// ===== about =====
function renderAbout() {
  document.title = '关于 · 北京宠物路书';
  $('#app').innerHTML = `
    <h2 style="margin-top:8px;">关于北京宠物路书 🐾</h2>
    <div class="md-body">
      <p>北京宠物路书是一个面向养狗人的周末出行助手。我们围绕"宠物友好"这件事，由编辑团队走访 + 翻阅小红书 / 马蜂窝 / 大众点评 / 知乎 / 本地媒体，把城区与近郊的公园、咖啡馆、餐厅、民宿与营地一条一条整理出来，每条信息都附上参考链接方便你二次核实。</p>

      <h3>主题维度</h3>
      <p>所有路书按 <strong>季节场景 / 区域 / 犬种与家庭 / 品类清单</strong> 四个维度组织，便于按需查找：周末想看银杏？想找大型犬可去的公园？想避开人多的地方？翻一下就有。</p>

      <h3>关于"定制路书"</h3>
      <p>把你的狗狗体型、出行时长、偏好区域、兴趣告诉我们，几秒为你拼一份专属周末方案。所有候选地点都来自站内已收录的真实清单。</p>

      <h3>免责声明</h3>
      <p>宠物友好政策随时可能变化，出行前请向商家电话确认。如需赴远郊景区，请遵守当地养犬管理规定，文明遛狗、全程牵绳、清理粪便。本站为非商业项目。</p>

      <h3>更多</h3>
      <p><a href="#/favs">我的收藏 →</a> · <a href="#/map">地图浏览 →</a></p>
    </div>
  `;
}
