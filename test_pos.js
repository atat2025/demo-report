#!/usr/bin/env node
/**
 * ポジション（ロング / ショート / 両方）の保存と、既存レコードを書き換えないことの確認。
 * 一時ディレクトリのDBだけで動かす。本番の data や seed は触らない。
 */
const {spawn}=require('child_process');
const fs=require('fs');
const os=require('os');
const path=require('path');
const initSql=require('sql.js');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-both-'));
const dbf=path.join(dir,'app.db');
const port=18765;
const pw='test-pos-pw';
const base='http://127.0.0.1:'+port;
const ACTS=JSON.stringify([{t:'見出しA',b:'本文A'}]);
const yen=150;

function sleep(ms){let t;const p=new Promise(r=>{t=setTimeout(r,ms)});p.cancel=()=>clearTimeout(t);return p}
function rowKey(r){return r.name}

async function openDb(){
  const SQL=await initSql();
  return new SQL.Database(fs.readFileSync(dbf));
}
function writeDb(db){
  fs.writeFileSync(dbf,Buffer.from(db.export()));
  db.close();
}
async function tables(){
  const db=await openDb();
  const dump=sql=>{
    const st=db.prepare(sql);const rows=[];
    while(st.step())rows.push(st.getAsObject());
    st.free();
    return rows;
  };
  const out={
    clients:dump('SELECT * FROM clients ORDER BY id'),
    balances:dump('SELECT * FROM balances ORDER BY id'),
    deposits:dump('SELECT * FROM deposits ORDER BY id')
  };
  db.close();
  return out;
}
function diffRows(before,after,label){
  const bad=[];
  const bmap=Object.fromEntries(before.map(r=>[rowKey(r),r]));
  const amap=Object.fromEntries(after.map(r=>[rowKey(r),r]));
  for(const name of Object.keys(bmap)){
    const x=bmap[name],y=amap[name];
    if(!y){bad.push(label+' missing '+name);continue}
    for(const k of new Set([...Object.keys(x),...Object.keys(y)])){
      if(JSON.stringify(x[k])!==JSON.stringify(y[k]))bad.push(`${label} ${name}.${k}: ${JSON.stringify(x[k])} -> ${JSON.stringify(y[k])}`);
    }
  }
  for(const name of Object.keys(amap))if(!bmap[name])bad.push(label+' extra '+name);
  return bad;
}

