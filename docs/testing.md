# Chạy dev và test

Tài liệu cho P1-01. Chỉ cần **Node 22.12+**, **pnpm** (qua `corepack`) và **Docker Desktop**.

## Từ clean checkout

```bash
corepack enable
pnpm install
pnpm services:up      # Postgres 16 (cổng 54316) + MinIO (cổng 19000, console 19001)
pnpm dev              # webapp: http://localhost:3100
```

`pnpm dev` hiện chưa đọc database: webapp mới có khung điều hướng 7 màn, bố cục responsive và màu lấy từ `design/wireframes/index.html`. Mỗi màn là trang giữ chỗ, ghi rõ task nào sẽ dựng nó. Database và đăng nhập đến ở P1-02 và P1-03; khi đó mới cần chép `apps/web/.env.example` thành `apps/web/.env.local`.

Kiểm tra nhanh: `curl http://localhost:3100/api/health` trả `{"ok":true,...}`.

## Lệnh kiểm tra

| Lệnh | Việc làm |
| --- | --- |
| `pnpm typecheck` | Sinh type route của Next rồi chạy `tsc` cho app và thư mục `tests/` |
| `pnpm lint` | ESLint cho toàn repo (bỏ qua `design/`, `packages/contracts/`, `tasks/` vì có bộ kiểm riêng) |
| `pnpm test` | Vitest: guard, test cô lập Postgres/MinIO thật, test của `apps/web` |
| `pnpm test:e2e` | Playwright ở 1440px và 390px: điều hướng, 404, không tràn ngang, axe WCAG 2.2 AA, vùng bấm 44px trên điện thoại |
| `pnpm check` | `typecheck` + `lint` + `test` |

`pnpm test` tự chạy `docker compose up -d --wait` nếu Postgres hoặc MinIO chưa lên. Đặt `TEST_SKIP_SERVICES_UP=1` nếu muốn tự quản lý service. `pnpm test:e2e` tự bật `next dev` ở cổng 3100, hoặc dùng lại server đang chạy.

## Cô lập dữ liệu test

- Mỗi test tạo **database riêng** `pod_w<worker>_<ngẫu nhiên>_test` và **bucket riêng** `pod-w<worker>-<ngẫu nhiên>-test` (`tests/support/db.ts`, `tests/support/storage.ts`). Hai worker song song ghi cùng id không va nhau.
- Cleanup chỉ xoá database và bucket do chính tiến trình đó tạo; tên khác (kể cả `pod_dev`, `postgres`) bị từ chối.
- `tests/support/guard.ts` dừng cả lượt test trước khi file test nào được nạp nếu:
  - `DATABASE_URL` hoặc `TEST_PGHOST` không phải localhost,
  - tên database không kết thúc bằng `_test`,
  - `S3_ENDPOINT` hoặc `TEST_S3_ENDPOINT` không phải MinIO local qua `http`.

Biến có thể đổi (mặc định khớp `ops/local/docker-compose.yml`): `TEST_PGHOST`, `TEST_PGPORT`, `TEST_PGUSER`, `TEST_PGPASSWORD`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`. Mật khẩu trong compose chỉ dùng cho máy local.

## Service local

| Service | Địa chỉ | Ghi chú |
| --- | --- | --- |
| Postgres 16 | `127.0.0.1:54316`, user `pod`, db `pod_dev` | Không dùng 5432 vì máy dev có thể đã chạy Postgres khác |
| MinIO API | `http://127.0.0.1:19000` | Image `chainguard/minio` ghim theo digest; image `minio/minio` chính thức không còn kéo công khai được |
| MinIO console | `http://127.0.0.1:19001` | Đăng nhập bằng `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` trong compose |

`pnpm services:down` dừng service và giữ dữ liệu; `pnpm services:reset` xoá luôn volume.

## Ghi chú

- Kế hoạch ghi `vitest.workspace.ts`; Vitest 5 đã bỏ file workspace, nên các project khai báo trong `vitest.config.ts` (`test.projects`).
- `packages/contracts` giữ lockfile npm và lệnh `npm run check` riêng; nó chưa nằm trong pnpm workspace cho tới khi P1-07 nối type sinh ra vào `apps/web`.
- Bộ test wireframe vẫn chạy riêng: `node design/wireframes/test-wireframes.mjs`.
