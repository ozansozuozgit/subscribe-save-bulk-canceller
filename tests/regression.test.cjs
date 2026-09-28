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
 dom.window.chrome={runtime:{sendMessage:(message,reply)=>{if(message.type==='sns:scanComplete'){scanned=message.items;reply({ok:true,run:{items:message.items,status:'reviewing'}});}else reply({status:'idle'});}},storage:{onChanged:{addListener:()=>{}}}};
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
 }},storage:{onChanged:{addListener:fn=>changed=fn}}};
 dom.window.eval(fs.readFileSync('content_manager.js','utf8'));
 await new Promise(resolve=>setImmediate(resolve));
 const row=dom.window.document.querySelector('#sns-list .sns-item');
 row.click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(dom.window.document.querySelector('#sns-stat-cancel').textContent,'1');
 assert.equal(dom.window.document.querySelector('#sns-list .sns-item'),row);
 current={...current,items:current.items.map(item=>({...item,keep:true}))};
 changed({sns_run:{newValue:current}},'local');
 assert.equal(dom.window.document.querySelector('#sns-stat-cancel').textContent,'0');
 dom.window.close();
});
