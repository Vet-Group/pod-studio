# Wireframe POD Studio (6 màn)

Prototype tương tác để duyệt UX trước khi code. Toàn bộ dữ liệu là DEMO, không gọi mạng, không kết nối hệ thống thật.

## Mở

Mở trực tiếp `index.html` bằng trình duyệt (chạy offline, CSS/JS/SVG nằm trong file).

## Nội dung

| Màn | Nội dung chính | Task |
| --- | --- | --- |
| 1 Studio | Thư viện design theo store, drawer upload, drawer tạo mockup, hàng đợi | P1-05, P1-09, P1-11 |
| 2 Duyệt ảnh | Design gốc cạnh mockup, phím A duyệt, R loại (có lý do), mũi tên chuyển ảnh | P1-10 |
| 3 Nội dung | Tab phân tích sản phẩm, editor content, xem trước listing | P2-01, P2-02 |
| 4 Sản phẩm | Bảng variant, dry-run bắt buộc, push draft, public kiểm quyền riêng | P2-03 đến P2-10 |
| 5 Store và thành viên | Chọn store, owner và quyền được cấp, bật tắt push/public, mời thành viên | P1-03, P1-04, P2-05 |
| 6 Skills và vận hành | Skill theo version, tài khoản AI (chạy, tạm nghỉ, hết phiên), worker | P3-01 đến P3-04 |

Ba chủ đề: 01 Sáng tạo (sáng), 02 Vận hành (dày thông tin), 03 Phòng tối (tối, cho duyệt ảnh).

## Kiểm thử

```bash
node design/wireframes/test-wireframes.mjs
```

Cần một Chrome/Chromium; đặt đường dẫn qua biến `CHROME_PATH` (mặc định là Chromium của Playwright trên máy này). Script dùng CDP trực tiếp, không cần cài package. Kiểm: điều hướng 6 màn, focus và Esc trả focus về nút mở, phím A/R/mũi tên, ma trận quyền, không tràn ngang và không cắt nhãn thanh điều hướng ở 1024/390 trên cả 6 màn, chụp ảnh vào `screenshots/`.

Lần chạy gần nhất: 67/67 đạt.

## Giới hạn

- Là wireframe, không phải design system cuối. Token màu và chữ sẽ chuyển sang `packages/ui` ở P3-08.
- Số liệu, thời gian, tên store và tài khoản là dữ liệu giả.
