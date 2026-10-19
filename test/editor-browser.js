import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createPublicGateway } from '../scripts/public-gateway.js';

const dataDir=await mkdtemp(join(tmpdir(),'commonroom-editor-'));
const service=await createApp({dataDir,agentsEnabled:false});
let browser,gateway;
try {
  const {port}=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,...(existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{})});
  const first=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),second=await browser.newContext({reducedMotion:'reduce'});
  const admin=await first.newPage(),member=await second.newPage(),errors=[];
  for(const page of [admin,member])page.on('pageerror',error=>errors.push(error.message));
  await admin.goto(base);await admin.locator('#auth-form [name=display_name]').fill('Editor Admin');await admin.locator('#auth-form [name=username]').fill('admin');await admin.locator('#auth-form [name=password]').fill('editor administrator password');await admin.locator('#auth-form button[type=submit]').click();await admin.locator('#message-input').waitFor();
  assert.equal((await first.request.post(base+'/api/admin/users',{data:{display_name:'Editor Member',username:'member',password:'editor member password',role:'member'}})).status(),201);
  let site=base;
  if(process.env.BOARD_PUBLIC){
    await first.clearCookies();site='https://editor.commonroom.test';gateway=createPublicGateway({targetPort:port,publicOrigin:site});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const upstream=`http://127.0.0.1:${gateway.address().port}`;
    for(const context of [first,second])await context.route(site+'/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await route.fetch({url:upstream+url.pathname+url.search,headers:{...request.headers(),host:url.host,...(!['GET','HEAD'].includes(request.method())?{origin:site,'sec-fetch-site':'same-origin'}:{})}});await route.fulfill({response});});
    await admin.goto(site);await admin.locator('#auth-form [name=username]').fill('admin');await admin.locator('#auth-form [name=password]').fill('editor administrator password');await admin.locator('#auth-form button[type=submit]').click();await admin.locator('#message-input').waitFor();
  }
  await member.goto(site);await member.locator('#auth-form [name=username]').fill('member');await member.locator('#auth-form [name=password]').fill('editor member password');await member.locator('#auth-form button[type=submit]').click();await member.locator('#message-input').waitFor();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const textFile={name:'original-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Original notes')};
  const imageFile={name:'new-sketch.png',mimeType:'image/png',buffer:png};
  await admin.locator('#message-input').fill('**Original message**');await admin.locator('#composer input[type=file]').setInputFiles(textFile);await admin.getByRole('button',{name:'Send message',exact:true}).click();
  await member.locator('#message-list .attachment').filter({hasText:'original-notes.txt'}).waitFor();
  const messageId=Number((await admin.locator('#message-list .message').first().getAttribute('id')).split('-')[1]);
  const rootMessage=admin.locator(`#message-list #message-${messageId}`);
  assert.equal(await member.locator(`#message-list #message-${messageId} .content-edit-button`).count(),0);
  let contentMutations=0;
  admin.on('request',request=>{if(['POST','PUT','DELETE'].includes(request.method())&&(/\/api\/messages\/\d+$/.test(new URL(request.url()).pathname)||/\/api\/tickets\/\d+\/comments\/\d+$/.test(new URL(request.url()).pathname)||new URL(request.url()).pathname==='/api/attachments'))contentMutations++;});
  await rootMessage.getByRole('button',{name:'Edit',exact:true}).click();
  let edit=rootMessage.locator('.inline-editor');
  await edit.locator('textarea').fill('A cancelled draft');await edit.getByRole('button',{name:'Remove original-notes.txt',exact:true}).click();await edit.locator('input[type=file]').setInputFiles(imageFile);
  await edit.locator('.editor-file img').waitFor();assert.equal(await edit.locator('.editor-file img').evaluate(image=>image.naturalWidth>0),true);
  assert.equal(contentMutations,0);
  await edit.getByRole('button',{name:'Cancel',exact:true}).click();await rootMessage.locator('.message-read:not([hidden])').waitFor();
  assert.equal(contentMutations,0);assert.equal(await rootMessage.locator('.message-body').innerText(),'Original message');assert.equal(await rootMessage.locator('.attachment').filter({hasText:'original-notes.txt'}).count(),1);
  // The same editor stages files, preserves selection during remote updates and previews exactly what is published.
  await rootMessage.getByRole('button',{name:'Edit',exact:true}).click();edit=rootMessage.locator('.inline-editor');
  await edit.locator('textarea').fill('**Updated message**\n\n- One useful detail\n- Another detail\n\n`inline code`');await edit.getByRole('button',{name:'Remove original-notes.txt',exact:true}).click();await edit.locator('input[type=file]').setInputFiles(imageFile);
  await edit.locator('textarea').evaluate(input=>{input.focus();input.setSelectionRange(2,9);window.activeEditorNode=input;});
  await member.locator('#message-input').fill('An incoming update while you edit.');await member.getByRole('button',{name:'Send message',exact:true}).click();await admin.locator('#message-list .message-body').filter({hasText:'An incoming update while you edit.'}).waitFor();
  assert.equal(await edit.locator('textarea').evaluate(input=>input===window.activeEditorNode),true);assert.deepEqual(await edit.locator('textarea').evaluate(input=>[input.selectionStart,input.selectionEnd]),[2,9]);assert.equal(await edit.locator('input[type=file]').evaluate(input=>input.files.length),1);
  await edit.getByRole('tab',{name:'Preview',exact:true}).click();await edit.locator('.composer-preview strong').filter({hasText:'Updated message'}).waitFor();const previewHTML=await edit.locator('.composer-preview').innerHTML();
  await edit.getByRole('button',{name:'Save changes',exact:true}).click();await rootMessage.locator('.inline-editor').waitFor({state:'detached'});await rootMessage.locator('.message-attachments img').waitFor();assert.equal(await rootMessage.locator('.message-body').innerHTML(),previewHTML);assert.equal(await rootMessage.locator('.attachment').filter({hasText:'original-notes.txt'}).count(),0);await rootMessage.locator('.edited-marker').waitFor();
  // A stale version shows an error and keeps the draft rather than overwriting another save.
  await rootMessage.getByRole('button',{name:'Edit',exact:true}).click();edit=rootMessage.locator('.inline-editor');await edit.locator('textarea').fill('Keep this unsaved conflict draft');
  const remote=await admin.evaluate(async id=>{const list=await (await fetch('/api/channels/1/messages')).json();const old=list.find(message=>message.id===id);const response=await fetch(`/api/messages/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'A newer saved version',version:old.version})});return response.status;},messageId);assert.equal(remote,200);
  const conflict=admin.waitForResponse(response=>new URL(response.url()).pathname===`/api/messages/${messageId}`&&response.request().method()==='PUT');await edit.getByRole('button',{name:'Save changes',exact:true}).click();assert.equal((await conflict).status(),409);await edit.locator('.form-feedback:not(:empty)').waitFor();assert.equal(await edit.locator('textarea').inputValue(),'Keep this unsaved conflict draft');await edit.getByRole('button',{name:'Cancel',exact:true}).click();await rootMessage.locator('.message-body').filter({hasText:'A newer saved version'}).waitFor();
  // Replies get the same author-only inline editor.
  await rootMessage.locator('[data-action=thread]').click();await admin.locator('#thread-input').fill('A reply to edit');await admin.getByRole('button',{name:'Send reply',exact:true}).click();const reply=admin.locator('.thread-messages .message').filter({hasText:'A reply to edit'});await reply.getByRole('button',{name:'Edit',exact:true}).click();await reply.locator('.inline-editor textarea').fill('An edited reply');await reply.getByRole('button',{name:'Save changes',exact:true}).click();await admin.locator('.thread-messages .message-body').filter({hasText:'An edited reply'}).waitFor();await admin.locator('[data-action=close-thread]').click();
  // Ticket comments use that exact editor, including local drop/paste staging and Save/Cancel.
  const ticket=await admin.evaluate(async()=>{const response=await fetch('/api/tickets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'A ticket for shared editing',status:'todo'})});return response.json();});
  await admin.getByRole('button',{name:'Ticket board',exact:true}).click();await admin.locator('.ticket-card').filter({hasText:'A ticket for shared editing'}).click();await admin.locator('#ticket-comment-body').fill('*A ticket comment*');await admin.locator('#ticket-comment-form input[type=file]').setInputFiles(textFile);await admin.locator('#ticket-comment-form button[type=submit]').click();await admin.locator('#ticket-comment-list .attachment').filter({hasText:'original-notes.txt'}).waitFor();
  const comment=admin.locator('#ticket-comment-list .ticket-comment').first();await comment.getByRole('button',{name:'Edit',exact:true}).click();let commentEdit=comment.locator('.inline-editor');await commentEdit.locator('textarea').fill('Cancelled comment edit');await commentEdit.getByRole('button',{name:'Remove original-notes.txt',exact:true}).click();const beforeCancel=contentMutations;await commentEdit.locator('input[type=file]').setInputFiles(imageFile);assert.equal(contentMutations,beforeCancel);await commentEdit.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(contentMutations,beforeCancel);await comment.locator('.comment-read .attachment').filter({hasText:'original-notes.txt'}).waitFor();
  await comment.getByRole('button',{name:'Edit',exact:true}).click();commentEdit=comment.locator('.inline-editor');await commentEdit.locator('textarea').fill('**Revised ticket comment**');await commentEdit.getByRole('button',{name:'Remove original-notes.txt',exact:true}).click();
  await commentEdit.evaluate(form=>{const transfer=new DataTransfer();transfer.items.add(new File(['Draft notes'],'dropped-notes.txt',{type:'text/plain'}));form.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));});await commentEdit.getByRole('button',{name:'Remove dropped-notes.txt',exact:true}).click();
  await commentEdit.locator('textarea').evaluate((input,base64)=>{const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0)),transfer=new DataTransfer();transfer.items.add(new File([bytes],'pasted-sketch.png',{type:'image/png'}));input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},png.toString('base64'));await commentEdit.locator('.editor-file img').waitFor();assert.equal(await commentEdit.locator('.editor-file img').evaluate(image=>image.naturalWidth>0),true);
  await commentEdit.getByRole('button',{name:'Save changes',exact:true}).click();await comment.locator('.inline-editor').waitFor({state:'detached'});await comment.locator('.comment-read img').waitFor();await comment.locator('.edited-marker').waitFor();assert.equal(await comment.locator('.comment-read .attachment').filter({hasText:'original-notes.txt'}).count(),0);
  // File-only comments are valid and require just one atomic create request.
  await admin.locator('#ticket-comment-form input[type=file]').setInputFiles({name:'file-only.txt',mimeType:'text/plain',buffer:Buffer.from('A file-only comment')});await admin.locator('#ticket-comment-form button[type=submit]').click();await admin.locator('#ticket-comment-list .attachment').filter({hasText:'file-only.txt'}).waitFor();
  await member.getByRole('button',{name:'Ticket board',exact:true}).click();await member.locator('.ticket-card').filter({hasText:'A ticket for shared editing'}).click();assert.equal(await member.locator('#ticket-comment-list .content-edit-button').count(),0);
  if(process.env.BROWSER_SCREENSHOTS){await mkdir(process.env.BROWSER_SCREENSHOTS,{recursive:true});await comment.getByRole('button',{name:'Edit',exact:true}).click();await admin.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-shared-editor-desktop.png'),fullPage:true});await admin.setViewportSize({width:390,height:844});await comment.locator('.inline-editor').scrollIntoViewIfNeeded();await admin.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-shared-editor-mobile.png'),fullPage:true});}
  // An own edit to loaded history must update the cached older message, too.
  await admin.locator('[data-action=close-modal]').click();
  await admin.evaluate(async()=>{for(let i=0;i<62;i++)await fetch('/api/channels/1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:`History item ${i}`})});});
  await admin.getByRole('button',{name:'Channels',exact:true}).click();await admin.locator('[data-action=older]').click();
  const older=admin.locator(`#message-list #message-${messageId}`);await older.getByRole('button',{name:'Edit',exact:true}).click();await older.locator('.inline-editor textarea').fill('Edited from loaded history.');await older.getByRole('button',{name:'Save changes',exact:true}).click();await older.locator('.inline-editor').waitFor({state:'detached'});await older.locator('.message-body').filter({hasText:'Edited from loaded history.'}).waitFor();
  assert.deepEqual(errors,[]);console.log(`Shared editor browser checks passed (${process.env.BOARD_PUBLIC?'public polling':'local SSE'}): author-only inline edits, atomic files, staged cancellation, preview parity, dirty draft/caret preservation, conflict409, replies, drop/paste and file-only comments.`);
}finally{await browser?.close();if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}await service.close();await rm(dataDir,{recursive:true,force:true});}
