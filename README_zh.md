# wechat-claude-code

[English](README.md) | **中文**

一个 [Claude Code](https://claude.ai/claude-code) Skill，将个人微信桥接到本地 Claude Code。通过手机微信与 Claude 对话——文字、图片、语音、文件、权限审批、斜杠命令，全部支持。

## 功能清单

### 核心对话

| 功能 | 说明 |
|------|------|
| 文字对话 | 通过微信与 Claude Code 进行多轮文字对话 |
| 图片识别 | 发送图片让 Claude 分析（自动下载、解密、保存为临时文件供 Claude 读取） |
| 语音转文字 | 发送语音消息，自动提取语音转文字结果发给 Claude |
| 文件处理 | 发送文件（PDF、Word、代码等），自动下载解密并保存供 Claude 分析 |
| 引用回复 | 引用消息时自动提取被引用内容作为上下文 |
| 会话持久化 | 跨消息保持上下文，支持 SDK session 恢复 |
| 上下文压缩 | `/compact` 命令开始新 SDK 会话，释放 token 但保留对话历史 |

### 实时交互

| 功能 | 说明 |
|------|------|
| 实时进度推送 | 实时查看 Claude 的工具调用（🔧 Bash、📖 Read、🔍 Glob…） |
| 思考预览 | 每次工具调用前展示 💭 Claude 的推理摘要 |
| 打字指示器 | Claude 思考时发送"正在输入"状态 |
| 中断支持 | 在 Claude 处理中发送新消息可打断当前任务并重定向 |
| 并发保护 | 5 秒宽限期防止误触发中断（如图片处理刚开始时） |

### 权限控制

| 功能 | 说明 |
|------|------|
| 交互式审批 | Claude 请求执行工具时，微信收到权限请求，回复 `y`/`n` 控制 |
| 超时自动拒绝 | 120 秒未回复自动拒绝并通知 |
| 多种权限模式 | `default`（手动审批）、`acceptEdits`（自动批准编辑）、`plan`（只读）、`auto`（全自动） |
| 运行时切换 | `/permission <模式>` 随时切换权限模式 |

### 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话（重新开始） |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/model <名称>` | 切换 Claude 模型（如 sonnet、opus） |
| `/permission <模式>` | 切换权限模式 |
| `/prompt [内容]` | 查看或设置系统提示词（全局生效，如"用中文回答"） |
| `/status` | 查看当前会话状态（模型、工作目录、权限模式等） |
| `/cwd [路径]` | 查看或切换工作目录 |
| `/skills` | 列出已安装的 Claude Code Skill |
| `/history [数量]` | 查看最近 N 条对话记录 |
| `/compact` | 压缩上下文（开始新 SDK 会话，保留历史） |
| `/undo [数量]` | 撤销最近 N 条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

### 服务管理

| 功能 | 说明 |
|------|------|
| 跨平台守护进程 | macOS（launchd）、Linux（systemd + nohup 回退）、Windows（PID 文件 + nohup） |
| 开机自启 | macOS/Linux 支持开机自动启动 |
| 自动重启 | 进程崩溃后自动重启 |
| 日志轮转 | 每日轮转，保留 30 天 |
| 限频保护 | 微信 API 限频时自动指数退避重试 |
| 多账号支持 | 支持绑定多个微信账号 |

### 安全与稳定

| 功能 | 说明 |
|------|------|
| CDN 加密传输 | 图片/文件通过 AES-128-ECB 加密的 CDN 链路传输 |
| 本地数据存储 | 所有数据存储在本地 `~/.wechat-claude-code/`，不经过第三方服务器 |
| 会话状态恢复 | 启动时自动重置残留的 processing 状态，防止卡死 |
| AbortController 生命周期管理 | 重试时创建新的 AbortController，避免复用已取消的控制器 |

---

## 与腾讯官方 openclaw-weixin 插件对比

腾讯官方提供了 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 插件，基于 OpenClaw 插件体系实现微信消息通道。以下是两者的对比：

| 功能 | 本项目 (wechat-claude-code) | 官方 openclaw-weixin |
|------|:---:|:---:|
| **安装方式** | `git clone` + `npm install` | `openclaw plugins install` |
| **依赖** | Claude Code + Agent SDK | OpenClaw（Claude Code 开源版） |
| **对话方式** | 微信直接聊天，手机随时用 | 微信直接聊天，手机随时用 |
| **文字消息** | ✅ | ✅ |
| **图片识别** | ✅ 自动下载解密 + 文件传递给 Claude | ✅ CDN 加密传输 |
| **语音消息** | ✅ 自动语音转文字 | ✅ SILK 编码支持 |
| **文件处理** | ✅ 自动下载解密 | ✅ CDN 加密传输 |
| **视频消息** | ❌ 不支持 | ✅ CDN 加密传输 |
| **引用回复** | ✅ 提取引用内容作为上下文 | ✅ 支持 |
| **打字指示器** | ✅ Claude 思考时显示"正在输入" | ✅ 支持 |
| **实时进度推送** | ✅ 工具调用实时推送到微信 | ❌ 无 |
| **思考预览** | ✅ 推理摘要实时推送 | ❌ 无 |
| **中断/重定向** | ✅ 发消息即可打断当前任务 | ❌ 不支持 |
| **权限审批** | ✅ 微信内交互式审批（y/n） | ❌ 无（依赖 OpenClaw 权限机制） |
| **斜杠命令** | ✅ 14+ 命令（/model /prompt /cwd 等） | ❌ 无 |
| **Skill 触发** | ✅ 微信中触发任意已安装 Skill | ❌ 不支持 |
| **系统提示词** | ✅ `/prompt` 持久化设置 | ❌ 不支持 |
| **会话管理** | ✅ 持久化 + 压缩 + 撤销 + 历史查看 | 依赖 OpenClaw 会话隔离 |
| **多账号** | ✅ 支持 | ✅ 支持 + per-account 会话隔离 |
| **后台运行** | ✅ 守护进程（launchd/systemd/nohup） | ✅ OpenClaw Gateway |
| **跨平台** | ✅ macOS / Linux / Windows | ✅ 跟随 OpenClaw 支持平台 |
| **CDN 图片上传** | ❌ 不支持（仅下载） | ✅ 支持上传图片/视频/文件 |
| **协议** | Claude Code Agent SDK | OpenClaw 插件协议 |

**总结：** 两个项目都实现了"用微信和 Claude 对话"的核心功能。本项目的优势在于丰富的交互体验（实时进度、思考预览、中断重定向、权限审批、斜杠命令、Skill 触发），适合需要精细控制 Claude 工作流的用户；官方插件的优势在于与 OpenClaw 生态深度集成、支持视频消息和 CDN 上传，安装更简单。

---

## 前置条件

- Node.js >= 18
- macOS / Linux / Windows（Git Bash / MSYS2）
- 个人微信账号（需扫码绑定）
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）
  > **注意：** 该 SDK 支持第三方 API 提供商（如 OpenRouter、AWS Bedrock、自定义 OpenAI 兼容接口）——按需设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY` 即可。

## 安装

克隆到 Claude Code skills 目录：

```bash
git clone https://github.com/CTctikki/wechat-claude-code.git ~/.claude/skills/wechat-claude-code
cd ~/.claude/skills/wechat-claude-code
npm install
```

`postinstall` 脚本会自动编译 TypeScript。

## 快速开始

### 1. 首次设置

扫码绑定微信账号：

```bash
cd ~/.claude/skills/wechat-claude-code
npm run setup
```

会自动弹出二维码图片，用微信扫码后配置工作目录。

### 2. 启动服务

```bash
npm run daemon -- start
```

- **macOS**：注册 launchd 代理，实现开机自启和自动重启
- **Linux**：使用 systemd 用户服务（无 systemd 时回退到 nohup）
- **Windows**：使用 PID 文件 + nohup 后台运行（需在 Git Bash 中执行）

### 3. 在微信中聊天

直接在微信中发消息即可与 Claude Code 对话。

### 4. 管理服务

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务（代码更新后使用）
npm run daemon -- logs     # 查看最近日志
```

## 权限审批

当 Claude 请求执行工具时，微信会收到权限请求：

- 回复 `y` 或 `yes` 允许
- 回复 `n` 或 `no` 拒绝
- 120 秒未回复自动拒绝

通过 `/permission <模式>` 切换权限模式：

| 模式 | 说明 |
|------|------|
| `default` | 每次工具使用需手动审批 |
| `acceptEdits` | 自动批准文件编辑，其他需审批 |
| `plan` | 只读模式，不允许任何工具 |
| `auto` | 自动批准所有工具（危险模式） |

## 工作原理

```
微信（手机） ←→ ilink bot API ←→ Node.js 守护进程 ←→ Claude Code SDK（本地）
```

1. 守护进程通过长轮询监听微信 ilink bot API 的新消息
2. 消息通过 `@anthropic-ai/claude-agent-sdk` 转发给 Claude Code
3. 工具调用和思考摘要在 Claude 工作时实时推送到微信
4. 回复发送回微信，限频时自动重试
5. 平台原生服务管理保持守护进程运行

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证（每个账号一个 JSON）
├── config.env      # 全局配置（工作目录、模型、权限模式、系统提示词）
├── sessions/       # 会话数据（每个账号一个 JSON）
├── images/         # 临时图片文件（供 Claude 读取）
├── files/          # 临时下载文件
├── get_updates_buf # 消息轮询同步缓冲
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## 开发

```bash
npm run dev    # 监听模式——TypeScript 文件变更时自动编译
npm run build  # 编译 TypeScript
```

## License

[MIT](LICENSE)
