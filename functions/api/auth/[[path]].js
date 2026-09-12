/**
 * Cloudflare Pages Function —— 访问验证管理接口（catch-all：/api/auth/*）
 * 注意：必须放在 functions/api/auth/[[path]].js，CF Pages 中 auth.js 只匹配 /api/auth，不匹配子路径
 * POST /api/auth/login    {password}            登录（密码正确 → 下发 30 天会话 Cookie）
 * POST /api/auth/logout                          退出登录（删除会话）
 * GET  /api/auth/status                          查询验证状态（公开）
 * GET  /api/auth/config                          读取验证配置（需已授权）
 * POST /api/auth/config                          更新验证配置（需已授权）
 * GET  /api/auth/privacy                         隐私政策文本页（公开）
 *
 * 配置存 KV（键 creator_auth_config）；密码可用 CF 加密密文 ACCESS_PASSWORD 覆盖（env 优先）
 */

const CFG_KEY = 'creator_auth_config';
const SESS_PREFIX = 'creator_auth_session:';
const FAIL_PREFIX = 'creator_auth_fail:';
const SESS_TTL = 30 * 24 * 3600 * 1000;   // 会话 30 天
const LOCK_TTL = 10 * 60 * 1000;          // 防爆破锁定 10 分钟
const MAX_FAIL = 5;                        // 5 次失败锁定

