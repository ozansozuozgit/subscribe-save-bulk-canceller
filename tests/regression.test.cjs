const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
require('../state.js');
const { reconcile, remember, targetUrl } = globalThis.SNSState;
const modern = (id, title = 'Example product', date = 'Nov 20') => ({ id, subscriptionId: id, title, nextDate: date, image: 'https://m.media-amazon.com/images/I/EXAMPLE._SS250_.jpg', cancelUrl: `https://www.amazon.com/auto-deliveries/cancelSubscription?subscriptionId=${id}` });
const legacy = (keep = false) => ({ ...modern('hash'), subscriptionId: null, keep, status: 'failed' });
function page(html) {
  const dom = new JSDOM(html, { url: 'https://www.amazon.com/auto-deliveries/subscriptionList', runScripts: 'outside-only' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({width:125,height:125});
  for (const file of ['utils.js','selectors.js','scan.js']) dom.window.eval(fs.readFileSync(file,'utf8'));
  return dom;
}
// v2.1.2: the review panel starts collapsed. Tests that exercise the open
// panel start with it open and the "How it works" explainer already seen.
const openUi=()=>({get:async()=>({sns_ui:{panelOpen:true,howSeen:true}}),set:async()=>{}});
function tile(id, title) { return `<div data-edit-url="/auto-deliveries/ajax/subscription/?subscriptionId=${id}&amp;subAsin=B012345678"><div><img alt="${title}" src="https://m.media-amazon.com/images/I/EXAMPLE._SS250_.jpg"><span class="a-truncate-full a-offscreen">${title}</span><span class="a-truncate-cut">${title.slice(0,8)}</span><span>Next delivery: Nov 20</span><span>1 unit every 2 months</span><div role="button" data-edit-link="true">Edit</div></div></div>`; }

test('current Amazon attribute cards have stable IDs, correct titles and cancellation URLs', () => {
 const dom = page(tile('SNST0_ABCD','A complete product name') + tile('SNST0_EFGH','A complete product name'));
 const first = dom.window.SNSScan.scan();
 assert.equal(first.length,2); assert.equal(first[0].id,'SNST0_ABCD'); assert.equal(first[0].asin,'B012345678');
 assert.equal(first[0].title,'A complete product name'); assert.equal(first[0].nextDate,'Nov 20');
 assert.match(first[0].cancelUrl,/subscriptionId=SNST0_ABCD/);
 dom.window.document.querySelector('.a-truncate-cut').textContent='A different hydration state';
 assert.equal(dom.window.SNSScan.scan()[0].id,first[0].id);
 const detached = new dom.window.DOMParser().parseFromString(tile('SNST0_ABCD','A complete product name'),'text/html');
 assert.equal(dom.window.SNSScan.scan(detached).length,1);
 dom.window.close();
});
test('modern duplicate DOM copies collapse, distinct subscriptions of same product do not', () => {
 const dom=page(tile('SNST0_ABCD','Product')+tile('SNST0_ABCD','Product')+tile('SNST0_EFGH','Product'));
 assert.equal(dom.window.SNSScan.scan().length,2); dom.window.close();
});
test('legacy duplicates migrate a selected product exactly once', () => {
 const result=reconcile([modern('real')],[legacy(),{...legacy(),id:'hash2'}]);
 assert.equal(result[0].keep,false); assert.equal(result[0].status,'failed');
});
test('legacy same-image damaged title migrates using date, never to both duplicate subscriptions', () => {
 const damaged={...legacy(),title:'Next delivery: Nov 20'};
 assert.equal(reconcile([modern('real')],[damaged])[0].keep,false);
 const result=reconcile([modern('a'),modern('b')],[damaged]);
 assert.ok(result.every(x=>x.keep&&x.needsReview));
});
test('conflicting legacy keep/cancel choices require review; new subscriptions default to keep', () => {
 assert.equal(reconcile([modern('real')],[legacy(),{...legacy(true),id:'other'}])[0].needsReview,true);
 assert.equal(reconcile([modern('new')],[])[0].keep,true);
});
test('rescan/restart retains decisions and results, and absent items remain saved', () => {
 const saved=[{...modern('a'),keep:false,status:'done'},{...modern('b'),keep:false,status:'failed'}];
 const result=reconcile([modern('a'),modern('b')],saved);
 assert.equal(result[0].keep,true); assert.equal(result[1].keep,false);
 assert.equal(remember(saved,[result[1]]).length,2);
});
test('navigation rejects offsite URLs and mismatched identities', () => {
 assert.ok(targetUrl(modern('a')));
 assert.equal(targetUrl({...modern('a'),cancelUrl:'https://evil.example/auto-deliveries/cancelSubscription?subscriptionId=a'}),null);
 assert.equal(targetUrl({...modern('a'),cancelUrl:modern('b').cancelUrl}),null);
});
test('a click submits only once', () => {
 const dom=page('<button>Confirm</button>'); let clicks=0;
 const button=dom.window.document.querySelector('button'); button.addEventListener('click',()=>clicks++);
 dom.window.SNSUtils.realClick(button); assert.equal(clicks,1); dom.window.close();
});

async function worker(seed, tabs = {}) {
 const storage=structuredClone(seed), timers=[]; let handler;
 const context={console,URL,crypto:require('node:crypto').webcrypto,setTimeout:fn=>timers.push(fn), SNSState:globalThis.SNSState,
 chrome:{storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(storage[key])])),set:async patch=>Object.assign(storage,structuredClone(patch))}},runtime:{onMessage:{addListener:fn=>handler=fn},onInstalled:{addListener:()=>{}}},tabs:{update:async id=>({id}),query:async()=>[],create:async()=>({id:7}),...tabs},notifications:{create:async()=>{}}}};
 vm.runInNewContext(fs.readFileSync('bg.js','utf8').replace("import './state.js';",''),context);
 return {storage,timers,send:(type,data={},tabId=7)=>new Promise(resolve=>handler({type,...data},{tab:{id:tabId}},resolve))};
}
test('upgrade backs up original failures and rescans preserve choices across reset', async()=>{
 const old={status:'done',items:[legacy()],reason:'Other'}; const w=await worker({sns_run:old});
 await w.send('sns:getState'); assert.deepEqual(w.storage.sns_legacy_backup,old);
 let r=await w.send('sns:scanComplete',{items:[modern('real')]}); assert.equal(r.run.items[0].keep,false);
 await w.send('sns:reset'); r=await w.send('sns:scanComplete',{items:[modern('real')]}); assert.equal(r.run.items[0].keep,false);
});
test('wrong-tab, stale-item and duplicate reports cannot advance a run', async()=>{
 const item={...modern('real'),keep:false,status:'inflight',attempts:1};
 const w=await worker({sns_run:{status:'running',runId:'run',items:[item],currentIndex:0,tabId:7}});
 const identity={itemId:'real',runId:'run',attempt:1};
 assert.equal((await w.send('sns:itemDone',identity,8)).ok,false);
 assert.equal((await w.send('sns:itemDone',{...identity,itemId:'wrong'})).ok,false);
 assert.equal((await w.send('sns:itemDone',identity)).ok,true);
 assert.equal((await w.send('sns:itemDone',identity)).ok,false);
 assert.equal(w.storage.sns_run.items[0].status,'done');
});

