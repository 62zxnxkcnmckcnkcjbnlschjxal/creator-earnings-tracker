/**
 * Cloudflare Pages Function —— 光遇碎石日程（红石/黑石日历）
 * GET  /api/sky-schedule                    读取 KV 日程（公开，前端日历渲染）
 * POST /api/sky-schedule  {text:"播报文本"}  调 DeepSeek 解析为结构化日程 → 合并写入 KV
 *
 * 依赖：KV EARNINGS_KV；Secret DEEPSEEK_API_KEY
 * KV 键：sky_schedule（日程数组）、sky_schedule_meta（{updated,source}）
 */

const SKY_KEY = 'sky_schedule';
const SKY_META = 'sky_schedule_meta';

const SYSTEM_PROMPT = '你是光遇游戏的碎石（红石/黑石）日程解析器。用户会给你一段光遇碎石播报文字，请严格提取其中的碎石信息。';

function buildPrompt(text) {
  return [
    '从以下播报文本中提取所有碎石（红石/黑石）信息，输出一个 JSON 数组，不要输出任何其他内容：',
    '[{"date":"YYYY-MM-DD","type":"红石","map":"地图名","times":["07:08","13:08","19:08"],"note":"备注(可空)"}]',
    '规则：',
    '1. type 只能是"红石"或"黑石"；',
    '2. date 是碎石落下的日期，必须是 YYYY-MM-DD 格式（如果文本只有星期几，请推算成日期）；',
    '3. times 是该日碎石降落场次时间列表（通常3场），如 ["07:08","13:08","19:08"]，没有则给空数组；',
    '4. map 是地图名（如云野、雨林、圣岛等）；',
    '5. 如果文本提到"今天"，按今天（' + new Date().toISOString().slice(0,10) + '）处理；提到"本周"，按本周的日期推算；',
    '6. 只输出 JSON 数组本身，不要代码块标记，不要解释。',
    '',
    '播报文本：',
    text
  ].join('\n');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

// 从 AI 输出中提取 JSON 数组并规范化
function parseItems(content) {
  if (!content) return [];
  let raw = String(content).trim();
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) raw = m[0];
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(function (it) { return it && (it.date || it.map || it.type); })
    .map(function (it) {
      var times = [];
      if (Array.isArray(it.times)) {
        times = it.times.map(function (t) { return String(t).trim(); }).filter(Boolean);
      } else if (typeof it.time === 'string') {
        times = it.time.split(/[,，、/\s]+/).filter(Boolean);
      } else if (it.times === undefined && it.time === undefined && typeof it.desc === 'string') {
        // 描述里可能带时间，尽力提取
        var mm = String(it.desc).match(/\d{1,2}:\d{2}/g) || [];
        times = mm.slice(0, 6);
      }
      var type = String(it.type || '').replace(/[\[\]]/g, '');
      if (type.indexOf('黑') >= 0 || type.indexOf('黑石') >= 0) type = '黑石';
      else if (type.indexOf('红') >= 0 || type.indexOf('红石') >= 0) type = '红石';
      var date = String(it.date || '').trim();
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';
      return {
        date: date,
        type: type === '红石' || type === '黑石' ? type : '红石',
        map: String(it.map || it.place || it.location || '').trim(),
        times: times.slice(0, 6),
        note: String(it.note || '').trim()
      };
    })
    .filter(function (it) { return it.date && it.map; });
}

export async function onRequestGet(ctx) {
  try {
    const raw = await ctx.env.EARNINGS_KV.get(SKY_KEY);
    let items = [];
    try { items = raw ? JSON.parse(raw) : []; } catch (e) {}
    const metaRaw = await ctx.env.EARNINGS_KV.get(SKY_META);
    let meta = { updated: 0, source: '' };
    try { meta = metaRaw ? JSON.parse(metaRaw) : meta; } catch (e) {}
    return json({ ok: true, items: items, updated: meta.updated || 0, source: meta.source || '' });
  } catch (e) {
    return json({ ok: false, error: '读取失败：' + (e && e.message ? e.message : e) }, 500);
  }
}

