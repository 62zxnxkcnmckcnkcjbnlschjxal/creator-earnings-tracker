/**
 * Cloudflare Pages Function —— 攻略 API 代理 + 图片云端缓存
 * GET /api/guide?url=<encodeURIComponent(目标URL)>            普通内容代理（JSON/文字，绕过 CORS）
 * GET /api/guide?url=<...>&img=1                              图片代理：优先返回 KV 云端缓存（dataURL），未缓存则拉取源站并缓存 30 天
 *
 * 依赖 KV 命名空间：EARNINGS_KV（与业务数据共用）
 * 缓存键：guide_img:<sha1(url)>，TTL 30 天
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// 递归解析"套娃链接"：目标不是直接图片时，从 JSON/HTML 里提取下一层链接继续拉（最多 3 层）
async function resolveImage(target, depth) {
  if (depth > 3) return null;
  let res;
  try { res = await fetch(target, { headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' } }); }
  catch (e) { return null; }
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('image/') === 0 || ct.indexOf('svg') >= 0) {
    const buf = await res.arrayBuffer();
    const finalCt = (ct.indexOf('image/') === 0) ? ct.split(';')[0] : 'image/svg+xml';
    return 'data:' + finalCt + ';base64,' + b64FromBuffer(buf);
  }
  const text = await res.text();
  // 1) JSON：提取 url/image/img/data/pic 字段（字符串 URL）或数组第一项
  try {
    const j = JSON.parse(text);
    const u = j.url || j.image || j.img || j.data || j.pic || j.thumb;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return resolveImage(u, depth + 1);
    if (Array.isArray(u) && u.length) {
      const f = u[0];
      if (typeof f === 'string' && /^https?:\/\//i.test(f)) return resolveImage(f, depth + 1);
    }
  } catch (e) { /* 非 JSON */ }
  // 2) HTML：og:image / <img src> / 图片扩展名链接
  const m = text.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<img[^>]+src=["']([^"']+)["']/i)
    || text.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s"'<>]*)?/i);
  if (m && m[1]) return resolveImage(m[1], depth + 1);
  return null;
}

async function sha1Hex(str) {
  try {
    const data = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  } catch (e) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return 'h' + (h >>> 0).toString(36);
  }
}

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestGet(ctx) {
  try {
    const url = new URL(ctx.request.url);
    const target = (url.searchParams.get('url') || '').trim();
    const isImg = url.searchParams.get('img') === '1';
    if (!target || !/^https?:\/\//i.test(target)) {
      return json({ error: '缺少 url 参数（需 http(s):// 开头）' }, 400);
    }

    // ===== 图片模式：KV 云端缓存优先 =====
    if (isImg) {
      const key = 'guide_img:' + await sha1Hex(target);
      try {
        const cached = await ctx.env.EARNINGS_KV.get(key);
        if (cached && cached.indexOf('base64,') > 0) {
          return new Response(cached, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public,max-age=86400', 'Access-Control-Allow-Origin': '*' } });
        }
      } catch (e) { /* KV 不可用时直接拉源站 */ }

      const dataUrl = await resolveImage(target, 0);
      if (!dataUrl) return json({ error: '无法解析为图片（多层链接均无效）' }, 400);
      try {
        await ctx.env.EARNINGS_KV.put(key, dataUrl, { expirationTtl: 30 * 24 * 3600 });
      } catch (e) { /* 缓存失败不影响返回 */ }
      return new Response(dataUrl, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public,max-age=86400', 'Access-Control-Allow-Origin': '*' } });
    }

    // ===== 普通内容代理（JSON / 文本，绕过 CORS） =====
    const res = await fetch(target, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' } });
    const text = await res.text();
    const ct = res.headers.get('content-type') || 'text/plain; charset=utf-8';
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return json({ error: '攻略代理异常：' + (e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}

export async function onRequest(ctx) {
  if (ctx.request.method === 'OPTIONS') return onRequestOptions();
  if (ctx.request.method === 'GET') return onRequestGet(ctx);
  return json({ error: '不支持的方法' }, 405);
}