async function cancelFlow({sid='real',authorized=true,success=true,alreadySubmitted=false}={}) {
 const dom=page(`${tile('real','Selected product')}<div role="dialog"><a href="https://www.amazon.com/auto-deliveries/cancelSubscription?subscriptionId=real">Cancel subscription</a><form action="https://www.amazon.com/auto-deliveries/ajax/cancelSubscriptionAction?subscriptionId=${sid}"><select name="sns-cancellation-dropdown"><option value="">Select</option><option value="unused">I no longer use this product</option><option value="other">Other</option></select><button type="submit">Cancel my subscription</button></form><div class="a-alert-content">Saved successfully</div></div>`);
 dom.window.document.querySelector('a').addEventListener('click',e=>e.preventDefault());
 const run={status:'running',currentIndex:0,runId:'run',reason:"I don't want this item anymore",items:[{...modern('real'),status:'inflight',attempts:1,phase:alreadySubmitted?'confirming':undefined}]};
 const reports=[]; let clicks=0;
 dom.window.chrome={runtime:{sendMessage:(message,reply)=>{ reports.push(message); reply(message.type==='sns:getState'?run:{ok:authorized}); }}};
 dom.window.document.querySelector('form').addEventListener('submit',e=>{e.preventDefault(); clicks++; if(success)dom.window.document.querySelector('.a-alert-content').textContent='Your subscription has been cancelled.';});
 dom.window.SNSUtils.waitFor=async predicate=>predicate();
 dom.window.setTimeout=fn=>{fn();};
 dom.window.eval(fs.readFileSync('content_cancel.js','utf8'));
 await new Promise(resolve=>setImmediate(resolve));
 const value=dom.window.document.querySelector('select').value;
 dom.window.close(); return {clicks,reports,value};
}
test('current cancellation flow selects equivalent reason and submits once after identity authorization',async()=>{
 const result=await cancelFlow(); assert.equal(result.clicks,1); assert.equal(result.value,'unused');
 assert.ok(result.reports.some(x=>x.type==='sns:itemDone'&&x.itemId==='real'&&x.attempt===1));
});
test('mismatched form, wrong tab and already submitted attempt cannot click again',async()=>{
 for(const args of [{sid:'another'},{authorized:false},{alreadySubmitted:true}]) assert.equal((await cancelFlow(args)).clicks,0);
});
test('unrelated success alert is not cancellation proof',async()=>{
 const result=await cancelFlow({success:false}); assert.equal(result.clicks,1);
 assert.equal(result.reports.some(x=>x.type==='sns:itemDone'),false);
 assert.equal(result.reports.some(x=>x.type==='sns:itemFailed'),true);
});

