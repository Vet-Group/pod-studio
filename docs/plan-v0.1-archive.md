# Plan: Webapp nội bộ "POD Studio" dựng trên nền PRD storekit (bản nháp v0.1)

> Trạng thái: bản nháp để thảo luận, **chưa triển khai**. Ngày 2026-09-30.
> Nguồn đã đọc: `Downloads/prd-rebuild.md` (storekit + mockup-worker), `ngatruong123/redesign`, `ngatruong123/remakeai`, `Vet-Group/pod-skill-builder`.
> Chưa đọc được: repo `storekit` và `mockup-worker` (không thấy dưới ngatruong123, Vet-Group, huuhungn). Mọi nhận định về 2 repo này dựa vào PRD.
> Phạm vi của bạn: Webapp, API, DB, scheduler, quota. Phạm vi ngatruong123: workers (browser/API) và skills runtime.

---

## 0. Đánh giá: có dựa vào PRD được không?

**Được, nhưng dùng PRD như "domain spec", không dùng như kiến trúc.** PRD rất tốt ở phần nghiệp vụ Shopify (đã có bất biến, idempotency, state machine, test case), nhưng được viết cho **1 người vận hành, 1 máy, 1 mật khẩu**. Ba giả định này ngược với bài toán của bạn.

| Phần PRD | Quyết định | Lý do |
|---|---|---|
| §4.1-4.4 catalog, pricing, products, variants, translations, store_products | **Giữ gần nguyên**, thêm cột owner/team | Đã ổn định, gắn chặt với logic push |
| §6.2-6.6 bảng giá, SEO, tạo product, push 14 bước, import | **Giữ nguyên logic** | Phần giá trị nhất và dễ sai nhất; bất biến §20 phải giữ |
| §7 tích hợp Shopify | **Giữ** | |
| §5.1 state machine mockup_jobs | **Giữ transition, bổ sung** lease/heartbeat, error_class, trạng thái quota | Nhiều người dùng cần hàng đợi công bằng |
| §8.5 internal worker API | **Giữ làm v1 compat**, thiết kế v2 | Để mockup-worker hiện tại chạy tiếp trong lúc chuyển đổi |
| §8.4 agent API | **Giữ**, đổi auth sang token per agent có scope | |
| §1.2, §10 auth `APP_PASSWORD`, session stateless | **Thay hoàn toàn** | Cần user, role, thu hồi session |
| §13 filesystem chung, ràng buộc "cùng máy" §1.3 | **Thay** bằng object storage + presigned URL | Worker phải chạy được trên nhiều máy/IP |
| §15 `WORKER_TOKEN`/`AGENT_TOKEN` dùng chung trong env | **Thay** bằng credential per worker/agent trong DB | Thu hồi, truy vết từng worker |
| §16 mockup-worker | **Thuộc ngatruong123**, webapp chỉ giữ hợp đồng | |
| §6.7-6.10 translate, audit, blog, theme | **Hoãn sau MVP** (hỏi Q8) | Không phục vụ trực tiếp designer/seller |
| §11 UI | **Viết lại theo persona**, giữ design token §11.2 | UI hiện tại cho 1 operator |

Ước lượng: khoảng 60% PRD tái dùng trực tiếp cho `core`. Phần còn lại (identity, tenancy, quota, storage, skills, UX) phải thiết kế mới.

Trả lời luôn 5 câu hỏi mở của PRD §22 (đề xuất, chờ bạn duyệt):

1. `<h3>` trong description: **không**, theo code hiện tại. Đưa quy tắc này vào content skill để đổi được mà không sửa code.
2. Heartbeat worker: **có**, bắt buộc trong v2 (xem §6).
3. Class lỗi có `code` thay regex: **có**.
4. Vá store scope và race duplicate guard: **có**, làm ngay trong bản dựng.
5. Backend mockup mặc định `chatgpt`: **có**.

---

## 1. Mục tiêu và phi mục tiêu

**Mục tiêu v1**

