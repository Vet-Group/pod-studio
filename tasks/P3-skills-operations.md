# P3 Skills và vận hành

Mục tiêu: vòng đời skill bất biến, vận hành account/worker, gia cố bảo mật, đo tải có số liệu, hoàn thiện UI.

> Mọi test dưới đây: **PLANNED - not implemented, not executed**. Đường dẫn là đề xuất, tương đối từ root monorepo.

| ID | Task | Owner | Phụ thuộc | Màn |
|---|---|---|---|---|
| P3-01 | Vòng đời skill: draft, duyệt, publish, deprecate | webapp + ngatruong123 | P1-07 | 6 |
| P3-02 | Gói niche agent: upload zip an toàn và validator | webapp + ngatruong123 | P3-01 | 6 |
| P3-03 | Provider skill: theo dõi cài đặt và định tuyến | webapp + ngatruong123 | P3-02 | 6 |
| P3-04 | Màn tài khoản AI và worker (admin) | webapp | P3-03 | 6 |
| P3-05 | Gia cố bảo mật | webapp | P1-03, P1-07, P2-05 | không |
| P3-06 | Quan sát và báo cáo usage | webapp | P1-11, P3-04 | 6 |
| P3-07 | Đo tải theo profile và cổng đạt | webapp | P1-06, P1-07, P1-08, P3-06 | 6 |
| P3-08 | Hoàn thiện UI và accessibility | webapp | P1-09, P1-10, P2-02, P2-08, P3-04 | 1, 2, 3, 4, 5, 6 |

---

## P3-01 Vòng đời skill: draft, duyệt, publish, deprecate

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P1-07
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Skills và skill_versions bất biến theo manifest trong packages/contracts; kiểm biến template khớp khai báo; diff 2 version; người có skill.publish duyệt; job ghi skill_version_id; gán skill mặc định theo job type, product type, niche.

**Đường dẫn đề xuất**

- `packages/core/src/skills/registry.ts`
- `packages/core/src/skills/render.ts`
- `packages/core/src/skills/bindings.ts`
- `packages/db/src/schema/skills.ts`
- `apps/web/src/app/(app)/skills/page.tsx`
- `apps/web/src/features/skills/template-editor.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/registry.test.ts`
  - Sửa version đã publish: bị từ chối, phải tạo version mới
  - Template dùng biến chưa khai báo: bị từ chối khi lưu
  - Manifest sai schema: bị từ chối với đường dẫn lỗi
- `packages/core/test/skills/render.test.ts`
  - Prompt render đúng biến, không chèn được biến lạ từ input người dùng

**Điều kiện xong**

- Mọi job AI truy được về đúng skill version

---

## P3-02 Gói niche agent: upload zip an toàn và validator

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P3-01
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Upload zip skill niche; giải nén có kiểm đường dẫn, giới hạn dung lượng và số file; chạy validator Python của pod-skill-builder như subprocess có timeout, map lỗi về field.

**Đường dẫn đề xuất**

- `packages/core/src/skills/archive.ts`
- `packages/core/src/skills/validator.ts`
- `apps/jobs/src/skills/validate-job.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/archive.test.ts`
  - Zip có ../ hoặc đường dẫn tuyệt đối: bị từ chối (zip-slip)
  - Zip bomb vượt giới hạn giải nén: dừng
  - Vượt số file tối đa: bị từ chối
  - Symlink trong zip: bị từ chối
- `packages/core/test/skills/validator.test.ts`
  - Validator chạy quá thời gian: bị kill, trả lỗi rõ
  - Output validator map đúng về field

**Điều kiện xong**

- Không có file nào được ghi ra ngoài thư mục tạm của lần giải nén

---

## P3-03 Provider skill: theo dõi cài đặt và định tuyến

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P3-02
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Theo dõi account nào cài provider skill version nào (từ register và account status); scheduler chỉ giao job cần skill cho account đã cài; chạy thử A/B và đo tỉ lệ ảnh được duyệt theo skill version.

**Đường dẫn đề xuất**

- `packages/core/src/skills/provider-install.ts`
- `packages/core/src/skills/test-runs.ts`
- `packages/db/src/schema/skill-installs.ts`
- `apps/web/src/features/skills/approval-rate.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/provider-install.test.ts`
  - Account báo gỡ skill: job cần skill không còn giao cho account đó
  - Tỉ lệ duyệt tính đúng theo skill version x provider

**Điều kiện xong**

- Thấy được skill nào cho tỉ lệ duyệt tốt hơn

---

## P3-04 Màn tài khoản AI và worker (admin)

- **Owner:** webapp
- **Phụ thuộc:** P3-03
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Screen 6 phần vận hành: trạng thái account (chạy, tạm nghỉ, hết phiên, chờ worker), worker trực tuyến và nhịp cuối, job đang chạy, skill đã cài; nút Đã đăng nhập lại; cấp và thu hồi token worker (hiện 1 lần, lưu hash).

**Đường dẫn đề xuất**

