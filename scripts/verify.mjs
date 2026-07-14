// ローカルでレンダリング検証: public/ を簡易サーバで配信し、
// Playwright でタブUI (Tシャツ/¥1000以下/他ブランド) の描画を確認して
// スクリーンショットを出力する。
// 本番の /api/* (KV) と /cheap 等のリライトはここで模擬する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve('public');
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.xml': 'application/xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/' || f === '/cheap' || f === '/brands') f = '/index.html';       // _redirects 相当
  if (f.startsWith('/d/') && !f.endsWith('.json')) f = '/item.html';             // 詳細ページ
  if (f.startsWith('/api/img')) { res.writeHead(404); return res.end(); }       // 画像プロキシは本番のみ
  if (f.startsWith('/img/')) {                                                  // R2ミラーは本番のみ → 原本へ302
    res.writeHead(302, { location: 'https://www.24028-net.jp/client_info/N24028/itemimage/' + f.slice(5) });
    return res.end();
  }
  if (f.startsWith('/api/')) f = f.slice(4);                                    // /api/x.json → 静的 x.json
  const fp = path.join(ROOT, f);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
const errs = [];
// リソース読込失敗(画像プロキシはローカル非対応で404が正常)は除外し、JSエラーのみ検知
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text());
});
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// --- タブ1: Tシャツ ---
await page.click('#tabs button[data-tab="tshirt"]');
await page.waitForTimeout(300);
const cards = await page.$$eval('#tshirtGrid .card', (c) => c.length);
const meta = await page.$eval('#tshirtMeta', (e) => e.textContent);
console.log('Tシャツカード:', cards, '|', meta);
await page.screenshot({ path: 'preview.png' });

// --- タブ2: お揃いパンツ・レギンス + ¥1000以下 ---
await page.click('#tabs button[data-tab="cheap"]');
await page.waitForTimeout(400);
const bottomsCards = await page.$$eval('#bottomsGrid .card', (c) => c.length);
const bottomsMeta = await page.$eval('#bottomsMeta', (e) => e.textContent);
console.log('お揃いボトムスカード:', bottomsCards, '|', bottomsMeta);
const firstBottomTitle = await page.$eval('#bottomsGrid .card .title', (e) => e.textContent);
console.log('先頭デザイン(10分丈優先):', firstBottomTitle);
const cheapCards = await page.$$eval('#cheapGrid .c-card', (c) => c.length);
const cheapMeta = await page.$eval('#cheapMeta', (e) => e.textContent);
console.log('¥1000以下カード:', cheapCards, '|', cheapMeta);
await page.click('#cheapKind button[data-k="len10"]');
await page.waitForTimeout(300);
console.log('10分丈のみ: お揃い', await page.$$eval('#bottomsGrid .card', (c) => c.length),
  '/ ¥1000以下', await page.$$eval('#cheapGrid .c-card', (c) => c.length));
await page.click('#cheapKind button[data-k="spats"]');
await page.waitForTimeout(300);
console.log('スパッツのみ:', await page.$$eval('#cheapGrid .c-card', (c) => c.length));
await page.click('#cheapKind button[data-k="all"]');
await page.waitForTimeout(200);
await page.screenshot({ path: 'preview-cheap.png' });

// --- タブ3: 他ブランド ---
await page.click('#tabs button[data-tab="brands"]');
await page.waitForTimeout(400);
console.log('他ブランドコーナー:', await page.$$eval('.brand-corner', (c) => c.length));
await page.screenshot({ path: 'preview-brands.png' });

// --- OGP画像 (1200x630) を生成 ---
const ogPage = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await ogPage.goto(`http://localhost:${port}/cheap`, { waitUntil: 'networkidle' });
await ogPage.waitForTimeout(500);
await ogPage.screenshot({ path: 'public/og.png' });
await ogPage.close();
console.log('OGP画像 → public/og.png');

// --- 直リンク: /cheap ---
await page.goto(`http://localhost:${port}/cheap`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const directCheap = await page.$eval('#pane-cheap', (e) => e.classList.contains('active'));
console.log('/cheap 直リンクでcheapタブ表示:', directCheap);

// --- 詳細ページ /d/<id> ---
const firstId = JSON.parse(fs.readFileSync('public/data.json', 'utf8')).designs[0].id;
await page.goto(`http://localhost:${port}/d/${firstId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
console.log('詳細ページ タイトル:', await page.$eval('h1', (e) => e.textContent).catch(() => '(なし)'));
console.log('詳細ページ 帯カード:', await page.$$eval('.band', (c) => c.length),
  '/ 色ブロック:', await page.$$eval('.color-block', (c) => c.length));
await page.screenshot({ path: 'preview-detail.png', fullPage: false });

// --- 詳細ページ /d/<id> (お揃いボトムス) ---
const firstBottomId = JSON.parse(fs.readFileSync('public/bottoms.json', 'utf8')).designs[0].id;
await page.goto(`http://localhost:${port}/d/${firstBottomId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
console.log('ボトムス詳細 タイトル:', await page.$eval('h1', (e) => e.textContent).catch(() => '(なし)'));
console.log('ボトムス詳細 帯カード:', await page.$$eval('.band', (c) => c.length),
  '/ 色ブロック:', await page.$$eval('.color-block', (c) => c.length));
await page.screenshot({ path: 'preview-detail-bottoms.png', fullPage: false });

// --- 詳細ページ スマホ表示 (390px) ---
const mp = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mp.goto(`http://localhost:${port}/d/${firstId}`, { waitUntil: 'networkidle' });
await mp.waitForTimeout(600);
const bandRow = await mp.$$eval('.bands .band', (els) => {
  const tops = els.map((e) => e.getBoundingClientRect().top);
  return tops.length === 3 && Math.max(...tops) - Math.min(...tops) < 5; // 3枚が横並びか
});
console.log('スマホ: 帯3枚が横並び:', bandRow);
await mp.screenshot({ path: 'preview-detail-mobile.png', fullPage: false });
await mp.close();

console.log('console errors:', errs.length ? errs : 'none');
await browser.close();
server.close();
if (errs.length) process.exitCode = 1;
