# P1 Nền móng và Studio

Mục tiêu: chạy trọn thin slice mời người dùng -> upload -> tạo job -> fake-worker trả ảnh -> duyệt, không cần worker thật.

> Mọi test dưới đây: **PLANNED - not implemented, not executed**. Đường dẫn là đề xuất, tương đối từ root monorepo.

| ID | Task | Owner | Phụ thuộc | Màn |
|---|---|---|---|---|
| P1-01 | Monorepo, tooling và test harness cô lập | webapp | không | không |
| P1-02 | Nền DB: Drizzle schema, migration và quy ước | webapp | P1-01 | không |
| P1-03 | Đăng nhập email + mật khẩu, tài khoản do admin tạo, lời mời | webapp | P1-02 | 5 |
| P1-04 | Phân quyền theo store, chuyển owner và audit log | webapp | P1-03 | 5 |
| P1-05 | Object storage, assets và thư viện design theo store | webapp | P1-04 | 1 |
| P1-06 | Bảng lease job AI, scheduler công bằng và reaper | webapp | P1-05 | 1 |
| P1-07 | Worker API v2 routes và token worker | webapp + ngatruong123 | P1-06 | không |
| P1-08 | tools/fake-worker theo contract | webapp | P1-07 | không |
| P1-09 | Màn Studio: thư viện design, upload, tạo job, hàng đợi | webapp | P1-08 | 1 |
| P1-10 | Màn Duyệt ảnh | webapp | P1-09 | 2 |
| P1-11 | Trạng thái realtime (SSE) và ghi usage_events | webapp | P1-07, P1-08, P1-09 | 1 |

---

## P1-01 Monorepo, tooling và test harness cô lập

- **Owner:** webapp
- **Phụ thuộc:** không
- **Màn prototype:** không
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Dựng khung pnpm monorepo và bộ test chạy local từ clean checkout: mỗi test worker có database Postgres 16 riêng, bucket MinIO riêng, có guard từ chối URL production.

**Đường dẫn đề xuất**

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `eslint.config.mjs`
- `vitest.workspace.ts`
- `playwright.config.ts`
- `ops/local/docker-compose.yml`
- `tests/support/db.ts`
- `tests/support/storage.ts`
- `tests/support/guard.ts`
- `docs/testing.md`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tests/support/guard.test.ts`
  - DATABASE_URL trỏ host không phải localhost hoặc tên DB không có hậu tố _test thì test dừng ngay
  - S3 endpoint không phải MinIO local thì từ chối
- `tests/support/db.test.ts`
  - 2 test worker song song tạo 2 database khác nhau, ghi cùng id không va nhau
  - Cleanup chỉ xoá database do chính test tạo

**Điều kiện xong**

- `pnpm test` chạy xanh trên máy mới chỉ với Docker + Node
- Guard production có test đỏ trước khi xanh
- docs/testing.md có lệnh từ clean checkout

---

## P1-02 Nền DB: Drizzle schema, migration và quy ước

- **Owner:** webapp
- **Phụ thuộc:** P1-01
- **Màn prototype:** không
- **Tham chiếu PRD:** §4.1-4.4

**Mục tiêu.** Thiết lập packages/db với quy ước PRD (PK text nanoid, không Postgres enum, timestamptz), migration có thứ tự, bảng users, sessions, stores, audit_log khung.

**Đường dẫn đề xuất**

- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/users.ts`
- `packages/db/src/schema/stores.ts`
- `packages/db/src/schema/audit.ts`
- `packages/db/src/ids.ts`
- `packages/db/migrations/`
- `packages/db/drizzle.config.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/db/test/migrations.test.ts`
  - Chạy toàn bộ migration trên DB rỗng thành công, chạy lại lần 2 không đổi gì
  - Không có kiểu enum Postgres nào trong schema sau migrate (truy vấn pg_type)
