import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';

test('unified search matches chat, replies, ticket titles/descriptions/keys and comments',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'commonroom-search-'));
  const service=await createApp({dataDir,agentsEnabled:false});
  const {port}=await service.listen(0,'127.0.0.1');
  t.after(async()=>{await service.close();await rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const setup=await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',display_name:'Admin',password:'search password test'})});
  const user=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
  const request=(q='',suffix='')=>fetch(base+'/api/search?scope=workspace&q='+encodeURIComponent(q)+suffix,{headers:{Cookie:cookie}});
  const store=service.store,channel=store.get('SELECT id FROM channels').id;
  const parent=store.post(user.id,channel,'Needle chat');
  store.post(user.id,channel,'needle reply',parent.id);
  const ticket=store.tickets.create(user.id,{title:'Needle title',description:'description text'});
  store.tickets.create(user.id,{title:'Other title',description:'needle description'});
  store.tickets.comment(user.id,ticket.id,{body:'Needle comment'});
  const results=await (await request('NEEDLE')).json();
  assert.equal(results.length,5);
  assert.deepEqual([...new Set(results.map(r=>r.type))].sort(),['comment','message','ticket']);
  assert.ok(results.some(r=>r.parent_id===parent.id));
  for(const type of ['message','ticket','comment']) {
    const rows=await (await request('needle','&type='+type)).json();
    assert.ok(rows.length);assert.ok(rows.every(r=>r.type===type));
  }
  assert.equal((await (await request('CR-'+ticket.id,'&type=ticket')).json())[0].id,ticket.id);
  assert.deepEqual(await (await request('%_')).json(),[]);
  assert.deepEqual(await (await request('absent phrase')).json(),[]);
  assert.equal((await request('')).status,400);
  assert.equal((await request('x'.repeat(121))).status,400);
  assert.equal((await request('needle','&type=invalid')).status,400);
  assert.equal((await fetch(base+'/api/search?scope=workspace&q=needle')).status,401);
  const legacy=await (await fetch(base+'/api/search?q=needle',{headers:{Cookie:cookie}})).json();
  assert.equal(legacy.length,2);assert.ok(legacy.every(row=>row.channel_name));
  store.post(user.id,channel,'x'.repeat(500)+'needle'+'z'.repeat(500));
  const snippet=(await (await request('needle','&type=message')).json())[0].body;
  assert.ok(snippet.includes('needle'));assert.ok(snippet.length<=302);
  for(let i=0;i<65;i++) store.post(user.id,channel,'limited '+i);
  assert.equal((await (await request('limited')).json()).length,60);
});
