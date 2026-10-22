# Agent Flow

Extension VS Code giúp **nhìn thấy Claude Code đang làm gì, theo thời gian thực**: prompt của bạn, agent chính, các agent phụ nó tạo ra, từng lần gọi tool, những file nó sửa và kết quả cuối cùng. Extension chỉ quan sát: không chạy agent, không có khung chat, không cần cấu hình. Bạn vẫn dùng Claude Code như bình thường (extension Claude Code hoặc terminal).

## Cách hoạt động

Claude Code tự ghi nhật ký mỗi phiên vào `~/.claude/projects/<folder>/<session>.jsonl`, và mỗi agent phụ vào `<session>/subagents/agent-*.jsonl` (kèm `.meta.json` cho biết lời gọi Agent nào đã tạo ra nó). Agent Flow đọc phần mới ghi thêm của các file đó khoảng 0,7 giây một lần và vẽ lại lượt (turn) hiện tại. Không có gì được gửi ra ngoài máy.

Định dạng nhật ký không phải API công khai của Claude Code. Toàn bộ phần đọc nằm trong [src/claude.ts](src/claude.ts); dòng nào lạ sẽ bị bỏ qua chứ không làm hỏng màn hình.

## Trong VS Code

- **Tab Flow** (`Agent Flow: Open Flow`, hoặc bấm thanh trạng thái), từ trái sang phải:
  - **Setup**: mọi thứ Claude Code nạp khi chạy trong folder này — CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins, settings — ghi rõ nguồn (`project` = `.claude/` của folder, `local` = không vào git, `user` = `~/.claude`, hoặc tên plugin). Mục nào đang được dùng trong lượt hiện tại thì sáng lên và có mũi tên nối tới agent hoặc lệnh đang dùng nó; bấm vào để xem chi tiết và mở file định nghĩa;
  - prompt của bạn, và slash command nếu có;
  - agent chính, kèm bước nó đang làm;
  - các agent phụ (Explore, general-purpose, agent trong `.claude/agents`…) và 8 lần gọi tool gần nhất;
  - output: câu trả lời cuối, báo cáo của từng agent phụ, danh sách file đã sửa (bấm vào để mở diff).
- Mũi tên tới việc đang chạy sáng lên, có "sao chổi" chạy dọc theo, cho đến khi việc đó xong.
- Bấm vào bất kỳ ô nào để xem chi tiết ở bên phải: đầu vào và kết quả của tool, prompt giao cho agent phụ, báo cáo đầy đủ.
- **Sidebar Agent Flow › Setup (.claude)**: cùng danh sách cấu hình đó dạng cây, bấm để mở file.
- **Sidebar Agent Flow**: các phiên Claude Code của folder đang mở. Mặc định tab Flow đi theo phiên mới nhất; bấm vào một phiên để xem phiên đó, nút ghim để quay lại chế độ đi theo.
- **Thanh trạng thái**: ví dụ `Claude · Bash npm test · 2 subagents` khi đang chạy.
- **Explorer**: file Claude đang sửa trong lượt hiện tại có chấm ●.

## Build và cài

```
npm install
npm run package                      # → agent-flow.vsix
code --install-extension agent-flow.vsix
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
