/**
 * セルフケアアプリ → セルフケア管理表 への書き込み口（Google Apps Script）
 *
 * 使い方
 *  1. セルフケア管理表を開き「拡張機能」→「Apps Script」
 *  2. このファイルの中身をすべて貼り付け、下の TOKEN を好きな合言葉に変えて保存
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *  4. 表示された「ウェブアプリの URL」と合言葉を、アプリの 設定 → スプレッドシートへの書き込み に入れて保存
 *     （スクリプトを書き換えたときは「デプロイを管理」→ 編集 → 新しいバージョン で更新）
 *
 * アプリから届く JSON（POST 本文）
 *  {token, action:'add',    record:{日時:'2026-11-23', カテゴリ, 場所, 時間帯, 担当者, 料金, 調剤, 特記事項}}
 *  {token, action:'update', sheet:'2026', row:12, record:{…変更した項目だけ…}, expect:{date:'2026-11-23', cat:'歯科'}}
 *  {token, action:'delete', sheet:'2026', row:12, expect:{…}}
 *  add は日時の年のシート（なければ標準の見出しで新規作成）の末尾に1行追加します。
 *  update / delete は sheet と row（1始まりの行番号）で行を特定します。expect があれば、その行の
 *  日時・カテゴリが一致するか確かめ、違えば（行がずれていれば）何も書かずにエラーを返します。
 *  返り値は {ok:true, …} または {ok:false, error:'…'}。
 */
const TOKEN = "CHANGE_ME";

const STANDARD_HEADERS = ['日時', 'カテゴリ', '場所', '時間帯', '担当者', '料金', '調剤', '特記事項', '画像1', '画像2', '画像3'];
// which sheet column a record field goes to: matched by header name (same rules as the app's js/sheet.js)
const FIELD_RX = [
  ['日時', /日時|日付|年月日|^日$/],
  ['カテゴリ', /カテゴリ|分類|区分|診療科|種別/],
  ['場所', /場所|病院|医院|クリニック|店舗|店名|施設/],
  ['時間帯', /時間帯|時間|時刻/],
  ['担当者', /担当|医師|スタッフ/],
  ['料金', /料金|金額|費用|代金|価格/],
  ['調剤', /調剤|処方|薬/],
  ['特記事項', /特記|備考|メモ|コメント|事項|内容/],
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (TOKEN === 'CHANGE_ME') return json({ ok: false, error: 'Apps Script の TOKEN が初期値のままです。合言葉に変えて保存・再デプロイしてください' });
    if (req.token !== TOKEN) return json({ ok: false, error: '合言葉（トークン）が違います' });
    if (!lock.tryLock(20000)) return json({ ok: false, error: 'ほかの書き込みが終わらないため、時間をおいてやり直してください' });
    if (req.action === 'add') return json(addRecord(req.record || {}));
    if (req.action === 'update') return json(updateRecord(req));
    if (req.action === 'delete') return json(deleteRecord(req));
    return json({ ok: false, error: '不明な action: ' + req.action });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) { /* not held */ }
  }
}

function doGet() {
  return json({ ok: true, message: 'セルフケアアプリの書き込み口です' });
}

// ---------- actions ----------
function addRecord(record) {
  const date = parseDate(record['日時']);
  if (!date) throw new Error('日時が正しくありません');
  const sheet = yearSheet(String(date.getFullYear()));
  const info = headerInfo(sheet);
  const width = Math.max(sheet.getLastColumn(), info.headers.length);
  const values = new Array(width).fill('');
  const skipped = fill(values, info, record);
  const at = Math.max(sheet.getLastRow(), info.row) + 1;
  const target = sheet.getRange(at, 1, 1, width);
  if (at - 1 > info.row) sheet.getRange(at - 1, 1, 1, width).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  target.setValues([values]);
  return { ok: true, sheet: sheet.getName(), row: at, skipped: skipped };
}

function updateRecord(req) {
  const t = targetRow(req);
  const range = t.sheet.getRange(t.row, 1, 1, t.width);
  const values = range.getValues()[0];
  const skipped = fill(values, t.info, req.record || {});
  range.setValues([values]);
  return { ok: true, sheet: t.sheet.getName(), row: t.row, skipped: skipped };
}

function deleteRecord(req) {
  const t = targetRow(req);
  t.sheet.deleteRow(t.row);
  return { ok: true, sheet: t.sheet.getName(), row: t.row };
}

