/* The content panel, served by the site itself at /site-admin.
 *
 * Deliberately NOT added to pzadmin.html. The game panel is a file the game
 * depends on; putting the website's editor inside it would mean every copy
 * change risked a file players' admin flow needs. This is a separate page in a
 * separate process — it cannot break anything the game uses.
 *
 * The admin key is typed once and kept in sessionStorage, so it is gone when
 * the tab closes and never appears in a URL or a bookmark.
 *
 * It edits pages as BLOCKS, not HTML. Someone writing marketing copy should not
 * be able to break a layout or paste a script, and should not have to know
 * what a <div> is.
 */
export function adminHtml(): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>محتوا و سئو | پرایز کوئیز</title>
<style>
:root{--bg:#0d0f14;--panel:#161a22;--panel2:#1d2230;--line:#2a3040;--ink:#e7ecf3;--muted:#8b94a7;
  --gold:#ffd21f;--ok:#33d97c;--bad:#ff5a48;--accent:#7b8bff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Tahoma,'Segoe UI',system-ui,sans-serif;font-size:14px}
input,select,textarea{font-family:inherit;background:#0c0f16;border:1.5px solid var(--line);border-radius:9px;
  color:var(--ink);padding:9px 11px;font-size:13px;width:100%}
textarea{min-height:96px;line-height:1.9;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
label{display:block;font-size:12px;color:var(--muted);font-weight:700;margin:0 0 5px}
.f{margin-bottom:12px}
.btn{border:1.5px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--ink);
  padding:9px 14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit}
.btn:hover{filter:brightness(1.15)}
.btn.pri{background:linear-gradient(180deg,#ffe24a,#f5b90d);color:#1a1400;border-color:#000}
.btn.ok{background:var(--ok);color:#062611;border-color:#000}
.btn.bad{background:var(--bad);color:#2a0500;border-color:#000}
.btn.sm{padding:6px 10px;font-size:11.5px}
header{background:var(--panel);border-bottom:1.5px solid var(--line);padding:13px 18px;
  display:flex;gap:12px;align-items:center;position:sticky;top:0;z-index:5}
header b{font-size:16px}
main{max-width:1000px;margin:0 auto;padding:18px}
.tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
.tabs button{border:1.5px solid var(--line);background:var(--panel);color:var(--muted);border-radius:10px;
  padding:9px 15px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}
.tabs button.on{background:linear-gradient(180deg,#ffe24a,#f5b90d);color:#1a1400;border-color:#000}
.card{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:16px;margin-bottom:13px}
.card h3{margin:0 0 4px;font-size:15px}
.sub{color:var(--muted);font-size:12px;margin:0 0 12px;line-height:1.8}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.note{background:#1a2230;border:1.5px solid var(--line);border-inline-start:4px solid var(--accent);
  border-radius:10px;padding:11px 13px;color:var(--muted);font-size:12.5px;line-height:1.9;margin-bottom:13px}
.item{border:1.5px solid var(--line);border-radius:11px;padding:12px;margin-bottom:9px;background:var(--panel2)}
.item .row{justify-content:space-between}
.blk{border:1.5px dashed var(--line);border-radius:11px;padding:12px;margin-bottom:10px}
.blk .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
.blk .hd b{font-size:13px;color:var(--gold)}
.pill{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;background:var(--panel2);
  border:1.5px solid var(--line);color:var(--muted)}
.pill.on{background:rgba(51,217,124,.16);color:var(--ok);border-color:rgba(51,217,124,.4)}
.pill.off{background:rgba(255,90,72,.14);color:var(--bad);border-color:rgba(255,90,72,.4)}
#toast{position:fixed;inset-inline-start:50%;transform:translateX(-50%);bottom:22px;z-index:50;
  background:var(--panel2);border:1.5px solid var(--line);border-radius:11px;padding:11px 18px;
  font-weight:800;font-size:13px;display:none}
#gate{min-height:100vh;display:grid;place-items:center;padding:20px}
#gate .card{max-width:400px;width:100%}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;direction:ltr;text-align:left}
</style></head><body>

<div id="gate">
  <div class="card">
    <h3>محتوا و سئوی سایت</h3>
    <p class="sub">کلید مدیریت سایت را وارد کن. این کلید <b>جدا از پنل بازی</b> است و روی سرور در <span class="mono">pz-site/site.env</span> نگه‌داری می‌شود. فقط تا بسته‌شدن همین تب در مرورگر می‌ماند.</p>
    <div class="f"><label>کلید مدیریت</label><input id="key" type="password" class="mono" autocomplete="off"></div>
    <button class="btn pri" style="width:100%" onclick="enter()">ورود</button>
    <p class="sub" id="gateErr" style="color:var(--bad);margin-top:10px"></p>
  </div>
</div>

<div id="app" style="display:none">
<header>
  <b>محتوا و سئو</b>
  <span class="sub" style="margin:0">سایت معرفی — جدا از بازی</span>
  <span style="flex:1"></span>
  <a class="btn sm" id="viewSite" href="/home" target="_blank" rel="noopener">دیدن سایت</a>
  <button class="btn sm" onclick="loadAll()">↻ تازه‌سازی</button>
</header>
<main>
  <div class="tabs">
    <button id="t-pages" class="on" onclick="tab('pages')">صفحه‌ها</button>
    <button id="t-posts" onclick="tab('posts')">وبلاگ</button>
    <button id="t-media" onclick="tab('media')">تصویرها</button>
    <button id="t-seo" onclick="tab('seo')">تنظیمات سئو</button>
  </div>
  <div id="body"></div>
</main>
</div>
<div id="toast"></div>

<script>
let KEY='', DATA={pages:[],posts:[],settings:{}}, MEDIA=[], TAB='pages';
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m,bad){const t=$('#toast');t.textContent=m;t.style.borderColor=bad?'var(--bad)':'var(--line)';
  t.style.display='block';clearTimeout(window._tt);window._tt=setTimeout(()=>t.style.display='none',2600);}

async function api(method,path,body){
  let r;
  try{
    r=await fetch('/site-api/'+path,{method:method,
      headers:{'content-type':'application/json','x-admin-key':KEY},
      body:body?JSON.stringify(body):undefined});
  }catch(e){ const err=new Error('به سرور سایت نرسیدیم'); err.status=0; throw err; }
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.ok===false){
    const err=new Error((j.error&&j.error.message)||('خطا '+r.status));
    err.status=r.status;            // the caller needs to tell 403 from 404
    throw err;
  }
  return j.data;
}
async function enter(){
  KEY=$('#key').value.trim();
  if(!KEY){ $('#gateErr').textContent='کلید را وارد کن.'; return; }
  try{
    await loadAll();
    try{ sessionStorage.setItem('site_admin_key',KEY); }catch(e){}
    $('#gate').style.display='none'; $('#app').style.display='';
  }catch(e){
    /* Saying "wrong key" for every failure sends people to hunt the wrong
     * problem: a 404 means nginx is not routing /site-api to this service, a
     * 502 means the service is down, and neither has anything to do with the
     * key they just typed. */
    const s=e&&e.status;
    $('#gateErr').textContent =
      s===403 ? 'کلید پذیرفته نشد.' :
      s===404 ? 'مسیر /site-api پیدا نشد — nginx درخواست را به سایت نمی‌فرستد.' :
      s===0   ? 'به سرور سایت نرسیدیم — سرویس بالا نیست یا شبکه قطع است.' :
      s       ? ('خطای سرور ('+s+') — کلید مشکلی ندارد.') :
                ('خطا: '+(e&&e.message||'نامشخص'));
  }
}
/* The site's home is NOT '/': the game owns the root, so home lives wherever
 * homePath says (default /home). The renderer already knew this; the panel did
 * not, so «دیدن سایت» and the home row's «مشاهده» both opened the game. */
function siteHome(){ return (DATA&&DATA.settings&&DATA.settings.homePath)||'/home'; }
function pageHref(slug){ return slug==='home' ? siteHome() : '/'+slug; }

async function loadAll(){
  DATA=await api('GET','all');
  try{ MEDIA=(await api('GET','media')).media||[]; }catch(e){ MEDIA=[]; }
  render();
}
function tab(t){ TAB=t; ['pages','posts','media','seo'].forEach((x)=>$('#t-'+x).className=(x===t?'on':'')); render(); }

/* ---------- media ---------- */
/* Upload happens in the browser: the file is read to a data: URI and posted as
 * JSON, so there is no multipart parser anywhere in this service. The server
 * still checks the bytes — nothing here is trusted. */
function bytesLabel(n){ return n>=1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }

function renderMedia(){
  $('#app').innerHTML=
    '<div class="note">تصویرهای سایت اینجا نگه‌داری می‌شوند. بعد از آپلود، دکمهٔ «انتخاب» کنار هر فیلد تصویر همین‌ها را نشان می‌دهد — لازم نیست آدرس را دستی بنویسی.<br>'+
    'قالب‌های مجاز: PNG، JPG، GIF، WebP، ICO — تا ۳ مگابایت.</div>'+
    '<div class="card">'+
      '<h3>آپلود تصویر</h3>'+
      '<p class="sub">می‌توانی چند فایل را با هم انتخاب کنی.</p>'+
      '<input type="file" id="mfile" accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon" multiple>'+
      '<div class="row" style="margin-top:10px"><button class="btn pri" id="mUp">آپلود</button>'+
      '<span id="mprog" class="pill"></span></div>'+
    '</div>'+
    '<div class="card"><h3>کتابخانه <span class="pill">'+MEDIA.length+'</span></h3>'+
      (MEDIA.length? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:11px">'+
        MEDIA.map((m)=>
          '<div class="item" style="margin:0">'+
            '<img src="'+esc(m.url)+'" alt="" style="width:100%;height:110px;object-fit:contain;background:#0c0f16;border-radius:8px">'+
            '<div style="font-size:11.5px;color:var(--muted);margin:7px 0 5px;word-break:break-all">'+esc(m.filename)+' · '+bytesLabel(m.size)+'</div>'+
            '<div class="f"><input class="mAlt" data-id="'+esc(m.id)+'" value="'+esc(m.alt||'')+'" placeholder="توضیح تصویر (alt)"></div>'+
            '<div class="row">'+
              '<button class="btn sm mCopy" data-id="'+esc(m.id)+'">کپی نشانی</button>'+
              '<button class="btn sm bad mDel" data-id="'+esc(m.id)+'">حذف</button>'+
            '</div>'+
          '</div>').join('')+'</div>'
        : '<p class="sub">هنوز تصویری آپلود نشده.</p>')+
    '</div>';
  $('#mUp').onclick=uploadMedia;
  document.querySelectorAll('.mAlt').forEach((el)=>{ el.onchange=()=>setAlt(el.getAttribute('data-id'),el.value); });
  document.querySelectorAll('.mCopy').forEach((el)=>{ el.onclick=()=>copyUrl(el.getAttribute('data-id')); });
  document.querySelectorAll('.mDel').forEach((el)=>{ el.onclick=()=>delMedia(el.getAttribute('data-id')); });
}

function readAsDataUrl(f){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); }); }

async function uploadMedia(){
  const inp=$('#mfile'); const files=[...(inp.files||[])];
  if(!files.length){ toast('فایلی انتخاب نشده.',1); return; }
  let done=0, failed=0;
  for(const f of files){
    $('#mprog').textContent='در حال آپلود '+(done+failed+1)+' از '+files.length;
    try{
      const data=await readAsDataUrl(f);
      await api('POST','media',{data:data,filename:f.name,alt:''});
      done++;
    }catch(e){ failed++; toast(f.name+': '+e.message,1); }
  }
  $('#mprog').textContent='';
  toast(done+' تصویر آپلود شد'+(failed?('، '+failed+' ناموفق'):''),failed?1:0);
  await loadAll(); tab('media');
}

async function setAlt(id,alt){ try{ await api('PUT','media/'+encodeURIComponent(id),{alt:alt}); const m=MEDIA.find((x)=>x.id===id); if(m)m.alt=alt; toast('ذخیره شد'); }catch(e){ toast(e.message,1); } }
async function delMedia(id){
  if(!confirm('این تصویر حذف شود؟ هر جای سایت که از آن استفاده شده خالی می‌شود.')) return;
  try{ await api('DELETE','media/'+encodeURIComponent(id)); toast('حذف شد'); await loadAll(); tab('media'); }catch(e){ toast(e.message,1); }
}
function copyUrl(id){
  const m=MEDIA.find((x)=>x.id===id); if(!m) return;
  try{ navigator.clipboard.writeText(m.url); toast('نشانی کپی شد: '+m.url); }
  catch(e){ prompt('نشانی تصویر:',m.url); }
}

/* The picker every image field gets: no typing, no leaving the page. */
function pick(inputId){
  if(!MEDIA.length){ toast('اول از تب «تصویرها» آپلود کن.',1); return; }
  const box=document.createElement('div');
  box.style.cssText='position:fixed;inset:0;background:#000a;z-index:50;display:grid;place-items:center;padding:18px';
  box.innerHTML='<div style="background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:16px;max-width:760px;width:100%;max-height:82vh;overflow:auto">'+
    '<div class="row" style="justify-content:space-between;margin-bottom:11px"><b>انتخاب تصویر</b>'+
    '<button class="btn sm" id="pkX">بستن</button></div>'+
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">'+
      MEDIA.map((m)=>'<div class="item" style="margin:0;cursor:pointer" data-u="'+esc(m.url)+'">'+
        '<img src="'+esc(m.url)+'" alt="" style="width:100%;height:90px;object-fit:contain;background:#0c0f16;border-radius:7px">'+
        '<div style="font-size:11px;color:var(--muted);margin-top:6px;word-break:break-all">'+esc(m.filename)+'</div></div>').join('')+
    '</div>'+
    '<div class="row" style="margin-top:12px"><button class="btn sm bad" id="pkClr">خالی کردن این فیلد</button></div></div>';
  const close=()=>box.remove();
  box.addEventListener('click',(e)=>{ if(e.target===box) close(); });
  box.querySelector('#pkX').onclick=close;
  box.querySelector('#pkClr').onclick=()=>{ const el=$('#'+inputId); if(el) el.value=''; close(); };
  box.querySelectorAll('[data-u]').forEach((el)=>{ el.onclick=()=>{ const t=$('#'+inputId); if(t) t.value=el.getAttribute('data-u'); close(); }; });
  document.body.appendChild(box);
}
/* Rendered next to an image input. */
function pickBtn(id){ return '<button type="button" class="btn sm pickBtn" style="margin-top:6px" data-for="'+id+'">انتخاب از تصویرها</button>'; }
/* Every pickBtn on the page, wired after whichever tab drew it. */
function wirePickers(){ document.querySelectorAll('.pickBtn').forEach((el)=>{ el.onclick=()=>pick(el.getAttribute('data-for')); }); }

/* ---------- pages ---------- */
const BLOCK_LABEL={hero:'سربرگ بزرگ',text:'متن',cards:'کارت‌ها',steps:'مرحله‌ها',faq:'پرسش و پاسخ',cta:'دعوت به اقدام',stats:'آمار'};
const ITEM_KINDS=['cards','steps','faq','stats'];

function render(){
  if(TAB==='pages') renderPages();
  else if(TAB==='posts') renderPosts();
  else if(TAB==='media') renderMedia();
  else renderSeo();
  wirePickers();
  const vs=$('#viewSite'); if(vs) vs.href=siteHome();
}

function renderPages(){
  $('#body').innerHTML=
    '<div class="note">هر صفحه از «بلوک» ساخته شده تا بدون دانستن HTML بتوانی محتوا را عوض کنی. نشانی صفحه (slug) در آدرس سایت دیده می‌شود و باید انگلیسی باشد. صفحهٔ <b>home</b> و <b>blog</b> حذف نمی‌شوند؛ فقط می‌شود غیرفعالشان کرد.</div>'+
    '<div class="row" style="margin-bottom:12px"><button class="btn ok" onclick="newPage()">➕ صفحهٔ جدید</button></div>'+
    DATA.pages.map((p,i)=>pageCard(p,i)).join('');
}
function pageCard(p,i){
  return '<div class="card"><div class="row"><h3 style="flex:1">'+esc(p.title)+
    ' <span class="pill '+(p.published?'on':'off')+'">'+(p.published?'منتشرشده':'پیش‌نویس')+'</span></h3>'+
    '<a class="btn sm" href="'+esc(pageHref(p.slug))+'" target="_blank" rel="noopener">مشاهده</a>'+
    '<button class="btn sm" onclick="togglePage('+i+')">'+(p.expanded?'بستن':'ویرایش')+'</button></div>'+
    '<p class="sub">/'+esc(p.slug==='home'?'':p.slug)+'</p>'+
    (p.expanded?pageEditor(p,i):'')+'</div>';
}
function togglePage(i){ DATA.pages[i].expanded=!DATA.pages[i].expanded; render(); }

function pageEditor(p,i){
  const f=(lbl,key,type)=>'<div class="f"><label>'+lbl+'</label><input id="pg_'+key+'_'+i+'" value="'+esc(p[key]||'')+'"'+(type==='num'?' type="number"':'')+'></div>';
  return '<div class="grid2">'+f('عنوان صفحه','title')+f('نشانی (slug) — انگلیسی','slug')+'</div>'+
    '<div class="grid2">'+f('نام در منو','navLabel')+f('ترتیب در منو','navOrder','num')+'</div>'+
    '<div class="row" style="margin-bottom:12px">'+
      '<label style="margin:0"><input type="checkbox" id="pg_show_'+i+'" '+(p.showInNav?'checked':'')+' style="width:auto"> نمایش در منو</label>'+
      '<label style="margin:0"><input type="checkbox" id="pg_pub_'+i+'" '+(p.published?'checked':'')+' style="width:auto"> منتشر شده</label>'+
      '<label style="margin:0"><input type="checkbox" id="pg_nox_'+i+'" '+(p.noindex?'checked':'')+' style="width:auto"> noindex (از گوگل پنهان)</label>'+
    '</div>'+
    '<div class="card" style="background:var(--panel2)"><h3>سئوی این صفحه</h3>'+
      '<p class="sub">اگر خالی بگذاری، از تنظیمات کلی سایت استفاده می‌شود. عنوان حدود ۶۰ و توضیح حدود ۱۵۵ کاراکتر بهترین نتیجه را می‌دهد.</p>'+
      '<div class="f"><label>عنوان سئو (title)</label><input id="pg_seoTitle_'+i+'" value="'+esc(p.seoTitle||'')+'"></div>'+
      '<div class="f"><label>توضیح متا (description)</label><textarea id="pg_seoDescription_'+i+'" style="min-height:64px">'+esc(p.seoDescription||'')+'</textarea></div>'+
      '<div class="f"><label>کلیدواژه‌ها (با ویرگول)</label><input id="pg_seoKeywords_'+i+'" value="'+esc(p.seoKeywords||'')+'"></div>'+
      '<div class="f"><label>تصویر اشتراک‌گذاری (og:image)</label><input id="pg_ogImage_'+i+'" class="mono" value="'+esc(p.ogImage||'')+'">'+pickBtn('pg_ogImage_'+i)+'</div>'+
    '</div>'+
    '<h3 style="margin:16px 0 8px">بلوک‌های محتوا</h3>'+
    (p.blocks||[]).map((b,bi)=>blockEditor(b,i,bi)).join('')+
    '<div class="row" style="margin:10px 0">'+
      Object.keys(BLOCK_LABEL).map((k)=>'<button class="btn sm" onclick="addBlock('+i+',\\''+k+'\\')">＋ '+BLOCK_LABEL[k]+'</button>').join('')+
    '</div>'+
    '<div class="row"><button class="btn pri" onclick="savePage('+i+')">💾 ذخیرهٔ صفحه</button>'+
      (['home','blog'].indexOf(p.slug)<0?'<button class="btn bad sm" onclick="delPage('+i+')">حذف صفحه</button>':'')+'</div>';
}

function blockEditor(b,i,bi){
  const id=(k)=>'bk_'+i+'_'+bi+'_'+k;
  const t=(lbl,k)=>'<div class="f"><label>'+lbl+'</label><input id="'+id(k)+'" value="'+esc(b[k]||'')+'"></div>';
  let inner='';
  if(b.kind==='hero'||b.kind==='cta'){
    inner=t('عنوان','title')+(b.kind==='hero'?t('زیرعنوان','subtitle'):'<div class="f"><label>متن</label><textarea id="'+id('body')+'" style="min-height:60px">'+esc(b.body||'')+'</textarea></div>')+
      '<div class="grid2">'+t('متن دکمه','ctaText')+t('لینک دکمه','ctaHref')+'</div>'+
      (b.kind==='hero'?'<div class="grid2">'+t('متن دکمهٔ دوم','ctaText2')+t('لینک دکمهٔ دوم','ctaHref2')+'</div>':'');
  } else if(b.kind==='text'){
    inner=t('عنوان','title')+'<div class="f"><label>متن — هر خط یک پاراگراف</label><textarea id="'+id('body')+'">'+esc(b.body||'')+'</textarea></div>';
  } else if(ITEM_KINDS.indexOf(b.kind)>=0){
    inner=t('عنوان بخش','title')+
      (b.items||[]).map((it,ii)=>{
        const iid=(k)=>'it_'+i+'_'+bi+'_'+ii+'_'+k;
        if(b.kind==='faq') return '<div class="item"><div class="f"><label>پرسش</label><input id="'+iid('q')+'" value="'+esc(it.q||'')+'"></div>'+
          '<div class="f"><label>پاسخ</label><textarea id="'+iid('a')+'" style="min-height:56px">'+esc(it.a||'')+'</textarea></div>'+
          '<button class="btn bad sm" onclick="delItem('+i+','+bi+','+ii+')">حذف</button></div>';
        return '<div class="item">'+
          (b.kind!=='steps'?'<div class="f"><label>آیکون (ایموجی)</label><input id="'+iid('icon')+'" value="'+esc(it.icon||'')+'" style="width:90px"></div>':'')+
          '<div class="f"><label>عنوان</label><input id="'+iid('title')+'" value="'+esc(it.title||'')+'"></div>'+
          (b.kind==='stats'?'<div class="f"><label>عدد</label><input id="'+iid('value')+'" value="'+esc(it.value||'')+'"></div>':
            '<div class="f"><label>متن</label><textarea id="'+iid('text')+'" style="min-height:56px">'+esc(it.text||'')+'</textarea></div>')+
          '<button class="btn bad sm" onclick="delItem('+i+','+bi+','+ii+')">حذف</button></div>';
      }).join('')+
      '<button class="btn sm" onclick="addItem('+i+','+bi+')">＋ مورد جدید</button>';
  }
  return '<div class="blk"><div class="hd"><b>'+(BLOCK_LABEL[b.kind]||b.kind)+'</b>'+
    '<span><button class="btn sm" onclick="moveBlock('+i+','+bi+',-1)">↑</button> '+
    '<button class="btn sm" onclick="moveBlock('+i+','+bi+',1)">↓</button> '+
    '<button class="btn bad sm" onclick="delBlock('+i+','+bi+')">حذف</button></span></div>'+inner+'</div>';
}

/* Read the DOM back into the model before any structural change, so typing is
   never lost when a block is added, moved or deleted. */
function syncPage(i){
  const p=DATA.pages[i];
  ['title','slug','navLabel','navOrder','seoTitle','seoDescription','seoKeywords','ogImage'].forEach((k)=>{
    const el=document.getElementById('pg_'+k+'_'+i); if(el) p[k]=(k==='navOrder')?(Number(el.value)||50):el.value;
  });
  const sh=document.getElementById('pg_show_'+i), pu=document.getElementById('pg_pub_'+i), nx=document.getElementById('pg_nox_'+i);
  if(sh)p.showInNav=sh.checked; if(pu)p.published=pu.checked; if(nx)p.noindex=nx.checked;
  (p.blocks||[]).forEach((b,bi)=>{
    ['title','subtitle','body','ctaText','ctaHref','ctaText2','ctaHref2'].forEach((k)=>{
      const el=document.getElementById('bk_'+i+'_'+bi+'_'+k); if(el) b[k]=el.value;
    });
    (b.items||[]).forEach((it,ii)=>{
      ['icon','title','text','q','a','value'].forEach((k)=>{
        const el=document.getElementById('it_'+i+'_'+bi+'_'+ii+'_'+k); if(el) it[k]=el.value;
      });
    });
  });
}
function addBlock(i,kind){ syncPage(i); DATA.pages[i].blocks=DATA.pages[i].blocks||[];
  DATA.pages[i].blocks.push({kind:kind,title:'',items:ITEM_KINDS.indexOf(kind)>=0?[{}]:[]}); render(); }
function delBlock(i,bi){ syncPage(i); DATA.pages[i].blocks.splice(bi,1); render(); }
function moveBlock(i,bi,d){ syncPage(i); const b=DATA.pages[i].blocks; const j=bi+d;
  if(j<0||j>=b.length) return; const t=b[bi]; b[bi]=b[j]; b[j]=t; render(); }
function addItem(i,bi){ syncPage(i); const b=DATA.pages[i].blocks[bi]; b.items=b.items||[]; b.items.push({}); render(); }
function delItem(i,bi,ii){ syncPage(i); DATA.pages[i].blocks[bi].items.splice(ii,1); render(); }
function newPage(){ DATA.pages.push({slug:'',title:'صفحهٔ جدید',navLabel:'صفحهٔ جدید',navOrder:50,
  showInNav:true,published:false,noindex:false,blocks:[],expanded:true}); render(); }
async function savePage(i){
  syncPage(i);
  try{ await api('PUT','pages',DATA.pages[i]); toast('ذخیره شد ✅'); await loadAll(); }
  catch(e){ toast(e.message,true); }
}
async function delPage(i){
  if(!confirm('این صفحه حذف شود؟')) return;
  try{ await api('DELETE','pages/'+encodeURIComponent(DATA.pages[i].slug)); toast('حذف شد'); await loadAll(); }
  catch(e){ toast(e.message,true); }
}

/* ---------- blog ---------- */
function renderPosts(){
  $('#body').innerHTML=
    '<div class="note">متن مقاله ساده است و HTML نمی‌پذیرد: خطی که با <b>##</b> شروع شود تیتر، با <b>###</b> تیتر کوچک‌تر، با <b>-</b> بولت، و بقیه پاراگراف است. همین باعث می‌شود هیچ مقاله‌ای نتواند ظاهر سایت را خراب کند.</div>'+
    '<div class="row" style="margin-bottom:12px"><button class="btn ok" onclick="newPost()">➕ مقالهٔ جدید</button></div>'+
    DATA.posts.map((p,i)=>postCard(p,i)).join('');
}
function postCard(p,i){
  return '<div class="card"><div class="row"><h3 style="flex:1">'+esc(p.title)+
    ' <span class="pill '+(p.published?'on':'off')+'">'+(p.published?'منتشرشده':'پیش‌نویس')+'</span></h3>'+
    '<a class="btn sm" href="/blog/'+esc(p.slug)+'" target="_blank" rel="noopener">مشاهده</a>'+
    '<button class="btn sm" onclick="togglePost('+i+')">'+(p.expanded?'بستن':'ویرایش')+'</button></div>'+
    '<p class="sub">/blog/'+esc(p.slug)+'</p>'+(p.expanded?postEditor(p,i):'')+'</div>';
}
function togglePost(i){ DATA.posts[i].expanded=!DATA.posts[i].expanded; render(); }
function postEditor(p,i){
  const f=(lbl,k)=>'<div class="f"><label>'+lbl+'</label><input id="po_'+k+'_'+i+'" value="'+esc(p[k]||'')+'"></div>';
  return '<div class="grid2">'+f('عنوان','title')+f('نشانی (slug) — انگلیسی','slug')+'</div>'+
    '<div class="f"><label>خلاصه (در فهرست وبلاگ و در گوگل دیده می‌شود)</label><textarea id="po_excerpt_'+i+'" style="min-height:60px">'+esc(p.excerpt||'')+'</textarea></div>'+
    '<div class="grid2">'+f('نویسنده','author')+f('برچسب‌ها (با ویرگول)','tagsCsv')+'</div>'+
    '<div class="f"><label>متن مقاله</label><textarea id="po_body_'+i+'" style="min-height:280px">'+esc(p.body||'')+'</textarea></div>'+
    '<div class="row" style="margin-bottom:12px">'+
      '<label style="margin:0"><input type="checkbox" id="po_pub_'+i+'" '+(p.published?'checked':'')+' style="width:auto"> منتشر شده</label>'+
      '<label style="margin:0"><input type="checkbox" id="po_nox_'+i+'" '+(p.noindex?'checked':'')+' style="width:auto"> noindex</label>'+
    '</div>'+
    '<div class="card" style="background:var(--panel2)"><h3>سئوی مقاله</h3>'+
      '<div class="f"><label>عنوان سئو</label><input id="po_seoTitle_'+i+'" value="'+esc(p.seoTitle||'')+'"></div>'+
      '<div class="f"><label>توضیح متا</label><textarea id="po_seoDescription_'+i+'" style="min-height:60px">'+esc(p.seoDescription||'')+'</textarea></div>'+
      '<div class="f"><label>کلیدواژه‌ها</label><input id="po_seoKeywords_'+i+'" value="'+esc(p.seoKeywords||'')+'"></div>'+
      '<div class="f"><label>تصویر کاور</label><input id="po_cover_'+i+'" class="mono" value="'+esc(p.cover||'')+'">'+pickBtn('po_cover_'+i)+'</div>'+
    '</div>'+
    '<div class="row"><button class="btn pri" onclick="savePost('+i+')">💾 ذخیرهٔ مقاله</button>'+
      '<button class="btn bad sm" onclick="delPost('+i+')">حذف مقاله</button></div>';
}
function newPost(){ DATA.posts.unshift({slug:'',title:'مقالهٔ جدید',excerpt:'',body:'',author:'تیم پرایز کوئیز',
  tags:[],published:false,noindex:false,publishedAt:new Date().toISOString(),expanded:true}); render(); }
async function savePost(i){
  const p=DATA.posts[i];
  ['title','slug','author','seoTitle','seoKeywords','cover'].forEach((k)=>{
    const el=document.getElementById('po_'+k+'_'+i); if(el) p[k]=el.value; });
  ['excerpt','body','seoDescription'].forEach((k)=>{
    const el=document.getElementById('po_'+k+'_'+i); if(el) p[k]=el.value; });
  const tg=document.getElementById('po_tagsCsv_'+i);
  if(tg) p.tags=tg.value.split(',').map((s)=>s.trim()).filter(Boolean);
  const pu=document.getElementById('po_pub_'+i), nx=document.getElementById('po_nox_'+i);
  if(pu)p.published=pu.checked; if(nx)p.noindex=nx.checked;
  try{ await api('PUT','posts',p); toast('ذخیره شد ✅'); await loadAll(); }catch(e){ toast(e.message,true); }
}
async function delPost(i){
  if(!confirm('این مقاله حذف شود؟')) return;
  try{ await api('DELETE','posts/'+encodeURIComponent(DATA.posts[i].slug)); toast('حذف شد'); await loadAll(); }
  catch(e){ toast(e.message,true); }
}

/* ---------- global SEO ---------- */
function renderSeo(){
  const s=DATA.settings||{};
  const f=(lbl,k,hint)=>'<div class="f"><label>'+lbl+'</label><input id="st_'+k+'" value="'+esc(s[k]||'')+'">'+
    (hint?'<p class="sub" style="margin:4px 0 0">'+hint+'</p>':'')+'</div>';
  $('#body').innerHTML=
    '<div class="note">این‌ها روی همهٔ صفحه‌ها اثر می‌گذارند. <b>نشانی سایت</b> از همه مهم‌تر است: آدرس canonical، لینک‌های اشتراک‌گذاری و sitemap همه از رویش ساخته می‌شوند، پس باید دقیقاً همان دامنه‌ای باشد که سایت روی آن بالا می‌آید (با https و بدون اسلش آخر).</div>'+
    '<div class="card"><h3>هویت سایت</h3>'+
      '<div class="grid2">'+f('نام سایت','siteName')+f('شعار','tagline')+'</div>'+
      f('نشانی سایت','baseUrl','مثال: https://www.prizequiz.ir')+
      '<div class="f"><label>توضیح پیش‌فرض سایت</label><textarea id="st_description" style="min-height:70px">'+esc(s.description||'')+'</textarea></div>'+
      f('کلیدواژه‌های پیش‌فرض','keywords')+
      '<div class="grid2">'+f('ایموجی لوگو','logoEmoji')+'<div class="f"><label>تصویر پیش‌فرض اشتراک‌گذاری</label><input id="st_ogImage" value="'+esc(s.ogImage||'')+'">'+pickBtn('st_ogImage')+'</div>'+'</div>'+
    '</div>'+
    '<div class="card"><h3>لینک بازی و دانلود</h3>'+
      '<p class="sub">هر جای سایت که نوشته شود <b>{play}</b> به همین نشانی تبدیل می‌شود، پس اگر آدرس بازی عوض شد فقط همین یک خانه را عوض کن.</p>'+
      f('نشانی بازی','playUrl')+
      f('نشانی صفحهٔ اصلی سایت','homePath','بازی روی / است، پس خانهٔ سایت روی /home می‌نشیند. اگر ریشه را به سایت دادی، اینجا / بگذار.')+
      '<div class="grid2">'+f('لینک اندروید (APK)','androidUrl')+f('لینک iOS','iosUrl')+'</div>'+
      '<div class="grid2">'+f('کافه بازار','bazaarUrl')+f('مایکت','myketUrl')+'</div>'+
    '</div>'+
    '<div class="card"><h3>تماس و شبکه‌ها</h3>'+
      '<div class="grid2">'+f('ایمیل','email')+f('تلفن','phone')+'</div>'+
      f('نشانی','address')+
      '<div class="grid2">'+f('تلگرام','telegram')+f('اینستاگرام','instagram')+'</div>'+
      f('ایکس (توییتر)','twitter')+
    '</div>'+
    '<div class="card"><h3>تأیید مالکیت و نماد</h3>'+
      '<p class="sub">این دو کادر <b>عیناً</b> در صفحه قرار می‌گیرند، چون کد آماده‌ای هستند که از پنل گوگل و اینماد کپی می‌کنی. فقط چیزی را بگذار که از خود آن پنل‌ها گرفته‌ای.</p>'+
      '<div class="f"><label>تگ تأیید گوگل سرچ کنسول</label><textarea id="st_googleVerification" class="mono" style="min-height:56px">'+esc(s.googleVerification||'')+'</textarea></div>'+
      '<div class="f"><label>کد نماد اعتماد الکترونیکی (اینماد)</label><textarea id="st_enamadHtml" class="mono" style="min-height:80px">'+esc(s.enamadHtml||'')+'</textarea></div>'+
    '</div>'+
    '<div class="card"><h3>پانویس و وضعیت</h3>'+
      f('متن پانویس','footerNote')+
      '<label style="margin:0"><input type="checkbox" id="st_enabled" '+(s.enabled!==false?'checked':'')+' style="width:auto"> سایت روشن باشد</label>'+
      '<p class="sub">خاموش‌کردن سایت هیچ اثری روی بازی ندارد — دو سرویس جدا هستند.</p>'+
    '</div>'+
    '<button class="btn pri" onclick="saveSeo()">💾 ذخیرهٔ تنظیمات</button>';
}
async function saveSeo(){
  const s={};
  ['siteName','tagline','baseUrl','keywords','logoEmoji','ogImage','playUrl','homePath','androidUrl','iosUrl',
   'bazaarUrl','myketUrl','email','phone','address','telegram','instagram','twitter','footerNote']
    .forEach((k)=>{ const el=document.getElementById('st_'+k); if(el) s[k]=el.value; });
  ['description','googleVerification','enamadHtml'].forEach((k)=>{
    const el=document.getElementById('st_'+k); if(el) s[k]=el.value; });
  const en=document.getElementById('st_enabled'); if(en) s.enabled=en.checked;
  try{ await api('PUT','settings',s); toast('ذخیره شد ✅'); await loadAll(); }catch(e){ toast(e.message,true); }
}

/* A key already typed this session skips the gate. */
(function(){
  let k=''; try{ k=sessionStorage.getItem('site_admin_key')||''; }catch(e){}
  if(!k) return;
  KEY=k;
  loadAll().then(()=>{ $('#gate').style.display='none'; $('#app').style.display=''; })
           .catch(()=>{ try{ sessionStorage.removeItem('site_admin_key'); }catch(e){} });
})();
</script></body></html>`;
}
