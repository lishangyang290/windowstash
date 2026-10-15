import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { nativeHostBinary as binary } from './native-host-paths.mjs';
const root=await mkdtemp(join(tmpdir(),'windowstash-auth-flow-'));
const origin='chrome-extension://'+'a'.repeat(32)+'/';
const id='b'.repeat(64),route='c'.repeat(64),login='d'.repeat(64);
let refreshes=0,user='account-A',mode='online',pendingRefresh,refreshStarted;
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;
 res.setHeader('Content-Type','application/json');
 if(req.url==='/auth/v1/user')return res.end(JSON.stringify({id:user}));
 if(req.url==='/auth/v1/token?grant_type=refresh_token') {
  refreshes++;assert.equal(JSON.parse(body).refresh_token,'fixture-refresh-1');
  if(mode==='offline')return req.socket.destroy();
  if(mode==='revoked')return res.end(JSON.stringify({error_code:'refresh_token_not_found'}));
  if(mode==='transient')return res.end(JSON.stringify({error_code:'temporarily_unavailable'}));
  const response=JSON.stringify({access_token:'fixture-access-2',refresh_token:'fixture-refresh-2',expires_in:3600,user:{id:user}});
  if(mode==='blocked'){pendingRefresh=()=>res.end(response);refreshStarted();return;}
  return res.end(response);
 }
 res.statusCode=404;res.end('{}');
});
async function exchange(action,extra={}) {
 const request={version:1,type:'auth',action,instance_id:id,capability:null,login_request:null,route_id:null,config:null,session:null,...extra};
 const payload=Buffer.from(JSON.stringify(request));const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);
 return await new Promise((done,reject)=>{const child=spawn(binary,[origin],{env:{...process.env,WINDOWSTASH_BRIDGE_DIR:root},stdio:['pipe','pipe','ignore']});const chunks=[];child.stdout.on('data',c=>chunks.push(c));child.on('error',reject);child.on('close',()=>{try {const result=Buffer.concat(chunks);assert.equal(result.readUInt32LE(),result.length-4);done(JSON.parse(result.subarray(4).toString()))}catch(e){reject(e)}});child.stdin.end(Buffer.concat([header,payload]));});
}
try {
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)});
const config={url:'http://127.0.0.1:'+server.address().port,publishable_key:'fixture-publishable-key'};
const initial={access_token:'fixture-access-1',refresh_token:'fixture-refresh-1',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:user}};
 await writeFile(join(root,'login-request.json'),JSON.stringify({id:login,route_id:route,origin,expires_at:Math.floor(Date.now()/1000)+900}),{mode:0o600});
 const reply=await exchange('bootstrap',{config,session:initial,login_request:login,route_id:route});assert.equal(reply.session.user.id,'account-A');const capability=reply.capability;assert.match(capability,/^[a-f0-9]{64}$/);
 const accountFile=await stat(join(root,'accounts',id+'.json'));
 if(process.platform==='win32')assert.equal(accountFile.isFile(),true);
 else assert.equal(accountFile.mode & 0o777,0o600);
 assert.equal((await exchange('completion',{capability,login_request:login})).completed,false);
 const grant=JSON.parse(await readFile(join(root,'accounts',id+'.json'),'utf8'));
 await writeFile(join(root,'login-completion.json'),JSON.stringify({request:login,instance_id:id,revision:grant.revision+1,completed:true}));
 assert.equal((await exchange('completion',{capability,login_request:login})).completed,false);
 await writeFile(join(root,'login-completion.json'),JSON.stringify({request:login,instance_id:id,revision:grant.revision,completed:false,failure:'workspace_unavailable'}));
 assert.equal((await exchange('completion',{capability,login_request:login})).failure,'workspace_unavailable');
 await exchange('bootstrap',{capability,config,session:initial,login_request:login,route_id:route});
 assert.equal((await exchange('completion',{capability,login_request:login})).failure,null);
 await writeFile(join(root,'login-completion.json'),JSON.stringify({request:login,instance_id:id,revision:grant.revision,completed:true}));
 assert.equal((await exchange('completion',{capability,login_request:login})).completed,true);

 assert.equal((await exchange('read',{capability:'e'.repeat(64)})).code,'unauthorized_instance');
 const stored=JSON.parse(await readFile(join(root,'accounts',id+'.json'),'utf8'));stored.session.expires_at=1;await writeFile(join(root,'accounts',id+'.json'),JSON.stringify(stored),{mode:0o600});
 assert.equal((await exchange('local',{capability})).session.expires_at,1);assert.equal(refreshes,0);
 const responses=await Promise.all(Array.from({length:6},()=>exchange('refresh',{capability})));assert.equal(refreshes,1);assert(responses.every(r=>r.session.refresh_token==='fixture-refresh-2'));
 const resumed=await exchange('read',{capability});assert.equal(resumed.session.user.id,'account-A');
 await exchange('clear',{capability});assert.equal((await exchange('read',{capability})).session,null);
 user='account-B';const next={...initial,user:{id:user}};const changed=await exchange('replace',{capability,config,session:next});assert.equal(changed.session.user.id,'account-B');
 const replay=await exchange('bootstrap',{capability,login_request:login,route_id:route,config,session:initial});assert.equal(replay.session.user.id,'account-B');
 const expire=async()=>{const stored=JSON.parse(await readFile(join(root,'accounts',id+'.json'),'utf8'));stored.session={...stored.session,expires_at:1,refresh_token:'fixture-refresh-1'};await writeFile(join(root,'accounts',id+'.json'),JSON.stringify(stored),'utf8');};
 await expire();mode='offline';assert.equal((await exchange('read',{capability})).code,'network_unavailable');assert.equal((await exchange('local',{capability})).session.user.id,'account-B');
 mode='transient';assert.equal((await exchange('read',{capability})).code,'session_refresh_failed');assert.equal((await exchange('local',{capability})).session.user.id,'account-B');
 mode='online';assert.equal((await exchange('read',{capability})).session.access_token,'fixture-access-2');
 await expire();mode='blocked';const started=new Promise(resolve=>{refreshStarted=resolve;});const delayed=exchange('refresh',{capability});await started;
 assert.equal((await exchange('local',{capability})).session.user.id,'account-B');
 await exchange('clear',{capability});assert.equal((await exchange('local',{capability})).session,null);
 pendingRefresh();pendingRefresh=null;assert.equal((await delayed).session,null);
 mode='online';await exchange('replace',{capability,config,session:next});await expire();
 mode='blocked';const changing=new Promise(resolve=>{refreshStarted=resolve;});const oldAccountRefresh=exchange('refresh',{capability});await changing;
 user='account-C';const accountC={...initial,user:{id:user}};await exchange('replace',{capability,config,session:accountC});
 pendingRefresh();pendingRefresh=null;assert.equal((await oldAccountRefresh).code,'account_mismatch');assert.equal((await exchange('local',{capability})).session.user.id,'account-C');await expire();
 mode='revoked';assert.equal((await exchange('refresh',{capability})).code,'authorization_revoked');assert.equal((await exchange('local',{capability})).session,null);
 console.log('PASS: isolated real Host: offline expiry, reconnect, transient failure preservation, local access during blocked refresh, logout defeating late refresh, explicit revocation, concurrent refresh, account isolation. No real credentials or registration used.');
}finally{pendingRefresh?.();if(server.listening)await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true})}
