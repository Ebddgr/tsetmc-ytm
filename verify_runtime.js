// Runtime-resolution tests: stubbed IFB pages, storage persistence across a
// simulated worker restart, strictness for incomplete coupon specs, and the
// alias/maturity hijack guard.
const fs = require('fs'), vm = require('vm');

// ytm.aspx shape: anchor(symbol, SymId, title) then newline-separated cells:
// قیمت, تاریخ آخرین روز معاملاتی, تاریخ سررسید, [YTM/بازده ساده].
const YTM_FIXTURE = [
  '<table>',
  '<tr><td>1</td><td><a href=\'/Instruments.aspx?id=99901\' SymId=\'99901\' title=\'اسناد خزانه-م5-080615\'>تست501</a></td>',
  '<td>945,150</td>',
  '<td>1405/06/18</td>',
  '<td>1408/06/15</td>',
  '<td>40.15%</td></tr>',
  '<tr><td>2</td><td><a href=\'/Instruments.aspx?id=99902\' SymId=\'99902\' title=\'مرابحه عام دولت306-ش.خ070402\'>تست306</a></td>',
  '<td>830,000</td>',
  '<td>1405/06/18</td>',
  '<td>1407/04/02</td>',
  '<td>39.70%</td></tr>',
  '<tr><td>3</td><td><a href=\'/Instruments.aspx?id=99903\' SymId=\'99903\' title=\'مرابحه عام دولت307-ش.خ070409\'>تست307</a></td>',
  '<td>700,000</td>',
  '<td>1405/06/18</td>',
  '<td>1406/06/20</td>',
  '<td>41.00%</td></tr>',
  '<tr><td>4</td><td><a href=\'/Instruments.aspx?id=99904\' SymId=\'99904\' title=\'مرابحه عام دولت308-ش.خ060620\'>تست308</a></td>',
  '<td>820,000</td>',
  '<td>1405/06/18</td>',
  '<td>1406/06/20</td>',
  '<td>40.20%</td></tr>',
  '</table>',
].join('\n');

// Zero-coupon page: maturity + par, no nominal rate.
const INSTRUMENT_99901 = [
  '<table>',
  '<tr><td><span>تاریخ سررسید</span></td><td>1408/06/15</td></tr>',
  '<tr><td><span>مبلغ اسمی هر ورقه</span></td><td>1,000,000</td></tr>',
  '</table>',
].join('\n');

// Complete coupon page in the current live shape: the issue date is shown
// directly as 'تاریخ انتشار' and the interval label is spelled correctly
// ('مواعد پرداخت سود'); the old stray-ن spelling is kept in one row so both
// forms stay covered.
const INSTRUMENT_99902 = [
  '<table>',
  '<tr><td><span>تاریخ سررسید</span></td><td>1407/04/02</td></tr>',
  '<tr><td><span>نرخ سود اسمی</span></td><td>23</td></tr>',
  '<tr><td><span>تاریخ انتشار</span></td><td>1404/04/02</td></tr>',
  '<tr><td><span>مواعد پرداخت سود</span></td><td>3 ماه</td></tr>',
  '<tr><td><span>مبلغ اسمی هر ورقه</span></td><td>1,000,000</td></tr>',
  '</table>',
].join('\n');

// Legacy coupon page shape: no direct issue-date field and the old stray-ن
// interval spelling; the issue date must be recovered from the aligned
// coupon schedule between the rate field and the interval marker.
const INSTRUMENT_99904 = [
  '<table>',
  '<tr><td><span>تاریخ سررسید</span></td><td>1406/06/20</td></tr>',
  '<tr><td><span>نرخ سود اسمی</span></td><td>23</td></tr>',
  '<tr><td>1404/06/20</td><td>1405/06/20</td></tr>',
  '<tr><td>مواعد پرداخت سود</td><td>هر شش ماه</td></tr>',
  '<tr><td><span>مواعد پرداخت نسود</span></td><td>6 ماه</td></tr>',
  '<tr><td><span>مبلغ اسمی هر ورقه</span></td><td>1,000,000</td></tr>',
  '</table>',
].join('\n');

function makeContext({ storageMap, offline }) {
  const listeners = [];
  const context = {
    console, URL, setTimeout, clearTimeout, AbortController,
    fetch: async url => {
      const u = String(url);
      if (u.endsWith('bonds.json')) return { ok: true, json: async () => JSON.parse(fs.readFileSync('bonds.json', 'utf8')) };
      if (offline) throw new Error('offline: ' + u);
      if (u.includes('ytm.aspx')) return { ok: true, text: async () => YTM_FIXTURE };
      if (u.includes('id=99901')) return { ok: true, text: async () => INSTRUMENT_99901 };
      if (u.includes('id=99902')) return { ok: true, text: async () => INSTRUMENT_99902 };
      if (u.includes('id=99904')) return { ok: true, text: async () => INSTRUMENT_99904 };
      throw new Error('IFB HTTP 404: ' + u);
    },
    chrome: {
      runtime: { getURL: p => p, onMessage: { addListener: fn => listeners.push(fn) } },
      storage: storageMap ? {
        local: {
          get: async key => ({ [key]: storageMap.get(key) }),
          set: async obj => { for (const [k, v] of Object.entries(obj)) storageMap.set(k, v); },
        },
      } : undefined,
    },
  };
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), context);
  return { request: (symbol, name) => new Promise(resolve => listeners[0]({ type: 'tsetmc-ytm-bond', symbol, name }, null, resolve)) };
}

