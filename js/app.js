// ===== state =====
const STATE = {
  routes: [],       // route metadata list
  routesById: {},   // id -> route
  pois: {},         // id -> poi
  cities: [],       // [{key, name, count}]
  mdCache: {},      // slug -> markdown string
  loaded: false,
};

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
  { match: /^\/route\/([\w-]+)$/,   page: 'route',       render: (m) => renderRouteDetail(m[1]) },
  { match: /^\/poi\/([\w-]+)$/,     page: 'poi',         render: (m) => renderPoiDetail(m[1]) },
  { match: /^\/map$/,               page: 'map',         render: renderMap },
  { match: /^\/search$/,            page: 'search',      render: renderSearch },
  { match: /^\/personalize$/,       page: 'personalize', render: renderPersonalize },
  { match: /^\/favs$/,              page: 'favs',        render: renderFavs },
  { match: /^\/about$/,             page: 'about',       render: renderAbout },
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
  const navMap = { home: 'home', map: 'map', search: 'search', personalize: 'personalize', about: 'about' };
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
window.addEventListener('DOMContentLoaded', route);

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
  const sources = dedupeSourcesByHost(p.sources).slice(0, 3).map(s =>
    `<a class="poi-source-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name || '原文')}</a>`
  ).join('');
  return `
    <a class="poi-card" href="#/poi/${p.id}">
      <div class="poi-icon">${icon}</div>
      <div class="poi-body">
        <div class="poi-name">${escapeHtml(p.name)}${p.district ? `<span class="poi-district">· ${escapeHtml(p.district)}</span>` : ''}</div>
        ${freshnessPillHtml(p)}
        ${p.why_friendly ? `<p class="poi-why">${escapeHtml(p.why_friendly)}</p>` : ''}
        ${p.price_hint ? `<div class="poi-meta">💰 ${escapeHtml(p.price_hint)}</div>` : ''}
        ${p.tips ? `<div class="poi-meta poi-meta-tip">⚠️ ${escapeHtml(p.tips)}</div>` : ''}
        ${sources ? `<div class="poi-sources">${sources}</div>` : ''}
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
function renderHome() {
  const filter = JSON.parse(sessionStorage.getItem('home-filter') || '{}');
  const cat = filter.category || '';
  const dim = filter.dim || '';
  const city = currentCity();

  let list = cityRoutes();
  // 默认只展示已通过近期核验的路书（verified === true）
  list = list.filter(r => r.verified !== false);
  if (cat) list = list.filter(r => r.category === cat);
  if (dim) list = list.filter(r => r.dim === dim);

  // city tabs (only show if more than 1 city has content)
  const activeCities = STATE.cities.filter(c => c.count > 0);
  const showCityTabs = activeCities.length > 1;

  const categoryOpts = [
    { v: '', l: '全部' },
    { v: 'season', l: '🌸 季节场景' },
    { v: 'district', l: '🗺️ 按区域' },
    { v: 'dog-type', l: '🐶 按狗狗' },
    { v: 'cat', l: '☕ 类别清单' },
  ];

  const dimOpts = {
    season: [
      { v: '', l: '全部' },
      { v: 'spring', l: '春' }, { v: 'summer', l: '夏' },
      { v: 'autumn', l: '秋' }, { v: 'winter', l: '冬' },
      { v: 'rainy', l: '雨天' }, { v: 'camping', l: '露营' },
      { v: 'picnic', l: '野餐' }, { v: 'morning', l: '清晨' },
    ],
    district: [
      { v: '', l: '全部' },
      ...['chaoyang','haidian','tongzhou','daxing','shunyi','changping','mentougou','fangshan']
        .map(d => ({ v: d, l: { chaoyang:'朝阳', haidian:'海淀', tongzhou:'通州', daxing:'大兴', shunyi:'顺义', changping:'昌平', mentougou:'门头沟', fangshan:'房山' }[d] })),
    ],
    'dog-type': [
      { v: '', l: '全部' },
      { v: 'large', l: '大型犬' }, { v: 'small', l: '小型犬' },
      { v: 'senior', l: '老年犬' }, { v: 'puppy', l: '幼犬' },
      { v: 'family', l: '亲子带狗' }, { v: 'afterwork', l: '下班后' },
    ],
    cat: [
      { v: '', l: '全部' },
      { v: 'cafe', l: '咖啡馆' }, { v: 'restaurant', l: '餐厅' },
      { v: 'hotel', l: '酒店民宿' }, { v: 'mall', l: '商场' },
      { v: 'petpark', l: '宠物乐园' }, { v: 'hike', l: '徒步' },
      { v: 'water', l: '湖河水边' }, { v: 'vet', l: '宠物医院' },
    ],
  };

  const app = $('#app');
  app.innerHTML = `
    <section class="hero">
      <h1>和狗狗一起逛${cityName(city)} 🐶</h1>
      <p>${list.length} 篇真实路书 · ${Object.keys(cityPois()).length} 个宠物友好地点 · 每条都附原始来源</p>
      <div style="margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap;">
        <a href="#/map" class="badge" style="text-decoration:none;color:inherit;">🗺️ 打开地图</a>
        <a href="#/personalize" class="badge" style="text-decoration:none;color:inherit;">✨ AI 定制</a>
        <a href="#/favs" class="badge" style="text-decoration:none;color:inherit;">⭐ 我的收藏</a>
      </div>
    </section>

    ${showCityTabs ? `
      <div class="filter-row" id="city-row">
        ${activeCities.map(c => `<div class="chip ${c.key === city ? 'active' : ''}" data-city="${c.key}">${c.name} · ${c.count}</div>`).join('')}
      </div>
    ` : ''}

    ${!cat && !dim ? recommendationsHtml() : ''}

    <div class="section-title">按主题</div>
    <div class="filter-row" id="cat-row">
      ${categoryOpts.map(o => `<div class="chip ${o.v === cat ? 'active' : ''}" data-v="${o.v}">${o.l}</div>`).join('')}
    </div>

    ${cat ? `
      <div class="filter-row" id="dim-row">
        ${(dimOpts[cat] || []).map(o => `<div class="chip ${o.v === dim ? 'active' : ''}" data-v="${o.v}">${o.l}</div>`).join('')}
      </div>
    ` : ''}

    ${list.length === 0
      ? `<div class="empty-state"><div class="emoji">🐾</div><div class="text">没有匹配的路书，换个条件试试</div></div>`
      : `<div class="grid">${list.map(routeCardHtml).join('')}</div>`}
  `;

  const cityRow = $('#city-row');
  if (cityRow) cityRow.addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    setCity(c.dataset.city);
    sessionStorage.removeItem('home-filter');
    renderHome();
  });
  $('#cat-row').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sessionStorage.setItem('home-filter', JSON.stringify({ category: c.dataset.v, dim: '' }));
    renderHome();
  });
  const dimRow = $('#dim-row');
  if (dimRow) dimRow.addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sessionStorage.setItem('home-filter', JSON.stringify({ category: cat, dim: c.dataset.v }));
    renderHome();
  });
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
  document.title = `${p.name} · 北京宠物路书`;

  const icon = POI_ICON[p.category] || '📍';
  const relRoutes = (p.route_slugs || []).map(s => STATE.routesById[s]).filter(Boolean);

  $('#app').innerHTML = `
    <section class="route-detail-head" style="text-align:center;">
      <div style="font-size: 56px; margin-bottom: 4px;">${icon}</div>
      <h1 style="font-size: 22px; text-align: center;">${escapeHtml(p.name)}</h1>
      <p class="route-detail-summary" style="text-align:center;">
        ${p.district ? escapeHtml(p.district) : ''}${p.address_hint ? ' · ' + escapeHtml(p.address_hint) : ''}
      </p>
    </section>

    <div class="md-body">
      ${p.freshness ? `
        <div style="padding:12px 14px;border-radius:8px;background:${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).bg};margin-bottom:12px;">
          <div style="font-weight:600;color:${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).color};font-size:13px;">
            ${(FRESHNESS_PILL[p.freshness.status]||FRESHNESS_PILL.unclear).label}
            ${p.freshness.latest_mention ? `· 最新提到 ${escapeHtml(p.freshness.latest_mention)}` : ''}
          </div>
          ${p.freshness.note ? `<div style="font-size:13px;margin-top:4px;color:#374151;">${escapeHtml(p.freshness.note)}</div>` : ''}
          ${p.freshness.checked_at ? `<div style="font-size:11px;color:#9CA3AF;margin-top:4px;">北京宠物路书核查于 ${escapeHtml(p.freshness.checked_at)}</div>` : ''}
        </div>
      ` : ''}
      ${p.why_friendly ? `<p>${escapeHtml(p.why_friendly)}</p>` : ''}
      ${p.price_hint ? `<p>💰 ${escapeHtml(p.price_hint)}</p>` : ''}
      ${p.tips ? `<p style="color:#b76a2a;">⚠️ ${escapeHtml(p.tips)}</p>` : ''}
    </div>

    ${(p.sources && p.sources.length) ? `
      <div class="section-title">数据来源</div>
      <div class="md-body">
        ${dedupeSourcesByHost(p.sources).map(s => `
          <p>
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">
              ${escapeHtml(s.name || '原文')} ↗
            </a>
            <br>
            <span class="small muted" style="word-break: break-all;">${escapeHtml(s.url)}</span>
          </p>
        `).join('')}
      </div>
    ` : ''}

    ${relRoutes.length ? `
      <div class="section-title">出现在以下路书</div>
      <div class="grid">${relRoutes.map(routeCardHtml).join('')}</div>
    ` : ''}
  `;
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
      $('#gen-result').innerHTML = `
        <div class="section-title">为你生成</div>
        <article class="md-body">${marked.parse(markdown, { breaks: false, gfm: true })}</article>
        ${usedPois.length ? `
          <div class="section-title">用到的地点</div>
          <div class="poi-list">${usedPois.map(poiCardHtml).join('')}</div>
        ` : ''}
        <div class="muted center-text small" style="margin-top: 20px;">仅供参考 · 请向商家电话确认细节</div>
      `;
      $$('#gen-result .md-body a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    } catch (e) {
      console.error(e);
      $('#gen-result').innerHTML = `<div class="empty-state"><div class="emoji">😢</div><div class="text">生成失败：${escapeHtml(e.message)}</div></div>`;
    }
    $('#gen-btn').disabled = false;
    $('#gen-btn').textContent = '生成路书';
  });
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
  if (form.size === 'large') pool = pool.filter(p => p.category !== 'mall');
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

  const pickedPool = pool.map(p => ({
    id: p.id, name: p.name, category: p.category, district: p.district,
    address: p.address_hint, why: p.why_friendly, tips: p.tips, price: p.price_hint,
    lat: p.lat, lng: p.lng,
    stay_min: STAY_MIN[p.category] || 60,
  }));

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

## 路线亮点
（≤30 字，一句话说清差异化，可以提一下"${isWeekend ? '避开周末人潮' : '工作日空场'}"或"${seasonName}专属"等）

## 时间线
- **HH:MM-HH:MM · 地点名** \`(POI:id)\` — 亮点（≤15 字）
- 🚗 通勤 X 分钟
- **HH:MM-HH:MM · 地点名** \`(POI:id)\` — 亮点
- 🚗 通勤 X 分钟
- （每个 POI 一行；不同 POI 之间穿插一行通勤；同 POI 不要重复也不要写通勤）

## 一句话提醒
（≤40 字，合并体型 / 天气 / 交通最关键的 1 条）

# 写作要求
- 整篇 ≤350 字
- "亮点"不写通用形容（如"草坪宽敞""环境优美"）
- 所有地点必须带 \`(POI:id)\`，id 严格使用候选库里的
- 不写"作为编辑"等开场
- 候选不够就少写节点；宁缺毋滥
- 不要写候选库以外的地点`;

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
  const filter = JSON.parse(sessionStorage.getItem('map-filter') || '{"cats":[],"district":""}');
  const activeCats = new Set(filter.cats || []);
  const activeDistrict = filter.district || '';

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
      if (c.dataset.all === '1') return updateFilter({ cats: [], district: activeDistrict });
      if (c.dataset.cat) {
        const cats = new Set(activeCats);
        if (cats.has(c.dataset.cat)) cats.delete(c.dataset.cat);
        else cats.add(c.dataset.cat);
        return updateFilter({ cats: [...cats], district: activeDistrict });
      }
      if (c.dataset.district !== undefined) {
        return updateFilter({ cats: [...activeCats], district: c.dataset.district });
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
  const points = Object.values(cityPoiMap).filter(p => {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (activeCats.size && !activeCats.has(p.category)) return false;
    if (activeDistrict && p.district !== activeDistrict) return false;
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
