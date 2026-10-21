# Agent Company (prototype)

Bảng điều khiển chạy local để điều phối các agent AI trên nhiều project. Mỗi project có **đội agent riêng**, chính là các file `.claude/agents/*.md` trong repo của project đó. Một agent **Organizer** dẫn dắt mọi project: lập kế hoạch, đề xuất đội cho từng project, giao việc và báo cáo cho bạn. Agent chạy bằng **Claude Code** hoặc **Codex** với subscription của bạn. Giao diện có hai ngôn ngữ EN / 日本語.

```
npm install
npm run dev        # server http://127.0.0.1:4317 + UI http://localhost:5317
npm run dev:watch  # như trên, nhưng server tự khởi động lại khi sửa code (khi phát triển app)
```

`npm run dev` không tự khởi động lại server, vì mỗi lần khởi động lại sẽ cắt ngang mọi agent đang chạy. Chỉ dùng `dev:watch` khi đang sửa code server và không có việc gì đang chạy.

Lần chạy đầu, nếu chưa có `org.yaml`, app tự tạo từ `templates/blank-company.yaml`. File `org.yaml` (profile, Organizer, thư mục project của bạn) và thư mục `data/` không được đưa lên git.

## Bắt đầu

1. Bấm vào nút chữ cái đầu tên bạn ở góc phải header để điền profile: tên, chức danh, giới thiệu bản thân, ngôn ngữ báo cáo, tên công ty và chế độ duyệt thay đổi đội.
2. **Manage projects…**: thêm thư mục project (repo có sẵn hoặc thư mục mới).
3. Chọn project trên header. Màn hình chia hai: bên trái là **khung chat**, bên phải là **khung project** gồm các slash command (hình lục giác) và đội agent (Claude Code ở trên, Codex ở dưới). Mũi tên nối mỗi lệnh với các agent mà lệnh đó gọi tới. Agent nào đang làm việc thì có mũi tên nét đứt chạy từ Organizer (góc dưới bên trái) tới agent đó. Kết quả mới nhất mỗi agent giao xong hiện thành thẻ **Outputs** ở bên phải agent; bấm vào để xem báo cáo đầy đủ. Khi Claude Code tự tạo agent phụ (general-purpose, Explore, Plan…), agent đó hiện trong mục **Spawned by Claude** lúc đang chạy, in kết quả ra cột Outputs khi xong, rồi tự biến mất sau khoảng 45 giây.
4. Project chưa có đội: bấm ví dụ "Build a team…" hoặc nhờ Organizer đề xuất. Organizer gọi `propose_team`, bạn duyệt trong **Approvals**, và app ghi các file agent vào `.claude/agents/` của repo.
5. Mỗi project có **một khung chat duy nhất** ở bên trái. Tin nhắn mặc định gửi cho Organizer; bắt đầu tin nhắn bằng `@id-agent` để gửi thẳng cho agent đó (bấm vào thẻ agent cũng điền sẵn `@id-agent`). Câu trả lời của mọi agent đều hiện trong cùng khung chat. Nút **i** ở góc thẻ agent mở hoạt động và profile của agent.

## Đội của từng project

- Đội = các file agent trong repo, chia theo bộ máy:
  - `.claude/agents/*.md`: agent chạy bằng **Claude Code** (dùng được cả khi mở Claude Code trực tiếp trong repo).
  - `.codex/agents/*.md`: agent chạy bằng **Codex**, cùng định dạng (frontmatter `name`, `description`, `model`, `sandbox: read-only | workspace-write`, phần thân là hướng dẫn). Codex không có khái niệm agent riêng nên app chạy chúng bằng `codex exec` với hướng dẫn đó.
  - Trên sơ đồ, khung của project chia thành hai phần **Claude Code** và **Codex**. Organizer giao việc cho agent Claude bằng Agent tool, cho agent Codex bằng `delegate`.
