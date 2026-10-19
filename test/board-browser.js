import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createPublicGateway } from '../scripts/public-gateway.js';

const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-board-browser-'));
const service = await createApp({dataDir,agentsEnabled:false});
let browser, gateway;
try {
  const {port} = await service.listen(0,'127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({headless:true,...(existsSync('/usr/bin/chromium') ? {executablePath:'/usr/bin/chromium'} : {})});
  const first = await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}), second = await browser.newContext({reducedMotion:'reduce'});
  const admin = await first.newPage(), member = await second.newPage();
  const errors=[]; [admin,member].forEach(page => page.on('pageerror',error => errors.push(error.message)));
  await admin.goto(base);
  await admin.locator('#auth-form [name=display_name]').fill('Board Admin');
  await admin.locator('#auth-form [name=username]').fill('boardadmin');
  await admin.locator('#auth-form [name=password]').fill('board password test');
  await admin.locator('#auth-form button[type=submit]').click();
  await admin.locator('#message-input').waitFor();
  const memberResponse = await first.request.post(`${base}/api/admin/users`,{data:{display_name:'Board Member',username:'boardmember',password:'member password test',role:'member'}});
  assert.equal(memberResponse.status(),201);
  const agentResponse = await first.request.post(`${base}/api/admin/agents`,{data:{display_name:'Ada',username:'ada',instructions:'Work thoughtfully on shared tickets.',subscriptions:[]}});
  assert.equal(agentResponse.status(),201);
  const agent = await agentResponse.json();
  let site = base;
  if(process.env.BOARD_PUBLIC){
    await first.clearCookies();
    site='https://board.commonroom.test'; gateway=createPublicGateway({targetPort:port,publicOrigin:site});
    await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
    const gatewayBase=`http://127.0.0.1:${gateway.address().port}`;
    for(const context of [first,second]) await context.route(`${site}/**`,async route=>{
      const request=route.request(),url=new URL(request.url());
      const response=await route.fetch({url:gatewayBase+url.pathname+url.search,headers:{...request.headers(),host:url.host,...(!['GET','HEAD'].includes(request.method())?{origin:site,'sec-fetch-site':'same-origin'}:{})}});
      await route.fulfill({response});
    });
    await admin.goto(site);await admin.locator('#auth-form [name=username]').fill('boardadmin');await admin.locator('#auth-form [name=password]').fill('board password test');await admin.locator('#auth-form button[type=submit]').click();
  } else await admin.reload();
  await admin.locator('#message-input').waitFor();
  await member.goto(site);await member.locator('#auth-form [name=username]').fill('boardmember');await member.locator('#auth-form [name=password]').fill('member password test');await member.locator('#auth-form button[type=submit]').click();await member.locator('#message-input').waitFor();
  await admin.getByRole('button',{name:'Ticket board',exact:true}).click();
  await member.getByRole('button',{name:'Ticket board',exact:true}).click();
  await admin.getByRole('button',{name:'New ticket',exact:true}).click();
  await admin.locator('#ticket-form [name=title]').fill('Write a getting-started guide');
  await admin.locator('#ticket-form [name=description]').fill('A shared task for people and AI agents.');
  await admin.locator('#ticket-form [name=assignee_id]').selectOption(String(agent.user_id));
  await admin.locator('#ticket-form button[type=submit]').click();
  await admin.locator('#ticket-subscribe').waitFor();
  await member.locator('.ticket-card').filter({hasText:'Write a getting-started guide'}).waitFor();
  await member.locator('.ticket-card').first().click();
  await member.locator('#ticket-subscribe').click();
  await member.locator('#ticket-comment-body').fill('I can review this when the draft is ready.');
  await member.locator('#ticket-comment-form button[type=submit]').click();
  await admin.locator('#ticket-comment-list').getByText('I can review this when the draft is ready.',{exact:true}).waitFor();
  // A live comment must not erase the editor's unsaved text or reset its selection.
  await admin.locator('#ticket-form [name=description]').fill('Unsaved description survives live updates.');
  await member.locator('#ticket-comment-body').fill('Another update, while you are editing.');
  await member.locator('#ticket-comment-form button[type=submit]').click();
  await admin.locator('#ticket-comment-list').getByText('Another update, while you are editing.',{exact:true}).waitFor();
  assert.equal(await admin.locator('#ticket-form [name=description]').inputValue(),'Unsaved description survives live updates.');
  // A comment changed the version, so reopen the ticket before editing its status.
  await admin.locator('[data-action=close-modal]').click();await admin.locator('.ticket-card').first().click();
  await admin.locator('#ticket-form [name=status]').selectOption('review');await admin.locator('#ticket-form button[type=submit]').click();
  await admin.locator('#ticket-form .form-feedback .form-error').waitFor({state:'detached'});
  await admin.locator('[data-action=close-modal]').click();await admin.locator('[data-status=review] .ticket-card').waitFor();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await member.locator('[data-action=close-modal]').click();await member.locator('[data-status=review] .ticket-card').click();
  await member.locator('input[data-upload=ticket]').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('Shared ticket notes')});
  await member.locator('#ticket-attachments .attachment').filter({hasText:'notes.txt'}).waitFor();
  await member.locator('#ticket-comment-body').fill('Here is the diagram.');
  await member.locator('#ticket-comment-form input[type=file]').setInputFiles({name:'comment-sketch.png',mimeType:'image/png',buffer:png});
  await member.locator('#ticket-comment-form button[type=submit]').click();
  await member.locator('#ticket-comment-list img').waitFor();
  // A comment followed by an own edit advances the local optimistic version.
  await member.locator('#ticket-form [name=status]').selectOption('done');await member.locator('#ticket-form button[type=submit]').click();
  await member.locator('[data-action=close-modal]').click();await member.locator('[data-status=done] .ticket-card').waitFor();
  assert.ok(await admin.locator('#notice-count').isVisible());
  if(process.env.BROWSER_SCREENSHOTS){await mkdir(process.env.BROWSER_SCREENSHOTS,{recursive:true});await admin.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-board-desktop.png'),fullPage:true});await admin.locator('.ticket-card').first().click();await admin.locator('.ticket-drawer').waitFor();await admin.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-ticket-desktop.png'),fullPage:true});await admin.locator('[data-action=close-modal]').click();}
  await member.setViewportSize({width:390,height:844});await member.locator('.ticket-card').first().click();
  await member.locator('.ticket-drawer').waitFor();
  const width=await member.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(width.scroll<=width.viewport);
  if(process.env.BROWSER_SCREENSHOTS)await member.screenshot({path:join(process.env.BROWSER_SCREENSHOTS,'commonroom-ticket-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Board browser checks passed: multiuser tickets, agents, review/done, comments, draft preservation, ticket/comment images/files, notifications and mobile drawer.');
} finally {await browser?.close();if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}await service.close();await rm(dataDir,{recursive:true,force:true});}