- `packages/db/test/ids.test.ts`
  - newId() sinh chuỗi đúng pattern ^[A-Za-z0-9_-]{8,40}$ của contract

**Điều kiện xong**

- Migration chạy được trên DB rỗng và idempotent
- Schema khớp quy ước, có test kiểm

---

## P1-03 Đăng nhập email + mật khẩu, tài khoản do admin tạo, lời mời

- **Owner:** webapp
- **Phụ thuộc:** P1-02
- **Màn prototype:** 5
- **Tham chiếu PRD:** §10

**Mục tiêu.** better-auth với email + mật khẩu, session lưu Postgres, tắt đăng ký công khai. Admin tạo tài khoản với mật khẩu tạm (bắt đổi lần đầu) hoặc tạo link mời; người được mời tự khai tên và mật khẩu. Không cần SMTP.

**Đường dẫn đề xuất**

- `packages/core/src/auth/auth.ts`
- `packages/core/src/auth/invites.ts`
- `packages/db/src/schema/invites.ts`
- `apps/web/src/app/(auth)/login/page.tsx`
- `apps/web/src/app/(auth)/invite/[token]/page.tsx`
- `apps/web/src/app/(auth)/change-password/page.tsx`
- `apps/web/src/app/api/auth/[...all]/route.ts`
- `apps/web/src/middleware.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/auth/invites.test.ts`
  - Token chỉ lưu dạng hash, không có bản rõ trong DB
  - Dùng lại token đã chấp nhận: bị từ chối (replay)
  - Token hết hạn 7 ngày: bị từ chối
  - Token đã thu hồi: bị từ chối
  - Người mời không cấp được quyền mình không có (leo quyền qua lời mời)
  - Lời mời vào store chỉ tạo được bởi người có store.members của đúng store đó
- `packages/core/test/auth/signup.test.ts`
  - Gọi thẳng endpoint sign-up của better-auth: trả lỗi, không tạo user
  - Tài khoản mật khẩu tạm bị chặn mọi trang trừ đổi mật khẩu
- `tests/e2e/auth.spec.ts`
  - Admin tạo lời mời, copy link, người mới mở link, đặt mật khẩu, vào được app
  - Đăng xuất thì session bị thu hồi trong DB

**Điều kiện xong**

- Toàn bộ kịch bản bypass, replay, hết hạn, thu hồi, leo quyền có test đỏ trước khi xanh
- Không có đường tạo user nào ngoài admin và lời mời

---

## P1-04 Phân quyền theo store, chuyển owner và audit log

- **Owner:** webapp
- **Phụ thuộc:** P1-03
- **Màn prototype:** 5
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Bảng store_members với preset role và permissions[]; hàm can(principal, permission, {storeId}) trong packages/core là nơi kiểm quyền duy nhất; audit_log ghi actor_user_id, actor_kind cho mọi thay đổi quyền và hành động nhạy cảm. Màn Stores và thành viên (screen 5).

**Đường dẫn đề xuất**

- `packages/core/src/access/permissions.ts`
- `packages/core/src/access/can.ts`
- `packages/core/src/access/members.ts`
- `packages/core/src/audit/log.ts`
- `packages/db/src/schema/store-members.ts`
- `apps/web/src/app/(app)/stores/page.tsx`
- `apps/web/src/app/(app)/stores/[storeId]/members/page.tsx`
- `apps/web/src/features/stores/member-table.tsx`
- `apps/web/src/features/stores/invite-dialog.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/access/can.test.ts`
  - Ma trận preset x permission khớp ADR 0002 (test theo bảng)
  - Admin hệ thống không có product.push hay product.publish ở store chưa được cấp
  - seller_support mặc định không có product.publish
  - Quyền của store A không dùng được ở store B
- `packages/core/test/access/members.test.ts`
  - Chỉ owner cấp được product.publish
  - Không ai cấp được quyền mình không có
  - Không xoá hay hạ quyền owner cuối cùng
  - Mỗi store đúng 1 owner (ràng buộc DB, 2 transaction đua nhau)
  - Chuyển owner chỉ owner hoặc admin làm được, ghi audit_log
