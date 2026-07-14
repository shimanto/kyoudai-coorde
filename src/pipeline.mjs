// kyoudai-coorde 共有パイプライン (Node / Cloudflare Worker 両対応)
//
// データソースは西松屋の検索基盤 NaviPlus (nishimatsuya-f-s.snva.jp) の
// json_grouping API のみ。www.24028-net.jp 本体の在庫確認ページ
// (item_itemproperty_zaiko_sub.html) は 2026-07-08 以降 WAF で 403 になったため
// 使用しない。在庫情報は API の path ファセット（n9c=在庫あり で絞った
// SIZE/COLOR 集約）を唯一のソースとする。色×サイズ単位の実在庫マトリクスは
// 取得不能になったので、デザイン(品番)単位の在庫サイズ表示に割り切る。
//
// すべての関数は fetch 実装を注入可能 (fetchFn) — Worker 側で subrequest
// 予算のカウントに使う。

const NAVI_BASE = 'https://nishimatsuya-f-s.snva.jp/';
const IMG_BASE = 'https://www.24028-net.jp/client_info/N24028/itemimage/';
const ITEM_BASE = 'https://www.24028-net.jp';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const NAVI_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://www.24028-net.jp/',
  'Accept-Language': 'ja-JP',
};

export const PATHS = {
  tshirt: 'ITEM-商品カテゴリ:ITEM_WEAR-ウェア:ITEM_TOPS-トップス:ITEM_TSHIRT-Tシャツ',
  pants: 'ITEM-商品カテゴリ:ITEM_WEAR-ウェア:ITEM_BOTTOMS-ボトムス:ITEM_PANTS-パンツ・キュロット',
  leggings: 'ITEM-商品カテゴリ:ITEM_WEAR-ウェア:ITEM_BOTTOMS-ボトムス:ITEM_LEGGINGS-レギンス',
};

export const CHEAP_MAX_PRICE = 1000; // 税込

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- NaviPlus API ----------------

function naviUrl(path, offset, extra = {}) {
  const qs = new URLSearchParams({
    fmt: 'json_grouping', glimit: '1', gsort: 'price', limit: '60',
    n9c: '在庫あり', o: String(offset), sort: 'number6,Reco_purchase', style: '0',
    path, ...extra,
  });
  return NAVI_BASE + '?' + qs.toString();
}

async function fetchNaviPage(fetchFn, path, offset, extra) {
  const url = naviUrl(path, offset, extra);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, { headers: NAVI_HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.kotohaco || !json.kotohaco.result) throw new Error('unexpected response shape');
      return json.kotohaco;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`NaviPlus fetch failed (${path} o=${offset}): ${lastErr && lastErr.message}`);
}

// path文字列から SIZE-サイズ:S7-100cm → [{code,cm}] を抽出
function parseSizes(pathStr) {
  const sizes = [];
  const re = /SIZE-サイズ:(S\d+)-([\d.]+)cm/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(pathStr || '')) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    sizes.push({ code: m[1], cm: parseFloat(m[2]) });
  }
  return sizes.sort((a, b) => a.cm - b.cm);
}

function parseGender(pathStr) {
  const boys = /TARGET-対象:BOYS-男の子/.test(pathStr);
  const girls = /TARGET-対象:GIRLS-女の子/.test(pathStr);
  if (boys && !girls) return 'boys';
  if (girls && !boys) return 'girls';
  return 'unisex';
}

function parseFrontCategory(pathStr) {
  const m = (pathStr || '').match(/FRONT-フロントカテゴリ:([A-Z_]+)-([^\t:]+)/);
  return m ? { code: m[1], label: m[2] } : { code: '', label: '' };
}

function parseBrand(pathStr) {
  const m = (pathStr || '').match(/BRAND-ブランド:[A-Z_]+-([^\t:]+)(?::([A-Z_]+)-([^\t:]+))?/);
  if (!m) return '';
  return m[3] ? m[3] : m[1];
}

function parseColors(pathStr) {
  const set = new Set();
  const re = /COLOR-カラー:[^\t:]+-([^\t:]+)/g;
  let m;
  while ((m = re.exec(pathStr || '')) !== null) set.add(m[1]);
  return [...set];
}

// COLOR-カラー:CODE-表示名 → [{code, name}] (色別画像URLの組み立てに code が必要)
function parseColorDetails(pathStr) {
  const seen = new Set();
  const out = [];
  const re = /COLOR-カラー:([^\t:]+)-([^\t:]+)/g;
  let m;
  while ((m = re.exec(pathStr || '')) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ code: m[1], name: m[2] });
  }
  return out;
}

