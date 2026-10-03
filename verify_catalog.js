const fs=require('fs');
const rows=JSON.parse(fs.readFileSync('bonds.json','utf8'));
const allowed=new Set([0,1,2,3,6,12]);
let complete=0, zero=0, coupon=0, bad=[];
for(const r of rows){
  const months=Number(String(r.interval||'').match(/[0-9]+/)?.[0]);
  const rate=Number(String(r.rate??'').replace('/','.'));
  const par=Number(String(r.parValue||'').replace(/,/g,''));
  const ok=r.symbol&&r.issue&&r.maturity&&Number.isFinite(rate)&&allowed.has(months)&&par>0;
  if(ok){complete++;if(rate===0||months===0)zero++;else coupon++;}else bad.push(r.symbol);
}
console.log(JSON.stringify({total:rows.length,complete,zero,coupon,incomplete:bad.length}));
// Regression: پاسار09 carried parValue 7,000,000 — unique in the catalog and
// disproven by the reference sheet (at 1,000,000 it recomputes to 25.047 ≈
// the official 25.05); the wrong par rendered 297.61٪ in the extension.
const pasargad=rows.find(r=>r.symbol==='پاسار09');
const pasargadPar=Number(String(pasargad?.parValue||'').replace(/,/g,''));
if(pasargadPar!==1000000){console.error('پاسار09 parValue must be 1,000,000, got '+pasargad?.parValue);process.exit(1);}
// Catalog grew from 1004 to 1060 rows in the 2026-10-03 live refresh.
if(rows.length!==1061||complete<1041)process.exit(1);
