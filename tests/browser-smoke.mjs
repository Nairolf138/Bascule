// Optional real-Chrome smoke test; no browser testing package required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 4319;
const profile = await mkdtemp(path.join(tmpdir(), 'bascule-smoke-'));
const downloads = path.join(profile, 'downloads');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.mjs', '--no-open'], { cwd: root, env: { ...process.env, BASCULE_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let chrome;
let socket;
let id = 0;
const pending = new Map();
const exceptions = [];

async function until(check, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch { /* loading */ }
    await pause(100);
  }
  throw new Error('Délai dépassé pendant le test navigateur.');
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok);
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1440,1100', `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore', windowsHide: true });
  const debuggerPort = await until(async () => {
    const content = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(content.split(/\r?\n/)[0]) || null;
  });
  const tab = await until(async () => {
    const tabs = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/list`)).json();
    return tabs.find((item) => item.type === 'page' && item.url.includes(`127.0.0.1:${port}`));
  });
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params.exceptionDetails.text);
    if (!event.id) return;
    const call = pending.get(event.id);
    if (!call) return;
    pending.delete(event.id);
    event.error ? call.reject(new Error(event.error.message)) : call.resolve(event.result);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await until(async () => Number(await evaluate("document.querySelector('.metric.attention strong')?.textContent")) >= 5);
  const initial = await evaluate("({attention:Number(document.querySelector('.metric.attention strong').textContent),cards:document.querySelectorAll('.change-card').length,statement:document.querySelector('#resultStatement').textContent})");
  assert.equal(initial.cards, initial.attention);
  assert.match(initial.statement, /écarts?/);
  if (process.argv.includes('--preview')) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(root, 'preview.png'), Buffer.from(screenshot.data, 'base64'));
  }

  await evaluate("document.querySelector('[data-filter=all]').click()");
  assert.equal(Number(await evaluate("document.querySelectorAll('.change-card').length")), 8);
  await evaluate("document.querySelector('[data-filter=unchanged]').click()");
  assert.equal(Number(await evaluate("document.querySelectorAll('.change-card').length")), 4);
  await evaluate("document.querySelector('[data-filter=all]').click()");
  await evaluate("document.querySelector('#search').value='99,9';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.change-card').length"), 1);
  await evaluate("document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))");
  await evaluate("const box=document.querySelector('#newText');box.value=box.value.replace('99,9 %','98,7 %');box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#analyzeButton').click()");
  assert.ok(await evaluate("document.querySelector('#changeList').textContent.includes('98,7 %')"));
  await evaluate("document.querySelector('.change-card [data-review-state=verified]').click()");
  await evaluate("const note=document.querySelector('.change-card [data-review-note]');note.value='Valeur confirmée avec l’équipe.';note.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.match(await evaluate("document.querySelector('#reviewProgress').textContent"), /1 \/ 8 triés/);

  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await evaluate("document.querySelector('#reportButton').click()");
  const reportName = await until(async () => (await readdir(downloads)).find((name) => name.endsWith('.md')));
  const report = await readFile(path.join(downloads, reportName), 'utf8');
  assert.match(report, /98,7 %/);
  assert.match(report, /ancienne ligne/);
  assert.match(report, /Valeur confirmée avec l’équipe/);
  await evaluate("document.querySelector('#projectExportButton').click()");
  const projectName = await until(async () => (await readdir(downloads)).find((name) => name.endsWith('.json')));
  const project = await readFile(path.join(downloads, projectName), 'utf8');
  assert.match(project, /Valeur confirmée avec l’équipe/);
  await evaluate("document.querySelector('#exampleButton').click()");
  await evaluate(`const projectFile=new File([${JSON.stringify(project)}],'bascule-projet.json',{type:'application/json'});const data=new DataTransfer();data.items.add(projectFile);const input=document.querySelector('#projectFile');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(async () => (await evaluate("document.querySelector('#status').textContent")).includes('Projet chargé'));
  assert.match(await evaluate("document.querySelector('#reviewProgress').textContent"), /1 \/ 8 triés/);
  assert.ok(await evaluate("document.querySelector('#changeList').textContent.includes('98,7 %')"));
  await evaluate("(()=>{const edited=document.querySelector('#newText');edited.value=edited.value.replace('8 heures ouvrées','9 heures ouvrées');edited.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#reportButton').click()})()");
  assert.ok(await evaluate("document.querySelector('#changeList').textContent.includes('9 heures ouvrées')"));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.reload', { ignoreCache: true });
  await until(async () => Number(await evaluate("document.querySelector('.metric.attention strong')?.textContent")) >= 5);
  const dimensions = await evaluate("({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth})");
  assert.equal(dimensions.viewport, 390);
  assert.ok(dimensions.document <= 390, `Débordement horizontal : ${JSON.stringify(dimensions)}`);
  if (process.argv.includes('--preview')) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(root, 'preview-mobile.png'), Buffer.from(screenshot.data, 'base64'));
    await evaluate("document.querySelector('#results').scrollIntoView({behavior:'instant',block:'start'})");
    await pause(100);
    const resultsScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(root, 'preview-mobile-results.png'), Buffer.from(resultsScreenshot.data, 'base64'));
  }
  assert.deepEqual(exceptions, []);
  console.log('Chrome : exemple, filtres, recherche, relecture, exports, import et affichage mobile vérifiés.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close'); } catch { /* already closing */ }
    socket.close();
  }
  server.kill();
  chrome?.kill();
  await pause(300);
  if (path.dirname(profile) === tmpdir() && path.basename(profile).startsWith('bascule-smoke-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
