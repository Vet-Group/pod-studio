// Test the wireframe prototype with Chromium over CDP, without a shell or external libraries.
// Run: node design/wireframes/test-wireframes.mjs
// Optional: CHROME_PATH=... specifies the browser. SCREENSHOTS=0 skips screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.html');
const shotsDir = join(here, 'screenshots');
const chromePath = process.env.CHROME_PATH || require('@playwright/test').chromium.executablePath();
const takeShots = process.env.SCREENSHOTS !== '0';
const port = 9300 + Math.floor(Math.random() * 400);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

// Static checks
const html = readFileSync(indexPath, 'utf8');
check('No long dashes or curly quotes', !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(html));
check('No external resources loaded (src/href http)', !/(src|href)\s*=\s*["']https?:/i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html));
check('Sidebar is 216px wide', /\.sidebar\{width:216px/.test(html));
check('Includes prefers-reduced-motion', html.includes('prefers-reduced-motion:reduce'));
check('Uses native dialogs', html.includes('<dialog') && html.includes('showModal()'));

if (!existsSync(chromePath)) { console.error('Chromium not found: ' + chromePath); process.exit(2); }
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'podwf-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const pending = new Map(); const netRequests = []; const consoleErrors = [];
async function connect() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('Chromium did not open the CDP port');
}
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function key(k, code, keyCode) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }); await sleep(60); }
async function viewport(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }); await sleep(150); }
async function shot(name) { if (!takeShots) return; mkdirSync(shotsDir, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(r.data, 'base64')); }
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('missing '+${JSON.stringify(sel)});e.click();return true})()`);
const text = () => ev('document.body.innerText');
// Height difference between the 2 card columns on screen 7 (0 when there is only 1 column).
const nicheColGap = () => ev(`(()=>{const s=document.querySelector('.nsec').getBoundingClientRect();const c=[...document.querySelectorAll('.nsec [data-section]')].map(e=>e.getBoundingClientRect());const xs=[...new Set(c.map(b=>Math.round(b.left)))];if(xs.length<2)return 0;const bot=xs.map(x=>Math.max(...c.filter(b=>Math.round(b.left)===x).map(b=>b.bottom)));return Math.round(Math.max(...bot)-Math.min(...bot));})()`);

try {
  ws = new WebSocket(await connect());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    if (d.method === 'Network.requestWillBeSent') netRequests.push(d.params.request.url);
    if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description || 'exception');
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push(JSON.stringify(d.params.args.map(a => a.value))); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await viewport(1440, 1000);
  await send('Page.navigate', { url: pathToFileURL(indexPath).href }); await sleep(900);

  // 1 Studio: Design library
  check('Has 7 navigation items', (await ev('document.querySelectorAll("#nav button").length')) === 7);
  check('Measured sidebar width is 216px', (await ev('document.querySelector(".sidebar").getBoundingClientRect().width')) === 216);
  check('Page title is in English', (await ev('document.title')).includes('Workspace'));
  check('Studio shows finalized decisions, with no proposal wording', (await text()).includes('skill library is shared company-wide') && !(await text()).includes('not confirmed'));
  check('DEMO label is visible', (await ev('document.querySelector(".demo").innerText')) === 'DEMO');
  check('Displays 6 SVG design cards', (await ev('document.querySelectorAll(".designcard svg").length')) >= 6);
  await shot('01-studio-1440');
  await ev(`(()=>{const s=document.querySelector('#search');s.value='wave';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('Search filters designs', (await ev('document.querySelectorAll(".designcard").length')) === 1);
  check('Search keeps focus in the input', (await ev('document.activeElement.id')) === 'search');
  await ev(`(()=>{const s=document.querySelector('#search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('[data-action="upload"]');
  check('Upload drawer opens as a native dialog', await ev('document.querySelector("#modal").open && document.querySelector("#modal").classList.contains("drawer")'));
  check('Focus is inside the dialog', await ev('document.querySelector("#modal").contains(document.activeElement)'));
  await shot('02-upload-drawer-1440');
  await key('Escape', 'Escape', 27); await sleep(100);
  check('Esc closes the dialog and returns focus to the opening button', await ev('!document.querySelector("#modal").open && document.activeElement.dataset.action==="upload"'));
  await ev(`(()=>{const c=document.querySelector('[data-select="0"]');c.click()})()`);
  await click('[data-action="mockup"]'); await click('[data-action="createMockup"]');
  await click('[data-action="queue"]');
  check('Mockup job enters the queue', (await ev('document.querySelector("#modal").innerText')).includes('Create mockups: 1'));
  await click('[data-canceljob]');
  check('Cancel a queued job', (await ev('document.querySelector("#modal").innerText')).includes('Canceled'));
  await click('#modal [data-close]');

  // 2 Review: Design review
  await click('[data-nav="review"]');
  check('Design review screen has the original and mockup', (await text()).includes('Original') && (await text()).includes('Mockup'));
  await key('ArrowRight', 'ArrowRight', 39);
  check('Right arrow key switches mockups', (await ev('document.querySelector("h1").innerText')) === 'June sun');
  await key('a', 'KeyA', 65);
  check('A key approves the design', (await text()).includes('DEMO result: Approved'));
  await key('ArrowLeft', 'ArrowLeft', 37);
  check('Left arrow key goes back', (await ev('document.querySelector("h1").innerText')) === 'Green space');
  await key('r', 'KeyR', 82);
  check('R key opens the rejection dialog', await ev('document.querySelector("#modal").open && document.querySelector("#rejectReason")!==null'));
  await click('[data-action="confirmReject"]');
  check('Rejection reason is required', await ev('document.querySelector("#modal").open'));
  await ev(`document.querySelector('#rejectReason').value='Colors differ from the original'`);
  await click('[data-action="confirmReject"]');
  check('Rejection updates the status', (await text()).includes('DEMO result: Rejected'));
  await shot('03-review-1440');

  // 3 Listing: Listing content
  await click('[data-nav="listing"]');
  await click('[data-action="generate"]');
  check('Generating content updates the preview', (await ev('document.querySelector("#previewTitle").innerText')) === 'Botanical wall art');
  await ev(`(()=>{const t=document.querySelector('#listingTitle');t.value='Test title';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('Editing the title updates the preview live', (await ev('document.querySelector("#previewTitle").innerText')) === 'Test title');
  await shot('04-listing-content-1440');
  await click('[data-listtab="analysis"]'); await click('[data-action="analyze"]');
  check('Analysis tab runs a simulation', (await text()).includes('Simulation complete'));
  await shot('05-listing-analysis-1440');

  // 4 Products: Products & push
  await click('[data-nav="products"]');
  check('Variant table has 3 rows', (await ev('document.querySelectorAll("tbody tr").length')) === 3);
  await click('[data-action="publish"]');
  check('Publishing is blocked before a dry run', !(await ev('document.querySelector("#modal").open')) && (await ev('document.querySelector("#toast").innerText')).includes('dry run'));
  await click('[data-action="dryrun"]');
  check('Dry run displays results', (await text()).includes('Product data is valid'));
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='admin';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]');
  check('Admin cannot publish by default', (await ev('document.querySelector("#modal").innerText')).includes('do not get publish permission automatically'));
  await click('#modal [data-close]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='delegate';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]');
  check('Delegate does not have publish permission by default', (await ev('document.querySelector("#modal").innerText')).includes('No publish permission'));
  await click('#modal [data-close]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='owner';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]'); await click('[data-action="confirmPublish"]');
  check('Confirmation requires the checkbox to be checked', await ev('document.querySelector("#modal").open'));
  await ev(`document.querySelector('#confirmPublish').checked=true`); await click('[data-action="confirmPublish"]');
  check('Store owner simulates publishing', (await text()).includes('Published in simulation'));
  await ev(`(()=>{const p=document.querySelector('[data-price="0"]');p.value='30';p.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check('Changing the price clears dry-run results', !(await text()).includes('Product data is valid'));
  await shot('06-products-1440');

  // 5 Team: Stores & members
  await click('[data-nav="team"]');
  check('Has 3 stores to choose from', (await ev('document.querySelectorAll("[data-store]").length')) === 3);
  await ev(`(()=>{const c=document.querySelector('#delegatePublish');c.click()})()`);
  await click('[data-nav="products"]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='delegate';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check('Explicit delegation grants publish permission to Casey Lee', (await text()).includes('Publish permission: Yes'));
  await click('[data-nav="team"]');
  await click('[data-action="invite"]');
  await click('[data-action="createInvite"]');
  check('Invite email is validated', await ev('document.querySelector("#inviteForm")!==null'));
  await ev(`document.querySelector('#inviteEmail').value='moi@example.invalid'`);
  await click('[data-action="createInvite"]');
  check('DEMO invite is created', (await ev('document.querySelector("#modal").innerText')).includes('moi@example.invalid'));
  await click('#modal [data-close]');
  await shot('07-team-1440');
  await click('[data-store="2"]');
  check('Store selection syncs the top selector', (await ev('document.querySelector("#storeSelect").value')) === '2');
  check('Delegation is disabled for a store the user does not own', await ev('document.querySelector("#delegatePublish").disabled'));
  await click('[data-store="0"]');

  // 6 Skills: Skills & operations
  await click('[data-nav="skills"]');
  check('Has 4 skills and operations tabs', (await ev('document.querySelectorAll("[data-skilltab]").length')) === 4);
  await shot('08-skills-1440');
  await click('[data-skilltab="health"]');
  const health = await text();
  check('Health tab displays only rest periods', health.includes('not a usage limit') && !/allowance|spending limit|quota|budget/i.test(health));
  check('Health tab has an AI account table and worker list', await ev('!!document.querySelector("table.health") && document.body.innerText.includes("browser-01@studio-host")'));
  await click('[data-action="relogged"]');
  check('Logged in again button records the status', (await text()).includes('Sign-in reported'));
  await shot('09-operations-1440');
  await click('[data-skilltab="providers"]');
  check('No fallback API switching', (await text()).includes('does not switch to another API automatically'));

  // 7 Niche: Niche data, editing niche master data using the generator schema 2.0
  await click('[data-nav="niche"]'); await sleep(80);
  const nq = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText`);
  const nset = (sel, v) => ev(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});s.value=${JSON.stringify(v)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const disabled = sel => ev(`document.querySelector(${JSON.stringify(sel)}).disabled`);
  check('Switching screens dismisses the previous screen notification', (await ev('document.querySelector("#toast").textContent')) === '');
  check('Screen 7 opens from navigation', (await nq('h1')) === 'Edit master data, build skills.');
  check('Screen 7 has exactly 5 steps', (await ev('document.querySelectorAll("[data-nstep]").length')) === 5);
  const t7 = await text();
  check('Editing and publishing permissions are separate', t7.includes('skill.edit') && t7.includes('skill.publish'));
  const allSections = await ev(`(async()=>{const ids=[];for(let i=0;i<5;i++){document.querySelector('[data-nstep="'+i+'"]').click();await new Promise(r=>setTimeout(r,30));document.querySelectorAll('[data-section]').forEach(s=>ids.push(s.dataset.section));}document.querySelector('[data-nstep="0"]').click();return ids})()`);
  check('Includes all 17 schema sections', allSections.length === 17 && new Set(allSections).size === 17, allSections.length + ' section');
  check('Step 1 reports personas at 8/8', (await nq('[data-count="personas"]')) === '8 / minimum 8');
  check('Data status has exactly 3 levels', (await ev('[...document.querySelectorAll("#nicheStatus option")].map(o=>o.value).join(",")')) === 'curated-draft,researched,validated');
  check('Missing data blocks the build', (await disabled('[data-nbuild]')) === true);
  const errText = await nq('.nerrs');
  check('Occasion error matches the validator format', errText.includes('- occasions: requires at least 8 records; found 6'));
  check('Sample brief error uses the correct threshold of 6', errText.includes('- sample_briefs: requires at least 6 records; found 4'));
  check('Steps with errors have red labels', (await nq('[data-nstep="1"] .badge.red')) === '1 error');
  await click('[data-nfix="occasions"]'); await sleep(60);
  check('Fix button jumps to the correct step', (await ev('document.querySelector("[aria-current=step]").dataset.nstep')) === '1');
  check('Fix button focuses the invalid field', (await ev('document.activeElement.dataset.nadd')) === 'occasions');
  await click('[data-nadd="occasions"]'); await click('[data-nadd="occasions"]');
  check('Adding occasions to 8/8 clears the error', (await nq('[data-count="occasions"]')) === '8 / minimum 8' && !(await nq('.nerrs')).includes('occasions'));
  await click('[data-nnext]'); await sleep(40);
  check('Typography requires at least 3 entries', (await nq('[data-count="visual_vocabulary.typography"]')) === '3 / minimum 3');
  await click('[data-nnext]'); await sleep(40);
  await click('[data-nadd="sample_briefs"]'); await click('[data-nadd="sample_briefs"]');
  check('Sample briefs reach 6/6', (await nq('[data-count="sample_briefs"]')) === '6 / minimum 6');
  check('Market scoring has 6 criteria', (await ev('document.querySelectorAll("[data-score]").length')) === 6);
  check('Default total score of 26/30 is Go', (await nq('#fitTotal')) === '26/30' && (await nq('#fitVerdict')) === 'Produce');
  await nset('[data-score="ip"]', '3'); await sleep(40);
  check('IP score below 4 always blocks', (await nq('#fitVerdict')).startsWith('Blocked'));
  await nset('[data-score="ip"]', '5'); await sleep(40);
  await click('[data-nnext]'); await sleep(40);
  check('Exactly 4 style variants, with the add button disabled', (await nq('[data-count="style_variants"]')) === '4 / exactly 4' && (await disabled('[data-nadd="style_variants"]')) === true);
  const gap1440 = await nicheColGap();
  check('Step 5 at 1440px has no gap below QA Rules', gap1440 <= 1, 'difference ' + gap1440 + 'px');
  const qa = await nq('[data-section="qa_rules"]');
  check('QA rules are an object with background #00FF00 and ratio 3:4', qa.includes('#00FF00') && qa.includes('3:4'));
  await nset('#nicheMaxColors', '13'); await sleep(40);
  check('13 colors triggers a 1 to 12 range error', (await text()).includes('qa_rules.max_colors: expected an integer from 1 to 12') && (await disabled('[data-nbuild]')) === true);
  await nset('#nicheMaxColors', '6'); await sleep(40);
  check('Complete data enables the build', (await disabled('[data-nbuild]')) === false);
  await click('[data-nbuild]'); await sleep(60);
  const built = await text();
  check('Completed build is still unpublished', built.includes('DEMO skill version v3 built') && built.includes('Not published') && (await ev('document.activeElement.className')) === 'nbuilt');
  await shot('12-niche-1440');

  // Themes
  for (const [t, name] of [['dense', '10-theme-dense-1440'], ['dark', '11-theme-dark-1440']]) {
    await click(`[data-theme="${t}"]`); await click('[data-nav="studio"]');
    check(`Direction ${t} applies the body class`, (await ev('document.body.className')) === t);
    await shot(name);
  }
  await click('[data-theme="light"]');

  // Responsive
  for (const [w, h] of [[1024, 900], [760, 1000], [390, 844]]) {
    await viewport(w, h);
    // Every nav label must be fully visible: inside the viewport and not truncated by its own box.
    const navClip = await ev(`[...document.querySelectorAll('#nav button')].filter(b => { const r = b.getBoundingClientRect(); const l = b.querySelector('span'); return r.left < 0 || r.right > ${w} + 1 || (l && l.scrollWidth > l.clientWidth + 1); }).map(b => b.textContent.trim())`);
    check(`Navigation labels at ${w}px are not clipped`, navClip.length === 0, navClip.join(', '));
    // Compare against the requested width: with mobile emulation window.innerWidth grows with the
    // content, which hid a real 122px overflow on the review screen.
    for (const s of ['studio', 'review', 'listing', 'products', 'team', 'skills', 'niche']) {
      await click(`[data-nav="${s}"]`); await sleep(80);
      const overflow = await ev(`document.documentElement.scrollWidth - ${w}`);
      check(`No horizontal overflow on ${s} at ${w}px`, overflow <= 1, 'overflow ' + overflow + 'px');
      if (s === 'niche' && w === 1024) { await click('[data-nstep="4"]'); await sleep(40); const g = await nicheColGap(); check('Step 5 at 1024px has balanced columns', g <= 1, 'difference ' + g + 'px'); }
      if (s === 'niche' && w === 390) { await click('[data-nstep="4"]'); await sleep(40); const order = await ev('[...document.querySelectorAll(".nsec [data-section]")].map(e=>e.dataset.section).join(",")'); check('Step 5 at 390px keeps Style, IP, QA order in one column', order === 'style_variants,ip_safety,qa_rules' && (await nicheColGap()) === 0, order); }
      await shot(`${s}-${w}`);
    }
  }
  await viewport(1440, 1000);

  // UI quality floor across screens, widths and visual directions: WCAG AA text contrast,
  // no text under 11px, controls at least 32px, and toasts never covering sticky action bars.
  const QUALITY = `(()=>{
    const parse=c=>{const m=c.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
    const lum=({r,g,b})=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
    const bgOf=el=>{const layers=[];for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break;}}let base={r:255,g:255,b:255};for(const c of layers.reverse())base={r:c.r*c.a+base.r*(1-c.a),g:c.g*c.a+base.g*(1-c.a),b:c.b*c.a+base.b*(1-c.a)};return base};
    const vis=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.05};
    const name=e=>(e.innerText||e.getAttribute('aria-label')||e.className||e.tagName).toString().trim().slice(0,24);
    const contrast=[],small=[],tiny=[],tap44=[];const seen=new Set();
    const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(w.nextNode()){const e=w.currentNode.parentElement;if(!w.currentNode.textContent.trim()||!e||seen.has(e)||!vis(e)||e.closest('svg,.sr,[aria-hidden=true],[disabled],[aria-disabled=true]'))continue;seen.add(e);
      const s=getComputedStyle(e);const fs=parseFloat(s.fontSize);if(fs<11)small.push(name(e)+' '+fs+'px');
      const fg=parse(s.color);if(!fg)continue;const bg=bgOf(e);const mix={r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a)};
      const a=lum(mix),b=lum(bg);const cr=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);const need=(fs>=24||(fs>=18.66&&+s.fontWeight>=700))?3:4.5;
      if(cr<need)contrast.push(name(e)+' '+cr.toFixed(2));}
    for(const e of document.querySelectorAll('button,a[href],input,select,textarea,summary,label.cardcheck,label.checkline')){if(!vis(e)||(e.matches('input[type=checkbox],input[type=radio]')&&e.closest('label')))continue;const r=e.getBoundingClientRect();if(r.height<32||r.width<32)tiny.push(name(e)+' '+Math.round(r.width)+'x'+Math.round(r.height));if(r.height<44||r.width<44)tap44.push(name(e)+' '+Math.round(r.width)+'x'+Math.round(r.height));}
    return {contrast,small,tiny,tap44};})()`;
  const floor = { contrast: [], small: [], tiny: [], tap44: [] };
  for (const theme of ['light', 'dense', 'dark']) {
    await click(`[data-theme="${theme}"]`);
    for (const [w, h] of [[1440, 1000], [1024, 900], [760, 1000], [390, 844]]) {
      await viewport(w, h);
      for (const s of ['studio', 'review', 'listing', 'products', 'team', 'skills', 'niche']) {
        await click(`[data-nav="${s}"]`); await sleep(40);
        const q = await ev(QUALITY);
        for (const k of ['contrast', 'small', 'tiny']) for (const x of q[k]) floor[k].push(`${theme}/${w}/${s}: ${x}`);
        if (w === 390) for (const x of q.tap44) floor.tap44.push(`${theme}/${s}: ${x}`);
      }
    }
  }
  await click('[data-theme="light"]');
  check('Text meets WCAG AA contrast across 3 directions and 4 widths', floor.contrast.length === 0, floor.contrast.slice(0, 3).join(' | '));
  check('No text smaller than 11px', floor.small.length === 0, floor.small.slice(0, 3).join(' | '));
  check('Buttons and selection controls are at least 32px', floor.tiny.length === 0, floor.tiny.slice(0, 3).join(' | '));
  check('Tap targets at 390px are at least 44px', floor.tap44.length === 0, floor.tap44.slice(0, 3).join(' | '));
  const toastHits = [];
  for (const [w, h] of [[1440, 1000], [1024, 900], [760, 1000], [390, 844]]) {
    await viewport(w, h);
    for (const s of ['review', 'niche']) {
      await click(`[data-nav="${s}"]`); await sleep(40);
      for (const y of ['0', 'document.documentElement.scrollHeight']) {
        await ev(`window.scrollTo(0, ${y})`); await sleep(40);
        const hit = await ev(`(async()=>{toast('Check notification position');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const a=document.querySelector('#toast').getBoundingClientRect();const pe=getComputedStyle(document.querySelector('#toast')).pointerEvents;const out=[...document.querySelectorAll('.reviewcontrols button,.nbar button')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.bottom>0&&b.top<innerHeight&&!(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom)}).map(e=>e.textContent.trim());document.querySelector('#toast').textContent='';return pe!=='none'?['pointer-events='+pe]:out})()`);
        for (const x of hit) toastHits.push(`${s}/${w}: ${x}`);
      }
    }
  }
  await viewport(1440, 1000);
  check('Toasts do not cover sticky action bars or block clicks', toastHits.length === 0, toastHits.slice(0, 3).join(' | '));

  // Focus visibility and semantics
  await click('[data-nav="studio"]');
  const clickableDivs = await ev('[...document.querySelectorAll("div[onclick],span[onclick]")].length');
  check('No div/span elements used as buttons', clickableDivs === 0);
  await ev('document.querySelector("[data-action=upload]").focus()');
  check('Focus is clearly visible', (await ev('getComputedStyle(document.activeElement).outlineStyle')) !== 'none');
  const external = netRequests.filter(u => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:'));
  check('No outgoing network requests', external.length === 0, external.slice(0, 3).join(', '));
  check('No JavaScript errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (err) {
  check('Test execution', false, err.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.${takeShots ? ' Screenshots: ' + shotsDir : ''}`);
process.exit(failed.length ? 1 : 0);
