// Ledger app · part 2 of 15: other venues — Lighter (by wallet address, like Hyperliquid), Bybit and Binance (read-only API keys).
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ venues ============================ */
// A wallet's venue is in its address: Hyperliquid wallets are plain 0x addresses (as always),
// the others carry a prefix — "lighter:0x…", "bybit:<key id>", "binance:<key id>" — so every
// per-wallet cache, filter and sync path keeps working unchanged and Hyperliquid-only code
// (the server's refresh, wallet claims, verified P&L) simply skips them. Each venue's loader
// returns fills in the Hyperliquid shape (engine.js: ltNormTrade, bybitNormExec, binanceNormTrade),
// so reconstruction, stats, journal, Pulse and the tax export see one kind of trade.
const VENUE_NAMES={hyperliquid:'Hyperliquid',lighter:'Lighter',bybit:'Bybit',binance:'Binance'};
const VENUE_RE=/^(lighter|bybit|binance):(.+)$/;
function venueOfAddr(a){ const m=VENUE_RE.exec(String(a||'')); return m?m[1]:'hyperliquid'; }
function venueOf(w){ return venueOfAddr(w&&w.address); }
function venueRaw(a){ const m=VENUE_RE.exec(String(a||'')); return m?m[2]:String(a||''); }
const isCexVenue=v=>v==='bybit'||v==='binance';
// the result a venue loader hands back to loadAll (same fields as loadWallet's)
function venueResult(o){ return Object.assign({added:0,cached:false,truncNote:null,flows:[],skipped:0,nFills:0,trades:[],positions:[],accountValue:null,
  port:{all:null,perp:null},spotHold:[],spotVal:0,spotHas:false},o); }
// same-millisecond fills keep the venue's own order (trade ids increase), or positions read backwards
const fillOrder=(a,b)=>a.time-b.time||(+a.tid||0)-(+b.tid||0);
async function venueCache(key){ try{ const c=await unpackFillCache(await idbGet(key)); return c&&c.v===2&&Array.isArray(c.fills)?c:null; }catch(e){ return null; } }
// fills cached without their derived fields (they depend on the whole history), with extras kept
async function venueSave(key, fills, extras, strip){
  const last=fills.reduce((x,f)=>f.time>x?f.time:x,0);
  try{ await idbSet(key,cacheExtras(await packFillCache(strip?fills.map(f=>{ const c={...f}; for(const k of strip)delete c[k]; return c; }):fills,last),extras||{})); }catch(e){} }
function mergeFills(old, add, keyOf){ const seen=new Set(), out=[]; let n=0;
  for(const f of old||[]){ const k=keyOf(f); if(!seen.has(k)){ seen.add(k); out.push(f); } }
  for(const f of add||[]){ const k=keyOf(f); if(!seen.has(k)){ seen.add(k); out.push(f); n++; } }
  return {fills:out.sort(fillOrder),added:n}; }
// trades rebuilt per position stream (a Lighter sub-account, a Binance hedge-mode leg) so two
// streams on one coin never merge; ids stay unique through the stream suffix
async function reconstructStreams(groups, frows, w, venue){
  const perp=[], spot=[];
  for(const [suffix,fills] of groups){ if(!fills.length)continue;
    const r=await reconstructCompute(fills,groups.length>1||suffix?frows.filter(x=>(x.stream||'')===suffix):frows,w.address+(suffix?'#'+suffix:''));
    perp.push(...r.perp); spot.push(...r.spot); }
  for(const t of [...perp,...spot]){ t.wallet={address:w.address,label:w.label}; t.venue=venue; if(t.coin.includes('/'))t.symbol=t.coin; }
  return {perp,spot};
}
function markOrphans(perp, positions){ const live=new Set(positions.map(p=>p.coin)); for(const t of perp)t.orphan=!!(t.isOpen&&!live.has(t.coin)); }

/* ---------------- Lighter: public by wallet address ---------------- */
const LT_API='https://mainnet.zklighter.elliot.ai';
let _ltGate=Promise.resolve();
// Lighter rate-limits bursts: every call goes through one queue, ~3 a second
function ltGet(path){ const p=_ltGate.then(()=>sleep(320)).then(async()=>{
    for(let i=0;i<5;i++){ let r;
      try{ r=await fetch(LT_API+path); }catch(e){ if(i===4)throw new Error('Network error reaching Lighter'); await sleep(900*(i+1)); continue; }
      if(r.status===429||r.status>=500){ await sleep(1600*(i+1)); continue; }
      let j; try{ j=await r.json(); }catch(e){ await sleep(1600*(i+1)); continue; } // a rate-limit page instead of JSON
      if(j&&j.code!=null&&j.code!==200){ const e=new Error(j.message||('Lighter error '+j.code)); e.code=j.code; throw e; }
      return j; }
    throw new Error('Lighter is busy — try again in a minute'); });
  _ltGate=p.catch(()=>{}); return p; }
async function ltAccountIndexes(l1){
  try{ const j=await ltGet('/api/v1/accountsByL1Address?l1_address='+encodeURIComponent(l1)); return (j.sub_accounts||[]).map(a=>+a.index).filter(n=>n>=0); }
  catch(e){ if(e.code===21100)return []; throw e; } }
