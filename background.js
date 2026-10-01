const IFB_BASE = 'https://www.ifb.ir';
const CACHE_TTL = 30 * 60_000;
// IFB can hang when it is filtered or overloaded; an MV3 worker must always
// answer the content script, so every fetch is bounded.
const FETCH_TIMEOUT = 8_000;
// Bonds resolved at runtime are persisted so a service-worker or browser
// restart does not re-fetch them from a slow IFB.
const RUNTIME_STORAGE_KEY = 'runtimeBonds';
const detailCache = new Map();
let catalogPromise = null;
let liveIndex = null;
const runtimeRecords = new Map(); // normalized symbol -> raw catalog-format record
let runtimeLoaded = false;

const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
function normalizeDigits(value) {
  return String(value)
    .replace(/[۰-۹]/g, digit => String(persianDigits.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)));
}
function normalize(value) {
  return normalizeDigits(value).replace(/[\u064A]/g, '\u06CC').replace(/[\u0643]/g, '\u06A9').replace(/[\u200C\s]/g, '').toLowerCase();
}
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}
function parseNumber(value) {
  const number = Number(normalizeDigits(value).replace(/[\u060C,]/g, '').replace('/', '.'));
  return Number.isFinite(number) ? number : null;
}
function parseJalali(value) {
  const match = normalizeDigits(value).match(/([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})/);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
  return date;
}
function parseInterval(value) {
  const match = normalizeDigits(value).match(/([0-9]+) *ماه/);
  return match ? Number(match[1]) : null;
}
// 8-digit tails carry the full year (13990521, 14080220); 6-digit tails are
// ambiguous between the 13xx and 14xx centuries, so both candidates are
// returned and the alias check accepts either.
function maturitiesFromName(name) {
  const runs = normalizeDigits(name).match(/[0-9]{6,8}(?![0-9])/g);
  if (!runs?.length) return [];
  const tail = runs[runs.length - 1];
  if (tail.length === 8) {
    const date = { year: Number(tail.slice(0, 4)), month: Number(tail.slice(4, 6)), day: Number(tail.slice(6, 8)) };
    return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= 31 ? [date] : [];
  }
  const yy = Number(tail.slice(0, 2));
  const month = Number(tail.slice(2, 4));
  const day = Number(tail.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  return [1300 + yy, 1400 + yy].map(year => ({ year, month, day }));
}
function sameJalaliDate(a, b) {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}
function symbolCandidates(symbol) {
  const key = normalize(symbol);
  const candidates = [key];
  // TSETMC appends a digit to truncated symbols (اراد1904, اخزا3012,
  // تابان204); a one-digit strip is only trusted after the maturity check.
  if (/[0-9]$/.test(key) && key.replace(/[0-9]$/, '').length >= 3) candidates.push(key.replace(/[0-9]$/, ''));
  return candidates;
}
async function loadRuntimeRecords() {
  if (runtimeLoaded) return;
  runtimeLoaded = true;
  try {
    const storage = chrome.storage?.local;
    if (!storage) return;
    const result = await storage.get(RUNTIME_STORAGE_KEY);
    for (const row of result?.[RUNTIME_STORAGE_KEY] || []) {
      const key = normalize(row.symbol);
      if (key) runtimeRecords.set(key, row);
    }
  } catch { /* storage unavailable: runtime records stay session-only */ }
}
function persistRuntimeRecords() {
  try {
    chrome.storage?.local?.set({ [RUNTIME_STORAGE_KEY]: [...runtimeRecords.values()] });
  } catch { /* quota or context loss: the in-memory copy still serves this session */ }
}
function parseCatalogItem(row) {
  return {
    officialSymbol: normalize(row.officialSymbol || row.symbol), name: row.name || '', category: row.category || '',
    parValue: parseNumber(row.parValue), issue: parseJalali(row.issue), maturity: parseJalali(row.maturity),
    rate: parseNumber(row.rate) === null ? null : parseNumber(row.rate) / 100,
    intervalMonths: parseInterval(row.interval), source: row.pageId ? IFB_BASE + '/Instruments.aspx?id=' + row.pageId : null,
  };
}
async function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = loadRuntimeRecords().then(() => fetch(chrome.runtime.getURL('bonds.json'))).then(response => {
      if (!response.ok) throw new Error('catalog HTTP ' + response.status);
      return response.json();
    }).then(rows => {
      const index = new Map();
      for (const row of rows) {
        const item = parseCatalogItem(row);
        index.set(normalize(row.symbol), item);
        index.set(item.officialSymbol, item);
      }
      // Runtime-resolved bonds from earlier sessions merge into the bundled
      // catalog on every service-worker start.
      for (const [key, row] of runtimeRecords) index.set(key, parseCatalogItem(row));
      return index;
    }).catch(error => { catalogPromise = null; throw error; });
  }
  return catalogPromise;
}
// MV3 service workers have no DOMParser: ytm.aspx rows are parsed with a
// regex instead. Matches both IFB grids (coupon bonds and zero-coupon
// khazaneh). Cell order: ردیف, نماد(anchor), قیمت, تاریخ آخرین روز
// معاملاتی, تاریخ سررسید, [YTM/بازده ساده].
function parseIfbRows(html) {
  const rows = new Map();
  const rowPattern = /<a[^>]*\bSymId='([0-9]+)'[^>]*>([^<]+)<\/a>((?:(?!<tr)[\s\S])*?)(?=<tr|<\/table|$)/gi;
  for (const match of html.matchAll(rowPattern)) {
    const hrefMatch = match[0].match(/href='([^']+)'/);
    const cells = stripTags(match[3]).replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!hrefMatch || !cells.length) continue;
    const titleMatch = match[0].match(/title='([^']*)'/);
    rows.set(normalize(match[2]), {
      pageId: match[1],
      href: new URL(hrefMatch[1], IFB_BASE).href,
      title: titleMatch ? titleMatch[1].trim() : '',
      referencePrice: parseNumber(cells[0]),
      referenceLastTrade: parseJalali(cells[1]),
      referenceMaturity: parseJalali(cells[2]),
      referenceYtm: (() => { const ytmCell = cells.find(cell => cell.includes('%')); return ytmCell ? parseNumber(ytmCell.replace('%', '')) : null; })(),
    });
  }
  return rows;
}
async function fetchIfbHtml(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(IFB_BASE + path, { signal: controller.signal });
    if (!response.ok) throw new Error('IFB HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
async function loadLiveIndex() {
  if (liveIndex && Date.now() - liveIndex.time < CACHE_TTL) return liveIndex.index;
  const rows = parseIfbRows(await fetchIfbHtml('/ytm.aspx'));
  if (!rows.size) throw new Error('IFB list parse produced no rows');
  liveIndex = { time: Date.now(), index: rows };
  return rows;
}
// Reads official instrument specs (par value, issue/maturity, nominal rate,
// coupon interval) from an IFB instrument page. The issue date is not shown
// directly; it is recovered from the coupon schedule (dates sharing the
// maturity's day-of-month at the coupon interval) and needs a second
// aligned date to be trusted.
function parseInstrument(html) {
  const fields = {};
  for (const match of html.matchAll(/<span[^>]*>([^<]{2,40})<\/span>\s*<\/td>\s*<td[^>]*>\s*([^<]{0,80})</g)) {
    fields[normalize(match[1])] = stripTags(match[2]).trim();
  }
  const maturity = parseJalali(fields['تاریخسررسید']);
  const rate = parseNumber(fields['نرخسوداسمی']);
  const intervalMonths = parseInterval(fields['مواعدپرداختنسود']);
  const parValue = parseNumber(fields['مبلغاسمیهرورقه']);
  let issue = null;
  if (maturity && intervalMonths && Number.isFinite(rate) && rate > 0) {
    const start = html.indexOf('نرخ سود اسمی');
    const end = html.indexOf('مواعد پرداخت سود');
    if (start >= 0 && end > start) {
      const window = html.slice(start, end);
      const candidates = new Map();
      for (const match of window.matchAll(/14[0-9]{2}\/[0-9]{1,2}\/[0-9]{1,2}/g)) {
        const date = parseJalali(match[0]);
        if (!date) continue;
        const monthDistance = (maturity.year - date.year) * 12 + maturity.month - date.month;
        const aligned = date.day === maturity.day
          && monthDistance > 0 && monthDistance % intervalMonths === 0
          && maturity.month === ((date.month + monthDistance - 1) % 12) + 1;
        if (aligned) candidates.set(date.year + '/' + date.month + '/' + date.day, date);
      }
      if (candidates.size >= 2) {
        issue = [...candidates.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.day - b.day))[0];
      }
    }
  }
  return { parValue, issue, maturity, rate, intervalMonths };
}
async function loadBondDetail(pageId) {
  if (detailCache.has(pageId)) return detailCache.get(pageId);
  const detail = parseInstrument(await fetchIfbHtml('/Instruments.aspx?id=' + pageId));
  detailCache.set(pageId, detail);
  return detail;
}
// Coupon-less families whose IFB row alone is enough when the instrument
// page cannot be fetched: treasury bills and credit certificates carry no
// nominal rate and their par value is the standard 1,000,000 IRR.
const ZERO_FAMILY_WORDS = /اسناد\s*خزانه|اخزا|گام|گواهي\s*اعتبار|گواهی\s*اعتبار/i;
function fmtJalali(date) {
  return date ? date.year + '/' + String(date.month).padStart(2, '0') + '/' + String(date.day).padStart(2, '0') : null;
}
// Live path for symbols missing from the bundled catalog: match the symbol
// on IFB's published YTM list, then read the instrument page for specs.
// Same discipline as refresh_catalog.js — a coupon bond with incomplete
// specs is refused rather than guessed, so it stays blank until a later
// retry instead of showing a wrong YTM.
async function resolveRuntimeBond(symbol, name) {
  const index = await loadLiveIndex();
  const candidates = symbolCandidates(symbol);
  const live = candidates.map(candidate => index.get(candidate)).find(Boolean);
  if (!live) return null;
  // A stripped-digit alias (اخزا5012 -> اخزا501) is only trusted when the
  // maturity embedded in the row name confirms the IFB record.
  if (live !== index.get(candidates[0])
    && !maturitiesFromName(name).some(date => sameJalaliDate(date, live.referenceMaturity))) return null;
  let detail = null;
  try { detail = await loadBondDetail(live.pageId); } catch { /* reference data only */ }
  const zeroFamily = ZERO_FAMILY_WORDS.test(live.title || name || '');
  if (!detail && !zeroFamily) return null;
  const rate = detail?.rate ?? 0;
  const zeroCoupon = !rate;
  if (!zeroCoupon && (!detail.issue || !detail.maturity || !detail.intervalMonths || !detail.parValue)) return null;
  const maturity = detail?.maturity || (zeroCoupon ? live.referenceMaturity : null);
  if (!maturity) return null;
  return {
    symbol, officialSymbol: symbol, pageId: live.pageId,
    name: live.title || name || '', category: '',
    parValue: String(detail?.parValue ?? 1_000_000),
    issue: fmtJalali(detail?.issue) || fmtJalali(maturity),
    maturity: fmtJalali(maturity),
    rate: zeroCoupon ? '0' : String(rate),
    interval: zeroCoupon ? '0 ماه' : detail.intervalMonths + ' ماه',
  };
}
async function loadBond(symbol, name) {
  const candidates = symbolCandidates(symbol);
  const catalog = await loadCatalog();
  let metadata = null;
  let guessed = false;
  for (const candidate of candidates) {
    if (!catalog.has(candidate)) continue;
    metadata = { ...catalog.get(candidate) };
    guessed = candidate !== candidates[0];
    break;
  }
  // Guessed aliases (e.g. اراد1904 -> اراد190) are only trusted when the
  // maturity embedded in the row name confirms the catalog record, so a
  // similarly-numbered but different bond can never hijack the metadata.
  if (metadata && guessed && !maturitiesFromName(name).some(date => sameJalaliDate(date, metadata.maturity))) {
    metadata = null;
  }
  if (!metadata) {
    // Not in the bundled catalog: resolve live from IFB and remember it for
    // future sessions. Failure leaves the row blank until the content
    // script's next hourly retry.
    try {
      const record = await resolveRuntimeBond(symbol, name);
      if (record) {
        metadata = parseCatalogItem(record);
        catalog.set(normalize(symbol), metadata);
        runtimeRecords.set(normalize(symbol), record);
        persistRuntimeRecords();
      }
    } catch { /* IFB unreachable or timed out; retried later */ }
  }
  if (!metadata) return { status: 'notFound' };
  try {
    const index = await loadLiveIndex();
    const live = candidates.map(candidate => index.get(candidate)).find(Boolean);
    if (live) {
      Object.assign(metadata, live);
      if (!metadata.maturity && live.referenceMaturity) metadata.maturity = live.referenceMaturity;
    }
  } catch { /* bundled/runtime metadata remains usable while IFB is unavailable */ }
  return { status: 'ok', metadata };
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'tsetmc-ytm-bond') return;
  loadBond(message.symbol, message.name).then(sendResponse, error => sendResponse({ status: 'error', message: String(error) }));
  return true;
});
if (typeof globalThis !== 'undefined') {
  globalThis.__TSETMC_YTM_BG_TEST__ = { parseIfbRows, parseInstrument, maturitiesFromName, symbolCandidates, parseNumber, parseJalali, parseInterval, normalize, resolveRuntimeBond, parseCatalogItem, fmtJalali };
}
