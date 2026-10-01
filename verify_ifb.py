import json, re, sys, urllib.request
from pathlib import Path
sys.path.insert(0, 'C:/Users/ebidr/Bond_dashboard/backend')
from services.coupon_calculation import bond_irr

snapshot = Path('.ifb-ytm-snapshot.html')
if snapshot.exists():
    html = snapshot.read_text(encoding='utf-8')
else:
    html = urllib.request.urlopen('https://www.ifb.ir/ytm.aspx', timeout=30).read().decode('utf-8')
pattern = re.compile(r"<tr[^>]*>.*?<a[^>]*SymId='(?P<id>\d+)'[^>]*>\s*(?P<symbol>اراد\d+)\s*</a>.*?<td[^>]*>\s*(?P<price>[\d,]+)\s*</td>.*?<td[^>]*>\s*(?P<trade>\d{4}-\d{2}-\d{2})\s*</td>.*?<td[^>]*>\s*(?P<maturity>\d{4}-\d{2}-\d{2})\s*</td>.*?<div[^>]*>\s*(?P<ytm>[\d/.]+)%", re.S)
rows = {m['symbol']: m.groupdict() for m in pattern.finditer(html)}
metadata = json.loads(Path('C:/Users/ebidr/Bond_dashboard/cache/ifb_ins_info.json').read_text(encoding='utf-8'))
by_symbol = {x.get('symbol') or x.get('نماد'): x for x in metadata}
results=[]
for symbol,row in reversed(list(rows.items())):
    meta=by_symbol.get(symbol)
    if not meta or not all(meta.get(k) for k in ('تاریخ انتشار','تاریخ سررسید','نرخ سود اسمی','مواعد پرداخت سود')): continue
    months=int(meta['مواعد پرداخت سود'].split()[0]); freq=12//months
    actual=bond_irr(float(row['price'].replace(',','')),1_000_000,float(meta['نرخ سود اسمی'].replace('/','.'))/100,meta['تاریخ انتشار'],meta['تاریخ سررسید'],freq,row['trade'])*100
    official=float(row['ytm'].replace('/','.'))
    results.append(dict(symbol=symbol,price=row['price'],trade=row['trade'],maturity=row['maturity'],official=official,calculated=actual,error=actual-official,issue=meta['تاریخ انتشار'],rate=meta['نرخ سود اسمی'],months=months))
    if len(results)==8: break
print(json.dumps(results,ensure_ascii=False,indent=2))
if len(results)<5: raise SystemExit('fewer than five samples')
