global.document = undefined;
require('./content.js');
const y = global.__TSETMC_YTM_TEST__;
const samples = [
  ['اراد292',810000,'1405-05-11','1405-04-09','1407-09-09',23,6,38.98],
  ['اراد291',821000,'1405-06-15','1405-04-09','1407-05-09',23,6,40.51],
  ['اراد290',820580,'1405-04-02','1405-04-02','1407-04-02',23,6,39.70],
  ['اراد289',874260,'1405-05-14','1405-03-26','1407-08-26',23,6,33.63],
  ['اراد288',895610,'1405-05-14','1405-03-26','1407-05-26',23,6,32.71],
];
function date(s) { const [year,month,day]=s.split('-').map(Number); return {year,month,day,utc:y.jalaliToGregorianUtc(year,month,day)}; }
let failed=0;
for (const [symbol,price,trade,issue,maturity,rate,months,official] of samples) {
  const actual=y.couponBondYtm(price,1000000,date(issue),date(maturity),rate/100,months,date(trade).utc);
  const error=actual-official;
  console.log([symbol,official,actual.toFixed(4),error.toFixed(4)].join('|'));
  if (Math.abs(error)>0.02) failed++;
}
const zeroSamples = [
  ['اخزا203',945150,'1405-06-18','1405-08-18',40.15],
  ['اخزا204',896100,'1405-06-16','1405-10-21',37.41],
  ['گام050617',886650,'1405-02-29','1405-06-31',41.69],
  ['گام050661',984330,'1405-06-15','1405-06-31',43.38],
];
for (const [symbol,price,trade,maturity,official] of zeroSamples) {
  const days=(date(maturity).utc-date(trade).utc)/86400000;
  const actual=(Math.pow(1000000/price,365/days)-1)*100;
  const error=actual-official;
  console.log([symbol,official,actual.toFixed(4),error.toFixed(4)].join('|'));
  if (Math.abs(error)>0.02) failed++;
}
const categorySamples = [
  ['طبیعت071',1000000,'1404-03-11','1404-03-11','1407-03-11',23,3,25.06],
  ['تابان23',1000000,'1405-06-16','1404-04-18','1408-04-18',23,3,25.08],
];
for (const [symbol,price,trade,issue,maturity,rate,months,official] of categorySamples) {
  const actual=y.couponBondYtm(price,1000000,date(issue),date(maturity),rate/100,months,date(trade).utc);
  const error=actual-official;
  console.log([symbol,official,actual.toFixed(4),error.toFixed(4)].join('|'));
  if (Math.abs(error)>0.02) failed++;
}
// Trade-date anchoring: YTM must not drift with time-of-day. اراد284 (specs
// from bonds.json) at 916,050 on 1405/07/10 reads the official 40.18٪ no
// matter when during the day it is evaluated; before anchoring it crept up to
// 40.23٪ by midnight while the price never moved.
const anchorSpecs = {
  price: 916050,
  name: 'مرابحه عام دولت284-ش.خ060419',
  metadata: { parValue: 1000000, issue: date('1405-03-19'), maturity: date('1406-04-19'), rate: 0.23, intervalMonths: 6 },
  maturity: date('1406-04-19'),
};
const anchorDay = date('1405-07-10').utc;
const anchorSeen = [];
for (const hours of [0, 6.5, 12, 15.5, 20.5, 23.99]) {
  const result = y.calculateYtm(anchorSpecs.price, anchorSpecs.maturity, anchorSpecs.name, anchorSpecs.metadata, anchorDay + hours * 3_600_000);
  if (!result) { console.error('anchor: no result @+'+hours+'h'); failed++; continue; }
  anchorSeen.push(result.value);
  console.log(['anchor@+'+hours+'h', '40.18', result.value.toFixed(4)].join('|'));
  if (result.value.toFixed(2) !== '40.18') { console.error('anchor: expected 40.18 @+'+hours+'h, got '+result.value); failed++; }
}
if (anchorSeen.length > 1 && new Set(anchorSeen).size !== 1) {
  console.error('anchor: intraday drift ' + anchorSeen.join(', '));
  failed++;
}
if (y.startOfUtcDay(anchorDay + 15.5 * 3_600_000) !== anchorDay) {
  console.error('startOfUtcDay does not truncate to day start');
  failed++;
}
if (failed) { console.error(failed+' benchmark(s) exceeded tolerance'); process.exit(1); }