let _ltMarkets=null;
async function ltMarkets(){
  if(_ltMarkets&&Date.now()-_ltMarkets.at<6*3600e3)return _ltMarkets;
  try{ const c=await idbGet('lt:markets'); if(c&&c.at>Date.now()-24*3600e3&&c.byId){ _ltMarkets=c; if(Date.now()-c.at<6*3600e3)return c; } }catch(e){}
  try{ const j=await ltGet('/api/v1/orderBooks'); const byId={}, bySym={};
    for(const m of j.order_books||[]){ byId[m.market_id]={symbol:m.symbol,spot:m.market_type==='spot'}; bySym[m.symbol]=m.market_id; }
    _ltMarkets={at:Date.now(),byId,bySym}; idbSet('lt:markets',_ltMarkets); }
  catch(e){ if(!_ltMarkets)throw e; } // a stale map beats no map
  return _ltMarkets; }
// newest first, page by page, until the cache's watermark — so a returning user fetches one page.
// A very long history stops after 40k trades and hands back where it stopped (cursor), so the
// next load carries on from there, further back, instead of starting from the top again.
async function ltFetchTrades(idx, since, from){
  const out=[]; let cursor=from||'', pages=0, truncated=false;
  for(;;){ const j=await ltGet('/api/v1/trades?account_index='+idx+'&sort_by=timestamp&sort_dir=desc&limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    const T=j.trades||[]; out.push(...T); pages++;
    if(!T.length||!j.next_cursor||T.length<100||T[T.length-1].timestamp<since)break;
    cursor=j.next_cursor;
    if(pages>=400){ truncated=true; break; } }
  return {trades:out.filter(t=>t.timestamp>=since),truncated,cursor:truncated?cursor:null}; }
// hourly funding rates for one market, cached and topped up per market (shared by every wallet)
async function ltFundingRates(marketId, fromMs, cachedOnly){
  const key='lt:fund:'+marketId; let c=null; try{ c=await idbGet(key); }catch(e){}
  if(!c||!Array.isArray(c.rows))c={rows:[],first:Infinity,last:0};
  if(cachedOnly)return c.rows.filter(r=>r.timestamp*1000>=fromMs);
  const now=Date.now(), want=Math.floor(fromMs/3600e3)*3600e3, spans=[];
  if(want<c.first)spans.push([want,Math.min(c.first,now)]);
  if(c.rows.length&&c.last<now-3600e3)spans.push([Math.max(c.last+1,want),now]); // an empty cache: the span above already runs to now
  for(const [a,b] of spans) for(let s=Math.floor(a/1000);s<b/1000;s+=500*3600){
    const j=await ltGet('/api/v1/fundings?market_id='+marketId+'&resolution=1h&start_timestamp='+s+'&end_timestamp='+Math.min(s+500*3600,Math.floor(b/1000))+'&count_back=500');
    for(const r of j.fundings||[])c.rows.push({timestamp:+r.timestamp,value:r.value,direction:r.direction}); }
  if(spans.length){ const seen=new Set(); c.rows=c.rows.filter(r=>!seen.has(r.timestamp)&&seen.add(r.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);
    c.first=Math.min(c.first,want); c.last=c.rows.length?c.rows[c.rows.length-1].timestamp*1000:now; try{ await idbSet(key,c); }catch(e){} }
  return c.rows.filter(r=>r.timestamp*1000>=fromMs);
}
// Lighter gives every perp fill's position before it; spot positions are walked from the history
function ltDeriveSpot(fills, idxs){ for(const idx of idxs)deriveFillPositions(fills.filter(f=>+f.acct===idx&&f.coin.includes('/'))); }
const ltGroups=(fills,idxs)=>idxs.length>1?idxs.map(i=>[String(i),fills.filter(f=>+f.acct===i)]):[['',fills]];
// funding: hourly rate × the position held, per sub-account — matches Lighter's own totals
async function ltFundingRows(fills, idxs, M, cachedOnly){
  const frows=[];
  for(const idx of idxs){ const F=fills.filter(f=>+f.acct===idx&&!f.coin.includes('/')); if(!F.length)continue;
    const fund={}; for(const c of new Set(F.map(f=>f.coin))){ const id=M.bySym[c]; if(id==null)continue;
      try{ fund[c]=await ltFundingRates(id,Math.min(...F.filter(f=>f.coin===c).map(f=>f.time)),cachedOnly); }catch(e){ if(typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.funding=true; } }
    for(const r of ltFundingEstimate(F,fund))frows.push({...r,stream:idxs.length>1?String(idx):''}); }
  return frows; }
async function loadLighterWallet(w, fresh){
  const l1=venueRaw(w.address), M=await ltMarkets();
  const idxs=await ltAccountIndexes(l1);
  if(!idxs.length)throw new Error('No Lighter account for this address');
  const key='flc:'+w.address, cache=fresh?null:await venueCache(key);
  let fills=cache?cache.fills.slice():[], added=0, trunc=false;
  // where a long history stopped last time, per sub-account: {cursor, since}
  const more=Object.assign({},(cache&&cache.more)||{}), moreWas=JSON.stringify(more);
  const norm=(T,idx)=>T.map(t=>{ const f=ltNormTrade(t,idx,id=>(M.byId[id]||{}).symbol); if(f)f.acct=idx; return f; }).filter(Boolean);
  for(const idx of idxs){
    const since=cache?Math.max(0,...cache.fills.filter(f=>+f.acct===idx).map(f=>f.time),0):0;
    const r=await ltFetchTrades(idx,since);
    let m=mergeFills(fills,norm(r.trades,idx),f=>f.acct+'|'+f.tid); fills=m.fills; added+=m.added;
    const left=more[idx]; if(r.truncated)more[idx]={cursor:r.cursor,since}; // (40k new trades since the last load: that gap is the one to fill now)
    else if(left){ // carry on below where the last load stopped
      try{ const o=await ltFetchTrades(idx,left.since||0,left.cursor);
        m=mergeFills(fills,norm(o.trades,idx),f=>f.acct+'|'+f.tid); fills=m.fills; added+=m.added;
        if(o.truncated)more[idx]={cursor:o.cursor,since:left.since||0}; else delete more[idx]; }
      catch(e){ delete more[idx]; trunc=true; } } // the cursor expired: the gap stays noted, the trades we have stay
    if(more[idx])trunc=true; }
  if(!cache||added||JSON.stringify(more)!==moreWas)await venueSave(key,fills,Object.keys(more).length?{more}:null,null);
  ltDeriveSpot(fills,idxs);
  const frows=await ltFundingRows(fills,idxs,M,false);
  // positions and equity, live
  const positions=[]; let accountValue=0, anyAcct=false;
  for(const idx of idxs){ try{ const j=await ltGet('/api/v1/account?by=index&value='+idx), a=(j.accounts||[])[0]; if(!a)continue; anyAcct=true;
      let upl=0; for(const p of a.positions||[]){ const sz=parseFloat(p.position)*(+p.sign||1); if(!sz)continue; upl+=parseFloat(p.unrealized_pnl)||0;
        const imf=parseFloat(p.initial_margin_fraction);
        positions.push({coin:p.symbol,dex:'',szi:sz,entryPx:parseFloat(p.avg_entry_price),uPnl:parseFloat(p.unrealized_pnl)||0,roe:null,
          liq:parseFloat(p.liquidation_price)>0?parseFloat(p.liquidation_price):null,lev:imf>0?Math.round(100/imf):null,value:parseFloat(p.position_value)||0,wallet:{address:w.address,label:w.label},venue:'lighter'}); }
      accountValue+=(parseFloat(a.collateral)||0)+upl; }catch(e){} }
  const {perp,spot}=await reconstructStreams(ltGroups(fills,idxs),frows,w,'lighter');
  if(anyAcct)markOrphans(perp,positions);
  return venueResult({added,cached:!!cache,truncNote:trunc?labelFor(w)+' (very long history — the next load continues)':null,nFills:fills.length,
    trades:perp.concat(spot),positions,accountValue:anyAcct?accountValue:null}); }
async function ltCandles(coin, itvName, a, b){
  const M=await ltMarkets(), id=M.bySym[coin]; if(id==null)throw new Error('not a Lighter market');
  const ms={'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3,'1d':86400e3}[itvName]||3600e3, rows=[];
  for(let s=a;s<b;s+=ms*500){ const j=await ltGet('/api/v1/candles?market_id='+id+'&resolution='+itvName+'&start_timestamp='+Math.floor(s/1000)+'&end_timestamp='+Math.floor(Math.min(b,s+ms*500)/1000)+'&count_back=500');
    for(const k of j.c||[])rows.push([+k.t,+k.h,+k.l,+k.c,+k.o]); }
  return {rows,coveredTo:b}; }

/* ---------------- Bybit and Binance: read-only API keys, signed here, relayed by the server ---------------- */
// The secret never leaves this browser: each request is signed here (WebCrypto HMAC-SHA256) and
// the companion server only forwards the signed, short-lived request to the exchange (neither
// exchange accepts browser requests directly). The server's relay forwards GETs to read-only
// endpoints only, and keys that could trade or withdraw are refused when connecting.
// Credentials live in this browser's IndexedDB under cexcred:<wallet address> — never in settings,
// sync, backups or the encrypted journal — so each device connects its own key once.
const cexCredKey=a=>'cexcred:'+a;
async function cexHmacHex(secret, msg){
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function cexKeyId(apiKey){ const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('ledger|'+apiKey));
  return [...new Uint8Array(h)].slice(0,6).map(b=>b.toString(16).padStart(2,'0')).join(''); }
// one relayed call; {status, json}. The server says when the exchange refused its location.
async function cexRelay(venue, host, path, query, headers){
  if(!(typeof SRV!=='undefined'&&SRV.enabled))throw new Error(VENUE_NAMES[venue]+' needs the companion server (it relays your signed requests — the exchange doesn’t accept them from a browser directly). Open Ledger from your server’s address.');
  const h={'Content-Type':'application/json'}; if(typeof SOC!=='undefined'&&SOC&&SOC.key)h['X-Pulse-Key']=SOC.key; // a Pulse member, not the owner
  let r; try{ r=await srvFetch('/api/cex/relay',{method:'POST',headers:h,body:JSON.stringify({venue,host,path,query:query||'',headers:headers||{}})}); }
  catch(e){ throw new Error('Couldn’t reach your server to relay the request ('+e.message+').'); }
  let j={}; try{ j=await r.json(); }catch(e){}
  if(r.status===401)throw new Error('Connect to your server first (access token or Keel sign-in) to use '+VENUE_NAMES[venue]+'.');
  if(r.status===404||r.status===405)throw new Error('Your server doesn’t relay exchange requests yet — redeploy it with this version of Ledger.');
  if(!r.ok)throw new Error(j.error||('relay HTTP '+r.status));
  if(j.geo)throw new Error(VENUE_NAMES[venue]+' refused your server’s location ('+(j.detail||'restricted region')+'). Exchange APIs only answer from countries they serve: run the server — or a relay — in a region '+VENUE_NAMES[venue]+' supports. See README-deploy “Exchange APIs”.');
  let json=null; try{ json=JSON.parse(j.body||'null'); }catch(e){}
  return {status:j.status,json}; }
// clock offset per venue: signed requests are rejected when this device's clock drifts
const _cexClock={};
async function cexNow(venue){
  if(_cexClock[venue]==null){ const t0=Date.now();
    try{ const r=venue==='bybit'?await cexRelay('bybit','api','/v5/market/time',''):await cexRelay('binance','fapi','/fapi/v1/time','');
      const t1=Date.now(), srv=venue==='bybit'?+((r.json&&r.json.time)||0):+((r.json&&r.json.serverTime)||0);
      _cexClock[venue]=srv>0?srv-Math.round((t0+t1)/2):0; }
    catch(e){ throw e; } }
  return Date.now()+_cexClock[venue]; }
const qsOf=p=>Object.entries(p).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
async function bybitGet(cred, path, params, signed){
  const qs=qsOf(params||{}); let headers={};
  if(signed!==false){ const ts=String(await cexNow('bybit')), rw='20000';
    headers={'X-BAPI-API-KEY':cred.apiKey,'X-BAPI-TIMESTAMP':ts,'X-BAPI-RECV-WINDOW':rw,'X-BAPI-SIGN':await cexHmacHex(cred.apiSecret,ts+cred.apiKey+rw+qs)}; }
  for(let i=0;i<4;i++){ const r=await cexRelay('bybit','api',path,qs,headers), j=r.json||{};
    if(j.retCode===0)return j.result||{};
    if(j.retCode===10006||r.status===429){ await sleep(1500*(i+1)); continue; } // rate limit
    const msg={10003:'Bybit rejected the API key — check it was copied in full',10004:'Bybit rejected the signature — check the API secret',10002:'Bybit says this device’s clock is off — check the time settings',33004:'This Bybit API key has expired — create a new read-only key',10005:'This Bybit API key lacks read permission'}[j.retCode];
    throw new Error(msg||('Bybit: '+(j.retMsg||('error '+(j.retCode!=null?j.retCode:r.status))))); }
  throw new Error('Bybit is rate-limiting — try again in a minute'); }
async function binanceGet(cred, host, path, params, signed){
  let qs=qsOf(params||{}), headers={};
  if(signed!==false){ qs=qsOf({...(params||{}),recvWindow:20000,timestamp:await cexNow('binance')}); qs+='&signature='+await cexHmacHex(cred.apiSecret,qs); headers={'X-MBX-APIKEY':cred.apiKey}; }
  else if(cred&&cred.apiKey)headers={'X-MBX-APIKEY':cred.apiKey};
  for(let i=0;i<4;i++){ const r=await cexRelay('binance',host,path,qs,headers), j=r.json;
    if(r.status>=200&&r.status<300)return j;
    if(r.status===429||r.status===418){ await sleep(2000*(i+1)); continue; }
    const code=j&&j.code, msg={'-2015':'Binance rejected the key: wrong key, an IP whitelist that doesn’t include your server, or missing read permission','-2014':'That isn’t a valid Binance API key','-1022':'Binance rejected the signature — check the API secret','-1021':'Binance says this device’s clock is off — check the time settings'}[String(code)];
    throw new Error(msg||('Binance: '+((j&&j.msg)||('HTTP '+r.status)))); }
  throw new Error('Binance is rate-limiting — try again in a minute'); }
// Connecting: the key must be read-only. Returns {keyId, note}.
async function cexCheckKey(venue, cred){
  if(venue==='bybit'){ const k=await bybitGet(cred,'/v5/user/query-api',{});
    if(+k.readOnly!==1)throw new Error('This Bybit key can trade or move funds. Create a key with “Read-Only” permissions and connect that one instead.');
    return {keyId:await cexKeyId(cred.apiKey),note:k.expiredAt?'expires '+String(k.expiredAt).slice(0,10)+' (keys without an IP whitelist expire after 90 days)':''}; }
  const k=await binanceGet(cred,'api','/sapi/v1/account/apiRestrictions',{});
  const risky=['enableWithdrawals','enableInternalTransfer','permitsUniversalTransfer','enableSpotAndMarginTrading','enableMargin','enableFutures','enablePortfolioMarginTrading','enableVanillaOptions','enableFixApiTrade'].filter(f=>k&&k[f]===true);
  if(risky.length)throw new Error('This Binance key can trade or move funds ('+risky.join(', ')+'). Edit it to “Enable Reading” only, or create a read-only key.');
  if(!(k&&k.enableReading))throw new Error('This Binance key can’t read the account — tick “Enable Reading”.');
  return {keyId:await cexKeyId(cred.apiKey),note:''}; }
async function cexCred(w){ try{ const c=await idbGet(cexCredKey(w.address)); return c&&c.apiKey&&c.apiSecret?c:null; }catch(e){ return null; } }
// 7-day windows, newest last, from `since` to now (both exchanges cap a query at 7 days)
function weekWindows(since, now){ const W=7*86400e3-1000, out=[]; for(let a=since;a<now;a+=W)out.push([a,Math.min(now,a+W)]); return out; }
async function mapPool(items, n, fn){ const out=new Array(items.length); let i=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{ while(i<items.length){ const k=i++; out[k]=await fn(items[k],k); } })); return out; }
function cexPosition(w, venue, coin, szi, entryPx, uPnl, liq, lev, value){
  return {coin,dex:'',szi,entryPx,uPnl,roe:null,liq:liq>0?liq:null,lev:lev||null,value:Math.abs(value||0),wallet:{address:w.address,label:w.label},venue}; }
function bybitDerive(fills, seed){ deriveFillPositions(fills.filter(f=>!f.coin.includes('/')),seed||{}); deriveFillPositions(fills.filter(f=>f.coin.includes('/'))); }
async function loadBybitWallet(w, fresh){
  const cred=await cexCred(w); if(!cred)throw new Error('add the Bybit API key on this device');
  const key='flc:'+w.address, cache=fresh?null:await venueCache(key), now=await cexNow('bybit');
  const since=cache&&cache.last?cache.last-3600e3:now-729*86400e3; // the API keeps 2 years
  let nf=[];
  for(const category of ['linear','spot']){
    const wins=weekWindows(since,now);
    const got=await mapPool(wins,3,async([a,b])=>{ const rows=[]; let cursor='';
      for(let p=0;p<200;p++){ const r=await bybitGet(cred,'/v5/execution/list',{category,startTime:a,endTime:b,limit:100,cursor});
        for(const e of r.list||[]){ const f=bybitNormExec(e,category); if(f)rows.push(f); }
        if(!r.nextPageCursor||!(r.list||[]).length)break; cursor=r.nextPageCursor; }
      return rows; });
    for(const g of got)nf.push(...g); }
  const m=mergeFills(cache?cache.fills:[],nf,f=>f.tid); let fills=m.fills;
  // funding: the transaction log's SETTLEMENT rows (+ received, − paid), cached like fills
  const fkey='fnd:'+w.address; let fc=null; try{ fc=fresh?null:await idbGet(fkey); }catch(e){}
  const fsince=fc&&fc.last?fc.last-3600e3:since; let frows=fc&&Array.isArray(fc.rows)?fc.rows.slice():[];
  try{ const got=await mapPool(weekWindows(fsince,now),3,async([a,b])=>{ const rows=[]; let cursor='';
      for(let p=0;p<400;p++){ const r=await bybitGet(cred,'/v5/account/transaction-log',{accountType:'UNIFIED',category:'linear',type:'SETTLEMENT',startTime:a,endTime:b,limit:50,cursor});
        for(const x of r.list||[]){ const v=parseFloat(x.funding); if(v&&x.symbol)rows.push({time:+x.transactionTime,coin:cexCoin(x.symbol,'perp'),usdc:v,id:x.id||''}); }
        if(!r.nextPageCursor||!(r.list||[]).length)break; cursor=r.nextPageCursor; }
      return rows; });
    const seen=new Set(frows.map(r=>r.id||r.time+'|'+r.coin)); for(const g of got)for(const r of g){ const k=r.id||r.time+'|'+r.coin; if(!seen.has(k)){ seen.add(k); frows.push(r); } }
    frows.sort((a,b)=>a.time-b.time); idbSet(fkey,{v:1,rows:frows,last:frows.length?frows[frows.length-1].time:now}); }
  catch(e){ if(typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.funding=true; }
  // positions and equity
  const positions=[]; let accountValue=null, hedge=false, posOk=true;
  for(const settleCoin of ['USDT','USDC']){ try{ let cursor='';
      for(let p=0;p<20;p++){ const r=await bybitGet(cred,'/v5/position/list',{category:'linear',settleCoin,limit:200,cursor});
        for(const x of r.list||[]){ const sz=parseFloat(x.size); if(!sz)continue; if(+x.positionIdx>0)hedge=true;
          positions.push(cexPosition(w,'bybit',cexCoin(x.symbol,'perp'),x.side==='Sell'?-sz:sz,parseFloat(x.avgPrice),parseFloat(x.unrealisedPnl)||0,parseFloat(x.liqPrice),parseFloat(x.leverage),parseFloat(x.positionValue))); }
        if(!r.nextPageCursor)break; cursor=r.nextPageCursor; } }catch(e){ posOk=false; } }
  try{ const r=await bybitGet(cred,'/v5/account/wallet-balance',{accountType:'UNIFIED'}); const a=(r.list||[])[0]; if(a)accountValue=parseFloat(a.totalEquity); }catch(e){}
  // positions older than the 2-year history: seed from today's position minus the window's net
  const perpFills=fills.filter(f=>!f.coin.includes('/')), nowPos={}; for(const p of positions)nowPos[p.coin]=(nowPos[p.coin]||0)+p.szi;
  const seed=posOk?initialPositions(perpFills,nowPos):(cache&&cache.seed)||{};
  bybitDerive(fills,seed);
  if(!cache||m.added||JSON.stringify(seed)!==JSON.stringify(cache.seed||{}))await venueSave(key,fills,{seed},['startPosition','closedPnl']);
  const {perp,spot}=await reconstructStreams([['',fills]],frows,w,'bybit');
  if(posOk)markOrphans(perp,positions);
  return venueResult({added:m.added,cached:!!cache,nFills:fills.length,trades:perp.concat(spot),positions,accountValue,
    truncNote:hedge?labelFor(w)+' (hedge-mode positions: Bybit’s fill history doesn’t say which side each fill belongs to, so they’re read as one-way)':null}); }
function binanceLegs(fills){ const legs=new Map(); for(const f of fills){ const k=f.leg||''; if(!legs.has(k))legs.set(k,[]); legs.get(k).push(f); } return legs; }
function binanceDerive(legs, seed){ for(const [leg,F] of legs)deriveFillPositions(F,(seed||{})[leg]||{}); }
// Binance's funding rows don't say which hedge-mode leg paid: each goes to the leg holding the
// larger position in that coin at that moment (one-way accounts have the one leg, '')
function legFunding(legs, frows){
  if(legs.size<2||!legs.has('LONG')&&!legs.has('SHORT'))return frows.map(r=>({...r,stream:legs.size?[...legs.keys()][0]:''}));
  const by={}; for(const [leg,F] of legs)for(const f of F)if(!f.coin.includes('/'))((by[leg]=by[leg]||{})[f.coin]=by[leg][f.coin]||[]).push(f);
  const posAt=(F,t)=>{ let lo=0,hi=F.length; while(lo<hi){ const m=(lo+hi)>>1; if(F[m].time<t)lo=m+1; else hi=m; }
    if(!lo)return F.length?Math.abs(parseFloat(F[0].startPosition)||0):0; const f=F[lo-1], q=parseFloat(f.sz);
    return Math.abs((parseFloat(f.startPosition)||0)+(f.side==='B'?q:-q)); };
  return frows.map(r=>{ let best='', bv=0; for(const leg in by){ const F=by[leg][r.coin]; if(!F)continue; const v=posAt(F,r.time); if(v>bv){ bv=v; best=leg; } }
    return {...r,stream:best}; }); }
async function loadBinanceWallet(w, fresh){
  const cred=await cexCred(w); if(!cred)throw new Error('add the Binance API key on this device');
  const key='flc:'+w.address, cache=fresh?null:await venueCache(key), now=await cexNow('binance');
  const floor=now-89*86400e3; // Binance's API only keeps 3 months of trades and income
  const since=Math.max(floor,cache&&cache.last?cache.last-3600e3:0);
  // income: funding payments, and which symbols were traded (commission and P&L rows name them)
  const fkey='fnd:'+w.address; let fc=null; try{ fc=fresh?null:await idbGet(fkey); }catch(e){}
  let frows=fc&&Array.isArray(fc.rows)?fc.rows.slice():[]; const syms=new Set((cache&&cache.syms)||[]);
  const incGot=await mapPool(weekWindows(Math.max(floor,fc&&fc.last?fc.last-3600e3:since),now),2,async([a,b])=>{ const rows=[];
    for(let page=1;page<=50;page++){ const r=await binanceGet(cred,'fapi','/fapi/v1/income',{startTime:a,endTime:b,limit:1000,page});
      rows.push(...(r||[])); if(!r||r.length<1000)break; }
    return rows; });
  { const seen=new Set(frows.map(r=>r.id)); for(const g of incGot)for(const x of g){ if(x.symbol)syms.add(x.symbol);
      if(x.incomeType==='FUNDING_FEE'){ const id=x.incomeType+'|'+x.tranId+'|'+x.symbol; if(!seen.has(id)){ seen.add(id); frows.push({time:+x.time,coin:cexCoin(x.symbol,'perp'),usdc:parseFloat(x.income)||0,id}); } } } }
  frows.sort((a,b)=>a.time-b.time); idbSet(fkey,{v:1,rows:frows,last:frows.length?frows[frows.length-1].time:now});
  // positions (and their symbols), equity, the BNB price for BNB-paid commissions
  const positions=[]; const nowPos={}; let posOk=true;
  try{ const r=await binanceGet(cred,'fapi','/fapi/v3/positionRisk',{});
    for(const x of r||[]){ const sz=parseFloat(x.positionAmt); if(!sz)continue; syms.add(x.symbol); const coin=cexCoin(x.symbol,'perp');
      const leg=x.positionSide&&x.positionSide!=='BOTH'?x.positionSide:''; nowPos[coin+'|'+leg]=(nowPos[coin+'|'+leg]||0)+sz;
      positions.push(cexPosition(w,'binance',coin,sz,parseFloat(x.entryPrice),parseFloat(x.unRealizedProfit)||0,parseFloat(x.liquidationPrice),null,parseFloat(x.notional))); } }catch(e){ posOk=false; }
  let accountValue=null; try{ const r=await binanceGet(cred,'fapi','/fapi/v3/account',{}); accountValue=parseFloat(r.totalMarginBalance); }catch(e){}
  let bnbUsd=0; try{ const r=await binanceGet(null,'fapi','/fapi/v1/ticker/price',{symbol:'BNBUSDT'},false); bnbUsd=parseFloat(r.price)||0; }catch(e){}
  // trades: per symbol (the API needs one), 7-day windows; past 1,000 in a window, page by id
  const jobs=[]; for(const s of syms)for(const win of weekWindows(since,now))jobs.push([s,win]);
  const got=await mapPool(jobs,3,async([symbol,[a,b]])=>{ const rows=[]; let r=await binanceGet(cred,'fapi','/fapi/v1/userTrades',{symbol,startTime:a,endTime:b,limit:1000});
    rows.push(...(r||[]));
    while(r&&r.length===1000){ r=await binanceGet(cred,'fapi','/fapi/v1/userTrades',{symbol,fromId:+r[r.length-1].id+1,limit:1000}); rows.push(...(r||[]).filter(x=>+x.time<=b)); if(r.some(x=>+x.time>b))break; }
    return rows.map(x=>binanceNormTrade(x,bnbUsd)).filter(Boolean); });
  const nf=[]; for(const g of got)nf.push(...g);
  const m=mergeFills(cache?cache.fills:[],nf,f=>f.tid); const fills=m.fills;
  // each hedge-mode leg is its own position stream; positions held before the 3-month window
  // are seeded from today's position minus the window's net
  const legs=binanceLegs(fills), seed={};
  for(const [leg,F] of legs){ const np={}; for(const k in nowPos){ const [c,l]=k.split('|'); if(l===leg)np[c]=nowPos[k]; } seed[leg]=initialPositions(F,np); }
  const useSeed=posOk?seed:(cache&&cache.seed)||{};
  binanceDerive(legs,useSeed);
  if(!cache||m.added||syms.size>((cache&&cache.syms)||[]).length||JSON.stringify(useSeed)!==JSON.stringify(cache.seed||{}))await venueSave(key,fills,{syms:[...syms],seed:useSeed},['startPosition']);
  const {perp,spot}=await reconstructStreams([...legs],legFunding(legs,frows),w,'binance');
  if(posOk)markOrphans(perp,positions);
  const unpriced=[...new Set(fills.filter(f=>f.feeUnpriced).map(f=>f.feeUnpriced))];
  const notes=[]; if(!cache)notes.push('Binance’s API only returns the last 3 months; Ledger keeps everything it has loaded from here on'); if(unpriced.length)notes.push('fees paid in '+unpriced.join(', ')+' aren’t counted');
  return venueResult({added:m.added,cached:!!cache,nFills:fills.length,trades:perp.concat(spot),positions,accountValue,truncNote:notes.length?labelFor(w)+' ('+notes.join('; ')+')':null}); }
// public candles through the relay, so replay and price excursions work for every exchange's coins
async function cexCandles(venue, coin, itvName, a, b){
  const rows=[];
  if(venue==='bybit'){ const iv={'1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'}[itvName]||'60', ms={'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3,'1d':86400e3}[itvName]||3600e3;
    for(let s=a;s<b;s+=ms*1000){ const r=await bybitGet(null,'/v5/market/kline',{category:coin.includes('/')?'spot':'linear',symbol:cexSymbol(coin),interval:iv,start:s,end:Math.min(b,s+ms*1000),limit:1000},false);
      for(const k of r.list||[])rows.push([+k[0],+k[2],+k[3],+k[4],+k[1]]); } }
  else { const ms={'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3,'1d':86400e3}[itvName]||3600e3;
    for(let s=a;s<b;s+=ms*1500){ const r=await binanceGet(null,'fapi','/fapi/v1/klines',{symbol:cexSymbol(coin),interval:itvName,startTime:s,endTime:Math.min(b,s+ms*1500),limit:1500},false);
      for(const k of r||[])rows.push([+k[0],+k[2],+k[3],+k[4],+k[1]]); } }
  return {rows:rows.sort((x,y)=>x[0]-y[0]),coveredTo:b}; }
// the venue-aware candle source: Hyperliquid's for its own trades (and anything unknown)
function candleVenue(t){ return t&&t.venue&&t.venue!=='hyperliquid'?t.venue:''; }
async function venueFetchCandles(venue, coin, itvName, a, b){
  if(venue==='lighter')return ltCandles(coin,itvName,a,b);
  if(isCexVenue(venue))return cexCandles(venue,coin,itvName,a,b);
  return fetchCandles(coin,itvName,a,b); }

/* ---------------- loading, and opening from this device's saved copy ---------------- */
function loadVenueWallet(w, fresh){ const v=venueOf(w);
  return v==='lighter'?loadLighterWallet(w,fresh):v==='bybit'?loadBybitWallet(w,fresh):loadBinanceWallet(w,fresh); }
// trades rebuilt from the saved fills and funding alone — no network — so the app opens at once
// (bootFromCache); null when this device has nothing saved for the wallet yet
async function venueBootTrades(w){
  const v=venueOf(w), c=await venueCache('flc:'+w.address); if(!c||!c.fills.length)return null;
  const fills=c.fills.sort(fillOrder);
  if(v==='lighter'){ const idxs=[...new Set(fills.map(f=>+f.acct))].sort((a,b)=>a-b); ltDeriveSpot(fills,idxs);
    let M=_ltMarkets; if(!M){ try{ M=await idbGet('lt:markets'); }catch(e){} }
    const frows=M&&M.bySym?await ltFundingRows(fills,idxs,M,true):[];
    const r=await reconstructStreams(ltGroups(fills,idxs),frows,w,'lighter'); return r.perp.concat(r.spot); }
  let fd=null; try{ fd=await idbGet('fnd:'+w.address); }catch(e){}
  const frows=fd&&Array.isArray(fd.rows)?fd.rows:[];
  if(v==='bybit'){ bybitDerive(fills,c.seed); const r=await reconstructStreams([['',fills]],frows,w,'bybit'); return r.perp.concat(r.spot); }
  const legs=binanceLegs(fills); binanceDerive(legs,c.seed);
  const r=await reconstructStreams([...legs],legFunding(legs,frows),w,'binance'); return r.perp.concat(r.spot); }
async function forgetVenueWallet(w){ if(isCexVenue(venueOf(w))){ try{ await idbDel(cexCredKey(w.address)); }catch(e){} } }

/* ---------------- adding wallets: one address finds Hyperliquid and Lighter ---------------- */
// Pasting an address checks both venues at once and adds the one(s) with an account, so a Lighter
// trader doesn't have to know there's anything to choose. Hyperliquid is never dropped on doubt:
// it's left out only when Hyperliquid itself says it has never seen the address AND Lighter has an
// account for it. Each check is one small request with a short time limit and no retries, so
// adding a wallet never waits on a slow or unreachable venue.
async function venueProbe(url, body, ms){
  const ctl=typeof AbortController!=='undefined'?new AbortController():null, timer=ctl?setTimeout(()=>ctl.abort(),ms):null;
  try{ const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctl&&ctl.signal}:{signal:ctl&&ctl.signal});
    return r.ok||r.status===400?await r.json():null; }
  catch(e){ return null; } finally{ if(timer)clearTimeout(timer); } }
async function detectVenues(addr){
  const [hl,lt]=await Promise.all([
    // {"role":"missing"} = Hyperliquid has never seen this address; anything else (or no answer) keeps it
    venueProbe('https://api.hyperliquid.xyz/info',{type:'userRole',user:addr},5000).then(j=>j&&typeof j.role==='string'?j.role!=='missing':null),
    venueProbe(LT_API+'/api/v1/accountsByL1Address?l1_address='+encodeURIComponent(addr),null,5000)
      .then(j=>!j?null:Array.isArray(j.sub_accounts)?j.sub_accounts.length>0:j.code===21100?false:null)]);
  const out=[]; if(hl!==false||lt!==true)out.push('hyperliquid'); if(lt===true)out.push('lighter');
  return out; }
// the wallet ids to add for a pasted 0x address
async function walletIdsFor(address, forced){
  const v=forced||await detectVenues(address);
  return v.map(x=>x==='lighter'?'lighter:'+address:address); }

/* ---------------- connecting an exchange key (the full journal's dialog and Pulse's sheet share this) ---------------- */
const CEX_HELP={
  bybit:{steps:'Bybit → Account → API → Create New Key → System-generated → <b>Read-Only</b>. Tick Contract (Orders, Positions) and Unified Trading (Trade); leave every Read-Write box empty.',
    url:'https://www.bybit.com/app/user/api-management'},
  binance:{steps:'Binance → Account → API Management → Create API → System generated. Leave only <b>Enable Reading</b> ticked. If you add an IP restriction, include your server’s IP.',
    url:'https://www.binance.com/en/my/settings/api-management'}};
// Checks the key is real and read-only, then keeps it on this device and adds the account.
// Returns {address, note, added}.
async function cexConnect(venue, apiKey, apiSecret, label){
  if(!isCexVenue(venue))throw new Error('Pick Bybit or Binance');
  apiKey=String(apiKey||'').trim(); apiSecret=String(apiSecret||'').trim();
  if(!/^[A-Za-z0-9]{10,100}$/.test(apiKey))throw new Error('That API key doesn’t look right — copy it again in full.');
  if(!/^[A-Za-z0-9+/=_-]{10,200}$/.test(apiSecret))throw new Error('That API secret doesn’t look right — copy it again in full (Ed25519/RSA keys aren’t supported; create a system-generated HMAC key).');
  const cred={apiKey,apiSecret};
  const {keyId,note}=await cexCheckKey(venue,cred);
  const address=venue+':'+keyId;
  await idbSet(cexCredKey(address),{...cred,venue,at:Date.now()});
  let added=false;
  if(!settings.wallets.some(w=>w.address===address)){ settings.wallets.push({address,label:String(label||'').trim().slice(0,40)||VENUE_NAMES[venue]}); added=true; await Store.set(S_KEY,settings); }
  return {address,note,added}; }