- `tests/e2e/stores-members.spec.ts`
  - Owner bật publish cho co_leader, co_leader thấy nút Public; tắt đi thì nút biến mất
  - Trạng thái quyền hiển thị bằng chữ và icon, không chỉ bằng màu

**Điều kiện xong**

- Mọi server action có store đều đi qua can()
- Ma trận quyền có test theo bảng
- Thay đổi quyền nào cũng có dòng audit_log

---

## P1-05 Object storage, assets và thư viện design theo store

- **Owner:** webapp
- **Phụ thuộc:** P1-04
- **Màn prototype:** 1
- **Tham chiếu PRD:** §13

**Mục tiêu.** Upload trực tiếp lên S3 bằng presigned PUT, kiểm sha256, dedupe theo (store_id, sha256), đọc ảnh qua presigned GET ngắn hạn. Design mặc định thuộc phạm vi store cho tới khi chốt policy dùng chung.

**Đường dẫn đề xuất**

- `packages/core/src/assets/storage.ts`
- `packages/core/src/assets/assets.ts`
- `packages/core/src/designs/designs.ts`
- `packages/db/src/schema/assets.ts`
- `packages/db/src/schema/designs.ts`
- `apps/web/src/features/designs/upload-queue.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/assets/assets.test.ts`
  - Upload file có sha256 khai báo sai: finalize bị từ chối, object bị xoá
  - Cùng file upload 2 lần trong 1 store: 1 asset
  - Người của store B không lấy được presigned URL ảnh store A
  - Presigned URL hết hạn đúng thời gian cấu hình
- `packages/core/test/designs/scope.test.ts`
  - Design mặc định chỉ hiện trong store đã upload
  - Chia sẻ design sang store khác là thao tác có quyền và có audit_log

**Điều kiện xong**

- Không có đường đọc file nào bỏ qua kiểm quyền store
- Dedupe và checksum có test

---

## P1-06 Bảng lease job AI, scheduler công bằng và reaper

- **Owner:** webapp
- **Phụ thuộc:** P1-05
- **Màn prototype:** 1
- **Tham chiếu PRD:** §5.1, §8.5

**Mục tiêu.** Bảng generation_jobs với lease_token, lease_expires_at, attempt, error_class, priority; claim bằng FOR UPDATE SKIP LOCKED theo thứ tự tier, xoay vòng store, xoay vòng người yêu cầu, tuổi job; reaper trả job hết lease về hàng đợi; bảng provider_accounts và workers.

**Đường dẫn đề xuất**

- `packages/db/src/schema/generation-jobs.ts`
- `packages/db/src/schema/provider-accounts.ts`
- `packages/db/src/schema/workers.ts`
- `packages/core/src/generation/scheduler.ts`
- `packages/core/src/generation/transitions.ts`
- `packages/core/src/generation/error-classes.ts`
- `apps/jobs/src/reapers/lease-reaper.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/generation/claim.test.ts`
  - 50 claim song song trên 20 job: không job nào bị claim 2 lần
  - Store A có 200 job, store B có 2 job: job của B được claim trong 2 lượt đầu
  - Account thiếu provider skill bắt buộc không nhận job cần skill đó
  - Account đang cooldown hoặc hết phiên không claim được
- `packages/core/test/generation/transitions.test.ts`
  - Bảng error class: mỗi class ra đúng trạng thái job, account và có tính attempt hay không
  - Transition dùng UPDATE có guard status + lease_token; 2 update đua nhau chỉ 1 thắng
  - Huỷ thắng hoàn thành: cancel ghi trước thì complete trả job_not_active
- `apps/jobs/test/lease-reaper.test.ts`
  - Job hết lease không complete/fail: về queued, tính 1 attempt transient
  - Vượt maxAttempts: failed; bị trả về quá N lần vì lỗi account: failed với lý do không có account khoẻ

