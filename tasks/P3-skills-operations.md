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
| P3-08 | Hoàn thiện UI và accessibility | webapp | P1-09, P1-10, P2-02, P2-08, P3-04 | 1, 2, 3, 4, 5, 6, 7 |
| P3-09 | Màn soạn niche master data theo schema 2.0 | webapp | P3-01, P3-02 | 7 |
| P3-10 | Chấm độ hợp thị trường và build skill version từ master data | webapp + ngatruong123 | P3-09 | 7 |
| P3-11 | Kho bí mật OpenBao cho tài khoản subscription và tự đăng nhập lại | webapp + ngatruong123 | P3-04, P3-05 | 6 |

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

## P3-09 Màn soạn niche master data theo schema 2.0

- **Owner:** webapp
- **Phụ thuộc:** P3-01, P3-02
- **Màn prototype:** 7
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR 0003)

**Mục tiêu.** Form 5 bước soạn đủ 17 section của schema 2.0; đếm tối thiểu theo từng field như generator, style_variants đúng 4; lỗi hiển thị cùng định dạng validator và nút Sửa đưa focus về field; trạng thái dữ liệu curated-draft, researched, validated; bản nháp lưu tự động theo skill.edit.

**Đường dẫn đề xuất**

- `packages/core/src/skills/niche-schema.ts`
- `packages/core/src/skills/niche-rules.ts`
- `apps/web/src/app/(app)/skills/niche/[id]/page.tsx`
- `apps/web/src/features/skills/niche-editor/`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/niche-schema.test.ts`
  - occasions 6 bản ghi: lỗi requires at least 8 records; found 6
  - style_variants 5 bản ghi: lỗi requires exactly 4
  - qa_rules.max_colors 13: lỗi expected an integer from 1 to 12
  - Bảng màu chứa #00FF00: bị từ chối
  - Dữ liệu mẫu teacher-example-data.json: hợp lệ
- `apps/web/test/e2e/niche-editor.spec.ts`
  - Nút Sửa nhảy đúng bước và focus field lỗi
  - Còn lỗi thì nút build bị khóa
  - Không tràn ngang ở 1024, 760, 390px

**Điều kiện xong**

- Luật tối thiểu trong UI và validator Python cho cùng kết quả trên bộ dữ liệu mẫu

---

## P3-10 Chấm độ hợp thị trường và build skill version từ master data

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P3-09
- **Màn prototype:** 7
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR 0003)

**Mục tiêu.** Chấm 6 tiêu chí 1 đến 5 (rõ ý, hợp làm quà, cảm xúc, khác biệt, làm thành bộ, an toàn IP), tối đa 30; 25 trở lên làm, 21 chỉnh, 16 làm lại, 15 trở xuống thay; IP dưới 4 luôn chặn. Build gọi generator như job worker có timeout, ra skill_version bất biến, chưa publish.

**Đường dẫn đề xuất**

- `packages/core/src/skills/market-fit.ts`
- `apps/jobs/src/skills/build-niche-skill.ts`
- `packages/contracts/schemas/niche-master-data.schema.json`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/market-fit.test.ts`
  - 26 điểm, IP 5: Làm
  - 24 điểm: Chỉnh
  - IP 3 dù tổng 27: Chặn
  - 15 điểm: Thay
- `apps/jobs/test/skills/build-niche-skill.test.ts`
  - Generator quá thời gian: job lỗi rõ, không tạo version
  - Build thành công: version mới trạng thái draft, không tự publish

**Điều kiện xong**

- Mọi skill version build từ master data truy được về bản master data và điểm chấm

---

## P3-11 Kho bí mật OpenBao cho tài khoản subscription và tự đăng nhập lại

- **Owner:** webapp + ngatruong123
- **Phụ thuộc:** P3-04, P3-05
- **Màn prototype:** 6
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR 0003)

**Mục tiêu.** Lưu thông tin đăng nhập tài khoản subscription (ChatGPT, Claude, Grok, Gemini và dịch vụ khác) trong OpenBao KV v2, TOTP qua secrets engine totp. Worker xác thực AppRole, nhận secret qua response wrapping dùng một lần. Khi account_state về session_expired, worker tự đăng nhập lại; captcha hoặc xác minh thiết bị thì chuyển trạng thái chờ người và báo admin. Webapp chỉ thấy metadata, không bao giờ thấy giá trị bí mật.

**Đường dẫn đề xuất**

- `infra/openbao/policies/worker-accounts.hcl`
- `infra/openbao/docker-compose.openbao.yml`
- `packages/contracts/schemas/account-credential-ref.schema.json`
- `apps/web/src/features/accounts/credential-status.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/accounts/credential-ref.test.ts`
  - API webapp trả metadata tài khoản không chứa giá trị bí mật
  - Wrap token dùng lần hai: bị từ chối
  - Policy worker không đọc được path của store khác
- `apps/web/test/e2e/account-relogin.spec.ts`
  - session_expired: worker báo đăng nhập lại thành công, trạng thái về available
  - Gặp captcha: trạng thái chờ người, admin nhận cảnh báo

**Điều kiện xong**

- Không có mật khẩu, cookie hoặc seed TOTP nào nằm trong Postgres, log hay payload job
