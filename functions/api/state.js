/**
 * Cloudflare Pages Functions —— 云端同步接口
 * GET  /api/state  读取云端数据
 * PUT  /api/state  写入云端数据（覆盖式，最后写入者胜）
 *
 * 绑定：EARNINGS_KV（Cloudflare KV 命名空间，免费额度 1GB / 10万读 / 1千写 每天）
 * 存储键：creator_earnings_state
 * 数据格式：{ "t": 时间戳, "activities": [...] }
 */
const KV_KEY = 'creator_earnings_state';
const MAX_BYTES = 512 * 1024; // 512KB 上限，正常数据远小于此

export async function onRequestGet(ctx) {
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

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
