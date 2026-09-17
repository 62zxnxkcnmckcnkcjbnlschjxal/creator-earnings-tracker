/**
 * Cloudflare Pages Function —— 友链数据云端同步
 * GET  /api/links   拉取友链列表
 * POST /api/links   整体保存友链列表（需已授权）
 *
 * 绑定：EARNINGS_KV
 * 存储键：creator_links
 * 数据格式：{ "t": 时间戳, "links": [ {id, title, url} ] }
 */

const KV_KEY = 'creator_links';

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

async function readLinks(env) {
  try {
    const raw = await env.EARNINGS_KV.get(KV_KEY);
    if (!raw) return { t: 0, links: [] };
    const d = JSON.parse(raw);
    return { t: d.t || 0, links: Array.isArray(d.links) ? d.links : [] };
  } catch (e) { return { t: 0, links: [] }; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export async function onRequestGet(ctx) {
  try {
    const d = await readLinks(ctx.env);
    return json({ ok: true, t: d.t, links: d.links });
  } catch (e) {
    return json({ ok: false, error: '读取异常：' + e.message }, 500);
  }
}

export async function onRequestPost(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);

    const body = await ctx.request.json();
    const list = Array.isArray(body.links) ? body.links : [];
    // 清洗：仅保留 id/title/url 字符串字段，避免脏数据入库
    const clean = list
      .map(function (l) {
        if (!l || typeof l !== 'object') return null;
        const id = String(l.id || '').slice(0, 64);
        const title = String(l.title || '').trim().slice(0, 100);
        const url = String(l.url || '').trim().slice(0, 500);
        if (!id || !title || !url) return null;
        return { id: id, title: title, url: url };
      })
      .filter(Boolean)
      .slice(0, 200);

    const payload = { t: Date.now(), links: clean };
    await ctx.env.EARNINGS_KV.put(KV_KEY, JSON.stringify(payload));
    return json({ ok: true, t: payload.t, count: clean.length });
  } catch (e) {
    return json({ ok: false, error: '保存异常：' + e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
