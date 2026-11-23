import { HumanViewer } from './human.js';
import { PARTS, OTHER, buildUrl, fetchBook, interpret, parseCSV } from './sheet.js';
import { DEMO_CSVS } from './demo.js';

const $ = (s) => document.querySelector(s);
const BUILD = document.querySelector('meta[name="app-build"]')?.content || '';
const SETTINGS_KEY = 'selfcare.settings.v1';
const CACHE_KEY = 'selfcare.cache.v1';
const DEFAULT_SHEET = 'https://docs.google.com/spreadsheets/d/1-PNYKR85-ep6DJwejzr51eMBJ29sNvUYmmQT6PcopwI/edit';
const DEFAULTS = {
  sheet: DEFAULT_SHEET, sheetName: '', interval: 5, appName: 'セルフケア',
  skin: '#f0c4a0', hair: '#2a1c15', shirt: '#4a7fa8',
  brightness: 1, accent: '#4f8cff', panelStyle: 'glass', fontSize: 'm', autoRotate: true, rotateSpeed: 0.8,
};
const HINT = 'ドラッグで回転 ・ 部位をタップで記録';

// ---------- storage (wrapped: private mode can throw) ----------
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Settings may also be passed in the URL once (?sheet=...&name=...), handy for sharing to the iPhone.
function loadSettings() {
  const s = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };
  if (!s.sheet) s.sheet = DEFAULT_SHEET;
  const q = new URLSearchParams(location.search);
  let changed = false;
  for (const [qk, sk] of [['sheet', 'sheet'], ['tab', 'sheetName'], ['name', 'appName']]) {
    if (q.has(qk)) { s[sk] = q.get(qk); changed = true; }
  }
  if (changed) {
    store.set(SETTINGS_KEY, s);
    history.replaceState(null, '', location.pathname);
  }
  return s;
}

let settings = loadSettings();
let data = null; // interpret() result
let currentView = null; // { type: 'part'|'all'|'summary'|'settings', id }
let timer = null;
let lastSync = null;
let loading = false;

const viewer = new HumanViewer($('#viewer'), {
  colors: { skin: settings.skin, hair: settings.hair, shirt: settings.shirt },
  onSelect: (id) => (id ? openPart(id) : closePanel()),
});
if (/[?&]debug\b/.test(location.search)) window.__viewer = viewer;
viewer.onInteract = () => $('#hint').classList.add('hide');
$('#hint').textContent = HINT;

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

// ---------- data ----------
const demoTables = () => DEMO_CSVS.map(parseCSV);
function apply(tables, source) {
  data = interpret(tables);
  if (currentView) rerenderPanel();
  $('#demoBanner').hidden = source !== 'demo';
}

async function refresh({ manual = false } = {}) {
  if (loading) return;
  const url = buildUrl(settings.sheet, settings.sheetName);
  if (!url) {
    apply(demoTables(), 'demo');
    lastSync = new Date();
    setStatus();
    return;
  }
  loading = true;
  $('#titleCard').classList.add('loading');
  try {
    const tables = await fetchBook(url, { full: manual });
    apply(tables, 'sheet');
    lastSync = new Date();
    store.set(CACHE_KEY, { url, tables, at: lastSync.toISOString() });
    $('#errorBanner').hidden = true;
  } catch (e) {
    const cache = store.get(CACHE_KEY, null);
    if (!data && cache && cache.url === url && Array.isArray(cache.tables)) {
      apply(cache.tables, 'cache');
      lastSync = new Date(cache.at);
    }
    showError(`${e.message || e}${data ? '（前回取得したデータを表示中）' : ''}`);
    if (!data) apply(demoTables(), 'demo');
  } finally {
    loading = false;
    $('#titleCard').classList.remove('loading');
    setStatus();
  }
}

function showError(msg) {
  const el = $('#errorBanner');
  el.textContent = msg;
  el.hidden = false;
}

function setStatus() {
  $('#syncStatus').textContent = lastSync
    ? lastSync.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, Math.max(1, +settings.interval) * 60000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!lastSync || Date.now() - lastSync > 60000)) refresh();
});