**Điều kiện xong**

- Không double claim dưới tải song song có test
- Fairness theo store có test
- Mọi transition là UPDATE có guard

---

## P1-07 Worker API v2 routes và token worker

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P1-06
- **Màn prototype:** không
- **Tham chiếu PRD:** §8.5

**Mục tiêu.** Hiện thực đúng packages/contracts (OpenAPI 3.1, X-Contract-Version: 2) dưới /api/worker/v2: register, claim long-poll, heartbeat, uploads, complete, fail, account status, skill version. Token riêng từng worker, lưu hash. ngatruong123 duyệt contract trước khi bắt đầu.

**Đường dẫn đề xuất**

- `apps/web/src/app/api/worker/v2/register/route.ts`
- `apps/web/src/app/api/worker/v2/claim/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/heartbeat/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/uploads/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/complete/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/fail/route.ts`
- `apps/web/src/app/api/worker/v2/accounts/[accountId]/status/route.ts`
- `apps/web/src/app/api/worker/v2/skills/[versionId]/route.ts`
- `packages/core/src/workers/tokens.ts`
- `packages/core/src/workers/idempotency.ts`
- `packages/contracts/`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tests/contract/worker-api.test.ts`
  - Mọi response khớp schema OpenAPI (validate bằng Ajv từ packages/contracts)
  - Lease cũ: 409 lease_lost
  - Complete lặp lại cùng Idempotency-Key: trả kết quả lần đầu, không tạo kết quả trùng
  - Cùng key khác body: 422 idempotency_key_reused
  - uploadKey thiếu hoặc sha256 lệch: 422
  - Thiếu hoặc sai X-Contract-Version: 426
  - Token đã thu hồi: 401
- `tests/contract/cancel-race.test.ts`
  - Cancel và complete gửi đồng thời 100 lần: job luôn kết thúc ở đúng 1 trạng thái, file upload của nhánh thua được dọn

**Điều kiện xong**

- Contract test xanh trên toàn bộ ví dụ trong packages/contracts/examples
- ngatruong123 xác nhận contract bằng văn bản (comment/issue)

---

## P1-08 tools/fake-worker theo contract

- **Owner:** webapp
- **Phụ thuộc:** P1-07
- **Màn prototype:** không
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Worker giả bằng Node chỉ nói chuyện qua Worker API v2 và presigned URL, có kịch bản: thành công, chậm có heartbeat, rate limit, hết phiên, crash giữa chừng, trả ảnh sai checksum. Dùng cho dev, E2E và đo tải.

**Đường dẫn đề xuất**

- `tools/fake-worker/src/index.ts`
- `tools/fake-worker/src/scenarios.ts`
- `tools/fake-worker/assets/`
- `tools/fake-worker/README.md`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tools/fake-worker/test/scenarios.test.ts`
  - Kịch bản success: job về succeeded, có đủ ảnh
  - Kịch bản rate_limited: account vào cooldown, job về queued, attempt không tăng
  - Kịch bản crash: reaper trả job về hàng đợi sau lease
  - Worker từ chối URL ngoài storageOrigins

**Điều kiện xong**

- Chạy được bằng 1 lệnh, cấu hình kịch bản bằng tham số
- Không import code nội bộ của apps/web (chỉ dùng contracts)

---

## P1-09 Màn Studio: thư viện design, upload, tạo job, hàng đợi

- **Owner:** webapp
- **Phụ thuộc:** P1-08
- **Màn prototype:** 1
- **Tham chiếu PRD:** §11.3

**Mục tiêu.** Screen 1 theo prototype: lưới design ảo hoá, lọc và tìm kiếm qua URL (nuqs), upload hàng loạt cả thư mục, drawer tạo mockup/redesign chọn skill và số lượng, drawer hàng đợi có vị trí, trạng thái, huỷ, chạy lại.

**Đường dẫn đề xuất**

