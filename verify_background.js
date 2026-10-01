const fs = require('fs'), vm = require('vm');
class FakeDOMParser { parseFromString() { return { querySelectorAll: () => [] }; } }
const listeners = [];
const context = {
  console, URL, DOMParser: FakeDOMParser,
  fetch: async url => {
    if (String(url).endsWith('bonds.json')) return { ok: true, json: async () => JSON.parse(fs.readFileSync('bonds.json', 'utf8')) };
    throw new Error('offline');
  },
  chrome: { runtime: { getURL: p => p, onMessage: { addListener: fn => listeners.push(fn) } } },
};
vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), context);
const request = (symbol, name) => new Promise(resolve => listeners[0]({ type: 'tsetmc-ytm-bond', symbol, name }, null, resolve));
const catalog = JSON.parse(fs.readFileSync('bonds.json', 'utf8'));
const arad113 = catalog.find(r => r.symbol === 'اراد113');
const arad114 = catalog.find(r => r.symbol === 'اراد114');
const cases = [
  ['اراد113', arad113.name, 'ok'],
  ['اراد1134', arad113.name, 'ok'],
  ['اراد1134', arad114.name, 'notFound'],
  ['اراد1134', 'گروه پتروشيمي تابان فردا', 'notFound'],
  ['اخزا203', 'اسناد خزانه-م3-050619', 'ok'],
  ['گام050617', 'گواهي اعتبارمولد کشاورزي050631', 'ok'],
  ['طبیعت071', arad113.name, 'ok'],
  ['تابان23', 'اجاره تابان فردا نوین14080418', 'ok'],
  ['تابان', 'گروه پتروشيمي تابان فردا', 'notFound'],
  ['اخزا3012', 'اسناد خزانه-م1-س.قوا03-060615', 'ok'],
  ['تابان204', 'اجاره تابان فردادماوند14080220', 'ok'],
  ['تابان204', 'اجاره تابان فردا نوین14061222', 'notFound'],
  ['اراد2854', 'مرابحه عام دولت285-ش.خ070419', 'ok'],
  ['وامين074', 'اجاره توان آفرين ساز 14070216', 'ok'],
  ['اراد3012', 'اسناد خزانه-م1-س.قوا03-060615', 'notFound'],
    ['فولاد', 'فولاد مبارکه', 'notFound'],
];
let failed = 0;
(async () => {
  for (const [symbol, name, expected] of cases) {
    const r = await request(symbol, name);
    const pass = r.status === expected;
    if (!pass) failed++;
    console.log((pass ? 'PASS' : 'FAIL'), symbol, '->', r.status, '(expected', expected + ')', name ? '"' + name.slice(0, 24) + '"' : '');
  }
  if (failed) { console.error(failed + ' case(s) failed'); process.exit(1); }
  console.log('all background cases passed');
})();
