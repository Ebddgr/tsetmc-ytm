// Refreshes bonds.json from IFB: live ytm.aspx list + instrument pages.
// Falls back to .ifb-ytm-snapshot.html when ifb.ir is unreachable; new
// coupon bonds needing instrument pages are skipped until a live run.
const fs = require('fs');
const vm = require('vm');
const ctx = { console, URL, fetch, chrome: { runtime: { getURL: p => p, onMessage: { addListener() {} } } } };
vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), ctx);
const t = ctx.__TSETMC_YTM_BG_TEST__;
const CATEGORY_BY_TYPE = { 'مرابحه': 'صكوك مرابحه', 'اجاره': 'صكوك اجاره', 'اسناد خزانه': 'اسناد خزانه اسلامي', 'گواهي اعتبار مولد': 'اوراق گواهي اعتبار مولد', 'گواهی اعتبار مولد': 'اوراق گواهي اعتبار مولد' };
async function fetchText(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
    catch (e) { if (i === attempts) throw e; await new Promise(r => setTimeout(r, 1500 * i)); }
  }
}
function titlesByPageId(html) {
  const map = new Map();
  for (const m of html.matchAll(/SymId='([0-9]+)'[^>]*title='([^']*)'/g)) map.set(m[1], m[2].trim());
  return map;
}
function nameTailMaturity(name) { return t.maturityFromName(name); }
async function main() {
  const rows = JSON.parse(fs.readFileSync('bonds.json', 'utf8'));
  const byKey = new Map();
  for (const row of rows) { byKey.set(t.normalize(row.symbol), row); byKey.set(t.normalize(row.officialSymbol || row.symbol), row); }
  let html;
  let source;
  try { html = await fetchText('https://www.ifb.ir/ytm.aspx', 2); source = 'live ifb.ir'; }
  catch { html = fs.readFileSync('.ifb-ytm-snapshot.html', 'utf8'); source = 'local snapshot (ifb.ir unreachable)'; }
  console.log('ytm list source:', source);
  const live = t.parseIfbRows(html);
  const titles = titlesByPageId(html);
  console.log('live rows parsed:', live.size);
  // add new symbols seen on the live list; coupon bonds need instrument
  //    pages (issue date/rate/interval) so they are only added when IFB is
  //    reachable; zero-coupon bonds only need maturity + par value
  const added = [];
  const skipped = [];
  for (const [key, item] of live) {
    if (byKey.has(key)) continue;
    const symbol = key;
    const name = titles.get(item.pageId) || '';
    const liveNetwork = source === 'live ifb.ir';
    if (!liveNetwork) { skipped.push(symbol + ' (needs ifb.ir)'); continue; }
    let detail = null;
    try { detail = t.parseInstrument(await fetchText(item.href, 2)); }
    catch (e) { skipped.push(symbol + ' (detail fetch failed)'); continue; }
    const rate = detail.rate;
    const zeroCoupon = rate === null || rate === 0;
    if (!zeroCoupon && (!detail.issue || !detail.intervalMonths || !detail.parValue)) {
      skipped.push(symbol + ' (incomplete specs)'); continue;
    }
    const record = {
      symbol, officialSymbol: symbol, pageId: item.pageId, name,
      category: CATEGORY_BY_TYPE[detail.category || ''] || '',
      parValue: detail.parValue === null ? '1,000,000' : String(detail.parValue),
      issue: zeroCoupon ? (detail.issue ? fmt(detail.issue) : fmt(item.referenceMaturity)) : fmt(detail.issue),
      maturity: fmt(detail.maturity || item.referenceMaturity),
      rate: zeroCoupon ? '0' : String(rate),
      interval: zeroCoupon ? '0 ماه' : detail.intervalMonths + ' ماه',
    };
    if (!record.issue || !record.maturity) { skipped.push(symbol + ' (no dates)'); continue; }
    rows.push(record);
    byKey.set(t.normalize(symbol), record);
    added.push(symbol);
  }
  function fmt(d) { return d ? d.year + '/' + String(d.month).padStart(2, '0') + '/' + String(d.day).padStart(2, '0') : null; }
  console.log('added:', added.length, added.slice(0, 20));
  console.log('skipped:', skipped.length, skipped.slice(0, 20));
  if (added.length) {
    fs.writeFileSync('bonds.json', JSON.stringify(rows));
    console.log('bonds.json written, total rows:', rows.length);
  } else {
    console.log('no changes; bonds.json untouched');
  }
}
main().catch(e => { console.error('refresh failed:', e.message); process.exit(1); });
