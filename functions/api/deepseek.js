/**
 * Cloudflare Pages Function —— DeepSeek / 腾讯云 TokenHub 多模型代理（创作者工作台同步版）
 * POST /api/deepseek    转发聊天请求
 *   body: { provider:'deepseek'|'tencent', model, messages, apiKey, stream }
 *   provider=deepseek → api.deepseek.com（官方，env DEEPSEEK_API_KEY）
 *   provider=tencent  → tokenhub.tencentmaas.com（腾讯云 TokenHub，env TENCENT_API_KEY）
 *   图片：messages 支持 OpenAI 多模态格式 [{type:'text'},{type:'image_url',image_url:{url:'data:...'}}]
 * GET /api/deepseek?action=key-status            服务器密钥配置状态
 * GET /api/deepseek?action=verify&provider=...   验证密钥（官方走 balance，腾讯走 /v1/models）
 * GET /api/deepseek?action=models&provider=tencent  拉取 TokenHub 可用模型列表
 *
 * 密钥优先级：Cloudflare 环境变量 > 请求传入的 apiKey
 */

const PROVIDERS = {
  deepseek: {
    base: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat'
  },
  tencent: {
    base: 'https://tokenhub.tencentmaas.com',
    envKey: 'TENCENT_API_KEY',
    defaultModel: 'deepseek-v4-flash'
  }
};

// TokenHub API 的 model 参数规范化（控制台服务ID 与 API 模型名不同）
// 控制台展示 deepseek/deepseek-flash，但 API 必须用 deepseek-v4-flash，否则 400
const TENCENT_MODEL_ALIAS = {
  'deepseek/deepseek-flash': 'deepseek-v4-flash',
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp'
};
function normalizeModel(provider, model) {
  if (provider !== 'tencent') return model;
  return TENCENT_MODEL_ALIAS[model] || model;
}

function pickProvider(name) {
  // auto：自动模式（见 resolveProvider）
  if (name === 'auto') return 'auto';
  return PROVIDERS[name] ? name : 'deepseek';
}

function getEnvKey(env, provider) {
  const p = PROVIDERS[provider];
  const v = env[p.envKey];
  return (v && typeof v === 'string' && v.trim()) ? v.trim() : '';
}

// 判断消息中是否包含图片
function hasImage(messages) {
  return Array.isArray(messages) && messages.some(function (m) {
    return m && Array.isArray(m.content) && m.content.some(function (c) {
      return c && c.type === 'image_url';
    });
  });
}

// 自动模式：带图 → 腾讯视觉模型；纯文本 → 官方（官方 key 未配则腾讯）
function resolveProvider(env, provider, withImg) {
  if (provider !== 'auto') return provider;
  if (withImg) return 'tencent';
  return getEnvKey(env, 'deepseek') ? 'deepseek' : (getEnvKey(env, 'tencent') ? 'tencent' : 'deepseek');
}

/* ================= POST /api/deepseek ================= */
export async function onRequestPost(ctx) {
  try {
    const body = await ctx.request.json();
    const requested = pickProvider(body.provider);
    const { messages, apiKey, stream = false } = body;

    if (!messages || !Array.isArray(messages)) {
      return json({ error: 'messages 必须是数组' }, 400);
    }

    // 最终供应商与模型
    const withImg = hasImage(messages);
    const provider = resolveProvider(ctx.env, requested, withImg);
    const p = PROVIDERS[provider];
    const rawModel = (body.model && String(body.model).trim()) || '';
    const model = normalizeModel(provider, (!rawModel || rawModel === 'auto') ? p.defaultModel : rawModel);

    // 密钥：CF 环境变量优先，未配置回退到请求中的 apiKey
    const envKey = getEnvKey(ctx.env, provider);
    const finalKey = envKey || (apiKey && typeof apiKey === 'string' ? apiKey.trim() : '');

    if (!finalKey) {
      return json({ error: '缺少 apiKey（服务器未配置 ' + p.envKey + '，且请求未提供）' }, 400);
    }

    const res = await fetch(p.base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + finalKey
      },
      body: JSON.stringify({ model, messages, stream })
    });

    // 透传响应（含流式）；非 2xx 时读取 body 包装成 JSON，给前端明确原因
    if (res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    const errBody = await res.text();
    let errMsg = errBody;
    try { const o = JSON.parse(errBody); errMsg = (o && (o.error && (o.error.message || o.error)) || o.message) || errBody; } catch (e) { /* 纯文本 */ }
    if (String(errMsg).indexOf('404') >= 0 || res.status === 404) {
      errMsg = '模型未开通或不可用（TokenHub 返回 404）：请在腾讯云控制台确认该模型已领取/开通，或换用 DeepSeek-V4.1-Flash';
    }
    return json({ error: String(errMsg).slice(0, 300) }, res.status);
  } catch (e) {
    return json({ error: '代理异常：' + e.message }, 500);
  }
}

/* ================= GET /api/deepseek ================= */
export async function onRequestGet(ctx) {
  try {
    const url = new URL(ctx.request.url);
    const action = url.searchParams.get('action');
    const provider = pickProvider(url.searchParams.get('provider'));
    const p = PROVIDERS[provider];

    if (action === 'key-status') {
      // 只返回 true/false，绝不返回密钥本身
      const hasDeepSeek = !!(getEnvKey(ctx.env, 'deepseek'));
      const hasTencent = !!(getEnvKey(ctx.env, 'tencent'));
      return json({
        configured: hasDeepSeek,          // 向后兼容旧前端
        deepseek: hasDeepSeek,
        tencent: hasTencent
      });
    }

    if (action === 'models') {
      // 拉取 TokenHub 可用模型列表（需腾讯密钥）
      const key = getEnvKey(ctx.env, provider) || url.searchParams.get('apiKey') || '';
      if (!key) return json({ error: '缺少腾讯云 API Key' }, 400);
      const res = await fetch(p.base + '/v1/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + key }
      });
      const body = await res.text();
      // 规范化模型 id（控制台服务ID → API 可用模型名），避免前端拿到无法调用的 id
      try {
        const obj = JSON.parse(body);
        if (obj && Array.isArray(obj.data)) {
          obj.data = obj.data.map(function (md) {
            if (!md || !md.id) return md;
            const id = normalizeModel('tencent', String(md.id));
            return (id === md.id) ? md : Object.assign({}, md, { id: id });
          });
          return new Response(JSON.stringify(obj), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch (e) { /* 非 JSON 直接透传 */ }
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (action === 'verify') {
      const source = url.searchParams.get('source') || 'local';
      const apiKey = url.searchParams.get('apiKey');
      let finalKey;
      if (source === 'env') {
        finalKey = getEnvKey(ctx.env, provider);
        if (!finalKey) return json({ error: '服务器未配置 ' + p.envKey }, 400);
      } else {
        if (!apiKey || typeof apiKey !== 'string') return json({ error: '缺少 apiKey' }, 400);
        finalKey = apiKey.trim();
      }

      // 官方走轻量 balance 接口，腾讯走 /v1/models
      const target = provider === 'tencent'
        ? p.base + '/v1/models'
        : p.base + '/user/balance';
      const res = await fetch(target, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + finalKey,
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

    return json({ error: '不支持的操作' }, 400);
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
