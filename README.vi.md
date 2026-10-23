# Agent Trace

Extension VS Code để **chat với Claude Code hoặc Codex và xem nó làm việc, theo thời gian thực**: prompt của bạn, agent chính, các agent phụ nó tạo ra, từng lần gọi tool, những file nó sửa và kết quả cuối cùng, vẽ thành một luồng cạnh cấu hình của bạn.

Khung chat chạy **chính Claude Code hoặc Codex của bạn** (CLI bạn đã cài và đăng nhập), với settings, hướng dẫn, skills và MCP servers của bạn. Bạn vẫn có thể dùng chúng như bình thường (extension riêng hoặc terminal): các phiên đó cũng hiện lên flow.

**Claude, Codex hay cả hai:** trên ô nhập, **Send to** chọn người nhận cho từng tin nhắn. Gửi cho cả hai thì Codex sửa code, Claude xem và nhận xét. Bật **Hand-over** thì agent này giao việc được cho agent kia (Claude có `ask_codex`, Codex có `ask_claude`, chỉ một bước): việc giao, câu trả lời và quyền mà agent kia cần đều hiện trong chat và trên flow, flow có một làn cho mỗi agent (Claude ở trên, Codex ở dưới). Flow, danh sách phiên và khung cấu hình đi theo chat: **Claude factory** (CLAUDE.md, agents, slash commands, skills, MCP, hooks, plugins, settings) hoặc **Codex factory** (AGENTS.md, skills, MCP servers kèm trạng thái kết nối, plugins, hooks, các file config user/project/managed — đúng như Codex tự báo). Với Codex, gõ `/` để chọn skill (chèn `$skill`), còn ô mode là các mức duyệt của Codex: Read only, Auto, Full access.

## Chạy Claude thế nào

Khung chat chạy CLI `claude` của bạn qua Claude Agent SDK, trên cùng kênh stream-json mà extension VS Code của Claude Code dùng. Agent Trace không đăng nhập, không đọc token, không kèm CLI riêng. Nếu `claude` không có trong PATH, đặt setting `agentTrace.claudePath`. Phiên là phiên Claude Code bình thường: tiếp tục được bằng `/resume` trong terminal hay trong extension Claude Code, và ngược lại.

Với Codex, khung chat chạy CLI `codex` của bạn qua `codex app-server`, cùng kênh mà extension VS Code của Codex dùng: cùng đăng nhập, config, thread và cách duyệt. Thread vẫn là thread Codex bình thường. Nếu `codex` không có trong PATH, đặt setting `agentTrace.codexPath`.

## Cách hoạt động

Claude Code tự ghi nhật ký mỗi phiên vào `~/.claude/projects/<folder>/<session>.jsonl`, và mỗi agent phụ vào `<session>/subagents/agent-*.jsonl` (kèm `.meta.json` cho biết lời gọi Agent nào đã tạo ra nó). Agent Trace đọc phần mới ghi thêm của các file đó khoảng 0,7 giây một lần và vẽ lại lượt (turn) hiện tại. Bản thân Agent Trace không gửi gì ra ngoài: nội dung bạn gõ vào chat đi tới CLI Claude Code của bạn, và CLI làm việc với Anthropic như mọi khi.

Định dạng nhật ký không phải API công khai của Claude Code. Toàn bộ phần đọc nằm trong [src/claude.ts](src/claude.ts); dòng nào lạ sẽ bị bỏ qua chứ không làm hỏng màn hình.

## Trong VS Code

- **Khung chat**: ngăn kéo bên trái tab Agent Trace, gập lại được; kéo mép phải để chỉnh độ rộng (bấm đúp vào mép để về độ rộng mặc định):
  - câu trả lời hiện dần; lần gọi tool hiện thành một dòng (chi tiết xem trên flow);
  - nút **Stop** dừng lượt đang chạy;
  - gõ `/` để chọn slash command (của Claude Code, của bạn, của project, skill, plugin);
  - chọn model và permission mode như trong Claude Code; effort chỉnh bằng thanh trượt (kéo, bấm vào một mức, hoặc dùng phím mũi tên); để trống thì theo settings Claude Code của bạn.
- **MCP servers đúng như hiện tại**: bấm thẻ MCP servers. Khi Claude Code đang chạy ở đây, trạng thái lấy trực tiếp từ nó (đã kết nối kèm số tool, lỗi kèm lý do, cần đăng nhập, bị tắt) và tự cập nhật trong lúc chạy. **Check now** hỏi Claude Code mà không gửi tin nhắn nào; **Reconnect** kết nối lại một server lỗi, hoặc tất cả server lỗi cùng lúc. Server cần đăng nhập thì đăng nhập bằng `/mcp` trong Claude Code ở terminal, rồi bấm Reconnect ở đây.
- **Trả lời Claude ngay trong chat hoặc trên flow**: xin quyền chạy tool (Allow, Always allow, Deny, bấm được ngay trên thẻ tool đang chờ), câu hỏi (chọn đáp án hoặc tự gõ), plan (duyệt hoặc bảo lập tiếp).
- **Flow** (`Agent Trace: Open`, hoặc bấm thanh trạng thái), từ trái sang phải:
  - **Claude factory**: mọi thứ Claude Code nạp khi chạy trong folder này — CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins, settings — ghi rõ nguồn (`project` = `.claude/` của folder, `local` = không vào git, `user` = `~/.claude`, hoặc tên plugin). Mục nào đang được dùng trong lượt hiện tại thì sáng lên và có mũi tên nối tới agent hoặc lệnh đang dùng nó; bấm vào để xem chi tiết và mở file định nghĩa. Bấm tiêu đề để thu cả khung thành một tab; bấm mũi tên cạnh từng nhóm (agents, slash commands, skills…) để thu nhóm đó lại;
  - prompt của bạn, và slash command nếu có;
  - agent chính, kèm bước nó đang làm;
  - các agent phụ (Explore, general-purpose, agent trong `.claude/agents`…) và 8 lần gọi tool gần nhất;
  - output: câu trả lời cuối, báo cáo của từng agent phụ, danh sách file đã sửa (bấm vào để mở diff).
