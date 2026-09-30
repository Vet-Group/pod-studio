# Plan: Webapp nội bộ "POD Studio" (bản v0.3)

> Trạng thái: **chưa triển khai code sản phẩm**. Ngày 2026-09-30.
> v0.2 thay v0.1 (lưu ở `pod-studio/docs/plan-v0.1-archive.md`) theo các quyết định anh chốt hôm nay.
> v0.3 thêm: chốt phạm vi thư viện (design theo store, skill dùng chung), màn 7 soạn niche master data, chấm độ hợp thị trường, kho bí mật OpenBao cho account subscription (ADR 0003, task P3-09 đến P3-11).
> Nguồn: `Downloads/prd-rebuild.md` là tài liệu nghiệp vụ tham khảo được chia sẻ lại. **Không có repo `storekit` hay `mockup-worker`**, nên không có code để port, không có dữ liệu để migrate và không có hệ thống cũ cần tương thích.
> Phạm vi của anh: webapp, API, DB, scheduler. Phạm vi của ngatruong123: workers (browser/API) và skills runtime.

Toàn bộ artifact nằm trong `C:/Users/Administrator/pod-studio/`:

| Thư mục | Nội dung |
|---|---|
| `docs/adr/0001-stack.md` | Chốt stack, có đánh giá Preact Signals |
| `docs/adr/0002-access-model.md` | Tài khoản, lời mời, phân quyền theo store |
| `docs/adr/0003-niche-skill-builder.md` | Niche master data, build skill version, chấm thị trường, OpenBao |
| `packages/contracts/` | Worker API v2 (OpenAPI 3.1) + JSON Schema skill manifest, có ví dụ và script tự kiểm |
| `design/wireframes/` | Prototype 7 màn chính (HTML chạy offline) |
| `tasks/` | Task P1-P3 chi tiết có file path và test, kèm `tasks.json` |

---

## 1. Quyết định đã chốt (2026-09-30)

| Chủ đề | Quyết định |
|---|---|
| Repo cũ | Bỏ qua `storekit`, `mockup-worker`. PRD chỉ dùng làm nguồn nghiệp vụ. |
| Quy mô | Không cố định số người và số account AI. Thiết kế mở rộng ngang (thêm worker, thêm account) không đổi schema. Không hứa "không giới hạn"; P3 đo tải theo profile cụ thể. |
| Đăng nhập | Không SSO. Email + mật khẩu. Admin tạo tài khoản (mật khẩu tạm, bắt đổi lần đầu) hoặc gửi link mời để người dùng tự khai thông tin. Không bắt buộc có SMTP: link copy gửi qua chat được. |
| Quyền push | Theo **store**, không theo công ty. Mỗi store có đúng 1 owner (leader). Chỉ owner và người được owner cấp quyền mới push hoặc public. Một leader có thể giữ nhiều store. Admin hệ thống **không** mặc nhiên có quyền push. |
| Quota, ngân sách | **Không làm.** Chỉ ghi `usage_events` (store, người yêu cầu, owner của store tại thời điểm đó) để sau này chia chi phí theo store hoặc leader. |
| Stack | Next.js + React + TypeScript + Tailwind v4 + shadcn/ui + Drizzle + Postgres + better-auth + pg-boss. Chi tiết và lý do: ADR 0001. |
| Preact Signals | Chưa dùng. Lý do ở §3. |
| Phạm vi thư viện | Design, mockup, redesign **theo store**; chia sẻ sang store khác là thao tác riêng. Thư viện **skill dùng chung toàn công ty**: ai có `skill.edit` soạn nháp, chỉ ai có `skill.publish` mới publish. |
| Niche master data | Soạn trên webapp theo schema 2.0 của generator, build ra skill version bất biến, không tự publish. Chi tiết §7b, ADR 0003. |
| Bí mật account subscription | Lưu trong OpenBao (KV v2 + TOTP engine), worker lấy qua AppRole và response wrapping, tự đăng nhập lại khi hết phiên. Postgres chỉ giữ metadata. |

## 2. Dùng lại gì từ PRD

