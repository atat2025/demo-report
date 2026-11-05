#!/usr/bin/env node
/**
 * Read-only monitor: compare live admin 持分残高 against a saved snapshot.
 * Usage:
 *   node check_decouple.js --save              # write snapshot from live admin CSV
 *   node check_decouple.js                     # compare; exit 1 on diffs
 *   node check_decouple.js --snapshot PATH     # use alternate snapshot
 * Env: BASE_URL (default https://live-report-sg.onrender.com), ADMIN_PASSWORD
 * Snapshot default: /workspace/demo-report/freeze_snapshot_monitor.json
 */
const fs=require('fs');
const path=require('path');
const BASE=(process.env.BASE_URL||process.env.PUBLIC_URL||'https://live-report-sg.onrender.com').replace(/\/$/,'');
const ADMIN=String(process.env.ADMIN_PASSWORD||'').trim().replace(/^["']+|["']+$/g,'');
const snapPath=(()=>{const i=process.argv.indexOf('--snapshot');return i>=0&&process.argv[i+1]?process.argv[i+1]:path.join(__dirname,'freeze_snapshot_monitor.json')})();
const doSave=process.argv.includes('--save');

async function login(){
  if(!ADMIN)throw new Error('ADMIN_PASSWORD required');
  const r=await fetch(BASE+'/admin/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'pw='+encodeURIComponent(ADMIN)});
  const set=r.headers.getSetCookie?r.headers.getSetCookie():[];
  const raw=set.length?set:[(r.headers.get('set-cookie')||'')];
  const cookie=raw.map(c=>String(c).split(';')[0]).filter(Boolean).join('; ');
  if(!/dadm=/.test(cookie))throw new Error('admin login failed status='+r.status);
  return cookie;
}

function parseCsv(text){
  const lines=text.replace(/^\ufeff/,'').trim().split(/\r?\n/);
  const out=[];
  for(let i=1;i<lines.length;i++){
    const line=lines[i];
    if(!line)continue;
    // name may be quoted
    let name,rest;
    if(line[0]==='"'){const m=line.match(/^"(.*)",(.*)$/);if(!m)continue;name=m[1].replace(/""/g,'"');rest=m[2]}
    else{const m=line.match(/^([^,]+),(.*)$/);if(!m)continue;name=m[1];rest=m[2]}
    const cols=rest.split(',');
    // 軍資金(円),開始日,投入資金(円),現在残高(円),...
    const balRaw=(cols[3]||'').trim();
    const bal=balRaw===''?null:Number(balRaw);
    out.push({name,yen:bal,start:cols[1],inv:Number(cols[2]),blank:balRaw===''});
  }
  return out;
}

async function fetchLive(cookie){
  const r=await fetch(BASE+'/admin/export.csv',{headers:{Cookie:cookie}});
  if(!r.ok)throw new Error('export.csv HTTP '+r.status);
  return parseCsv(await r.text());
}

(async()=>{
  const cookie=await login();
  const live=await fetchLive(cookie);
  if(doSave){
    const payload={savedAt:new Date().toISOString(),base:BASE,rows:live.map(r=>({name:r.name,yen:r.blank?null:r.yen,blank:!!r.blank}))};
    fs.writeFileSync(snapPath,JSON.stringify(payload,null,2));
    console.log('saved',snapPath,'clients',live.length);
    process.exit(0);
  }
  if(!fs.existsSync(snapPath)){
    console.error('snapshot missing:',snapPath,'(run with --save first)');
    process.exit(2);
  }
  const snap=JSON.parse(fs.readFileSync(snapPath,'utf8'));
  const map=Object.fromEntries((snap.rows||[]).map(r=>[r.name,{yen:r.yen,blank:r.blank||r.yen==null||r.yen===''}]));
  const diffs=[];
  for(const r of live){
    if(!(r.name in map)){diffs.push({name:r.name,expected:'(missing in snapshot)',actual:r.yen});continue}
    const exp=map[r.name];
    const expBlank=!!exp.blank;
    const actBlank=!!r.blank;
    if(expBlank||actBlank){
      if(expBlank!==actBlank)diffs.push({name:r.name,expected:expBlank?'(blank)':exp.yen,actual:actBlank?'(blank)':r.yen});
      continue;
    }
    if(Number(exp.yen)!==Number(r.yen))diffs.push({name:r.name,expected:exp.yen,actual:r.yen,delta:r.yen-exp.yen});
  }
  for(const n of Object.keys(map)){
    if(!live.find(r=>r.name===n))diffs.push({name:n,expected:map[n],actual:'(missing live)'});
  }
  if(diffs.length){
    console.error('DECOUPLE_FAIL',JSON.stringify({at:new Date().toISOString(),diffs},null,2));
    process.exit(1);
  }
  console.log('DECOUPLE_OK',live.length,'clients match',snapPath);
  process.exit(0);
})().catch(e=>{console.error('ERR',e&&e.message||e);process.exit(2)});