1. Nhiều người dùng đồng thời (designer, seller, leader, admin), phân quyền theo team và store.
2. Điều phối job AI công bằng trên số account giới hạn: quota, ưu tiên, hàng đợi minh bạch.
3. Luồng designer: upload → redesign/variation → mockup → duyệt.
4. Luồng seller: phân tích sản phẩm → sinh title/description/tags/SEO đa ngôn ngữ → sửa → push Shopify.
5. Skills: registry, editor, version, chạy thử, gán vào luồng.
6. Hợp đồng rõ ràng với worker/skills của ngatruong123, chạy song song được với mockup-worker hiện tại.

**Phi mục tiêu v1**: bán SaaS ra ngoài (multi-org, billing), marketplace ngoài Shopify, auto-push không người bấm, lưu credential ChatGPT/Grok trong webapp.

---

## 2. Ranh giới trách nhiệm

| Hạng mục | Webapp (bạn) | Worker/Skills (ngatruong123) | Chung |
|---|---|---|---|
| Auth, RBAC, team, store grant | ✓ | | |
| Job API, scheduler, quota, ledger | ✓ | | |
| Browser automation, login account, profile, proxy | | ✓ | |
| Credential account AI | | ✓ (chỉ trên máy worker) | |
| Nội dung prompt/skill | lưu, version, phân phối | viết, kiểm chứng | |
| Validator skill (Python) | gọi qua job | sở hữu | |
| Hợp đồng API (OpenAPI + JSON Schema) | | | ✓ `packages/contracts` |
| Object storage | cấp presigned URL | upload/download | |
| Shopify push | ✓ | | |

Quy tắc merge: **không chia sẻ DB, không chia sẻ filesystem**. Hai bên chỉ gặp nhau ở HTTP contract và object storage. Nhờ vậy khác stack (ngatruong123/redesign dùng Next.js + Prisma, PRD dùng TanStack Start + Drizzle, worker dùng Python) không còn là vấn đề.

---

## 3. Kiến trúc đề xuất

```
Người dùng (designer / seller / leader / admin)
   │ SSO + session DB
   ▼
apps/web  (UI + server functions + REST /api/v2)
   │                                   ▲
   ▼                                   │ presigned URL
Postgres (bảng app + pgboss.*) ◄── apps/jobs (Node, pg-boss)
   ▲                                   push, text-LLM, product analysis,
   │                                   reapers, scheduler tick, notify
   │ /api/v2/worker/*  (register, claim, heartbeat, complete, fail, account-status)
   │
AI workers (ngatruong123): chatgpt@accN, grok@accN, gemini-api, ...
   │ chạy trên 1 hoặc nhiều máy
   ▼
Object storage (MinIO self-host hoặc Cloudflare R2)
```

Nguyên tắc:

- Worker không đọc DB, không đọc filesystem của webapp. Bỏ ràng buộc "cùng máy" của PRD §1.3.
- Server quyết định job nào chạy tiếp (scheduler). Worker chỉ claim theo capability của account nó đang giữ.
- Credential account AI nằm trên máy worker. Webapp chỉ biết metadata và sức khoẻ account.
- `packages/core` thuần TypeScript, không phụ thuộc framework, như PRD §3, để port logic push/SEO.

Monorepo:

```
apps/web             TanStack Start (hoặc Next.js, xem Q6)
apps/jobs            Node + pg-boss
packages/core        catalog, pricing, seo, push, generation, quota, skills, rbac
packages/db          drizzle schema + migrations
packages/contracts   OpenAPI worker v2 + JSON Schema skill manifest → sinh TS types + Pydantic
packages/skill-schema  schema master data niche (dùng chung với POD Skill Studio nếu team đồng ý)
packages/ui          design token (PRD §11.2) + shadcn
tools/fake-worker    worker giả để test scheduler/quota, không cần Chrome
```

---

## 4. Người dùng và phân quyền

Mô hình: 1 Organization (công ty) → nhiều Team (ví dụ Wall Art, Apparel) → User. Store được cấp cho team, có thể override theo user.