// ---------- tab bar ----------
const TABS = {
  summary: () => openSummary(),
  all: () => openList(),
  body: () => { viewer.select('body'); openPart('body', { tab: 'body' }); },
  settings: () => openSettings(),
};
let activeTab = null;
function setActiveTab(t) {
  activeTab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
}
$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  if (activeTab === b.dataset.tab && $('#panel').classList.contains('open')) { closePanel(); return; }
  viewer.select(null);
  TABS[b.dataset.tab]();
});
$('#titleCard').addEventListener('click', () => refresh({ manual: true }));

// ---------- panel ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => `¥${Math.round(n).toLocaleString()}`;
const partLabel = (id) => PARTS[id]?.label || OTHER.label;

function itemHTML(row, { showPart = false } = {}) {
  const kv = [
    ['場所', row.place], ['時間帯', row.slot], ['担当者', row.staff], ['調剤', row.rx], ['特記事項', row.note],
    ...row.extra.map((c) => [c.label, c.value]),
  ].filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const thumbs = row.images.length
    ? `<div class="thumbs">${row.images.map((im) => `<button class="thumb" data-img="${esc(im.full)}" data-link="${esc(im.link)}"><img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>`
    : '';
  const chip = showPart
    ? `<button class="chip" data-part="${row.part}">${esc(row.cat || partLabel(row.part))}</button>`
    : `<span class="chip static">${esc(row.cat || '—')}</span>`;
  return `<article class="item">
    <div class="item-head"><span class="item-title">${esc(row.date || '日付なし')}</span>${row.costText ? `<span class="badge">${esc(row.cost != null ? yen(row.cost) : row.costText)}</span>` : ''}</div>
    <p class="item-sub">${chip}</p>
    ${kv ? `<dl class="kv">${kv}</dl>` : ''}${thumbs}
  </article>`;
}

// ---- records are shown one year at a time; swipe left/right (or ‹ ›) to change the year ----
let viewYear = null;
function yearsOf(rows) {
  const ys = [...new Set(rows.map((r) => r.year ?? null))];
  return ys.sort((a, b) => (b ?? -1) - (a ?? -1)); // newest first, "no date" last
}
function yearBlock(rows, opts = {}) {
  const years = yearsOf(rows);
  if (!years.includes(viewYear)) viewYear = years[0] ?? null;
  const list = rows.filter((r) => (r.year ?? null) === viewYear); // rows are already newest first
  const i = years.indexOf(viewYear);
  const older = years[i + 1], newer = years[i - 1];
  const label = viewYear == null ? '日付なしの記録' : `${viewYear}年の記録`;
  const cost = list.reduce((s, r) => s + (r.cost || 0), 0);
  const facts = [`${list.length}件`];
  if (cost) facts.push(`合計 ${yen(cost)}`);
  const dots = years.length > 1
    ? `<div class="yr-dots">${years.map((y) => `<span class="${y === viewYear ? 'on' : ''}"></span>`).join('')}</div>` : '';
  const bar = `<div class="year-bar">
      <button class="yr-btn" ${newer === undefined ? 'disabled' : ''} aria-label="新しい年">‹</button>
      <div class="yr-label"><b>${label}</b><small>${facts.join(' ・ ')}</small>${dots}</div>
      <button class="yr-btn" ${older === undefined ? 'disabled' : ''} aria-label="古い年">›</button>
    </div>`;
  return bar + list.map((r) => itemHTML(r, opts)).join('');
}
function changeYear(dir) {
  const years = yearsOf(currentRows());
  const j = years.indexOf(viewYear) + dir; // +1 = older, -1 = newer
  if (j < 0 || j >= years.length) return;
  viewYear = years[j];
  rerenderPanel({ keepScroll: false });
}
function currentRows() {
  if (!currentView || !data) return [];
  if (currentView.type === 'part') return data.byPart[currentView.id] || [];
  if (currentView.type === 'all') return data.rows;
  return [];
}

function openPart(id, { tab } = {}) {
  if (currentView?.type !== 'part' || currentView.id !== id) viewYear = null; // start at the newest year
  currentView = { type: 'part', id, tab };
  setActiveTab(tab || null);
  const rows = data?.byPart[id] || [];
  const p = PARTS[id];
  $('#panelTitle').textContent = partLabel(id);
  const cats = p ? p.cats.join('・') : 'どの部位にも当てはまらないカテゴリ';
  $('#panelSub').textContent = rows.length ? `${cats} ・ 全${rows.length}件` : cats;
  $('#panelBody').innerHTML = rows.length
    ? yearBlock(rows)
    : `<p class="empty">「${esc(cats)}」の記録はまだありません。<br>スプレッドシートのカテゴリ列に「${esc(p?.cats[0] || '')}」と入れると表示されます。</p>`;
  showPanel();
}

function openList() {
  if (currentView?.type !== 'all') viewYear = null;
  currentView = { type: 'all', id: 'all' };
  setActiveTab('all');
  const rows = data?.rows || [];
  $('#panelTitle').textContent = 'すべての記録';
  $('#panelSub').textContent = `全${rows.length}件 ・ 新しい順`;
  $('#panelBody').innerHTML = rows.length ? yearBlock(rows, { showPart: true }) : '<p class="empty">記録がありません</p>';
  showPanel();
}

// ---------- 概要 tab: this year at a glance and the last visit for each part ----------
function ago(d) {
  if (!d) return '';
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days < 0) return `${-days}日後`;
  if (days === 0) return '今日';
  if (days < 31) return `${days}日前`;
  const months = Math.floor(days / 30.44);
  return months < 12 ? `${months}か月前` : `${Math.floor(months / 12)}年${months % 12 ? `${months % 12}か月` : ''}前`;
}
function openSummary({ keepScroll = false } = {}) {
  currentView = { type: 'summary', id: 'summary' };
  setActiveTab('summary');
  const rows = data?.rows || [];
  const year = new Date().getFullYear();
  const thisYear = rows.filter((r) => r.year === year);
  const yearCost = thisYear.reduce((s, r) => s + (r.cost || 0), 0);
  const last = rows.find((r) => r.dateObj && r.dateObj <= new Date());
  const ids = [...Object.keys(PARTS), ...(data?.byPart.other.length ? [OTHER.id] : [])];
  const list = ids.map((id) => {
    const rs = data?.byPart[id] || [];
    const r = rs[0];
    return `<button class="part-row" data-part="${id}">
        <span class="pr-name"><b>${esc(partLabel(id))}</b><small>${esc(PARTS[id]?.cats.join('・') || 'その他のカテゴリ')}</small></span>
        <span class="pr-last">${r ? `<b>${esc(ago(r.dateObj) || r.date)}</b><small>${esc(r.date)}</small>` : '<small>記録なし</small>'}</span>
        <span class="pr-count">${rs.length}件</span>
      </button>`;
  }).join('');
  $('#panelTitle').textContent = '概要';
  $('#panelSub').textContent = rows.length ? `全${rows.length}件の記録` : '記録がありません';
  $('#panelBody').innerHTML = `
    <section class="card stats">
      <div><small>${year}年の記録</small><b>${thisYear.length}</b><span>件</span></div>
      <div><small>${year}年の費用</small><b>${yearCost ? yen(yearCost) : '--'}</b><span>記録分</span></div>
      <div><small>前回のケア</small><b>${last ? esc(ago(last.dateObj)) : '--'}</b><span>${last ? esc(last.cat) : ''}</span></div>
    </section>
    <section class="card"><h3>部位ごとの前回</h3>${list}</section>`;
  showPanel({ keepScroll });
}

function rerenderPanel({ keepScroll = true } = {}) {
  const body = $('#panelBody');
  const top = body.scrollTop;
  if (currentView.type === 'part') openPart(currentView.id, currentView);
  else if (currentView.type === 'all') openList();
  else if (currentView.type === 'summary') openSummary();
  else return; // settings form: don't rebuild under the user's fingers
  if (keepScroll) body.scrollTop = top;
}

$('#panelBody').addEventListener('click', (e) => {
  const yb = e.target.closest('.yr-btn');
  if (yb && !yb.disabled) { changeYear(yb.getAttribute('aria-label') === '古い年' ? 1 : -1); return; }
  const th = e.target.closest('.thumb');
  if (th) { openImage(th.dataset.img, th.dataset.link); return; }
  const b = e.target.closest('[data-part]');
  if (!b) return;
  viewer.select(b.dataset.part === OTHER.id ? null : b.dataset.part);
  openPart(b.dataset.part);
});
// images that cannot be loaded (private Drive files, dead links) are replaced by a link
$('#panelBody').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.closest('.thumb')?.classList.add('broken');
}, true);

function showPanel({ keepScroll = false } = {}) {
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  if (!keepScroll) $('#panelBody').scrollTop = 0;
  requestAnimationFrame(() => viewer.setBottomInset($('#panel').offsetHeight));
}
function closePanel() {
  currentView = null;
  setActiveTab(null);
  viewer.select(null);
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
  viewer.setBottomInset(0);
}
$('#btnClosePanel').addEventListener('click', closePanel);

// swipe left / right on the records to change the year
(() => {
  let sx = null, sy = 0;
  const body = $('#panelBody');
  body.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (currentRows().length && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) changeYear(dx < 0 ? 1 : -1); // swipe left = older
  });
})();

// swipe down on the sheet header to close
(() => {
  let y0 = null;
  const head = $('#panel');
  head.addEventListener('touchstart', (e) => { if (!e.target.closest('.panel-body')) y0 = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closePanel();
    y0 = null;
  });
})();

// ---------- image viewer ----------
function openImage(src, link) {
  $('#docImg').src = src;
  $('#docLink').href = link || src;
  $('#docViewer').hidden = false;
}
$('#docClose').addEventListener('click', () => { $('#docViewer').hidden = true; $('#docImg').removeAttribute('src'); });

// ---------- 設定 tab ----------
const ACCENTS = [['#4f8cff', 'ブルー'], ['#34c77b', 'グリーン'], ['#f5a524', 'オレンジ'], ['#a970ff', 'パープル'], ['#ff6b8b', 'ピンク'], ['#c9ced6', 'シルバー']];
const SKINS = [['#f6d5bb', '明るめ'], ['#f0c4a0', '標準'], ['#d9a27c', '小麦色'], ['#a86f4c', '褐色']];
const HAIRS = [['#2a1c15', '黒'], ['#5a3a24', 'ブラウン'], ['#a0703c', '明るい茶'], ['#d8c08a', 'ブロンド'], ['#9aa0a8', 'グレー']];
function openSettings() {
  currentView = { type: 'settings', id: 'settings' };
  setActiveTab('settings');
  const s = settings;
  const opt = (name, list) => list.map(([v, l]) => `<button class="seg ${String(s[name]) === String(v) ? 'on' : ''}" data-pref="${name}" data-value="${v}">${l}</button>`).join('');
  const swatches = (name, list) => `<div class="swatches">${list.map(([c, l]) => `<button class="swatch ${s[name] === c ? 'on' : ''}" style="--c:${c}" data-pref="${name}" data-value="${c}" aria-label="${l}"></button>`).join('')}</div>`;
  const t = lastSync ? lastSync.toLocaleString('ja-JP') : '—';
  $('#panelTitle').textContent = '設定';
  $('#panelSub').textContent = `バージョン ${BUILD.startsWith('__') ? '開発版' : BUILD}`;
  $('#panelBody').innerHTML = `
    <section class="card"><h3>表示</h3>
      <label class="row">画面の明るさ <output>${Math.round(s.brightness * 100)}%</output>
        <input type="range" min="0.5" max="1.6" step="0.05" value="${s.brightness}" data-pref="brightness"></label>
      <div class="row">テーマカラー${swatches('accent', ACCENTS)}</div>
      <div class="row">パネルのスタイル<div class="segs">${opt('panelStyle', [['glass', 'ガラス'], ['solid', 'ソリッド'], ['light', 'ライト']])}</div></div>
      <div class="row">文字の大きさ<div class="segs">${opt('fontSize', [['s', '小'], ['m', '標準'], ['l', '大']])}</div></div>
      <label class="field">タイトル<input data-pref="appName" value="${esc(s.appName)}"></label>
    </section>
    <section class="card"><h3>3D</h3>
      <label class="row">自動で回転 <input type="checkbox" class="switch" data-pref="autoRotate" ${s.autoRotate ? 'checked' : ''}></label>
      <label class="row">回転の速さ <output>${s.rotateSpeed}</output>
        <input type="range" min="0.2" max="3" step="0.1" value="${s.rotateSpeed}" data-pref="rotateSpeed"></label>
      <div class="row">肌の色${swatches('skin', SKINS)}</div>
      <div class="row">髪の色${swatches('hair', HAIRS)}</div>
      <label class="row">服の色 <input type="color" data-pref="shirt" value="${esc(s.shirt)}"></label>
    </section>
    <section class="card"><h3>データ</h3>
      <label class="field">スプレッドシートの URL<input type="url" id="setSheet" value="${esc(s.sheet)}" autocomplete="off"></label>
      <label class="field">シート名（空欄なら年ごとのシートを全部読み込み）<input id="setSheetName" value="${esc(s.sheetName)}"></label>
      <div class="row">自動更新<div class="segs">${opt('interval', [[1, '1分'], [5, '5分'], [15, '15分'], [60, '60分']])}</div></div>
      <div class="row-btns">
        <button class="btn primary" data-action="saveSheet">保存して読み込み</button>
        <button class="btn" data-action="refresh">今すぐ更新</button>
      </div>
      <p class="note">最終更新：${esc(t)}<br>スプレッドシートは「リンクを知っている全員（閲覧者）」で共有してください。読み取りのみで、書き込みはしません。</p>
    </section>`;
  showPanel();
}

function saveSettings() { store.set(SETTINGS_KEY, settings); }
function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--accent', settings.accent);
  root.dataset.panel = settings.panelStyle;
  root.dataset.font = settings.fontSize;
  viewer.setPrefs({ brightness: +settings.brightness, autoRotate: !!settings.autoRotate, rotateSpeed: +settings.rotateSpeed });
  viewer.setAccent(settings.accent);
  viewer.setColors({ skin: settings.skin, hair: settings.hair, shirt: settings.shirt });
  $('#appName').textContent = settings.appName || DEFAULTS.appName;
}

$('#panelBody').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.pref && (el.type === 'range' || el.type === 'color')) {
    settings[el.dataset.pref] = el.type === 'range' ? +el.value : el.value;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = el.dataset.pref === 'brightness' ? `${Math.round(el.value * 100)}%` : el.value;
    saveSettings(); applyPrefs();
  }
});
$('#panelBody').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset.pref || el.type === 'range' || el.type === 'color') return;
  settings[el.dataset.pref] = el.type === 'checkbox' ? el.checked : el.value;
  saveSettings(); applyPrefs();
});
$('#panelBody').addEventListener('click', async (e) => {
  if (currentView?.type !== 'settings') return;
  const seg = e.target.closest('[data-pref][data-value]');
  if (seg) {
    const k = seg.dataset.pref;
    settings[k] = k === 'interval' ? +seg.dataset.value : seg.dataset.value;
    saveSettings(); applyPrefs();
    if (k === 'interval') schedule();
    seg.parentElement.querySelectorAll('[data-pref]').forEach((b) => b.classList.toggle('on', b === seg));
    return;
  }
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (act === 'refresh') { await refresh({ manual: true }); openSettings(); toast('更新しました'); }
  if (act === 'saveSheet') {
    settings.sheet = $('#setSheet').value.trim() || DEFAULT_SHEET;
    settings.sheetName = $('#setSheetName').value.trim();
    saveSettings(); data = null; $('#errorBanner').hidden = true;
    await refresh({ manual: true }); openSettings();
  }
});
$('#btnOpenSettings2').addEventListener('click', () => openSettings());
applyPrefs();

// ---------- update notice ----------
// index.html carries the build number stamped at deploy time; version.json always has the latest one.
async function checkUpdate() {
  if (!BUILD || BUILD.startsWith('__')) return; // local copy without a build number
  try {
    const r = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    $('#updateBanner').hidden = !build || build === BUILD;
  } catch { /* offline */ }
}
$('#updateBanner').addEventListener('click', async () => {
  $('#updateBanner').textContent = '更新しています…';
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) || [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* ignore */ }
  location.reload();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
setInterval(checkUpdate, 10 * 60000);

// ---------- start ----------
refresh();
schedule();
checkUpdate();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
