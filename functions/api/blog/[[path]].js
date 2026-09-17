/**
 * Cloudflare Pages Function —— 博客数据云端同步
 * GET    /api/blog              列表（分页）
 * GET    /api/blog/:id          单篇详情
 * POST   /api/blog              新建/更新
 * DELETE /api/blog/:id          删除
 *
 * 绑定：EARNINGS_KV
 * 存储键：creator_blog_data
 * 数据格式：{ "t": 时间戳, "v": 1, "articles": [Article] }
 */

const KV_KEY = 'creator_blog_data';
const MAX_BYTES = 512 * 1024;

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

async function readBlog(env) {
  try {
    const raw = await env.EARNINGS_KV.get(KV_KEY);
    if (!raw) return { t: 0, v: 1, articles: [] };
    const d = JSON.parse(raw);
    return { t: d.t || 0, v: d.v || 1, articles: Array.isArray(d.articles) ? d.articles : [] };
  } catch (e) { return { t: 0, v: 1, articles: [] }; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

function uid() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
}

export async function onRequestGet(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);

    const url = new URL(ctx.request.url);
    const id = url.pathname.split('/').pop();
    const d = await readBlog(ctx.env);

    if (id && id !== 'blog') {
      const article = d.articles.find(function (a) { return a.id === id; });
      if (!article) return json({ ok: false, error: '文章不存在' }, 404);
      return json({ ok: true, article: article });
    }

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || '10', 10)));
    const statusFilter = url.searchParams.get('status') || '';

    let list = d.articles.slice();
    if (statusFilter) {
      list = list.filter(function (a) { return a.status === statusFilter; });
    }
    list.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const total = list.length;
    const start = (page - 1) * size;
    const pageItems = list.slice(start, start + size).map(function (a) {
      return {
        id: a.id, title: a.title, summary: a.summary,
        status: a.status, announce: !!a.announce, pinned: a.pinned, hidden: a.hidden,
        createdAt: a.createdAt, updatedAt: a.updatedAt
      };
    });

    return json({ ok: true, t: d.t, articles: pageItems, page: page, size: size, total: total });
  } catch (e) {
    return json({ ok: false, error: '读取异常：' + e.message }, 500);
  }
}

export async function onRequestPost(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);

    const body = await ctx.request.json();
    const title = String(body.title || '').trim();
    if (!title) return json({ ok: false, error: '标题不能为空' }, 400);

    const d = await readBlog(ctx.env);
    const now = Date.now();
    const id = body.id || uid();

    const idx = d.articles.findIndex(function (a) { return a.id === id; });
    const article = {
      id: id,
      title: title.slice(0, 200),
      summary: String(body.summary || '').trim().slice(0, 500),
      content: String(body.content || ''),
      status: body.status === 'draft' ? 'draft' : 'published',
      announce: !!body.announce,
      pinned: !!body.pinned,
      hidden: !!body.hidden,
      createdAt: idx >= 0 ? d.articles[idx].createdAt : now,
      updatedAt: now
    };

    if (idx >= 0) {
      d.articles[idx] = article;
    } else {
      d.articles.unshift(article);
    }

    const next = { t: now, v: 1, articles: d.articles };
    const payload = JSON.stringify(next);
    if (payload.length > MAX_BYTES) return json({ ok: false, error: '博客数据过大，请删除旧文章后再保存' }, 413);

    await ctx.env.EARNINGS_KV.put(KV_KEY, payload);
    return json({ ok: true, id: id, t: next.t });
  } catch (e) {
    return json({ ok: false, error: '保存异常：' + e.message }, 500);
  }
}

export async function onRequestDelete(ctx) {
  try {
    const authed = await isAuthed(ctx.env, ctx.request);
    if (!authed) return json({ ok: false, error: '未授权' }, 401);

    const url = new URL(ctx.request.url);
    const id = url.pathname.split('/').pop();
    if (!id || id === 'blog') return json({ ok: false, error: '缺少文章 ID' }, 400);

    const d = await readBlog(ctx.env);
    const beforeLen = d.articles.length;
    d.articles = d.articles.filter(function (a) { return a.id !== id; });
    if (d.articles.length === beforeLen) return json({ ok: false, error: '文章不存在' }, 404);

    const next = { t: Date.now(), v: 1, articles: d.articles };
    await ctx.env.EARNINGS_KV.put(KV_KEY, JSON.stringify(next));
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: '删除异常：' + e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}

export async function onRequest(ctx) {
  if (ctx.request.method === 'OPTIONS') return onRequestOptions();
  if (ctx.request.method === 'GET') return onRequestGet(ctx);
  if (ctx.request.method === 'POST') return onRequestPost(ctx);
  if (ctx.request.method === 'DELETE') return onRequestDelete(ctx);
  return json({ ok: false, error: '不支持的方法' }, 405);
}
