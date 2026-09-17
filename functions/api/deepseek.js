/**
 * Cloudflare Pages Function —— DeepSeek API 代理
 * POST /api/deepseek  转发聊天请求到 api.deepseek.com
 * GET  /api/deepseek?action=verify&apiKey=sk-...        验证密钥有效性（本地密钥）
 * GET  /api/deepseek?action=verify&source=env           验证服务器 env 密钥
 * GET  /api/deepseek?action=key-status                  查询服务器是否已配置密钥（只返回 true/false）
 *
 * 密钥优先级：Cloudflare Environment Variable (DEEPSEEK_API_KEY) > 请求传入的 apiKey
 * 解决浏览器直连 DeepSeek API 的 CORS 与密钥暴露问题
 */

export async function onRequestPost(ctx) {
  try {
    const body = await ctx.request.json();
    const { messages, apiKey, stream = false } = body;

    if (!messages || !Array.isArray(messages)) {
      return json({ error: 'messages 必须是数组' }, 400);
    }

    // 优先从 Cloudflare 加密环境变量读取，未配置时回退到请求中的 apiKey
    const envKey = ctx.env.DEEPSEEK_API_KEY;
    const finalKey = (envKey && typeof envKey === 'string' && envKey.startsWith('sk-')) ? envKey : apiKey;

    if (!finalKey || typeof finalKey !== 'string') {
      return json({ error: '缺少 apiKey（服务器未配置 DEEPSEEK_API_KEY，且请求未提供）' }, 400);
    }

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${finalKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        stream
      })
    });

    // 透传响应（含流式）
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return json({ error: '代理异常：' + e.message }, 500);
  }
}

export async function onRequestGet(ctx) {
  try {
    const url = new URL(ctx.request.url);
    const action = url.searchParams.get('action');
    const apiKey = url.searchParams.get('apiKey');
    const source = url.searchParams.get('source') || 'local';

    if (action === 'key-status') {
      // 只返回 true/false，绝不返回密钥本身
      const hasEnvKey = !!(ctx.env.DEEPSEEK_API_KEY && typeof ctx.env.DEEPSEEK_API_KEY === 'string' && ctx.env.DEEPSEEK_API_KEY.startsWith('sk-'));
      return json({ configured: hasEnvKey });
    }

    if (action === 'verify') {
      let finalKey;
      if (source === 'env') {
        // 验证服务器配置的 env 密钥
        finalKey = ctx.env.DEEPSEEK_API_KEY;
        if (!finalKey || typeof finalKey !== 'string') {
          return json({ error: '服务器未配置 DEEPSEEK_API_KEY' }, 400);
        }
      } else {
        // 验证本地提供的密钥
        if (!apiKey || typeof apiKey !== 'string') {
          return json({ error: '缺少 apiKey' }, 400);
        }
        finalKey = apiKey;
      }

      // 使用轻量 balance 接口验证密钥（比 chat/completions 更快更便宜）
      const res = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${finalKey}`,
          'Accept': 'application/json'
        }
      });

      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return json({ error: '不支持的操作，请使用 action=verify 或 action=key-status' }, 400);
  } catch (e) {
    return json({ error: '代理异常：' + e.message }, 500);
  }
}

export async function onRequestOptions(ctx) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