| Role | Quyền chính |
|---|---|
| Admin | user, team, store, Shopify credential, provider account, quota policy, publish skill, xem mọi audit |
| Leader | quản lý thành viên team, duyệt design/listing, đặt ưu tiên job, xem KPI và usage của team, push |
| Designer | upload design, redesign, mockup, duyệt ảnh, dùng skill đã publish, tạo skill draft (nếu được cấp) |
| Seller | phân tích sản phẩm, tạo product, sửa content, preview, push trên store được cấp |
| Viewer | chỉ xem |

- Permission là chuỗi (`job.create`, `job.priority.set`, `result.approve`, `product.create`, `product.push`, `store.manage`, `skill.edit`, `skill.publish`, `quota.manage`, `account.manage`, `user.manage`). Role là tập permission. Kiểm tra trong `core`, không chỉ ở UI.
- Mọi truy vấn có store đi qua `assertStoreAccess(principal, storeId, perm)`, cộng với các guard store-scope của PRD §4.6.
- Service principal: `worker` (mỗi worker một token, lưu hash, scope `worker:*`) và `agent` (diprr, scope hạn chế, cờ `push_allowed` riêng). Thay `WORKER_TOKEN`/`AGENT_TOKEN` chung.
- Auth: SSO (Google Workspace hoặc Lark OAuth, xem Q3), dự phòng invite email + mật khẩu. Session lưu DB để thu hồi được.
- `activity_log` thêm `actor_user_id`, `actor_kind` (user/agent/worker/system).

---

## 5. Quota và điều phối account (trọng tâm)

### 5.1 Vấn đề

- Account subscription (ChatGPT, Grok) có giới hạn ẩn, không công bố số chính xác, hay bị cooldown và hết phiên. Một account xử lý một job một lúc (PRD §16.2).
- API (Gemini, OpenAI, DeepSeek) giới hạn theo RPM/TPM và tính tiền.
- FIFO thuần: một người upload 200 design là chiếm hết hàng đợi của cả công ty.

### 5.2 Khái niệm

- **`provider_account`**: một account cụ thể (chatgpt-acc1, grok1, gemini-key-a). Có capabilities (mockup, redesign, content, analysis) và trạng thái `active | busy | cooldown(until) | session_expired | disabled`. Worker báo trạng thái, admin bật/tắt.
- **Capacity unit**: chi phí quy đổi cho từng cặp job type × backend, cấu hình được. Ví dụ ban đầu: mockup ChatGPT = 10, content qua browser = 3, content qua API = 1. Không hardcode giới hạn nhà cung cấp; đo thực tế rồi chỉnh.
- **`quota_policy`**: scope (user | team | role) × job type/provider × window (ngày | tháng) → `limit_units`, `max_inflight`, `max_pending`.
- **`quota_ledger`**: reserve lúc enqueue, commit lúc complete, release lúc cancel hoặc lỗi không do người dùng.

### 5.3 Luồng

1. **Enqueue**: kiểm tra quyền → reserve quota → tạo job `pending` (hoặc `waiting_quota`), trả vị trí hàng đợi và ETA ước tính.
2. **Claim** (worker gọi): server chọn theo thứ tự priority tier (`interactive` > `normal` > `bulk`) → round-robin theo người yêu cầu (ai đang có ít job chạy nhất đi trước) → `created_at`. Vẫn dùng `FOR UPDATE SKIP LOCKED` như PRD. Tôn trọng `max_inflight` theo user và team.
3. **Lease + heartbeat**: `lease_expires_at` ngắn (ví dụ 5 phút), worker heartbeat mỗi 60 giây. Reaper dựa vào lease, không dựa `claimed_at` 30 phút. Luồng ChatGPT chạy 15-20 phút không còn bị cắt nhầm.
4. **Fail có phân loại** `error_class`:

   | error_class | Xử lý job | Xử lý account | Tính attempt | Trừ quota |
   |---|---|---|---|---|
   | `account_rate_limited` (+ `retry_after_s`) | về `pending` | cooldown | không | không |
   | `account_session_expired` | về `pending` | `session_expired`, báo admin | không | không |
   | `provider_refused` | `failed`, báo người dùng sửa prompt/design | giữ nguyên | có | có (tuỳ policy) |
   | `transient` | retry có backoff | giữ nguyên | có | không |
   | `permanent` | `error_permanent` | giữ nguyên | | không |