function toProduct(g) {
  const it = (g.items && g.items[0]) || {};
  const pathStr = it.path || '';
  const sizes = parseSizes(pathStr);
  return {
    hinban: g.value,
    title: it.title || '',
    price: it.price != null ? Number(it.price) : null,
    image: it.image ? IMG_BASE + it.image : '',
    url: it.url ? ITEM_BASE + it.url : '',
    sizes,
    sizeCms: sizes.map((s) => s.cm),
    gender: parseGender(pathStr),
    front: parseFrontCategory(pathStr),
    brand: parseBrand(pathStr),
    colors: parseColors(pathStr),
    colorDetails: parseColorDetails(pathStr),
    saleNote: (it.data1 || '').trim(),      // 例: "値下げしました！"
    stockNum: Number(it.number9) || null,   // number9 は在庫関連の数値 (参考値)
  };
}

// カテゴリを全ページ取得して products[] を返す。
// opts: { maxPrice (税込上限, ph に渡す), delayMs, maxPages }
export async function scrapeCategory(fetchFn, path, opts = {}) {
  const extra = {};
  if (opts.maxPrice != null) { extra.pl = '0'; extra.ph = String(opts.maxPrice); }
  const first = await fetchNaviPage(fetchFn, path, 0, extra);
  const info = first.result.info;
  const lastPage = Math.min(info.last_page, opts.maxPages || 30);
  const groups = [...first.result.groups];
  for (let p = 1; p < lastPage; p++) {
    await sleep(opts.delayMs != null ? opts.delayMs : 400);
    const k = await fetchNaviPage(fetchFn, path, p * 60, extra);
    groups.push(...k.result.groups);
  }
  return {
    indexUpdate: info.index_update_time,
    hitnum: info.hitnum,
    products: groups.map(toProduct),
    pagesFetched: lastPage,
  };
}

// ---------------- SKU(色×サイズ)在庫マトリクス ----------------
// q=<品番> のキーワード検索は items が SKU 単位で返る:
//   itemid = <品番>-<サイズコード>-<色コード>, narrow3 = "90cm", narrow5 = "グリーン"
// n9c=在庫あり なので「返ってきたSKU = 在庫あり」。1品番 = 1リクエスト。

