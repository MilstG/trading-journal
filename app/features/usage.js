/* ============================================================================
   Which parts of Daruma get used — counted on the device, sent with your stats, shown to the league
   owner only as totals across members (Admin → Insights → What gets used), never per person.
   Loads on Daruma's page only (data-only="keel").

   Per day (your clock, the last 14 days kept here, 35 on the server): the screens you opened ('tab:name'),
   the Today cards that were on screen ('card:id', from the data-use mark each card's root carries), and how
   many times you pressed something on a screen or a card. Nothing about what's in them: no numbers, no text.
   ============================================================================ */
const USE_LS='pzUse';
let _use=null, _useTab=null;
function useLoad(){ if(_use)return _use; try{ _use=JSON.parse(localStorage.getItem(USE_LS)||'{}')||{}; }catch(e){ _use={}; } if(typeof _use!=='object'||Array.isArray(_use))_use={}; return _use; }
function useSave(){ try{ const k=Object.keys(_use).sort(); for(const x of k.slice(0,Math.max(0,k.length-14)))delete _use[x]; localStorage.setItem(USE_LS,JSON.stringify(_use)); }catch(e){} }
const useKey=s=>String(s||'').toLowerCase().replace(/[^a-z0-9:_-]/g,'').slice(0,40);
// one mark: o (opened a screen), s (a card shown), a (pressed something on it). Pure on the store it's given.
function useMark(store, day, kind, key, act){
  const d=store[day]=store[day]||{o:[],s:[],a:{}}; key=useKey(key); if(!key)return store;
  if(act){ d.a[key]=(d.a[key]||0)+1; return store; }
  const list=kind==='o'?d.o:d.s; if(!list.includes(key)&&list.length<60)list.push(key); return store;
}
function pzUseSync(){ return useLoad(); }
function useDrawn(D, tab){
  if(pzS.demo)return; const S=useLoad(), day=dayKey(Date.now()), before=JSON.stringify(S[day]||null);
  if(tab&&tab!==_useTab){ _useTab=tab; useMark(S,day,'o','tab:'+tab); }
  if(tab==='today')for(const el of document.querySelectorAll('#pzView [data-use]'))if(el.offsetParent!==null)useMark(S,day,'s','card:'+el.dataset.use);
  if(JSON.stringify(S[day])!==before)useSave();
}
try{ document.addEventListener('click',e=>{
  if(typeof PZ==='undefined'||!PZ||pzS.demo)return; const b=e.target&&e.target.closest&&e.target.closest('#pzView a,#pzView button,#pzView [role=switch],#pzView summary'); if(!b)return;
  const S=useLoad(), day=dayKey(Date.now()), card=b.closest('[data-use]');
  useMark(S,day,'a','tab:'+pzTab(),true); if(card)useMark(S,day,'a','card:'+card.dataset.use,true); useSave(); },true); }catch(e){}
pzFeature({id:'usage',drawn:useDrawn});
