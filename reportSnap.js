/**
 * 報告済みスナップショット: 運用進捗レポートを PNG/PDF で永続保存（append-only）
 * 主保存: DATA_DIR/reports/  二重化: DATA_DIR/report-backups/ + 任意で GitHub Contents API
 */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const https=require('https');

function ensureDirs(dataDir){
  for(const d of [path.join(dataDir,'reports'), path.join(dataDir,'report-backups')]){
    fs.mkdirSync(d,{recursive:true});
  }
}

function stampJst(ms=Date.now()){
  const d=new Date(ms+9*36e5);
  const p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function launchBrowser(){
  const puppeteer=require('puppeteer-core');
  let executablePath=process.env.PUPPETEER_EXECUTABLE_PATH||process.env.CHROME_PATH||'';
  let args=['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--font-render-hinting=none'];
  try{
    const chromium=require('@sparticuz/chromium');
    executablePath=await chromium.executablePath();
    args=chromium.args.concat(['--font-render-hinting=none']);
  }catch(e){
    if(!executablePath){
      for(const c of ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser']){
        if(fs.existsSync(c)){executablePath=c;break}
      }
    }
  }
  if(!executablePath||!fs.existsSync(executablePath))throw new Error('Chromium が見つかりません（報告画像の生成に必要です）');
  return puppeteer.launch({executablePath,headless:true,args});
}

async function captureReport({html,url,outPng,outPdf}){
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage();
    await page.setViewport({width:900,height:1400,deviceScaleFactor:2});
    if(html){
      await page.setContent(html,{waitUntil:'networkidle0',timeout:60000});
    }else{
      await page.goto(url,{waitUntil:'networkidle0',timeout:60000});
    }
    await new Promise(r=>setTimeout(r,800));
    await page.screenshot({path:outPng,fullPage:true,type:'png'});
    await page.pdf({path:outPdf,format:'A4',printBackground:true,margin:{top:'12mm',bottom:'12mm',left:'10mm',right:'10mm'}});
  }finally{
    try{await browser.close()}catch{}
  }
}

function mirrorFile(src, backupRoot, rel){
  const dest=path.join(backupRoot,rel);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.copyFileSync(src,dest);
  return dest;
}

