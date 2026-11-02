# 🎙 AI 声鉴所（voice-aura）

> 30 秒，鉴定你的声音灵魂。念一段文字，测出你的专属声音人格、声音估值与五维声学雷达。

## 产品结构

- **前端**：纯 HTML/CSS/JS 静态站（部署在 GitHub Pages）
  - 录音（MediaRecorder）→ 解码重采样 16kHz WAV → base64
  - 本地声学特征提取（音高/明亮度/语速/停顿/响度动态，Web Audio API）
  - 结果页：声音人格 + 估值 + 击败率 + 五维雷达 + AI 诊断书
  - 分享：Canvas 生成 1080×1440 分享卡（navigator.share / 下载 + 复制文案）+ 再测一次
- **后端**：Cloudflare Worker（`worker/`）
  - `POST /api/analyze`：CORS 校验 → 频率限制 → 调用阿里云百炼 DashScope（OpenAI 兼容接口）
  - 模型：`qwen3.8-omni-flash`（原生音频理解，直接"听"录音）
  - 输出结构化 JSON 并归一化（分数钳制 72–98、估值与击败率确定性右偏映射）
- **隐私**：录音仅用于本次分析，Worker 不落盘不记日志；密钥只存 Worker Secret。

## 目录

```
voice-aura/
├── web/               # 前端（GitHub Pages 部署这个目录）
│   ├── index.html
│   ├── style.css
│   ├── config.js      # 部署后填入 Worker 地址
│   ├── audio.js       # 录音 + 声纹特征 + WAV 编码
│   ├── share.js       # 雷达图 + 分享卡片
│   └── app.js         # 主流程
├── worker/
│   ├── wrangler.toml
│   └── src/worker.js  # API 后端
├── docs/design.md     # 测评结果分析设计文档
└── secrets/           # API Key（已 gitignore，不进仓库）
```

## 本地开发

```bash
cd worker
npx wrangler dev        # 打开 http://127.0.0.1:8787
```

- 未配置 Key 时自动进入**演示模式**（本地模拟结果，health 接口 `mock: true`）
- 也可以加 `?demo=1` 强制前端演示模式
- 本地真实 Key：创建 `worker/.dev.vars` 写入 `DASHSCOPE_API_KEY=sk-xxx`（已 gitignore）

## 部署

### 1. Cloudflare Worker

```bash
cd worker
npx wrangler login                       # 浏览器授权
npx wrangler secret put DASHSCOPE_API_KEY   # 粘贴百炼 API Key
npx wrangler deploy                      # 得到 https://voice-aura-api.<子域>.workers.dev
```

然后把 workers.dev 地址填入 `web/config.js` 的 `API_BASE`，并把 GitHub Pages 域名
（`https://<用户名>.github.io`）追加到 `worker/wrangler.toml` 的 `ALLOWED_ORIGINS`，重新 `deploy`。

### 2. GitHub Pages

```bash
git init && git add . && git commit -m "init: AI 声鉴所"
gh repo create voice-aura --public --source=. --push
gh api repos/{owner}/voice-aura/pages -X POST -f "source[branch]=main" -f "source[path]=/"
# 或者: 仓库 Settings → Pages → Branch: main / root
```

站点地址：`https://<用户名>.github.io/voice-aura/`