test('manager loads successive infinite-scroll batches and never follows footer See More links', async()=>{
 const dom=page(`<div id="subscriptionsDesktopGridLayout">${tile('SNST0_A','First')}<div id="endOfGridDesktop" data-next-url="/api/page2"></div></div><a href="/b/">See More Ways to Make Money</a>`);
 let batches=0, footerClicks=0, scanned;
 dom.window.HTMLElement.prototype.scrollIntoView=function(){ if(this.id==='endOfGridDesktop'){batches++; this.insertAdjacentHTML('beforebegin',tile(`SNST0_${batches}`,'Next product')); if(batches===2)this.removeAttribute('data-next-url');}};
 dom.window.document.querySelector('a').addEventListener('click',()=>footerClicks++);
 dom.window.scrollTo=()=>{}; dom.window.SNSUtils.sleep=async()=>{};
 dom.window.chrome={runtime:{sendMessage:(message,reply)=>{if(message.type==='sns:scanComplete'){scanned=message.items;reply({ok:true,run:{items:message.items,status:'reviewing'}});}else reply({status:'idle'});}},storage:{local:openUi(),onChanged:{addListener:()=>{}}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(batches,2); assert.equal(scanned.length,3); assert.equal(footerClicks,0); dom.window.close();
});
test('manager does not scan or overwrite choices on cancellation pages',()=>{
 const dom=page(''); dom.reconfigure({url:'https://www.amazon.com/auto-deliveries/cancelSubscription?subscriptionId=real'});
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 assert.equal(dom.window.document.querySelector('#sns-root'),null); dom.window.close();
});

test('an unexpected Amazon response pauses the queue and retains the item for retry', async()=>{
 const item={...modern('real'),keep:false,status:'inflight',attempts:1};
 const w=await worker({sns_run:{status:'running',runId:'run',items:[item,{...modern('next'),keep:false,status:'pending'}],currentIndex:0,tabId:7}});
 await w.send('sns:itemFailed',{itemId:'real',runId:'run',attempt:1,error:'No confirmation'});
 assert.equal(w.storage.sns_run.status,'paused'); assert.equal(w.storage.sns_run.items[0].status,'failed');
 assert.equal(w.storage.sns_saved[0].keep,false); assert.equal(w.timers.length,0);
});
test('new runs never retry a previously confirmed cancellation',async()=>{
 const item={...modern('real'),keep:false,status:'done'};
 const w=await worker({sns_run:{status:'done',items:[item],currentIndex:0,tabId:7}});
 assert.equal((await w.send('sns:startRun')).ok,false); assert.equal(w.storage.sns_run.items[0].status,'done');
});

test('restored choices survive the popup reset and rescan, preserving confirmed history',async()=>{
 const selected={...modern('selected'),keep:true,status:'pending'};
 const done={...modern('done'),keep:false,status:'done',verification:'Confirmed on Amazon'};
 const w=await worker({sns_run:{status:'reviewing',items:[selected,done],tabId:7}});
 const backup={sns_saved:[{...selected,keep:false},{...done,status:'pending'}]};
 assert.equal((await w.send('sns:import',{data:backup})).ok,true);
 assert.equal(w.storage.sns_run.items[0].keep,false);
 await w.send('sns:reset');
 const result=await w.send('sns:scanComplete',{items:[modern('selected'),modern('done')]});
 assert.equal(result.run.items[0].keep,false);
 assert.equal(result.run.items[1].status,'done');
 assert.equal(result.run.items[1].verification,'Confirmed on Amazon');
 assert.deepEqual(w.storage.sns_import_backup,backup);
});

test('resume assigns a replacement tab before authorizing cancellation',async()=>{
 const item={...modern('real'),keep:false,status:'inflight',attempts:1};
 const w=await worker({sns_run:{status:'paused',runId:'run',items:[item],currentIndex:0,tabId:7}},
  {update:async()=>{throw new Error('Tab closed');},create:async()=>({id:8})});
 assert.equal((await w.send('sns:resume')).ok,true);
 assert.equal(w.storage.sns_run.tabId,8);
 assert.equal((await w.send('sns:authorizeStep',{itemId:'real',runId:'run',attempt:2},8)).ok,true);
});

test('navigation failure pauses safely and the message queue remains usable',async()=>{
 const item={...modern('real'),keep:false,status:'inflight',attempts:1};
 const w=await worker({sns_run:{status:'running',runId:'run',items:[item,{...modern('next'),keep:false,status:'pending'}],currentIndex:0,tabId:7}},
  {update:async()=>{throw new Error('Tab closed');},create:async()=>{throw new Error('Browser unavailable');}});
 await w.send('sns:itemDone',{itemId:'real',runId:'run',attempt:1});
 await w.send('sns:getState');
 assert.equal(w.timers.length,1);
 w.timers.shift()();
 const result=await w.send('sns:getState');
 assert.equal(result.status,'paused');
 assert.equal(result.items[0].status,'done');
 assert.equal(result.items[1].keep,false);
 assert.match(result.items[1].error,/could not open/i);
});

test('open review reflects restored choices without rebuilding acknowledged local toggles',async()=>{
 const dom=page(tile('real','Selected product'));
 let changed, current;
 dom.window.scrollTo=()=>{}; dom.window.SNSUtils.sleep=async()=>{};
 dom.window.chrome={runtime:{sendMessage:(message,reply)=>{
  if(message.type==='sns:scanComplete') {
   current={status:'reviewing',items:reconcile(message.items,[])};
   reply({ok:true,run:current});
  } else if(message.type==='sns:setKeep') {
   current={...current,items:current.items.map(item=>({...item,keep:message.keepIds.includes(item.id)}))};
   queueMicrotask(()=>changed({sns_run:{newValue:current}},'local'));
   reply({ok:true});
  } else reply({status:'idle'});
 }},storage:{local:openUi(),onChanged:{addListener:fn=>changed=fn}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 await new Promise(resolve=>setImmediate(resolve));
 const row=dom.window.document.querySelector('#sns-list .sns-item');
 row.click();
 // Choices are written after a 150 ms debounce; wait until the toggle is acknowledged.
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal(dom.window.document.querySelector('#sns-stat-cancel').textContent,'1');
 assert.equal(dom.window.document.querySelector('#sns-list .sns-item'),row);
 current={...current,items:current.items.map(item=>({...item,keep:true}))};
 changed({sns_run:{newValue:current}},'local');
 assert.equal(dom.window.document.querySelector('#sns-stat-cancel').textContent,'0');
 dom.window.close();
});

// ---------- Settings defaults, popup links, progress controls, confirm button ----------
test('fresh install and getOptions use the shared 2–5 s pacing default', async()=>{
 const { DEFAULT_OPTIONS } = globalThis.SNSState;
 assert.deepEqual(DEFAULT_OPTIONS.jitterMs,[2000,5000]);
 const storage={}; let handler, installed;
 const context={console,URL,crypto:require('node:crypto').webcrypto,setTimeout:()=>{},SNSState:globalThis.SNSState,
  chrome:{storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(storage[k])])),set:async p=>Object.assign(storage,structuredClone(p))}},
  runtime:{onMessage:{addListener:fn=>handler=fn},onInstalled:{addListener:fn=>installed=fn}},tabs:{},notifications:{}}};
 vm.runInNewContext(fs.readFileSync('bg.js','utf8').replace("import './state.js';",''),context);
 const opts=await new Promise(r=>handler({type:'sns:getOptions'},{},r));
 assert.deepEqual([...opts.jitterMs],[2000,5000]); assert.equal(opts.reason,DEFAULT_OPTIONS.reason);
 await installed();
 assert.deepEqual(storage.sns_options.jitterMs,[2000,5000]);
});
test('Settings "Restore defaults" saves exactly the shared defaults', async()=>{
 const html=fs.readFileSync('options.html','utf8');
 assert.ok(html.indexOf('src="state.js"')>=0 && html.indexOf('src="state.js"')<html.indexOf('src="options.js"'),'options.html loads state.js first');
 const dom=new JSDOM(html.replace(/<script[^>]*><\/script>/g,''),{runScripts:'outside-only'});
 const sent=[]; let stored={reason:'Other',jitterMs:[700,900]};
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{sent.push(m); if(m.type==='sns:setOptions') stored={...stored,...m.options}; reply(m.type==='sns:getOptions'?stored:{ok:true});}}};
 dom.window.eval(fs.readFileSync('state.js','utf8')); dom.window.eval(fs.readFileSync('options.js','utf8'));
 await new Promise(r=>setTimeout(r,10));
 assert.equal(dom.window.document.getElementById('jitter-min').value,'700');
 dom.window.document.getElementById('reset').click();
 await new Promise(r=>setTimeout(r,10));
 const set=sent.find(m=>m.type==='sns:setOptions');
 assert.deepEqual([...set.options.jitterMs],[...globalThis.SNSState.DEFAULT_OPTIONS.jitterMs]);
 assert.equal(set.options.reason,globalThis.SNSState.DEFAULT_OPTIONS.reason);
 assert.equal(dom.window.document.getElementById('jitter-min').value,'2000');
 assert.equal(dom.window.document.getElementById('jitter-max').value,'5000');
 dom.window.close();
});
test('popup "Open" links only ever point at amazon.com', async()=>{
 const dom=new JSDOM(fs.readFileSync('popup.html','utf8').replace(/<script[^>]*><\/script>/g,''),{runScripts:'outside-only'});
 const items=[{id:'a',title:'Bad link',status:'failed',keep:false,cancelUrl:'javascript:alert(1)'},
  {id:'b',title:'Good link',status:'failed',keep:false,cancelUrl:'https://www.amazon.com/auto-deliveries/cancelSubscription?subscriptionId=b'}];
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>reply(m.type==='sns:getState'?{status:'done',items}:[])},storage:{onChanged:{addListener:()=>{}}},tabs:{}};
 dom.window.eval(fs.readFileSync('popup.js','utf8'));
 await new Promise(r=>setTimeout(r,10));
 const links=[...dom.window.document.querySelectorAll('.fail-link')].map(a=>a.getAttribute('href'));
 assert.deepEqual(links,['https://www.amazon.com/auto-deliveries/subscriptionList','https://www.amazon.com/auto-deliveries/cancelSubscription?subscriptionId=b']);
 dom.window.close();
});
test('progress panel disables Skip while paused (background ignores it then)', async()=>{
 const run=status=>({status,runId:'r',currentIndex:0,items:[{...modern('x'),keep:false,status:status==='paused'?'failed':'inflight'}]});
 for (const [status,disabled] of [['paused',true],['running',false]]) {
  const dom=page(''); let current=run(status);
  dom.window.chrome={runtime:{sendMessage:(m,reply)=>reply(current)},storage:{onChanged:{addListener:()=>{}}}};
  dom.window.eval(fs.readFileSync('content_progress.js','utf8'));
  await new Promise(r=>setTimeout(r,500));
  assert.equal(dom.window.document.getElementById('sns-skip').disabled,disabled,status);
  dom.window.close();
 }
});
test('double-clicking the confirm button starts only one run', async()=>{
 const dom=page(`<div id="subscriptionsDesktopGridLayout">${tile('SNST0_A','First')}${tile('SNST0_B','Second')}</div>`);
 dom.window.scrollTo=()=>{}; dom.window.SNSUtils.sleep=async()=>{};
 let starts=0, finishStart;
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{
  if(m.type==='sns:scanComplete') return reply({ok:true,run:{status:'reviewing',items:m.items.map(i=>({...i,keep:false,status:'pending'}))}});
  if(m.type==='sns:startRun'){starts++; finishStart=()=>reply({ok:false,error:'Navigation failed'}); return;}
  reply(m.type==='sns:getState'?{status:'idle'}:{ok:true});
 }},storage:{local:openUi(),onChanged:{addListener:()=>{}}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 for(let i=0;i<50&&!dom.window.document.querySelector('#sns-preview:not([disabled])');i++) await new Promise(r=>setTimeout(r,20));
 dom.window.document.getElementById('sns-preview').click();
 const confirm=dom.window.document.getElementById('sns-confirm-run');
 confirm.click(); confirm.click();
 await new Promise(r=>setTimeout(r,20));
 assert.equal(starts,1); assert.equal(confirm.disabled,true);
 finishStart(); await new Promise(r=>setTimeout(r,20));
 assert.equal(confirm.disabled,false,'re-enabled after an error so the user can retry');
 assert.match(dom.window.document.getElementById('sns-modal-error').textContent,/Navigation failed/);
 dom.window.close();
});