| Phần PRD | Quyết định |
|---|---|
| §4.1-4.4 catalog, pricing, product, variant, translation, store_products | Dựng lại theo schema PRD, thêm `store_id` scope và người tạo |
| §6.2-6.6 bảng giá, SEO, tạo product, push 14 bước, import | Viết lại theo đặc tả, giữ 20 bất biến ở §20 làm test case |
| §7 Shopify Admin GraphQL | Giữ cách gọi và idempotency |
| §5.1 state machine job | Thay bằng lease + heartbeat + error class (contract v2) |
| §8.5 worker API | Thay bằng Worker API v2 (PRD tự nêu 3 điểm yếu: không heartbeat, token chung, filesystem chung) |
| §8.4 agent API | Để sau P3; nếu làm thì token riêng từng agent, có scope |
| §1.2, §10 `APP_PASSWORD` | Thay bằng tài khoản + phân quyền theo store |
| §13 filesystem chung | Thay bằng object storage + presigned URL |
| §6.7-6.10 translate toàn store, audit, blog, theme | Ngoài MVP |

## 3. Stack và Preact Signals

Chọn Next.js vì hệ sinh thái lớn nhất cho đúng bộ công cụ cần dùng (shadcn/ui, better-auth, Drizzle, TanStack Query), nhiều ví dụ production, dễ tuyển người và dễ nhờ AI hỗ trợ. Lượt tải npm/tuần đo hôm nay: next 70,0 triệu, @tanstack/react-start 20,0 triệu. Logic nghiệp vụ nằm ở `packages/core` thuần TypeScript, nên nếu sau này muốn đổi framework thì không phải viết lại phần lõi.

**`preactjs/signals`**, đã đọc README của `packages/react` và số liệu npm:

- Hỗ trợ React 16.14 đến 19 (bản 3.12.0).
- Muốn tự re-render phải cài Babel plugin `@preact/signals-react-transform`. Next.js biên dịch bằng SWC, nên phải thêm bước Babel hoặc gọi `useSignals()` thủ công ở từng component.
- README tự nêu giới hạn: không truyền signal vào thuộc tính DOM; render prop và getter có thể không được theo dõi; component render qua SSR không theo dõi signal.
- Khoảng 0,35 triệu lượt tải/tuần, so với khoảng 65 triệu của zustand.

Kết luận: **chưa dùng.** Các màn nặng (lưới duyệt ảnh hàng trăm tấm, thư viện design, hàng đợi upload) xử lý bằng virtual list + zustand selector, đủ để chỉ re-render đúng ô thay đổi. Chỉ cân nhắc lại khi profiler cho thấy nghẽn thật.

## 4. Kiến trúc

```
Người dùng (owner, co-leader, seller support, seller, designer, admin)
   │ email + mật khẩu, session lưu Postgres
   ▼
apps/web  Next.js: UI, Server Actions, /api/worker/v2/*, SSE
   │                       ▲
   ▼                       │ presigned URL
Postgres ◄──── apps/jobs (pg-boss): push Shopify, reaper lease, thông báo
   ▲
   │ HTTP Worker API v2 (register, claim, heartbeat, uploads, complete, fail)
AI workers của ngatruong123 (chatgpt@accN, grok@accN, gemini-api, ...) trên 1 hoặc nhiều máy
   │
Object storage (MinIO dev; MinIO hoặc Cloudflare R2 prod)
```

- Worker không đọc DB, không đọc filesystem của webapp.
- Job AI dùng bảng lease riêng, claim qua HTTP với `FOR UPDATE SKIP LOCKED`. pg-boss chỉ cho job nội bộ.
- Thứ tự claim: tier ưu tiên, rồi xoay vòng theo **store**, rồi theo người yêu cầu, rồi job cũ trước. Một người đẩy 200 design không chặn cả hàng đợi.
- Credential account AI nằm trên máy worker; webapp chỉ biết metadata và sức khoẻ account.

Monorepo:

```
apps/web            Next.js
apps/jobs           Node + pg-boss
packages/core       access, catalog, pricing, seo, push, generation, skills
packages/db         Drizzle schema + migrations
packages/contracts  Worker API v2 + skill manifest (đã có bản nháp)
packages/ui         token + component shadcn đã chỉnh
tools/fake-worker   worker giả để test end-to-end không cần trình duyệt
```

## 5. Tài khoản và phân quyền (tóm tắt ADR 0002)

