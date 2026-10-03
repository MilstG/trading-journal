// Ledger app · part 9 of 15: tax PDF, fee tiers, the weekly review, variance, risk creep, guardrails, demo mode, notifications, PWA.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ tax statement PDF ============================ */
// Minimal single-purpose PDF writer: US-letter pages, base-14 Courier fonts, zero deps —
// keeps the app self-contained and CSP-clean. Courier is fixed-width (600/1000 em) so
// column alignment is exact and the Node harness can verify layout math.
class MiniPDF{
  constructor(){ this.pages=[]; this._imgs=[]; this.newPage(); }
  newPage(){ this._ops=[]; this.pages.push(this._ops); }
  usePage(i){ this._ops=this.pages[i]; }
  _sub(s){ return String(s)
      .replace(/[\u2014\u2013\u2212]/g,'-').replace(/\u00b7/g,'.').replace(/\u2248/g,'~')
      .replace(/\u00d7/g,'x').replace(/\u2192/g,'->').replace(/[\u2018\u2019]/g,"'")
      .replace(/[\u201c\u201d]/g,'"').replace(/[^\x20-\x7E]/g,'?'); }
  _esc(s){ return this._sub(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
  // Measure the SUBSTITUTED string: '\u2192' renders as two glyphs ('->'), and measuring the
  // raw string shifted every right-aligned cell containing an arrow by one glyph.
  w(s,size){ return this._sub(s).length*0.6*(size||8); } // Courier advance = 600/1000 em
  text(x,y,s,o={}){ const size=o.size||8, f=o.bold?'F2':(o.italic?'F3':'F1'), c=o.color||[0,0,0];
    this._ops.push(`BT /${f} ${size} Tf ${c[0]} ${c[1]} ${c[2]} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${this._esc(s)}) Tj ET`); }
  textR(x,y,s,o={}){ this.text(x-this.w(s,o.size||8),y,s,o); } // right-aligned
  line(x1,y1,x2,y2,o={}){ const c=o.color||[0.72,0.74,0.78];
    this._ops.push(`${c[0]} ${c[1]} ${c[2]} RG ${(o.w||0.7)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  rect(x,y,w,h,o={}){ const c=o.fill||[0.95,0.95,0.96];
    this._ops.push(`${c[0]} ${c[1]} ${c[2]} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  // Register a JPEG (from canvas.toDataURL('image/jpeg')) as an image XObject. Returns an
  // index for drawImage, or -1 if the data URL isn't a parseable JPEG. Dimensions are read
  // from the SOF marker; pixel data is embedded verbatim with /Filter /DCTDecode, so no
  // decompression or re-encoding happens here.
  image(dataUrl){
    const m=/^data:image\/jpeg;base64,(.+)$/.exec(dataUrl||''); if(!m)return -1;
    let bin; try{ bin=atob(m[1]); }catch(e){ return -1; }
    let w=0,h=0;
    for(let i=2;i<bin.length-9;){
      if(bin.charCodeAt(i)!==0xFF){ i++; continue; }
      const mk=bin.charCodeAt(i+1);
      if(mk===0xFF){ i++; continue; } // 0xFF fill bytes are legal padding — stepping past them read a bogus segment length
      if(mk===0xD8||mk===0x01||(mk>=0xD0&&mk<=0xD9)){ i+=2; continue; }
      const len=(bin.charCodeAt(i+2)<<8)|bin.charCodeAt(i+3);
      if(mk>=0xC0&&mk<=0xCF&&mk!==0xC4&&mk!==0xC8&&mk!==0xCC){
        h=(bin.charCodeAt(i+5)<<8)|bin.charCodeAt(i+6);
        w=(bin.charCodeAt(i+7)<<8)|bin.charCodeAt(i+8); break; }
      i+=2+len;
    }
    if(!(w>0&&h>0))return -1;
    this._imgs.push({data:bin,w,h}); return this._imgs.length-1;
  }
  imgSize(i){ const im=this._imgs[i]; return im?{w:im.w,h:im.h}:null; }
  drawImage(i,x,y,w,h){ if(i==null||i<0||!this._imgs[i])return;
    this._ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q`); }
  output(){
    const n=this.pages.length, objs=[];
    const pageRefs=[]; let num=6;
    for(let i=0;i<n;i++){ pageRefs.push({page:num,content:num+1}); num+=2; }
    const imgBase=num; num+=this._imgs.length;
    objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
    objs[2]=`<< /Type /Pages /Kids [${pageRefs.map(r=>r.page+' 0 R').join(' ')}] /Count ${n} >>`;
    objs[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
    objs[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>';
    objs[5]='<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Oblique >>';
    const xo=this._imgs.length?` /XObject << ${this._imgs.map((im,i)=>`/Im${i} ${imgBase+i} 0 R`).join(' ')} >>`:'';
    for(let i=0;i<n;i++){ const r=pageRefs[i];
      objs[r.page]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${xo} >> /Contents ${r.content} 0 R >>`;
      objs[r.content]={stream:this.pages[i].join('\n')};
    }
    this._imgs.forEach((im,i)=>{
      objs[imgBase+i]={stream:im.data,
        dict:`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode `};
    });
    let out='%PDF-1.4\n'; const offs=[0];
    for(let i=1;i<num;i++){ offs[i]=out.length; const o=objs[i];
      out+=(o&&o.stream!==undefined)
        ? `${i} 0 obj\n<< ${o.dict||''}/Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream\nendobj\n`
        : `${i} 0 obj\n${o}\nendobj\n`;
    }
    const xref=out.length;
    out+=`xref\n0 ${num}\n0000000000 65535 f \n`;
    for(let i=1;i<num;i++) out+=String(offs[i]).padStart(10,'0')+' 00000 n \n';
    out+=`trailer\n<< /Size ${num} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return out;
  }
  // The text-only statement path serializes fine as a plain string; embedded JPEG bytes need
  // a latin1-faithful byte array (a UTF-8 Blob would mangle every byte >127).
  outputBytes(){ const s=this.output(); const u=new Uint8Array(s.length);
    for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i)&0xFF; return u; }
}
// Pure statement model: chronological realized trades grouped by UTC tax year with monthly
// subtotals and a running balance (cumulative realized net from the first trade onward).
// Sign convention matches the tax CSV: fees shown as a negative cost; pnl+fees+funding=net.
function taxStatementModel(trades,wallets,nowIso){
  const rows=trades.filter(t=>!t.isOpen&&t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  if(!rows.length)return null;
  const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dU=ms=>new Date(ms).toISOString().slice(0,10);
  let bal=0; const years=[]; let Y=null,M=null;
  const grand={n:0,pnl:0,fees:0,funding:0,net:0};
  for(const t of rows){ const d=new Date(t.closeTime), yr=d.getUTCFullYear(), mo=d.getUTCMonth();
    if(!Y||Y.year!==yr){ Y={year:yr,open:bal,close:bal,totals:{n:0,pnl:0,fees:0,funding:0,net:0},months:[],lines:[]}; years.push(Y); M=null; }
    if(!M||M.mo!==mo){ M={mo,label:MON[mo]+' '+yr,n:0,wins:0,losses:0,pnl:0,fees:0,funding:0,net:0,endBal:bal}; Y.months.push(M); }
    const fees=-t.fees, fund=t.funding||0;
    bal+=t.net;
    Y.lines.push({date:dU(t.closeTime),symbol:dcoin(t),market:t.market,dir:t.dir,
      held:t.durationMs?t.durationMs/86400000:0,pnl:t.pnl,fees,funding:fund,net:t.net,balance:bal,
      wallet:t.wallet&&(t.wallet.label||(t.wallet.address?t.wallet.address.slice(0,10):''))||''});
    M.n++; if(t.net>0)M.wins++; else if(t.net<0)M.losses++;
    M.pnl+=t.pnl; M.fees+=fees; M.funding+=fund; M.net+=t.net; M.endBal=bal;
    Y.totals.n++; Y.totals.pnl+=t.pnl; Y.totals.fees+=fees; Y.totals.funding+=fund; Y.totals.net+=t.net; Y.close=bal;
    grand.n++; grand.pnl+=t.pnl; grand.fees+=fees; grand.funding+=fund; grand.net+=t.net;
  }
  return { generated:(nowIso||new Date().toISOString()).replace(/\.\d{3}Z$/,'Z'),
    from:dU(rows[0].closeTime), to:dU(rows[rows.length-1].closeTime),
    wallets:(wallets||[]).map(w=>({label:w.label||'',address:w.address||''})),
    years, grand, endBalance:bal };
}
// Renders the statement model into PDF ops. Pure aside from fmtUsd.
function renderTaxPdfDoc(model){
  const pdf=new MiniPDF(); const W=612,H=792,Mg=42;
  const gray=[0.44,0.46,0.52], faint=[0.6,0.62,0.67], dark=[0.09,0.10,0.13];
  const pos=[0.05,0.52,0.33], neg=[0.75,0.19,0.24];
  const colFor=v=>v>0.004?pos:v<-0.004?neg:dark;
  const money=v=>fmtUsd(v);
  let y;
  const runHead=()=>{ pdf.text(Mg,H-30,'LEDGER - ACCOUNT STATEMENT',{size:7,bold:true,color:gray});
    pdf.textR(W-Mg,H-30,model.from+' to '+model.to,{size:7,color:gray});
    pdf.line(Mg,H-36,W-Mg,H-36); y=H-52; };
  const page=()=>{ pdf.newPage(); runHead(); };
  const ensure=h=>{ if(y-h<Mg+26)page(); };
  // ---- cover header ----
  pdf.text(Mg,H-64,'LEDGER',{size:20,bold:true,color:dark});
  pdf.textR(W-Mg,H-64,'ACCOUNT STATEMENT',{size:11,color:gray});
  pdf.text(Mg,H-80,'Hyperliquid trading activity - realized PnL',{size:8.5,color:gray});
  pdf.line(Mg,H-90,W-Mg,H-90,{w:1.1,color:dark});
  y=H-108;
  pdf.text(Mg,y,'Period covered:',{size:8,color:gray}); pdf.text(Mg+110,y,model.from+'  to  '+model.to,{size:8,bold:true}); y-=13;
  pdf.text(Mg,y,'Generated:',{size:8,color:gray});      pdf.text(Mg+110,y,model.generated,{size:8}); y-=13;
  if(model.wallets.length){ pdf.text(Mg,y,'Wallets:',{size:8,color:gray});
    for(const w of model.wallets){ pdf.text(Mg+110,y,(w.label?w.label+'  ':'')+w.address,{size:8}); y-=11; } y-=2; }
  y-=8;
  // ---- statement summary (per year) ----
  const cols={yr:Mg, n:Mg+92, pnl:Mg+205, fees:Mg+285, fund:Mg+365, net:Mg+445, bal:W-Mg};
  const sumHead=(title)=>{ ensure(40); pdf.rect(Mg-4,y-4,W-2*Mg+8,15); pdf.text(Mg,y,title,{size:8,bold:true,color:dark}); y-=16;
    pdf.text(cols.yr,y,'TAX YEAR',{size:7,color:gray}); pdf.textR(cols.n,y,'TRADES',{size:7,color:gray});
    pdf.textR(cols.pnl,y,'REALIZED PNL',{size:7,color:gray}); pdf.textR(cols.fees,y,'FEES',{size:7,color:gray});
    pdf.textR(cols.fund,y,'FUNDING',{size:7,color:gray}); pdf.textR(cols.net,y,'NET',{size:7,color:gray});
    pdf.textR(cols.bal,y,'CLOSING BAL',{size:7,color:gray}); y-=4; pdf.line(Mg,y,W-Mg,y); y-=11; };
  sumHead('STATEMENT SUMMARY');
  for(const Y of model.years){ ensure(12);
    pdf.text(cols.yr,y,String(Y.year),{size:8,bold:true});
    pdf.textR(cols.n,y,String(Y.totals.n),{size:8});
    pdf.textR(cols.pnl,y,money(Y.totals.pnl),{size:8,color:colFor(Y.totals.pnl)});
    pdf.textR(cols.fees,y,money(Y.totals.fees),{size:8,color:colFor(Y.totals.fees)});
    pdf.textR(cols.fund,y,money(Y.totals.funding),{size:8,color:colFor(Y.totals.funding)});
    pdf.textR(cols.net,y,money(Y.totals.net),{size:8,bold:true,color:colFor(Y.totals.net)});
    pdf.textR(cols.bal,y,money(Y.close),{size:8});
    y-=12; }
  pdf.line(Mg,y+4,W-Mg,y+4); y-=2;
  pdf.text(cols.yr,y,'TOTAL',{size:8,bold:true});
  pdf.textR(cols.n,y,String(model.grand.n),{size:8,bold:true});
  pdf.textR(cols.pnl,y,money(model.grand.pnl),{size:8,bold:true,color:colFor(model.grand.pnl)});
  pdf.textR(cols.fees,y,money(model.grand.fees),{size:8,bold:true,color:colFor(model.grand.fees)});
  pdf.textR(cols.fund,y,money(model.grand.funding),{size:8,bold:true,color:colFor(model.grand.funding)});
  pdf.textR(cols.net,y,money(model.grand.net),{size:8,bold:true,color:colFor(model.grand.net)});
  pdf.textR(cols.bal,y,money(model.endBalance),{size:8,bold:true});
  y-=24;
  // ---- per-year detail ----
  const dcols={date:Mg, sym:Mg+52, dir:Mg+150, held:Mg+218, pnl:Mg+286, fees:Mg+348, fund:Mg+410, net:Mg+468, bal:W-Mg};
  const detHead=()=>{ pdf.text(dcols.date,y,'CLOSE',{size:6.5,color:gray}); pdf.text(dcols.sym,y,'MARKET',{size:6.5,color:gray});
    pdf.text(dcols.dir,y,'SIDE',{size:6.5,color:gray}); pdf.textR(dcols.held,y,'HELD(D)',{size:6.5,color:gray});
    pdf.textR(dcols.pnl,y,'PNL',{size:6.5,color:gray}); pdf.textR(dcols.fees,y,'FEES',{size:6.5,color:gray});
    pdf.textR(dcols.fund,y,'FUNDING',{size:6.5,color:gray}); pdf.textR(dcols.net,y,'NET',{size:6.5,color:gray});
    pdf.textR(dcols.bal,y,'BALANCE',{size:6.5,color:gray}); y-=3.5; pdf.line(Mg,y,W-Mg,y); y-=9.5; };
  const ensureDet=h=>{ if(y-h<Mg+26){ page(); detHead(); } };
  for(const Y of model.years){
    ensure(78);
    pdf.rect(Mg-4,y-4,W-2*Mg+8,15,{fill:[0.92,0.93,0.94]});
    pdf.text(Mg,y,'TAX YEAR '+Y.year,{size:8.5,bold:true});
    pdf.textR(W-Mg,y,'opening '+money(Y.open)+'   closing '+money(Y.close),{size:7.5,color:gray});
    y-=18;
    // monthly summary — re-emit the label after a page break so continuation rows
    // aren't a headless block of numbers
    const monHead=cont=>{ pdf.text(Mg,y,'Monthly summary'+(cont?' (continued)':''),{size:7,italic:true,color:gray}); y-=11; };
    monHead(false);
    const mc={mo:Mg, n:Mg+120, wl:Mg+185, pnl:Mg+265, fees:Mg+330, fund:Mg+395, net:Mg+455, bal:W-Mg};
    for(const m of Y.months){ if(y-10<Mg+26){ page(); monHead(true); }
      pdf.text(mc.mo,y,m.label,{size:7.5});
      pdf.textR(mc.n,y,m.n+' trades',{size:7.5,color:gray});
      pdf.textR(mc.wl,y,m.wins+'W/'+m.losses+'L',{size:7.5,color:gray});
      pdf.textR(mc.pnl,y,money(m.pnl),{size:7.5,color:colFor(m.pnl)});
      pdf.textR(mc.fees,y,money(m.fees),{size:7.5,color:colFor(m.fees)});
      pdf.textR(mc.fund,y,money(m.funding),{size:7.5,color:colFor(m.funding)});
      pdf.textR(mc.net,y,money(m.net),{size:7.5,bold:true,color:colFor(m.net)});
      pdf.textR(mc.bal,y,money(m.endBal),{size:7.5});
      y-=10.5; }
    y-=6;
    // transaction detail
    ensure(30);
    pdf.text(Mg,y,'Transactions ('+Y.lines.length+')',{size:7,italic:true,color:gray}); y-=11;
    detHead();
    let alt=false;
    for(const ln of Y.lines){ ensureDet(9.5);
      if(alt)pdf.rect(Mg-2,y-2.4,W-2*Mg+4,9.2,{fill:[0.965,0.968,0.975]}); alt=!alt;
      pdf.text(dcols.date,y,ln.date,{size:7});
      pdf.text(dcols.sym,y,String(ln.symbol).slice(0,15)+(ln.market==='spot'?' (s)':''),{size:7});
      pdf.text(dcols.dir,y,ln.dir,{size:7,color:gray});
      pdf.textR(dcols.held,y,ln.held<0.01?'<0.01':ln.held.toFixed(2),{size:7,color:gray});
      pdf.textR(dcols.pnl,y,money(ln.pnl),{size:7,color:colFor(ln.pnl)});
      pdf.textR(dcols.fees,y,money(ln.fees),{size:7,color:colFor(ln.fees)});
      pdf.textR(dcols.fund,y,money(ln.funding),{size:7,color:colFor(ln.funding)});
      pdf.textR(dcols.net,y,money(ln.net),{size:7,bold:true,color:colFor(ln.net)});
      pdf.textR(dcols.bal,y,money(ln.balance),{size:7});
      y-=9.5; }
    y-=8; pdf.line(Mg,y+5,W-Mg,y+5,{color:faint});
    pdf.textR(W-Mg,y-3,'Year '+Y.year+' net: '+money(Y.totals.net),{size:8,bold:true,color:colFor(Y.totals.net)});
    y-=20;
  }
  // ---- footers (need final page count) ----
  const nP=pdf.pages.length;
  for(let i=0;i<nP;i++){ pdf.usePage(i);
    pdf.line(Mg,Mg-8,W-Mg,Mg-8);
    pdf.text(Mg,Mg-19,'Realized PnL only - no unrealized positions or transferred cost basis. Not tax advice.',{size:6.5,color:faint});
    pdf.textR(W-Mg,Mg-19,'Page '+(i+1)+' of '+nP,{size:6.5,color:faint});
  }
  return pdf.output();
}
// Pure diagnostic-PDF renderer over a plain model (stats rows, JPEG charts, recommendation
// text) — the print-grade sibling of the HTML report export. Layout mirrors the statement
// PDF; charts arrive pre-rendered as canvas JPEGs and are embedded via MiniPDF image
// XObjects (DCTDecode), so the document opens anywhere without a browser.
function renderDiagPdfDoc(model){
  const pdf=new MiniPDF(); const W=612,H=792,Mg=42,CW=W-2*Mg;
  const gray=[0.44,0.46,0.52], faint=[0.6,0.62,0.67], dark=[0.09,0.10,0.13];
  let y;
  const runHead=()=>{ pdf.text(Mg,H-30,'LEDGER - TRADING DIAGNOSTIC',{size:7,bold:true,color:gray});
    pdf.textR(W-Mg,H-30,model.periodDesc,{size:7,color:gray});
    pdf.line(Mg,H-36,W-Mg,H-36); y=H-52; };
  const page=()=>{ pdf.newPage(); runHead(); };
  const ensure=h=>{ if(y-h<Mg+26)page(); };
  const wrap=(txt,size,maxW)=>{ const words=String(txt).split(/\s+/).filter(Boolean);
    const lines=[]; let cur='';
    for(const wd of words){ const t=cur?cur+' '+wd:wd;
      if(pdf.w(t,size)>maxW&&cur){ lines.push(cur); cur=wd; } else cur=t; }
    if(cur)lines.push(cur); return lines; };
  // ---- cover header ----
  pdf.text(Mg,H-64,'LEDGER',{size:20,bold:true,color:dark});
  pdf.textR(W-Mg,H-64,'TRADING DIAGNOSTIC',{size:11,color:gray});
  pdf.text(Mg,H-80,'Hyperliquid trading activity - performance diagnostic snapshot',{size:8.5,color:gray});
  pdf.line(Mg,H-90,W-Mg,H-90,{w:1.1,color:dark});
  y=H-108;
  pdf.text(Mg,y,'View / period:',{size:8,color:gray}); pdf.text(Mg+110,y,model.view+'  -  '+model.periodDesc,{size:8,bold:true}); y-=13;
  pdf.text(Mg,y,'Generated:',{size:8,color:gray});     pdf.text(Mg+110,y,model.generated+'  ('+model.tz+')',{size:8}); y-=13;
  if(model.wallets.length){ pdf.text(Mg,y,'Wallets:',{size:8,color:gray});
    for(const w of model.wallets){ pdf.text(Mg+110,y,(w.label?w.label+'  ':'')+w.address,{size:8}); y-=11; } y-=2; }
  y-=8;
  // ---- headline stats, two columns ----
  ensure(30); pdf.rect(Mg-4,y-4,CW+8,15); pdf.text(Mg,y,'HEADLINE',{size:8,bold:true,color:dark}); y-=18;
  const colW=CW/2, rows=model.stats||[];
  for(let i=0;i<rows.length;i+=2){ ensure(13);
    for(let c=0;c<2;c++){ const r2=rows[i+c]; if(!r2)continue; const x=Mg+c*colW;
      pdf.text(x,y,r2.k,{size:7.5,color:gray});
      pdf.textR(x+colW-14,y,r2.v+(r2.sub?'  ('+r2.sub+')':''),{size:7.5,bold:true}); }
    y-=12; }
  y-=8;
  // ---- charts ----
  for(const ch of (model.charts||[])){
    const idx=pdf.image(ch.img); if(idx<0)continue;
    const sz=pdf.imgSize(idx); let w=CW, h=w*sz.h/sz.w;
    if(h>300){ w=w*300/h; h=300; } // clamp height by shrinking BOTH axes — stretching tall charts distorted them
    ensure(h+26);
    pdf.text(Mg,y,ch.title.toUpperCase(),{size:8,bold:true,color:dark}); y-=6;
    pdf.drawImage(idx,Mg,y-h,w,h); y-=h+16;
  }
  // ---- recommendations ----
  if((model.recs||[]).length){
    ensure(30); pdf.rect(Mg-4,y-4,CW+8,15); pdf.text(Mg,y,'RECOMMENDATIONS',{size:8,bold:true,color:dark}); y-=18;
    model.recs.forEach((r2,i)=>{ const lines=wrap(r2,7.5,CW-16); ensure(lines.length*10+6);
      pdf.text(Mg,y,String(i+1)+'.',{size:7.5,bold:true});
      for(const ln of lines){ pdf.text(Mg+16,y,ln,{size:7.5}); y-=10; } y-=4; });
  }
  const nP=pdf.pages.length;
  for(let i=0;i<nP;i++){ pdf.usePage(i);
    pdf.line(Mg,Mg-8,W-Mg,Mg-8);
    pdf.text(Mg,Mg-19,'In-sample diagnostic of realized trades. Not financial advice.',{size:6.5,color:faint});
    pdf.textR(W-Mg,Mg-19,'Page '+(i+1)+' of '+nP,{size:6.5,color:faint});
  }
  return pdf;
}
// Gathers the live Diagnostic tab into a renderDiagPdfDoc model: headline stats from
// computeStats, every visible chart canvas as a JPEG (composited over the theme background
// first — canvases are transparent and JPEG has no alpha), and the recommendation texts.
function exportDiagPdf(){
  const closed=periodTrades(), allv=periodTradesAll();
  if(!closed.length){ setStatus('No closed trades in this view to report on.'); return; }
  const st=computeStats(closed,allv);
  const pf=st.profitFactor===Infinity?'inf':st.profitFactor.toFixed(2);
  const stats=[
    {k:'Net PnL',v:fmtUsd(st.net),sub:st.n+' trades'},
    {k:'Win rate',v:(st.winRate*100).toFixed(1)+'%',sub:st.wins+'W/'+st.losses+'L'},
    {k:'Expectancy / trade',v:fmtUsd(st.expectancy)},
    {k:'Profit factor',v:pf},
    {k:'Max drawdown',v:fmtUsd(st.maxDD)},
    {k:'Sharpe (daily, ann.)',v:st.sharpe!=null?st.sharpe.toFixed(2):'-'},
    {k:'Fees / funding',v:fmtUsd(st.fees)+' / '+fmtUsd(st.fund)},
    {k:'Avg hold',v:fmtDur(st.avgHold)},
  ];
  const bg=getComputedStyle(document.body).backgroundColor||'#101318';
  const charts=[];
  document.querySelectorAll('#diagView canvas').forEach(cv=>{
    if(!cv.width||!cv.height||cv.offsetParent===null)return; // skip hidden cards
    try{
      const off=document.createElement('canvas'); off.width=cv.width; off.height=cv.height;
      const ctx=off.getContext('2d'); ctx.fillStyle=bg; ctx.fillRect(0,0,off.width,off.height);
      ctx.drawImage(cv,0,0);
      const card=cv.closest('.diag-card,.card');
      const h3=card&&card.querySelector('h3,h2');
      const title=(h3?h3.textContent:'Chart').replace(/\s+/g,' ').trim().slice(0,70);
      charts.push({title,img:off.toDataURL('image/jpeg',0.82)});
    }catch(e){}
  });
  const recs=!document.querySelector('#diagView .fnd')
    ?[...document.querySelectorAll('#recsFallback li')].map(li=>li.textContent.replace(/\s+/g,' ').trim()).slice(0,10)
    :[...document.querySelectorAll('#diagView .fnd')].map(c=>{ const q=sel=>{ const e=c.querySelector(sel); return e?e.textContent.replace(/\s+/g,' ').trim():''; };
    return q('.fnd-title')+'. '+q('.fnd-body')+' Do this: '+q('.fnd-do').replace(/^Do this\s*/,''); }).slice(0,10);
  const periodDesc=rangeActive()
    ? 'custom range'+(customRange.from?' from '+fmtDate(customRange.from):'')+(customRange.to?' to '+fmtDate(customRange.to):'')
    : (period===0?'all time':'last '+period+' days');
  const model={ generated:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),
    wallets:settings.wallets.map(w=>({label:w.label||'',address:w.address||''})),
    view, periodDesc, tz:tzLabel(), stats, charts, recs };
  let pdf; try{ pdf=renderDiagPdfDoc(model); }catch(e){ console.error(e); setErr('Could not build the diagnostic PDF ('+e.message+').'); return; }
  const blob=new Blob([pdf.outputBytes()],{type:'application/pdf'});
  dlBlob(blob,'ledger-diagnostic-'+new Date().toISOString().slice(0,10)+'.pdf');
  setStatus('Diagnostic PDF exported ('+(blob.size/1024/1024).toFixed(1)+' MB, '+charts.length+' chart'+(charts.length===1?'':'s')+'). Run the miner / excursions first if you want their charts included.');
}
$('exportTaxPdf').onclick=()=>{
  const model=taxStatementModel(allTrades,settings.wallets);
  if(!model){ setStatus('No closed trades to export.'); return; }
  let doc; try{ doc=renderTaxPdfDoc(model); }catch(e){ console.error(e); setErr('Could not build the PDF ('+e.message+').'); return; }
  const blob=new Blob([doc],{type:'application/pdf'});
  dlBlob(blob,'ledger-statement-'+new Date().toISOString().slice(0,10)+'.pdf');
  setStatus(`Exported statement PDF: ${model.grand.n} realized trades across ${model.years.length} tax year${model.years.length===1?'':'s'}, net ${fmtUsd(model.grand.net)}. Realized PnL only — not tax advice.`);
};
$('exportTax').onclick=()=>{
  // realized (closed) trades across ALL markets/wallets, ignoring view/period filters
  const rows=allTrades.filter(t=>!t.isOpen&&t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  if(!rows.length){ setStatus('No closed trades to export for tax.'); return; }
  const q=v=>{ v=v==null?'':String(v);
    // formula-injection guard: notes/tags open in Excel/Sheets, where a leading = @
    // (or +/- that isn't a number) executes as a formula; real negatives pass untouched
    if(/^[=@]/.test(v)||(/^[+-]/.test(v)&&!isFinite(Number(v))))v="'"+v;
    return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const isoU=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z'); // ISO-8601 UTC, no milliseconds
  const dateU=ms=>new Date(ms).toISOString().slice(0,10);            // YYYY-MM-DD (UTC)
  // ONE rectangular table — no embedded summary or comment lines, so every spreadsheet / tax tool parses it cleanly.
  const head=['tax_year','close_date','open_utc','close_utc','holding_days','market','symbol','direction','realized_pnl','fees','funding','net','wallet_label','wallet_address'];
  const lines=[head.join(',')]; const byYear={};
  for(const t of rows){ const yr=new Date(t.closeTime).getUTCFullYear(); const hold=t.durationMs?(t.durationMs/86400000):0;
    const addr=t.wallet&&t.wallet.address?t.wallet.address:''; const lbl=t.wallet&&t.wallet.label?t.wallet.label:'';
    lines.push([yr,dateU(t.closeTime),isoU(t.openTime),isoU(t.closeTime),hold.toFixed(2),t.market,dcoin(t),t.dir,
      t.pnl.toFixed(2),(-t.fees).toFixed(2),(t.funding||0).toFixed(2),t.net.toFixed(2),lbl,addr].map(q).join(','));
    const b=byYear[yr]||(byYear[yr]={n:0,net:0}); b.n++; b.net+=t.net; }
  const blob=new Blob([lines.join('\r\n')],{type:'text/csv'});
  dlBlob(blob,'ledger-tax-'+new Date().toISOString().slice(0,10)+'.csv');
  const yrs=Object.keys(byYear).sort();
  const summary=yrs.map(y=>`${y}: net ${fmtUsd(byYear[y].net)} (${byYear[y].n} trade${byYear[y].n===1?'':'s'})`).join(' · ');
  setStatus(`Exported ${rows.length} realized trades → ${summary}. Realized PnL only (no unrealized or transferred cost basis) — not tax advice.`);
};
/* ---- tax export by country (presets in engine.js: TAX_PRESETS, taxReport) ---- */
const TAX_UI={preset:null,cur:null,rates:''};
async function taxAllSpotFills(){
  const out=[]; for(const w of settings.wallets){ let c=null; try{ c=await unpackFillCache(await idbGet('flc:'+w.address)); }catch(e){} if(c&&Array.isArray(c.fills))out.push(...c.fills); }
  return out.length?out:(_pastedFills||[]);
}
async function openTaxExport(){
  const tm=$('toolsMenu'); if(tm)tm.open=false;
  const fills=await taxAllSpotFills();
  if(!TAX_UI.rates){ try{ TAX_UI.rates=(await idbGet('taxRates'))||''; }catch(e){} } // a pasted rate table stays on this device
  const perps=allTrades.filter(t=>t.market==='perp'&&!t.isOpen&&t.closeTime);
  const bg=document.createElement('div'); bg.className='modal-bg show'; bg.setAttribute('role','dialog'); bg.setAttribute('aria-modal','true'); bg.setAttribute('aria-label','Tax export by country');
  const saved=settings.taxExport||{};
  TAX_UI.preset=TAX_UI.preset||saved.preset||'us'; TAX_UI.cur=TAX_UI.cur||saved.cur||TAX_PRESETS[TAX_UI.preset].cur;
  bg.innerHTML=`<div class="modal taxbox"><h2>Tax export by country</h2>
    <div class="taxgrid"><div class="field"><label for="taxPreset">Country</label><select id="taxPreset">${Object.entries(TAX_PRESETS).map(([k,p])=>`<option value="${k}"${k===TAX_UI.preset?' selected':''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="taxCur">Report currency</label><input type="text" id="taxCur" maxlength="3" value="${esc(TAX_UI.cur)}" style="text-transform:uppercase"></div></div>
    <div class="field" id="taxRatesF"><label for="taxRates">Daily rates — one line each: <code>YYYY-MM-DD,rate</code> (units of your currency per 1 USD)</label>
      <textarea id="taxRates" placeholder="2025-01-02,0.7998&#10;2025-01-03,0.8041&#10;…" spellcheck="false">${esc(TAX_UI.rates)}</textarea>
      <p class="mini-note">From your central bank or tax authority (e.g. the ECB, Bank of England, RBA, Bank of Canada). Each fill uses the rate on its own date, or the latest within a week before it. Kept on this device only.</p></div>
    <p class="lead" id="taxNote"></p>
    <div id="taxPreview"></div>
    <div class="modal-actions"><button class="btn ghost" data-tax="close">Close</button><button class="btn ghost" data-tax="perps">Perp P&amp;L CSV</button><button class="btn" data-tax="spot">Spot disposals CSV</button></div>
    <h3 class="taxsw-h">For tax software: Koinly or CoinTracker</h3>
    <div class="field"><label for="taxSwYear">Period</label><select id="taxSwYear"></select></div>
    <div class="field hide" id="taxSwDates"><label for="taxSwFrom">From and to (UTC dates)</label><div style="display:flex;gap:6px;flex-wrap:wrap"><input type="date" id="taxSwFrom" style="flex:1;min-width:130px"><input type="date" id="taxSwTo" aria-label="To (UTC date)" style="flex:1;min-width:130px"></div></div>
    <p class="mini-note"><b>Koinly:</b> add a wallet for this exchange, choose to import from a file, and upload the Koinly file (Koinly's universal format). <b>CoinTracker:</b> add a wallet, choose to import a CSV in the CoinTracker format, and upload the CoinTracker file. Spot fills are trades; each closed perp's realised P&amp;L is a margin gain or loss (Koinly: “realized gain”) with its fees, and its funding a row of its own; deposits and withdrawals are transfers. Amounts stay in the coins traded (both tools price them in your currency), times are UTC. Import your whole history once so spot buys carry their cost; pick a tax year to add just that year later.</p>
    <div class="modal-actions"><button class="btn ghost" data-tax="koinly">Koinly CSV</button><button class="btn ghost" data-tax="cointracker">CoinTracker CSV</button></div></div>`;
  document.body.appendChild(bg);
  let rep=null, fx=null;
  const sw={fills,trades:allTrades,flows:ledFlows,nameByCoin:spotMaps.nameByCoin,quoteByCoin:spotMaps.quoteByCoin}, swT=taxToolRows('koinly',sw).times;
  const q=v=>{ v=v==null?'':String(v); if(/^[=@]/.test(v)||(/^[+-]/.test(v)&&!isFinite(Number(v))))v="'"+v; return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const day=ms=>ms==null?'':new Date(ms).toISOString().slice(0,10);
  const money=(v,c)=>(v<0?'-':'')+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+c;
  const refresh=()=>{
    const key=$('taxPreset').value, cur=($('taxCur').value||'USD').trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)||'USD';
    TAX_UI.preset=key; TAX_UI.cur=cur; TAX_UI.rates=$('taxRates').value;
    $('taxRatesF').classList.toggle('hide',cur==='USD');
    const ys=$('taxSwYear'), was=ys.value, yk=(TAX_PRESETS[key]||TAX_PRESETS.other).year, labs=[...new Set(swT.map(t=>taxYearLabel(t,yk)))].sort().reverse();
    ys.innerHTML=[['all','All history'],...labs.map(l=>[l,'Tax year '+l]),['dates','Dates…']].map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('');
    ys.value=[...ys.options].some(o=>o.value===was)?was:'all'; $('taxSwDates').classList.toggle('hide',ys.value!=='dates');
    const tbl=cur==='USD'?fxFromTable(''):fxFromTable(TAX_UI.rates);
    fx=tbl.fx; rep=taxReport(fills,spotMaps.nameByCoin,key,fx);
    const pm=perps.filter(t=>!(fx(t.closeTime)>0)).length;
    const P=rep.preset;
    $('taxNote').innerHTML=esc(P.note)+' <b>Not tax advice</b> — confirm with your adviser.';
    const warn=[];
    if(cur!=='USD'&&!tbl.n)warn.push('Paste a rate table to convert into '+esc(cur)+'.');
    else if(rep.missingFx||pm)warn.push(`${rep.missingFx+pm} fill${rep.missingFx+pm===1?'':'s'}/trades have no ${esc(cur)} rate within a week — extend the table to cover ${tbl.first?day(tbl.first)+' … '+day(tbl.last)+' and beyond':'every trading date'}.`);
    if(rep.unknown)warn.push(`${rep.unknown} disposal${rep.unknown===1?'':'s'} sold more than was bought on the exchange (transfers or airdrops in): zero cost assumed and flagged “unknown basis”.`);
    if(cur!==P.cur&&P.cur!=='USD')warn.push(esc(P.name)+' reports in '+P.cur+'.');
    const blocked=cur!=='USD'&&(!tbl.n||rep.missingFx>0||pm>0);
    bg.querySelectorAll('[data-tax="spot"],[data-tax="perps"]').forEach(b=>b.disabled=blocked);
    const perpY={}; if(!blocked)for(const t of perps){ const y=taxYearLabel(t.closeTime,P.year), r=fx(t.closeTime); perpY[y]=(perpY[y]||0)+t.net*r; }
    const yrs=[...new Set([...rep.years.map(y=>y.year),...Object.keys(perpY)])].sort();
    $('taxPreview').innerHTML=(warn.length?`<div class="taxwarn">${warn.map(w=>`<p>${w}</p>`).join('')}</div>`:'')
      +(yrs.length&&!blocked?`<div class="tbl-wrap"><table class="taxtbl"><thead><tr><th class="l">Tax year</th><th>Spot disposals</th><th>Proceeds</th><th>Costs</th><th>Gains</th><th>Losses</th><th>Net spot</th>${key==='de'?'<th>of which tax-free</th>':''}<th>Perp net</th></tr></thead><tbody>${yrs.map(y=>{ const r=rep.years.find(x=>x.year===y)||{n:0,proceeds:0,cost:0,gains:0,losses:0,net:0,exempt:0};
        return `<tr><td class="l">${esc(y)}</td><td>${r.n}${r.flagged?` <span class="badge mid" data-tip="Rows with a flag (see the CSV)">${r.flagged} flagged</span>`:''}</td><td>${money(r.proceeds,cur)}</td><td>${money(r.cost,cur)}</td><td class="pos-t">${money(r.gains,cur)}</td><td class="neg-t">${money(r.losses,cur)}</td><td class="${cls(r.net)}">${money(r.net,cur)}</td>${key==='de'?`<td>${money(r.exempt,cur)}</td>`:''}<td class="${cls(perpY[y]||0)}">${money(perpY[y]||0,cur)}</td></tr>`; }).join('')}</tbody></table></div>`:blocked?'':'<p class="lead">No realized spot disposals or closed perp trades in the loaded history.</p>');
    try{ settings.taxExport={preset:key,cur}; Store.set(S_KEY,settings); idbSet('taxRates',TAX_UI.rates); }catch(e){}
  };
  refresh();
  const close=()=>{ bg.remove(); document.removeEventListener('keydown',onKey); };
  const onKey=e=>{ if(e.key==='Escape')close(); }; document.addEventListener('keydown',onKey);
  $('taxPreset').addEventListener('change',()=>{ $('taxCur').value=TAX_PRESETS[$('taxPreset').value].cur; refresh(); });
  $('taxSwYear').addEventListener('change',()=>$('taxSwDates').classList.toggle('hide',$('taxSwYear').value!=='dates'));
  $('taxCur').addEventListener('input',refresh); $('taxRates').addEventListener('input',()=>{ clearTimeout(TAX_UI.t); TAX_UI.t=setTimeout(refresh,250); });
  bg.addEventListener('click',e=>{ const b=e.target.closest('[data-tax]'); if(!b){ if(e.target===bg)close(); return; }
    const a=b.dataset.tax, cur=TAX_UI.cur, P=rep.preset, stamp=new Date().toISOString().slice(0,10);
    if(a==='close')return close();
    if(a==='koinly'||a==='cointracker'){ const y=$('taxSwYear').value, d=id=>{ const v=$(id).value; return v?Date.parse(v+'T00:00:00Z'):null; };
      const [from,to]=y==='all'?[null,null]:y==='dates'?[d('taxSwFrom'),d('taxSwTo')!=null?d('taxSwTo')+86400000:null]:taxYearBounds(y,P.year);
      const csv=taxToolCsv(a,Object.assign({},sw,{from,to})), n=csv.split('\r\n').length-1, name=a==='koinly'?'Koinly':'CoinTracker';
      if(!n){ setStatus('Nothing to export for '+name+' in that period.'); return; }
      dlBlob(new Blob([csv],{type:'text/csv'}),'ledger-'+a+'-'+(y==='dates'?'range':y.replace(/[^A-Za-z0-9-]/g,'-'))+'-'+stamp+'.csv');
      setStatus(`Exported ${n} rows for ${name} (${y==='all'?'all history':y==='dates'?'your dates':'tax year '+y}). Not tax advice.`); return; }
    if(a==='spot'){ if(!rep.rows.length){ setStatus('No spot disposals to export.'); return; }
      const head=['tax_year','asset','quantity','date_acquired','date_disposed','proceeds_'+cur,'cost_'+cur,'gain_'+cur,'matching_rule','flag'];
      const lines=[head.join(',')].concat(rep.rows.map(r=>[r.year,r.symbol,r.qty.toFixed(8),day(r.acquired),day(r.disposed),r.proceeds.toFixed(2),r.cost.toFixed(2),r.gain.toFixed(2),r.rule,r.flag].map(q).join(',')));
      dlBlob(new Blob([lines.join('\r\n')],{type:'text/csv'}),'ledger-tax-'+TAX_UI.preset+'-spot-'+stamp+'.csv');
      setStatus(`Exported ${rep.rows.length} spot disposals (${P.name}, ${cur}). Not tax advice.`); }
    if(a==='perps'){ if(!perps.length){ setStatus('No closed perp trades to export.'); return; }
      const head=['tax_year','close_date','open_time_utc','close_time_utc','market','asset','direction','realized_pnl_'+cur,'fees_'+cur,'funding_'+cur,'net_'+cur,'usd_rate'];
      const iso=ms=>new Date(ms).toISOString().replace('T',' ').slice(0,19);
      const lines=[head.join(',')].concat([...perps].sort((x,y)=>x.closeTime-y.closeTime).map(t=>{ const r=fx(t.closeTime);
        return [taxYearLabel(t.closeTime,P.year),day(t.closeTime),iso(t.openTime),iso(t.closeTime),'perp',dcoin(t),t.dir,(t.pnl*r).toFixed(2),(-t.fees*r).toFixed(2),((t.funding||0)*r).toFixed(2),(t.net*r).toFixed(2),r].map(q).join(','); }));
      dlBlob(new Blob([lines.join('\r\n')],{type:'text/csv'}),'ledger-tax-'+TAX_UI.preset+'-perps-'+stamp+'.csv');
      setStatus(`Exported ${perps.length} closed perp trades (${P.name} tax years, ${cur}). Not tax advice.`); }
  });
}
$('exportTaxCountry').onclick=()=>{ openTaxExport().catch(e=>setErr('Tax export failed: '+e.message)); };
$('exportSpotLots').onclick=async()=>{
  // FIFO lot rows are built straight from the cached raw fills (not the reconstructed
  // trades), because lots need the individual buy/sell legs, not netted round-trips.
  if(!settings.wallets.length){ setStatus('Add a wallet and Load all first \u2014 lots are built from the cached fills.'); return; }
  const q=v=>{ v=v==null?'':String(v);
    // formula-injection guard: notes/tags open in Excel/Sheets, where a leading = @
    // (or +/- that isn't a number) executes as a formula; real negatives pass untouched
    if(/^[=@]/.test(v)||(/^[+-]/.test(v)&&!isFinite(Number(v))))v="'"+v;
    return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const dateU=ms=>ms==null?'':new Date(ms).toISOString().slice(0,10);
  const head=['tax_year','symbol','quantity','date_acquired','date_disposed','proceeds','cost_basis','gain','term','basis_note','wallet_label','wallet_address'];
  const lines=[head.join(',')];
  let totalRows=0, unknown=0, openLots=0; const byYear={};
  for(const w of settings.wallets){
    let cache=null; try{ cache=await unpackFillCache(await idbGet('flc:'+w.address)); }catch(e){}
    if(!cache||!Array.isArray(cache.fills))continue;
    const m=spotFifoLots(cache.fills, spotMaps.nameByCoin);
    for(const r of m.rows){
      const yr=new Date(r.disposed).getUTCFullYear();
      lines.push([yr,r.symbol,r.qty.toFixed(8),dateU(r.acquired),dateU(r.disposed),
        r.proceeds.toFixed(2),r.basis.toFixed(2),r.gain.toFixed(2),r.term,
        r.unknownBasis?'UNKNOWN BASIS \u2014 acquired off-exchange (transfer/airdrop); zero-cost assumed':'',
        w.label||'',w.address].map(q).join(','));
      const b=byYear[yr]=byYear[yr]||{n:0,gain:0}; b.n++; b.gain+=r.gain;
      totalRows++; if(r.unknownBasis)unknown++;
    }
    openLots+=m.open.length;
  }
  if(!totalRows){ setStatus('No spot disposals found in the cached fills. If you have traded spot, hit Load all first (Shift-click for a full re-fetch).'); return; }
  const blob=new Blob([lines.join('\r\n')],{type:'text/csv'});
  dlBlob(blob,'ledger-spot-lots-'+new Date().toISOString().slice(0,10)+'.csv');
  const yrs=Object.keys(byYear).sort();
  const summary=yrs.map(y=>`${y}: ${byYear[y].n} lot${byYear[y].n===1?'':'s'}, gain ${fmtUsd(byYear[y].gain)}`).join(' \u00b7 ');
  setStatus(`Exported ${totalRows} FIFO lot rows \u2192 ${summary}${unknown?` \u00b7 \u26a0 ${unknown} row${unknown===1?'':'s'} with UNKNOWN basis (tokens acquired off-exchange, zero cost assumed \u2014 your accountant must resolve these)`:''}${openLots?` \u00b7 ${openLots} lot${openLots===1?'':'s'} still open (not in the file)`:''}. FIFO, from cached fills \u2014 not tax advice.`);
};
$('exportJ').onclick=()=>{ const blob=new Blob([JSON.stringify(journal,null,2)],{type:'application/json'});
  dlBlob(blob,'hl-journal-'+new Date().toISOString().slice(0,10)+'.json'); };
// Full backup = snapshot (journal + wallets + settings) + per-wallet fill caches.
// Caches make the backup restorable past the API's 60-page history cap, and are
// deliberately NOT in the auto-synced linked file (they'd bloat every debounced write).
// Shared by the download button and the server-backup button.
async function buildBackupData(){
  const data={...snapshot(),version:9,fillCaches:{}};
  for(const w of settings.wallets){ try{ const c=await unpackFillCache(await idbGet('flc:'+w.address));
    if(validFillCache(w.address,c)) data.fillCaches[w.address]=c; }catch(e){} }
  try{ const p=await idbGet('excRows'); if(p&&p.v===1&&p.rows)data.excRows=p; }catch(e){}
  return data;
}
$('backupAll').onclick=async()=>{
  const data=await buildBackupData();
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  dlBlob(blob,'ledger-backup-'+new Date().toISOString().slice(0,10)+'.json');
  const nc=Object.keys(data.fillCaches).length;
  setStatus('Backup exported ('+(blob.size/1024/1024).toFixed(1)+' MB)'+(nc?' incl. fill cache for '+nc+' wallet'+(nc===1?'':'s')+' — restoring it preserves history beyond the 60-page API cap':'')+'.'); };
$('backupSrv').onclick=async()=>{
  if(!SRV.enabled){ setErr('No sync server detected.'); return; }
  setStatus('Building backup…');
  try{
    const data=await buildBackupData();
    const r=await srvFetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||('HTTP '+r.status)); }
    const j=await r.json();
    setStatus('Backup stored on the server as '+j.name+' (newest 10 kept).');
  }catch(e){ setErr('Server backup failed: '+e.message); }
};
$('clearCandles').onclick=async()=>{
  const keys=await idbKeys('cnd:');
  if(!keys.length){ setStatus('Candle cache is empty.'); return; }
  let bytes=0; for(const k of keys){ try{ const v=await idbGet(k); bytes+=JSON.stringify(v||'').length; }catch(e){} }
  for(const k of keys)await idbDel(k);
  _excCache={key:null,rows:null,skippedCoins:null,skippedN:0};
  setStatus('Cleared '+keys.length+' cached candle set'+(keys.length===1?'':'s')+' ('+(bytes/1024/1024).toFixed(1)+' MB). Candles re-fetch on the next run; saved MAE/MFE measurements are kept.'); };

/* ============================ fee-tier optimizer ============================ */
// Hyperliquid perp fees step by trailing-14-day volume. This table is the BASE schedule
// (no staking discounts, no referral rebates) — VERIFY against app.hyperliquid.xyz/fees
// before trusting the dollar figures; last checked September 2026. Rates are decimals.
const FEE_TIERS=[ // Hyperliquid's base schedule (no staking discount): perps, and spot's own rates
  {min:0,    taker:0.00045, maker:0.00015, spotTaker:0.0007,  spotMaker:0.0004},
  {min:5e6,  taker:0.00040, maker:0.00012, spotTaker:0.0006,  spotMaker:0.0003},
  {min:25e6, taker:0.00035, maker:0.00008, spotTaker:0.0005,  spotMaker:0.0002},
  {min:100e6,taker:0.00030, maker:0.00004, spotTaker:0.0004,  spotMaker:0.0001},
  {min:500e6,taker:0.00028, maker:0,       spotTaker:0.00035, spotMaker:0},
  {min:2e9,  taker:0.00026, maker:0,       spotTaker:0.0003,  spotMaker:0},
  {min:7e9,  taker:0.00024, maker:0,       spotTaker:0.00025, spotMaker:0},
];
// Rolling volume from the per-fill events each reconstructed trade carries ([time,px,sz,k]),
// so the 14-day window is exact even when a trade spans it. The "what would last month have
// cost" answers use the recorded maker/taker split. Pure; null when there is no flow at all.
function feeTierModel(trades, now){
  now=now||Date.now();
  const cut14=now-14*86400000, cut30=now-30*86400000;
  // Hyperliquid's tier volume: perps + 2 × spot ("spot volume counts double toward your fee tier")
  let vol14=0, perp14=0, spot14=0, fees30=0, takerN30=0, makerN30=0, unk30=0, spotTakerN30=0;
  for(const t of (trades||[])){ const spot=t.market==='spot';
    for(const ev of (t.events||[])){ const n=Math.abs((ev[1]||0)*(ev[2]||0)); if(ev[0]>=cut14&&ev[0]<=now){ if(spot)spot14+=n; else perp14+=n; } }
    const last=t.closeTime||t.openTime;
    if(last>=cut30&&last<=now){ fees30+=t.fees||0; takerN30+=t.takerNotional||0; makerN30+=t.makerNotional||0; unk30+=t.unkNotional||0; if(spot)spotTakerN30+=t.takerNotional||0; }
  }
  vol14=perp14+2*spot14;
  if(!(vol14>0)&&!(takerN30+makerN30+unk30>0))return null;
  let tier=0; for(let i=0;i<FEE_TIERS.length;i++)if(vol14>=FEE_TIERS[i].min)tier=i;
  const cur=FEE_TIERS[tier], next=FEE_TIERS[tier+1]||null, perpTakerN30=takerN30-spotTakerN30;
  // taker flow priced at its own market's rate: spot fees are higher than perps at every tier
  const at=(T,k)=>perpTakerN30*T[k]+spotTakerN30*T[k==='taker'?'spotTaker':'spotMaker'];
  const takerFee30=at(cur,'taker');
  return {vol14, perp14, spot14, tier, cur, next, toNext:next?Math.max(0,next.min-vol14):null,
    takerN30, makerN30, unk30, fees30, takerFee30,
    saveAsMaker30:takerFee30-at(cur,'maker'),
    saveNextTier30:next?takerFee30-at(next,'taker'):null};
}

/* ============================ weekly review wizard + lessons ============================ */
// ISO week key ('week:GGGG-Www') from the tz-toggle calendar date — rides the existing
// journal plumbing (sync, backup, conflict merge) exactly like the 'day:' entries.
function isoWeekKey(ms){
  const p=tzParts(ms);
  const d=new Date(Date.UTC(p.y,p.mo,p.day));
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)+3);      // this week's Thursday fixes the ISO year
  const ft=new Date(Date.UTC(d.getUTCFullYear(),0,4));
  ft.setUTCDate(ft.getUTCDate()-((ft.getUTCDay()+6)%7)+3);   // first ISO week's Thursday
  const week=1+Math.round((d-ft)/(7*86400000));
  return 'week:'+d.getUTCFullYear()+'-W'+String(week).padStart(2,'0');
}
// Monday's midnight from the calendar fields, like addDays: stepping back dow×24h crossed the 25-hour
// day at a clock change (Sunday 23:30 after the fall-back read last Tuesday as "this Monday")
function lastCompletedWeekRange(now){
  now=now||Date.now();
  const p=tzParts(now);
  const dow=(new Date(Date.UTC(p.y,p.mo,p.day)).getUTCDay()+6)%7; // Mon=0 on the tz calendar
  const at=d=>settings.tz==='utc'?Date.UTC(p.y,p.mo,d):tzMidnight(new Date(p.y,p.mo,d,12).getTime()); // noon, then its midnight: a day whose midnight is skipped starts at 01:00
  return {from:at(p.day-dow-7), to:at(p.day-dow)};
}
function weeklyReviewSectionHtml(){
  const {from,to}=lastCompletedWeekRange();
  const wkKey=isoWeekKey(from+3.5*86400000);
  const e=journal[wkKey]||{};
  const closed=allTrades.filter(t=>!t.isOpen&&t.closeTime>=from&&t.closeTime<to&&viewFilter(t));
  const net=closed.reduce((s,t)=>s+t.net,0);
  const sorted=[...closed].sort((a,b)=>b.net-a.net);
  const best=sorted[0], worst=sorted[sorted.length-1];
  const tl=t=>t?`<b>${esc(dispMarket(dcoin(t)))}</b> ${t.dir} · <span class="${cls(t.net)}">${fmtUsd(t.net)}</span>`:'—';
  const lessons=Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].lesson)
    .sort().reverse().map(k=>({k,e:journal[k]}));
  const lrows=lessons.slice(0,12).map(x=>`<div class="metric-row"><span class="ml">${esc(x.k.slice(5))}</span><span class="mv" style="max-width:70%;text-align:right;white-space:normal;font-weight:400">${esc(x.e.lesson)}</span></div>`).join('');
  return `<div class="diag-section"><h2>Weekly review <span style="font-size:11px;color:var(--faint);font-weight:400">${esc(wkKey.slice(5))} · last completed week</span></h2>
    <div class="diag-grid">
      <div class="diag-card" data-draft-scope="${esc(wkKey)}"><h3 data-tip="Three questions, once a week, about the week that just ended. The digest automates the numbers; this automates the learning — every answer feeds the lessons library.">Guided review — ${closed.length} trade${closed.length===1?'':'s'}, net <span class="${cls(net)}">${fmtUsd(net)}</span></h3>
        ${lastWeekFocusHtml(from)}
        <div class="metric-row"><span class="ml">Best trade</span><span class="mv">${tl(best)}</span></div>
        <div class="metric-row"><span class="ml">Worst trade</span><span class="mv">${tl(worst)}</span></div>
        <div class="field" style="margin-top:8px"><label>What worked — worth repeating?</label><textarea id="wrRepeat" placeholder="setups, conditions, behaviors that paid">${esc(e.repeat||'')}</textarea></div>
        <div class="field"><label>What didn't — what changes next week?</label><textarea id="wrChange" placeholder="the leak you'll plug">${esc(e.change||'')}</textarea></div>
        <div class="field"><label>One-line lesson</label><input type="text" id="wrLesson" maxlength="160" value="${esc(e.lesson||'')}" placeholder="the sentence future-you should re-read"></div>
        <div><button class="btn ghost" id="wrSave">Save week</button> <span id="wrSaved" style="color:var(--faint);font-size:11px"></span></div>
      </div>
      <div class="diag-card"><h3 data-tip="Every one-line lesson from your saved weekly reviews, newest first. Rereading these before a session is the cheapest edge available.">Lessons library</h3>
        ${lessons.length?`<p class="lead" style="margin-bottom:8px">Latest: <b>${esc(lessons[0].e.lesson)}</b></p>`:''}
        ${lrows||'<p class="lead">No lessons saved yet. Answer the three questions and the library builds itself.</p>'}
      </div>
    </div><div id="coachLetter" style="margin-top:14px"></div></div>`;
}
// Last week's focus habit, how often it was kept, and a one-click carry-over to this week.
function lastWeekFocusHtml(from){
  if(!coachOn())return '';
  const e=journal[isoWeekKey(from+3.5*86400000)]; const h=e&&e.focus&&habitById(e.focus); if(!h||h.retired)return '';
  let p={total:0,kept:0,res:[]}; try{ const ctx=coachContext(); const all=habitProgress(h,ctx,from);
    const toK=dayKey(lastCompletedWeekRange().to); p.res=all.res.filter(r=>r.key<toK); Object.assign(p,habitSummary(p.res)); }catch(err){}
  const cur=weekFocus();
  return `<div class="focus-recap"><div class="focus-k">Last week\u2019s focus</div><div class="focus-sent">${esc(habitSentence(h))}</div>
    <div class="focus-prog">${p.total?`${dotsHtml(p.res)} kept on ${p.kept} of ${p.total} trading day${p.total===1?'':'s'}`:'No trading days that week.'}
    ${cur===h.id?'<span class="fnd-adopted" style="margin-left:8px">\u2713 still this week\u2019s focus</span>':`<button class="btn ghost" id="wrKeepFocus" data-id="${esc(h.id)}" style="margin-left:8px">Keep it this week</button>`}</div></div>`;
}
function wireWeeklyReview(){
  const kf=$('wrKeepFocus'); if(kf)kf.onclick=async()=>{ await setWeekFocus(kf.dataset.id); renderReview(); renderCoach(); };
  const b=$('wrSave'); if(!b)return;
  b.onclick=()=>{
    const {from}=lastCompletedWeekRange();
    const wkKey=isoWeekKey(from+3.5*86400000);
    const e={repeat:$('wrRepeat').value.trim(), change:$('wrChange').value.trim(), lesson:$('wrLesson').value.trim()};
    const prev=journal[wkKey]||{};
    if(!(e.repeat||e.change||e.lesson||prev.focus)) delete journal[wkKey];
    else journal[wkKey]={...prev,...e,updatedAt:Date.now()}; // keeps that week's focus habit
    markJEdit(wkKey); Store.set(J_KEY,journal);
    const s=$('wrSaved'); if(s){ s.textContent='saved'; setTimeout(()=>{ s.textContent=''; },1400); }
    renderReview(); // the lessons library updates in place
  };
}

/* ============================ variance expectations ============================ */
// From YOUR OWN win rate, frequency, and net distribution (seeded MC): how likely a given
// loss streak is over the next 200 trades, and what a 1-in-20 bad month looks like at
// current sizing. Deciding NOW what normal-bad looks like is the single best antidote to
// abandoning an edge mid-drawdown — live pain then reads as variance, not falsification.
function varianceModel(closed, opts){
  opts=opts||{};
  const dec=(closed||[]).filter(t=>isWin(t.net)||isLoss(t.net));
  if(!closed||closed.length<20||dec.length<10)return null;
  const p=dec.filter(t=>isWin(t.net)).length/dec.length;
  const nets=closed.map(t=>t.net);
  const times=closed.map(t=>t.closeTime);
  const span=Math.max(1,(Math.max(...times)-Math.min(...times))/86400000);
  const perMonth=Math.max(1,Math.round(closed.length/span*30.44));
  const N=opts.horizon||200, SIM=opts.sims||2000, MAXL=10;
  _srand(_hashSeed(opts.seed||('variance|'+closed.length+'|'+dec.length)));
  const hit=new Array(MAXL+1).fill(0);
  for(let s=0;s<SIM;s++){
    let run=0,best=0;
    for(let i=0;i<N;i++){ if(_rng()>=p){ run++; if(run>best)best=run; } else run=0; }
    for(let L=1;L<=MAXL;L++)if(best>=L)hit[L]++;
  }
  const streaks=[]; for(let L=3;L<=MAXL;L++){ const pr=hit[L]/SIM; if(pr>=0.01)streaks.push({len:L,prob:pr}); }
  const months=[];
  for(let s=0;s<1000;s++){ let m=0; for(let i=0;i<perMonth;i++)m+=nets[Math.floor(_rng()*nets.length)]; months.push(m); }
  months.sort((a,b)=>a-b);
  const q=x=>months[Math.min(months.length-1,Math.floor(x*months.length))];
  return {p, n:closed.length, perMonth, horizon:N, streaks, monthP5:q(0.05), monthP25:q(0.25), monthMed:q(0.5)};
}

/* ============================ risk-creep detector ============================ */
// Median entry notional of the last 20 trades vs the 20 before, compared with how much
// capital actually changed over the same stretch. Sizing that outruns equity is the
// classic post-win-streak failure. Pure; needs 40 closed trades.
function riskCreepModel(closed, acctNow){
  const chron=(closed||[]).filter(t=>!t.isOpen&&t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  if(chron.length<40)return null;
  const notional=t=>(t.maxSize||0)*(t.avgEntry||0);
  const last=chron.slice(-20), prior=chron.slice(-40,-20);
  const m2=nfMedian(last.map(notional)), m1=nfMedian(prior.map(notional));
  if(!(m1>0)||!(m2>0))return null;
  const sizeGrowth=m2/m1-1;
  let eqGrowth=null;
  if(acctNow>0){
    const netSince=last.reduce((s,t)=>s+t.net,0); // realized change over the last-20 stretch
    const acctThen=acctNow-netSince;
    if(acctThen>0)eqGrowth=acctNow/acctThen-1;
  }
  // creep = sizing clearly up AND clearly ahead of capital (or way up with no equity data)
  const creep=sizeGrowth>0.25&&(eqGrowth==null?sizeGrowth>0.5:sizeGrowth>eqGrowth+0.25);
  return {m1, m2, sizeGrowth, eqGrowth, creep};
}

/* ============================ unplanned-trading guardrail ============================ */
// The day journal knows whether today has a plan; the tape knows whether you're trading.
// Pure given the journal object; today = tz-toggle day, opens and closes both count.
function unplannedToday(trades, journalObj, now){
  now=now||Date.now();
  const d0=tzMidnight(now);
  let n=0;
  for(const t of (trades||[])){
    if(t.isOpen){ if(t.openTime>=d0)n++; }
    else if(t.closeTime>=d0)n++;
  }
  const dj=(journalObj||{})[dayJKey(now)];
  const hasPlan=!!(dj&&(dj.plan||dj.bias||dj.maxLoss>0));
  return {n, hasPlan, unplanned:n>=2&&!hasPlan};
}

/* ============================ demo mode ============================ */
// Seeded synthetic history so a fresh visitor (or a screenshot) sees every panel populated
// without pasting a wallet: ~5 months of perp round trips across four coins (52% win rate,
// fat left tail, mild size-follows-wins creep) plus PURR/USDC spot accumulation with a
// partial take-profit. Deterministic per seed, and it goes through the exact paste-import
// path — nothing about the pipeline is special-cased. Rows use the exchange fill schema.
function demoFills(seed, now){
  now=now||Date.now();
  _srand(_hashSeed('demo|'+(seed==null?1:seed)));
  const R=()=>_rng();
  const DAY=86400000, H=3600000;
  const coins=[{c:'ETH',px:2600},{c:'BTC',px:64000},{c:'SOL',px:150},{c:'DOGE',px:0.12}];
  const out=[]; let tid=1;
  const F=(coin,side,sz,px,time,sp,pnl,fee,crossed)=>out.push({coin,side,
    sz:String(+sz.toFixed(5)), px:String(+px.toFixed(8)), time:Math.round(time),
    startPosition:String(+sp.toFixed(5)), closedPnl:String(+pnl.toFixed(2)),
    fee:String(+fee.toFixed(4)), crossed, dir:'', tid:tid++, oid:9000+tid});
  let size=1;
  const free={}; // per-coin next-free time — overlapping same-coin round trips would read as adds
  for(let day=150;day>=1;day--){
    const t0=now-day*DAY;
    const dow=new Date(t0).getUTCDay();
    if(R()<(dow===0||dow===6?0.75:0.35)){continue;}
    const nTr=R()<0.3?2:1;
    for(let i=0;i<nTr;i++){
      const A=coins[Math.floor(R()*coins.length)];
      let open=t0+(7+R()*11)*H;
      if(free[A.c]&&open<free[A.c])open=free[A.c]+H;
      const hold=(0.4+R()*(R()<0.85?7:30))*H;
      const close=open+hold;
      if(close>now-2*H)continue;
      const px0=A.px*(1+(R()-0.5)*0.24);
      const long=R()<0.58;
      const notional=(3000+R()*9000)*size;
      const sz=notional/px0;
      const win=R()<0.52;
      // decisive moves (0.4–4.5% of notional) so the default $50 break-even band doesn't
      // turn the whole demo into scratches; ~15% of losses draw the fat left tail
      const gross=win?notional*(0.005+R()*0.04):-notional*(0.004+R()*(R()<0.15?0.09:0.03));
      const px1=px0+(long?1:-1)*gross/sz;
      const maker=R()<0.3, feeR=maker?0.00015:0.00045;
      F(A.c, long?'B':'A', sz, px0, open, 0, 0, notional*feeR, !maker);
      F(A.c, long?'A':'B', sz, px1, close, long?sz:-sz, gross, Math.abs(px1*sz)*feeR, !maker);
      free[A.c]=close;
      size*=win?1.004:0.999;
    }
  }
  // spot: four PURR buys, one partial sale near the end
  let bag=0, cost=0;
  for(let k=0;k<4;k++){
    const px=0.14+R()*0.1, sz=3000+R()*3000;
    F('PURR/USDC','B',sz,px,now-(130-k*25)*DAY+10*H,bag,0,sz*px*0.0004,true);
    bag+=sz; cost+=sz*px;
  }
  const sellSz=bag*0.4, sellPx=(cost/bag)*1.35;
  F('PURR/USDC','A',sellSz,sellPx,now-9*DAY+15*H,bag,(sellPx-cost/bag)*sellSz,sellSz*sellPx*0.0004,true);
  out.sort((a,b)=>a.time-b.time);
  return out;
}
let _demoData=false; // sample data was loaded (and no real wallet's trades have replaced it: sample trades carry no address)
function isDemoData(){ return _demoData&&!((typeof allTrades!=='undefined'&&allTrades)||[]).some(t=>t&&t.wallet&&t.wallet.address&&t.wallet.address!=='paste'); } // pasted (and sample) trades say 'paste'
async function loadDemo(){
  setStatus('Generating sample data…',true);
  try{ await loadFromPaste(demoFills(1),{offline:true}); _demoData=true; }
  catch(e){ setErr('Demo generation failed: '+e.message); return; }
  setStatus('Sample data loaded — '+allTrades.length+' synthetic trades across perps and spot. Nothing was fetched or saved to a wallet; add a real address whenever you like.');
}
(function(){ for(const id of ['demoBtn','demoBtn2']){ const b=$(id); if(b)b.onclick=loadDemo; } })();
// Sample candles. The sample fills are made up, so real exchange candles can never line up with them:
// in sample mode every chart and excursion reads a price path drawn here instead. One deterministic
// path per coin that passes through every one of its fills (log-linear between fills, with layered
// value noise that fades out near each fill), so any interval and any range agree with each other.
const _demoAnchors=new Map();
function demoAnchorsFor(coin){
  const tr=(typeof allTrades!=='undefined'?allTrades:[]).filter(t=>t.coin===coin), sig=tr.length+'|'+tr.reduce((a,t)=>a+(t.events||[]).length,0);
  const c=_demoAnchors.get(coin); if(c&&c.sig===sig)return c.pts;
  const pts=[]; for(const t of tr)for(const e of (t.events||[]))if(e[1]>0)pts.push([e[0],e[1]]);
  pts.sort((a,b)=>a[0]-b[0]); _demoAnchors.set(coin,{sig,pts}); return pts;
}
const _demoHash=(coin,oct,i)=>_hashSeed('dc|'+coin+'|'+oct+'|'+i)/4294967296;
function demoNoise(coin,ms){ // -1..1, smooth, with the slow swings of a real tape
  const OCT=[[86400e3,1],[14400e3,.6],[3600e3,.45],[900e3,.3],[300e3,.18],[90e3,.1]]; let v=0, w=0;
  for(let o=0;o<OCT.length;o++){ const [P,A]=OCT[o], x=ms/P, i=Math.floor(x), u=x-i, s=u*u*(3-2*u);
    v+=A*((1-s)*_demoHash(coin,o,i)+s*_demoHash(coin,o,i+1)); w+=A; }
  return (v/w)*2-1;
}
function demoPrice(coin,ms){
  const P=demoAnchorsFor(coin), FADE=20*60e3; if(!P.length)return null; // the noise fades out only in the last 20 minutes to a fill
  let lo=0, hi=P.length; while(lo<hi){ const m=(lo+hi)>>1; if(P[m][0]<=ms)lo=m+1; else hi=m; }
  const A=P[lo-1]||null, B=P[lo]||null; let base, dist;
  if(A&&B){ const u=(ms-A[0])/Math.max(1,B[0]-A[0]); base=A[1]*Math.pow(B[1]/A[1],u); dist=Math.min(ms-A[0],B[0]-ms); }
  else { const N=A||B; base=N[1]; dist=Math.abs(ms-N[0]); }
  return base*(1+Math.min(1,dist/FADE)*0.03*demoNoise(coin,ms));
}
// the same shape venueFetchCandles returns: rows [t, high, low, close, open], and coverage to b
function demoCandles(coin,itvName,a,b){
  const ms=(({'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3,'1d':86400e3})[itvName])||300e3, rows=[], P=demoAnchorsFor(coin);
  if(!P.length)return {rows,coveredTo:b};
  for(let t=Math.floor(a/ms)*ms;t<b;t+=ms){
    const xs=[]; for(let k=0;k<=6;k++)xs.push(demoPrice(coin,t+ms*k/6));
    for(const p of P)if(p[0]>=t&&p[0]<t+ms)xs.push(p[1]); // a fill inside the candle is inside its range
    rows.push([t,Math.max(...xs),Math.min(...xs),xs[6],xs[0]]);
  }
  return {rows,coveredTo:b};
}
(function(){ const b=$('helpBtn'); if(b)b.onclick=()=>window.open('help','_blank','noopener'); })();
// Docs entry points show whenever the page is SERVED (http/https) — the /help and /docs
// routes come from server.js, so from file:// they'd 404 and stay hidden. Protocol-gated
// rather than SRV-gated so they're findable even before/without the sync handshake.
(function(){ if(/^https?:$/.test(location.protocol))
  for(const id of ['appfoot','helpBtn','helpLink']){ const el=$(id); if(el)el.classList.remove('hide'); } })();

/* ============================ tab-visible tripwire notifications ============================ */
// The webhook covers the phone; this covers the desktop: when the app sits in a background
// tab and the tripwire trips, the OS notification fires. Permission is only ever requested
// on an explicit save gesture (rules / day plan) — never on load.
const _notified={};
function maybeNotify(key, title, body){
  try{
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    if(_notified[key])return;
    _notified[key]=1;
    new Notification(title,{body, tag:key});
  }catch(e){}
}
function askNotifyPerm(){
  try{ if(('Notification' in window)&&Notification.permission==='default')Notification.requestPermission().catch(()=>{}); }catch(e){}
}

/* ============================ PWA ============================ */
// Installable when served over http(s): the manifest + icons above handle "Add to home screen".
// Full offline caching needs a companion service worker file at the origin (see self-hosting notes),
// so registration is best-effort and silently no-ops from file:// or when no sw.js is present.
let _deferredInstall=null;
// Android and desktop Chrome hand over an install prompt; iPhone Safari never does, so there the
// button explains Share → Add to Home Screen. Hidden once the app runs installed (standalone).
const installedNow=()=>{ try{ return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true; }catch(e){ return false; } };
const isIOSSafari=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function showInstall(on){ for(const id of ['installPWA','installSide']){ const b=$(id); if(b)b.classList.toggle('hide',!on); } }
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); _deferredInstall=e; showInstall(true); });
async function doInstall(){
  if(_deferredInstall){ _deferredInstall.prompt(); try{ await _deferredInstall.userChoice; }catch(e){} _deferredInstall=null; showInstall(false); return; }
  if(isIOSSafari())alert('To install Ledger on your iPhone or iPad: tap the Share button in Safari’s toolbar, then “Add to Home Screen”. It opens full screen, like an app.'); }
(function(){ for(const id of ['installPWA','installSide']){ const b=$(id); if(b)b.onclick=doInstall; }
  if(/^https?:$/.test(location.protocol)&&!installedNow()&&isIOSSafari())showInstall(true); })();
window.addEventListener('appinstalled',()=>{ _deferredInstall=null; showInstall(false); });
(function(){ try{
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('sw.js').catch(()=>{}); // present only if the app is self-hosted with a sw.js
  }
}catch(e){} })();
// An installed phone app is resumed far more often than it's reloaded, so a deploy could go unseen
// for days. Coming back to the foreground (at most once a minute) it asks the server which version
// it would serve now; a newer one reloads the page at once, unless something typed here would be
// lost, in which case a bar offers the update instead.
function appTyped(){ return [...document.querySelectorAll('textarea,input:not([type]),input[type=text],input[type=number],input[type=search]')]
  .some(el=>el.offsetParent!==null&&el.value!==''&&el.value!==el.defaultValue); }
function appUpdateBar(){ if(document.getElementById('appUpdate'))return;
  const d=document.createElement('div'); d.id='appUpdate'; d.setAttribute('role','status');
  d.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:9999;display:flex;gap:12px;align-items:center;padding:10px 12px 10px 16px;border-radius:12px;background:#1B2027;color:#E8ECF1;font:500 14px/1.3 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 32px);width:max-content;white-space:nowrap';
  d.innerHTML='<span>A new version is ready.</span><button type="button" style="border:0;border-radius:8px;padding:7px 12px;background:#3B82F6;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Update</button>';
  d.querySelector('button').onclick=()=>location.reload(); document.body.appendChild(d); }
(function(){ try{
  const meta=document.querySelector('meta[name="app-version"]'), mine=meta&&meta.content;
  if(!mine||!/^https?:$/.test(location.protocol))return; // served by our server only
  let last=Date.now(), busy=false;
  async function check(){ if(busy||document.hidden||Date.now()-last<60000)return; busy=true; last=Date.now();
    try{ const r=await fetch('/api/version',{cache:'no-store'}); const j=r.ok?await r.json():null;
      if(!j||!j.v||j.v===mine)return;
      if(appTyped())appUpdateBar(); else location.reload();
    }catch(e){} finally{ busy=false; } }
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden)check(); });
  window.addEventListener('focus',check);
}catch(e){} })();