async function getConfig(env) {
  const cfg = { enabled: false, password: '', ipWhitelist: [], devices: [] };
  try {
    const raw = await env.EARNINGS_KV.get(CFG_KEY);
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch (e) { /* 忽略 */ }
  if (env.ACCESS_PASSWORD && typeof env.ACCESS_PASSWORD === 'string' && env.ACCESS_PASSWORD.trim()) {
    cfg.password = env.ACCESS_PASSWORD.trim();
  }
  cfg.enabled = !!(cfg.enabled && (cfg.password || (Array.isArray(cfg.ipWhitelist) && cfg.ipWhitelist.length > 0)));
  return cfg;
}

function getIP(req) {
  const xff = req.headers.get('x-forwarded-for') || '';
  return (req.headers.get('CF-Connecting-IP') || xff.split(',')[0] || '').trim() || 'unknown';
}

function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// 是否已授权：IP 白名单 或 有效会话 Cookie
async function isAuthed(env, req) {
  const cfg = await getConfig(env);
  const ip = getIP(req);
  if (Array.isArray(cfg.ipWhitelist) && cfg.ipWhitelist.indexOf(ip) >= 0) return true;
  const token = getCookie(req, 'ce_auth');
  if (!token) return false;
  try {
    const raw = await env.EARNINGS_KV.get(SESS_PREFIX + token);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return s.exp > Date.now();
  } catch (e) { return false; }
}

/* ================= POST /api/auth/login ================= */
export async function onRequestPost(ctx) {
  try {
    const body = await ctx.request.json();
    const pwd = String(body.password || '').trim();
    const ip = getIP(ctx.request);

    const cfg = await getConfig(ctx.env);
    if (!cfg.enabled) return json({ ok: true, disabled: true, error: '访问验证未启用' }, 200);

    // 防爆破：连续失败锁定
    const failRaw = await ctx.env.EARNINGS_KV.get(FAIL_PREFIX + ip);
    if (failRaw) {
      const f = JSON.parse(failRaw);
      if (f.n >= MAX_FAIL && f.until > Date.now()) {
        const mins = Math.ceil((f.until - Date.now()) / 60000);
        return json({ ok: false, error: '尝试次数过多，请 ' + mins + ' 分钟后再试' }, 429);
      }
    }

    if (!cfg.password || pwd !== cfg.password) {
      // 记录失败
      let f = { n: 1, until: 0 };
      if (failRaw) { try { f = JSON.parse(failRaw); } catch (e) {} }
      f.n = (f.n || 0) + 1;
      if (f.n >= MAX_FAIL) f.until = Date.now() + LOCK_TTL;
      await ctx.env.EARNINGS_KV.put(FAIL_PREFIX + ip, JSON.stringify(f), { expirationTtl: 3600 });
      return json({ ok: false, error: '密码错误' }, 401);
    }

    // 成功：清除失败计数，下发会话
    await ctx.env.EARNINGS_KV.delete(FAIL_PREFIX + ip);
    const token = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    await ctx.env.EARNINGS_KV.put(SESS_PREFIX + token, JSON.stringify({ exp: Date.now() + SESS_TTL }), { expirationTtl: Math.ceil(SESS_TTL / 1000) });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'ce_auth=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.ceil(SESS_TTL / 1000),
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return json({ ok: false, error: '登录异常：' + e.message }, 500);
  }
}

/* ================= POST /api/auth/logout ================= */
export async function onRequestPostLogout(ctx) {
  try {
    const token = getCookie(ctx.request, 'ce_auth');
    if (token) await ctx.env.EARNINGS_KV.delete(SESS_PREFIX + token);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'ce_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return json({ ok: false, error: '退出异常：' + e.message }, 500);
  }
}

/* ================= GET /api/auth/status（公开） ================= */
export async function onRequestGetStatus(ctx) {
  try {
    const cfg = await getConfig(ctx.env);
    const ip = getIP(ctx.request);
    const authed = await isAuthed(ctx.env, ctx.request);
    const ipWhitelisted = Array.isArray(cfg.ipWhitelist) && cfg.ipWhitelist.indexOf(ip) >= 0;
    return json({
      enabled: cfg.enabled,
      locked: cfg.enabled && !authed,
      ip: ip,
      ipWhitelisted: ipWhitelisted,
      authed: authed,
      passwordViaEnv: !!(ctx.env.ACCESS_PASSWORD && String(ctx.env.ACCESS_PASSWORD).trim())
    });
  } catch (e) {
    return json({ error: '状态查询异常：' + e.message }, 500);
  }
}

/* ================= GET /api/auth/config（需授权） ================= */
export async function onRequestGetConfig(ctx) {
  const authed = await isAuthed(ctx.env, ctx.request);
  if (!authed) return json({ error: '未授权' }, 401);
  const cfg = await getConfig(ctx.env);
  return json({
    enabled: cfg.enabled,
    passwordSet: !!(cfg.password),
    passwordViaEnv: !!(ctx.env.ACCESS_PASSWORD && String(ctx.env.ACCESS_PASSWORD).trim()),
    ipWhitelist: Array.isArray(cfg.ipWhitelist) ? cfg.ipWhitelist : [],
    devices: Array.isArray(cfg.devices) ? cfg.devices : [],
    ip: getIP(ctx.request)
  });
}

/* ================= POST /api/auth/config（需授权，或首次启用 bootstrap） ================= */
export async function onRequestPostConfig(ctx) {
  // bootstrap 判断基于 KV 原始配置（不受 env.ACCESS_PASSWORD 覆盖干扰）：
  // 只要 KV 里从未配置过（无 enabled / 无密码 / 无白名单），就允许未授权首次启用
  let raw0 = null;
  try { raw0 = await ctx.env.EARNINGS_KV.get(CFG_KEY); } catch (e) {}
  let c0 = {};
  if (raw0) { try { c0 = JSON.parse(raw0); } catch (e) {} }
  const neverEnabled = !c0.enabled && !c0.password && !(Array.isArray(c0.ipWhitelist) && c0.ipWhitelist.length > 0);
  if (!neverEnabled) {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ error: '未授权' }, 401);
  }
  try {
    const body = await ctx.request.json();
    const cfg = await getConfig(ctx.env);

    if (body.hasOwnProperty('enabled')) cfg.enabled = !!body.enabled;
    if (body.hasOwnProperty('password')) {
      const p = String(body.password).trim();
      if (p) cfg.password = p;
      // 传空字符串表示不修改密码
    }
    if (Array.isArray(body.ipWhitelist)) {
      cfg.ipWhitelist = body.ipWhitelist
        .map(function (s) { return String(s).trim(); })
        .filter(Boolean)
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    }
    if (Array.isArray(body.devices)) cfg.devices = body.devices;

    // 安全阀：启用必须至少有一个凭据（密码或白名单），否则拒绝启用
    if (cfg.enabled && !cfg.password && !(cfg.ipWhitelist && cfg.ipWhitelist.length > 0)) {
      return json({ error: '启用访问验证前，请先设置访问密码或至少一个 IP 白名单' }, 400);
    }

    await ctx.env.EARNINGS_KV.put(CFG_KEY, JSON.stringify(cfg));
    return json({ ok: true, config: cfg });
  } catch (e) {
    return json({ error: '保存配置异常：' + e.message }, 500);
  }
}

