// Pages Functions: /api/* — KV のデータ配信 + 画像プロキシ
//
// /api/data.json 等: cron Worker が KV に書いた最新データを返す。
// KV に無ければデプロイ同梱の静的ファイル (public/*.json) にフォールバック。
// /api/img?u=<URL>: 他ブランドコーナー画像のプロキシ (ホットリンク拒否対策)。

const JSON_KEYS = new Set(['data.json', 'bottoms.json', 'cheap.json', 'uniqlo.json', 'corners.json', 'status.json']);
const FEED_KEYS = new Set(['feed.xml']);

// 画像プロキシで許可するホスト (それ以外は拒否 — オープンプロキシ化防止)
const IMG_HOSTS = new Set([
  'lp2.hm.com', 'image.hm.com', 'lp.assets.hm.com', 'www2.hm.com',
  'static.zara.net',
  'www.hiraki.co.jp',
  'www.gap.co.jp',
  'im.uniqlo.com', 'image.uniqlo.com', 'www.uniqlo.com',
  'www.24028-net.jp',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const segs = Array.isArray(params.path) ? params.path : [params.path];
  const name = segs.join('/');
  const url = new URL(request.url);

  // ---- 画像プロキシ ----
  if (name === 'img') {
    const target = url.searchParams.get('u') || '';
    let t;
    try { t = new URL(target); } catch { return new Response('bad url', { status: 400 }); }
    if (t.protocol !== 'https:' || t.port !== '' || !IMG_HOSTS.has(t.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // redirect: 'manual' — 許可ホスト上のオープンリダイレクト経由での許可リスト迂回を防ぐ
    const upstream = await fetch(t.toString(), {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/', 'Accept': 'image/*,*/*' },
      redirect: 'manual',
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!upstream.ok) return new Response('upstream ' + upstream.status, { status: 502 });
    const ctype = upstream.headers.get('content-type') || '';
    if (!ctype.startsWith('image/')) return new Response('not an image', { status: 415 });
    const res = new Response(upstream.body, {
      headers: {
        'content-type': ctype,
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      },
    });
    context.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  // ---- KV データ配信 (静的フォールバック付き) ----
  if (JSON_KEYS.has(name) || FEED_KEYS.has(name)) {
    const ct = FEED_KEYS.has(name)
      ? 'application/rss+xml; charset=utf-8'
      : 'application/json; charset=utf-8';
    const kv = env.COORDE_KV ? await env.COORDE_KV.get(name) : null;
    if (kv !== null && kv !== undefined) {
      return new Response(kv, {
        headers: { 'content-type': ct, 'cache-control': 'public, max-age=300', 'x-data-source': 'kv' },
      });
    }
    // フォールバック: デプロイ同梱の静的ファイル
    const staticRes = await env.ASSETS.fetch(new URL('/' + name, url.origin));
    if (staticRes.ok) {
      return new Response(staticRes.body, {
        headers: { 'content-type': ct, 'cache-control': 'public, max-age=300', 'x-data-source': 'static' },
      });
    }
    return new Response(JSON.stringify({ error: 'no data yet' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  return new Response('not found', { status: 404 });
}
