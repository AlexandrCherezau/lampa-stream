import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSession } from '../src/utils/source-host-client.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
const candidate = (id, providerId='p', voiceId='dub') => ({id, providerId, providerName:providerId, voiceId, voiceName:voiceId, season:1, episode:2});
const result = (name, quality='720p') => ({kind:'hls', selected:{url:`https://media.invalid/${name}.m3u8`,label:quality}, qualities:[{label:quality,height:720}], audioNames:['Dub'], subtitles:[]});
function fixture({discover, resolve}={}) {
 let state;
 const calls=[];
 const session=createSourceSession({publish:value=>state=value,
  discover:discover || (async (_, {onEvent})=>{onEvent('candidate',candidate('a'));onEvent('candidate',candidate('b','other'));}),
  resolve:async (id,quality,signal)=>{calls.push({id,quality});return resolve ? resolve(id,quality,signal,calls.length) : result(id);},
 });
 return {session,calls,get state(){return state;}};
}
async function start(f) {await f.session.start({title:'Fixture',type:'tv',season:1,episode:2});await flush();f.session.notePlaying();}
test('refresh resolves the same confirmed provider, voice and quality without sibling fallback',async()=>{
 const f=fixture();await start(f);const before=f.calls.length;
 assert.equal(await f.session.refreshCurrent(),true);
 assert.deepEqual(f.calls.slice(before),[{id:'a',quality:'720p'}]);
 assert.equal(f.state.balanser,'p');assert.equal(f.state.voice,'a');assert.deepEqual(f.state.audioNames,['Dub']);
 assert.equal(f.session.reportPlaybackFailure(),false,'a refreshed URL stays locked even before its new frames');
 f.session.stop();
});
test('failed refresh is bounded even after notePlaying, and explicit selection resets the budget',async()=>{
 let fail=false;const f=fixture({resolve:async id=>{if(fail)throw new Error('offline');return result(id);}});await start(f);fail=true;
 const before=f.calls.length;
 for(let i=0;i<3;i++){assert.equal(await f.session.refreshCurrent(),false);f.session.notePlaying();}
 assert.equal(f.calls.length-before,2);assert.equal(f.state.balanser,'p');assert.ok(f.state.stream);
 assert.equal(f.session.reportPlaybackFailure(),false);
 fail=false;await f.session.selectBalanser('p');f.session.notePlaying();
 assert.equal(await f.session.refreshCurrent(),true);f.session.stop();
});
test('concurrent refresh is coalesced and manual selection invalidates its late result',async()=>{
 let release,signal;let refreshing=false;
 const f=fixture({resolve:async(id,quality,s)=>{if(refreshing&&id==='a'){signal=s;return new Promise(r=>release=r);}return result(id);}});await start(f);refreshing=true;
 const one=f.session.refreshCurrent();const two=f.session.refreshCurrent();assert.equal(one,two);
 await flush();await f.session.selectBalanser('other');assert.equal(signal.aborted,true);
 assert.equal(await one,undefined);release(result('late'));await flush();
 assert.equal(f.state.balanser,'other');assert.match(f.state.stream.hls,/b\.m3u8/);f.session.stop();
});
test('expired sealed candidate rediscovery accepts only the same provider, voice and episode',async()=>{
 let discoveries=0;
 const f=fixture({discover:async(_, {onEvent})=>{
  if(++discoveries===1){onEvent('candidate',candidate('old'));return;}
  for(const c of [candidate('wrong-provider','other'),candidate('wrong-voice','p','sub'),{...candidate('wrong-episode'),episode:3},candidate('fresh')])onEvent('candidate',c);
 },resolve:async(id,quality,_signal,number)=>{if(number>1&&id==='old')throw Object.assign(new Error('expired'),{code:'SOURCE_EXPIRED',status:410});return result(id,quality);}});
 await start(f);assert.equal(await f.session.refreshCurrent(),true);
 assert.deepEqual(f.calls.map(c=>c.id),['old','old','fresh']);assert.equal(f.state.voice,'fresh');assert.equal(f.state.balanser,'p');f.session.stop();
});
test('expired source never substitutes a different voice if the original disappeared',async()=>{
 let discoveries=0;
 const f=fixture({discover:async(_, {onEvent})=>onEvent('candidate',candidate(++discoveries===1?'old':'sub','p',discoveries===1?'dub':'sub')),
 resolve:async(id,quality,_signal,number)=>{if(number>1)throw Object.assign(new Error('expired'),{status:410});return result(id,quality);}});
 await start(f);assert.equal(await f.session.refreshCurrent(),false);assert.equal(f.state.voice,'old');assert.deepEqual(f.calls.map(c=>c.id),['old','old']);f.session.stop();
});
test('refresh deadline aborts a hung request without replacing the active source',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let hung=false,signal;
 const f=fixture({resolve:async(id,_q,s)=>{if(hung){signal=s;return new Promise(()=>{});}return result(id);}});await start(f);hung=true;
 const refreshed=f.session.refreshCurrent();await flush();t.mock.timers.tick(20_000);await flush();
 assert.equal(await refreshed,false);assert.equal(signal.aborted,true);assert.equal(f.state.balanser,'p');assert.equal(f.state.switching,false);f.session.stop();
});
test('changing title cancels refresh and cannot publish an old source into the new title',async()=>{
 let hung=false,release;
 const f=fixture({resolve:async id=>hung?new Promise(r=>release=r):result(id)});await start(f);hung=true;
 const pending=f.session.refreshCurrent();await flush();hung=false;
 await f.session.start({title:'New fixture'});await flush();assert.equal(await pending,undefined);
 const stream=f.state.stream;release(result('old-late'));await flush();assert.equal(f.state.stream,stream);f.session.stop();
});
test('an existing manual switch takes precedence over a late error from the old engine',async()=>{
 let choosing=false,release;
 const f=fixture({resolve:async id=>choosing&&id==='b'?new Promise(r=>release=r):result(id)});await start(f);choosing=true;
 const manual=f.session.selectBalanser('other');await flush();const before=f.calls.length;
 assert.equal(await f.session.refreshCurrent(),undefined);assert.equal(f.calls.length,before);
 release(result('manual'));assert.equal(await manual,true);assert.equal(f.state.balanser,'other');f.session.stop();
});
test('reused positional voice ID cannot silently replace the original dub after rediscovery',async()=>{
 let discoveries=0;
 const f=fixture({discover:async(_, {onEvent})=>{
  const c=candidate(++discoveries===1?'old':'reordered');
  onEvent('candidate',{...c,voiceName:discoveries===1?'Original Dub':'Different Dub'});
 },resolve:async(id,quality,_signal,number)=>{if(number>1)throw Object.assign(new Error('expired'),{code:'SOURCE_EXPIRED'});return result(id,quality);}});
 await start(f);assert.equal(await f.session.refreshCurrent(),false);
 assert.equal(f.state.sourcePreference.voiceName,'Original Dub');assert.deepEqual(f.calls.map(c=>c.id),['old','old']);f.session.stop();
});
