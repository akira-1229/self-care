// Fetching and interpreting the セルフケア管理表 spreadsheet (one sheet per year: "2016" … "2026").
// Columns may differ from year to year, so every sheet is read by its own header names.

// ---- body parts on the 3D figure and the カテゴリ that belong to each ----
export const PARTS = {
  hair: { label: '髪', cats: ['美容院'], words: ['美容院', '美容室', 'ヘアサロン', '理容', '床屋', 'カット'] },
  eye: { label: '目', cats: ['眼科'], words: ['眼科', 'コンタクト', '眼鏡', 'メガネ'] },
  mouth: { label: '口（歯）', cats: ['歯科'], words: ['歯科', '歯医者', '矯正歯科', '口腔'] },
  ear: { label: '耳', cats: ['耳鼻咽喉科'], words: ['耳鼻咽喉科', '耳鼻科'] },
  skin: { label: '美容', cats: ['皮膚科'], words: ['皮膚科', '美容皮膚科', 'エステ'] },
  body: { label: '身体', cats: ['内科', '外科', '健康診断', 'リラクゼーション', '整骨院'],
    words: ['内科', '外科', '健康診断', '健診', '人間ドック', 'リラクゼーション', 'マッサージ', '整骨院', '接骨院', '整体', '鍼灸'] },
};
// matched in this order: the more specific names first ("美容皮膚科" is skin, not hair; "整形外科" is body)
const MATCH_ORDER = ['ear', 'eye', 'mouth', 'skin', 'hair', 'body'];
export const OTHER = { id: 'other', label: 'その他' };

