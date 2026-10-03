// Validates the DOMParser-free IFB ytm.aspx parser against the real page
// snapshot, plus instrument-spec parsing helpers.
const fs = require('fs'), vm = require('vm');
const context = {
  console, URL, fetch: async () => { throw new Error('offline'); },
  chrome: { runtime: { getURL: p => p, onMessage: { addListener() {} } } },
};
vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), context);
const t = context.__TSETMC_YTM_BG_TEST__;
const html = fs.readFileSync('.ifb-ytm-snapshot.html', 'utf8');
const rows = t.parseIfbRows(html);
let failed = 0;
const check = (label, pass, extra) => { if (!pass) failed++; console.log((pass ? 'PASS' : 'FAIL'), label, extra ?? ''); };
check('row count over 900', rows.size > 900, '(' + rows.size + ')');
const dekoosar = rows.get(t.normalize('دکوثر06'));
check('دکوثر06 price 864000', dekoosar?.referencePrice === 864000, JSON.stringify(dekoosar?.referencePrice));
check('دکوثر06 ytm 39.93', dekoosar?.referenceYtm === 39.93, JSON.stringify(dekoosar?.referenceYtm));
check('دکوثر06 pageId 40578', dekoosar?.pageId === '40578');
const matured = rows.get(t.normalize('اخزا001'));
check('matured row has null ytm', matured?.referenceYtm === null);
let numeric = 0, blank = 0;
for (const [, v] of rows) (v.referenceYtm === null ? blank++ : numeric++);
// The snapshot is refreshed on every live fetch; the pin tracks the
// 2026-10-03 snapshot (518 numeric) with a small tolerance for intraday
// rows maturing between fetches.
check('numeric ytm rows near 518', Math.abs(numeric - 518) <= 2, '(' + numeric + ' numeric / ' + blank + ' blank)');
check('maturities 8-digit', JSON.stringify(t.maturitiesFromName('اجاره تابان فردادماوند14080220')) === '[{"year":1408,"month":2,"day":20}]');
check('maturities 6-digit both centuries', t.maturitiesFromName('اسنادخزانه-م8بودجه80-990521').some(d => d.year === 1399));
check('maturities stock name empty', t.maturitiesFromName('گروه پتروشيمي تابان فردا').length === 0);
check('parseNumber persian decimal', t.parseNumber('39/93') === 39.93);
check('parseNumber latin comma', t.parseNumber('864,000') === 864000);
if (failed) { console.error(failed + ' live-index check(s) failed'); process.exit(1); }
console.log('all live-index checks passed');