- `apps/web/src/app/(app)/studio/page.tsx`
- `apps/web/src/features/studio/design-grid.tsx`
- `apps/web/src/features/studio/upload-drawer.tsx`
- `apps/web/src/features/studio/create-job-drawer.tsx`
- `apps/web/src/features/studio/queue-drawer.tsx`
- `apps/web/src/features/studio/actions.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tests/e2e/studio.spec.ts`
  - Upload 20 file, 1 file trùng: 19 design mới, báo trùng rõ ràng
  - Tạo job mockup 10 ảnh: job hiện trong hàng đợi với vị trí
  - Huỷ job đang chạy: trạng thái chuyển Đã huỷ
  - Lọc và tìm kiếm giữ nguyên sau reload (URL state)
- `tests/e2e/studio-a11y.spec.ts`
  - axe không có lỗi nghiêm trọng
  - Drawer bẫy focus, Esc đóng và trả focus về nút mở

**Điều kiện xong**

- Luồng upload -> tạo job -> thấy trong hàng đợi chạy được với fake-worker
- Lưới 1.000 design cuộn mượt (virtual list)

---

## P1-10 Màn Duyệt ảnh

- **Owner:** webapp
- **Phụ thuộc:** P1-09
- **Màn prototype:** 2
- **Tham chiếu PRD:** §5.1, §11.3

**Mục tiêu.** Screen 2: design gốc đặt cạnh kết quả, phím tắt A duyệt, R loại (bắt buộc lý do), mũi tên chuyển ảnh, duyệt hàng loạt; lý do loại được lưu để đo chất lượng skill.

**Đường dẫn đề xuất**

- `apps/web/src/app/(app)/review/page.tsx`
- `apps/web/src/features/review/review-stage.tsx`
- `apps/web/src/features/review/use-review-keys.ts`
- `apps/web/src/features/review/reject-dialog.tsx`
- `packages/core/src/generation/review.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/generation/review.test.ts`
  - Người không có quyền ở store của design không duyệt được
  - Loại mà không có lý do: bị từ chối
- `tests/e2e/review.spec.ts`
  - A duyệt, R mở hộp lý do, mũi tên chuyển ảnh
  - Phím tắt không kích hoạt khi đang gõ trong ô nhập
  - Trạng thái duyệt hiển thị bằng chữ + icon, không chỉ bằng màu
  - Không tràn ngang ở 390px

**Điều kiện xong**

- Duyệt 50 ảnh chỉ bằng bàn phím được
- Lý do loại lưu kèm skill_version_id của job

---

## P1-11 Trạng thái realtime (SSE) và ghi usage_events

- **Owner:** webapp
- **Phụ thuộc:** P1-07, P1-08, P1-09
- **Màn prototype:** 1
- **Tham chiếu PRD:** §14

**Mục tiêu.** SSE cấp theo store, nguồn là Postgres LISTEN/NOTIFY sau commit; mỗi job kết thúc ghi usage_events (job_id, job_type, provider, account_id, requester_id, store_id, store_owner_id_at_time, units). Không có giới hạn hay quota.

**Đường dẫn đề xuất**

- `apps/web/src/app/api/events/route.ts`
- `packages/core/src/events/notify.ts`
- `packages/core/src/usage/record.ts`
- `packages/db/src/schema/usage-events.ts`
- `apps/web/src/features/realtime/use-store-events.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/usage/record.test.ts`
  - Job succeeded ghi đúng 1 usage_event, lặp complete không ghi thêm
  - Owner đổi sau đó thì usage cũ vẫn giữ store_owner_id_at_time ban đầu
- `tests/integration/sse.test.ts`
  - Client store A không nhận event của store B
  - Event chỉ bắn sau commit, rollback thì không bắn

**Điều kiện xong**

- Hàng đợi cập nhật không cần poll
- Có truy vấn tổng hợp usage theo store và theo owner (chỉ đọc)