// ---------- Startup flicker, loading/error states, stability (v2.1.1 round 3) ----------
const tick=(ms=0)=>new Promise(r=>setTimeout(r,ms));
function managerPage(tiles, handler, { scanDelay=0 } = {}) {
 const dom=page(`<div id="subscriptionsDesktopGridLayout">${tiles}</div>`);
 dom.window.scrollTo=()=>{}; dom.window.SNSUtils.sleep=async()=>{};
 const sent=[]; let changed;
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{sent.push(m); const r=handler(m,reply); if(r!==undefined) setTimeout(()=>reply(r),m.type==='sns:scanComplete'?scanDelay:0);}},storage:{local:openUi(),onChanged:{addListener:fn=>changed=fn}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 return {dom,sent,doc:dom.window.document,fire:v=>changed({sns_run:{newValue:v}},'local')};
}
// Waits until the panel has finished its scan (or the timeout), so tests don't
// depend on how fast a loaded machine runs the scan's timers.
async function settled(doc,ms=1000){ for(let t=0;t<ms;t+=10){ const c=doc.querySelector('.sns-card'); if(doc.getElementById('sns-launcher')||(c&&c.getAttribute('aria-busy')==='false')) break; await tick(10);} await tick(5); }
const reviewing=(items)=>({ok:true,run:{status:'reviewing',items:reconcile(items,[])}});

