# P2 Listing và Shopify

Mục tiêu: từ ảnh đã duyệt tạo product đúng bảng giá, sinh content, dry-run bắt buộc, push draft, public theo quyền riêng; bất biến PRD §20 thành test.

> Mọi test dưới đây: **PLANNED - not implemented, not executed**. Đường dẫn là đề xuất, tương đối từ root monorepo.

| ID | Task | Owner | Phụ thuộc | Màn |
|---|---|---|---|---|
| P2-01 | Phân tích sản phẩm | webapp | P1-07, P1-10 | 3 |
| P2-02 | Sinh và sửa content listing đa ngôn ngữ | webapp | P2-01, P2-04 | 3 |
| P2-03 | Catalog: product type, bảng giá, variant | webapp | P1-04 | 4 |
| P2-04 | Tạo product từ kết quả đã duyệt | webapp | P1-10, P2-01, P2-03 | 4 |
| P2-05 | Kết nối Shopify: credential mã hoá và client | webapp | P1-04 | 5 |
| P2-06 | Push dry-run và snapshot | webapp | P2-02, P2-04, P2-05 | 4 |
| P2-07 | Push draft: thực thi, kiểm lại quyền, idempotency, reconcile | webapp | P2-06 | 4 |
| P2-08 | Public: status active, sales channel, market | webapp | P2-07 | 4 |
| P2-09 | Hàng chờ yêu cầu push | webapp | P2-06, P1-04 | 4 |
| P2-10 | Import và resync từ Shopify | webapp | P2-03, P2-05 | 4 |

---

## P2-01 Phân tích sản phẩm

- **Owner:** webapp
- **Phụ thuộc:** P1-07, P1-10
- **Màn prototype:** 3
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Job product_analysis theo contract: đầu vào design + niche + link đối thủ tuỳ chọn; đầu ra audience, dịp, keyword chính/phụ, góc bán, gợi ý product type và giá, cảnh báo IP. Kết quả làm context cho content.

**Đường dẫn đề xuất**

- `packages/core/src/analysis/analysis.ts`
- `packages/db/src/schema/product-analyses.ts`
- `apps/web/src/app/(app)/listing/[designId]/analysis/page.tsx`
- `apps/web/src/features/listing/analysis-panel.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/analysis/analysis.test.ts`
  - Payload sai schema ProductAnalysisPayload: job failed với input_invalid, không lưu rác
  - Cảnh báo IP mức high hiển thị nổi bật nhưng không chặn thao tác
- `tests/e2e/analysis.spec.ts`
  - Chạy phân tích với fake-worker, kết quả hiện đủ các mục

**Điều kiện xong**

- Phân tích gắn được vào job content làm context

---

## P2-02 Sinh và sửa content listing đa ngôn ngữ

- **Owner:** webapp
- **Phụ thuộc:** P2-01, P2-04
- **Màn prototype:** 3
- **Tham chiếu PRD:** §6.3

**Mục tiêu.** Job listing_content theo từng locale; locale lấy từ params, không lấy từ payload; truyền danh sách primary keyword đã dùng trong store; editor có bộ đếm giới hạn SEO, sinh lại từng trường, lịch sử phiên bản; bản sửa tay thắng bản sinh mới.

**Đường dẫn đề xuất**

- `packages/core/src/listing/content.ts`
- `packages/core/src/listing/seo.ts`
- `packages/db/src/schema/listing-contents.ts`
- `apps/web/src/app/(app)/listing/[productId]/page.tsx`
- `apps/web/src/features/listing/content-editor.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/listing/content.test.ts`
  - Payload ghi locale khác params: lưu theo params
  - Keyword chính trùng keyword đã dùng trong store: cảnh báo
  - Bản sửa tay không bị job sinh sau ghi đè
- `packages/core/test/listing/seo.test.ts`
  - Quy tắc SEO theo PRD §6.3 thành test theo bảng
- `tests/e2e/listing.spec.ts`
  - Sửa title, bộ đếm cập nhật, lưu, reload vẫn còn

**Điều kiện xong**

- Mỗi locale có content hợp lệ trước khi cho push

---

## P2-03 Catalog: product type, bảng giá, variant

- **Owner:** webapp
- **Phụ thuộc:** P1-04
- **Màn prototype:** 4
- **Tham chiếu PRD:** §4.2, §6.2

**Mục tiêu.** product_types, pricing_rules theo store; variant sinh từ bảng giá, không từ tích Descartes; thứ tự theo sort_order; excluded_markets theo từng dòng giá. Chỉ người có store.settings sửa được.

**Đường dẫn đề xuất**

