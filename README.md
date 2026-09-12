# 创作者收益工作台 v2.9

## 部署说明（重要）

### ⚠️ Dashboard 直接上传 zip 不会部署接口函数

Cloudflare Pages Dashboard 的「直接上传」方式**不会部署 `functions/` 目录下的 Functions**。这会导致 `/api/deepseek`、`/api/state`、`/api/music` 等接口全部返回 404 HTML，前端解析报错后显示「请求失败」。

**必须使用以下两种方式之一部署：**

---

### 方式一：Git 集成（推荐）

1. 将源码推送到 GitHub / GitLab 仓库
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Pages
3. 点击「创建项目」→「连接到 Git」
4. 选择仓库，构建设置：
   - **构建命令**：留空（静态站点，无需构建）
   - **构建输出目录**：`/`（根目录）
5. 点击「保存并部署」
6. 部署完成后，在「设置」→「Functions」中绑定 KV 命名空间：
   - 变量名：`EARNINGS_KV`
   - 选择或创建 KV 命名空间

---

### 方式二：Wrangler CLI

1. 安装 Wrangler（如未安装）：
   ```bash
   npm install -g wrangler
   # 或
   npx wrangler login
   ```

2. 创建 KV 命名空间（仅需一次）：
   ```bash
   npx wrangler kv:namespace create "EARNINGS_KV"
   ```
   记录返回的 `id`，填入 `wrangler.toml`（如果项目中有）或在 Dashboard 绑定。

3. 部署：
   ```bash
   cd creator-earnings-tracker-v2.8
   npx wrangler pages deploy . --project-name=your-project-name
   ```

4. 首次部署后，在 Dashboard → Pages → 项目 → 设置 → Functions 中确认 `EARNINGS_KV` 已绑定。

---

### 配置 DeepSeek 密钥到 Cloudflare 加密密文（推荐）

将 DeepSeek API Key 配置到 Cloudflare 加密环境变量后，**无需在每个浏览器填写 Key**，对话直接通过服务器代理转发，密钥始终不暴露给前端。

**方式 A：Cloudflare Dashboard（图形界面）**

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Pages → 选择项目
2. 左侧「设置」→「Environment variables」
3. 点击「添加变量」：
   - 变量名：`DEEPSEEK_API_KEY`
   - 值：你的 DeepSeek API Key（如 `sk-...`）
   - **类型**：选择「加密 / Secret」（Encrypt）
4. 确保「生产环境」和「预览环境」都添加了该变量
5. 点击「保存」后，**重新部署一次**项目（Settings 页面有「重新部署」按钮）才能生效

**方式 B：Wrangler CLI（命令行）**

```bash
npx wrangler pages secret put DEEPSEEK_API_KEY --project-name <项目名>
# 按提示粘贴你的 Key
```

执行后会要求输入密钥值，粘贴后回车即可。Secret 会自动加密存储。

**优先级说明**

- 服务器环境变量 `DEEPSEEK_API_KEY`（Cloudflare 加密密文）**优先**
- 若服务器未配置，则回退使用用户在设置页本地填写的 Key
- 两者都未配置时，DeepSeek 对话功能不可用，设置页会给出明确提示

---

### 目录结构说明

```
creator-earnings-tracker-v2.8/
├── index.html              # 主页面（前端应用）
├── manifest.json           # PWA 配置
├── functions/              # Cloudflare Pages Functions（必须通过 Git/CLI 部署）
│   ├── _middleware.js      # 全站访问验证中间件（锁屏 + IP 白名单 + 会话校验）
│   └── api/
│       ├── auth.js         # 访问验证管理接口（登录/登出/状态/配置/隐私）
│       ├── deepseek.js     # DeepSeek API 代理（支持 Cloudflare 加密环境变量密钥）
│       ├── state.js        # 云端同步（KV）
│       └── music.js        # 网易云音乐代理（含 ncmFetch、needLogin 回退、Cookie 支持）
├── assets/                 # 字体、播放器脚本
├── icons/                  # PWA 图标
└── README.md               # 本文件
```

---

### 🔒 访问验证（服务端拦截，v2.9 新增）

站点默认**不开启**访问验证。开启后，未授权设备**无法加载任何页面与接口**（连首页 HTML 都拿不到），由服务端 `functions/_middleware.js` 统一拦截。

**如何启用（二选一）**

