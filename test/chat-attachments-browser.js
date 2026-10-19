import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createPublicGateway } from '../scripts/public-gateway.js';

const dataDir=await mkdtemp(join(tmpdir(),'commonroom-chat-files-'));
const service=await createApp({dataDir,agentsEnabled:false});
let browser,gateway;
try {
  const {port}=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,...(existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{})});
  const first=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),second=await browser.newContext({reducedMotion:'reduce'});
  const admin=await first.newPage(),member=await second.newPage(),errors=[];
  for(const page of [admin,member])page.on('pageerror',e=>errors.push(e.message));
  await admin.goto(base);await admin.locator('#auth-form [name=display_name]').fill('Chat Admin');await admin.locator('#auth-form [name=username]').fill('admin');await admin.locator('#auth-form [name=password]').fill('chat attachment password');await admin.locator('#auth-form button[type=submit]').click();await admin.locator('#message-input').waitFor();
  assert.equal((await first.request.post(base+'/api/admin/users',{data:{display_name:'Chat Member',username:'member',password:'member attachment password',role:'member'}})).status(),201);
  let site=base;
  if(process.env.BOARD_PUBLIC){
    await first.clearCookies();site='https://chat.commonroom.test';gateway=createPublicGateway({targetPort:port,publicOrigin:site});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
    const gatewayBase=`http://127.0.0.1:${gateway.address().port}`;
    for(const context of [first,second])await context.route(site+'/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await route.fetch({url:gatewayBase+url.pathname+url.search,headers:{...request.headers(),host:url.host,...(!['GET','HEAD'].includes(request.method())?{origin:site,'sec-fetch-site':'same-origin'}:{})}});await route.fulfill({response});});
    await admin.goto(site);await admin.locator('#auth-form [name=username]').fill('admin');await admin.locator('#auth-form [name=password]').fill('chat attachment password');await admin.locator('#auth-form button[type=submit]').click();await admin.locator('#message-input').waitFor();
  }
  await member.goto(site);await member.locator('#auth-form [name=username]').fill('member');await member.locator('#auth-form [name=password]').fill('member attachment password');await member.locator('#auth-form button[type=submit]').click();await member.locator('#message-input').waitFor();
  let failUpload=true;
  await first.route('**/api/channels/*/messages',async route=>{if(failUpload && route.request().method()==='POST'){failUpload=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary send failure'})});}else await route.fallback();});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await admin.locator('#message-input').fill('A sketch for the shared room.');await admin.locator('#composer input[type=file]').setInputFiles({name:'room-sketch.png',mimeType:'image/png',buffer:png});await admin.locator('#composer .chat-selected-files img').waitFor();
  await admin.getByRole('button',{name:'Remove room-sketch.png',exact:true}).click();assert.equal(await admin.locator('#composer input[type=file]').evaluate(input=>input.files.length),0);await admin.locator('#composer input[type=file]').setInputFiles({name:'room-sketch.png',mimeType:'image/png',buffer:png});
  await admin.getByRole('button',{name:'Send message',exact:true}).click();await admin.locator('#composer .form-error').filter({hasText:'Temporary send failure'}).waitFor();
  await admin.locator('.channel-link').filter({hasText:'ideas'}).click();assert.equal(await admin.locator('#message-input').inputValue(),'');assert.equal(await admin.locator('#composer input[type=file]').evaluate(input=>input.files.length),0);
  await admin.locator('.channel-link').filter({hasText:'general'}).click();assert.equal(await admin.locator('#message-input').inputValue(),'A sketch for the shared room.');assert.equal(await admin.locator('#composer input[type=file]').evaluate(input=>input.files.length),1);
  await admin.getByRole('button',{name:'Send message',exact:true}).click();await member.locator('#message-list .message-attachments img').waitFor();
  assert.equal(await member.locator('#message-list .message-body').filter({hasText:'A sketch for the shared room.'}).count(),1);
  const preview=member.locator('#message-list .message-attachments a');assert.equal(await preview.getAttribute('target'),'_blank');
  await admin.locator('#message-list [data-action=thread]').first().click();await member.locator('#message-list [data-action=thread]').first().click();await member.locator('#thread-input').waitFor();
  await member.locator('#thread-input').fill('The review notes are attached.');await member.locator('#thread-composer input[type=file]').setInputFiles({name:'review-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Useful review notes')});
  await admin.locator('#thread-input').fill('Ready for your review.');await admin.getByRole('button',{name:'Send reply',exact:true}).click();await member.locator('.thread-messages .message-body').filter({hasText:'Ready for your review.'}).waitFor();
  assert.equal(await member.locator('#thread-input').inputValue(),'The review notes are attached.');assert.equal(await member.locator('#thread-composer input[type=file]').evaluate(input=>input.files.length),1);
  await member.getByRole('button',{name:'Send reply',exact:true}).click();await admin.locator('.thread-messages .attachment').filter({hasText:'review-notes.txt'}).waitFor();
  // Unchanged polling or workspace events keep the existing image nodes, avoiding repeat downloads.
  await member.evaluate(()=>{window.attachmentImage=document.querySelector('#message-list .message-attachments img');});
  if(process.env.BOARD_PUBLIC){await member.waitForResponse(r=>/\/api\/channels\/\d+\/messages$/.test(new URL(r.url()).pathname));}
  else {await admin.locator('#message-input').fill('A regular text message still works.');await admin.locator('#message-input').press('Enter');await member.locator('#message-list .message-body').filter({hasText:'A regular text message still works.'}).waitFor();}
  if(process.env.BOARD_PUBLIC)assert.equal(await member.evaluate(()=>window.attachmentImage===document.querySelector('#message-list .message-attachments img')),true);
  await member.locator('[data-action=close-thread]').click();await member.getByRole('button',{name:'Ticket board',exact:true}).click();assert.equal(await member.locator('input[data-upload=board]').count(),0);await member.getByRole('button',{name:'Channels',exact:true}).click();await member.locator('#message-list .message-attachments img').waitFor();
  if(process.env.BROWSER_SCREENSHOTS){await mkdir(process.env.BROWSER_SCREENSHOTS,{recursive:true});await admin.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-chat-attachments.png'),fullPage:true});await member.setViewportSize({width:390,height:844});await member.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-chat-attachments-mobile.png'),fullPage:true});}
  assert.deepEqual(errors,[]);console.log(`Chat attachment browser checks passed (${process.env.BOARD_PUBLIC?'public polling':'local SSE'}): channel images, threaded files, atomic send retry without duplicate text, preserved file selections and normal Enter-to-send.`);
} finally {await browser?.close();if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}await service.close();await rm(dataDir,{recursive:true,force:true});}
