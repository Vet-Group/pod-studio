# Quy ước database

Áp dụng cho `packages/db` từ P1-02. Nguồn: PRD §4, ADR 0001 (stack) và ADR 0002 (quyền theo store).

## Cấu trúc

| Đường dẫn | Nội dung |
| --- | --- |
| `packages/db/src/schema/*.ts` | Schema Drizzle, mỗi miền một file. `index.ts` export tất cả |
| `packages/db/src/schema/columns.ts` | Cột dùng chung: `id()`, `createdAt()`, `updatedAt()`, `timestamptz()` |
| `packages/db/src/ids.ts` | `newId()`, `ID_PATTERN`, `isId()` |
| `packages/db/src/migrate.ts` | `migrateDatabase()`: chạy migration có khoá và kiểm tra thứ tự |
| `packages/db/src/client.ts` | `createDatabase()`: pool postgres.js kèm schema |
| `packages/db/migrations/` | File SQL đánh số `0000_…`, `0001_…` và `meta/` của drizzle-kit |

App import `@pod-studio/db` (hoặc `@pod-studio/db/schema` khi chỉ cần bảng).

## Quy ước schema

- **Khoá chính**: cột `id` kiểu `text`, mặc định `newId()` (nanoid 21 ký tự). Khớp `Id` trong `packages/contracts/schemas/common.schema.json` (`^[A-Za-z0-9_-]{8,40}$`); test đọc thẳng pattern từ file contract. Không dùng `serial`, `uuid` hay id tăng dần.
- **Tên**: bảng số nhiều, `snake_case` (`users`, `stores`, `store_members`). Riêng `audit_log` là sổ ghi nên để số ít. Cột `snake_case`; property TypeScript `camelCase`. Khoá ngoại là `<bảng số ít>_id` (`user_id`, `store_id`).
- **Tên index**: `<bảng>_<cột>_idx`; unique là `<bảng>_<cột>_unique`. Khoá ngoại giữ tên drizzle-kit tự sinh.
- **Không Postgres enum, không CHECK**. Giá trị cố định là cột `text`, danh sách hợp lệ nằm trong code (`GLOBAL_ROLES`, `ACTOR_KINDS`) và được kiểm ở tầng app. Đổi danh sách không cần migration.
- **Thời gian**: mọi cột thời gian là `timestamptz` (`timestamp with time zone`). `created_at` và `updated_at` là `NOT NULL DEFAULT now()`; Drizzle tự làm mới `updated_at` ở mỗi lệnh update nó phát ra. Câu SQL viết tay phải tự đặt `updated_at = now()`.
- **Không xoá dữ liệu có lịch sử**. User bị khoá (`banned`), store sẽ lưu trữ. Khoá ngoại từ `audit_log` là `restrict`, nên xoá user hay store đã có trong sổ sẽ lỗi. Dữ liệu phụ thuộc thuần tuý (session, account) dùng `cascade`.
- **Chuỗi so khớp không phân biệt hoa thường** dùng unique index trên `lower(col)` (ví dụ `stores.domain`). App lưu giá trị đã chuẩn hoá.
- **JSON** dùng `jsonb` với `$type<…>()` để có type; mặc định `'{}'` thay vì `NULL` khi luôn có giá trị.

## Bảng hiện có

| Bảng | Mục đích |
| --- | --- |
| `users`, `sessions`, `accounts`, `verifications` | Bảng của better-auth 1.7.6 (email + mật khẩu, plugin admin). Property trùng tên field của better-auth; P1-03 nối adapter với `usePlural: true`. `users.role` là vai trò toàn cục `admin` hoặc `member` |
| `stores` | Store Shopify: tên, domain `*.myshopify.com`, `api_version`. Credential tách sang bảng riêng ở P2-05 |
| `audit_log` | Sổ ghi chỉ thêm (append-only): ai làm, trên store nào, việc gì, request nào |

Quyền theo store (`store_members`, `store_member_permissions`, preset) đến ở P1-04 theo ADR 0002.

## audit_log

- `actor_kind`: `user`, `agent`, `worker` hoặc `system`. `actor_user_id` là người thật đứng sau hành động; worker và job hệ thống để trống chứ không mượn danh ai.
- `action` là động từ có chấm, ví dụ `store.member.grant`. `target_type` + `target_id` trỏ đối tượng bị tác động; `data` là `jsonb` chi tiết.
- `request_id` và `ip` (`inet`, nhận cả IPv6) để trống khi việc không bắt đầu từ HTTP request, không bịa giá trị.
- Migration `0001` cài trigger chặn `UPDATE`, `DELETE`, `TRUNCATE`. Sửa sai bằng một dòng mới. Nếu sau này cần job dọn theo hạn lưu trữ, phải có migration riêng được review.

## Migration

```bash
pnpm services:up
cp apps/web/.env.example apps/web/.env.local   # một lần; chỉ chứa giá trị local
pnpm db:migrate        # áp migration còn thiếu vào database trong DATABASE_URL hoặc PG*
```

Khi đổi schema:

1. Sửa file trong `packages/db/src/schema/`.
2. `pnpm db:generate --name <mo_ta_ngan>` sinh file SQL mới. Đọc lại SQL trước khi commit.
3. Việc drizzle-kit không sinh được (trigger, function, dữ liệu) dùng `pnpm --filter @pod-studio/db exec drizzle-kit generate --custom --name <ten>` rồi viết SQL vào file trống. Giữ dòng `--> statement-breakpoint` giữa các câu lệnh.
4. `pnpm db:check` kiểm snapshot, rồi `pnpm test`.

Quy tắc:

- **Không sửa migration đã chạy ở bất kỳ đâu.** `migrateDatabase()` so hash và dừng nếu file đã chạy bị sửa. Muốn đổi thì thêm migration mới.
- **Chỉ tiến.** Không có migration down. Rollback là một migration mới đảo lại thay đổi.
- **Migration sinh sau phải nằm sau.** Khi hai nhánh cùng sinh migration, nhánh merge sau phải xoá file của mình và sinh lại trên `main`. Drizzle bỏ qua lặng lẽ migration có mốc thời gian cũ hơn migration đã chạy; `migrateDatabase()` dừng với lỗi `would be skipped` thay vì bỏ qua.
- Đừng dùng `drizzle-kit migrate` hay `drizzle-kit push`. `pnpm db:migrate` thêm advisory lock (hai tiến trình khởi động cùng lúc không chạy trùng DDL) và các kiểm tra trên.
- Lịch sử nằm ở `drizzle.__drizzle_migrations`.

## Test

- Test tích hợp tạo database riêng bằng `createTestDatabase()` (`tests/support/db.ts`), rồi `migrateDatabase(d.connection)`. Không dùng chung `pod_dev`.
- `packages/db/test/migrations.test.ts` kiểm: áp sạch trên database rỗng, chạy lại không đổi gì, ba tiến trình song song chỉ áp một lần; không enum, không CHECK; PK `text` tên `id`; mọi cột thời gian là `timestamptz`; unique, cascade, restrict; `audit_log` chặn sửa và xoá; các guard hash và thứ tự.
