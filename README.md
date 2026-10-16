# Agent Company (prototype)

Bảng điều khiển chạy local cho "công ty AI" của riêng bạn. Công ty không gắn với một ngành nào: bạn mô tả việc kinh doanh, CEO thiết kế phòng ban, HR tuyển nhân sự, và mỗi nhân viên là một agent chạy bằng **Claude Code**, **Codex** hoặc **Antigravity** với subscription của bạn. Giao diện có hai ngôn ngữ EN / 日本語.

```
npm install
npm run dev        # server http://127.0.0.1:4317 + UI http://localhost:5317
```

Lần chạy đầu, nếu chưa có `org.yaml`, app tự tạo từ `templates/blank-company.yaml`. File `org.yaml` (tên công ty, nhân sự, thư mục project của bạn) và thư mục `data/` không được đưa lên git.

## Bắt đầu

1. Bấm vào thẻ **owner** để điền profile: tên, chức danh, giới thiệu bản thân, ngôn ngữ báo cáo, tên công ty và chế độ duyệt thay đổi tổ chức.
2. Mô tả việc kinh doanh trong ô giao việc, hoặc bấm một ví dụ có sẵn. CEO sẽ gọi `propose_org` để đề xuất phòng ban và nhân sự.
3. Mở **Approvals**, xem đề xuất rồi duyệt. Sơ đồ tổ chức cập nhật ngay.
4. Giao việc cho CEO, hoặc bấm vào bất kỳ nhân viên nào để **chat trực tiếp**.
5. Cần thêm hoặc bớt người: nhắn cho HR (Mei), HR dùng `hire` / `dismiss`, và mọi thay đổi vẫn đi qua Approvals.

## Nhiều project

- Mỗi **project** là một thư mục làm việc riêng. Toàn bộ nhân sự làm việc chung cho mọi project.
- Bộ chọn **Công ty / Project ▾** trên header quyết định task và tin nhắn chat được gửi vào project nào.
- Các project có thể chạy **song song**, mỗi project tối đa một task tại một thời điểm.
- **Manage projects…** dùng để thêm, đổi tên, đổi thư mục hoặc gỡ project. Gỡ project chỉ xoá nó khỏi danh sách; thư mục và file vẫn giữ nguyên.
- Phiên chat 1:1 được nhớ riêng cho từng cặp nhân viên và project.
- Khi trỏ vào một repo có sẵn, app không ghi đè `CLAUDE.md` / `AGENTS.md` của bạn. App có thêm `.agent-company/` và `.claude/agents/`, nên nếu không muốn commit chúng thì thêm vào `.gitignore` của repo.

## Chọn bộ máy cho CEO

Bấm vào CEO, mở tab **Profile**, chọn **Runs on: Claude Code / Codex**.

| | Claude Code | Codex |
|---|---|---|
| Giao việc cho đội | Subagent gốc (Agent tool) | Tool `delegate`. App chạy `claude --agent <id>` hoặc `codex exec` cho người nhận |
| Chạy song song | Subagent chạy nền | `delegate(wait=false)` rồi `wait_for_reports` |
| Nhắn cho CEO khi đang chạy | Tin nhắn được chèn trực tiếp vào phiên | Tin nhắn vào hộp thư, CEO đọc giữa các bước bằng `check_messages` |
| Kế hoạch, đề xuất, tuyển dụng | Tool MCP | Tool MCP, giống hệt |

Đổi bộ máy thì model đang chọn trở về mặc định của bộ máy mới, vì mỗi bên có tên model riêng. Tool của server MCP `agent-company` được tự động duyệt khi Codex chạy không tương tác. Thiếu thiết lập này, `codex exec` sẽ âm thầm huỷ mọi lần gọi tool.

## Kế hoạch & tiến độ

- Trước khi giao việc, CEO lập kế hoạch cho project bằng `set_plan` (milestone M1… và task T1… có người phụ trách) và cập nhật bằng `update_task`.
- Mỗi lần giao việc có mã task, ví dụ `[T3] …`. App tự chuyển task sang **doing** khi giao và sang **done** khi người làm thật sự xong (kể cả subagent chạy nền), nên tiến độ không phụ thuộc agent có nhớ báo cáo hay không.
- Viên tiến độ cạnh tên project (ví dụ `62% · 5/8`): bấm vào để xem kế hoạch chi tiết, cập nhật trực tiếp.
- Một nhân viên có thể làm nhiều việc song song; thẻ hiện **×N**, rê chuột hoặc mở panel để xem từng việc. Mặc định mỗi người làm tối đa 2 việc song song (`maxConcurrent` trong org.yaml); với Codex, việc vượt giới hạn sẽ xếp hàng.

## Portfolio & trang Project

- **Company / Projects** trên header dùng để chuyển giữa sơ đồ tổ chức và màn hình Portfolio.
- **Portfolio**: mỗi project là một thẻ gồm % tiến độ, milestone hiện tại, ai đang làm, việc tiếp theo, lần cập nhật cuối và chi phí. Project **cần bạn** luôn nằm đầu, rồi đến project đang chạy.
  - "Cần bạn" gồm: đề xuất chờ duyệt, câu hỏi agent hỏi bạn qua `message_owner` mà bạn chưa trả lời, task bị chặn, và việc thủ công.