test('while scanning the panel shows a loading state, never "No subscriptions found"', async()=>{
 const {dom,doc}=managerPage(tile('SNST0_A','First'),(m)=>m.type==='sns:scanComplete'?reviewing(m.items):(m.type==='sns:getState'?{status:'idle'}:{ok:true}),{scanDelay:60});
 await tick(20);
 const card=doc.querySelector('.sns-card');
 assert.ok(doc.querySelector('.sns-skeleton'),'skeleton rows while loading');
 assert.equal(doc.querySelector('.sns-empty'),null,'no empty state during the scan');
 assert.equal(card.getAttribute('aria-busy'),'true');
 assert.equal(doc.getElementById('sns-scan-note').hidden,false);
 assert.match(doc.getElementById('sns-scan-note').getAttribute('aria-live'),/polite/);
 await tick(120);
 assert.equal(doc.querySelectorAll('.sns-item').length,1);
 assert.equal(doc.querySelector('.sns-card'),card,'the card element (and its entrance animation) is mounted once');
 assert.equal(card.getAttribute('aria-busy'),'false');
 assert.equal(doc.getElementById('sns-scan-note').hidden,true);
 dom.window.close();
});
test('an empty scan shows the empty state with a working "Scan again"', async()=>{
 let scans=0;
 const {dom,doc}=managerPage('',(m)=>{ if(m.type==='sns:scanComplete'){scans++; return reviewing(m.items);} return m.type==='sns:getState'?{status:'idle'}:{ok:true}; });
 await tick(30);
 assert.ok(doc.querySelector('.sns-empty'));
 doc.getElementById('sns-retry').click();
 await tick(30);
 assert.equal(scans,2);
 dom.window.close();
});
test('an unreachable extension shows an error with retry instead of hanging in "Scanning"', async()=>{
 let fail=true;
 const {dom,doc}=managerPage(tile('SNST0_A','First'),(m)=>{
  if(m.type==='sns:scanComplete'){ if(fail) throw new Error('Extension context invalidated.'); return reviewing(m.items); }
  return m.type==='sns:getState'?{status:'idle'}:{ok:true};
 });
 await tick(30);
 assert.ok(doc.querySelector('.sns-empty--error'),'error state shown');
 assert.match(doc.getElementById('sns-error-msg').textContent,/reload|reach/i);
 assert.equal(doc.querySelector('.sns-card').getAttribute('aria-busy'),'false');
 fail=false; doc.getElementById('sns-retry').click();
 await tick(30);
 assert.equal(doc.querySelectorAll('.sns-item').length,1);
 dom.window.close();
});
test('a background error during scan is shown, not a list of unsaved items', async()=>{
 const {dom,doc}=managerPage(tile('SNST0_A','First'),(m)=>m.type==='sns:scanComplete'?{ok:false,error:'A cancellation run is already active.'}:(m.type==='sns:getState'?{status:'idle'}:{ok:true}));
 await tick(30);
 assert.equal(doc.querySelectorAll('.sns-item').length,0);
 assert.match(doc.getElementById('sns-error-msg').textContent,/already active/);
 dom.window.close();
});
test('rows are reused across filters, echoes and toggles (thumbnails never reload)', async()=>{
 let current;
 const {dom,doc,fire}=managerPage(tile('SNST0_A','First')+tile('SNST0_B','Second'),(m)=>{
  if(m.type==='sns:scanComplete'){ const r=reviewing(m.items); current=r.run; return r; }
  return m.type==='sns:getState'?{status:'idle'}:{ok:true};
 });
 await settled(doc);
 const rows=[...doc.querySelectorAll('.sns-item')], imgs=rows.map(r=>r.querySelector('img,.sns-item__thumb--placeholder'));
 doc.querySelector('.sns-filter[data-filter="cancel"]').click();
 assert.equal(doc.querySelectorAll('.sns-item').length,0);
 doc.querySelector('.sns-filter[data-filter="all"]').click();
 fire(current); // background echo with identical choices
 const after=[...doc.querySelectorAll('.sns-item')];
 assert.equal(after.length,rows.length);
 after.forEach((r,i)=>{ assert.equal(r,rows[i],'same row element'); assert.equal(r.querySelector('img,.sns-item__thumb--placeholder'),imgs[i],'same thumbnail element'); });
 dom.window.close();
});
test('rapid toggles are written once, and an older echo does not undo newer clicks', async()=>{
 let current;
 const {dom,doc,sent,fire}=managerPage(tile('SNST0_A','First')+tile('SNST0_B','Second')+tile('SNST0_C','Third'),(m)=>{
  if(m.type==='sns:scanComplete'){ const r=reviewing(m.items); current=r.run; return r; }
  return m.type==='sns:getState'?{status:'idle'}:{ok:true};
 });
 await settled(doc);
 const rows=()=>[...doc.querySelectorAll('.sns-item')];
 rows()[0].click(); rows()[1].click(); rows()[2].click();
 assert.equal(doc.getElementById('sns-stat-cancel').textContent,'3');
 // An echo of the state before these clicks arrives while the write is pending.
 fire(current);
 assert.equal(doc.getElementById('sns-stat-cancel').textContent,'3','older echo must not revert local clicks');
 assert.equal(sent.filter(m=>m.type==='sns:setKeep').length,0,'debounced');
 await tick(250);
 const writes=sent.filter(m=>m.type==='sns:setKeep');
 assert.equal(writes.length,1); assert.deepEqual(writes[0].keepIds,[]);
 dom.window.close();
});
test('starting a run flushes pending choices first and shows a busy confirm button', async()=>{
 let finishStart;
 const {dom,doc,sent}=managerPage(tile('SNST0_A','First')+tile('SNST0_B','Second'),(m,reply)=>{
  if(m.type==='sns:scanComplete') return reviewing(m.items);
  if(m.type==='sns:startRun'){ finishStart=()=>reply({ok:true}); return undefined; }
  return m.type==='sns:getState'?{status:'idle'}:{ok:true};
 });
 await settled(doc);
 doc.querySelector('.sns-item').click();
 doc.getElementById('sns-preview').click();
 doc.getElementById('sns-confirm-run').click();
 await tick(10);
 const types=sent.map(m=>m.type).filter(t=>t==='sns:setKeep'||t==='sns:startRun');
 assert.deepEqual(types,['sns:setKeep','sns:startRun'],'choices are saved before the run starts');
 assert.deepEqual(sent.find(m=>m.type==='sns:setKeep').keepIds,['SNST0_B']);
 const btn=doc.getElementById('sns-confirm-run');
 assert.equal(btn.getAttribute('aria-busy'),'true'); assert.match(btn.textContent,/Starting/); assert.ok(btn.querySelector('.sns-spinner'));
 finishStart(); await tick(10);
 await tick(250);
 assert.equal(sent.filter(m=>m.type==='sns:setKeep').length,1,'no second, late write after the flush');
 dom.window.close();
});
test('content scripts boot once even if injected twice', async()=>{
 const {dom,doc}=managerPage(tile('SNST0_A','First'),(m)=>m.type==='sns:scanComplete'?reviewing(m.items):(m.type==='sns:getState'?{status:'idle'}:{ok:true}));
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 await tick(30);
 assert.equal(doc.querySelectorAll('#sns-root').length,1); assert.equal(doc.querySelectorAll('.sns-card').length,1);
 dom.window.close();
});
test('progress panel updates in place, renders once per frame, and its buttons still work', async()=>{
 const dom=page(''); const sent=[]; let changed;
 const run=(i)=>({status:'running',runId:'r',currentIndex:i,items:[0,1,2].map(k=>({...modern('x'+k,'Item '+k),keep:false,status:k<i?'done':k===i?'inflight':'pending'}))});
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{sent.push(m.type); reply(m.type==='sns:getState'?run(0):{ok:true});}},storage:{onChanged:{addListener:fn=>changed=fn}}};
 dom.window.eval(fs.readFileSync('content_progress.js','utf8'));
 await tick(450);
 const panel=dom.window.document.querySelector('.sns-progress');
 assert.ok(panel);
 let writes=0; new dom.window.MutationObserver(()=>writes++).observe(panel,{childList:true});
 changed({sns_run:{newValue:run(1)}},'local'); changed({sns_run:{newValue:run(2)}},'local');
 await tick(40);
 assert.equal(dom.window.document.querySelector('.sns-progress'),panel,'same element, no re-entrance animation');
 assert.equal(writes,1,'two writes in one frame render once');
 assert.match(panel.textContent,/Item 2/);
 dom.window.document.getElementById('sns-pause').click();
 await tick(5);
 assert.ok(sent.includes('sns:pause'));
 dom.window.close();
});
test('progress panel explains a lost connection after the extension is reloaded', async()=>{
 const dom=page(''); let alive=true;
 const run={status:'running',runId:'r',currentIndex:0,items:[{...modern('x'),keep:false,status:'inflight'}]};
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{ if(!alive) throw new Error('Extension context invalidated.'); reply(run); }},storage:{onChanged:{addListener:()=>{}}}};
 dom.window.eval(fs.readFileSync('content_progress.js','utf8'));
 await tick(450);
 alive=false;
 dom.window.document.getElementById('sns-pause').click();
 await tick(10);
 assert.match(dom.window.document.querySelector('.sns-progress').textContent,/Reload the page/);
 dom.window.close();
});
test('a worker restart between items pauses the stalled run; resume continues and clears the note', async()=>{
 const items=[{...modern('a'),keep:false,status:'done',attempts:1},{...modern('b'),keep:false,status:'pending'}];
 const w=await worker({sns_run:{status:'running',runId:'r',items,currentIndex:0,tabId:7}});
 await tick(5);
 assert.equal(w.storage.sns_run.status,'paused');
 assert.match(w.storage.sns_run.pausedReason,/restarted/);
 const r=await w.send('sns:resume');
 assert.equal(w.storage.sns_run.status,'running'); assert.equal(w.storage.sns_run.currentIndex,1);
 assert.equal(w.storage.sns_run.pausedReason,undefined); assert.ok(r.ok!==false);
});
test('a worker restart with an item in flight leaves the run alone', async()=>{
 const items=[{...modern('a'),keep:false,status:'inflight',attempts:1}];
 const w=await worker({sns_run:{status:'running',runId:'r',items,currentIndex:0,tabId:7}});
 await tick(5);
 assert.equal(w.storage.sns_run.status,'running');
 assert.equal(w.storage.sns_run.pausedReason,undefined);
});
test('popup renders once after reading state, and offers retry when the background is unreachable', async()=>{
 const dom=new JSDOM(fs.readFileSync('popup.html','utf8').replace(/<script[^>]*><\/script>/g,''),{runScripts:'outside-only'});
 let up=false;
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{ if(!up) throw new Error('Could not establish connection.'); reply(m.type==='sns:getState'?{status:'reviewing',items:[{...modern('a'),keep:false,status:'pending'}]}:[]); }},storage:{onChanged:{addListener:()=>{}}},tabs:{}};
 dom.window.eval(fs.readFileSync('popup.js','utf8'));
 await tick(10);
 const d=dom.window.document;
 assert.match(d.getElementById('status-text').textContent,/Couldn't read/);
 assert.equal(d.getElementById('btn-retry').hidden,false);
 assert.equal(d.body.getAttribute('aria-busy'),'false');
 up=true; d.getElementById('btn-retry').click();
 await tick(10);
 assert.match(d.getElementById('status-text').textContent,/ready to review/);
 assert.equal(d.getElementById('btn-retry').hidden,true);
 assert.equal(d.getElementById('stat-active').textContent,'1');
 dom.window.close();
});