5. **Complete**: commit ledger, lưu kết quả, thông báo sau commit (như PRD §14).

### 5.4 Giảm tiêu hao quota

- **Text task chạy qua API**, không qua browser ChatGPT. PRD hiện sinh content bằng browser (§16.6), chiếm slot của account vẽ ảnh. Chuyển listing content và product analysis sang API LLM trong `apps/jobs`. Cần ngatruong123 đồng ý và duyệt ngân sách API.
- **Mockup template** (composite bằng sharp/Fabric như `ngatruong123/redesign`) cho ảnh chuẩn (khung trơn, flat lay): không tốn quota AI. AI dành cho cảnh lifestyle.
- **Cache/dedupe**: cùng `sha256(design) + skill_version + params` thì cho phép dùng lại kết quả.
- **Bulk chạy ngoài giờ**: hàng `bulk` được ưu tiên ban đêm, `interactive` ưu tiên giờ hành chính.
- **Minh bạch**: người dùng luôn thấy vị trí hàng đợi, ETA, số dư quota, lý do đang chờ.

---

## 6. Hợp đồng worker v2 (làm chung với ngatruong123)

v1 (PRD §8.5) vẫn chạy song song cho mockup-worker hiện tại, rồi tắt ở P9.

| Endpoint | Mục đích |
|---|---|
| `POST /api/v2/worker/register` | worker khai báo id, host, version, accounts[], capabilities |
| `POST /api/v2/worker/claim` | `{worker_id, account_id, capabilities, job_types}` → `{job, inputs[presigned GET], skill:{id, version, manifest_url}, lease_expires_at}`; 204 khi hết job |
| `POST /api/v2/worker/jobs/:id/heartbeat` | gia hạn lease, progress (tuỳ chọn), log ngắn |
| `POST /api/v2/worker/jobs/:id/uploads` | xin presigned PUT cho N output |
| `POST /api/v2/worker/jobs/:id/complete` | `{outputs:[{key, sha256, width, height, meta}]}` hoặc `{payload}` cho content; idempotent theo key |
| `POST /api/v2/worker/jobs/:id/fail` | `{error_class, message, retry_after_s?}` |
| `POST /api/v2/worker/accounts/:id/status` | `{status, cooldown_until?, installed_skills?}` |

- Contract nằm ở `packages/contracts` (OpenAPI 3.1 + JSON Schema), sinh TS types và Pydantic model. Contract test chạy ở cả hai repo. Đổi contract thì bump version.
- `tools/fake-worker` giúp webapp test độc lập, không phụ thuộc tiến độ worker thật.

---

## 7. Skills

### 7.1 Ba loại "skill" đang tồn tại (cần xác nhận Q9)

| Loại | Ví dụ | Chạy ở đâu | Webapp làm gì |
|---|---|---|---|
| Prompt template | `SCENE_PROMPTS` (poster, tshirt, mug...), `REDESIGN_PROMPT`, content prompt theo niche (PRD §16.8-16.9) | Worker tải theo version | Lưu, version, editor, gán vào luồng |
| Provider skill | `@create-wall-art-mockups` phải cài trên mọi account ChatGPT (PRD §16.8) | Trong account ChatGPT | Theo dõi account nào đã cài bản nào, cảnh báo thiếu |
| Niche design agent | Output của `Vet-Group/pod-skill-builder`: master data schema 2.0 → `SKILL.md` + zip | Agent/worker | Editor master data, validate, build, publish, phân phối |

### 7.2 Dữ liệu

