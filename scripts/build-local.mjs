// ローカルでパイプラインを実行し public/*.json (静的フォールバック) を生成する。
// 本番の毎日更新は Cloudflare cron Worker (worker/index.mjs) が行う。
// これはデプロイ時の初期データ生成・ローカル開発・障害時の手動復旧用。
import fs from 'node:fs';
import {
  PATHS, scrapeCategory, buildTshirtData, buildCheapData,
  buildUniqloData, buildCornersData, buildFeedXml,
  fetchSkuMatrix, applySkuMatrices,
} from '../src/pipeline.mjs';

const SITE_URL = 'https://nishimatsuya-coorde.pages.dev/';
const f = (...args) => fetch(...args);
const save = (name, content) => {
  fs.writeFileSync(new URL('../public/' + name, import.meta.url),
    typeof content === 'string' ? content : JSON.stringify(content, null, 1));
  console.log('✔ public/' + name);
};

let tshirtData = null, cheapData = null;

// 1) Tシャツお揃い
try {
  const r = await scrapeCategory(f, PATHS.tshirt, { maxPages: 12 });
  console.log(`Tシャツ: ${r.products.length}品番 (index ${r.indexUpdate})`);
  tshirtData = buildTshirtData(r.products, { indexUpdate: r.indexUpdate });
  console.log(`  → お揃いデザイン ${tshirtData.totalDesigns} (全在庫 ${tshirtData.fullCount})`);

  // 色×サイズのSKU在庫 (詳細ページ用、品番ごとに1リクエスト)
  const hinbans = [...new Set(tshirtData.designs.flatMap((d) => d.products.map((p) => p.hinban)))];
  const map = {};
  let done = 0;
  for (const h of hinbans) {
    try { const m = await fetchSkuMatrix(f, h); if (m) map[h] = m; } catch { /* 個別失敗は帯表示にフォールバック */ }
    done++;
    if (done % 25 === 0) console.log(`  SKUマトリクス ${done}/${hinbans.length}`);
    await new Promise((r2) => setTimeout(r2, 80));
  }
  const applied = applySkuMatrices(tshirtData, map);
  console.log(`  SKUマトリクス適用: ${applied}/${hinbans.length}品番`);
  save('data.json', tshirtData);
} catch (e) { console.error('✘ data.json:', e.message); process.exitCode = 1; }

// 2) ¥1000以下 パンツ・スパッツ
try {
  const pants = await scrapeCategory(f, PATHS.pants, { maxPrice: 1000, maxPages: 8 });
  const leggings = await scrapeCategory(f, PATHS.leggings, { maxPrice: 1000, maxPages: 4 });
  cheapData = buildCheapData(pants, leggings);
  console.log(`¥1000以下: パンツ${cheapData.pantsCount} + スパッツ${cheapData.spatsCount} = ${cheapData.totalItems}件`);
  save('cheap.json', cheapData);
} catch (e) { console.error('✘ cheap.json:', e.message); process.exitCode = 1; }

// 3) ユニクロ (失敗しても既存ファイル温存)
try {
  const u = await buildUniqloData(f, { maxProbes: 35 });
  console.log(`ユニクロ: ${u.sample.name} ¥${u.sample.price}`);
  save('uniqlo.json', u);
} catch (e) { console.error('△ uniqlo.json スキップ:', e.message); }

// 4) 他ブランドコーナー (失敗しても既存ファイル温存)
try {
  const c = await buildCornersData(f);
  console.log('コーナー:', c.corners.map((x) => `${x.brand}(${x.items.length})`).join(', '),
    Object.keys(c.errors).length ? ' / 失敗: ' + JSON.stringify(c.errors) : '');
  save('corners.json', c);
} catch (e) { console.error('△ corners.json スキップ:', e.message); }

// 5) RSS フィード
try {
  save('feed.xml', buildFeedXml(tshirtData, cheapData, SITE_URL));
} catch (e) { console.error('△ feed.xml スキップ:', e.message); }
