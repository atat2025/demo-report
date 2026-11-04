// 【例】サンプルデータ：マスター口座 10/1〜11/3、10/20にデモ資金+50,000の追加（損益から除外される）
module.exports=(db,crypto)=>{let s=11;const rnd=()=>(s=(s*16807)%2147483647)/2147483647;
db.run("INSERT INTO settings(k,v) VALUES('strategy','超短期スキャルピングを中心に、BTCUSDT・ETHUSDTで1日数回の取引を行います。\n損切りラインを事前に設定し、レバレッジは上限以内を厳守します。'),('leverage','10')");
let E=100000;for(let d=0;d<=33;d++){const dt=new Date(Date.UTC(2026,9,1+d));const date=dt.toISOString().slice(0,10);let flow=0,dayPnl=0;
 if(d){for(let k=0;k<2;k++){const sym=rnd()<.6?'BTCUSDT':'ETHUSDT',px=sym=='BTCUSDT'?76000+rnd()*2000:2900+rnd()*100,long=rnd()<.6,qty=Math.round(E*3/px*1000)/1000,move=(rnd()-.42)*.004,exit=px*(1+(long?move:-move)),pnl=Math.round((long?exit-px:px-exit)*qty*100)/100;dayPnl+=pnl;
  db.run('INSERT INTO trades(oid,ts,symbol,side,qty,entry,exit,pnl) VALUES(?,?,?,?,?,?,?,?)',[`ex-${d}-${k}`,Date.UTC(2026,9,1+d,1+k*6),sym,long?'ロング決済':'ショート決済',qty,Math.round(px*100)/100,Math.round(exit*100)/100,pnl])}
  if(date=='2026-10-20')flow=50000;}
 E=Math.round((E+dayPnl+flow)*100)/100;db.run('INSERT INTO master(date,equity,flow,source) VALUES(?,?,?,?)',[date,E,flow,'例'])}
const add=(n,c,d,note)=>{db.run('INSERT INTO clients(token,name,capital,start_date,note) VALUES(?,?,?,?,?)',['ex'+crypto.randomBytes(14).toString('hex'),n,c,d,note]);return db.exec('SELECT max(id) FROM clients')[0].values[0][0]};
db.run("INSERT INTO evidence(file,created,ocr_value,confirmed,kind,public) VALUES('demo-assets.jpg','2026-11-03',NULL,1,'資産',1),('demo-trade.jpg','2026-11-03',NULL,1,'取引',1)");
add('【例】山田 様',1000,'2026-10-01','サンプル');const id=add('【例】佐藤 様',5000,'2026-10-01','サンプル（10/25に追加入金2,000）');db.run("INSERT INTO deposits(client_id,date,amount) VALUES(?,?,?)",[id,'2026-10-25',2000]);add('【例】高橋 様',20000,'2026-10-20','サンプル（途中開始）')}