- `skills` (kind, slug, name, niche, owner_team, visibility)
- `skill_versions` (semver, status `draft | in_review | published | deprecated`, manifest jsonb, artifact_key cho zip, checksum, schema_version, changelog, created_by, published_by)
- `skill_bindings` (job type × product type × niche × backend → skill_version; mặc định toàn công ty, override theo team)
- `skill_test_runs` (version, design mẫu, job ids, approval rate)
- Version đã publish là **bất biến**. Mỗi job lưu `skill_version_id` để truy vết ảnh nào sinh từ prompt nào.

### 7.3 UI-UX

- **Thư viện**: lọc theo kind, niche, product type, trạng thái; hiện version, approval rate, người sở hữu.
- **Editor prompt template**: biến `{count}`, `{product_type}`; cảnh báo khi có mention `@skill` (worker phải gõ mention bằng phím thật, PRD §16.6 bước 6); preview prompt sau khi render.
- **Editor niche agent**: wizard theo section như POD Skill Studio (`app/src/lib/schema/sections.ts`, `types.ts`): personas, occasions, emotions, visual vocabulary...; badge `count/min`; field tham chiếu chéo là dropdown; hằng số cố định (nền `#00FF00`, tỉ lệ 3:4) chỉ đọc; tab JSON thô.
- **Validate**: không viết lại validator bằng TS. Gọi `create_pod_design_skill.py --validate-only` qua job `skill-validate` (Python sidecar hoặc worker), map lỗi về field (tái dùng ý tưởng `parseValidatorOutput.ts`, `errorIndex.ts`).
- **Review và publish**: diff giữa 2 version, Leader/Admin duyệt trước khi publish.
- **Chạy thử**: chọn 1-3 design mẫu, chạy bằng budget "sandbox" riêng, so với version đang dùng (A/B).
- **Gán skill**: bảng binding, rollout theo team.
- **KPI chất lượng**: approval rate kết quả ảnh theo skill version × backend (có sẵn cột `approved` ở PRD §5.2). Đây là dữ liệu để quyết định prompt nào tốt hơn.

Đề xuất thêm: tách `packages/skill-schema` để POD Skill Studio (Tauri) và web editor dùng chung một schema. Cần hỏi team pod-skill-builder.

---

## 8. UX theo persona

Điều hướng:

- **Studio** (designer): Designs, Redesign, Mockups, Review
- **Listing** (seller): Analyze, Products, Content, Push
- **Skills**
- **Team** (leader): Dashboard, Approvals, Usage
- **Admin**: Users & Teams, Stores, AI Accounts & Workers, Quota, Audit log

Màn hình chính:

1. **Design library**: upload hàng loạt (kéo cả thư mục), dedupe sha256, gắn niche/product type/tag, tìm kiếm, trạng thái pipeline của từng design.
2. **Tạo job** (redesign/mockup): chọn design, product type, skill (mặc định theo binding), số lượng, backend "tự động" hoặc ghim; hiện chi phí unit, số dư, ETA **trước khi bấm**.
3. **Hàng đợi của tôi**: vị trí, ETA, trạng thái, huỷ, chạy lại; realtime qua SSE thay vì poll 2-3 giây.
4. **Review**: lưới ảnh, phím tắt (A duyệt, R loại, ←/→), đặt cạnh design gốc, duyệt hàng loạt, lý do loại (dữ liệu để cải tiến skill).
5. **Product analysis** (seller): đầu vào là design/ảnh + niche + (tuỳ chọn) link đối thủ. Đầu ra: audience, dịp, keyword chính/phụ, góc bán, cảnh báo IP/trademark, product type và giá gợi ý. Dùng làm context cho content.
6. **Listing studio**: tạo product từ kết quả đã duyệt (PRD §6.4); editor đa locale có bộ đếm giới hạn (SEO title 60, SEO description 155, 13 tag, handle); cảnh báo keyword trùng trong store; sinh lại từng trường; lịch sử bản content.
7. **Push**: preview/dry-run so với Shopify, chọn publish status, cần quyền `product.push`, tuỳ policy cần Leader duyệt.
8. **Leader dashboard**: throughput design → mockup → listing → push, cycle time duyệt, approval rate, usage quota theo user/team, job lỗi.
9. **AI Accounts & Workers** (admin): trạng thái account, cooldown, session hết hạn (nút "đã đăng nhập lại"), worker online, job đang chạy, skill đã cài trên account.