async function readItems(env) {
  const raw = await env.EARNINGS_KV.get(SKY_KEY);
  let existing = [];
  try { existing = raw ? JSON.parse(raw) : []; } catch (e) {}
  return Array.isArray(existing) ? existing : [];
}

async function writeItems(env, items) {
  await env.EARNINGS_KV.put(SKY_KEY, JSON.stringify(items));
  await env.EARNINGS_KV.put(SKY_META, JSON.stringify({ updated: Date.now(), source: 'manual' }));
}

function keyOf(it) { return (it.date || '') + '|' + (it.type || '') + '|' + (it.map || ''); }

export async function onRequestPost(ctx) {
  try {
    let body;
    try { body = await ctx.request.json(); } catch (e) { return json({ ok: false, error: '请求体不是 JSON' }, 400); }
    const action = body.action || 'ai';

    // ===== 手动添加 =====
    if (action === 'add') {
      const it = body.item || {};
      const date = String(it.date || '').trim();
      const map = String(it.map || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !map) return json({ ok: false, error: '日期（YYYY-MM-DD）和地图必填' }, 400);
      const type = String(it.type || '红石').indexOf('黑') >= 0 ? '黑石' : '红石';
      const times = Array.isArray(it.times) ? it.times.map(String).filter(Boolean).slice(0, 6) : [];
      const item = { date: date, type: type, map: map, times: times, note: String(it.note || '').trim() };
      const existing = await readItems(ctx.env);
      const merged = existing.filter(function (x) { return keyOf(x) !== keyOf(item); }).concat(item);
      merged.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
      await writeItems(ctx.env, merged);
      return json({ ok: true, items: merged, updated: Date.now() });
    }

    // ===== 手动删除 =====
    if (action === 'del') {
      const key = String(body.key || '');
      if (!key) return json({ ok: false, error: '缺少 key' }, 400);
      const existing = await readItems(ctx.env);
      const merged = existing.filter(function (x) { return keyOf(x) !== key; });
      await writeItems(ctx.env, merged);
      return json({ ok: true, items: merged, updated: Date.now() });
    }

    // ===== AI 解析更新 =====
    const envKey = ctx.env.DEEPSEEK_API_KEY;
    if (!envKey || typeof envKey !== 'string' || !envKey.trim()) {
      return json({ ok: false, error: '服务器未配置 DEEPSEEK_API_KEY' }, 400);
    }
    const text = String(body.text || '').trim();
    if (!text) return json({ ok: false, error: '请提供播报文本' }, 400);

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + envKey
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(text) }
        ],
        temperature: 0.1,
        stream: false
      })
    });
    if (!res.ok) return json({ ok: false, error: 'DeepSeek 调用失败 HTTP ' + res.status }, 502);
    const data = await res.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const items = parseItems(content);
    if (!items.length) return json({ ok: false, error: 'AI 未能解析出日程，请检查文本是否包含碎石播报' }, 400);

    // 合并写入：与现有日程按 (date|type|map) 去重
    const existing = await readItems(ctx.env);
    const seen = {};
    items.forEach(function (it) { seen[keyOf(it)] = true; });
    const merged = items.concat(existing.filter(function (it) { return !seen[keyOf(it)]; }));
    merged.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });

    await ctx.env.EARNINGS_KV.put(SKY_KEY, JSON.stringify(merged));
    await ctx.env.EARNINGS_KV.put(SKY_META, JSON.stringify({ updated: Date.now(), source: 'ai' }));
    return json({ ok: true, items: merged, updated: Date.now() });
  } catch (e) {
    return json({ ok: false, error: '更新失败：' + (e && e.message ? e.message : e) }, 500);
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
  return json({ error: '不支持的方法' }, 405);
}