function githubPut({token,owner,repo,branch,filePath,contentBuf,message}){
  return new Promise((resolve,reject)=>{
    const apiPath=`/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    const body=JSON.stringify({
      message,
      content:contentBuf.toString('base64'),
      branch
    });
    const req=https.request({
      hostname:'api.github.com',
      path:apiPath,
      method:'PUT',
      headers:{
        'Authorization':'Bearer '+token,
        'User-Agent':'live-report-sg-backup',
        'Accept':'application/vnd.github+json',
        'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body)
      }
    },res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300)resolve(JSON.parse(data||'{}'));
        else reject(new Error('GitHub '+res.statusCode+': '+data.slice(0,300)));
      });
    });
    req.on('error',reject);
    req.write(body);
    req.end();
  });
}

async function backupToGithub({token,owner,repo,branch,localFiles,message}){
  const results=[];
  for(const f of localFiles){
    const buf=fs.readFileSync(f.abs);
    const r=await githubPut({token,owner,repo,branch,filePath:f.repoPath,contentBuf:buf,message:message+' '+f.repoPath});
    results.push({path:f.repoPath,sha:r.content&&r.content.sha});
  }
  return results;
}

function diskUsage(dataDir){
  const out={dataDir,exists:fs.existsSync(dataDir),bytes:0,files:0};
  function walk(d){
    let ents;try{ents=fs.readdirSync(d,{withFileTypes:true})}catch{return}
    for(const e of ents){
      const p=path.join(d,e.name);
      try{
        if(e.isDirectory())walk(p);
        else{const st=fs.statSync(p);out.bytes+=st.size;out.files++}
      }catch{}
    }
  }
  if(out.exists)walk(dataDir);
  out.mb=Math.round(out.bytes/1024/1024*10)/10;
  out.gb=Math.round(out.bytes/1024/1024/1024*1000)/1000;
  return out;
}

/**
 * Create one report snapshot for a client.
 * deps: { DATA_DIR, renderHtml(c), client, baseUrl, run, save, one }
 */
async function createSnapshot(deps){
  const {DATA_DIR,renderHtml,client,baseUrl,run,save}=deps;
  ensureDirs(DATA_DIR);
  const ts=stampJst();
  const id=crypto.randomBytes(6).toString('hex');
  const rel=`${client.id}/${ts}_${id}`;
  const dir=path.join(DATA_DIR,'reports',rel);
  fs.mkdirSync(dir,{recursive:true});
  const html=renderHtml(client);
  const htmlPath=path.join(dir,'report.html');
  fs.writeFileSync(htmlPath,html,'utf8');
  const pngPath=path.join(dir,'report.png');
  const pdfPath=path.join(dir,'report.pdf');
  let pngOk=false,pdfOk=false,err=null;
  try{
    await captureReport({html,outPng:pngPath,outPdf:pdfPath});
    pngOk=fs.existsSync(pngPath)&&fs.statSync(pngPath).size>1000;
    pdfOk=fs.existsSync(pdfPath)&&fs.statSync(pdfPath).size>1000;
  }catch(e){
    err=String(e&&e.message||e);
    console.error('reportSnap capture',err);
  }
  const meta={
    id,client_id:client.id,client_name:client.name,token:client.token,
    created_at:new Date().toISOString(),created_jst:ts.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/,'$1-$2-$3 $4:$5:$6'),
    rel,png:pngOk?'report.png':null,pdf:pdfOk?'report.pdf':null,html:'report.html',
    capture_error:err,url:`${baseUrl}/r/${client.token}/report`
  };
  fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta,null,2));
  // local mirror (second copy on disk)
  const bakRoot=path.join(DATA_DIR,'report-backups');
  mirrorFile(htmlPath,bakRoot,rel+'/report.html');
  if(pngOk)mirrorFile(pngPath,bakRoot,rel+'/report.png');
  if(pdfOk)mirrorFile(pdfPath,bakRoot,rel+'/report.pdf');
  mirrorFile(path.join(dir,'meta.json'),bakRoot,rel+'/meta.json');
  // DB index (append-only)
  run('INSERT INTO report_snaps(client_id,created,rel,png,pdf,html,meta_json) VALUES(?,?,?,?,?,?,?)',[
    client.id,meta.created_jst,rel,meta.png,meta.pdf,meta.html,JSON.stringify(meta)
  ]);
  if(typeof save==='function')save();
  // optional GitHub remote backup
  const token=process.env.REPORT_BACKUP_TOKEN||process.env.GITHUB_TOKEN||'';
  if(token){
    try{
      const owner=process.env.REPORT_BACKUP_OWNER||'atat2025';
      const repo=process.env.REPORT_BACKUP_REPO||'demo-report';
      const branch=process.env.REPORT_BACKUP_BRANCH||'report-archives';
      const files=[{abs:htmlPath,repoPath:`archives/${rel}/report.html`}];
      if(pngOk)files.push({abs:pngPath,repoPath:`archives/${rel}/report.png`});
      if(pdfOk)files.push({abs:pdfPath,repoPath:`archives/${rel}/report.pdf`});
      files.push({abs:path.join(dir,'meta.json'),repoPath:`archives/${rel}/meta.json`});
      meta.github=await backupToGithub({token,owner,repo,branch,localFiles:files,message:`report snap ${client.name} ${ts}`});
      fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta,null,2));
      console.log('reportSnap github backup ok',rel);
    }catch(e){
      console.error('reportSnap github backup',e&&e.message||e);
      meta.github_error=String(e&&e.message||e);
      fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta,null,2));
    }
  }else{
    meta.github_skipped='REPORT_BACKUP_TOKEN / GITHUB_TOKEN unset';
  }
  return meta;
}

function listSnaps(all,clientId){
  return all('SELECT * FROM report_snaps WHERE client_id=? ORDER BY id DESC',[clientId]);
}

module.exports={createSnapshot,listSnaps,diskUsage,ensureDirs,stampJst};