export async function fetchSkuMatrix(fetchFn, hinban) {
  const qs = new URLSearchParams({
    fmt: 'json_grouping', glimit: '99', limit: '99', style: '0',
    n9c: '在庫あり', q: String(hinban),
  });
  const res = await fetchFn(NAVI_BASE + '?' + qs.toString(), { headers: NAVI_HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const groups = (((json.kotohaco || {}).result) || {}).groups || [];
  const g = groups.find((x) => String(x.value) === String(hinban));
  if (!g) return null; // 品番が見つからない(完売等)
  const colors = {}; // 色名 -> { code, sizes:[cm] }
  for (const it of g.items || []) {
    const cm = parseFloat(String(it.narrow3 || ''));
    const color = String(it.narrow5 || '').trim();
    if (!Number.isFinite(cm) || !color) continue;
    const idParts = String(it.itemid || '').split('-');
    const code = idParts.length >= 3 ? idParts[2] : '';
    const c = colors[color] || (colors[color] = { code, sizes: [] });
    if (!c.code && code) c.code = code;
    if (!c.sizes.includes(cm)) c.sizes.push(cm);
  }
  for (const c of Object.values(colors)) c.sizes.sort((a, b) => a - b);
  return colors;
}

// data.json に SKU 実在庫を反映する。
// 重要: path ファセット由来のサイズは「展開サイズ」であり在庫ではない
// (例: 130cm が path にあっても SKU 照会で 0 件 = 売切) ことが判明したため、
// ここで products[].sizes を SKU 在庫で上書きし、sizeMap / isFull / 並び順を再計算する。
// これにより「在庫あり / 売切(展開あり) / 展開なし」の3状態が復活する。
export function applySkuMatrices(tshirtData, matrixByHinban) {
  let applied = 0;
  const DISPLAY = tshirtData.displaySizes || DISPLAY_SIZES;
  for (const d of tshirtData.designs || []) {
    for (const p of d.products || []) {
      const m = matrixByHinban[p.hinban];
      if (m && Object.keys(m).length) {
        p.colorSizes = m;
        applied++;
        p.offered = p.offered || p.sizes; // path由来 = 展開サイズとして保持
        p.sizes = [...new Set(Object.values(m).flatMap((c) => c.sizes))].sort((a, b) => a - b);
      }
    }
    const sizeMap = {};
    for (const cm of DISPLAY) {
      const owner = d.products.find((p) => p.sizes.includes(cm));
      if (owner) { sizeMap[cm] = { state: 'in', url: owner.url, front: owner.front }; continue; }
      const offered = d.products.some((p) => (p.offered || p.sizes).includes(cm));
      sizeMap[cm] = { state: offered ? 'out' : 'off' }; // out=売切(展開あり) / off=展開なし
    }
    d.sizeMap = sizeMap;
    d.inStockSizes = DISPLAY.filter((cm) => sizeMap[cm].state === 'in');
    d.gaps = CORE_SIZES.filter((cm) => sizeMap[cm].state !== 'in');
    d.isFull = d.gaps.length === 0;
    d.spans = BABY_SIZES.some((c) => d.inStockSizes.includes(c)) &&
              KIDS_SIZES.some((c) => d.inStockSizes.includes(c));
  }
  // SKU反映でお揃い不成立になったデザインは除外し、再ソート・再集計
  tshirtData.designs = (tshirtData.designs || []).filter((d) => d.spans && d.inStockSizes.length);
  sortDesigns(tshirtData.designs);
  tshirtData.totalDesigns = tshirtData.designs.length;
  tshirtData.fullCount = tshirtData.designs.filter((d) => d.isFull).length;
  tshirtData.gapCount = tshirtData.totalDesigns - tshirtData.fullCount;
  tshirtData.skuMatrixAt = new Date().toISOString();
  tshirtData.stockSource = 'sku';
  return applied;
}

// ---------------- Tシャツ「きょうだいお揃い」データ ----------------

const DISPLAY_SIZES = [80, 90, 95, 100, 110, 120, 130, 140, 150, 160]; // 70は表示しない・160まで
const BABY_SIZES = [80, 90, 95];
const KIDS_SIZES = [100, 110, 120, 130];
const CORE_SIZES = [80, 90, 95, 100, 110, 120, 130];

// デザイン共通ソート。prio (10分丈優先。bottoms のみ設定、Tシャツは undefined=同値) が先頭キー。
const GENDER_RANK = { boys: 0, unisex: 1, girls: 2 };
function sortDesigns(designs) {
  designs.sort((a, b) =>
    ((a.prio || 0) - (b.prio || 0)) ||
    (b.isFull - a.isFull) ||
    (GENDER_RANK[a.gender] - GENDER_RANK[b.gender]) ||
    (b.inStockSizes.length - a.inStockSizes.length) ||
    a.title.localeCompare(b.title, 'ja'));
}

// タイトル一致でベビー/キッズ/スクールの品番を束ね、デザイン単位のカードを作る。
// 同名でも男の子用と女の子用は別デザインなので混ぜない (unisexはどちらとも束ねる)。
const FRONT_RANK = { BABY: 0, KIDS: 1, SCHOOL: 2 };
function splitByGender(list) {
  const hasBoys = list.some((p) => p.gender === 'boys');
  const hasGirls = list.some((p) => p.gender === 'girls');
  if (hasBoys && hasGirls) {
    return [
      list.filter((p) => p.gender !== 'girls'), // boys + unisex
      list.filter((p) => p.gender !== 'boys'),  // girls + unisex
    ];
  }
  return [list];
}

export function buildTshirtData(products, meta = {}) {
  const byTitle = new Map();
  for (const p of products) {
    if (!p.title) continue;
    if (!byTitle.has(p.title)) byTitle.set(p.title, []);
    byTitle.get(p.title).push(p);
  }

  const groups = [];
  for (const [title, all] of byTitle) {
    for (const list of splitByGender(all)) {
      // owner選択を決定的に: BABY→KIDS→SCHOOL、同frontは品番昇順
      list.sort((a, b) =>
        ((FRONT_RANK[a.front.code] ?? 9) - (FRONT_RANK[b.front.code] ?? 9)) ||
        String(a.hinban).localeCompare(String(b.hinban)));
      groups.push([title, list]);
    }
  }

  const designs = [];
  for (const [title, list] of groups) {
    // サイズ→そのサイズが在庫ありの品番 (小さいcmを持つ品番優先で束ねる)
    const sizeMap = {};
    for (const cm of DISPLAY_SIZES) {
      const owner = list.find((p) => p.sizeCms.includes(cm));
      sizeMap[cm] = owner
        ? { state: 'in', url: owner.url, front: owner.front.code }
        : { state: 'off' }; // API上は「在庫なし」と「展開なし」を区別できない
    }
    const inStockSizes = DISPLAY_SIZES.filter((cm) => sizeMap[cm].state === 'in');
    if (inStockSizes.length === 0) continue;

    const spans = BABY_SIZES.some((c) => inStockSizes.includes(c)) &&
                  KIDS_SIZES.some((c) => inStockSizes.includes(c));
    if (!spans) continue; // ベビー×キッズで揃わないデザインは対象外

    const gaps = CORE_SIZES.filter((cm) => sizeMap[cm].state === 'off');
    const isFull = gaps.length === 0;

    // splitByGender 後は boys と girls が混在しないので、片方あればそれが代表
    const genders = new Set(list.map((p) => p.gender));
    const gender = genders.has('boys') ? 'boys' : genders.has('girls') ? 'girls' : 'unisex';
    const prices = list.map((p) => p.price).filter((n) => n != null);
    const colors = [...new Set(list.flatMap((p) => p.colors))];
    const imgP = list.find((p) => p.front.code === 'KIDS') || list.find((p) => p.front.code === 'BABY') || list[0];

    designs.push({
      id: list[0].hinban, // 詳細ページURL (/d/<id>) 用。ソート済みなので決定的
      title,
      gender,
      brand: (list.find((p) => p.brand) || {}).brand || '',
      image: imgP.image,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      colors,
      inStockSizes, gaps, isFull, spans,
      sizeMap,
      saleNote: (list.find((p) => p.saleNote) || {}).saleNote || '',
      // 帯(品番)ごとの詳細: 詳細ページの代表画像3枚と色×帯マトリクスの材料
      products: list.map((p) => ({
        hinban: p.hinban, front: p.front.code, url: p.url, sizes: p.sizeCms,
        image: p.image, price: p.price,
        colors: (p.colorDetails || []).length ? p.colorDetails : p.colors.map((name) => ({ code: '', name })),
      })),
    });
  }

  sortDesigns(designs);

  if (designs.length === 0) {
    throw new Error('お揃いデザインが0件 — 上流データ異常の可能性があるため出力しません');
  }

  return {
    generatedAt: new Date().toISOString(),
    indexUpdate: meta.indexUpdate || null,
    source: 'naviplus-api', // 在庫詳細ページ廃止後の APIオンリー版
    displaySizes: DISPLAY_SIZES,
    unit: 'design',
    totalDesigns: designs.length,
    fullCount: designs.filter((d) => d.isFull).length,
    gapCount: designs.filter((d) => !d.isFull).length,
    designs,
  };
}

// ---------------- お揃いパンツ・レギンス データ ----------------
// Tシャツと同じ title+性別 グルーピングをボトムス2カテゴリ(統合)に適用する。
// 両カテゴリに属する品番は先勝ちで1回だけ数え、マタニティとcmサイズ無しは除外。

export function buildBottomsData(pantsResult, leggingsResult) {
  const seen = new Set();
  const products = [];
  const push = (result, kind) => {
    for (const p of result.products) {
      if (seen.has(p.hinban)) continue;
      seen.add(p.hinban);
      if (p.front.code === 'MAMA' || /マタニティ/.test(p.title)) continue;
      if (!p.sizeCms.length) continue;
      products.push({ ...p, kind }); // kind: 'pants' | 'spats'
    }
  };
  push(pantsResult, 'pants');
  push(leggingsResult, 'spats');

  const data = buildTshirtData(products, {
    indexUpdate: pantsResult.indexUpdate || leggingsResult.indexUpdate || null,
  });
  // デザイン単位の kind (フロントの パンツ/レギンス フィルタ用) と 10分丈優先度
  const kindOf = new Map(products.map((p) => [p.hinban, p.kind]));
  for (const d of data.designs) {
    d.kind = kindOf.get(((d.products || [])[0] || {}).hinban) || 'pants';
    d.prio = /10分丈/.test(d.title) ? 0 : 1; // applySkuMatrices の再ソートでも維持される
  }
  sortDesigns(data.designs);
  return data;
}

// ---------------- ¥1,000以下 パンツ・スパッツ データ ----------------

export function buildCheapData(pantsResult, leggingsResult) {
  const items = [];
  const push = (result, kind) => {
    for (const p of result.products) {
      if (p.price == null || p.price > CHEAP_MAX_PRICE) continue;
      // マタニティ(大人)商品と、cmサイズが取れない商品(表示が崩れる)は除外
      if (p.front.code === 'MAMA' || /マタニティ/.test(p.title)) continue;
      if (!p.sizeCms.length) continue;
      items.push({
        kind, // 'pants' | 'spats'
        hinban: p.hinban,
        title: p.title,
        price: p.price,
        image: p.image,
        url: p.url,
        sizes: p.sizeCms,
        gender: p.gender,
        front: p.front.code,
        brand: p.brand,
        colors: p.colors,
        saleNote: p.saleNote,
      });
    }
  };
  push(pantsResult, 'pants');
  push(leggingsResult, 'spats');

  // 両カテゴリに属する品番の二重計上を防ぐ (先勝ち)
  const seen = new Set();
  const deduped = items.filter((i) => !seen.has(i.hinban) && seen.add(i.hinban));
  items.length = 0;
  items.push(...deduped);

  if (items.length === 0) {
    throw new Error('¥1000以下アイテムが0件 — 上流データ異常の可能性があるため出力しません');
  }
  // 10分丈レギンスを最優先で表示、以降は安い順
  const prio = (i) => (i.kind === 'spats' && /10分丈/.test(i.title) ? 0 : 1);
  items.sort((a, b) =>
    (prio(a) - prio(b)) ||
    (a.price - b.price) ||
    a.title.localeCompare(b.title, 'ja'));

  const sizeSet = new Set(items.flatMap((i) => i.sizes));
  return {
    generatedAt: new Date().toISOString(),
    indexUpdate: pantsResult.indexUpdate || leggingsResult.indexUpdate || null,
    maxPrice: CHEAP_MAX_PRICE,
    totalItems: items.length,
    pantsCount: items.filter((i) => i.kind === 'pants').length,
    spatsCount: items.filter((i) => i.kind === 'spats').length,
    availableSizes: [...sizeSet].sort((a, b) => a - b),
    items,
  };
}

// ---------------- ユニクロコーナー ----------------

const UQ_API = 'https://www.uniqlo.com/jp/api/commerce/v5/ja';
const UQ_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'Referer': 'https://www.uniqlo.com/jp/ja/',
  'Accept-Language': 'ja-JP',
};

export async function buildUniqloData(fetchFn, opts = {}) {
  const maxProbes = opts.maxProbes || 35;
  const search = async (q) => {
    const u = `${UQ_API}/products?q=${encodeURIComponent(q)}&offset=0&limit=80&imageRatio=3x4&httpFailure=true`;
    const r = await fetchFn(u, { headers: UQ_HEADERS });
    return ((await r.json()).result || {}).items || [];
  };
  const raw = [...await search('キッズ Tシャツ'), ...await search('ベビー Tシャツ')];
  const seen = new Set();
  const cands = raw.filter((it) => it.productId && !seen.has(it.productId) && seen.add(it.productId));

  const sale = [];
  for (const it of cands.slice(0, maxProbes)) {
    try {
      const u = `${UQ_API}/products/${it.productId}/price-groups/00/l2s?withPrices=true&withStocks=true&httpFailure=true`;
      const d = (await (await fetchFn(u, { headers: UQ_HEADERS })).json()).result || {};
      await sleep(opts.delayMs != null ? opts.delayMs : 70);
      const a = analyzeUniqlo(d);
      if (a.saleFlag && a.inStockSizes.length > 0) sale.push({ it, a });
    } catch { /* 個別失敗は無視 */ }
  }

  const eligible = sale.filter(({ it }) => !/エアリズム|AIRism/i.test(it.name));
  eligible.sort((x, y) =>
    (x.a.promoMin - y.a.promoMin) ||
    (y.a.inStockSizes.length - x.a.inStockSizes.length) ||
    ((x.it.name.startsWith('GIRLS') ? 1 : 0) - (y.it.name.startsWith('GIRLS') ? 1 : 0)) ||
    x.it.name.localeCompare(y.it.name, 'ja'));

  const pick = eligible[0];
  if (!pick) throw new Error('ユニクロのセール×在庫あり商品が見つかりませんでした');
  const { it, a } = pick;
  const repColor = (a.colors.find((c) => c.inStockSizes.length) || a.colors[0] || { code: '00' }).code;
  const main = (it.images && it.images.main) || {};
  const imgEntry = main[repColor] || main[Object.keys(main)[0]];

  return {
    fetchedAt: new Date().toISOString(),
    note: 'ユニクロのセール(期間限定価格/値下げ)キッズTシャツから自動選定したサンプル1点',
    saleCandidates: sale.length,
    sample: {
      brand: 'UNIQLO',
      productId: it.productId,
      name: it.name,
      genderName: it.genderName || '',
      url: `https://www.uniqlo.com/jp/ja/products/${it.productId}`,
      image: imgEntry ? imgEntry.image : '',
      price: a.promoMin,
      saleLabel: a.saleFlag ? a.saleFlag.name : 'セール',
      displaySizes: Object.keys(a.sizeState).map(Number).sort((p, q) => p - q),
      sizeState: a.sizeState,
      inStockSizes: a.inStockSizes,
      colorCount: a.colors.length,
    },
  };
}

function analyzeUniqlo(d) {
  const l2s = d.l2s || [], prices = d.prices || {}, stocks = d.stocks || {};
  let saleFlag = null;
  const colorMap = new Map();
  const sizeState = {};
  let promoMin = Infinity;
  for (const x of l2s) {
    const st = stocks[x.l2Id], pr = prices[x.l2Id];
    const inStock = st && st.statusCode === 'IN_STOCK' && (st.quantity == null || st.quantity > 0);
    const pf = ((x.flags && x.flags.priceFlags) || []).find((f) => /limitedOffer|discount/.test(f.code));
    if (pf && !saleFlag) saleFlag = { code: pf.code, name: pf.name };
    if (pr && pr.promo) promoMin = Math.min(promoMin, pr.promo.value);
    const size = x.size.displayCode;
    if (inStock) sizeState[size] = 'in';
    else if (!(size in sizeState)) sizeState[size] = 'out';
    const cc = x.color.displayCode;
    if (!colorMap.has(cc)) colorMap.set(cc, { code: cc, inStock: new Set() });
    if (inStock) colorMap.get(cc).inStock.add(size);
  }
  return {
    saleFlag, sizeState, promoMin,
    inStockSizes: Object.entries(sizeState).filter(([, s]) => s === 'in').map(([s]) => parseInt(s, 10)).sort((a, b) => a - b),
    colors: [...colorMap.values()].map((c) => ({ code: c.code, inStockSizes: [...c.inStock].map(Number).sort((a, b) => a - b) })),
  };
}

// ---------------- 他ブランドコーナー (H&M / ZARA / ヒラキ / GAP) ----------------
// 画像はビルド時ローカル化をやめ、フロントの /api/img プロキシ経由で表示する。

const H_HTML = { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9', 'Accept': 'text/html' };
const H_JSON = { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9', 'Accept': 'application/json' };
const CORNER_TAKE = 6;
const yen = (n) => (n == null ? null : Number(n));
const genderFromText = (s) => {
  const boys = /男の子|ボーイ|BOY/i.test(s), girls = /女の子|ガール|GIRL/i.test(s);
  if (boys && !girls) return 'boys';
  if (girls && !boys) return 'girls';
  return 'unisex';
};

async function fetchHM(fetchFn) {
  const url = 'https://www2.hm.com/ja_jp/kids/sale/2-8-years/view-all.html';
  const t = await (await fetchFn(url, { headers: H_HTML })).text();
  const m = t.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  const j = JSON.parse(m[1]);
  let hits = null;
  (function walk(o, d) {
    if (hits || d > 8 || !o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) && v.length && v[0] && v[0].prices && v[0].articleCode) { hits = v; return; }
      walk(v, d + 1);
    }
  })(j.props.pageProps, 0);
  if (!hits) throw new Error('no product hits');
  const items = [];
  for (const it of hits) {
    if (!/Tシャツ|シャツ|トップ|T-/i.test(it.title + (it.category || ''))) continue;
    const red = (it.prices || []).find((p) => p.priceType === 'redPrice');
    const white = (it.prices || []).find((p) => p.priceType === 'whitePrice');
    if (!red || !white || red.price >= white.price) continue;
    const img = it.imageProductSrc || (it.galleryImages && it.galleryImages[0]);
    items.push({
      name: it.title, price: yen(red.price), oldPrice: yen(white.price),
      saleLabel: it.discountPercentage ? `${it.discountPercentage} OFF` : 'SALE',
      image: img && (img.startsWith('http') ? img : 'https:' + img),
      url: 'https://www2.hm.com' + it.pdpUrl,
      sizes: (it.sizes || []).map((s) => s.name || s).join('・').slice(0, 60),
      gender: genderFromText(it.title),
    });
  }
  items.sort((a, b) => a.price - b.price);
  return items.slice(0, CORNER_TAKE);
}

async function fetchZARA(fetchFn) {
  const cats = (await (await fetchFn('https://www.zara.com/jp/ja/categories?ajax=true', { headers: H_JSON })).json()).categories;
  const ids = [];
  (function walk(a) {
    for (const c of a || []) {
      // シーズン接頭辞 (I2024 / I2024R / I2025...) は変わるため固定しない
      if (/I\d{4}[A-Z]?-NINOS-(NINO|NINA)-CAMISETAS-VER_TODO/.test(c.key || '')) ids.push(c.id);
      walk(c.subcategories);
    }
  })(cats);
  const prods = [];
  for (const id of ids.slice(0, 2)) {
    const j = await (await fetchFn(`https://www.zara.com/jp/ja/category/${id}/products?ajax=true`, { headers: H_JSON })).json();
    for (const g of j.productGroups || []) for (const el of g.elements || []) for (const c of el.commercialComponents || []) prods.push(c);
  }
  const seen = new Set();
  const items = [];
  for (const p of prods) {
    if (!p.oldPrice || !p.price || p.price >= p.oldPrice) continue;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    let x = (p.xmedia || [])[0];
    if (!x) { const col = ((p.detail || {}).colors || [])[0] || {}; x = (col.xmedia || [])[0]; }
    if (!x || !x.path || !x.name) continue;
    const sizes = (((p.detail || {}).colors || [])[0] || {}).sizes || [];
    items.push({
      name: p.name, price: yen(p.price), oldPrice: yen(p.oldPrice),
      saleLabel: 'SPECIAL PRICE',
      image: `https://static.zara.net${x.path}/w/563/${x.name}.jpg?ts=${x.timestamp || ''}`,
      url: p.seo ? `https://www.zara.com/jp/ja/${p.seo.keyword}-p${p.seo.seoProductId}.html` : '',
      sizes: sizes.map((s) => s.name).join('・').slice(0, 60),
      gender: genderFromText(p.sectionName || p.familyName || ''),
    });
  }
  items.sort((a, b) => a.price - b.price);
  return items.slice(0, CORNER_TAKE);
}

async function fetchHiraki(fetchFn) {
  const url = 'https://www.hiraki.co.jp/ec/proList/searchProduct?categoryCd=110E0x02000';
  const t = await (await fetchFn(url, { headers: H_HTML })).text();
  const items = [];
  const re = /<a href="\/ec\/pro\/disp\/1\/(\d+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const id = m[1], attrs = m[2];
    const get = (k) => { const mm = attrs.match(new RegExp(k + '="([^"]*)"')); return mm ? mm[1] : ''; };
    const price = Math.max(parseInt(get('data-taxprice') || '0', 10), parseInt(get('data-notaxprice') || '0', 10));
    if (!price || price < 50) continue;
    if (/在庫なし|×/.test(get('data-stockmark'))) continue;
    const after = t.slice(m.index, m.index + 1000);
    const alt = (after.match(/alt="([^"]{4,60})"/) || [])[1] || '';
    const cleanName = alt.replace(/\[[^\]]*\]/g, '').replace(/【[^】]*】/g, '').trim();
    if (!cleanName) continue;
    const med = get('data-med');
    items.push({
      name: cleanName, price, oldPrice: null,
      saleLabel: /true/i.test(get('data-iconPriceDown')) ? '値下げ' : '激安プライス',
      image: med ? 'https://www.hiraki.co.jp' + med : '',
      url: 'https://www.hiraki.co.jp/ec/pro/disp/1/' + id,
      sizes: (alt.match(/【([^】]+)】/) || [])[1] || '',
      gender: genderFromText(alt),
    });
  }
  const seen = new Set();
  const uniq = items.filter((x) => !seen.has(x.url) && seen.add(x.url));
  uniq.sort((a, b) => a.price - b.price);
  return uniq.slice(0, CORNER_TAKE);
}

