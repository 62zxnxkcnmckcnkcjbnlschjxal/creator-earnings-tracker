/**
 * Cloudflare Pages Function —— 界面配置云端同步（攻略 API 列表 + 光遇应天 Key）
 * GET  /api/settings  读取云端配置（需已授权）
 * POST /api/settings  写入云端配置（需已授权）
 *
 * 绑定：EARNINGS_KV（与业务数据共用）
 * 存储键：creator_ui_settings
 * 数据格式：{ "t": 时间戳, "guideApis": [{id,url}...], "skyKey": "..." }
 *
 * 鉴权规则与 /api/state 一致：访问验证启用时要求已授权（middleware 已做外层拦截，本接口做纵深防御）
 */
const KV_KEY = 'creator_ui_settings';
const MAX_BYTES = 64 * 1024;

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
  if (!cfg.enabled) return true;
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

async function readSettings(env) {
  try {
    const raw = await env.EARNINGS_KV.get(KV_KEY);
    if (!raw) return { t: 0, guideApis: [], skyKey: '' };
    const d = JSON.parse(raw);
    return {
      t: d.t || 0,
      guideApis: Array.isArray(d.guideApis) ? d.guideApis : [],
      skyKey: typeof d.skyKey === 'string' ? d.skyKey : ''
    };
  } catch (e) { return { t: 0, guideApis: [], skyKey: '' }; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestGet(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);
    const d = await readSettings(ctx.env);
    return json({ ok: true, t: d.t, guideApis: d.guideApis, skyKey: d.skyKey });
  } catch (e) {
    return json({ ok: false, error: '读取异常：' + e.message }, 500);
  }
}

export async function onRequestPost(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);
    const body = await ctx.request.json();
    const prev = await readSettings(ctx.env);

    // guideApis：合并去重（按 url，云端保留已存在的）
    const cloud = Array.isArray(body.guideApis) ? body.guideApis : prev.guideApis;
    const seen = {};
    const merged = [];
    prev.guideApis.forEach(function (a) {
      if (a && a.url) { seen[a.url] = true; merged.push(a); }
    });
    cloud.forEach(function (a) {
      if (a && a.url && !seen[a.url]) {
        seen[a.url] = true;
        merged.push({ id: a.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)), url: a.url });
      }
    });

    const next = {
      t: Date.now(),
      guideApis: merged.slice(0, 100),
      skyKey: typeof body.skyKey === 'string' ? body.skyKey.slice(0, 500) : prev.skyKey
    };
    const payload = JSON.stringify(next);
    if (payload.length > MAX_BYTES) return json({ ok: false, error: '配置过大' }, 400);
    await ctx.env.EARNINGS_KV.put(KV_KEY, payload);
    return json({ ok: true, t: next.t, guideApis: next.guideApis, skyKey: next.skyKey });
  } catch (e) {
    return json({ ok: false, error: '保存异常：' + e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}

export async function onRequest(ctx) {
  if (ctx.request.method === 'OPTIONS') return onRequestOptions();
  if (ctx.request.method === 'GET') return onRequestGet(ctx);
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  return json({ ok: false, error: '不支持的方法' }, 405);
}
