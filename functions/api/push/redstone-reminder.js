/**
 * Cloudflare Pages Function —— 红石提醒推送
 * GET /api/push/redstone-reminder — 检查下周红石日程，有就推 Bark
 * 
 * KV 键：
 * - sky_schedule: 红石日程数组 [{date, type, map, times}]
 * - push_bark_key: Bark 推送 Key
 */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestGet(ctx) {
  try {
    const kv = ctx.env.EARNINGS_KV;
    if (!kv) return json({ error: 'KV 未绑定' }, 500);

    // 读 Bark Key
    const barkKey = await kv.get('push_bark_key');
    if (!barkKey) return json({ error: '未配置 Bark Key' });

    // 读红石日程
    const raw = await kv.get('sky_schedule');
    if (!raw) return json({ error: '没有红石日程数据' });
    const items = JSON.parse(raw);

    // 找下周（周五~周日）的红石
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayOfWeek = today.getDay(); // 0=周日, 5=周五, 6=周六

    // 计算本周五、周六、周日的日期
    const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
    const friday = new Date(today); friday.setDate(today.getDate() + daysUntilFriday);
    const saturday = new Date(friday); saturday.setDate(friday.getDate() + 1);
    const sunday = new Date(friday); sunday.setDate(friday.getDate() + 2);

    const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const friStr = fmt(friday), satStr = fmt(saturday), sunStr = fmt(sunday);

    const redstoneDays = items.filter(it => 
      it.type === '红石' && [friStr, satStr, sunStr].includes(it.date)
    );

    if (!redstoneDays.length) {
      return json({ ok: true, message: '本周末没有红石', pushed: false });
    }

    // 组消息
    const dayNames = { [friStr]: '周五', [satStr]: '周六', [sunStr]: '周日' };
    const lines = redstoneDays.map(it => {
      const dayName = dayNames[it.date] || it.date;
      const times = (it.times && it.times.length) ? it.times.join(' / ') : '时间待确认';
      return dayName + ' ' + it.map + ' ' + times;
    });

    const title = '🔴 周末红石提醒（' + redstoneDays.length + '天）';
    const body = lines.join('\n');

    // 推 Bark
    const res = await fetch('https://api.day.app/' + barkKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        body: body,
        group: '红石提醒',
        url: 'https://skyzyf335.top/#/攻略',
        icon: 'https://skyzyf335.top/icons/icon-192.png'
      })
    });

    return json({ ok: true, pushed: true, days: redstoneDays.length, body: body, barkStatus: res.status });
  } catch (e) {
    return json({ error: '异常：' + e.message }, 500);
  }
}