/* ================= GET /api/auth/privacy（公开） ================= */
export async function onRequestGetPrivacy(ctx) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐私政策与品牌声明 · 创作者收益工作台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7fb;color:#1f2430;margin:0;padding:24px 14px}
.wrap{max-width:680px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 8px 30px rgba(30,40,80,.08)}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:15px;margin:22px 0 8px;color:#FF4757}
p,li{font-size:13.5px;line-height:1.75;color:#3a4258}
ul{padding-left:20px;margin:6px 0}
a{color:#FF4757}
.foot{margin-top:26px;font-size:12px;color:#98a0b6;border-top:1px solid #eef0f6;padding-top:14px}
</style></head><body><div class="wrap">
<h1>隐私政策与品牌声明</h1>
<p>创作者收益工作台 — 非官方个人自用工具。本工具不设置账号注册与登录体系，也不会收集您的个人身份信息（如姓名、手机号、邮箱等）。</p>
<h2>业务数据（Cloudflare KV 云端同步）</h2>
<p>活动内容、奖励信息、公示记录等业务状态数据，通过 /api/state 接口存储在 Cloudflare KV。数据为全局共享状态，不区分用户身份。</p>
<h2>访问验证</h2>
<p>本站点支持访问验证（访问密码 + IP 白名单）。验证密码以加密密文方式保管（Cloudflare Secret），会话凭证以 HttpOnly Cookie 形式存储，仅用于判断是否允许访问，不含业务数据。登录失败计数仅用于防爆破，超时自动清除。</p>
<h2>界面偏好（浏览器本地存储）</h2>
<p>播放器设置、各模块折叠/展开状态等仅保存在浏览器 localStorage 中，不会上传到任何服务器。</p>
<h2>DeepSeek 对话数据</h2>
<p>密钥支持两种方式：① 推荐在 Cloudflare 配置加密密文 DEEPSEEK_API_KEY（密钥只存在 CF 服务端，浏览器不接触）；② 或手动填写保存于浏览器本地。对话通过 Cloudflare Function 透明转发至 api.deepseek.com，本工具服务器不存储对话内容。</p>
<h2>音乐播放</h2>
<p>页面嵌入了网易云歌单播放器，本工具不采集、不存储与音乐播放相关的任何用户数据。网易云 Cookie（如配置）仅用于获取歌单播放地址，存储在浏览器本地。</p>
<h2>品牌声明</h2>
<p>本工具与抖音、快手、小红书、网易等平台无任何从属或合作关系，各平台名称与标识归各自权利人所有。工具仅供创作者个人记账使用。</p>
<div class="foot">创作者收益工作台 · <a href="/">返回站点</a></div>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* ================= 路由分发 ================= */
async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const action = url.pathname.split('/').pop(); // login/logout/status/config/privacy
  if (action === 'status') return onRequestGetStatus(ctx);
  if (action === 'config') return onRequestGetConfig(ctx);
  if (action === 'privacy') return onRequestGetPrivacy(ctx);
  return json({ error: '不支持的操作' }, 400);
}

export async function onRequest(ctx) {
  if (ctx.request.method === 'POST') {
    const url = new URL(ctx.request.url);
    const action = url.pathname.split('/').pop();
    if (action === 'login') return onRequestPost(ctx);
    if (action === 'logout') return onRequestPostLogout(ctx);
    if (action === 'config') return onRequestPostConfig(ctx);
    return json({ error: '不支持的操作' }, 400);
  }
  if (ctx.request.method === 'GET') return onRequestGet(ctx);
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  return json({ error: '不支持的方法' }, 405);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}
//（注：内容由AI生成）