- `packages/db/src/schema/catalog.ts`
- `packages/core/src/catalog/product-types.ts`
- `packages/core/src/catalog/pricing.ts`
- `apps/web/src/app/(app)/stores/[storeId]/catalog/page.tsx`
- `apps/web/src/features/catalog/pricing-table.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/catalog/pricing.test.ts`
  - Variant đúng bằng số dòng bảng giá, đúng thứ tự sort_order (bất biến §20.1)
  - Dòng giá thiếu option của type: bị từ chối
  - Người không có store.settings không sửa được bảng giá

**Điều kiện xong**

- Bảng giá sửa được dạng bảng, có validate

---

## P2-04 Tạo product từ kết quả đã duyệt

- **Owner:** webapp
- **Phụ thuộc:** P1-10, P2-01, P2-03
- **Màn prototype:** 4
- **Tham chiếu PRD:** §6.4, §5.3

**Mục tiêu.** Chọn design + ảnh đã duyệt, product type; SKU là tên file design bỏ đuôi; ảnh design làm featured; stage product suy ra theo PRD §5.3, tính theo batch không N+1.

**Đường dẫn đề xuất**

- `packages/core/src/products/create.ts`
- `packages/core/src/products/stage.ts`
- `packages/db/src/schema/products.ts`
- `apps/web/src/app/(app)/products/page.tsx`
- `apps/web/src/features/products/create-product-drawer.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/products/create.test.ts`
  - SKU bằng tên file bỏ đuôi, giống nhau mọi variant (bất biến §20.11)
  - Chỉ ảnh đã duyệt được chọn
  - Tạo lặp cùng nguồn: không tạo product trùng
- `packages/core/test/products/stage.test.ts`
  - Các nhánh deriveStage theo PRD §5.3 thành test theo bảng
  - Danh sách 200 product tính stage bằng số truy vấn cố định

**Điều kiện xong**

- Product tạo xong có đủ variant, ảnh, SKU

---

## P2-05 Kết nối Shopify: credential mã hoá và client

- **Owner:** webapp
- **Phụ thuộc:** P1-04
- **Màn prototype:** 5
- **Tham chiếu PRD:** §7, §6.1

**Mục tiêu.** Lưu client_secret và access token bằng AES-256-GCM (khoá từ env, có version); Shopify Admin GraphQL client có xử lý throttle; nút Test kết nối; stub Shopify xác định được cho test.

**Đường dẫn đề xuất**

- `packages/core/src/shopify/client.ts`
- `packages/core/src/shopify/crypto.ts`
- `packages/core/src/shopify/connect.ts`
- `packages/db/src/schema/shopify.ts`
- `tests/support/shopify-stub.ts`
- `apps/web/src/app/(app)/stores/[storeId]/settings/page.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/shopify/crypto.test.ts`
  - Mã hoá rồi giải mã đúng; sửa 1 byte ciphertext thì giải mã lỗi
  - Log và lỗi không bao giờ chứa secret (quét chuỗi)
- `packages/core/test/shopify/client.test.ts`
  - Throttle từ Shopify: chờ và thử lại có giới hạn
  - Chỉ owner hoặc người có store.settings xem/sửa credential

**Điều kiện xong**

- Không có secret dạng rõ trong DB, log, response

---

## P2-06 Push dry-run và snapshot

- **Owner:** webapp
- **Phụ thuộc:** P2-02, P2-04, P2-05
- **Màn prototype:** 4
- **Tham chiếu PRD:** §6.5, §7.4

**Mục tiêu.** Dry-run dựng toàn bộ input push (productSet, media, bản dịch, market, sales channel) từ snapshot content tại thời điểm bấm, so với dữ liệu đang có trên Shopify, hiện diff. Đổi giá hoặc content sau dry-run thì dry-run hết hiệu lực.

**Đường dẫn đề xuất**

- `packages/core/src/push/plan.ts`
- `packages/core/src/push/snapshot.ts`
- `packages/core/src/push/diff.ts`
- `apps/web/src/features/products/push-panel.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/push/plan.test.ts`
  - Snapshot khoá content tại thời điểm push (bất biến §20.10)
  - Đổi giá sau dry-run: dry-run bị đánh dấu cũ, không cho push
  - Dry-run không gọi mutation nào tới Shopify stub

**Điều kiện xong**

- Không push được nếu chưa có dry-run còn hiệu lực

---

## P2-07 Push draft: thực thi, kiểm lại quyền, idempotency, reconcile

- **Owner:** webapp
- **Phụ thuộc:** P2-06
- **Màn prototype:** 4
- **Tham chiếu PRD:** §5.4, §6.5, §7.4, §12

