// Pages Functions: /img/* — 西松屋商品画像の read-through ミラー (R2 永続キャッシュ)
//
// 目的: 訪問者のブラウザから www.24028-net.jp へ画像を直接取りに行かせない。
//   - ホットリンク対策やIPレート制限が画像に導入された場合の一斉表示崩れを防ぐ
//   - ユーザーIPが西松屋側で制限されるリスクをゼロにする
//   - 原本サーバーへのリクエストは「1画像につき生涯1回」に激減する
//
// 動作: エッジキャッシュ → R2 → (無ければ) 原本を1回取得して R2 に保存し配信。
// 原本が後日取得不能になっても、R2 に保存済みの画像は配信され続ける (last-good)。
// 掲載終了画像の削除要請等があれば R2 バケットを消すだけで即応できる。

const ORIGIN_BASE = 'https://www.24028-net.jp/client_info/N24028/itemimage/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// itemimage 配下の画像パスのみ許可 (オープンプロキシ化・パストラバーサル防止)
const KEY_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*(\/[0-9A-Za-z][0-9A-Za-z._-]*)*\.(jpe?g|png|gif|webp)$/i;

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const segs = Array.isArray(params.path) ? params.path : [params.path];
  const key = segs.join('/');
  if (key.length > 200 || !KEY_RE.test(key)) {
    return new Response('bad image path', { status: 400 });
  }

  // 1) エッジキャッシュ
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const serve = (body, ctype, source) => {
    const res = new Response(body, {
      headers: {
        'content-type': ctype,
        'cache-control': 'public, max-age=2592000, immutable', // 品番単位の画像は実質不変
        'access-control-allow-origin': '*',
        'x-img-source': source,
      },
    });
    context.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  };

  // 2) R2 (保存済みミラー)。ストリーム+clone+cache.put の組合せはローカルworkerdで
  //    ストールするため、バッファ化してから配信する (画像は数十KB程度)。
  const obj = await env.COORDE_IMG.get(key);
  if (obj) {
    const ctype = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg';
    return serve(await obj.arrayBuffer(), ctype, 'r2');
  }

  // 3) 原本から1回だけ取得して R2 へ保存 (read-through)
  const upstream = await fetch(ORIGIN_BASE + key, {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.24028-net.jp/', 'Accept': 'image/*,*/*' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok) return new Response('upstream ' + upstream.status, { status: 502 });
  const ctype = upstream.headers.get('content-type') || '';
  if (!ctype.startsWith('image/')) return new Response('not an image', { status: 415 });

  const buf = await upstream.arrayBuffer();
  try {
    await env.COORDE_IMG.put(key, buf, { httpMetadata: { contentType: ctype } });
  } catch { /* 保存に失敗しても配信は継続 (次回リクエストで再試行される) */ }
  return serve(buf, ctype, 'origin-stored');
}
