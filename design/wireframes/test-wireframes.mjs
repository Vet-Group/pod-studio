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
  check('Có 6 mục điều hướng', (await ev('document.querySelectorAll("#nav button").length')) === 6);
  check('Sidebar đo được 216px', (await ev('document.querySelector(".sidebar").getBoundingClientRect().width')) === 216);
  check('Tiêu đề trang bằng tiếng Việt', (await ev('document.title')).includes('Bàn làm việc'));
  check('Thư viện dùng chung ghi rõ là đề xuất', (await text()).includes('đề xuất, chưa xác nhận'));
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

  // Themes
  for (const [t, name] of [['dense', '10-theme-dense-1440'], ['dark', '11-theme-dark-1440']]) {
    await click(`[data-theme="${t}"]`); await click('[data-nav="studio"]');
    check(`Hướng ${t} áp dụng lớp body`, (await ev('document.body.className')) === t);
    await shot(name);
  }
  await click('[data-theme="light"]');

  // Responsive
  for (const [w, h] of [[1024, 900], [390, 844]]) {
    await viewport(w, h);
    // Every nav label must be fully visible: inside the viewport and not truncated by its own box.
    const navClip = await ev(`[...document.querySelectorAll('#nav button')].filter(b => { const r = b.getBoundingClientRect(); const l = b.querySelector('span'); return r.left < 0 || r.right > ${w} + 1 || (l && l.scrollWidth > l.clientWidth + 1); }).map(b => b.textContent.trim())`);
    check(`Thanh điều hướng không cắt nhãn ${w}px`, navClip.length === 0, navClip.join(', '));
    // Compare against the requested width: with mobile emulation window.innerWidth grows with the
    // content, which hid a real 122px overflow on the review screen.
    for (const s of ['studio', 'review', 'listing', 'products', 'team', 'skills']) {
      await click(`[data-nav="${s}"]`); await sleep(80);
      const overflow = await ev(`document.documentElement.scrollWidth - ${w}`);
      check(`Không tràn ngang ${s} ${w}px`, overflow <= 1, 'dư ' + overflow + 'px');
      await shot(`${s}-${w}`);
    }
  }
  await viewport(1440, 1000);

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