async function fetchGAP(fetchFn) {
  const url = 'https://www.gap.co.jp/browse/category.do?cid=1058733';
  const t = await (await fetchFn(url, { headers: H_HTML })).text();
  const items = [];
  const seen = new Set();
  const re = /<img[^>]+alt="([^"]{4,60})"[^>]+src="(https:\/\/www\.gap\.co\.jp\/on\/demandware[^"]+)"/g;
  let m;
  while ((m = re.exec(t)) !== null && items.length < CORNER_TAKE) {
    const name = m[1].trim();
    if (!/T|シャツ|ロゴ|プリント|グラフィック|トップ/i.test(name)) continue;
    if (/30%OFF|40%OFF|公式/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ name, price: null, oldPrice: null, saleLabel: 'SALE', image: m[2], url: 'https://www.gap.co.jp/gap/boys/sale-1058733', sizes: '', gender: 'boys' });
  }
  return items;
}

// ZOZOTOWN: 本体 zozo.jp は Akamai Bot Manager で機械アクセスを明示拒否 (2026-07-14実測:
// カテゴリページはローカルからも403) のため直接は取得しない。公式出店の
// ZOZOTOWN Yahoo!店 (store.shopping.yahoo.co.jp/zozo/) をキーワード検索して値下げ品を拾う。
// robots.txt で禁止されているのは strcid/brandid/spec 等のパラメータ付き検索のみで、
// ?p= のキーワード検索は許可されている (2026-07-14確認)。
async function fetchZozoYahoo(fetchFn) {
  const u = 'https://store.shopping.yahoo.co.jp/zozo/search.html?p=' + encodeURIComponent('キッズ Tシャツ');
  const t = await (await fetchFn(u, { headers: H_HTML })).text();
  const m = t.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  const j = JSON.parse(m[1]);
  let arr = null;
  (function walk(o, d) {
    if (arr || !o || typeof o !== 'object' || d > 9) return;
    if (Array.isArray(o) && o.length > 3 && o[0] && typeof o[0] === 'object' && 'name' in o[0] && 'price' in o[0]) { arr = o; return; }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(j.props, 0);
  if (!arr) throw new Error('no item array in NEXT_DATA');
  const items = [];
  for (const it of arr) {
    const price = yen(it.actualPrice || it.price);
    const img = it.image && it.image.imageUrl;
    const name = String(it.name || '').trim();
    if (!price || !img || !name) continue;
    const ob = String(it.dataBeacon || '').match(/o_prc:(\d+)/); // 値下げ前価格はbeaconのみに載る
    const oldPrice = ob && Number(ob[1]) > price ? Number(ob[1]) : null;
    items.push({
      name, price, oldPrice,
      saleLabel: it.discountRate > 0 ? `${it.discountRate}% OFF` : 'ZOZO Yahoo!店',
      image: img,
      url: String(it.url || '').split('?')[0],
      sizes: '100〜130cm中心',
      gender: genderFromText(name),
    });
  }
  const sale = items.filter((i) => i.oldPrice);
  let pool = sale.length >= CORNER_TAKE ? sale : items;
  const seen = new Set();
  pool = pool.filter((i) => !seen.has(i.name) && seen.add(i.name)); // 色違いの同名重複を除去
  pool.sort((a, b) => a.price - b.price);
  return pool.slice(0, CORNER_TAKE);
}

const RETAILERS = [
  { brand: 'H&M', accent: '#e50010', note: 'キッズ(2〜8歳)セールより値下げTシャツ', fn: fetchHM },
  { brand: 'ZARA', accent: '#000000', note: 'キッズ Tシャツ スペシャルプライス', fn: fetchZARA },
  { brand: 'ZOZOTOWN', accent: '#1d1d1b', note: 'ZOZOTOWN Yahoo!店の値下げキッズTシャツ（100〜130cm中心・きょうだいサイズが見つけやすい）', fn: fetchZozoYahoo },
  { brand: 'ヒラキ', accent: '#e6322e', note: '激安キッズTシャツ（100〜160cm中心）', fn: fetchHiraki },
  { brand: 'GAP', accent: '#1a3d7c', note: 'ボーイズ セール（価格は商品ページでご確認ください）', fn: fetchGAP },
];

// ---------------- RSS フィード ----------------
// 毎朝の更新をRSSで配信 (SNS自動投稿・RSSリーダー・Google Discover 対策)。
// guid を hinban+price にしているので、値下げ時は新着として再配信される。

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function buildFeedXml(tshirtData, cheapData, siteUrl) {
  const now = new Date().toUTCString();
  const items = [];

  for (const it of (cheapData && cheapData.items || []).slice(0, 20)) {
    const kindLabel = it.kind === 'spats' ? 'レギンス' : 'パンツ';
    items.push(`  <item>
    <title>${esc(`【¥${it.price}】${it.title}（${kindLabel} / ${it.sizes.join('・')}cm）`)}</title>
    <link>${esc(it.url)}</link>
    <guid isPermaLink="false">${esc(`${it.hinban}-${it.price}`)}</guid>
    <description>${esc(`西松屋の¥1,000以下${kindLabel}。税込¥${it.price}${it.saleNote ? '・' + it.saleNote : ''}。在庫サイズ: ${it.sizes.join('/')}cm`)}</description>
    <pubDate>${now}</pubDate>
  </item>`);
  }
  for (const d of (tshirtData && tshirtData.designs || []).filter((x) => x.isFull).slice(0, 10)) {
    items.push(`  <item>
    <title>${esc(`【お揃い全サイズ在庫】${d.title}（¥${d.priceMin}〜）`)}</title>
    <link>${esc(siteUrl)}</link>
    <guid isPermaLink="false">${esc(`tshirt-${d.title}-${d.inStockSizes.join('.')}`)}</guid>
    <description>${esc(`80〜130cmが同デザインで揃うTシャツ。在庫サイズ: ${d.inStockSizes.join('/')}cm、カラー: ${d.colors.join('・')}`)}</description>
    <pubDate>${now}</pubDate>
  </item>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>きょうだいお揃いコーデ &amp; ¥1,000以下パンツ・レギンス</title>
  <link>${esc(siteUrl)}</link>
  <description>西松屋オンラインの在庫から毎朝8時に自動更新。80〜160cmお揃いTシャツと¥1,000以下の激安パンツ・レギンス。</description>
  <language>ja</language>
  <lastBuildDate>${now}</lastBuildDate>
${items.join('\n')}
</channel>
</rss>`;
}

// 取得できたブランドだけで corners.json を作る。全滅なら throw (既存データ保持のため)。
export async function buildCornersData(fetchFn) {
  const corners = [];
  const errors = {};
  for (const r of RETAILERS) {
    try {
      const items = await r.fn(fetchFn);
      if (items.length) corners.push({ brand: r.brand, accent: r.accent, note: r.note, items });
      else errors[r.brand] = '0件';
    } catch (e) {
      errors[r.brand] = e.message;
    }
  }
  if (corners.length === 0) throw new Error('他ブランドコーナーが全滅: ' + JSON.stringify(errors));
  return { generatedAt: new Date().toISOString(), corners, errors };
}
