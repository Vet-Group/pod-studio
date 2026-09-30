# Kế hoạch triển khai P1-P3

Đây là kế hoạch xây mới, không phải báo cáo đã triển khai. PRD là tài liệu tham chiếu, không phải code nền để port hoặc dữ liệu cần migrate.

## Cách đọc

- `tasks.json` là danh mục có cấu trúc; các file P1, P2, P3 trình bày đầy đủ cùng nội dung cho người đọc.
- ID ổn định dạng `P1-01`. `depends_on` là điều kiện kỹ thuật phải hoàn tất trước khi task được nghiệm thu; có thể thiết kế song song.
- `owner`: `web` là đội webapp, `worker` là ngatruong123, `both` là phối hợp hai đội. Mã worker thật nằm ở repo ngoài, không giả định đường dẫn hoặc repo đó đã tồn tại.
- Đường dẫn triển khai là ĐỀ XUẤT, tương đối từ root monorepo; không khẳng định file đã tồn tại. Repo này chỉ chứa server web, jobs nội bộ, contracts và fake-worker, không chứa runtime AI thật.
- `screens` dùng số prototype 1-7; danh sách rỗng nghĩa là none. `prd_refs` chỉ dùng các mục đã xác minh; danh sách rỗng nghĩa là yêu cầu ADR hoặc contract mới.
- Mọi test trong kế hoạch mang nhãn `PLANNED - not implemented, not executed`. Done criteria là điều kiện nghiệm thu tương lai, không phải kết quả kiểm thử.

## Mục tiêu và nghiệm thu từng phase

| Phase | Mục tiêu | Điều kiện nghiệm thu |
| --- | --- | --- |
| P1 | Nền tảng, tài khoản, phân quyền, assets, generation và Studio/Review | Người được mời đăng nhập, chọn store hợp lệ, upload, tạo mockup, theo dõi và duyệt kết quả qua fake-worker. Chứng minh isolation, lease, cancel và permission bằng test thực tế trước khi tuyên bố hoàn tất. |
| P2 | Listing, catalog và Shopify | Từ kết quả approved tạo sản phẩm đúng pricing, dry-run bắt buộc, push mặc định draft; publish kiểm tra quyền riêng lúc thực thi. Timeout sau write được reconcile, không retry mù. |
| P3 | Skills, vận hành, bảo mật và chất lượng UI | Skill version bất biến, routing theo install, token có thể revoke, vận hành có bằng chứng; benchmark công bố tải đo được, UI qua keyboard/axe ở ba viewport. |

## Phụ thuộc và đường găng

- Nền tảng: P1-01 -> P1-02 -> P1-03 -> P1-04 -> P1-05 -> P1-06 -> P1-07.
- Studio: P1-07 -> P1-08 -> P1-09 -> P1-10; P1-11 bổ sung SSE và usage và phụ thuộc P1-07/P1-08/P1-09.
- Thương mại: P1-10 + P2-01 + P2-03 -> P2-04 -> P2-06 -> P2-07 -> P2-08; P2-05 cung cấp Shopify client, P2-09 request-push, P2-10 import/resync.
- Vận hành: P3-01 -> P3-02 -> P3-03 -> P3-04. P3-05 gia cố bảo mật, P3-06 telemetry, P3-07 đo tải và P3-08 chốt UI.
- Niche và bí mật: P3-01 + P3-02 -> P3-09 -> P3-10 (soạn master data, chấm điểm, build). P3-04 + P3-05 -> P3-11 (OpenBao, tự đăng nhập lại).
- Danh sách `depends_on` trong JSON là nguồn chính xác cho đồ thị. Mỗi phase có thể bắt đầu thiết kế sớm nhưng chỉ nghiệm thu khi các prerequisite tương ứng đã đạt.

## Ánh xạ prototype

| Screen | Nội dung | Task chính |
| --- | --- | --- |
| 1 | Studio, design library, upload, create mockup, queue | P1-05, P1-09, P1-11 |
| 2 | Review original/mockups, A/R/arrows, reject reason | P1-10 |
| 3 | Listing content và analysis | P2-01, P2-02 |
| 4 | Products, variants, dry-run, push/publish | P2-03, P2-04, P2-06, P2-07, P2-08, P2-09, P2-10 |
| 5 | Stores, members, push/publish toggles, invite | P1-03, P1-04, P2-05 |
| 6 | Skills, accounts và worker health | P3-01, P3-02, P3-03, P3-04, P3-06, P3-07, P3-11 |
| 7 | Niche master data editor, market fit, build skill version | P3-09, P3-10 |