- Vai trò toàn hệ thống: `admin` (quản trị user, account AI, worker, publish skill) và `member`.
- Quyền theo store: một dòng `store_members(store_id, user_id, role, permissions[])`. Role là preset: `owner`, `co_leader`, `seller_support`, `seller`, `designer`, `viewer`. Owner bật tắt từng quyền.
- `product.push` (đẩy lên Shopify ở dạng draft) và `product.publish` (chuyển active, mở sales channel) là 2 quyền riêng. Chỉ owner cấp được `product.publish`.
- Không ai cấp được quyền mình không có. Không xoá hay hạ quyền owner cuối cùng.
- Ai có `product.edit` mà không có `product.push` thì thấy nút **"Gửi yêu cầu push"** thay cho "Push".
- Lúc thực thi push, server kiểm lại quyền. Nếu quyền bị thu hồi giữa chừng, job dừng.
- Kiểm quyền ở `packages/core`, UI chỉ phản chiếu.
- Lời mời: token ngẫu nhiên, lưu hash, dùng 1 lần, hết hạn sau 7 ngày, thu hồi được.

## 6. Worker API v2 (bản nháp đã có)

Xem `packages/contracts/README.md`. Điểm chính cần ngatruong123 duyệt:

- Worker claim thay mặt 1 account AI; lease 180 giây, heartbeat 45 giây, long-poll 25 giây.
- File đi qua presigned URL, kiểm sha256 cả chiều vào lẫn chiều ra; worker từ chối URL ngoài `storageOrigins` (chống SSRF).
- 7 error class quyết định retry, có tính lượt thử hay không, và trạng thái account (cooldown, hết phiên).
- `complete`/`fail` idempotent theo `Idempotency-Key`; huỷ thắng hoàn thành khi 2 lệnh chạy đua.
- Prompt đã render sẵn từ skill version, worker không cần template engine.
- 3 loại skill chung 1 manifest: `prompt_template`, `provider_skill` (ví dụ `@create-wall-art-mockups`), `niche_agent`.

Đã kiểm bằng máy: `npm run check` (redocly lint 0 cảnh báo, 30/30 ca validate gồm 9 ca lỗi cố ý bị từ chối, sinh TypeScript types), và `tsc --strict` trên file kiểm types.

## 7. Bảy màn chính (wireframe)

| # | Màn | Người dùng chính | Nội dung |
|---|---|---|---|
| 1 | Studio | designer | Thư viện design, upload hàng loạt, tạo job mockup/redesign, hàng đợi |
| 2 | Duyệt ảnh | designer, seller | Design gốc đặt cạnh kết quả, phím tắt A/R/mũi tên, duyệt hàng loạt, lý do loại |
| 3 | Listing | seller | Phân tích sản phẩm, sinh và sửa content đa ngôn ngữ, cảnh báo keyword trùng |
| 4 | Products và push | seller, owner | Variant theo bảng giá, dry-run, push draft, public (cần quyền) |
| 5 | Stores và thành viên | owner | Chọn store, thành viên, bật tắt quyền, mời người |
| 6 | Skills và vận hành | admin, người viết skill | Thư viện skill 3 loại, account AI (kèm trạng thái đăng nhập lại), worker |
| 7 | Dữ liệu ngách | người viết skill, người publish | Soạn niche master data 5 bước, validator có nút Sửa, chấm 6 tiêu chí, build skill version |

Kiểm bằng máy: `node design/wireframes/test-wireframes.mjs` đạt 104/104 (điều hướng, phím tắt, quyền, luật tối thiểu và chấm điểm màn 7, không tràn ngang ở 1024/760/390 trên cả 7 màn).

## 7b. Niche master data và build skill (tóm tắt ADR 0003)

