// functions/api/state.js
export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.EARNINGS_KV;
  const key = "app_data";

  // GET：读取数据
  if (request.method === "GET") {
    const raw = await kv.get(key);
    return new Response(raw || JSON.stringify({t:0, activities:[]}), {
      headers: {"Content-Type":"application/json"}
    });
  }

  // PUT：写入数据
  if (request.method === "PUT") {
    const payload = await request.text();
    await kv.put(key, payload);
    return new Response("ok", {status:200});
  }

  return new Response("method not allowed", {status:405});
}