- Agent bạn tự viết và agent do Organizer đề xuất đều nằm trong repo, nên đội đi theo repo và được quản lý bằng git. Khi đề xuất đội, Organizer chọn bộ máy cho từng agent: Claude cho phần lớn công việc, Codex cho phản biện độc lập, review, kiểm tra chéo số liệu (model khác giúp tránh "nghĩ giống nhau").
- **Thêm agent**: Organizer dùng `propose_team` (cả đội một lần) hoặc `hire` (từng agent). Mọi đề xuất đều qua **Approvals**; khi duyệt, app ghi file mới và không bao giờ ghi đè file có sẵn (trùng tên thì thêm hậu tố).
- **Bớt agent**: Organizer dùng `dismiss`, nhưng chỉ xoá được agent do app tạo (có dòng `Hired through Agent Company`). Agent bạn tự viết thì bạn sửa/xoá trong repo.
- File agent do app tạo là của bạn: sửa thoải mái, app không ghi đè.

## Check-in: Organizer dừng lại để chốt với bạn

Organizer gọi `ask_owner` ở các điểm cần chốt và **chờ** câu trả lời:

| Loại | Khi nào |
|---|---|
| **Spec** | Tính năng mới hoặc yêu cầu còn mơ hồ: mục tiêu, phạm vi, ngoài phạm vi, tiêu chí nghiệm thu, câu hỏi mở |
| **Plan** | Sau khi lập kế hoạch: milestone, task, người làm, rủi ro. Chỉ giao việc khi bạn duyệt |
| **Milestone** | Xong một milestone: đã làm gì, kiểm tra thế nào, bước tiếp theo |
| **Decision** | Lựa chọn đổi phạm vi/kiến trúc, hoặc không hoàn tác được (commit/push/deploy, xoá dữ liệu) |

- Thẻ check-in hiện trong **Approvals** và ngay trong khung chat với Organizer: bấm **Approve**, chọn một phương án, hoặc ghi nhận xét rồi **Request changes**. Gõ trả lời trong chat cũng được: tin nhắn tiếp theo của bạn chính là câu trả lời.
- Bạn vắng lâu (quá ~25 phút): Organizer dừng lại, tóm tắt tình hình. Khi bạn trả lời, app **nối tiếp đúng phiên đó** (resume session) để làm tiếp.
- Mức độ check-in chỉnh trong profile của bạn: **Spec, plan & milestones** (mặc định) / **Plan only** / **Only when stuck**. Việc nhỏ, rõ ràng thì Organizer làm luôn.

## Duyệt ngay trong chat

Đề xuất đội (`propose_team` / `hire` / `dismiss`) và check-in của Organizer hiện thành thẻ ngay trong khung chat với Organizer: bấm **Approve / Decline** (hoặc Approve / Request changes) tại chỗ. Thẻ cũng có trong **Approvals**; duyệt ở đâu cũng được, và câu trả lời được ghi lại trong chat.

## Việc đang chạy & dừng giữa chừng

- Bấm **Activity** (hoặc chữ "N running" trên header) để xem **Running now**: mọi lượt chạy của Organizer, câu trả lời chat đang soạn, và task được giao (kể cả task đang xếp hàng), kèm project, bộ máy, thời gian chạy và bước đang làm. Subagent bên trong một lượt chạy của Organizer hiện ngay dưới lượt đó.
- Thời gian chuyển **vàng** sau 15 phút, **đỏ** sau 30 phút. Nút **Stop** dừng đúng việc đó cùng mọi tiến trình con (MCP server, lệnh shell…); phần đã làm vẫn giữ. Dừng một task được giao thì Organizer nhận báo "stopped by owner" và làm tiếp phần còn lại.
- Tự động dừng: trong profile của bạn chọn **Stop work automatically after** 30 phút / 1 giờ / 2 giờ (mặc định: không). Thời gian chờ bạn trả lời check-in không bị tính.

## Slash command của repo