- Nguồn sự thật là master data JSON schema 2.0; skill version là kết quả build, truy được về bản master data và điểm chấm.
- 17 section, chia 5 bước. Mọi list là **tối thiểu**, chỉ `style_variants` là **đúng 4**:
  - Bước 1: thông tin cơ bản, `niche_profile` (6 ô), nguồn dữ liệu (ít nhất 1, trạng thái `curated-draft`, `researched`, `validated`), persona 8, cặp người mua và người nhận 5.
  - Bước 2: dịp mua 8, cảm xúc 6, ngôn ngữ người mua 6.
  - Bước 3: motif 10, bảng màu 3, kiểu chữ 3, bố cục 4, sản phẩm phù hợp 5, trường cá nhân hóa 4.
  - Bước 4: hook 8, brief mẫu 6, ngưỡng chấm thị trường.
  - Bước 5: style variant đúng 4, an toàn IP (tránh 5, cặp thay thế 3, dấu hiệu cần người duyệt 3), luật QA là 1 object (nền `#00FF00`, tỉ lệ `3:4`, số màu 1 đến 12).
- Chấm độ hợp thị trường: 6 tiêu chí 1 đến 5 (rõ ý, hợp làm quà, cảm xúc, khác biệt, làm thành bộ, an toàn IP), tối đa 30. 25 trở lên làm, 21 chỉnh, 16 làm lại, 15 trở xuống thay. IP dưới 4 luôn chặn.
- Lỗi dùng cùng câu với generator (`occasions: requires at least 8 records; found 6`). Generator vẫn là bên chấm cuối: một bộ fixture chung phải cho cùng kết quả ở rule TypeScript và script Python.
- Giấy phép của generator trong bản chia sẻ chưa rõ; build job gọi script từ skill pack, không chép code vào repo cho tới khi làm rõ.

## 8. Lộ trình

| Phase | Mục tiêu | Nghiệm thu |
|---|---|---|
| **P0** (đang làm) | Wireframe, contract, ADR, task breakdown | ngatruong123 duyệt contract; anh duyệt wireframe |
| **P1 Nền móng + Studio** | Monorepo, auth + lời mời, phân quyền store, audit log, object storage, bảng lease + Worker API v2, fake-worker, Studio, Duyệt ảnh | Thin slice chạy trọn: mời user, upload, tạo job, fake-worker trả ảnh, duyệt; không cần worker thật |
| **P2 Listing + Shopify** | Phân tích, content, catalog, bảng giá, tạo product, push dry-run/draft/public, import | Push thật lên dev store: đúng variant, giá, market, bản dịch; bất biến PRD §20 thành test |
| **P3 Skills + vận hành** | Vòng đời skill, màn account AI/worker, harden bảo mật, đo tải, soạn niche master data và build skill, OpenBao cho account subscription | Có số liệu tải theo profile cụ thể; checklist bảo mật đạt; build skill từ master data mẫu cho cùng kết quả với generator; account hết phiên tự đăng nhập lại hoặc chuyển chờ người |

Chi tiết từng task: `pod-studio/tasks/` (32 task: P1 11, P2 10, P3 11; `node tasks/validate-tasks.mjs` đạt).

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Worker thật trễ hơn webapp | fake-worker theo đúng contract; P1 không phụ thuộc worker thật |
| Account subscription bị khoá hoặc hết phiên | Error class tách riêng; worker lấy mật khẩu và mã TOTP từ OpenBao để tự đăng nhập lại; gặp captcha hoặc xác minh thiết bị thì chuyển chờ người, admin được báo |
| Lộ mật khẩu account subscription | Chỉ OpenBao giữ giá trị; job mang `credential_ref`; wrap token dùng 1 lần; Postgres, log và payload không bao giờ chứa bí mật |
| Editor lệch luật với generator | Fixture chung chạy cả rule TypeScript lẫn script Python trong CI; generator là bên chấm cuối |
| Push sai lên store thật | Dry-run bắt buộc, lần đầu mặc định draft, quyền publish tách riêng, kiểm lại quyền lúc chạy |
| Repo công khai lộ credential | Không commit secret; pre-commit chặn file config nhạy cảm |

## 10. Câu hỏi còn mở (không chặn P1)

1. Ai được tạo store mới: chỉ admin, hay leader được admin cấp quyền `store.create`?
2. Tên miền và nơi chạy production (1 VPS hay nhiều máy)? Ảnh hưởng tới object storage (MinIO tự chạy hay R2).
3. Có cần email thật (quên mật khẩu tự phục vụ) hay admin gửi link reset qua chat là đủ?
4. OpenBao chạy chung máy với webapp hay máy riêng, và ai giữ unseal key? Ảnh hưởng tới P3-11.
