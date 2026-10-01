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
if(rows.length!==1004||complete<981)process.exit(1);
