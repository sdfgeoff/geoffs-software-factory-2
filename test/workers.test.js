import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { createPublicGateway } from '../scripts/public-gateway.js';
import { request as httpRequest } from 'node:http';

async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'commonroom-workers-')); const app=await createApp({dataDir,agentsEnabled:false});const {port}=await app.listen(0,'127.0.0.1');
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const admin=app.store.setup({username:'admin',display_name:'Admin',password:'worker test password'});const cookie=`commonroom=${app.store.createSession(admin.id)}`;
  async function request(path,{method='POST',body={},token,auth=cookie,headers={}}={}) {
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  }
  async function worker(name='Worker',capacity=1){const created=await request('/api/admin/workers',{body:{name,capacity}});const enrolled=await request('/api/workers/enroll',{auth:null,body:{token:created.data.enrollment_token}});const token=enrolled.data.token;await request('/api/workers/heartbeat',{auth:null,token,body:{status:'ready',auth:{connected:true},models:[{id:'fake-model',name:'Fake model'}]}});return {id:enrolled.data.worker_id,token,enrollment:created.data.enrollment_token};}
  const agent=workerId=>app.store.createAgent({username:`agent-${app.store.users().length}`,display_name:'Remote agent',instructions:'Only contribute when useful.',subscriptions:[],worker_id:workerId});
  const claim=token=>{app.store.run('UPDATE notifications SET due_at=0');return request('/api/workers/claim',{auth:null,token});};
  return {...app,dataDir,admin,cookie,port,request,worker,agent,claim,channel:app.store.channels(admin.id)[0]};
}

test('admin enrollment is one-use, hashed, revocable and machine endpoints reject browser credentials',async t=>{
  const {store,request,worker}=await fixture(t);
  assert.equal((await request('/api/admin/workers',{auth:null,body:{name:'No'}})).status,401);
  const first=await worker();
  assert.equal((await request('/api/workers/enroll',{auth:null,body:{token:first.enrollment}})).status,401);
  const saved=store.get('SELECT * FROM workers WHERE id=?',first.id);assert.notEqual(saved.credential_hash,first.token);assert.equal(saved.enrollment_hash,null);
  const roster=await request('/api/admin/workers',{method:'GET'});assert.ok(!JSON.stringify(roster.data).includes(first.token));assert.ok(!JSON.stringify(roster.data).includes('credential_hash'));
  assert.equal((await request('/api/workers/claim',{auth:null})).status,401);
  assert.equal((await request('/api/workers/claim',{token:first.token,headers:{Origin:'http://localhost'}})).status,403);
  assert.equal((await request(`/api/admin/workers/${first.id}`,{method:'PUT',body:{revoked:true}})).status,200);
  assert.equal((await request('/api/workers/heartbeat',{auth:null,token:first.token})).status,401);
});

test('worker claims are capacity-limited, agent-serial and heartbeat renews only active owned leases',async t=>{
  const {store,worker,agent,claim,request}=await fixture(t);const first=await worker('One',2);const second=await worker('Two');
  agent(first.id);agent(first.id);agent(second.id);
  const a=(await claim(first.token)).data.job;const b=(await claim(first.token)).data.job;assert.ok(a&&b);assert.notEqual(a.agent.user_id,b.agent.user_id);
  assert.equal((await claim(first.token)).data.job,null);assert.ok((await claim(second.token)).data.job);
  store.run('UPDATE worker_jobs SET expires_at=? WHERE id=?',Date.now()+1000,a.id);
  const beat=await request('/api/workers/heartbeat',{auth:null,token:first.token,body:{auth:{connected:true},running:[a.id]}});
  assert.ok(store.get('SELECT expires_at FROM worker_jobs WHERE id=?',a.id).expires_at>Date.now()+80000);assert.equal(beat.data.lease_duration_ms,90000);
  assert.equal(beat.data.capacity,2);
  await request(`/api/admin/workers/${first.id}`,{method:'PUT',body:{capacity:3}});
  assert.equal((await request('/api/workers/heartbeat',{auth:null,token:first.token,body:{auth:{connected:true}}})).data.capacity,3);
  assert.equal((await request(`/api/workers/jobs/${a.id}/complete`,{auth:null,token:second.token,body:{lease_token:a.lease_token}})).status,403);
});

