# 创作者收益工作台 v4.0

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
creator-earnings-tracker/
├── index.html              # 主页面（前端应用，v3.6 最新）
├── manifest.json           # PWA 配置
├── functions/              # Cloudflare Pages Functions（必须通过 Git/CLI 部署）
│   ├── _middleware.js      # 全站访问验证中间件（锁屏深色适配 + IP 白名单 + 会话校验）
│   └── api/
│       ├── auth/[[path]].js  # 访问验证管理接口（catch-all：/api/auth/* 全部子路径）
│       ├── deepseek.js     # DeepSeek API 代理（支持 Cloudflare 加密环境变量密钥）
│       ├── state.js        # 云端同步（KV，含活动 + 公告 + 内联鉴权）
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

### v3.6 更新内容（公告标题与内联编辑 + 主题按钮统一）
1. **公告支持标题 + 内容 + 日期**：添加公告表单新增「公告标题」输入框（如"光遇追光计划第 21 期"），下方填活动奖励、规则说明等内容，再选日期；公告列表标题加粗显示在内容上方。
2. **公告内联编辑**：点「编辑」自动将标题/内容/日期填入表单，按钮变为「保存修改」，改完保存即更新；不再使用浏览器 prompt 弹窗（手机端体验差），编辑态显示「取消」按钮可退出。
3. **公告多设备云端同步**：公告与活动数据一起存入 Cloudflare KV（`state.notices` 并入 `/api/state`），平板上添加/编辑/删除 → 推送云端 → 手机端自动拉到，多设备可见。
4. **DeepSeek 公告上下文增强**：注入给 DeepSeek 的公告上下文携带标题，格式 `[日期] 标题：内容`，公告解读更准确。
5. **主题切换按钮三端统一**：电脑端主区工具栏与平板/手机端窄屏头部两处按钮统一为 `☀️/🌙/⚙️`，所有屏幕比例显示一致。

### v3.5 更新内容（主题色全面联动，修复硬编码彩色）
1. **首页「待发放收益」总览卡**背景从固定红色渐变改为跟随主题主色（切换海蓝主题即变蓝色卡、青瓷即青色卡）。
2. **「已发放」总览卡**固定绿色渐变与绿色阴影改为跟随主题绿色变量。
3. **修复全部硬编码彩色阴影**：logo、选中页签、主按钮的红色阴影、已发放卡绿色阴影，改用 `color-mix()` 从主题主色自动生成——切换任意主题阴影颜色同步变化，深浅模式自动适配。
4. **播放器歌单选中色**与深色模式引用块背景改为跟随主题。

### v3.4 更新内容（状态栏修复 + 6 套配色主题 + 抖音美好体）
1. **修复手机状态栏白色刺眼**：PWA 全屏时状态栏透明区显示 `html` 根背景，之前 html 无背景色导致露白。现在 html 背景跟随主题深色，深色模式下状态栏为深色。
2. **设置 → 外观 → 新增「主题色」**：6 套配色主题——绯红（默认）/ 青瓷 / 紫罗兰 / 琥珀 / 海蓝 / 樱粉，**每套均有对应的深色模式样式**，一键切换，本地保存。
3. **DeepSeek 回答改用抖音美好体（DouyinSansText）字体**，与站内标题风格统一。

### v3.3 更新内容（公告改名 + 公告云端同步 + 助手全屏）
1. **「公示」全部改名「公告」**：页面标题、按钮、空状态、DeepSeek 快捷按钮「公示解读」→「公告解读」。
2. **公告云端同步**：公告记录并入 `state.notices`，与活动一起走 `/api/state` 存入 CF KV，换设备自动同步。
3. **DeepSeek 助手全屏**：打开助手页时隐藏顶部工具栏与底部工具条，只保留聊天界面。
4. **底部工具条（备份/恢复/清空 + 非官方说明）只在「待发放首页」和「设置页」显示**；修复 CSS `display:flex` 覆盖 `hidden` 属性导致工具条隐藏失效的 bug。
5. **手机 tabbar「待发放」横排**：改为 3 列网格布局，数字徽标横排显示，不再竖排。
6. **锁屏页深色适配**：`functions/_middleware.js` 锁屏页支持深色模式 + `viewport-fit=cover` 全屏 + 动态 theme-color（随系统深浅自动切换）。
7. **设置页当前访问 IP 长串适配**：IP 过长自动换行，不再撑破布局。

