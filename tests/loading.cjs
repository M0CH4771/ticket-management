const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const script=fs.readFileSync(__dirname+'/../docs/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const modal={open:false,close(){this.open=false}},reload={disabled:false,textContent:''};
const pending=[];let renders=0;
const c=vm.createContext({console,sessionStorage:{removeItem(){}},localStorage:{getItem:()=>'',removeItem(){},setItem(){}},document:{getElementById:id=>id==='modal'?modal:id==='reload'?reload:null,querySelectorAll:()=>[]},window:{scrollY:0,scrollTo(){}},history:{pushState(){}},location:{pathname:'/',search:''}});
vm.runInContext(script.slice(0,script.indexOf('function showSetup()')),c);
c.notice=()=>{};c.cacheSnapshot=()=>{};c.render=()=>renders++;
c.rpc=(...args)=>new Promise((resolve,reject)=>pending.push({args,resolve,reject}));
const fixture={me:{id:'me'},lives:[{id:'event',title:'前回',date:'2099-01-01',groups:[]}],members:[],tickets:[],attendance:[],groups:[],updatedAt:'2026-09-20'};
c.fixture=fixture;vm.runInContext("memberId='me';data=fixture;cachedView=true;",c);
(async()=>{
  const read=c.refresh();assert.equal(pending.length,1);assert.equal(vm.runInContext('busy',c),false);
  c.openEvent('event');assert.equal(renders,1); // Previous snapshot remains interactive.
  const duplicate=c.refresh();await duplicate;assert.equal(pending.length,1);
  modal.open=true;pending.shift().resolve({...fixture,lives:[{...fixture.lives[0],title:'最新'}]});await read;
  assert.equal(renders,1);assert.equal(modal.open,true); // Inputs were not rebuilt.
  assert.equal(vm.runInContext('data.lives[0].title',c),'最新');assert.equal(reload.disabled,false);
  modal.open=false;
  const oldRead=c.refresh();const oldRequest=pending.shift();
  const saving=c.save('live',{id:'event'});const saveRequest=pending.shift();
  assert.equal(saveRequest.args[0],'saveData');assert.equal(vm.runInContext('busy',c),true);
  saveRequest.resolve({kind:'patch-v1',changes:{Lives:{upsert:[{...fixture.lives[0],title:'保存済み'}],remove:[]}},savedAt:'now'});await saving;
  oldRequest.resolve(fixture);await oldRead;
  assert.equal(vm.runInContext('data.lives[0].title',c),'保存済み'); // Late read cannot undo save.
  const failed=c.refresh();pending.shift().reject(new Error('offline'));await failed;
  assert.equal(vm.runInContext('data.lives[0].title',c),'保存済み');assert.equal(reload.disabled,false);
  const wrongMember=c.refresh();const request=pending.shift();c.rememberMember('other');request.resolve(fixture);await wrongMember;
  assert.equal(vm.runInContext('data.lives[0].title',c),'保存済み');
  console.log('PASS: nonblocking cached navigation, no duplicate loads, preserve open form, stale response cannot overwrite save/member switch, offline retry');
})().catch(error=>{console.error(error);process.exitCode=1});
