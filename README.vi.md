# Agent Trace

**Chat với Claude Code và Codex ngay trong VS Code, và xem chúng làm việc theo thời gian thực.** Hỏi một agent, agent kia, hoặc cả hai. Cho chúng giao việc cho nhau. Mỗi lượt được vẽ thành một luồng: prompt của bạn, từng agent, các agent phụ nó tạo ra, từng lần gọi tool, những file nó sửa và câu trả lời, đặt cạnh cấu hình mà mỗi agent đã nạp (**Claude factory** và **Codex factory**).

Agent Trace chạy **chính** Claude Code và Codex của bạn: CLI bạn đã cài và đăng nhập, với settings, hướng dẫn, skills và MCP servers của bạn. Nó không đăng nhập thay bạn, không đọc token, không kèm agent riêng.

> English: [README.md](README.md)

- [Có gì](#có-gì)
- [Cài đặt](#cài-đặt): Agent Trace, Claude Code, Codex
- [Cách dùng](#cách-dùng)
- [Cấu hình Claude Code và Codex](#cấu-hình-claude-code-và-codex)
- [Quyền](#quyền)
- [Settings](#settings)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Cách hoạt động và dữ liệu của bạn](#cách-hoạt-động-và-dữ-liệu-của-bạn)

## Có gì

- **Một khung chat, hai agent.** Trên ô nhập, **Send to** chọn người nhận cho từng tin nhắn: Claude, Codex hoặc Both. Gửi cho cả hai thì Codex sửa code, Claude xem và nhận xét. Mỗi dòng trong chat có nhãn của agent.
- **Hand-over (giao việc).** Bật lên thì Claude có thể giao việc cho Codex (`ask_codex`) và Codex giao cho Claude (`ask_claude`), chỉ một bước. Việc được giao và câu trả lời hiện trong chat, và trên flow là một đường nối giữa hai agent.
- **Flow trực tiếp, mỗi agent một làn.** Claude ở trên, Codex ở dưới, mỗi làn có tool, agent phụ và câu trả lời riêng. Thanh **Now** cho biết công việc đang đi đâu, ví dụ `Claude → code-reviewer → Grep TODO`.
- **Các factory:** những gì mỗi agent nạp trong folder này, đúng như nó đã nạp: CLAUDE.md hoặc AGENTS.md, agents, slash commands, skills, MCP servers (kèm trạng thái kết nối), hooks, plugins và settings. Mục nào đang dùng thì sáng lên. Thu gọn cả factory hoặc từng nhóm.
- **Trả lời agent ngay tại chỗ:** quyền (Allow, Always allow, Deny), câu hỏi và plan, trong chat hoặc ngay trên thẻ tool đang chờ.
- **MCP servers đúng như hiện tại:** đã kết nối (kèm số tool), lỗi (kèm lý do), chờ đăng nhập. Kiểm tra lại hoặc kết nối lại mà không cần gửi tin nhắn.
- **Các phiên của bạn:** mọi phiên Claude Code và thread Codex của folder, trong sidebar. Tiếp tục ở đây, hoặc vẫn dùng agent ở terminal hay extension riêng của chúng: các phiên đó cũng hiện lên flow.

## Cài đặt

Bạn cần **VS Code 1.100 trở lên** (Cursor, Windsurf và các editor dựa trên VS Code cũng được) và **ít nhất một** trong hai: Claude Code hoặc Codex. Cài cả hai để chat với cả hai.

### 1. Cài Agent Trace

Tìm **Agent Trace** trong mục Extensions (publisher `dannytv0307`) và cài. Biểu tượng **Agent Trace** sẽ hiện ở thanh hoạt động bên trái.

### 2. Cài Claude Code và đăng nhập

Chạy một trong các lệnh sau trong terminal:

| Hệ điều hành | Lệnh |
|---|---|
| macOS, Linux, WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Bất kỳ, có Node.js 18+ | `npm install -g @anthropic-ai/claude-code` |

Sau đó đăng nhập một lần: chạy `claude`, gõ `/login` và làm theo hướng dẫn (gói Claude hoặc tài khoản Anthropic Console). Kiểm tra bằng `claude --version`.

### 3. Cài Codex và đăng nhập

| Hệ điều hành | Lệnh |
|---|---|
| Bất kỳ, có Node.js | `npm install -g @openai/codex` |
| macOS (Homebrew) | `brew install --cask codex` |

Sau đó đăng nhập một lần: chạy `codex` và làm theo hướng dẫn (tài khoản ChatGPT hoặc API key). Kiểm tra bằng `codex --version`.

### 4. Mở Agent Trace

Mở một folder, rồi bấm biểu tượng Agent Trace, mục **Agent Trace** trên thanh trạng thái, hoặc chạy **Agent Trace: Open** trong Command Palette.

- Vừa cài agent khi VS Code đang mở? Chạy **Agent Trace: Find Claude Code and Codex**, hoặc reload cửa sổ.
- Agent nào Agent Trace không tìm thấy sẽ có link **Set up …** cạnh **Send to**: bấm vào để biết thiếu gì và cần làm gì.
- Cài ở chỗ khác thường? Đặt đường dẫn: `agentTrace.claudePath` hoặc `agentTrace.codexPath` (xem [Settings](#settings)).

## Cách dùng

### Khung chat

- **Send to:** Claude, Codex hoặc Both. **Hand-over** (mặc định bật) cho phép agent bạn đang nhắn giao việc cho agent kia khi cần.
- **Model, effort và mode** nằm dưới ô nhập, áp dụng cho agent bạn đang nhắn (khi chọn Both, công tắc nhỏ C/X chọn đang chỉnh cho ai). Để trống thì theo settings của bạn. Lựa chọn được nhớ cho chat sau.
- **`/`** liệt kê slash commands của Claude Code (của bạn, của project, có sẵn, skills, plugins), hoặc skills của Codex (chèn `$skill`).
- **Stop** dừng lượt đang chạy. **＋** mở chat mới. Kéo mép phải khung chat để chỉnh độ rộng; gập lại bằng **‹**.

### Flow

- Từ trái sang phải: các factory, prompt của bạn, các agent (mỗi agent một làn), tool và agent phụ của chúng, và kết quả.
- Bấm vào thẻ bất kỳ để xem chi tiết: đầu vào và kết quả của tool, việc và báo cáo của agent phụ, một mục cấu hình và file của nó. Bấm vào file đã sửa để mở diff.
- Rê chuột lên một thẻ để xem luồng đi qua nó. Tin nhắn mới làm flow bắt đầu lại; agent phụ còn đang chạy được giữ, có nhãn *earlier*.

### Sidebar

- **Sessions:** các phiên Claude Code và thread Codex của folder. Mở một phiên để xem flow và chat tiếp. Xoá phiên Claude (vào thùng rác) hoặc lưu trữ thread Codex (Codex khôi phục lại được).
- **Claude Factory** và **Codex Factory:** cấu hình dạng cây; bấm vào một mục để mở file.

## Cấu hình Claude Code và Codex

Agent Trace khởi động mỗi agent đúng như CLI sẽ làm trong folder của bạn, nên mọi thứ dưới đây chạy giống hệt ở terminal, trong extension riêng của agent, và ở đây. Thay đổi có hiệu lực từ chat mới (＋).

### Claude Code

| Thứ gì | Project (dùng chung qua git) | Project, chỉ bạn | Bạn, mọi project |
|---|---|---|---|
| Hướng dẫn | `CLAUDE.md` | | `~/.claude/CLAUDE.md` |
| Settings và quyền | `.claude/settings.json` | `.claude/settings.local.json` | `~/.claude/settings.json` |
| Agent phụ | `.claude/agents/*.md` | | `~/.claude/agents/*.md` |
| Slash commands | `.claude/commands/*.md` | | `~/.claude/commands/*.md` |
| Skills | `.claude/skills/<tên>/SKILL.md` | | `~/.claude/skills/<tên>/SKILL.md` |
| MCP servers | `.mcp.json` (hỏi bạn duyệt một lần) | | `claude mcp add …` |

Ví dụ một file settings có quyền, `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read(./src/**)"],
    "deny": ["Read(./.env)", "Bash(rm -rf:*)"],
    "defaultMode": "acceptEdits"
  }
}
```

### Codex

| Thứ gì | Ở đâu |
|---|---|
| Hướng dẫn | `AGENTS.md` ở gốc repo (và trong thư mục con), `~/.codex/AGENTS.md` cho riêng bạn |
| Settings | `~/.codex/config.toml`; `.codex/config.toml` của project chỉ được dùng khi bạn đã tin cậy (trust) project đó |
| Skills | `~/.agents/skills/<tên>/SKILL.md` cho bạn, `.agents/skills/<tên>/SKILL.md` trong repo |
| MCP servers | `[mcp_servers.<tên>]` trong `config.toml` |

Ví dụ `~/.codex/config.toml`:

```toml
model = "…"                       # một model tài khoản của bạn có
model_reasoning_effort = "medium"
approval_policy = "on-request"    # hỏi khi cần nhiều hơn sandbox cho phép
sandbox_mode = "workspace-write"  # sửa file và chạy lệnh trong project

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_TOKEN"
```

Các factory hiện đúng những gì mỗi agent đã nạp, kèm nguồn (`project`, `local`, `user`, plugin, có sẵn). Thứ có trong folder nhưng không được nạp nằm ở **Here, not loaded**, kèm lý do.

## Quyền

Mỗi agent tự quyết quyền theo settings của chính nó. Agent Trace chỉ hiện cho bạn những gì agent hỏi.

- **Claude Code:** rule `deny` luôn thắng, kể cả ở mode Bypass; rule `allow` chạy không hỏi; còn lại thì hỏi bạn. **Always allow** thêm rule mà Claude Code đề xuất, giống "đừng hỏi lại" ở terminal (mờ đi kèm lý do khi Claude Code không đề xuất được).
- **Codex:** `approval_policy` và `sandbox_mode` quyết định. **Always allow** có hiệu lực trong phiên đó.
- **Mode** chọn trong chat thay cho mặc định của bạn trong chat đó:

| Claude Code | | Codex | |
|---|---|---|---|
| Ask first | hỏi trước khi sửa và chạy lệnh | Read only | chỉ đọc; hỏi trước khi thay đổi |
| Accept edits | sửa không hỏi, chạy lệnh thì hỏi | Auto | sửa và chạy lệnh trong project; cần thêm thì hỏi |
| Plan | đọc và lập kế hoạch, rồi xin bạn duyệt | Full access | không sandbox, không hỏi |
| Auto | bộ phân loại tự duyệt thao tác an toàn, hỏi phần còn lại | | |
| Bypass | không hỏi gì (chỉ dùng trong sandbox bạn tin) | | |

- Tool **giao việc** chạy không hỏi, vì bạn đã bật hand-over. Những gì agent kia cần sau đó vẫn hỏi bạn.
- Với **Both**, Claude được dặn chỉ xem và nhận xét; đây là lời dặn, không phải khoá. Chọn Plan cho Claude nếu nó tuyệt đối không được sửa.

## Settings

| Setting | Tác dụng |
|---|---|
| `agentTrace.claudePath` | Đường dẫn tới `claude` nếu Agent Trace không tự tìm thấy. Ví dụ `C:\Users\ban\.local\bin\claude.exe`, `/opt/homebrew/bin/claude`. |
| `agentTrace.codexPath` | Đường dẫn tới `codex` nếu Agent Trace không tự tìm thấy. Ví dụ `/usr/local/bin/codex`; trên Windows là file `codex.exe` mà npm đã cài, hoặc để trống. |
| `agentTrace.notifyWhenWaiting` | Thông báo khi agent chờ bạn mà tab đang khuất. Mặc định bật. |
| `agentTrace.accentColor` | Màu của việc đang chạy: theo theme, hoặc vàng, cam đất, xanh biển, xanh ngọc, tím, hồng. |

Lệnh: **Agent Trace: Open**, **New Chat**, **Find Claude Code and Codex**.

## Xử lý sự cố

**Codex (hoặc Claude) không hiện, hoặc nút bị mờ.** Agent Trace không tìm thấy nó. Bấm **Set up …** cạnh **Send to** để xem lý do. Cài nó ([Cài đặt](#cài-đặt)), chạy một lần trong terminal để đăng nhập, rồi chạy **Agent Trace: Find Claude Code and Codex**. Trên macOS, VS Code mở từ Dock có thể không thấy PATH của terminal: Agent Trace có hỏi login shell và tìm ở các chỗ thường gặp, nhưng nếu vẫn sót thì đặt `agentTrace.codexPath` / `agentTrace.claudePath` bằng kết quả của `which codex` / `which claude`.

**Báo chưa đăng nhập.** Chạy `claude` rồi `/login`, hoặc chạy `codex` và đăng nhập, trong terminal. Sau đó mở chat mới.

**Model bị từ chối (lỗi 400).** Model trong settings của bạn không dùng được với tài khoản. Chọn model khác trong menu model của chat, hoặc sửa `model` trong config.

**MCP server cần đăng nhập hoặc bị lỗi.** Mở thẻ MCP servers để xem lỗi. Đăng nhập từ terminal (Claude Code: `claude` rồi `/mcp`; Codex: `codex mcp login <tên>`), rồi bấm **Reconnect**. Server của project trong `.mcp.json` chờ bạn duyệt: chạy `claude` trong folder một lần và duyệt.

**"This session is running in another window".** Phiên đang chạy ở terminal hoặc panel riêng của agent. Đợi nó xong, hoặc mở chat mới.

**Hỏi quyền nhiều hơn khi dùng Claude Code trực tiếp.** Có thể bạn dùng mode khác ở đó (ví dụ Auto). Chọn cùng mode trong chat: lựa chọn sẽ được nhớ.

## Cách hoạt động và dữ liệu của bạn

- **Claude Code** chạy qua Claude Agent SDK, cùng kênh mà extension VS Code của Claude Code dùng. **Codex** chạy qua `codex app-server`, kênh mà extension VS Code của Codex dùng. Phiên vẫn là phiên bình thường: tiếp tục bằng `/resume` trong Claude Code, hoặc trong danh sách của Codex.
- Flow được vẽ từ chính bản ghi của mỗi agent: nhật ký của Claude Code trong `~/.claude/projects/` và thread của Codex. Agent Trace chỉ đọc những gì nó vẽ; không bao giờ đọc giá trị biến môi trường, header hay tham số của MCP.
- Bản thân Agent Trace không gửi gì ra ngoài. Những gì bạn gõ đi tới Claude Code và Codex của bạn, và chúng làm việc với Anthropic và OpenAI như mọi khi.
- Mỗi agent được cho biết nó đang chạy trong Agent Trace, và tool giao việc là gì.

## Build từ mã nguồn

```
npm install
npm run package          # → agent-trace.vsix
code --install-extension agent-trace.vsix
```

`npm run typecheck` kiểm tra phần extension (`src/`) và giao diện (`web/`, `shared/`).

---

Agent Trace là dự án độc lập, không liên kết hay được Anthropic hoặc OpenAI bảo trợ. Claude và Claude Code là nhãn hiệu của Anthropic. Codex là sản phẩm của OpenAI.