**Mục tiêu.** Job push chạy trong apps/jobs (pg-boss); lần đầu mặc định draft; kiểm lại product.push lúc chạy và trước từng store; timeout sau khi đã ghi Shopify thì đọc lại để reconcile, không retry mù; mọi bước ghi event.

**Đường dẫn đề xuất**

- `apps/jobs/src/push/run-push.ts`
- `packages/core/src/push/execute.ts`
- `packages/core/src/push/reconcile.ts`
- `packages/db/src/schema/push-jobs.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/push/execute.test.ts`
  - Quyền bị thu hồi giữa job: dừng trước store kế tiếp, ghi event
  - Admin chưa được cấp: bị từ chối
  - Match variant bằng variantOptionKey, không theo index (bất biến §20.2)
  - Media: gắn ảnh mới trước rồi mới xoá ảnh cũ (bất biến §20.6)
  - Lần push đầu mặc định draft (bất biến §20.9)
- `packages/core/test/push/reconcile.test.ts`
  - Stub timeout sau khi đã tạo product: job đọc lại theo handle/idempotency key, không tạo product thứ 2
  - pg-boss giao lại message: job đã terminal thì thoát ngay

**Điều kiện xong**

- Push 1 product lên Shopify dev store (gate riêng, cần credential) đúng variant, giá, ảnh

---

## P2-08 Public: status active, sales channel, market

- **Owner:** webapp
- **Phụ thuộc:** P2-07
- **Màn prototype:** 4
- **Tham chiếu PRD:** §6.5, §20

**Mục tiêu.** Tách quyền product.publish; hộp xác nhận bắt buộc tick; kiểm lại quyền lúc chạy; market exclusion fail closed; sales channel non-market khác bị unpublish khi type có khai báo. Bộ test bất biến PRD §20 phần push.

**Đường dẫn đề xuất**

- `packages/core/src/push/publish.ts`
- `packages/core/src/push/markets.ts`
- `apps/web/src/features/products/publish-confirm-dialog.tsx`
- `packages/core/test/push/invariants/`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/push/publish.test.ts`
  - Có product.push nhưng không có product.publish: bị từ chối
  - seller_support không được owner cấp publish: bị từ chối
  - Owner thu hồi publish sau khi job xếp hàng: job dừng khi chạy
- `packages/core/test/push/invariants/markets.test.ts`
  - Market exclusion fail closed (bất biến §20.3)
  - Channel non-market khác bị unpublish (bất biến §20.4)

**Điều kiện xong**

- Mọi bất biến §20 liên quan push có test tương ứng

---

## P2-09 Hàng chờ yêu cầu push

- **Owner:** webapp
- **Phụ thuộc:** P2-06, P1-04
- **Màn prototype:** 4
- **Tham chiếu PRD:** không (yêu cầu mới từ ADR/contract)

**Mục tiêu.** Người có product.edit nhưng không có product.push thấy nút Gửi yêu cầu push; yêu cầu kèm dry-run; người có product.push trong store duyệt hoặc trả lại có lý do; có thông báo.

**Đường dẫn đề xuất**

- `packages/core/src/push/requests.ts`
- `packages/db/src/schema/push-requests.ts`
- `apps/web/src/app/(app)/products/requests/page.tsx`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/push/requests.test.ts`
  - Người gửi không tự duyệt được yêu cầu của mình nếu không có product.push
  - Dry-run của yêu cầu cũ thì phải chạy lại trước khi duyệt
- `tests/e2e/push-request.spec.ts`
  - Seller gửi yêu cầu, owner thấy trong hàng chờ, duyệt thì job push chạy

**Điều kiện xong**

- Không có đường push nào bỏ qua người có quyền

---

## P2-10 Import và resync từ Shopify

- **Owner:** webapp
- **Phụ thuộc:** P2-03, P2-05
- **Màn prototype:** 4
- **Tham chiếu PRD:** §6.6

**Mục tiêu.** Import product có sẵn trên Shopify vào catalog; resync variant theo bảng giá; giữ nguyên SKU khi resync.

**Đường dẫn đề xuất**

- `packages/core/src/shopify/import.ts`
- `packages/core/src/catalog/resync.ts`
- `apps/jobs/src/shopify/import-job.ts`

**Test dự kiến** (PLANNED - not implemented, not executed)

- `packages/core/test/shopify/import.test.ts`
  - Import 2 lần không tạo trùng
  - Resync giữ nguyên SKU (bất biến §20.11)
  - Người không có quyền store không import được

**Điều kiện xong**

- Import chạy nền, có tiến độ và log