let child;
function start(){
  const env={...process.env,DATA_DIR:dir,PORT:String(port),ADMIN_PASSWORD:pw,NODE_ENV:'development'};
  delete env.RENDER;delete env.RENDER_EXTERNAL_URL;delete env.SEED_SAMPLE;delete env.VERCEL;
  child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname),env,stdio:['ignore','pipe','pipe']});
  let log='';
  child.stdout.on('data',d=>{log+=d});
  child.stderr.on('data',d=>{log+=d});
  child._log=()=>log.slice(-4000);
}
async function stop(){
  if(!child||child.exitCode!=null||child.signalCode!=null){child=null;return}
  const c=child;
  const exited=new Promise(r=>c.once('exit',r));
  const timer=sleep(3000);
  c.kill('SIGTERM');
  await Promise.race([exited,timer]);
  timer.cancel();
  if(c.exitCode==null&&c.signalCode==null){c.kill('SIGKILL');await exited}
  child=null;
}
async function waitUp(){
  for(let i=0;i<60;i++){
    try{const r=await fetch(base+'/admin/login');if(r.status===200)return}catch{}
    if(child.exitCode!=null)throw new Error('server exited\n'+child._log());
    await sleep(200);
  }
  throw new Error('server did not start\n'+child._log());
}
async function login(){
  const r=await fetch(base+'/admin/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:'pw='+encodeURIComponent(pw)});
  const cookie=(r.headers.get('set-cookie')||'').split(';')[0];
  if(!/dadm=/.test(cookie))throw new Error('login failed '+r.status);
  return cookie;
}
function decode(s){return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>')}
function formBody(html,id,posValues){
  const m=html.match(new RegExp(`<form method="post" action="/admin/c/${id}/terms"[\\s\\S]*?</form>`));
  if(!m)throw new Error('terms form missing for '+id);
  const params=new URLSearchParams();
  for(const im of m[0].matchAll(/<input\b([^>]*)>/g)){
    const tag=im[1];
    const name=(tag.match(/\bname="([^"]*)"/)||[])[1];
    if(!name||name==='pos')continue;
    if(/\bdisabled\b/.test(tag))continue;
    const value=(tag.match(/\bvalue="([^"]*)"/)||[])[1]||'';
    params.append(name,decode(value));
  }
  for(const tm of m[0].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)){
    const name=(tm[1].match(/\bname="([^"]*)"/)||[])[1];
    if(!name)continue;
    params.append(name,decode(tm[2]));
  }
  for(const p of posValues)params.append('pos',p);
  return params;
}
function boxChecked(html,value){
  const m=html.match(new RegExp(`<input type="checkbox" name="pos" value="${value}"([^>]*)>`));
  if(!m)throw new Error('checkbox missing '+value);
  return /\bchecked\b/.test(m[1]);
}
function lgOf(html){
  const m=html.match(/<div class="lg">([\s\S]*?)<\/div>/);
  if(!m)throw new Error('lg missing');
  return m[1];
}

function insertClients(db){
  db.run('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)',['usdt_jpy','150']);
  const ins=(o)=>{
    db.run(`INSERT INTO clients(token,name,capital,capital_yen,start_date,note,principal,principal_yen,add_principal,add_principal_yen,patron,patron_yen,temp_funds,maturity_date,fee_rate,target_lo,target_hi,pos,lev,acts_json,created,member_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
      o.token,o.name,o.capitalYen/yen,o.capitalYen,o.start,o.note,
      o.principalYen/yen,o.principalYen,o.addYen/yen,o.addYen,o.patronYen/yen,o.patronYen,
      null,o.maturity,20,2,4,o.pos,10,ACTS,'2026-11-01',o.mid
    ]);
  };
  ins({token:'tok-long-existing',name:'既存ロング',capitalYen:1280000,principalYen:500000,addYen:300000,patronYen:10000,start:'2026-01-15',maturity:'2027-01-15',note:'ロングだけのメモ',pos:'ロング',mid:'memlong1'});
  ins({token:'tok-short-existing',name:'既存ショート',capitalYen:800000,principalYen:400000,addYen:50000,patronYen:20000,start:'2026-02-02',maturity:'2027-02-02',note:'ショートだけのメモ',pos:'ショート',mid:'memshort1'});
  ins({token:'tok-unset-existing',name:'未設定',capitalYen:600000,principalYen:600000,addYen:0,patronYen:0,start:'2026-03-03',maturity:'2027-03-03',note:'ポジション未保存',pos:null,mid:'memunset1'});
  ins({token:'tok-roundtrip',name:'保存確認',capitalYen:900000,principalYen:450000,addYen:10000,patronYen:5000,start:'2026-04-04',maturity:'2027-04-04',note:'往復確認',pos:'ロング',mid:'memround1'});
  const ids={};
  const st=db.prepare('SELECT id,name,token FROM clients');
  while(st.step()){const r=st.getAsObject();ids[r.name]=r}
  st.free();
  for(const name of Object.keys(ids)){
    const id=ids[name].id;
    const amountYen=name==='既存ロング'?1979756:name==='既存ショート'?1500000:1111111;
    db.run('INSERT INTO balances(client_id,date,amount,amount_yen,evidence_file,created,source) VALUES(?,?,?,?,?,?,?)',[id,'2026-11-01',amountYen/yen,amountYen,null,'2026-11-01','admin']);
    db.run('INSERT INTO deposits(client_id,date,amount) VALUES(?,?,?)',[id,'2026-05-01',name==='既存ロング'?250:100]);
  }
  return ids;
}

(async()=>{
  const fails=[];
  const fail=m=>{fails.push(m);console.error('FAIL',m)};
  try{
    start();
    await waitUp();
    await stop();

    const SQL=await initSql();
    const db0=new SQL.Database(fs.readFileSync(dbf));
    const ids=insertClients(db0);
    writeDb(db0);
    const snap=await tables();
    const byName=Object.fromEntries(snap.clients.map(c=>[c.name,c]));
    if(byName['既存ロング'].pos!=='ロング')fail('seed long');
    if(byName['既存ショート'].pos!=='ショート')fail('seed short');
    if(byName['未設定'].pos!==null)fail('seed unset');

    start();
    await waitUp();
    const afterBoot=await tables();
    for(const m of diffRows(snap.clients,afterBoot.clients,'boot-client'))fail(m);
    for(const m of diffRows(snap.balances,afterBoot.balances,'boot-bal'))fail(m);
    for(const m of diffRows(snap.deposits,afterBoot.deposits,'boot-dep'))fail(m);

    const cookie=await login();
    const get=async p=>{
      const r=await fetch(base+p,{headers:{cookie}});
      if(!r.ok)throw new Error(p+' '+r.status);
      return r.text();
    };
    const longHtml=await get('/admin/c/'+ids['既存ロング'].id);
    const shortHtml=await get('/admin/c/'+ids['既存ショート'].id);
    const unsetHtml=await get('/admin/c/'+ids['未設定'].id);
    if(!(boxChecked(longHtml,'ロング')&&!boxChecked(longHtml,'ショート')))fail('form long checks');
    if(!(!boxChecked(shortHtml,'ロング')&&boxChecked(shortHtml,'ショート')))fail('form short checks');
    if(!(boxChecked(unsetHtml,'ロング')&&!boxChecked(unsetHtml,'ショート')))fail('form unset falls back to long without writing');
    if(/<select name="pos"/.test(longHtml))fail('pos is still a single select');

    const post=async(name,posValues)=>{
      const html=await get('/admin/c/'+ids[name].id);
      const body=formBody(html,ids[name].id,posValues);
      const r=await fetch(base+'/admin/c/'+ids[name].id+'/terms',{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:body.toString()});
      if(r.status!==302)fail('save status '+name+' '+r.status);
    };
    const posOf=async name=>(await tables()).clients.find(c=>c.name===name).pos;
    const othersSame=(beforeRow,afterRow,allowPos)=>{
      for(const k of new Set([...Object.keys(beforeRow),...Object.keys(afterRow)])){
        if(allowPos&&k==='pos')continue;
        if(JSON.stringify(beforeRow[k])!==JSON.stringify(afterRow[k]))fail(`${beforeRow.name}.${k}: ${JSON.stringify(beforeRow[k])} -> ${JSON.stringify(afterRow[k])}`);
      }
    };

    await post('保存確認',[]);
    if(await posOf('保存確認')!=='ロング')fail('missing checkbox must keep ロング, got '+await posOf('保存確認'));
    await post('保存確認',['ショート']);
    if(await posOf('保存確認')!=='ショート')fail('save short exact, got '+JSON.stringify(await posOf('保存確認')));
    await post('保存確認',['ロング','ショート']);
    if(await posOf('保存確認')!=='ロング・ショート')fail('save both exact, got '+JSON.stringify(await posOf('保存確認')));
    let roundHtml=await get('/admin/c/'+ids['保存確認'].id);
    if(!(boxChecked(roundHtml,'ロング')&&boxChecked(roundHtml,'ショート')))fail('reload both checks');
    await post('保存確認',['ロング']);
    if(await posOf('保存確認')!=='ロング')fail('back to long exact, got '+JSON.stringify(await posOf('保存確認')));
    roundHtml=await get('/admin/c/'+ids['保存確認'].id);
    if(!(boxChecked(roundHtml,'ロング')&&!boxChecked(roundHtml,'ショート')))fail('reload long only');

    const mid=await tables();
    othersSame(byName['保存確認'],mid.clients.find(c=>c.name==='保存確認'),false);
    othersSame(byName['既存ロング'],mid.clients.find(c=>c.name==='既存ロング'),false);
    othersSame(byName['既存ショート'],mid.clients.find(c=>c.name==='既存ショート'),false);
    othersSame(byName['未設定'],mid.clients.find(c=>c.name==='未設定'),false);
    for(const m of diffRows(snap.balances,mid.balances,'mid-bal'))fail(m);
    for(const m of diffRows(snap.deposits,mid.deposits,'mid-dep'))fail(m);

    await post('既存ショート',['ロング','ショート']);
    const afterBoth=await tables();
    const shortRow=afterBoth.clients.find(c=>c.name==='既存ショート');
    if(shortRow.pos!=='ロング・ショート')fail('existing short -> both, got '+JSON.stringify(shortRow.pos));
    othersSame(byName['既存ショート'],shortRow,true);
    othersSame(byName['既存ロング'],afterBoth.clients.find(c=>c.name==='既存ロング'),false);
    othersSame(byName['未設定'],afterBoth.clients.find(c=>c.name==='未設定'),false);
    for(const m of diffRows(snap.balances,afterBoth.balances,'both-bal'))fail(m);
    for(const m of diffRows(snap.deposits,afterBoth.deposits,'both-dep'))fail(m);

    const bothForm=await get('/admin/c/'+ids['既存ショート'].id);
    if(!(boxChecked(bothForm,'ロング')&&boxChecked(bothForm,'ショート')))fail('existing short form did not persist both');

    for(const q of ['','?type=a','?type=b']){
      const rep=await (await fetch(base+'/r/tok-short-existing/report'+q)).text();
      const lg=lgOf(rep);
      if(!lg.includes('▲ ロング')||!lg.includes('▼ ショート'))fail('report both '+q+' :: '+lg);
      if(lg.includes('ロング・ショート'))fail('report leaked stored code '+q);
    }
    for(const q of ['','?type=a']){
      const rep=await (await fetch(base+'/r/tok-long-existing/report'+q)).text();
      const lg=lgOf(rep);
      if(!lg.includes('▲ ロング')||lg.includes('▼ ショート'))fail('report long only '+q+' :: '+lg);
      const repS=await (await fetch(base+'/r/tok-unset-existing/report'+q)).text();
      const lgU=lgOf(repS);
      if(!lgU.includes('▲ ロング')||lgU.includes('▼ ショート'))fail('report unset fallback '+q+' :: '+lgU);
    }

    const art=process.env.ARTIFACT_DIR||'/tmp/pos-artifacts';
    fs.mkdirSync(art,{recursive:true});
    try{
      const puppeteer=require('puppeteer-core');
      const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
      const page=await browser.newPage();
      await page.setViewport({width:1280,height:900});
      await page.goto(base+'/admin/login',{waitUntil:'networkidle0'});
      await page.type('input[name=pw]',pw);
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('button')]);
      await page.goto(base+'/admin/c/'+ids['保存確認'].id,{waitUntil:'networkidle0'});
      const beforeClick=await page.$$eval('.pospick input',els=>els.map(e=>({v:e.value,on:e.checked})));
      if(!beforeClick.find(s=>s.v==='ロング'&&s.on)||beforeClick.find(s=>s.v==='ショート'&&s.on))fail('browser roundtrip start '+JSON.stringify(beforeClick));
      await page.click('.pospick label:nth-of-type(2)');
      await Promise.all([
        page.waitForNavigation({waitUntil:'networkidle0'}),
        page.$eval('form[action$="/terms"] button',b=>b.click())
      ]);
      const afterClick=await page.$$eval('.pospick input',els=>els.map(e=>({v:e.value,on:e.checked})));
      if(!afterClick.find(s=>s.v==='ロング'&&s.on)||!afterClick.find(s=>s.v==='ショート'&&s.on))fail('browser save both '+JSON.stringify(afterClick));
      const clicked=await tables();
      const round=clicked.clients.find(c=>c.name==='保存確認');
      if(round.pos!=='ロング・ショート')fail('browser stored '+JSON.stringify(round.pos));
      othersSame(byName['保存確認'],round,true);
      await page.goto(base+'/admin/c/'+ids['既存ショート'].id,{waitUntil:'networkidle0'});
      const posEl=await page.$('.posfield');
      if(!posEl)throw new Error('posfield not on page');
      await posEl.screenshot({path:path.join(art,'admin-position-both.png')});
      const state=await page.$$eval('.pospick input',els=>els.map(e=>({v:e.value,on:e.checked})));
      if(!state.find(s=>s.v==='ロング'&&s.on)||!state.find(s=>s.v==='ショート'&&s.on))fail('browser both not checked '+JSON.stringify(state));
      await page.goto(base+'/r/tok-short-existing/report',{waitUntil:'networkidle0'});
      const lgEl=await page.$('.lg');
      await lgEl.screenshot({path:path.join(art,'report-position-both.png')});
      const lgText=await page.$eval('.lg',el=>el.innerText);
      if(!lgText.includes('ロング')||!lgText.includes('ショート'))fail('browser report text '+lgText);
      await page.setViewport({width:390,height:844});
      await page.goto(base+'/r/tok-short-existing/report',{waitUntil:'networkidle0'});
      await (await page.$('.lg')).screenshot({path:path.join(art,'report-position-both-mobile.png')});
      const lgMobile=await page.$eval('.lg',el=>el.innerText.replace(/\s+/g,''));
      if(!lgMobile.includes('ロング')||!lgMobile.includes('ショート'))fail('browser mobile report '+lgMobile);
      await page.goto(base+'/admin/c/'+ids['既存ロング'].id,{waitUntil:'networkidle0'});
      const longEl=await page.$('.posfield');
      await longEl.screenshot({path:path.join(art,'admin-position-long-mobile.png')});
      const longState=await page.$$eval('.pospick input',els=>els.map(e=>({v:e.value,on:e.checked})));
      if(!longState.find(s=>s.v==='ロング'&&s.on)||longState.find(s=>s.v==='ショート'&&s.on))fail('browser long mobile '+JSON.stringify(longState));
      await page.goto(base+'/r/tok-long-existing/report',{waitUntil:'networkidle0'});
      await (await page.$('.lg')).screenshot({path:path.join(art,'report-position-long.png')});
      const longLg=await page.$eval('.lg',el=>el.innerText);
      if(!longLg.includes('ロング')||longLg.includes('ショート'))fail('browser long report '+longLg);
      await browser.close();
      console.log('browser ok',art);
    }catch(e){
      fail('browser '+ (e&&e.stack||e));
    }

    await stop();
    start();
    await waitUp();
    const afterRestart=await tables();
    othersSame(byName['既存ロング'],afterRestart.clients.find(c=>c.name==='既存ロング'),false);
    othersSame(byName['未設定'],afterRestart.clients.find(c=>c.name==='未設定'),false);
    othersSame(shortRow,afterRestart.clients.find(c=>c.name==='既存ショート'),false);
    for(const m of diffRows(snap.balances,afterRestart.balances,'restart-bal'))fail(m);
    for(const m of diffRows(snap.deposits,afterRestart.deposits,'restart-dep'))fail(m);
    const again=await (await fetch(base+'/admin/c/'+ids['既存ショート'].id,{headers:{cookie:await login()}})).text();
    if(!(boxChecked(again,'ロング')&&boxChecked(again,'ショート')))fail('both lost after restart');
  }catch(e){
    fail(e&&e.stack||String(e));
  }finally{
    await stop();
  }
  if(fails.length){
    console.error('\n'+fails.length+' failure(s)');
    process.exit(1);
  }
  console.log('ok',dir);
})();
