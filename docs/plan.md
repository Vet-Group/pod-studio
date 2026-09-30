# Plan: Webapp nội bộ "POD Studio" (bản v0.2)

> Trạng thái: **chưa triển khai code sản phẩm**. Ngày 2026-09-30.
> v0.2 thay v0.1 (lưu ở `pod-studio/docs/plan-v0.1-archive.md`) theo các quyết định anh chốt hôm nay.
> Nguồn: `Downloads/prd-rebuild.md` là tài liệu nghiệp vụ tham khảo được chia sẻ lại. **Không có repo `storekit` hay `mockup-worker`**, nên không có code để port, không có dữ liệu để migrate và không có hệ thống cũ cần tương thích.
> Phạm vi của anh: webapp, API, DB, scheduler. Phạm vi của ngatruong123: workers (browser/API) và skills runtime.

Toàn bộ artifact nằm trong `C:/Users/Administrator/pod-studio/`:

| Thư mục | Nội dung |
|---|---|
| `docs/adr/0001-stack.md` | Chốt stack, có đánh giá Preact Signals |
| `docs/adr/0002-access-model.md` | Tài khoản, lời mời, phân quyền theo store |
| `packages/contracts/` | Worker API v2 (OpenAPI 3.1) + JSON Schema skill manifest, có ví dụ và script tự kiểm |
| `design/wireframes/` | Prototype 6 màn chính (HTML chạy offline) |
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

## 7. Sáu màn chính (wireframe)

| # | Màn | Người dùng chính | Nội dung |
|---|---|---|---|
| 1 | Studio | designer | Thư viện design, upload hàng loạt, tạo job mockup/redesign, hàng đợi |
| 2 | Duyệt ảnh | designer, seller | Design gốc đặt cạnh kết quả, phím tắt A/R/mũi tên, duyệt hàng loạt, lý do loại |
| 3 | Listing | seller | Phân tích sản phẩm, sinh và sửa content đa ngôn ngữ, cảnh báo keyword trùng |
| 4 | Products và push | seller, owner | Variant theo bảng giá, dry-run, push draft, public (cần quyền) |
| 5 | Stores và thành viên | owner | Chọn store, thành viên, bật tắt quyền, mời người |
| 6 | Skills và vận hành | admin, người viết skill | Thư viện skill 3 loại, account AI, worker |

## 8. Lộ trình

| Phase | Mục tiêu | Nghiệm thu |
|---|---|---|
| **P0** (đang làm) | Wireframe, contract, ADR, task breakdown | ngatruong123 duyệt contract; anh duyệt wireframe |
| **P1 Nền móng + Studio** | Monorepo, auth + lời mời, phân quyền store, audit log, object storage, bảng lease + Worker API v2, fake-worker, Studio, Duyệt ảnh | Thin slice chạy trọn: mời user, upload, tạo job, fake-worker trả ảnh, duyệt; không cần worker thật |
| **P2 Listing + Shopify** | Phân tích, content, catalog, bảng giá, tạo product, push dry-run/draft/public, import | Push thật lên dev store: đúng variant, giá, market, bản dịch; bất biến PRD §20 thành test |
| **P3 Skills + vận hành** | Vòng đời skill, màn account AI/worker, harden bảo mật, đo tải | Có số liệu tải theo profile cụ thể; checklist bảo mật đạt |

Chi tiết từng task: `pod-studio/tasks/`.

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Worker thật trễ hơn webapp | fake-worker theo đúng contract; P1 không phụ thuộc worker thật |
| Account subscription bị khoá hoặc hết phiên | Error class tách riêng, account vào trạng thái cooldown/hết phiên, admin được báo |
| Push sai lên store thật | Dry-run bắt buộc, lần đầu mặc định draft, quyền publish tách riêng, kiểm lại quyền lúc chạy |
| Đổi policy chia sẻ design sau này | Mặc định an toàn: design thuộc phạm vi store cho tới khi anh chốt |
| Repo công khai lộ credential | Không commit secret; pre-commit chặn file config nhạy cảm |

## 10. Câu hỏi còn mở (không chặn P1)

1. **Thư viện design dùng chung toàn công ty hay riêng từng store?** ADR 0002 đề xuất dùng chung, nhưng khi code sẽ mặc định riêng theo store cho tới khi anh chốt. Designer phục vụ nhiều leader thì dùng chung tiện hơn; leader muốn giữ design riêng thì cần phạm vi store.
2. Ai được tạo store mới: chỉ admin, hay leader được admin cấp quyền `store.create`?
3. Tên miền và nơi chạy production (1 VPS hay nhiều máy)? Ảnh hưởng tới object storage (MinIO tự chạy hay R2).
4. Có cần email thật (quên mật khẩu tự phục vụ) hay admin gửi link reset qua chat là đủ?
