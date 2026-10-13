import assert from 'node:assert/strict';
import http from 'node:http';import {once} from 'node:events';
import express from 'express';
import handler from '../api/source-host.js';
const prior={url:process.env.SOURCE_HOST_URL,key:process.env.SOURCE_API_KEY};
let payload={kind:'hls',source:{providerId:'habster:alloha',catalogSource:'habster'},selected:{label:'2160p',url:'/v1/media?token=fixture'},qualities:[{label:'2160p',url:'/v1/media?token=fixture'}],subtitles:[]};
const source=http.createServer((req,res)=>{assert.equal(req.url,'/v1/resolve');res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(payload));});const app=express();app.use(express.json());app.post('/api/source-host',handler);const gateway=http.createServer(app);
async function listen(s){s.listen(0,'127.0.0.1');await once(s,'listening');return 'http://127.0.0.1:'+s.address().port;}
try{process.env.SOURCE_HOST_URL=await listen(source);process.env.SOURCE_API_KEY='fixture-key';const base=await listen(gateway);const call=()=>fetch(base+'/api/source-host?op=resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'fixture'})});let r=await call();assert.equal(r.status,200);const result=await r.json();assert.equal(result.kind,'hls');assert.equal(result.selected.url,process.env.SOURCE_HOST_URL+'/v1/media?token=fixture');const original=structuredClone(payload);
for(const url of ['https://befriend.stravers.live/?kp=5494049','https://evil.test/v1/media?token=fixture','/v1/media','/other?token=fixture']){payload={...original,selected:{...original.selected,url}};r=await call();assert.equal(r.status,502);assert.equal((await r.json()).error,'HOST_UNAVAILABLE');}
payload={...original,qualities:[{url:'https://evil.test/v1/media?token=fixture'}]};assert.equal((await call()).status,502);
payload={...original,subtitles:[{url:'https://evil.test/v1/media?token=fixture'}]};assert.equal((await call()).status,502);
console.log('Native HLS gateway uses our media host and rejects external player, quality and subtitle URLs');
}finally{for(const s of [gateway,source]){s.closeAllConnections();s.close();}for(const[k,v]of Object.entries({SOURCE_HOST_URL:prior.url,SOURCE_API_KEY:prior.key})){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