// ---------- v2.1.2: launcher, explainer, finish summary, flicker ----------
const css=fs.readFileSync('ui/panel.css','utf8');
const rule=sel=>{ const m=css.match(new RegExp('(^|\\n)'+sel.replace(/[.#]/g,'\\$&')+'\\s*\\{([^}]*)\\}')); return m?m[2]:''; };
function uiStore(initial){ const store={sns_ui:initial}; return {store,local:{get:async k=>({[k]:structuredClone(store[k])}),set:async p=>Object.assign(store,structuredClone(p))}}; }
function managerWith(local, handler){
 const dom=page(`<div id="subscriptionsDesktopGridLayout">${tile('SNST0_A','First')}${tile('SNST0_B','Second')}${tile('SNST0_C','Third')}</div>`);
 dom.window.scrollTo=()=>{}; dom.window.SNSUtils.sleep=async()=>{};
 const sent=[]; let changed;
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>{sent.push(m); const r=handler(m); if(r!==undefined) setTimeout(()=>reply(r),0);}},storage:{local,onChanged:{addListener:fn=>changed=fn}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 return {dom,doc:dom.window.document,sent,fire:v=>changed({sns_run:{newValue:v}},'local'),fireUi:v=>changed({sns_ui:{newValue:v}},'local')};
}
const idleHandler=m=>m.type==='sns:scanComplete'?reviewing(m.items):(m.type==='sns:getState'?{status:'idle'}:{ok:true});

test('the panel starts as a small launcher, opens on click, and remembers that it was open', async()=>{
 const {store,local}=uiStore(undefined);
 let {dom,doc}=managerWith(local,idleHandler);
 await settled(doc);
 assert.equal(doc.querySelector('.sns-card'),null,'no panel over the page by default');
 const launcher=doc.getElementById('sns-launcher');
 assert.ok(launcher); assert.equal(launcher.tagName,'BUTTON'); assert.equal(launcher.getAttribute('aria-expanded'),'false');
 assert.match(launcher.textContent,/3 subscriptions · Review/);
 launcher.click(); await tick(5);
 assert.ok(doc.querySelector('.sns-card'),'opens the panel');
 assert.equal(doc.activeElement,doc.getElementById('sns-panel-title'),'focus moves into the panel');
 assert.equal(store.sns_ui.panelOpen,true,'open state is saved');
 dom.window.close();
 ({dom,doc}=managerWith(local,idleHandler)); await settled(doc);
 assert.ok(doc.querySelector('.sns-card'),'reopens open on the next visit');
 doc.getElementById('sns-minimize').click(); await tick(5);
 assert.equal(doc.querySelector('.sns-card'),null); assert.ok(doc.getElementById('sns-launcher'));
 assert.equal(doc.activeElement,doc.getElementById('sns-launcher'),'focus returns to the launcher');
 assert.equal(store.sns_ui.panelOpen,false,'closed state is saved');
 dom.window.close();
});
test('launcher cannot be squashed: it positions itself against the viewport and never wraps', ()=>{
 const launcher=rule('.sns-launcher');
 assert.match(launcher,/position:\s*fixed/); assert.match(launcher,/white-space:\s*nowrap/);
 assert.doesNotMatch(rule('#sns-root'),/inset:\s*0 0 0 auto/,'no zero-width sidebar anchor');
 assert.doesNotMatch(css,/\.sns-pill\b/,'old pill styles are gone');
});
test('"How it works" shows on first open, "Got it" dismisses it for good, and "?" reopens it', async()=>{
 const {store,local}=uiStore({panelOpen:true});
 let {dom,doc}=managerWith(local,idleHandler); await settled(doc);
 const how=doc.getElementById('sns-how');
 assert.equal(how.hidden,false,'shown the first time');
 assert.equal(how.querySelectorAll('li').length,3);
 assert.match(how.textContent,/Pick what to keep[\s\S]*Review and confirm[\s\S]*one at a time[\s\S]*pause anytime/);
 const help=doc.getElementById('sns-help');
 assert.equal(help.getAttribute('aria-label'),'How it works'); assert.equal(help.getAttribute('aria-expanded'),'true');
 doc.getElementById('sns-how-done').click(); await tick(5);
 assert.equal(how.hidden,true); assert.equal(store.sns_ui.howSeen,true); assert.equal(help.getAttribute('aria-expanded'),'false');
 help.click(); assert.equal(how.hidden,false,'"?" reopens it');
 help.click(); assert.equal(how.hidden,true);
 dom.window.close();
 ({dom,doc}=managerWith(local,idleHandler)); await settled(doc);
 assert.equal(doc.getElementById('sns-how').hidden,true,'not shown again after Got it');
 dom.window.close();
});
test('rows say Keep or Cancel in words, and the confirm step states exactly what will happen', async()=>{
 const {local}=uiStore({panelOpen:true,howSeen:true});
 const {dom,doc}=managerWith(local,m=>m.type==='sns:getOptions'?{jitterMs:[2000,5000]}:idleHandler(m)); await settled(doc);
 const rows=[...doc.querySelectorAll('.sns-item')];
 const visibleChoice=r=>r.classList.contains('sns-item--kept')?'Keep':'Cancel';
 assert.deepEqual(rows.map(visibleChoice),['Keep','Keep','Keep'],'everything starts as Keep');
 rows[0].click(); rows[1].click();
 assert.equal(rows[0].getAttribute('aria-pressed'),'true');
 assert.equal(doc.getElementById('sns-preview').textContent,'Review & cancel 2');
 doc.getElementById('sns-preview').click(); await tick(5);
 assert.equal(doc.getElementById('sns-modal-title').textContent,'Cancel 2 subscriptions, keep 1.');
 assert.match(doc.getElementById('sns-modal-lede').textContent,/You can pause anytime/);
 assert.equal(doc.querySelectorAll('.sns-modal__list:not(.sns-modal__list--keep) li').length,2);
 assert.equal(doc.querySelectorAll('.sns-modal__list--keep li').length,1);
 assert.match(doc.getElementById('sns-pace').textContent,/2–5 second/);
 assert.equal(doc.querySelector('.sns-modal').getAttribute('aria-modal'),'true');
 doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(doc.getElementById('sns-modal'),null,'Escape closes it');
 assert.equal(doc.activeElement,doc.getElementById('sns-preview'),'focus returns to the button that opened it');
 dom.window.close();
});
test('while a finish summary is showing the review panel stays out of the way, then comes back after Done', async()=>{
 const {local}=uiStore({panelOpen:true,howSeen:true});
 const done={status:'done',items:[{...modern('SNST0_A'),keep:false,status:'done'},{...modern('SNST0_B'),keep:true,status:'pending'}]};
 let status='done';
 const {dom,doc,sent,fire}=managerWith(local,m=>m.type==='sns:getState'?(status==='done'?done:{status:'idle'}):idleHandler(m));
 await settled(doc);
 assert.equal(doc.getElementById('sns-root').children.length,0,'nothing covers the finish summary');
 assert.equal(sent.some(m=>m.type==='sns:scanComplete'),false,'the summary is not replaced by a rescan');
 // The run finishing in place on the last item's page behaves the same.
 fire({...done,status:'running'}); fire(done);
 assert.equal(doc.getElementById('sns-root').children.length,0);
 status='reviewing'; fire({...done,status:'reviewing'}); // Done pressed
 await settled(doc);
 assert.ok(sent.some(m=>m.type==='sns:scanComplete'),'rescans what is left on the page');
 assert.ok(doc.querySelector('.sns-card'),'panel returns as the user left it');
 dom.window.close();
});
function progressPage(run,{storageRun=run,reply=true}={}){
 const dom=page(''); const sent=[];
 dom.window.chrome={runtime:{sendMessage:(m,cb)=>{sent.push(m.type); if(reply) cb(m.type==='sns:getState'?run:{ok:true});}},
  storage:{local:{get:async()=>({sns_run:storageRun})},onChanged:{addListener:()=>{}}}};
 dom.window.eval(fs.readFileSync('content_progress.js','utf8'));
 return {dom,doc:dom.window.document,sent};
}
test('the progress card is restored at once from saved state on every page load, without an entrance animation', async()=>{
 const run={status:'running',runId:'r',currentIndex:1,startedAt:Date.now()-20000,jitterMs:[2000,5000],items:[{...modern('a','First'),keep:false,status:'done'},{...modern('b','Second'),keep:false,status:'inflight'},{...modern('c','Third'),keep:false,status:'pending'},{...modern('d','Kept one'),keep:true,status:'pending'}]};
 const {dom,doc}=progressPage(run,{reply:false}); // the background has not answered yet
 await tick(5);
 const panel=doc.querySelector('.sns-progress');
 assert.ok(panel,'drawn from chrome.storage.local within a few ms, not after a 400 ms delay');
 assert.ok(panel.classList.contains('sns-progress--restored'));
 assert.doesNotMatch(rule('.sns-progress'),/animation/,'no fade/slide-in to replay on each item');
 assert.match(doc.querySelector('.sns-progress__count').textContent,/^2 of 3$/);
 assert.match(doc.querySelector('.sns-progress__title').textContent,/Second/);
 assert.match(doc.querySelector('.sns-progress__meta').textContent,/About 40 sec left · 1 cancelled · 1 kept/);
 assert.match(panel.textContent,/pause anytime/);
 dom.window.close();
});
test('manifest injects the progress card at document_start without changing matches or permissions', ()=>{
 const m=JSON.parse(fs.readFileSync('manifest.json','utf8'));
 assert.equal(m.version,'2.1.2');
 assert.deepEqual(m.permissions,['storage','notifications']); assert.deepEqual(m.host_permissions,['https://www.amazon.com/*']);
 const entry=m.content_scripts.find(e=>e.js.includes('content_progress.js'));
 assert.equal(entry.run_at,'document_start');
 assert.equal(m.content_scripts.filter(e=>e.js.includes('content_progress.js')).length,1);
 const allMatches=new Set(m.content_scripts.flatMap(e=>e.matches));
 assert.deepEqual([...allMatches].sort(),['https://www.amazon.com/auto-deliveries*','https://www.amazon.com/auto-deliveries/subscriptionList*','https://www.amazon.com/gp/subscribe-and-save/*','https://www.amazon.com/gp/subscribe-and-save/manager/viewsubscriptions*']);
 assert.deepEqual(entry.matches,m.content_scripts.find(e=>e.js.includes('content_cancel.js')).matches,'same pages as before');
});
test('the finish summary lists what was cancelled, kept and failed, and links to Amazon to double-check', async()=>{
 const run={status:'done',runId:'r',currentIndex:2,items:[{...modern('a','Paper towels'),keep:false,status:'done'},{...modern('b','Coffee'),keep:true,status:'pending'},{...modern('c','Dish soap'),keep:false,status:'failed',error:'No confirmation shown'}]};
 const {dom,doc,sent}=progressPage(run);
 await tick(10);
 const panel=doc.querySelector('.sns-progress');
 assert.match(doc.querySelector('.sns-progress__title').textContent,/1 cancelled, 1 kept, 1 failed/);
 const sections=[...panel.querySelectorAll('details.sns-sum')].map(d=>d.querySelector('summary').textContent);
 assert.deepEqual(sections,['Needs attention (1)','Cancelled (1)','Kept (1)']);
 assert.match(panel.textContent,/Dish soap[\s\S]*No confirmation shown/);
 assert.ok(panel.querySelector('details.sns-sum').open,'problems are shown first, expanded');
 const link=doc.getElementById('sns-check-amazon');
 assert.equal(link.getAttribute('href'),'https://www.amazon.com/auto-deliveries/subscriptionList');
 assert.equal(link.getAttribute('target'),'_blank'); assert.match(link.getAttribute('rel'),/noopener/);
 doc.getElementById('sns-dismiss').click(); await tick(5);
 assert.ok(sent.includes('sns:reset'),'Done clears the summary');
 dom.window.close();
});
test('time left reads naturally', ()=>{
 const dom=page(''); dom.window.chrome={runtime:{sendMessage:()=>{}},storage:{onChanged:{addListener:()=>{}}}};
 dom.window.eval(fs.readFileSync('content_progress.js','utf8'));
 const {timeLeftText}=dom.window.SNSProgress; const now=1e12;
 const s=(done,total)=>({cancelled:done,failed:0,skipped:0,totalToProcess:total});
 assert.equal(timeLeftText({startedAt:now-5000},s(1,2),now),'A few seconds left');
 assert.equal(timeLeftText({startedAt:now-30000},s(1,3),now),'About 1 min left');
 assert.equal(timeLeftText({startedAt:now-10000},s(1,4),now),'About 30 sec left');
 assert.equal(timeLeftText({startedAt:now-600000},s(5,10),now),'About 10 min left');
 assert.equal(timeLeftText({jitterMs:[2000,5000]},s(0,2),now),'About 15 sec left','estimate before the first item finishes');
 assert.equal(timeLeftText({startedAt:now},s(3,3),now),'');
 dom.window.close();
});
test('popup and options use plain labels and show the new version', async()=>{
 const popup=fs.readFileSync('popup.html','utf8');
 assert.match(popup,/How it works/); assert.match(popup,/v2\.1\.2/);
 const dom=new JSDOM(popup.replace(/<script[^>]*><\/script>/g,''),{runScripts:'outside-only'});
 dom.window.chrome={runtime:{sendMessage:(m,reply)=>reply(m.type==='sns:getState'?{status:'done',items:[{...modern('a'),keep:false,status:'done'},{...modern('b'),keep:true,status:'pending'}]}:[])},storage:{onChanged:{addListener:()=>{}}},tabs:{}};
 dom.window.eval(fs.readFileSync('popup.js','utf8')); await tick(10);
 assert.equal(dom.window.document.getElementById('status-text').textContent,'Last run: 1 cancelled, 1 kept');
 dom.window.close();
 const options=fs.readFileSync('options.html','utf8');
 assert.match(options,/<label class="field-heading" for="reason">/); assert.match(options,/v2\.1\.2/);
});
