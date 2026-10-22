# Agent Trace

Extension VS Code giúp **nhìn thấy Claude Code đang làm gì, theo thời gian thực**: prompt của bạn, agent chính, các agent phụ nó tạo ra, từng lần gọi tool, những file nó sửa và kết quả cuối cùng. Extension chỉ quan sát: không chạy agent, không có khung chat, không cần cấu hình. Bạn vẫn dùng Claude Code như bình thường (extension Claude Code hoặc terminal).

## Cách hoạt động

Claude Code tự ghi nhật ký mỗi phiên vào `~/.claude/projects/<folder>/<session>.jsonl`, và mỗi agent phụ vào `<session>/subagents/agent-*.jsonl` (kèm `.meta.json` cho biết lời gọi Agent nào đã tạo ra nó). Agent Trace đọc phần mới ghi thêm của các file đó khoảng 0,7 giây một lần và vẽ lại lượt (turn) hiện tại. Không có gì được gửi ra ngoài máy.

Định dạng nhật ký không phải API công khai của Claude Code. Toàn bộ phần đọc nằm trong [src/claude.ts](src/claude.ts); dòng nào lạ sẽ bị bỏ qua chứ không làm hỏng màn hình.

## Trong VS Code

- **Tab Flow** (`Agent Trace: Open Flow`, hoặc bấm thanh trạng thái), từ trái sang phải:
  - **Setup**: mọi thứ Claude Code nạp khi chạy trong folder này — CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins, settings — ghi rõ nguồn (`project` = `.claude/` của folder, `local` = không vào git, `user` = `~/.claude`, hoặc tên plugin). Mục nào đang được dùng trong lượt hiện tại thì sáng lên và có mũi tên nối tới agent hoặc lệnh đang dùng nó; bấm vào để xem chi tiết và mở file định nghĩa;
  - prompt của bạn, và slash command nếu có;
  - agent chính, kèm bước nó đang làm;
  - các agent phụ (Explore, general-purpose, agent trong `.claude/agents`…) và 8 lần gọi tool gần nhất;
  - output: câu trả lời cuối, báo cáo của từng agent phụ, danh sách file đã sửa (bấm vào để mở diff).
- **Khung viền** chia riêng từng phần: Setup, prompt và slash command, agent chính, agent phụ, tool, output. Khung nào có việc đang chạy thì sáng lên; mục không dùng trong lượt này thì mờ đi.
- **Khi Claude cần bạn** (xin quyền chạy tool, hỏi lại, chờ duyệt plan): thanh Now chuyển sang "Needs you" kèm nội dung, header và thanh trạng thái màu vàng, thẻ và tool đang chờ sáng vàng, sidebar có chuông. Kèm một thông báo mỗi lần chờ (tắt bằng `agentTrace.notifyWhenWaiting`). Tín hiệu lấy từ trạng thái phiên do chính Claude Code ghi (`~/.claude/sessions`), không cài thêm gì.
- **Setup đúng như Claude Code đã nạp**: Agent Trace đối chiếu với danh sách Claude Code tự ghi trong nhật ký phiên (skill, agent, MCP và trạng thái kết nối, file hướng dẫn), nên đúng với mọi kiểu cấu hình. Thứ có trong folder nhưng không được nạp nằm ở thẻ **Here, not loaded**, kèm lý do và cách xử lý. Khi folder chưa có phiên nào, Setup đọc từ file và ghi rõ như vậy.
- **Hoà vào VS Code**: nền, thẻ, viền và chữ lấy theo theme màu của bạn (sáng, tối hay tương phản cao). Màu chủ đạo mặc định cũng theo theme; hoặc chọn vàng, cam đất, xanh biển, xanh ngọc, tím, hồng bằng các chấm màu trên header hay setting `agentTrace.accentColor`.
- **Thanh Now** ở trên cùng cho thấy luồng đang đi đâu, ví dụ `/ship (project command) → Claude → code-reviewer (project agent) → Grep TODO`; bấm vào từng bước để xem chi tiết.
- Mũi tên từ Setup xuất phát đúng từ agent, command, skill hay MCP server đang được dùng. Khi Claude đang chạy, phần ngoài luồng hiện tại mờ đi; rê chuột lên một thẻ để xem luồng đi qua nó.
- Mũi tên tới việc đang chạy sáng lên, có "sao chổi" chạy dọc theo, cho đến khi việc đó xong.
- Bấm vào bất kỳ ô nào để xem chi tiết ở bên phải: đầu vào và kết quả của tool, prompt giao cho agent phụ, báo cáo đầy đủ.
- **Sidebar Agent Trace › Setup (.claude)**: cùng danh sách cấu hình đó dạng cây, bấm để mở file.
- **Sidebar Agent Trace › Active Sessions**: chỉ các phiên Claude Code đang chạy trong folder này (Claude đang làm, hoặc còn agent phụ chạy nền). Phiên cũ chọn trong danh sách phiên ở tab Flow. Mặc định tab Flow đi theo phiên mới nhất; nút ghim để quay lại chế độ đi theo.
- **Thanh trạng thái**: ví dụ `Claude · Bash npm test · 2 subagents` khi đang chạy.
- **Explorer**: file Claude đang sửa trong lượt hiện tại có chấm ●.

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
| `src/` | Phần chạy trong VS Code: đọc nhật ký (`claude.ts`), đọc cấu hình `.claude` (`setup.ts`), tab Flow, sidebar, thanh trạng thái, đánh dấu file (`extension.ts`) |
| `shared/` | Kiểu dữ liệu chung giữa extension và giao diện (`model.ts`) |
| `web/` | Giao diện tab Flow (React + React Flow), build bằng Vite vào `out/webview` |
| `media/` | Icon |

## Lộ trình

- Timeline: mỗi agent một làn theo thời gian, kéo để xem lại phiên cũ.
- Hỗ trợ Codex (`~/.codex/sessions`).
- Tuỳ chọn dùng hook của Claude Code để có tín hiệu chính xác hơn.
