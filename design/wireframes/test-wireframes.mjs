// Kiểm thử nguyên mẫu wireframe bằng Chromium qua CDP, không cần shell hay thư viện ngoài.
// Chạy: node design/wireframes/test-wireframes.mjs
// Tùy chọn: CHROME_PATH=... để chỉ định trình duyệt. SCREENSHOTS=0 để bỏ chụp ảnh.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.html');
const shotsDir = join(here, 'screenshots');
const chromePath = process.env.CHROME_PATH || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const takeShots = process.env.SCREENSHOTS !== '0';
const port = 9300 + Math.floor(Math.random() * 400);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

// Static checks
const html = readFileSync(indexPath, 'utf8');
check('Không có dấu gạch dài hoặc ngoặc kép cong', !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(html));
check('Không tải tài nguyên ngoài (src/href http)', !/(src|href)\s*=\s*["']https?:/i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html));
check('Sidebar rộng 216px', /\.sidebar\{width:216px/.test(html));
check('Có prefers-reduced-motion', html.includes('prefers-reduced-motion:reduce'));
check('Dùng dialog gốc', html.includes('<dialog') && html.includes('showModal()'));

if (!existsSync(chromePath)) { console.error('Không tìm thấy Chromium: ' + chromePath); process.exit(2); }
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'podwf-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const pending = new Map(); const netRequests = []; const consoleErrors = [];
async function connect() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('Chromium không mở cổng CDP');
}
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
async function key(k, code, keyCode) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }); await sleep(60); }
async function viewport(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }); await sleep(150); }
async function shot(name) { if (!takeShots) return; mkdirSync(shotsDir, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(r.data, 'base64')); }
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('missing '+${JSON.stringify(sel)});e.click();return true})()`);
const text = () => ev('document.body.innerText');
// Chênh chiều cao giữa 2 cột thẻ ở màn 7 (0 khi chỉ có 1 cột).
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

  // 1 Studio
  check('Có 7 mục điều hướng', (await ev('document.querySelectorAll("#nav button").length')) === 7);
  check('Sidebar đo được 216px', (await ev('document.querySelector(".sidebar").getBoundingClientRect().width')) === 216);
  check('Tiêu đề trang bằng tiếng Việt', (await ev('document.title')).includes('Bàn làm việc'));
  check('Studio ghi quyết định đã chốt, không còn chữ đề xuất', (await text()).includes('dùng chung toàn công ty đã chốt') && !(await text()).includes('chưa xác nhận'));
  check('Nhãn DEMO hiển thị', (await ev('document.querySelector(".demo").innerText')) === 'DEMO');
  check('Hiển thị 6 thẻ thiết kế SVG', (await ev('document.querySelectorAll(".designcard svg").length')) >= 6);
  await shot('01-studio-1440');
  await ev(`(()=>{const s=document.querySelector('#search');s.value='sóng';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('Tìm kiếm lọc thiết kế', (await ev('document.querySelectorAll(".designcard").length')) === 1);
  check('Tìm kiếm giữ focus ô nhập', (await ev('document.activeElement.id')) === 'search');
  await ev(`(()=>{const s=document.querySelector('#search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click('[data-action="upload"]');
  check('Ngăn kéo tải lên mở bằng dialog gốc', await ev('document.querySelector("#modal").open && document.querySelector("#modal").classList.contains("drawer")'));
  check('Focus nằm trong dialog', await ev('document.querySelector("#modal").contains(document.activeElement)'));
  await shot('02-upload-drawer-1440');
  await key('Escape', 'Escape', 27); await sleep(100);
  check('Esc đóng dialog và trả focus về nút mở', await ev('!document.querySelector("#modal").open && document.activeElement.dataset.action==="upload"'));
  await ev(`(()=>{const c=document.querySelector('[data-select="0"]');c.click()})()`);
  await click('[data-action="mockup"]'); await click('[data-action="createMockup"]');
  await click('[data-action="queue"]');
  check('Tác vụ mô phỏng vào hàng đợi', (await ev('document.querySelector("#modal").innerText')).includes('Tạo 1 mẫu mô phỏng'));
  await click('[data-canceljob]');
  check('Hủy tác vụ trong hàng đợi', (await ev('document.querySelector("#modal").innerText')).includes('Đã hủy'));
  await click('#modal [data-close]');

  // 2 Review
  await click('[data-nav="review"]');
  check('Màn duyệt có bản gốc và mẫu mô phỏng', (await text()).includes('BẢN GỐC') && (await text()).includes('MẪU MÔ PHỎNG'));
  await key('ArrowRight', 'ArrowRight', 39);
  check('Phím mũi tên phải chuyển mẫu', (await ev('document.querySelector("h1").innerText')) === 'Mặt trời tháng sáu');
  await key('a', 'KeyA', 65);
  check('Phím A duyệt thiết kế', (await text()).includes('Kết quả DEMO: Đã duyệt'));
  await key('ArrowLeft', 'ArrowLeft', 37);
  check('Phím mũi tên trái quay lại', (await ev('document.querySelector("h1").innerText')) === 'Khoảng xanh');
  await key('r', 'KeyR', 82);
  check('Phím R mở hộp thoại từ chối', await ev('document.querySelector("#modal").open && document.querySelector("#rejectReason")!==null'));
  await click('[data-action="confirmReject"]');
  check('Bắt buộc nhập lý do từ chối', await ev('document.querySelector("#modal").open'));
  await ev(`document.querySelector('#rejectReason').value='Màu lệch bản gốc'`);
  await click('[data-action="confirmReject"]');
  check('Từ chối cập nhật trạng thái', (await text()).includes('Kết quả DEMO: Từ chối'));
  await shot('03-review-1440');

  // 3 Listing
  await click('[data-nav="listing"]');
  await click('[data-action="generate"]');
  check('Tạo nội dung cập nhật xem trước', (await ev('document.querySelector("#previewTitle").innerText')) === 'Mang một góc bình yên về nhà');
  await ev(`(()=>{const t=document.querySelector('#listingTitle');t.value='Tiêu đề thử nghiệm';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('Sửa tiêu đề cập nhật xem trước trực tiếp', (await ev('document.querySelector("#previewTitle").innerText')) === 'Tiêu đề thử nghiệm');
  await shot('04-listing-content-1440');
  await click('[data-listtab="analysis"]'); await click('[data-action="analyze"]');
  check('Tab phân tích chạy giả lập', (await text()).includes('Đã hoàn tất kết quả giả lập'));
  await shot('05-listing-analysis-1440');

  // 4 Products
  await click('[data-nav="products"]');
  check('Bảng biến thể có 3 dòng', (await ev('document.querySelectorAll("tbody tr").length')) === 3);
  await click('[data-action="publish"]');
  check('Chặn xuất bản khi chưa chạy thử', !(await ev('document.querySelector("#modal").open')) && (await ev('document.querySelector("#toast").innerText')).includes('chạy thử'));
  await click('[data-action="dryrun"]');
  check('Chạy thử hiển thị kết quả', (await text()).includes('Dữ liệu sản phẩm hợp lệ'));
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='admin';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]');
  check('Quản trị viên không mặc định được xuất bản', (await ev('document.querySelector("#modal").innerText')).includes('không tự động có quyền xuất bản'));
  await click('#modal [data-close]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='delegate';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]');
  check('Người được ủy quyền chưa có quyền xuất bản mặc định', (await ev('document.querySelector("#modal").innerText')).includes('Chưa có quyền xuất bản'));
  await click('#modal [data-close]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='owner';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('[data-action="publish"]'); await click('[data-action="confirmPublish"]');
  check('Xác nhận bắt buộc tích kiểm tra', await ev('document.querySelector("#modal").open'));
  await ev(`document.querySelector('#confirmPublish').checked=true`); await click('[data-action="confirmPublish"]');
  check('Chủ cửa hàng xuất bản giả lập', (await text()).includes('Đã xuất bản giả lập'));
  await ev(`(()=>{const p=document.querySelector('[data-price="0"]');p.value='30';p.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check('Đổi giá xóa kết quả chạy thử', !(await text()).includes('Dữ liệu sản phẩm hợp lệ'));
  await shot('06-products-1440');

  // 5 Team
  await click('[data-nav="team"]');
  check('Có 3 cửa hàng để chọn', (await ev('document.querySelectorAll("[data-store]").length')) === 3);
  await ev(`(()=>{const c=document.querySelector('#delegatePublish');c.click()})()`);
  await click('[data-nav="products"]');
  await ev(`(()=>{const s=document.querySelector('#actor');s.value='delegate';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check('Ủy quyền rõ ràng cấp quyền xuất bản cho Lan Chi', (await text()).includes('Quyền xuất bản: Có'));
  await click('[data-nav="team"]');
  await click('[data-action="invite"]');
  await click('[data-action="createInvite"]');
  check('Email lời mời được kiểm tra hợp lệ', await ev('document.querySelector("#inviteForm")!==null'));
  await ev(`document.querySelector('#inviteEmail').value='moi@example.invalid'`);
  await click('[data-action="createInvite"]');
  check('Lời mời DEMO được tạo', (await ev('document.querySelector("#modal").innerText')).includes('moi@example.invalid'));
  await click('#modal [data-close]');
  await shot('07-team-1440');
  await click('[data-store="2"]');
  check('Chọn cửa hàng đồng bộ bộ chọn trên cùng', (await ev('document.querySelector("#storeSelect").value')) === '2');
  check('Cửa hàng không sở hữu bị khóa ủy quyền', await ev('document.querySelector("#delegatePublish").disabled'));
  await click('[data-store="0"]');

  // 6 Skills
  await click('[data-nav="skills"]');
  check('Có 4 tab kỹ năng và vận hành', (await ev('document.querySelectorAll("[data-skilltab]").length')) === 4);
  await shot('08-skills-1440');
  await click('[data-skilltab="health"]');
  const health = await text();
  check('Tab sức khỏe chỉ hiển thị thời gian nghỉ', health.includes('không phải giới hạn sử dụng') && !/hạn mức|ngân sách|quota|budget/i.test(health));
  check('Tab sức khỏe có bảng tài khoản AI và danh sách worker', await ev('!!document.querySelector("table.health") && document.body.innerText.includes("browser-01@studio-host")'));
  await click('[data-action="relogged"]');
  check('Nút Đã đăng nhập lại ghi nhận trạng thái', (await text()).includes('Đã báo đăng nhập lại'));
  await shot('09-operations-1440');
  await click('[data-skilltab="providers"]');
  check('Không có chuyển API dự phòng', (await text()).includes('không tự chuyển sang API khác'));

  // 7 Dữ liệu ngách: soạn niche master data theo schema 2.0 của generator
  await click('[data-nav="niche"]'); await sleep(80);
  const nq = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText`);
  const nset = (sel, v) => ev(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});s.value=${JSON.stringify(v)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const disabled = sel => ev(`document.querySelector(${JSON.stringify(sel)}).disabled`);
  check('Đổi màn thì tắt thông báo của màn trước', (await ev('document.querySelector("#toast").textContent')) === '');
  check('Màn 7 mở từ điều hướng', (await nq('h1')) === 'Soạn master data, build skill.');
  check('Màn 7 có đúng 5 bước', (await ev('document.querySelectorAll("[data-nstep]").length')) === 5);
  const t7 = await text();
  check('Quyền soạn và publish tách riêng', t7.includes('skill.edit') && t7.includes('skill.publish'));
  const allSections = await ev(`(async()=>{const ids=[];for(let i=0;i<5;i++){document.querySelector('[data-nstep="'+i+'"]').click();await new Promise(r=>setTimeout(r,30));document.querySelectorAll('[data-section]').forEach(s=>ids.push(s.dataset.section));}document.querySelector('[data-nstep="0"]').click();return ids})()`);
  check('Đủ 17 section của schema', allSections.length === 17 && new Set(allSections).size === 17, allSections.length + ' section');
  check('Bước 1 báo persona 8/8', (await nq('[data-count="personas"]')) === '8 / tối thiểu 8');
  check('Trạng thái dữ liệu có đúng 3 mức', (await ev('[...document.querySelectorAll("#nicheStatus option")].map(o=>o.value).join(",")')) === 'curated-draft,researched,validated');
  check('Thiếu dữ liệu thì chặn build', (await disabled('[data-nbuild]')) === true);
  const errText = await nq('.nerrs');
  check('Lỗi dịp mua đúng định dạng validator', errText.includes('- occasions: requires at least 8 records; found 6'));
  check('Lỗi brief mẫu đúng ngưỡng 6', errText.includes('- sample_briefs: requires at least 6 records; found 4'));
  check('Bước có lỗi gắn nhãn đỏ', (await nq('[data-nstep="1"] .badge.red')) === '1 lỗi');
  await click('[data-nfix="occasions"]'); await sleep(60);
  check('Nút Sửa nhảy tới đúng bước', (await ev('document.querySelector("[aria-current=step]").dataset.nstep')) === '1');
  check('Nút Sửa đưa focus tới trường lỗi', (await ev('document.activeElement.dataset.nadd')) === 'occasions');
  await click('[data-nadd="occasions"]'); await click('[data-nadd="occasions"]');
  check('Thêm dịp mua tới 8/8 thì hết lỗi', (await nq('[data-count="occasions"]')) === '8 / tối thiểu 8' && !(await nq('.nerrs')).includes('occasions'));
  await click('[data-nnext]'); await sleep(40);
  check('Kiểu chữ yêu cầu tối thiểu 3', (await nq('[data-count="visual_vocabulary.typography"]')) === '3 / tối thiểu 3');
  await click('[data-nnext]'); await sleep(40);
  await click('[data-nadd="sample_briefs"]'); await click('[data-nadd="sample_briefs"]');
  check('Brief mẫu đạt 6/6', (await nq('[data-count="sample_briefs"]')) === '6 / tối thiểu 6');
  check('Chấm thị trường có 6 tiêu chí', (await ev('document.querySelectorAll("[data-score]").length')) === 6);
  check('Tổng điểm mặc định 26/30 là Làm', (await nq('#fitTotal')) === '26/30' && (await nq('#fitVerdict')) === 'Làm');
  await nset('[data-score="ip"]', '3'); await sleep(40);
  check('Điểm IP dưới 4 luôn chặn', (await nq('#fitVerdict')).startsWith('Chặn'));
  await nset('[data-score="ip"]', '5'); await sleep(40);
  await click('[data-nnext]'); await sleep(40);
  check('Style variant đúng 4, nút thêm bị khóa', (await nq('[data-count="style_variants"]')) === '4 / đúng 4' && (await disabled('[data-nadd="style_variants"]')) === true);
  const gap1440 = await nicheColGap();
  check('Bước 5 ở 1440px không để khoảng trống dưới Luật QA', gap1440 <= 1, 'chênh ' + gap1440 + 'px');
  const qa = await nq('[data-section="qa_rules"]');
  check('Luật QA là object, có nền #00FF00 và tỉ lệ 3:4', qa.includes('#00FF00') && qa.includes('3:4'));
  await nset('#nicheMaxColors', '13'); await sleep(40);
  check('Số màu 13 bị báo lỗi 1 đến 12', (await text()).includes('qa_rules.max_colors: expected an integer from 1 to 12') && (await disabled('[data-nbuild]')) === true);
  await nset('#nicheMaxColors', '6'); await sleep(40);
  check('Đủ dữ liệu thì mở build', (await disabled('[data-nbuild]')) === false);
  await click('[data-nbuild]'); await sleep(60);
  const built = await text();
  check('Build xong vẫn chưa publish', built.includes('Đã build skill version v3 DEMO') && built.includes('Chưa publish') && (await ev('document.activeElement.className')) === 'nbuilt');
  await shot('12-niche-1440');

  // Themes
  for (const [t, name] of [['dense', '10-theme-dense-1440'], ['dark', '11-theme-dark-1440']]) {
    await click(`[data-theme="${t}"]`); await click('[data-nav="studio"]');
    check(`Hướng ${t} áp dụng lớp body`, (await ev('document.body.className')) === t);
    await shot(name);
  }
  await click('[data-theme="light"]');

  // Responsive
  for (const [w, h] of [[1024, 900], [760, 1000], [390, 844]]) {
    await viewport(w, h);
    // Every nav label must be fully visible: inside the viewport and not truncated by its own box.
    const navClip = await ev(`[...document.querySelectorAll('#nav button')].filter(b => { const r = b.getBoundingClientRect(); const l = b.querySelector('span'); return r.left < 0 || r.right > ${w} + 1 || (l && l.scrollWidth > l.clientWidth + 1); }).map(b => b.textContent.trim())`);
    check(`Thanh điều hướng không cắt nhãn ${w}px`, navClip.length === 0, navClip.join(', '));
    // Compare against the requested width: with mobile emulation window.innerWidth grows with the
    // content, which hid a real 122px overflow on the review screen.
    for (const s of ['studio', 'review', 'listing', 'products', 'team', 'skills', 'niche']) {
      await click(`[data-nav="${s}"]`); await sleep(80);
      const overflow = await ev(`document.documentElement.scrollWidth - ${w}`);
      check(`Không tràn ngang ${s} ${w}px`, overflow <= 1, 'dư ' + overflow + 'px');
      if (s === 'niche' && w === 1024) { await click('[data-nstep="4"]'); await sleep(40); const g = await nicheColGap(); check('Bước 5 ở 1024px hai cột cân nhau', g <= 1, 'chênh ' + g + 'px'); }
      if (s === 'niche' && w === 390) { await click('[data-nstep="4"]'); await sleep(40); const order = await ev('[...document.querySelectorAll(".nsec [data-section]")].map(e=>e.dataset.section).join(",")'); check('Bước 5 ở 390px giữ thứ tự Style, IP, QA và 1 cột', order === 'style_variants,ip_safety,qa_rules' && (await nicheColGap()) === 0, order); }
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
  check('Chữ đạt tương phản WCAG AA ở 3 hướng và 4 độ rộng', floor.contrast.length === 0, floor.contrast.slice(0, 3).join(' | '));
  check('Không có chữ nhỏ hơn 11px', floor.small.length === 0, floor.small.slice(0, 3).join(' | '));
  check('Nút và ô chọn tối thiểu 32px', floor.tiny.length === 0, floor.tiny.slice(0, 3).join(' | '));
  check('Vùng bấm ở 390px tối thiểu 44px', floor.tap44.length === 0, floor.tap44.slice(0, 3).join(' | '));
  const toastHits = [];
  for (const [w, h] of [[1440, 1000], [1024, 900], [760, 1000], [390, 844]]) {
    await viewport(w, h);
    for (const s of ['review', 'niche']) {
      await click(`[data-nav="${s}"]`); await sleep(40);
      for (const y of ['0', 'document.documentElement.scrollHeight']) {
        await ev(`window.scrollTo(0, ${y})`); await sleep(40);
        const hit = await ev(`(async()=>{toast('Kiểm tra vị trí thông báo');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const a=document.querySelector('#toast').getBoundingClientRect();const pe=getComputedStyle(document.querySelector('#toast')).pointerEvents;const out=[...document.querySelectorAll('.reviewcontrols button,.nbar button')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.bottom>0&&b.top<innerHeight&&!(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom)}).map(e=>e.textContent.trim());document.querySelector('#toast').textContent='';return pe!=='none'?['pointer-events='+pe]:out})()`);
        for (const x of hit) toastHits.push(`${s}/${w}: ${x}`);
      }
    }
  }
  await viewport(1440, 1000);
  check('Thông báo không che thanh nút dính và không chặn click', toastHits.length === 0, toastHits.slice(0, 3).join(' | '));

  // Focus visibility and semantics
  await click('[data-nav="studio"]');
  const clickableDivs = await ev('[...document.querySelectorAll("div[onclick],span[onclick]")].length');
  check('Không dùng div/span làm nút', clickableDivs === 0);
  await ev('document.querySelector("[data-action=upload]").focus()');
  check('Focus hiển thị rõ', (await ev('getComputedStyle(document.activeElement).outlineStyle')) !== 'none');
  const external = netRequests.filter(u => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:'));
  check('Không có yêu cầu mạng ra ngoài', external.length === 0, external.slice(0, 3).join(', '));
  check('Không có lỗi JavaScript', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (err) {
  check('Thực thi kiểm thử', false, err.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kiểm tra đạt.${takeShots ? ' Ảnh chụp: ' + shotsDir : ''}`);
process.exit(failed.length ? 1 : 0);