- `apps/web/src/app/(app)/admin/accounts/page.tsx`
- `apps/web/src/app/(app)/admin/workers/page.tsx`
- `apps/web/src/features/admin/account-table.tsx`
- `apps/web/src/features/admin/worker-token-dialog.tsx`
- `packages/core/src/workers/admin.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/workers/admin.test.ts`
  - Token worker chỉ hiện 1 lần, DB chỉ có hash
  - Thu hồi token: request kế tiếp 401
  - Chỉ admin truy cập được
- `tests/e2e/admin-accounts.spec.ts`
  - Account hết phiên hiện rõ bằng chữ + icon; bấm Đã đăng nhập lại thì chờ worker xác nhận

**Điều kiện xong**

- Admin biết ngay account nào cần đăng nhập lại

---

## P3-05 Gia cố bảo mật

- **Owner:** webapp
- **Phụ thuộc:** P1-03, P1-07, P2-05
- **Màn prototype:** không
- **Tham chiếu PRD:** §6.1

**Mục tiêu.** Giới hạn tốc độ đăng nhập, tạo lời mời, API worker; CSP và security header; CSRF cho server action; storageOrigins chống SSRF; redaction log; audit dependency; checklist review bảo mật trước production.

**Đường dẫn đề xuất**

- `apps/web/src/middleware.ts`
- `apps/web/next.config.ts`
- `packages/core/src/security/rate-limit.ts`
- `packages/core/src/logging/redact.ts`
- `docs/security-checklist.md`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/security/rate-limit.test.ts`
  - Sai mật khẩu quá ngưỡng: khoá tạm theo tài khoản và IP
- `packages/core/test/logging/redact.test.ts`
  - Log chứa token, cookie, secret: bị che trước khi ghi
- `tests/e2e/security-headers.spec.ts`
  - Mọi trang có CSP, X-Frame-Options, Referrer-Policy đúng cấu hình

**Điều kiện xong**

- Checklist bảo mật đạt, có người review

---

## P3-06 Quan sát và báo cáo usage

- **Owner:** webapp
- **Phụ thuộc:** P1-11, P3-04
- **Màn prototype:** 6
- **Tham chiếu PRD:** §14

**Mục tiêu.** Log có cấu trúc, metric (độ sâu hàng đợi, thời gian claim, lease hết hạn, trạng thái account), cảnh báo khi account hết phiên hoặc hàng đợi kẹt; xem audit log; báo cáo usage theo store và owner (chỉ đọc, không giới hạn).

**Đường dẫn đề xuất**

- `packages/core/src/observability/metrics.ts`
- `apps/jobs/src/alerts/account-alerts.ts`
- `apps/web/src/app/(app)/admin/audit/page.tsx`
- `apps/web/src/app/(app)/admin/usage/page.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/observability/metrics.test.ts`
  - Metric hàng đợi khớp số job queued thật trong DB
- `apps/jobs/test/account-alerts.test.ts`
  - Account chuyển session_expired: đúng 1 cảnh báo, không spam

**Điều kiện xong**

- Có dashboard vận hành đủ để trực không cần đọc DB

---

## P3-07 Đo tải theo profile và cổng đạt

- **Owner:** webapp
- **Phụ thuộc:** P1-06, P1-07, P1-08, P3-06
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Đo trên Postgres và MinIO thật bằng fake-worker. Profile đề xuất: A = 50 người dùng UI + 20 account + 5.000 job; B = 200 người dùng + 100 account + 50.000 job. Cổng đạt đề xuất (chốt lại khi có máy prod): claim p95 < 200 ms, không double claim, không store nào chờ quá 3 vòng xoay. Công bố cấu hình máy; sức chứa là số đo, không phải cam kết không giới hạn.

**Đường dẫn đề xuất**

- `tests/load/profiles.ts`
- `tests/load/run.ts`
- `tests/load/report.md`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tests/load/run.ts`
  - Profile A và B chạy đủ thời lượng, xuất p50/p95/p99, lỗi, độ công bằng, thời gian xả hàng đợi

**Điều kiện xong**

- Có báo cáo số đo thật kèm cấu hình máy
- Ghi rõ ngưỡng nào cần thêm worker hoặc tách DB

---

## P3-08 Hoàn thiện UI và accessibility

- **Owner:** webapp
- **Phụ thuộc:** P1-09, P1-10, P2-02, P2-08, P3-04
- **Màn prototype:** 1, 2, 3, 4, 5, 6
- **Tham chiếu PRD:** §11.2

**Mục tiêu.** Rà cả 6 màn ở 1440, 1024, 390: không tràn ngang, thao tác bàn phím đầy đủ, trạng thái không chỉ bằng màu, giảm chuyển động, axe sạch, ảnh chụp so sánh để bắt vỡ giao diện.

**Đường dẫn đề xuất**

- `packages/ui/src/tokens.css`
- `packages/ui/src/components/`
- `tests/e2e/visual/`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `tests/e2e/visual/screens.spec.ts`
  - 6 màn x 3 kích thước: không tràn ngang, ảnh chụp khớp baseline trong ngưỡng
- `tests/e2e/a11y.spec.ts`
  - axe không có lỗi serious/critical trên 6 màn
  - Toàn bộ luồng chính làm được chỉ bằng bàn phím

**Điều kiện xong**

- Checklist UI đạt ở cả 3 kích thước