---

## 9. Dữ liệu: thay đổi so với PRD

Giữ các bảng PRD §4.1-4.4. Thêm:

```
users, sessions, invites, teams, team_members(role), role_permissions
store_grants(team_id | user_id, store_id, permissions[])
service_clients(kind worker|agent, name, token_hash, scopes, push_allowed, last_used_at, revoked_at)
assets(storage_key, sha256, mime, width, height, bytes, owner_user_id, team_id)
designs            + created_by, team_id, niche, tags, asset_id (thay source_file)
generation_jobs    (= mockup_jobs) + requested_by, team_id, priority, cost_units,
                   lease_expires_at, account_id, skill_version_id, error_class,
                   not_before, idempotency_key, queue_state
generation_results (= mockup_results) + asset_id, approved_by_user_id, reject_reason
provider_accounts, workers (last_seen, version, current_job_id)
quota_policies, quota_ledger
skills, skill_versions, skill_bindings, skill_test_runs
product_analyses(design_id, input, output jsonb, model, created_by)
approvals(entity, entity_id, requested_by, decided_by, status)
activity_log       + actor_user_id, actor_kind
```

Giữ quy ước PRD: PK text nanoid, không Postgres enum, `timestamptz`. Vá luôn các lỗi PRD đã chỉ ra: duplicate guard bằng unique `(store_id, source_job_id, result_set_hash)`; lọc stage trước khi phân trang; class lỗi thay regex; thêm store scope cho `rollbackThemeBackup`, `fixFindings`, `ignoreFinding`.

---

## 10. Lộ trình

| Phase | Nội dung | Nghiệm thu |
|---|---|---|
| **P0 Chốt** (khoảng 1 tuần) | Trả lời §12; lấy quyền repo storekit/mockup-worker; họp contract với ngatruong123; wireframe 6 màn chính; chốt stack | Contract v2 draft được 2 bên duyệt; wireframe duyệt; ADR stack |
| **P1 Nền móng** | Monorepo, DB, SSO + invite, session DB, RBAC, team, store grant, audit log, khung UI + token | Admin mời user, gán role; seller không thấy store không được cấp (có test) |
| **P2 Asset + Design** | Object storage, presigned URL, upload hàng loạt, dedupe, design library | Upload 200 file không trùng, có thumbnail |
| **P3 Scheduler + Quota** | generation_jobs, claim công bằng, lease/heartbeat, error_class, ledger, provider_accounts, trang workers, v1 compat, fake-worker | 10 user × 50 job: không double claim; không ai phải chờ hết batch của người khác; rate limit không tốn attempt; hết quota thì `waiting_quota` |
| **P4 Designer studio** | Tạo job, hàng đợi (SSE), review, duyệt | upload → mockup → duyệt chạy được với fake-worker và 1 worker thật |
| **P5 Catalog + Listing** | PRD P2 + P5: product type, bảng giá, tạo product, fan-out content, editor, product analysis qua API | Tạo product N locale, stage `ready`, bản sửa tay thắng bản sinh |
| **P6 Push** | Logic 14 bước PRD P6 + permission + approval policy | Dry run khớp snapshot; push store dev đúng mọi bất biến PRD §20 |
| **P7 Skills** | Registry, version, editor prompt template, wizard niche, validate sidecar, binding, chạy thử | Publish prompt poster v2 thì job mới dùng v2, job cũ vẫn trỏ v1; có approval rate theo version |
| **P8 Leader + Ops** | Dashboard KPI, usage, thông báo (Lark hoặc Buzz), backup, monitoring, deploy chờ queue rảnh | Leader xem usage theo user; có alert khi account `session_expired` |
| **P9 Migration** | Import dữ liệu storekit prod (nếu có) vào team mặc định, giữ id; chuyển mockup-worker sang v2; tắt v1 | Số hàng khớp; GID Shopify giữ nguyên; push lại ra `skipped` |
| **P10 (tuỳ chọn)** | Translate, audit, blog, theme (PRD P8-P10) | Theo PRD |