P3-05 bảo vệ mọi screen; P3-08 kiểm tra xuyên suốt cả bảy screen.

## Chiến lược kiểm thử

**PLANNED - not implemented, not executed**

- Unit: Vitest cho policy, pricing, state machine, template và payload; clock/RNG inject được để kiểm tra expiry và fairness.
- Integration: Postgres 16 thật, schema hoặc database riêng từng test/worker; migration thực, transaction cạnh tranh thực. Guard từ chối URL production, không dùng shared truncate; cleanup chỉ namespace do test tạo. MinIO riêng cho asset/upload test.
- Contract: OpenAPI 3.1 Worker API v2 tại `packages/contracts/openapi/worker-api.yaml`, bản `2.0.0-draft.1`, header `X-Contract-Version: 2`, prefix `/api/worker/v2`. Fake-worker kiểm chứng request/response, HTTP code, lease và presigned storage; runtime ngoài chỉ giao tiếp qua contract và object storage.
- E2E: Playwright chạy flow auth -> Studio -> Review -> Listing -> draft/publish, dùng fake-worker và Shopify stub xác định được side effects. Smoke sandbox Shopify thật là gate riêng cần credential được cấp, không gọi live trong suite mặc định.
- A11y: axe + kiểm tra keyboard thủ công có checklist; không coi axe pass là đủ.
- Load: Postgres/MinIO thật, workload công khai trong P3-07, báo p95, lỗi, fairness, queue drain và cấu hình máy. Capacity là số đo, không cam kết unlimited.
- Chạy local không phụ thuộc CI. README của test harness sẽ hướng dẫn lệnh từ clean checkout; chỉ báo pass khi đã thực chạy. Không dùng dữ liệu giả để báo kết quả benchmark.

## Ràng buộc kiến trúc

- Next.js App Router, React, TypeScript strict, Tailwind v4, shadcn/ui; TanStack Query/Table/Virtual, nuqs, zustand, react-hook-form + zod; không dùng Preact Signals. Version trong ADR là snapshot dự kiến.
- better-auth email/password, sessions trong Postgres, không SSO và không public signup. pg-boss chỉ dành cho internal push/reaper/notification; AI job dùng lease table riêng qua HTTP. SSE dùng LISTEN/NOTIFY.
- Admin không tự có quyền push/publish. `product.push` và `product.publish` tách riêng; chỉ owner cấp publish; không ai cấp quyền mình không có. Thực thi job phải kiểm tra lại quyền đã lưu, không tin UI.
- Không quota, budget hay fallback API trả phí. Chỉ ghi usage_events; owner attribution là snapshot tại thời điểm phát sinh.
- Nội dung PRD worker API cũ không dùng làm chuẩn. Không hứa port storekit/mockup-worker hoặc migrate dữ liệu từ repo chưa tồn tại.

## Quyết định còn mở

| Chủ đề | Mặc định khi triển khai | Cần chốt |
| --- | --- | --- |
| Ai được tạo store | Fail closed với permission riêng, chưa bật tự tạo cho member | Product owner chọn admin-only hay nhóm có quyền và quy trình cấp owner |
| Production host/object storage | Local Postgres 16 + MinIO cho dev/test | Host, region, TLS, backup, key management, bucket lifecycle và storageOrigins production |
| Email thật | Invite link copy được, không yêu cầu SMTP | Nhà cung cấp mail, sender domain, delivery và quy trình reset password trước production |

## Cổng xác minh tài liệu

File trong thư mục này: `tasks.json` (nguồn chính), `P1-foundation-studio.md`, `P2-listing-shopify.md`, `P3-skills-operations.md`, `validate-tasks.mjs`.

```bash
node tasks/validate-tasks.mjs
```

Script kiểm: 30-40 task, ID duy nhất, dependency tồn tại và không trỏ sang phase sau, không chu trình, mỗi task có đường dẫn, test (nhãn PLANNED) và điều kiện xong, đủ 7 màn prototype, file markdown có đủ mục của phase, không có em dash, en dash, smart quotes hoặc ellipsis. Kiểm tra này chỉ xác minh kế hoạch, không chạy test sản phẩm.
