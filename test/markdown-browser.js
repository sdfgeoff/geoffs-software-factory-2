import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-markdown-'));
const service = await createApp({ dataDir, agentsEnabled: false });
let browser;
try {
  const { port } = await service.listen(0, '127.0.0.1');
  browser = await chromium.launch({ headless: true, ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) });
  const page = await browser.newPage();
  await page.route('**/app.js', route => route.abort());
  await page.goto(`http://127.0.0.1:${port}`);
  const results = await page.evaluate(async () => {
    const { renderMarkdown } = await import('/markdown.js');
    const input = '**Bold** and *italic* with `code`\n\n- first\n- second\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1))\n\n<script>window.unsafe = true</script>\n\n<img src=x onerror="window.unsafe=true">\n\n![remote](https://example.com/pixel.png)';
    const rendered = renderMarkdown(input);
    const container = document.createElement('div');
    container.innerHTML = rendered;
    document.body.append(container);
    const link = container.querySelector('a[href="https://example.com"]');
    const probes = [
      '[escaped](jav&#x61;script:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '<svg><a xlink:href="javascript:alert(1)">bad</a></svg>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<form id="attributes"><input name="action"></form>',
    ].map(source => {
      const target = document.createElement('div');
      target.innerHTML = renderMarkdown(source);
      return { dangerous: target.querySelectorAll('script,img,svg,iframe,form,input,[onerror],[onclick],a[href^="javascript:"],a[href^="data:"]').length };
    });
    return {
      bold: container.querySelector('strong')?.textContent,
      italic: container.querySelector('em')?.textContent,
      code: container.querySelector('code')?.textContent,
      list: container.querySelectorAll('li').length,
      dangerous: container.querySelectorAll('script,img,[onerror],a[href^="javascript:"]').length,
      rawVisible: container.textContent.includes('<script>window.unsafe = true</script>'),
      external: { target: link?.target, rel: link?.rel },
      unsafe: window.unsafe,
      deterministic: renderMarkdown(input) === rendered,
      probes,
    };
  });
  assert.equal(results.bold, 'Bold');
  assert.equal(results.italic, 'italic');
  assert.equal(results.code, 'code');
  assert.equal(results.list, 2);
  assert.equal(results.dangerous, 0);
  assert.equal(results.rawVisible, true);
  assert.equal(results.external.target, '_blank');
  assert.match(results.external.rel, /noopener/);
  assert.equal(results.unsafe, undefined);
  assert.equal(results.deterministic, true);
  assert.ok(results.probes.every(probe => probe.dangerous === 0));
  console.log('Markdown browser checks passed: shared formatting, literal HTML, safe links and no active content or remote image elements.');
} finally {
  await browser?.close();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}