test('remote mutation retries are durable and idempotent; filesystem tools and server paths are fenced',async t=>{
  const {store,worker,agent,claim,request,channel}=await fixture(t);const machine=await worker();agent(machine.id);const job=(await claim(machine.token)).data.job;
  const tool=(name,input,request_id='request-1')=>request(`/api/workers/jobs/${job.id}/tool`,{auth:null,token:machine.token,body:{lease_token:job.lease_token,request_id,name,input}});
  const one=await tool('post_message',{channel_id:channel.id,body:'One remote contribution'});assert.equal(one.status,200);
  assert.equal((await tool('post_message',{channel_id:channel.id,body:'One remote contribution'})).data.id,one.data.id);assert.equal(store.get('SELECT COUNT(*) n FROM messages').n,1);
  assert.equal((await tool('post_message',{channel_id:channel.id,body:'Changed retry'})).status,409);
  for(const name of ['list_files','read_file','write_file','create_directory','move_file','delete_file','attach_file'])assert.equal((await tool(name,{path:'/tmp/master-file'},name)).status,403);
  assert.equal((await tool('read_attachment',{attachment_id:1,destination:'/tmp/server-write'},'destination')).status,403);
  assert.equal((await tool('post_message',{channel_id:channel.id,body:'No server import',attachments:[{path:'/etc/passwd'}]},'path')).status,400);
  const attachment=await tool('attach_bytes',{message_id:one.data.id,filename:'worker.txt',content_base64:Buffer.from('Worker bytes').toString('base64')},'bytes');assert.equal(attachment.status,200);
  const read=await tool('read_attachment',{attachment_id:attachment.data.id},'read');assert.equal(Buffer.from(read.data.content_base64,'base64').toString(),'Worker bytes');
  const complete=()=>request(`/api/workers/jobs/${job.id}/complete`,{auth:null,token:machine.token,body:{lease_token:job.lease_token,thread_id:'worker-thread',workspace_path:'/worker/agents/1/workspace',model:'fake-model'}});
  assert.equal((await complete()).status,200);assert.equal((await complete()).status,200);
  assert.equal(store.get('SELECT COUNT(*) n FROM worker_tool_results').n,0);assert.equal(store.get('SELECT COUNT(*) n FROM worker_job_notifications').n,0);
  assert.equal((await tool('post_message',{channel_id:channel.id,body:'Too late'},'late')).status,409);
});

test('expiration, reassignment and revoke invalidate leases immediately and retain pending work',async t=>{
  const {store,worker,agent,claim,request}=await fixture(t);const first=await worker('First');const second=await worker('Second');const person=agent(first.id);
  const old=(await claim(first.token)).data.job;store.run('UPDATE worker_jobs SET expires_at=0 WHERE id=?',old.id);
  const stale=await request(`/api/workers/jobs/${old.id}/complete`,{auth:null,token:first.token,body:{lease_token:old.lease_token}});assert.equal(stale.status,409);
  assert.equal(store.get('SELECT attempts FROM notifications WHERE agent_id=?',person.user_id).attempts,0);
  const next=(await claim(first.token)).data.job;assert.notEqual(next.id,old.id);
  store.updateAgent(person.user_id,{...person,enabled:true,worker_id:second.id});
  assert.equal((await request(`/api/workers/jobs/${next.id}/tool`,{auth:null,token:first.token,body:{lease_token:next.lease_token,request_id:'stale',name:'list_channels',input:{}}})).status,409);
  const moved=(await claim(second.token)).data.job;assert.ok(moved);assert.equal(moved.thread_id,null);
  await request(`/api/admin/workers/${second.id}`,{method:'PUT',body:{revoked:true}});
  assert.equal(store.get('SELECT status FROM worker_jobs WHERE id=?',moved.id).status,'cancelled');assert.equal(store.get('SELECT status FROM notifications WHERE agent_id=?',person.user_id).status,'pending');
});

test('device authentication controls work before readiness, are acknowledged, and sanitize reports',async t=>{
  const {request,worker,claim}=await fixture(t);const machine=await worker();
  await request(`/api/admin/workers/${machine.id}/auth`,{body:{action:'start'}});
  const beat=await request('/api/workers/heartbeat',{auth:null,token:machine.token,body:{status:'authenticating',auth:{connected:false,access_token:'DO NOT STORE',flow:{status:'awaiting_user',verification_url:'https://auth.openai.com/codex/device',user_code:'SAFE-CODE'}}}});
  assert.equal(beat.data.commands[0].type,'auth_start');assert.equal((await claim(machine.token)).data.job,null);
  const ack=await request('/api/workers/heartbeat',{auth:null,token:machine.token,body:{ack_commands:[beat.data.commands[0].id],auth:{connected:false,flow:{status:'pending',verification_url:'javascript:alert(1)',user_code:'CODE'}}}});assert.deepEqual(ack.data.commands,[]);
  const roster=(await request('/api/admin/workers',{method:'GET'})).data.workers[0];assert.equal(roster.auth.flow.verification_url,null);assert.ok(!JSON.stringify(roster).includes('DO NOT STORE'));
});