- **网页后台**：打开站点 → 设置 → 「访问验证」→ 填写访问密码（建议同时把当前 IP 加入白名单）→ 勾选「启用访问验证」→ 保存。
- **Cloudflare 密文（更安全，推荐）**：Settings → Environment variables → 添加 `ACCESS_PASSWORD`（勾选 Encrypt）→ Retry deployment。此时设置页密码由 CF 密文提供。

**验证逻辑（按顺序放行）**

1. `/api/auth/*` 管理接口（登录/登出/状态查询/隐私页）始终可访问；
2. 请求 IP 命中**白名单** → 直接放行（家庭/办公固定 IP 建议加入，免输入密码）；
3. Cookie `ce_auth` 携带**有效会话**（登录后下发，HttpOnly，30 天有效）→ 放行；
4. 其余请求 → 返回 401 锁屏页，输入访问密码解锁后自动进入站点。

**安全特性**

- 访问密码存储在 CF（优先 `ACCESS_PASSWORD` 密文，其次 KV 配置），不进入前端代码；
- 连续输错 5 次密码，该 IP 锁定 10 分钟（防爆破）；
- 未授权访问 `/api/state`、`/api/deepseek` 等全部接口同样被拦截，业务数据不外泄；
- 退出登录：设置页「退出登录」按钮，清除会话 Cookie。

**⚠️ 重要提醒**

- 启用前**务必记好密码**，或在 CF 配置 `ACCESS_PASSWORD` 密文兜底；
- 若同时清空密码与 IP 白名单，验证**自动关闭**（安全阀），防止把站点锁死；
- 会话有效期 30 天，到期后需重新输入密码；
- 请勿把访问密码与 DeepSeek 密钥写在代码或 README 中提交到公开仓库。

### v2.9 更新内容
1. 新增**访问验证模块**：`functions/_middleware.js` 全站服务端拦截 + `functions/api/auth.js` 管理接口；设置页新增「访问验证」组（启用开关、访问密码、IP 白名单、退出登录）；未授权返回 401 锁屏页；防爆破、会话 30 天。
2. 隐私政策与品牌声明链接改为 hash 路由（`#privacy`），点击可靠打开隐私页，支持前进/后退。
3. 锁屏页与隐私页均可公开访问隐私政策。

### v2.8 更新内容

**A 部分：播放器 P0 修复**
1. `functions/api/music.js` 升级为新版实现：
   - `ncmFetch` 函数支持 Cookie 参数传递
   - `needLogin` 结构化错误处理（返回 200 + `needLogin: true`，前端可解析）
   - 默认歌单请求 `n=500` 获取更多歌曲
   - `FALLBACK_PL='3778678'`（热歌榜）回退逻辑：私人歌单匿名请求失败时自动切换到公开热歌榜
2. 播放器前端增加 `r.ok` / `content-type` 检查与中文状态码提示（404→接口未部署，401→需要登录等）
3. 设置面板新增「网易云 Cookie」输入框，支持访问私人歌单
4. 播放器状态提示跟随红色主题 / 深色模式 / 手机排版规范

**B 部分：DeepSeek 密钥迁移 Cloudflare 加密密文**
1. `functions/api/deepseek.js` 优先从 `ctx.env.DEEPSEEK_API_KEY` 读取密钥（Cloudflare 加密环境变量）
2. 新增 `key-status` 探查接口：只返回 `true/false`，绝不泄漏密钥本身
3. 设置页显示「服务器密钥：已配置/未配置」状态，并给出对应引导
4. 新增「验证服务器密钥」按钮，支持 `action=verify&source=env` 验证服务器 env 密钥
5. 密钥双模式兼容：env 有 → 用 env；env 无本地有 → 用本地；都无 → 明确提示
6. README 新增「配置 DeepSeek 密钥到 Cloudflare 加密密文」完整步骤

---

### 已知限制

- **预览环境**：直接打开本地 `index.html` 或使用静态托管预览时，`/api/deepseek`、`/api/state`、`/api/music` 不可用。密钥验证会降级尝试直连 `api.deepseek.com`（DeepSeek 支持 CORS 时可用），但对话请求仍需要 Functions 代理（因 POST 需隐藏密钥）。预览环境不体现服务器密文功能。
- **密钥存储**：本地填写的 API Key 仅保存在浏览器 `localStorage`，不进入云端同步；换设备或清缓存需重新填写。推荐通过 Cloudflare 加密环境变量配置，多设备通用且更安全。
- **Cloudflare KV**：免费额度 1GB 存储 / 10 万次读取 / 1 千次写入每天，正常用量远不会触及。
- **网易云 Cookie**：Cookie 仅保存在浏览器本地，不进入云端同步。不同设备需分别填写。
