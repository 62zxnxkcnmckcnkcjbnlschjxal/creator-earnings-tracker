/**
 * Cloudflare Pages Functions —— 云端同步接口
 * GET  /api/state  读取云端数据
 * PUT  /api/state  写入云端数据（覆盖式，最后写入者胜）
 *
 * 绑定：EARNINGS_KV（Cloudflare KV 命名空间，免费额度 1GB / 10万读 / 1千写 每天）
 * 存储键：creator_earnings_state
 * 数据格式：{ "t": 时间戳, "activities": [...] }
 *
 * v3.0 新增：当访问验证启用时，本接口同样要求已授权（防御纵深，middleware 已做外层拦截）
 */
const KV_KEY = 'creator_earnings_state';
const MAX_BYTES = 512 * 1024; // 512KB 上限，正常数据远小于此

const AUTH_CFG_KEY = 'creator_auth_config';
const AUTH_SESS_PREFIX = 'creator_auth_session:';
const AUTH_SESS_TTL = 30 * 24 * 3600 * 1000;

async function getAuthConfig(env) {
  const cfg = { enabled: false, password: '', ipWhitelist: [], devices: [] };
  try {
    const raw = await env.EARNINGS_KV.get(AUTH_CFG_KEY);
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch (e) {}
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

async function isAuthed(env, req) {
  const cfg = await getAuthConfig(env);
  if (!cfg.enabled) return true; // 未启用验证时，接口直接放行
  const ip = getIP(req);
  if (Array.isArray(cfg.ipWhitelist) && cfg.ipWhitelist.indexOf(ip) >= 0) return true;
  const token = getCookie(req, 'ce_auth');
  if (!token) return false;
  try {
    const raw = await env.EARNINGS_KV.get(AUTH_SESS_PREFIX + token);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return s.exp > Date.now();
  } catch (e) { return false; }
}

export async function onRequestGet(ctx) {
  const authed = await isAuthed(ctx.env, ctx.request);
  if (!authed) return json({ error: '未授权' }, 401);

  try {
    const raw = await ctx.env.EARNINGS_KV.get(KV_KEY);
    if (!raw) {
      return json({ t: 0, activities: [] });
    }
    return json(JSON.parse(raw));
  } catch (e) {
    return json({ t: 0, activities: [] });
  }
}

export async function onRequestPut(ctx) {
  const authed = await isAuthed(ctx.env, ctx.request);
  if (!authed) return json({ error: '未授权' }, 401);

  try {
    const body = await ctx.request.text();
    if (!body || body.length > MAX_BYTES) {
      return new Response('invalid body', { status: 413 });
    }
    // 校验结构，避免写入脏数据
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return new Response('bad json', { status: 400 });
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.activities)) {
      return new Response('bad shape', { status: 400 });
    }
    if (typeof data.t !== 'number') data.t = Date.now();

    await ctx.env.EARNINGS_KV.put(KV_KEY, JSON.stringify(data));
    return new Response('ok');
  } catch (e) {
    return new Response('server error', { status: 500 });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