let failed = 0;
const check = (label, pass, extra) => { if (!pass) failed++; console.log((pass ? 'PASS' : 'FAIL'), label, extra ?? ''); };

(async () => {
  // Session 1: IFB reachable.
  const storage1 = new Map();
  const live = makeContext({ storageMap: storage1 });

  const r1 = await live.request('تست501', 'اسناد خزانه-م5-080615');
  check('تست501 resolves at runtime', r1.status === 'ok', r1.status);
  check('تست501 zero-coupon record', r1.metadata?.rate === 0 && r1.metadata?.intervalMonths === 0, JSON.stringify({ rate: r1.metadata?.rate, interval: r1.metadata?.intervalMonths }));
  check('تست501 maturity', r1.metadata?.maturity?.year === 1408 && r1.metadata?.maturity?.month === 6 && r1.metadata?.maturity?.day === 15, JSON.stringify(r1.metadata?.maturity));
  check('تست501 par 1,000,000', r1.metadata?.parValue === 1000000, String(r1.metadata?.parValue));
  check('تست501 official ytm merged', r1.metadata?.referenceYtm === 40.15, String(r1.metadata?.referenceYtm));

  const r2 = await live.request('تست306', 'مرابحه عام دولت306-ش.خ070402');
  check('تست306 resolves with full specs', r2.status === 'ok' && r2.metadata?.rate === 0.23 && r2.metadata?.intervalMonths === 3 && r2.metadata?.parValue === 1000000, JSON.stringify({ status: r2.status, rate: r2.metadata?.rate, interval: r2.metadata?.intervalMonths }));
  check('تست306 issue recovered', r2.metadata?.issue?.year === 1404 && r2.metadata?.issue?.month === 4 && r2.metadata?.issue?.day === 2, JSON.stringify(r2.metadata?.issue));
  check('تست306 official ytm merged', r2.metadata?.referenceYtm === 39.7, String(r2.metadata?.referenceYtm));
  check('two records persisted', (storage1.get('runtimeBonds') || []).length === 2, String((storage1.get('runtimeBonds') || []).length));

  const r3 = await live.request('تست307', 'مرابحه عام دولت307-ش.خ070409');
  check('coupon without specs stays notFound', r3.status === 'notFound', r3.status);

  const r3b = await live.request('تست308', 'مرابحه عام دولت308-ش.خ060620');
  check('legacy page issue recovered from schedule', r3b.status === 'ok' && r3b.metadata?.issue?.year === 1404 && r3b.metadata?.issue?.month === 6 && r3b.metadata?.issue?.day === 20, JSON.stringify({ status: r3b.status, issue: r3b.metadata?.issue }));
  check('legacy page interval parsed', r3b.metadata?.intervalMonths === 6, String(r3b.metadata?.intervalMonths));
  check('three records persisted', (storage1.get('runtimeBonds') || []).length === 3, String((storage1.get('runtimeBonds') || []).length));

  const r4 = await live.request('تست5012', 'اسناد خزانه-م5-080616');
  check('alias hijack rejected', r4.status === 'notFound', r4.status);
  const r5 = await live.request('تست5012', 'اسناد خزانه-م5-080615');
  check('confirmed alias accepted', r5.status === 'ok', r5.status);
  // r5 resolves through the persisted تست501 record via the alias guard,
  // so it is not persisted as its own record.
  check('still three records after alias resolution', (storage1.get('runtimeBonds') || []).length === 3, String((storage1.get('runtimeBonds') || []).length));

  // Session 2: worker restart with IFB offline; the storage merge keeps the
  // resolved bonds alive without any network.
  const cold = makeContext({ storageMap: storage1, offline: true });
  const r6 = await cold.request('تست501', 'اسناد خزانه-م5-080615');
  check('zero-coupon survives restart offline', r6.status === 'ok' && r6.metadata?.rate === 0, JSON.stringify(r6.status));
  const r7 = await cold.request('تست306', 'مرابحه عام دولت306-ش.خ070402');
  check('coupon survives restart offline', r7.status === 'ok' && r7.metadata?.rate === 0.23, JSON.stringify(r7.status));
  const r8 = await cold.request('تست5012', 'اسناد خزانه-م5-080615');
  check('alias-resolved bond survives restart offline', r8.status === 'ok', r8.status);

  const t0 = Date.now();
  const r9 = await cold.request('فولاد', 'فولاد مبارکه');
  check('offline unknown fails fast, no hang', r9.status === 'notFound' && Date.now() - t0 < 5000, r9.status);

  if (failed) { console.error(failed + ' runtime check(s) failed'); process.exit(1); }
  console.log('all runtime checks passed');
})().catch(e => { console.error('verify_runtime crashed:', e); process.exit(1); });
