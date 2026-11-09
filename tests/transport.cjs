const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
let handler,frame,seq=0,timer=0;const timers=new Map(),sent=[];
const peer={postMessage:(message,origin)=>sent.push({message,origin})};
const context={URL,Set,Map,Promise,Error,crypto:{randomUUID:()=>`00000000-0000-0000-0000-${String(++seq).padStart(12,'0')}`},setTimeout:(cb)=>{timers.set(++timer,cb);return timer},clearTimeout:id=>timers.delete(id),window:{LivePocketAuth:{getIdToken:async()=>'test-id-token'},LIVE_POCKET_CONFIG:{gasUrl:'https://script.google.com/macros/s/example/exec'},addEventListener:(_,fn)=>handler=fn,removeEventListener(){}},document:{createElement:()=>({setAttribute(){},remove(){}}),body:{appendChild:x=>frame=x}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/../docs/transport.js','utf8'),context);
const result=context.window.LivePocketTransport.call('getMembers');
await new Promise(setImmediate);
const channel=new URL(frame.src).searchParams.get('channel');
handler({origin:'https://evil.example',source:peer,data:{type:'live-pocket-ready',channel}});
assert.equal(sent.length,0);
handler({origin:'https://n-test-script.googleusercontent.com',source:peer,data:{type:'live-pocket-ready',channel}});
await new Promise(setImmediate);assert.equal(sent.length,1);
const request=sent[0].message;assert.equal(request.args[0],'test-id-token'); // ID token is passed only as an RPC argument.
assert.ok(!frame.src.includes('test-id-token'));let done=false;result.then(()=>done=true);
handler({origin:sent[0].origin,source:{},data:{type:'live-pocket-result',channel,id:request.id,ok:true,value:'bad'}});
await new Promise(setImmediate);assert.equal(done,false);
handler({origin:sent[0].origin,source:peer,data:{type:'live-pocket-result',channel,id:request.id,ok:true,value:[{id:'1',name:'test'}]}});
assert.equal((await result)[0].name,'test');
const mutation=context.window.LivePocketTransport.call('saveData','1','attendance',{});await new Promise(setImmediate);
const timeout=[...timers.values()][0];timeout();await assert.rejects(mutation,/登録済みの可能性/);assert.equal(sent.length,2);
await assert.rejects(context.window.LivePocketTransport.call('setup_'),/未対応/);
let bridgeListener;const calls=[],replies=[];const top={postMessage:(m,o)=>replies.push({m,o})};
const runner={withSuccessHandler(fn){this.success=fn;return this},withFailureHandler(){return this},getMembers(){calls.push('getMembers');this.success([{id:'1',name:'test'}])}};
const bridge={window:{top,addEventListener:(_,fn)=>bridgeListener=fn},google:{script:{run:runner}},Set,JSON};vm.createContext(bridge);
let code=fs.readFileSync(__dirname+'/../Bridge.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace('<?!= JSON.stringify(channel) ?>',JSON.stringify(channel)).replace('<?!= JSON.stringify(parentOrigin) ?>',JSON.stringify('https://m0ch4771.github.io'));
vm.runInContext(code,bridge);
const message={type:'live-pocket-call',channel,id:request.id,method:'getMembers',args:[]};
bridgeListener({origin:'https://evil.example',source:top,data:message});assert.equal(calls.length,0);
bridgeListener({origin:'https://m0ch4771.github.io',source:top,data:message});assert.equal(calls.length,1);
bridgeListener({origin:'https://m0ch4771.github.io',source:top,data:message});assert.equal(calls.length,1);
assert.equal(replies[1].m.ok,true);assert.equal(replies[1].o,'https://m0ch4771.github.io');
// Calls made while sign-in is still starting wait for it instead of failing.
{let release;const ready=new Promise(r=>release=r);delete context.window.LivePocketAuth;context.window.LivePocketAuthReady=ready;
const before=sent.length;const waiting=context.window.LivePocketTransport.call('getData','1');await new Promise(setImmediate);assert.equal(sent.length,before);
let asked=0;release({getIdToken:async()=>{asked++;return 'late-token'}});for(let i=0;i<5;i++)await new Promise(setImmediate);assert.equal(asked,1);
context.window.LivePocketAuthReady=undefined;await assert.rejects(context.window.LivePocketTransport.call('getData','1'),/ログイン/);
assert.equal(typeof context.window.LivePocketTransport.warm,'function');}
// Cloudflare API: plain HTTPS POST with the token in the Authorization header, never in the body or URL.
{const requests=[];const api={...context,window:{LivePocketAuth:{getIdToken:async()=>'api-token'},LIVE_POCKET_CONFIG:{apiUrl:'https://api.example.workers.dev/'},addEventListener(){},removeEventListener(){}},
 document:{createElement:()=>({}),head:{appendChild(){}},body:{appendChild(){}}},AbortController,
 fetch:async(url,init)=>{requests.push({url,init});return {json:async()=>JSON.parse(init.body).method==='saveData'?{ok:false,error:'他の更新がありました。再読込してください'}:{ok:true,value:{echo:JSON.parse(init.body)}}}}};
vm.createContext(api);vm.runInContext(fs.readFileSync(__dirname+'/../docs/transport.js','utf8'),api);
const value=await api.window.LivePocketTransport.call('getData','member-1');
assert.equal(requests[0].url,'https://api.example.workers.dev/api/rpc');assert.equal(requests[0].init.headers.authorization,'Bearer api-token');
assert.deepEqual(JSON.parse(JSON.stringify(value.echo)),{method:'getData',args:['member-1']});assert.ok(!requests[0].init.body.includes('api-token'));assert.equal(requests[0].init.credentials,'omit');
await assert.rejects(api.window.LivePocketTransport.call('saveData','m','live',{}),/他の更新/);
await api.window.LivePocketTransport.call('getAuthConfig');assert.equal(requests.at(-1).init.headers.authorization,undefined);
api.fetch=async()=>{throw new TypeError('Failed to fetch')};await assert.rejects(api.window.LivePocketTransport.call('saveData','m','live',{}),/登録済みか再読込/);
api.window.LIVE_POCKET_CONFIG.apiUrl='http://api.example.com';await assert.rejects(api.window.LivePocketTransport.call('getData','m'),/https/);
console.log('PASS: Cloudflare API transport (Authorization header, errors, no token in body, https only)');}
console.log('PASS: iframe handshake, origin/source checks, RPC response, mutation timeout without retry, method allowlist, bridge reply and replay prevention');
})().catch(e=>{console.error(e);process.exit(1)});