- Gõ `/` trong khung chat (hoặc bấm vào một lệnh trên khung project) để thấy danh sách lệnh trong `.claude/commands/` của project (kèm mô tả và tham số); ↑/↓ để chọn, Tab hoặc Enter để điền.
- Khi đang gõ một lệnh, lệnh đó và các agent nó gọi sáng lên trên khung project; khi gửi, một chấm sáng chạy từ khung chat qua lệnh tới các agent. App biết lệnh gọi agent nào bằng cách tìm id của agent trong nội dung file lệnh.
- Gửi `/ten-lenh tham-so` cho agent Claude: Claude Code tự chạy lệnh đó. Với Organizer chạy bằng Codex, app tự mở file lệnh, điền `$ARGUMENTS` / `$1…` rồi gửi thành prompt.
- Organizer và các agent trong đội cũng tự dùng được lệnh của repo (qua Skill tool). Lệnh commit/push/deploy/xoá thì Organizer phải hỏi bạn trước (check-in Decision), trừ khi chính bạn yêu cầu.

## Nhiều project

- Bộ chọn project trên header quyết định task và tin nhắn chat được gửi vào project nào.
- Các project có thể chạy **song song**, mỗi project tối đa một task tại một thời điểm.
- **Manage projects…** dùng để thêm, đổi tên, đổi thư mục hoặc gỡ project. Gỡ project chỉ xoá nó khỏi danh sách; thư mục và file vẫn giữ nguyên.
- Phiên chat 1:1 được nhớ riêng cho từng cặp agent và project.
- Khi trỏ vào một repo có sẵn, app không ghi đè `CLAUDE.md` / `AGENTS.md` của bạn. App có thêm thư mục `.agent-company/` (brief của Organizer, cấu hình MCP); nếu không muốn commit thì thêm vào `.gitignore` của repo.

## Chọn bộ máy cho Organizer

Chat với Organizer, bấm **Details**, mở tab **Profile**, chọn **Runs on: Claude Code / Codex**.

| | Claude Code | Codex |
|---|---|---|
| Giao việc cho đội | Subagent gốc (Agent tool) | Tool `delegate`. App chạy `claude --agent <id>` cho người nhận |
| Chạy song song | Subagent chạy nền | `delegate(wait=false)` rồi `wait_for_reports` |
| Nhắn cho Organizer khi đang chạy | Tin nhắn được chèn trực tiếp vào phiên | Tin nhắn vào hộp thư, đọc giữa các bước bằng `check_messages` |
| Kế hoạch, đề xuất đội | Tool MCP | Tool MCP, giống hệt |

Đổi bộ máy thì model đang chọn trở về mặc định của bộ máy mới. Tool của server MCP `agent-company` được tự động duyệt khi Codex chạy không tương tác.

## Kế hoạch & tiến độ

- Trước khi giao việc, Organizer lập kế hoạch cho project bằng `set_plan` (milestone M1… và task T1… có người phụ trách) và cập nhật bằng `update_task`.
- Mỗi lần giao việc có mã task, ví dụ `[T3] …`. App tự chuyển task sang **doing** khi giao và sang **done** khi người làm thật sự xong (kể cả subagent chạy nền).
- Viên tiến độ cạnh tên project (ví dụ `62% · 5/8`): bấm vào để xem kế hoạch chi tiết.
- Một agent có thể làm nhiều việc song song; thẻ hiện **×N**. Mặc định tối đa 2 việc song song mỗi agent.

## Portfolio & trang Project

- **Project / All projects** trên header dùng để chuyển giữa khung project và màn hình Portfolio.
- **Portfolio**: mỗi project là một thẻ gồm % tiến độ, milestone hiện tại, ai đang làm, việc tiếp theo, lần cập nhật cuối và chi phí. Project **cần bạn** luôn nằm đầu.
  - "Cần bạn" gồm: đề xuất chờ duyệt, câu hỏi agent hỏi bạn qua `message_owner` mà bạn chưa trả lời, task bị chặn.