- **Assign to several projects**: viết yêu cầu cho từng project, bấm một lần là các project cùng chạy song song.
- **Trang Project**:
  - Thanh **Now**: ai đang làm gì; nếu quá 5 phút không có động tĩnh thì hiện cảnh báo "không có hoạt động".
  - Tab **Plan**: kế hoạch và tiến độ.
  - Tab **Activity**: nhật ký gom theo task, lọc được theo người, có thể bật xem từng bước nhỏ.
  - Tab **Changes**: chạy `git status` / `git diff` (chỉ đọc), cho biết ai sửa file nào thuộc task nào, bấm vào file để xem diff. File config do app sinh ra không hiện ở đây.
- **View on the org chart** (hoặc nút gạt "Everyone / <project>" trên sơ đồ): làm mờ những người không tham gia project.
- Project đang chọn được lưu **riêng ở từng trình duyệt**: hai cửa sổ có thể xem hai project khác nhau.

## Tận dụng cấu hình sẵn có của repo

- App quét `CLAUDE.md`, `AGENTS.md`, `.claude/agents`, `.claude/skills`, `.claude/commands`, `.mcp.json` và lộ trình như `docs/journey.md`, và chỉ đọc chứ không sửa các file này.
- **Chế độ đội** cho từng project (trong Manage projects):
  - **Company team**: chỉ dùng nhân sự của công ty.
  - **Repo team**: dùng agent của repo, cộng HR.
  - **Both**: dùng cả hai. Đây là mặc định khi repo có agent riêng.
- Agent của repo nằm trong **một khung riêng** "<project> · own agents" dưới khối Claude Code. Bạn chat được với họ và theo dõi tiến độ như nhân viên thường.
- **Ai điều phối được họ**: CEO giao việc trực tiếp bằng Agent tool; nhân viên công ty (ví dụ PM) giao việc qua tool `delegate`. Khi đó app chạy một phiên `claude --agent <id>` riêng trong thư mục project, rồi trả kết quả về cho người giao. Việc được chuyển tiếp như vậy tự kế thừa mã task (`[T#]`) của người giao.
- CEO được báo về luật trong `CLAUDE.md`, các skill và lộ trình của repo. Nhân viên công ty dùng được skill của repo. Codex được chèn nội dung `CLAUDE.md` vào prompt, và `.mcp.json` của repo được nạp.

## Chat với từng nhân viên

| Tình huống | Điều gì xảy ra |
|---|---|
| CEO đang chạy một task | Tin nhắn được đưa thẳng vào phiên đang chạy (`--input-format stream-json`) |
| Nhân viên đang bận trong task | Tin nhắn vào hộp thư; nhân viên đọc giữa các bước bằng `check_messages` |
| Nhân viên đang rảnh | Mở phiên 1:1 riêng (`claude --agent <id>` / `codex exec`) và nối tiếp phiên cũ để nhớ ngữ cảnh |
| Nhân viên cần hỏi bạn | Nhân viên gọi `message_owner`, câu hỏi hiện trong khung chat |

## Cách hoạt động

```
org.yaml ──compile──► workspace/
                       ├─ CLAUDE.md, .claude/agents/*.md, .agent-company/ceo-prompt.md   (Claude Code)
                       ├─ AGENTS.md                                                      (Codex)
                       └─ .agent/rules/agent-company.md                                  (Antigravity)

Assign ─► claude -p (CEO) ─┬─ Agent tool ─► subagent Claude
                           └─ MCP "agent-company" ─► server ─┬─ delegate ─► codex exec --json
                                                             ├─ propose_org / hire / dismiss ─► Approvals ─► org.yaml
                                                             └─ check_messages / message_owner ─► chat
mọi bước ─► event bus (data/events.jsonl) ─► SSE ─► sơ đồ tổ chức, Activity, chat
```

- **Templates**:
  - `templates/blank-company.yaml`: mặc định, chỉ có CEO, HR và đối tác Codex.
  - `templates/bakery-example.yaml`: tiệm bánh do CEO thiết kế.
  - `templates/software-company.yaml`: công ty phần mềm.
  - Copy một template đè lên `org.yaml` để dùng.
- **Watch a demo**: phát một kịch bản sinh từ tổ chức hiện tại, không tốn quota.
- **Antigravity** chạy ở chế độ `manual`, vì gói consumer không hỗ trợ app ngoài tự động hoá `agy`. Task được đưa vào inbox để bạn copy prompt và chạy tay.

## Tuỳ chỉnh tay trong `org.yaml`

| Muốn… | Sửa |
|---|---|
| Đổi model | `model: opus / sonnet / haiku` (Claude) hoặc tên model của Codex |
| Giới hạn quyền | `tools` (Claude), `sandbox: read-only / workspace-write` (Codex), `permissions.allow` |
| Luật công ty | `company.rules` |
| Danh sách project | `company.projects` (`id`, `name`, `path`) và `company.activeProject` |
| Bảo vệ một vai trò khỏi bị cho nghỉ | `core: true` |

Biến môi trường: `PORT`, `AGENT_COMPANY_CLAUDE_BIN`, `AGENT_COMPANY_CODEX_BIN`. Mặc định app tự tìm trong PATH; với Codex, app còn tìm thêm trong extension VS Code.

## An toàn

- Server chỉ lắng nghe trên `127.0.0.1`, và mọi request ghi dữ liệu bắt buộc có header `x-agent-company`.
- App không đọc token; việc xác thực do chính các CLI đảm nhận.
- Mọi thay đổi tổ chức do agent đề xuất đều cần bạn duyệt, trừ khi bạn bật tự động duyệt.
- Agent Claude chạy với `permissions.mode` (mặc định `acceptEdits`) và một allowlist lệnh Bash. Agent Codex chạy trong sandbox.