// ---------- helpers ----------
// the sheet + row an update / delete points at, checked against what the app saw (expect)
function targetRow(req) {
  const sheet = findSheet(req.sheet);
  const row = Number(req.row);
  const info = headerInfo(sheet);
  if (!(row > info.row) || row > sheet.getLastRow()) throw new Error('行番号が範囲外です（' + req.sheet + ' シート ' + req.row + ' 行目）');
  const width = Math.max(sheet.getLastColumn(), 1);
  const ex = req.expect;
  if (ex) {
    const values = sheet.getRange(row, 1, 1, width).getValues()[0];
    const display = sheet.getRange(row, 1, 1, width).getDisplayValues()[0];
    const di = info.col['日時'], ci = info.col['カテゴリ'];
    const okCat = ci == null || ex.cat == null || norm(display[ci]) === norm(ex.cat);
    let okDate = true;
    if (di != null && ex.date) {
      const d = values[di] instanceof Date ? values[di] : parseDate(display[di]);
      okDate = !!d && Utilities.formatDate(d, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') === ex.date;
    }
    if (!okCat || !okDate) throw new Error('対象の行が見つかりません（スプレッドシートが変更された可能性があります）。アプリで再読み込みしてからやり直してください');
  }
  return { sheet: sheet, row: row, width: width, info: info };
}

function findSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  name = String(name == null ? '' : name);
  if (name === '') return ss.getSheets()[0];
  const gid = name.match(/^#gid=(\d+)$/);
  if (gid) {
    const s = ss.getSheets().filter(function (x) { return String(x.getSheetId()) === gid[1]; })[0];
    if (s) return s;
  }
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」がありません');
  return sheet;
}

// the sheet for a year; created with the standard header row when missing, next to the other year sheets
function yearSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = ss.getSheetByName(name);
  if (found) return found;
  const years = ss.getSheets().filter(function (s) { return /^\d{4}$/.test(s.getName()); });
  let index = ss.getSheets().length;
  if (years.length) {
    const newest = years.reduce(function (a, b) { return Number(b.getName()) > Number(a.getName()) ? b : a; });
    const oldest = years.reduce(function (a, b) { return Number(b.getName()) < Number(a.getName()) ? b : a; });
    const descending = newest.getIndex() < oldest.getIndex(); // getIndex() is 1-based
    index = descending ? newest.getIndex() - 1 : newest.getIndex();
  }
  const sheet = ss.insertSheet(name, index);
  sheet.getRange(1, 1, 1, STANDARD_HEADERS.length).setValues([STANDARD_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

// header row = first row (in the first 10) naming a date or category column; col: field -> 0-based column
function headerInfo(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const top = sheet.getRange(1, 1, Math.min(Math.max(sheet.getLastRow(), 1), 10), lastCol).getDisplayValues();
  let hi = top.findIndex(function (r) { return r.some(function (c) { return FIELD_RX[0][1].test(c) || FIELD_RX[1][1].test(c); }); });
  if (hi < 0) hi = 0;
  const headers = top[hi].map(function (h) { return String(h).trim(); });
  const col = {};
  const used = {};
  FIELD_RX.forEach(function (f) {
    const i = headers.findIndex(function (h, j) { return !used[j] && f[1].test(h); });
    if (i >= 0) { col[f[0]] = i; used[i] = true; }
  });
  return { row: hi + 1, headers: headers, col: col };
}

// write the record's fields into a row array by header name; returns fields the sheet has no column for
function fill(values, info, record) {
  const skipped = [];
  Object.keys(record).forEach(function (k) {
    const i = info.col[k];
    if (i == null) { if (String(record[k] || '') !== '') skipped.push(k); return; }
    values[i] = cellValue(k, record[k]);
  });
  return skipped;
}

function cellValue(field, v) {
  v = v == null ? '' : String(v).trim();
  if (v === '') return '';
  if (field === '日時') return parseDate(v) || v;
  if (field === '料金') {
    const n = v.replace(/[¥￥,\s円]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(n)) return Number(n);
  }
  return v;
}

// '2026-11-23', '2026/11/23', '2026年11月23日', optionally followed by 'HH:MM'
function parseDate(v) {
  if (v instanceof Date) return v;
  const m = String(v || '').normalize('NFKC').match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})(?:\D+?(\d{1,2}):(\d{2}))?/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)) : null;
}

function norm(s) { return String(s == null ? '' : s).normalize('NFKC').trim(); }

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