/* ============================================================================
   NEW FEATURES BUILD — added as extracted, mostly-pure functions.
   1 Capital: cash-flow ledger + money-weighted return (XIRR)
   2 Leverage survivability (liq-proximity from realized MAE)
   3 Pre-trade position sizer (Project tab)
   4 Rule engine + live daily-loss tripwire
   5 Trade-plan capture + adherence scoring
   6 Wallet / setup leaderboard (Review tab)
   7 Funding-carry lens
   Pure fns take their inputs explicitly so the Node harness / server engine can
   call them without DOM. Render fns touch the DOM and reuse existing primitives.
   ============================================================================ */

/* ---- small local helpers (nf* prefix to avoid collisions) ---- */
const nfPct=(x,dp=1)=>x==null||!isFinite(x)?'\u2014':(x*100).toFixed(dp)+'%';
const nfSignPct=(x,dp=1)=>x==null||!isFinite(x)?'\u2014':((x>=0?'+':'')+(x*100).toFixed(dp)+'%');
// Day bucket honoring the tz toggle. This used to be a raw UTC day (floor(ms/86400000)),
// so a US-timezone trader's "daily loss limit" and max-trades/day reset at 4-5pm local
// while every other day analytic used tzMidnight. One clock now.
const nfDayKey=ms=>tzMidnight(ms);
function nfMedian(a){ if(!a||!a.length)return null; const s=[...a].sort((x,y)=>x-y),n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; }
