/**
 * Cloudflare Pages 全站访问验证中间件
 * functions/_middleware.js —— 作用于站点所有请求（含静态页面与全部 API）
 *
 * 验证逻辑（按顺序放行）：
 *   1. /api/auth/* 管理接口始终放行（登录/登出/状态查询本身必须可访问）
 *   2. 未启用访问验证（无密码且无 IP 白名单）→ 全部放行（安全阀，防止锁死自己）
 *   3. 请求 IP 命中白名单 → 放行
 *   4. Cookie ce_auth 携带有效会话（30 天）→ 放行
 *   5. 其余请求 → 401 返回锁屏页面
 *
 * 配置存储：KV（键 creator_auth_config）
 *   { enabled:bool, password:string, ipWhitelist:string[], devices:[] }
 * 密码可用 CF 加密密文 ACCESS_PASSWORD 覆盖（env 优先，更安全）
 */

const CFG_KEY = 'creator_auth_config';
const SESS_PREFIX = 'creator_auth_session:';
const SESS_TTL = 30 * 24 * 3600 * 1000; // 30 天

async function getConfig(env) {
  const cfg = { enabled: false, password: '', ipWhitelist: [], devices: [] };
  try {
    const raw = await env.EARNINGS_KV.get(CFG_KEY);
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch (e) { /* KV 不可用时按默认（放行）处理 */ }
  // CF 密文密码优先（若配置了 ACCESS_PASSWORD，则以后台设置为准，env 覆盖 KV 中的密码）
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

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);

  // 管理接口始终放行（接口内部自行校验授权）
  if (url.pathname.startsWith('/api/auth/')) return ctx.next();

  const cfg = await getConfig(ctx.env);
  if (!cfg.enabled) return ctx.next();

  // IP 白名单
  const ip = getIP(ctx.request);
  if (Array.isArray(cfg.ipWhitelist) && cfg.ipWhitelist.indexOf(ip) >= 0) return ctx.next();

  // 会话 Cookie
  const token = getCookie(ctx.request, 'ce_auth');
  if (token) {
    try {
      const raw = await ctx.env.EARNINGS_KV.get(SESS_PREFIX + token);
      if (raw) {
        const sess = JSON.parse(raw);
        if (sess.exp > Date.now()) return ctx.next();
      }
    } catch (e) { /* 会话解析失败按未授权处理 */ }
  }

  // 未授权 → 锁屏页
  return new Response(renderLock(ip), {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* ============ 锁屏页面 ============ */
function renderLock(ip) {
  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7fb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#1f2430}
    .card{background:#fff;border-radius:18px;box-shadow:0 10px 40px rgba(30,40,80,.10);padding:36px 32px;width:100%;max-width:380px;text-align:center}
    .logo{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#FF4757,#FF7A45);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:26px;color:#fff;font-weight:800}
    h1{font-size:19px;margin-bottom:6px}
    .sub{font-size:13px;color:#8a91a5;margin-bottom:22px}
    .input{width:100%;padding:12px 14px;border:1px solid #e3e6ef;border-radius:10px;font-size:15px;outline:none;margin-bottom:12px;background:#fafbfe;transition:border .2s}
    .input:focus{border-color:#FF4757}
    .btn{width:100%;padding:12px;border:0;border-radius:10px;background:linear-gradient(135deg,#FF4757,#FF7A45);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
    .btn:disabled{opacity:.6;cursor:wait}
    .err{display:none;background:#fdecec;color:#d93025;border:1px solid #f5c6c6;border-radius:8px;padding:9px 10px;font-size:12.5px;margin-bottom:12px}
    .meta{font-size:11.5px;color:#a6adc0;margin-top:16px;line-height:1.7}
    .meta a{color:#FF4757;text-decoration:none}
    .hint{font-size:11.5px;color:#a6adc0;margin-top:8px}
  `;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问验证 · 创作者收益工作台</title>
<style>${css}</style></head>
<body><div class="card">
  <div class="logo">创</div>
  <h1>创作者收益工作台</h1>
  <div class="sub">此站点已启用访问验证，请输入访问密码</div>
  <div class="err" id="err"></div>
  <input class="input" type="password" id="pwd" placeholder="访问密码" autocomplete="current-password" autofocus>
  <button class="btn" id="btn">解锁</button>
  <div class="meta">当前访问 IP：<b>${esc(ip)}</b><br>
  <a href="/api/auth/privacy" target="_blank">隐私政策与品牌声明</a></div>
  <div class="hint">解锁成功后自动进入站点</div>
</div>
<script>
var btn=document.getElementById('btn'),pwd=document.getElementById('pwd'),err=document.getElementById('err');
function show(msg){err.style.display='block';err.textContent=msg;}
function submit(){
  var v=pwd.value.trim();
  if(!v){show('请输入访问密码');return;}
  btn.disabled=true;btn.textContent='验证中...';
  fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v})})
    .then(function(r){return r.json().then(function(d){return {s:r.status,d:d};});})
    .then(function(res){
      if(res.s===200 && res.d.ok){ location.reload(); return; }
      btn.disabled=false;btn.textContent='解锁';
      show(res.d.error || '密码错误，请重试');
      pwd.value='';pwd.focus();
    })
    .catch(function(){btn.disabled=false;btn.textContent='解锁';show('网络异常，请重试');});
}
btn.addEventListener('click',submit);
pwd.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
</script></body></html>`;
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