- **Khung viền** chia riêng từng phần, mép trên thẳng hàng: Claude factory, prompt và slash command, agent chính, agent phụ, tool, output. Khung nào có việc đang chạy thì sáng lên; mục không dùng trong lượt này thì mờ đi.
- **Khi Claude cần bạn** (xin quyền chạy tool, hỏi lại, chờ duyệt plan): thanh Now chuyển sang "Needs you" kèm nội dung, header và thanh trạng thái màu vàng, thẻ và tool đang chờ sáng vàng, sidebar có chuông. Kèm một thông báo mỗi lần chờ khi tab đang khuất (tắt bằng `agentTrace.notifyWhenWaiting`). Tín hiệu lấy từ trạng thái phiên do chính Claude Code ghi (`~/.claude/sessions`), không cài thêm gì.
- **Setup đúng như Claude Code đã nạp**: Agent Trace đối chiếu với danh sách Claude Code tự ghi trong nhật ký phiên (skill, agent, MCP và trạng thái kết nối, file hướng dẫn), nên đúng với mọi kiểu cấu hình. Thứ có trong folder nhưng không được nạp nằm ở thẻ **Here, not loaded**, kèm lý do và cách xử lý. Khi folder chưa có phiên nào, Setup đọc từ file và ghi rõ như vậy.
- **Hoà vào VS Code**: nền, thẻ, viền và chữ lấy theo theme màu của bạn (sáng, tối hay tương phản cao). Màu chủ đạo mặc định cũng theo theme; hoặc chọn vàng, cam đất, xanh biển, xanh ngọc, tím, hồng bằng các chấm màu trên header hay setting `agentTrace.accentColor`.
- **Thanh Now** ở trên cùng cho thấy luồng đang đi đâu, ví dụ `/ship (project command) → Claude → code-reviewer (project agent) → Grep TODO`; bấm vào từng bước để xem chi tiết.
- Mũi tên từ Setup xuất phát đúng từ agent, command, skill hay MCP server đang được dùng. Khi Claude đang chạy, phần ngoài luồng hiện tại mờ đi; rê chuột lên một thẻ để xem luồng đi qua nó.
- Mũi tên tới việc đang chạy sáng lên, có "sao chổi" chạy dọc theo, cho đến khi việc đó xong.
- Bấm vào bất kỳ ô nào để xem chi tiết ở bên phải: đầu vào và kết quả của tool, prompt giao cho agent phụ, báo cáo đầy đủ.
- **Sidebar Agent Trace › Claude Factory**: cùng danh sách cấu hình đó (Claude factory) dạng cây, bấm để mở file.
- **Sidebar Agent Trace › Sessions**: các phiên Claude Code của folder này, phiên đang chạy hay đang chờ bạn được đánh dấu. Bấm để mở flow và chat tiếp; nút thùng rác xoá phiên (vào thùng rác, khôi phục được). Mở tab khi Claude Code đang chạy ở cửa sổ khác thì tab hiện luôn phiên đó.
- **Thanh trạng thái**: ví dụ `Claude · Bash npm test · 2 subagents` khi đang chạy.
- **Explorer**: file Claude đang sửa trong lượt hiện tại có chấm ●.

## Yêu cầu

- VS Code 1.100 trở lên (Cursor, Windsurf, Antigravity… cũng được).
- Claude Code đã cài và đăng nhập: chạy `claude` một lần trong terminal, rồi `/login`.

## Build và cài

```
npm install
npm run package                      # → agent-trace.vsix
code --install-extension agent-trace.vsix
```

`npm run typecheck` kiểm tra kiểu cho cả phần extension (`src/`) lẫn giao diện (`web/`, `shared/`).

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `src/` | Phần chạy trong VS Code: đọc nhật ký (`claude.ts`), đọc cấu hình `.claude` (`setup.ts`), chạy CLI Claude Code cho khung chat (`chat.ts`), tab, sidebar, thanh trạng thái, đánh dấu file (`extension.ts`) |
| `shared/` | Kiểu dữ liệu chung giữa extension và giao diện (`model.ts`) |
| `web/` | Giao diện tab: chat và flow (React + React Flow), build bằng Vite vào `out/webview` |
| `media/` | Icon |

## Lộ trình

- Timeline: mỗi agent một làn theo thời gian, kéo để xem lại phiên cũ.
- Hỗ trợ Codex (`~/.codex/sessions`).
- Tuỳ chọn dùng hook của Claude Code để có tín hiệu chính xác hơn.
