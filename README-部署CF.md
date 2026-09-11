# 部署到 Cloudflare（免费）

把「创作者待发收益工作台」发布到 Cloudflare Pages，并使用 **Cloudflare KV** 做云端存储。
部署完成后，手机、平板、电脑打开同一个网址，数据自动云端同步，换设备也能看到。

---

## 方式一：CF 控制台操作（推荐，无需命令行）

1. **注册/登录** [dash.cloudflare.com](https://dash.cloudflare.com)，进入 **Workers & Pages → Create → Pages → Upload assets（直接上传）**。

2. **准备要上传的文件夹**：本目录下的文件保持现状即可（`index.html` + `functions/`）。
   > 注意：直接拖拽上传只支持纯静态；带 `functions/` 的部署需要 Git 集成或 wrangler，见下方。

3. **推荐：连接 GitHub 自动部署（支持 functions）**
   - 把本目录推到你的 GitHub 仓库（例如 `creator-earnings-tracker`）。
   - CF Pages → Create project → **Connect to Git** → 选择该仓库。
   - 构建命令留空，输出目录填 `.` → Save and Deploy。
   - 部署完成后会得到一个 `https://<项目名>.pages.dev` 网址。

4. **创建 KV 并绑定**
   - CF 控制台 → **Workers & Pages → KV** → Create a namespace，名称随意（如 `earnings-kv`），记住它的 ID。
   - 回到你的 Pages 项目 → **Settings → Functions → KV namespace bindings** → Add binding：
     - Variable name：`EARNINGS_KV`
     - KV namespace：选刚创建的 `earnings-kv`
   - 保存后 **Redeploy**（Deployments → 最新一次 → ⋯ → Retry deployment），让绑定生效。

5. 打开你的 `.pages.dev` 网址 → 顶部出现绿色「云端已同步」即成功。

---

## 方式二：wrangler 命令行（本机安装）

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录你的 CF 账号
wrangler login

# 3. 创建 KV 命名空间（只需一次）
wrangler kv namespace create EARNINGS_KV
#   输出里复制 id，填入 wrangler.toml 的 kv_namespaces.id

# 4. 创建 Pages 项目（只需一次）
wrangler pages project create creator-earnings-tracker

# 5. 部署
wrangler pages deploy . --project-name creator-earnings-tracker
```

---

## 部署完成后

- 数据保存在 **Cloudflare KV**（免费额度：1GB 存储 / 每天 10 万次读 / 1 千次写，个人记账完全够用）。
- 前端逻辑：每次修改数据 → 自动推送到云端；每次打开页面 → 自动拉取较新的数据；断网时自动降级为浏览器本地存储，联网后恢复同步。
- 页面顶部有同步状态提示：绿=云端已同步 / 橙=同步中 / 灰=本地模式（未部署或未联网）/ 红=同步失败。
- CSV 导入导出、JSON 备份恢复照常可用，可作为额外保险。

## 常见问题

- **打开后显示「本地模式」**：说明没有通过 `.pages.dev` 网址访问（例如直接双击本地 html），属正常现象，本地模式也能用；用部署网址打开即自动云端同步。
- **两台设备数据不一致**：采用「最后写入者胜」，以最后修改时间较新的数据为准，正常使用无需关心。
- **想在自定义域名访问**：CF Pages → 项目 → Custom domains → 添加你的域名（需先在 CF 托管 DNS）。
