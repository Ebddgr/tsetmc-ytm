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
if (failed) { console.error(failed+' benchmark(s) exceeded tolerance'); process.exit(1); }
