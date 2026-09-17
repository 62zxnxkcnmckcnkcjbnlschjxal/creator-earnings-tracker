/**
 * Cloudflare Pages Function —— 网易云音乐接口代理
 * GET /api/music?type=playlist&id=xxx&cookie=xxx  获取歌单
 * GET /api/music?type=url&id=xxx                   获取歌曲外链
 * GET /api/music?type=detail&id=xxx                获取歌曲详情
 *
 * 解决浏览器直连网易云接口的 CORS 限制
 */

const FALLBACK_PL = '3778678'; // 热歌榜（公开歌单，无需登录）

async function ncmFetch(url, cookie) {
  const headers = {
    'Referer': 'https://music.163.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  const res = await fetch(url, { headers });
  return res;
}

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');
  const cookie = url.searchParams.get('cookie') || '';

  if (!type || !id) {
    return json({ error: '缺少参数：type 和 id 必填' }, 400);
  }

  try {
    if (type === 'playlist') {
      return await getPlaylist(id, cookie);
    }
    if (type === 'url') {
      return await getSongUrl(id);
    }
    if (type === 'detail') {
      return await getSongDetail(id);
    }
    return json({ error: '不支持的 type' }, 400);
  } catch (e) {
    return json({ error: '代理异常：' + e.message }, 500);
  }
}

async function getPlaylist(id, cookie) {
  const res = await ncmFetch(
    `https://music.163.com/api/playlist/detail?id=${id}&n=500`,
    cookie
  );
  const data = await res.json();

  if (data.code === -1) {
    return json({ error: '网易云服务暂时不可用', code: data.code }, 502);
  }

  const needLogin = data.code !== 200 || !data.result;

  if (needLogin && id !== FALLBACK_PL) {
    const fallbackRes = await ncmFetch(
      `https://music.163.com/api/playlist/detail?id=${FALLBACK_PL}&n=500`,
      cookie
    );
    const fb = await fallbackRes.json();

    if (fb.code === 200 && fb.result) {
      const tracks = (fb.result.tracks || []).map(t => ({
        id: String(t.id),
        name: t.name,
        artists: (t.artists || []).map(a => a.name).filter(Boolean).join(', '),
        album: t.album?.name || '',
        picUrl: t.album?.picUrl || '',
        duration: t.duration || 0
      }));
      return json({
        id: FALLBACK_PL,
        name: fb.result.name || '热歌榜',
        cover: fb.result.coverImgUrl || '',
        songs: tracks,
        fallback: true,
        originalId: id,
        message: '原歌单需要登录，已自动切换到热歌榜'
      });
    }
  }

  if (needLogin) {
    return json({
      error: '该歌单需要网易云登录，请在设置中填写 Cookie',
      code: data.code,
      needLogin: true
    }, 200);
  }

  const tracks = (data.result.tracks || []).map(t => ({
    id: String(t.id),
    name: t.name,
    artists: (t.artists || []).map(a => a.name).filter(Boolean).join(', '),
    album: t.album?.name || '',
    picUrl: t.album?.picUrl || '',
    duration: t.duration || 0
  }));

  return json({
    id,
    name: data.result.name || '',
    cover: data.result.coverImgUrl || '',
    songs: tracks
  });
}

async function getSongUrl(id) {
  const url = `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
  return json({ id, url });
}

async function getSongDetail(id) {
  const res = await ncmFetch(`https://music.163.com/api/song/detail?ids=[${id}]`);
  const data = await res.json();
  const song = data.songs?.[0];
  if (!song) {
    return json({ error: '歌曲不存在' }, 404);
  }
  return json({
    id: String(song.id),
    name: song.name,
    artists: (song.artists || []).map(a => a.name).filter(Boolean).join(', '),
    album: song.album?.name || '',
    picUrl: song.album?.picUrl || '',
    duration: song.duration || 0
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
