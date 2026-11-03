import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fetchFeedSource} from '../src/feed-fetch.js';
const source={url:'https://openrouter.ai/api/v1/models'};
test('non-200 response is destroyed even when server never ends body', async()=>{
 const server=http.createServer((req,res)=>{res.writeHead(429);res.write('still open');});
 const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const request=(_url,options,callback)=>http.request({hostname:'127.0.0.1',port:server.address().port,headers:options.headers,agent:false},callback);
  await assert.rejects(fetchFeedSource(source,{}, {timeoutMs:100,request}),/http_429/);
  // Wait for actual transport close (not a simulated response's destroy method).
  const deadline=Date.now()+1000;
  while(sockets.size && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(sockets.size,0);
 }finally{for(const socket of sockets) socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
test('query-only redirect must not replay resource-specific validators',async()=>{
 const seen=[];
 const server=http.createServer((req,res)=>{seen.push(req.headers['if-none-match']);if(req.url==='/api/v1/models'){res.writeHead(302,{location:'?version=2'});res.end();}else{res.writeHead(200,{etag:'new'});res.end('{}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const request=(url,options,callback)=>http.request({hostname:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,headers:options.headers,agent:false},callback);
  const result=await fetchFeedSource(source,{etag:'old'},{request});assert.equal(result.status,200);assert.deepEqual(seen,['old',undefined]);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
