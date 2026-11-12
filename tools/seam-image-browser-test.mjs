'use strict';
/*
 * Browser-driven image capsule send — real Chromium against the local site.
 *
 *   node tools/seam-image-browser-test.mjs
 *
 * Drives the actual product UI: load / -> switch to the Image tab -> wait for
 * the wasm engine -> pick an image -> choose public -> create -> wait for the
 * result modal. Proves the client-side image-send path (file -> bytes -> envelope
 * -> POST /capsules) works in a real browser against the real local Functions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalSite, assertLocal } from './lib/local-site.mjs';

const PNG = '/Users/arshbuttar/.local/go/src/image/testdata/video-001.png';
const pngBuffer = fs.readFileSync(PNG);

const site = await startLocalSite({ host: '127.0.0.1', port: 0 });
const BASE = assertLocal(site.base);

const loadPlaywright = async () => {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');
  const npx = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npx)) {
    for (const dir of fs.readdirSync(npx)) {
      const entry = path.join(npx, dir, 'node_modules', 'playwright', 'index.js');
      if (fs.existsSync(entry)) candidates.push(pathToFileURL(entry).href);
    }
  }
  for (const spec of candidates) {
    try { return await import(spec); } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE to its index.js');
};

const playwright = await loadPlaywright();
const { chromium } = playwright.default || playwright;
const browser = await chromium.launch();

let pass = 0;
let fail = 0;
const pageErrors = [];
const consoleErrors = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}: ${e && e.message ? e.message : e}`);
  }
}

const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

await check('wasm engine reaches ready on the page', async () => {
  await page.waitForFunction(() => window.wasmReady === true, { timeout: 30000 });
});

await check('image file is accepted into the client state', async () => {
  await page.click('#tabImage');
  await page.waitForSelector('#panelImage:not([hidden])', { state: 'visible', timeout: 10000 });
  await page.setInputFiles('#imageFile', { name: 'shot.png', mimeType: 'image/png', buffer: pngBuffer });
  await page.waitForFunction(() => {
    const btn = document.getElementById('createImageBtn');
    const prev = document.getElementById('imagePreview');
    return btn && !btn.disabled && !prev.hidden;
  }, { timeout: 15000 });
});

await check('create image capsule -> result modal opens', async () => {
  await page.click('#createImageBtn');
  await page.waitForSelector('#choice', { state: 'visible', timeout: 10000 });
  await page.click('#choicePublic');
  const createBtn = page.locator('#choice .spim-modal-actions button.spim-btn--primary');
  await createBtn.click();
  await page.waitForSelector('#result:not([class*="spim-hide"])', { state: 'visible', timeout: 30000 });
  const link = await page.inputValue('#shareLink');
  if (!link || !link.includes('#c/')) throw new Error('no capsule link in result: ' + link);
});

const resultText = await page.textContent('#resultMeta').catch(() => null);

await browser.close();
try { await site.close(); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
if (pageErrors.length) console.log('PAGE ERRORS:\n' + pageErrors.slice(0, 5).join('\n'));
if (consoleErrors.length) console.log('CONSOLE ERRORS:\n' + consoleErrors.slice(0, 5).join('\n'));
console.log('result meta text:', resultText);
process.exit(fail === 0 ? 0 : 1);