- **Assign to several projects**: viết yêu cầu cho từng project, bấm một lần là các project cùng chạy song song.
- **Trang Project**: thanh **Now** (ai đang làm gì), tab **Plan**, tab **Activity** (gom theo task), tab **Changes** (`git status` / `git diff` chỉ đọc, ai sửa file nào thuộc task nào).
- Project đang chọn được lưu **riêng ở từng trình duyệt**.

## Tận dụng cấu hình sẵn có của repo

- App quét `CLAUDE.md`, `AGENTS.md`, `.claude/agents`, `.claude/skills`, `.claude/commands`, `.mcp.json` và lộ trình như `docs/journey.md`.
- Organizer được báo về luật trong `CLAUDE.md`, các skill và lộ trình của repo, và bám theo lộ trình đó khi lập kế hoạch. Codex được chèn nội dung `CLAUDE.md` vào prompt, và `.mcp.json` của repo được nạp.

## Gọi agent bằng @

| Tình huống | Điều gì xảy ra |
|---|---|
| Organizer đang chạy một task | Tin nhắn được đưa thẳng vào phiên đang chạy (`--input-format stream-json`) |
| Agent đang bận trong task | Tin nhắn vào hộp thư; agent đọc giữa các bước bằng `check_messages` |
| Agent đang rảnh | Mở phiên 1:1 riêng (`claude --agent <id>` / `codex exec`) và nối tiếp phiên cũ để nhớ ngữ cảnh |
| Agent cần hỏi bạn | Agent gọi `message_owner`, câu hỏi hiện trong khung chat |

Nút **Clear** xoá cả khung chat của project đang chọn (với Organizer và mọi agent đã được gọi), kể cả phiên đã lưu, để agent bắt đầu lại.

## Cách hoạt động

```
org.yaml (owner, Organizer, projects) ──compile──► <project>/
                                                   ├─ .agent-company/ceo-prompt.md, mcp.json
                                                   └─ CLAUDE.md / AGENTS.md (chỉ khi repo chưa có)
<project>/.claude/agents/*.md  ◄── đội của project (của bạn + do app ghi sau khi duyệt)

Assign ─► Organizer (claude -p | codex exec) ─┬─ Agent tool / delegate ─► agent của project
                                              └─ MCP "agent-company" ─► server ─┬─ propose_team / hire / dismiss ─► Approvals ─► .claude/agents/
                                                                                ├─ get_plan / set_plan / update_task ─► data/plans
                                                                                └─ check_messages / message_owner ─► chat
mọi bước ─► event bus (data/events.jsonl) ─► SSE ─► sơ đồ, Activity, chat
```


## Tuỳ chỉnh tay trong `org.yaml`

| Muốn… | Sửa |
|---|---|
| Đổi model của Organizer | `model: opus / sonnet / haiku` (Claude) hoặc tên model của Codex |
| Giới hạn quyền | `permissions.allow`, `permissions.mode` |
| Luật chung | `company.rules` |
| Danh sách project | `company.projects` (`id`, `name`, `path`) và `company.activeProject` |

Model, tool và hướng dẫn của từng agent trong đội thì sửa ngay trong file `.claude/agents/<id>.md` của repo.

Biến môi trường: `PORT`, `AGENT_COMPANY_CLAUDE_BIN`, `AGENT_COMPANY_CODEX_BIN`. Mặc định app tự tìm trong PATH; với Codex, app còn tìm thêm trong extension VS Code.

## An toàn

- Server chỉ lắng nghe trên `127.0.0.1`, và mọi request ghi dữ liệu bắt buộc có header `x-agent-company`.
- App không đọc token; việc xác thực do chính các CLI đảm nhận.
- Mọi thay đổi đội do agent đề xuất đều cần bạn duyệt, trừ khi bạn bật tự động duyệt. App không bao giờ ghi đè hay xoá file agent bạn tự viết.
- Agent Claude chạy với `permissions.mode` (mặc định `acceptEdits`) và một allowlist lệnh Bash. Codex chạy trong sandbox.