test('outer idempotency failure rolls back nested text, attachments and existing file removals',async t=>{
  const {store,worker,agent,claim,channel,dataDir}=await fixture(t);const machine=await worker();const person=agent(machine.id);const job=(await claim(machine.token)).data.job;
  const message=store.post(person.user_id,channel.id,'Original',null,0,[{filename:'old.txt',content_base64:'eA=='}]);const oldFiles=await readdir(join(dataDir,'uploads'));
  const run=store.run.bind(store);store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO worker_tool_results'))throw new Error('Cache failure');return run(sql,...args);};
  try{assert.throws(()=>store.workers.tool(store.workers.authenticate(machine.token),job.id,{lease_token:job.lease_token,request_id:'atomic',name:'edit_message',input:{message_id:message.id,version:1,body:'New',remove_attachment_ids:[message.attachments[0].id],attachments:[{filename:'new.txt',content_base64:'eQ=='}]}}),/Cache failure/);
    assert.throws(()=>store.workers.tool(store.workers.authenticate(machine.token),job.id,{lease_token:job.lease_token,request_id:'atomic-bytes',name:'attach_bytes',input:{message_id:message.id,filename:'new-direct.txt',content_base64:'eg=='}}),/Cache failure/);
  }finally{store.run=run;}
  assert.equal(store.message(message.id).body,'Original');assert.equal(store.message(message.id).attachments[0].id,message.attachments[0].id);assert.deepEqual(await readdir(join(dataDir,'uploads')),oldFiles);assert.equal(store.tickets.readAttachment(person.user_id,message.attachments[0].id).content_base64,'eA==');
});

test('worker credentials, live leases, mutation receipts and worker-specific memory survive reopening',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'commonroom-worker-restart-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const path=join(dataDir,'db.sqlite');let store=new Store(path);
  const admin=store.setup({username:'admin',display_name:'Admin',password:'restart test password'});const channel=store.channels(admin.id)[0];
  const registration=store.workers.create({name:'Persistent worker'});const enrolled=store.workers.enroll({token:registration.enrollment_token});
  let worker=store.workers.authenticate(enrolled.token);store.workers.heartbeat(worker,{auth:{connected:true}});
  const person=store.createAgent({username:'persistent-agent',display_name:'Persistent Agent',instructions:'Work.',subscriptions:[],worker_id:worker.id});store.run('UPDATE notifications SET due_at=0');
  const attach=()=>{const tokens=new Map();store.workers.attachRuntime({tokens,notificationContext:()=>({prompt:'A notification. Responding is optional.',depth:1}),tool:(token,name,input)=>store.post(tokens.get(token).agentId,channel.id,input.body)});};attach();
  const job=store.workers.claim(worker).job;const call={lease_token:job.lease_token,request_id:'durable',name:'post_message',input:{body:'Saved exactly once'}};
  const first=store.workers.tool(worker,job.id,call);store.close();store=new Store(path);attach();
  try{worker=store.workers.authenticate(enrolled.token);assert.equal(store.workers.tool(worker,job.id,call).id,first.id);assert.equal(store.get('SELECT COUNT(*) n FROM messages').n,1);
    store.workers.complete(worker,job.id,{lease_token:job.lease_token,thread_id:'persistent-remote-thread',workspace_path:'/remote/agent',model:'fake'});
    store.run("INSERT INTO notifications(agent_id,kind,due_at) VALUES(?,'check_in',0)",person.user_id);
    const resumed=store.workers.claim(worker).job;assert.equal(resumed.thread_id,'persistent-remote-thread');assert.equal(resumed.agent.thread_id,'persistent-remote-thread');
  }finally{store.close();}
});

test('public gateway allows only explicit bearer machine routes and keeps browser CSRF boundaries',async t=>{
  const {port,request,worker,agent}=await fixture(t);const machine=await worker();agent(machine.id);
  const gateway=createPublicGateway({targetPort:port,publicOrigin:'https://workers.example'});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));});
  const raw=(path,headers={},body={})=>new Promise((resolve,reject)=>{const bytes=JSON.stringify(body);const req=httpRequest({host:'127.0.0.1',port:gateway.address().port,path,method:'POST',headers:{Host:'workers.example','Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes),...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);req.end(bytes);});
  assert.equal((await raw('/api/workers/heartbeat',{Authorization:`Bearer ${machine.token}`},{auth:{connected:true}})).status,200);
  assert.equal((await raw('/api/workers/claim')).status,401);
  assert.equal((await raw('/api/workers/claim',{Authorization:`Bearer ${machine.token}`,Origin:'https://workers.example','Sec-Fetch-Site':'same-origin'})).status,403);
  assert.equal((await raw('/api/admin/workers',{Authorization:`Bearer ${machine.token}`},{name:'Bypass'})).status,403);
  assert.equal((await raw('/internal/agent/tool',{Authorization:`Bearer ${machine.token}`})).status,404);
  assert.equal((await raw('/api/workers/jobs/../claim',{Authorization:`Bearer ${machine.token}`})).status,404);
});