### v3.2 更新内容（访问验证启用收尾）
1. **前端 auth 状态防异步覆盖**：保存设置后立即刷新验证状态（`authDirty` / `wlDirty` 标记），避免旧请求返回覆盖新状态。
2. 线上部署后确认访问验证可正常启用（勾选 → 保存 → 服务端锁定生效）。

### v3.1 更新内容（访问验证首次启用死锁修复）
1. **bootstrap 首次启用修复**：判断"验证从未启用"必须直接读 KV 原始配置（`EARNINGS_KV.get(CFG_KEY)`），不能用 `getConfig()` 读取——否则会被 `ACCESS_PASSWORD` 加密密文污染，导致首次启用死锁（勾选后保存自动取消）。
2. 交付纯净 `export async function onRequest(ctx)` 单分发器版 auth 接口（`functions/api/auth/[[path]].js`），彻底消除路由冲突。

### v3.0 更新内容（登录验证根因修复）
1. **修复访问验证接口路由冲突（v2.9 登录失效的根因）**：v2.9 的 `functions/api/auth/[[path]].js` 同时导出了 `onRequestPost` 与 `onRequest`，Cloudflare Pages 编译后把 `POST /api/auth/*` 全部固定路由到 `onRequestPost`（登录处理器），导致 `/api/auth/logout`、`/api/auth/config` 等 POST 请求也被当作登录请求处理，返回密码错误。v3.0 移除所有方法专属导出，仅保留单一 `export async function onRequest(ctx)`，内部按 `url.pathname` 与 `request.method` 自行分发到 `handleLogin` / `handleLogout` / `handlePostConfig` 等私有函数，彻底消除路由冲突。
2. **前端 fetch 增加 `credentials: 'same-origin'`**：v2.9 前端 auth 请求未携带 credentials，在 PWA / standalone 模式或跨域场景下 Cookie（`ce_auth`）不会被浏览器发送，导致登录后服务端收不到会话凭证。v3.0 所有 auth 相关 fetch（status / config / login / logout）均显式携带 `credentials: 'same-origin'`。
3. **防御纵深：/api/state 增加授权校验**：即便 `_middleware.js` 被绕过（如本地开发直接请求 Functions），`state.js` 内联 `isAuthed` 检查，未授权时返回 401，保护云端业务数据。
4. **修复 `loadAuthStatus` 404 检测**：catch 块中 `e.status===404` 对 fetch 异常无效（异常对象是 Error 而非 Response），改为在 `.then(r => ...)` 阶段检测 `r.status===404` 后主动抛出，保证 404 提示文案正确触发。
5. **恢复 v2.8 字体文件**：v2.9 意外丢失了 `assets/DouyinSansBold.*.woff2`，v3.0 从 v2.8 基线恢复，确保「创」字 Logo 字体正常渲染。
6. **移除空文件 artifact**：v2.9 包含 1 字节空文件 `functions/api/auth/#`，v3.0 已清理。

### v2.9.1 更新内容（关键路由修复）
1. **修复访问验证接口 404/返回首页问题**：CF Pages 路由规则中 `functions/api/auth.js` 只匹配 `/api/auth`，不匹配 `/api/auth/status` 等子路径。已改为 `functions/api/auth/[[path]].js`（catch-all），`/api/auth/*` 全部子路径均可正确路由。
2. `_middleware.js` 放行条件补充 `/api/auth`（不带斜杠）路径。

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