Có thể song song: sau P3, ngatruong123 phát triển worker v2 dựa vào contract và fake-worker, không phải chờ UI.

---

## 11. Rủi ro

- **Điều khoản sử dụng**: tự động hoá account ChatGPT/Grok bản consumer có thể vi phạm điều khoản và bị khoá. Cần phương án API dự phòng cho luồng quan trọng, không phụ thuộc 1-2 account.
- **Giới hạn ẩn thay đổi**: quota phải cấu hình được và điều chỉnh theo sự kiện rate limit thực tế.
- **Skill ngoài hệ thống**: account ChatGPT thiếu `@create-wall-art-mockups` sẽ sinh ảnh sai. Cần theo dõi việc cài đặt trên từng account.
- **Khác stack giữa hai bên**: giảm bằng contract HTTP, không chia sẻ DB.
- **Dữ liệu prod storekit**: nếu đang chạy, migration phải giữ GID Shopify và checksum để không tạo product trùng.
- **Secret trong repo công khai**: xem ghi chú bảo mật gửi kèm trong chat.

---

## 12. Câu hỏi cần bạn trả lời

Ưu tiên cao (chặn P0):

1. **Repo và prod**: storekit và mockup-worker nằm ở đâu, ai sở hữu? storekit có đang chạy production với dữ liệu thật cần migrate không?
2. **Quy mô**: bao nhiêu designer, seller, leader? Bao nhiêu store? Bao nhiêu design mỗi ngày? Hiện có bao nhiêu account ChatGPT, Grok, Gemini, dự kiến tăng bao nhiêu?
3. **Đăng nhập**: công ty dùng Google Workspace hay Lark để SSO?
4. **Quy trình duyệt**: ai được push Shopify? Design/listing có cần Leader duyệt trước khi push không? Seller có thấy mọi store không?
5. **Quota**: tính theo người hay theo team? Có mức ưu tiên (ví dụ đơn gấp) không? Có ngân sách API (Gemini/OpenAI) làm dự phòng không?
6. **Stack**: theo PRD (TanStack Start + Drizzle + pg-boss) hay Next.js + Prisma như `ngatruong123/redesign`?

Ưu tiên trung bình:

7. **Hạ tầng**: chạy trên host Ubuntu + Tailscale như PRD, hay VPS/Cloudflare? Object storage chọn MinIO hay R2?
8. **Phạm vi**: translate, audit, blog, theme có cần trong v1 không?
9. **Skills**: ngatruong123 làm loại skill nào trong 3 loại ở §7.1? `Vet-Group/pod-skill-builder` (commit của willpine88, thienduy2211) có phải phần skills cần tích hợp không?
10. **Thông báo**: Lark hay Buzz như PRD?
11. **Product analysis**: đầu vào là ảnh, link đối thủ (Etsy/Amazon), hay cả hai? Đầu ra cần những trường gì?
12. **Mockup template**: có muốn thêm mockup composite theo template (không tốn quota AI) như `ngatruong123/redesign` không?

---

## 13. Mặc định nếu chưa có trả lời

- Stack: TanStack Start + Drizzle + pg-boss, để tái dùng PRD tối đa.
- Auth: SSO Google Workspace + invite.
- Storage: MinIO trên cùng host.
- Text task (content, analysis) chạy qua API.
- Có heartbeat, có class lỗi, backend mockup mặc định `chatgpt`, description không mở đầu bằng `<h3>`.
- Không làm translate, audit, blog, theme trong v1.

---

## 14. Bước tiếp theo đề xuất

1. Bạn trả lời Q1-Q6.
2. Soạn `packages/contracts` bản nháp (OpenAPI worker v2 + JSON Schema skill manifest) để gửi ngatruong123 review.
3. Wireframe 6 màn: Design library, Tạo job, Review, Listing studio, Skills editor, AI Accounts & Workers.
4. Chia P1-P3 thành task chi tiết có file path và test.