const HEADER_RX = {
  date: /日時|日付|年月日|^日$/,
  cat: /カテゴリ|分類|区分|診療科|種別/,
  place: /場所|病院|医院|クリニック|店舗|店名|施設/,
  slot: /時間帯|時間|時刻/,
  staff: /担当|医師|スタッフ/,
  cost: /料金|金額|費用|代金|価格/,
  rx: /調剤|処方|薬/,
  note: /特記|備考|メモ|コメント|事項|内容/,
  image: /画像|写真|image|photo/i,
};
const EMPTY = /^[-－−ー―]+$/;
const num = (v) => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ---------------- Fetching ----------------
export function buildUrl(input, sheetName) {
  const raw = (input || '').trim();
  if (!raw) return null;
  // Already a CSV / JSON endpoint (published CSV, gviz, any other URL)
  if (/output=csv|tqx=out:csv|format=csv|script\.google(usercontent)?\.com/.test(raw)) return raw;
  if (/^https?:/.test(raw) && !/docs\.google\.com\/spreadsheets/.test(raw)) return raw;
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = m ? m[1] : raw;
  const gid = (raw.match(/[#&?]gid=(\d+)/) || [])[1];
  // JSON keeps real date values (with the year) next to the formatted text; headers=1 stops gviz from
  // guessing the header and gluing the first data rows into the column labels
  let url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:json&headers=1`;
  if (sheetName) url += `&sheet=${encodeURIComponent(sheetName)}`;
  else if (gid) url += `&gid=${gid}`;
  return url;
}

// The 管理表 keeps one sheet (tab) per year. When the URL points at the whole spreadsheet, every year sheet
// is read. A year without a sheet makes gviz fall back to the first tab, so a sheet only counts when its
// dates really are in that year. Returns a list of tables ([header, ...rows]), oldest year first, with
// `.sheets` = the sheet (tab) name of each table ("#gid=…" or "" = first tab when the name is unknown).
// `years`: year sheets to re-read even on a routine refresh (e.g. one that was just written to).
const BOOK_KEY = 'selfcare.book.v1';
const withSheets = (tables, sheets) => Object.assign(tables, { sheets });
function sheetOfUrl(url) {
  const name = (url.match(/[?&]sheet=([^&#]*)/) || [])[1];
  if (name != null) return decodeURIComponent(name);
  const gid = (url.match(/[?&#]gid=(\d+)/) || [])[1];
  return gid ? `#gid=${gid}` : '';
}
export async function fetchBook(url, { full = false, years: reread = [] } = {}) {
  const also = reread.map(Number);
  if (!/\/gviz\/tq/.test(url) || /[?&](sheet|gid)=/.test(url)) return withSheets([await fetchSheet(url)], [sheetOfUrl(url)]);
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(BOOK_KEY)); } catch { /* none */ }
  if (cache?.url !== url) cache = null;
  const thisYear = new Date().getFullYear();
  const yearSheet = async (y) => {
    const t = await fetchSheet(`${url}&sheet=${y}`);
    return isYearTable(t, y) ? t : null;
  };
  const tables = { ...(cache?.tables || {}) };
  const fresh = cache && !full && Date.now() - cache.at < 24 * 3600e3;
  if (fresh) {
    // routine refresh: only this year and last year can still change
    for (const y of new Set([thisYear + 1, thisYear, thisYear - 1, ...also])) {
      const t = await yearSheet(y).catch(() => undefined);
      if (t) tables[y] = t; else if (t === null && (y === thisYear + 1 || also.includes(y))) delete tables[y];
    }
  } else {
    // discover the year sheets, newest first, six at a time, until a whole batch is empty
    let firstError = null;
    for (let top = thisYear + 1, found = false; top > thisYear - 60; top -= 6) {
      const ys = Array.from({ length: 6 }, (_, i) => top - i);
      const got = await Promise.all(ys.map((y) => yearSheet(y).catch((e) => { firstError ||= e; return null; })));
      got.forEach((t, i) => { if (t) tables[ys[i]] = t; else delete tables[ys[i]]; });
      if (got.some(Boolean)) found = true;
      else if (found) break;
      else if (firstError) throw firstError; // nothing readable at all (not shared, offline, …)
    }
  }
  const years = Object.keys(tables).map(Number).sort((a, b) => a - b);
  if (!years.length) return withSheets([await fetchSheet(url)], ['']); // not a per-year workbook
  try { localStorage.setItem(BOOK_KEY, JSON.stringify({ url, at: fresh ? cache.at : Date.now(), tables })); } catch { /* full */ }
  return withSheets(years.map((y) => tables[y]), years.map(String));
}

function isYearTable(t, y) {
  if (!t?.length) return false;
  const hi = headerIndex(t);
  const di = (t[hi] || []).findIndex((h) => HEADER_RX.date.test(h || ''));
  return t.slice(hi + 1).some((r) => {
    const d = parseDate(di >= 0 ? r[di] : r[0]);
    return d && d.getFullYear() === y;
  });
}

export async function fetchSheet(url) {
  const sep = url.includes('?') ? '&' : '?';
  let res;
  try {
    res = await fetch(`${url}${sep}_ts=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
  } catch {
    throw new Error('スプレッドシートを読み取れませんでした。共有設定を「リンクを知っている全員（閲覧者）」にしてください（電波がない場合も表示されます）。');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('スプレッドシートが公開されていません。共有設定を「リンクを知っている全員（閲覧者）」にしてください。');
  }
  if (!res.ok) throw new Error(`取得に失敗しました（HTTP ${res.status}）`);
  const text = await res.text();
  const trimmed = text.trim();
  if (/^<(!doctype|html)/i.test(trimmed)) {
    throw new Error('シートを読み取れませんでした。共有設定を「リンクを知っている全員」にするか、「ウェブに公開」してください。');
  }
  if (trimmed.startsWith('/*O_o*/') || trimmed.startsWith('google.visualization')) return gvizToTable(trimmed);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return jsonToTable(JSON.parse(trimmed));
  return parseCSV(text);
}

// Google Visualization (gviz) JSON -> rows of display strings; dates get their year added if the format hides it
export function gvizToTable(text) {
  const json = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  if (json.status === 'error') throw new Error('スプレッドシートを読み取れませんでした。共有設定を確認してください。');
  const { cols, rows } = json.table;
  const cell = (c, col) => {
    if (!c || c.v == null) return c?.f ?? '';
    let f = c.f ?? String(c.v);
    if ((col.type === 'date' || col.type === 'datetime') && typeof c.v === 'string') {
      const m = c.v.match(/Date\((\d{4}),(\d+),(\d+)/);
      if (m && !/\d{4}/.test(f)) f = `${m[1]}年${f}`;
    }
    return f;
  };
  const body = rows.map((r) => cols.map((col, i) => cell(r?.c?.[i], col)));
  // headers=1: the labels are always row 1 of the sheet and every following sheet row is a table row,
  // so table index i is sheet row i + 1 (needed to write back to the right row). Keep the header row
  // even when it is blank, so that mapping holds.
  return [cols.map((c) => c.label || ''), ...body];
}

function jsonToTable(json) {
  const data = Array.isArray(json) ? json : json.values || json.rows || json.data || [];
  if (!data.length) return [];
  if (Array.isArray(data[0])) return data.map((r) => r.map((c) => (c == null ? '' : String(c))));
  const headers = [...new Set(data.flatMap((o) => Object.keys(o)))];
  return [headers, ...data.map((o) => headers.map((h) => (o[h] == null ? '' : String(o[h]))))];
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------- Interpreting ----------------
// header row = first row (in the first 10) naming a date or category column
function headerIndex(table) {
  const i = table.slice(0, 10).findIndex((r) => (r || []).some((c) => HEADER_RX.date.test(c || '') || HEADER_RX.cat.test(c || '')));
  return i < 0 ? 0 : i;
}

export function partOf(cat) {
  const t = (cat || '').normalize('NFKC');
  if (!t) return OTHER.id;
  for (const id of MATCH_ORDER) if (PARTS[id].cats.some((c) => t === c)) return id;
  for (const id of MATCH_ORDER) if (PARTS[id].words.some((w) => t.includes(w))) return id;
  return OTHER.id;
}

// Google Drive share links -> an image URL the browser can show
export function imageUrl(v) {
  const s = (v || '').trim();
  if (!/^https?:\/\//.test(s)) return null;
  const id = (s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]+)/) || [])[1];
  if (id) return { thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w400`, full: `https://drive.google.com/thumbnail?id=${id}&sz=w2000`, link: s };
  return { thumb: s, full: s, link: s };
}

/**
 * tables: list of [header, ...rows] (one per year sheet) -> records, newest first.
 * sheets: the sheet name of each table. Every record gets _sheet (sheet name) and _row (1-based row
 * number in that sheet: table index + 1, as table row 0 is sheet row 1 for gviz with headers=1 and CSV).
 */
export function interpret(tables, sheets = tables.sheets || []) {
  const rows = [];
  let seq = 0;
  for (const [ti, table] of tables.entries()) {
    if (!table?.length) continue;
    const clean = table.map((r) => (r || []).map((c) => String(c ?? '').trim()));
    const hi = headerIndex(clean);
    const headers = (clean[hi] || []).map((h, i) => h || `列${i + 1}`);
    const col = {};
    const used = new Set();
    for (const [k, rx] of Object.entries(HEADER_RX)) {
      if (k === 'image') continue;
      col[k] = headers.findIndex((h, i) => !used.has(i) && rx.test(h));
      if (col[k] >= 0) used.add(col[k]);
    }
    const imgCols = headers.map((h, i) => (HEADER_RX.image.test(h) && !used.has(i) ? i : -1)).filter((i) => i >= 0);
    imgCols.forEach((i) => used.add(i));
    const val = (r, i) => {
      const v = i >= 0 ? (r[i] || '').replace(/[ \t]{2,}/g, ' ') : '';
      return EMPTY.test(v) ? '' : v;
    };
    for (let ri = hi + 1; ri < clean.length; ri++) {
      const r = clean[ri];
      if (!r.some((c) => c && !EMPTY.test(c))) continue;
      const date = val(r, col.date);
      const cat = val(r, col.cat);
      if (!date && !cat) continue; // stray notes / totals
      const d = parseDate(date);
      const images = [];
      for (const i of imgCols) {
        for (const part of (r[i] || '').split(/[\s,、]+/)) {
          const u = imageUrl(part);
          if (u) images.push(u);
        }
      }
      // any other filled column is still shown (labelled by its own header)
      const extra = headers.map((label, i) => ({ label, value: val(r, i) })).filter((c, i) => !used.has(i) && c.value);
      const costText = val(r, col.cost);
      rows.push({
        seq: seq++, date, dateObj: d, year: d ? d.getFullYear() : null,
        cat, part: partOf(cat),
        place: val(r, col.place), slot: val(r, col.slot), staff: val(r, col.staff),
        cost: num(costText), costText, rx: val(r, col.rx), note: val(r, col.note),
        images, extra,
        _sheet: sheets[ti] ?? '', _row: ri + 1,
      });
    }
  }
  // newest first; rows without a date go last, otherwise keep the sheet order (later row = newer)
  const ts = (r) => { const t = r.dateObj?.getTime(); return Number.isFinite(t) ? t : -Infinity; };
  rows.sort((a, b) => {
    const ta = ts(a), tb = ts(b);
    return ta !== tb ? tb - ta : b.seq - a.seq;
  });
  const byPart = { [OTHER.id]: [] };
  for (const id of Object.keys(PARTS)) byPart[id] = [];
  for (const row of rows) byPart[row.part].push(row);
  return { rows, byPart };
}

export function parseDate(text) {
  if (!text) return null;
  const t = String(text).normalize('NFKC');
  let m = t.match(/(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})(?:\D+?(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  m = t.match(/Date\((\d{4}),(\d{1,2}),(\d{1,2})/); // raw gviz value
  if (m) return new Date(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*月?/);
  if (m) return new Date(+m[1], +m[2] - 1, 1);
  return null;
}
