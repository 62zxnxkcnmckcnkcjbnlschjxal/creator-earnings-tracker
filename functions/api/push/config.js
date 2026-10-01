/**
 * GET/POST /api/push/config — 读取/保存 Bark Key
 */
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestGet(ctx) {
  try {
    const key = await ctx.env.EARNINGS_KV.get('push_bark_key');
    return json({ ok: true, barkKey: key || '' });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPost(ctx) {
  try {
    const body = await ctx.request.json();
    await ctx.env.EARNINGS_KV.put('push_bark_key', String(body.barkKey || '').trim());
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
