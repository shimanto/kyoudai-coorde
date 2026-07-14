// nishimatsuya-coorde 更新 Worker (Durable Object Alarm 駆動)
//
// 毎朝 8:00 JST (= 23:00 UTC) に Durable Object の Alarm でデータ更新パイプラインを
// 実行し、生成 JSON を KV に保存する。サイト (Cloudflare Pages) は Pages Functions
// 経由で KV を読むため、PC が起動していなくても毎日更新が続く。
//
// ▼ なぜ cron trigger ではなく DO Alarm か
//   - 無料プランの cron trigger はアカウント全体で 5 個までで、既存プロジェクト
//     (kyoutsu-api / lineclaude / ses-app) が使い切っている。
//   - DO Alarm は cron 枠を消費せず、無料プラン (SQLite backend) で利用できる。
//   - DO は単一スレッド実行なので tick の排他制御が構造的に保証される。
//   - DO の呼び出しは CPU 30 秒まで許容され、無料 Worker の 10ms 制限を回避できる。
//
// ▼ 動作
//   - Alarm が 23:00 UTC に発火 → 予算内でステップを進める → 未完なら 90 秒後に
//     再 Alarm して継続、完了なら翌日 23:00 UTC に Alarm を設定。
//   - 1 invocation の外部 fetch は MAX_FETCH_PER_TICK (既定40) でハードストップし、
//     無料プランの 50 subrequests/invocation に収める。
//   - 各ステップは成功時のみ KV を上書きするので、失敗日は前日データが残る (last-good)。
//
// ▼ 初回のみ: デプロイ後に POST /init?token=<ADMIN_TOKEN> で Alarm を起動すること。

import {
  PATHS, scrapeCategory, buildTshirtData, buildBottomsData, buildCheapData,
  buildUniqloData, buildCornersData, buildFeedXml,
  fetchSkuMatrix, applySkuMatrices,
} from '../src/pipeline.mjs';

const SITE_URL = 'https://nishimatsuya-coorde.pages.dev/';
const RUN_HOUR_UTC = 23;              // 23:00 UTC = 8:00 JST
const CONTINUE_DELAY_MS = 90 * 1000;  // 未完了時の継続 Alarm 間隔
const MAX_ATTEMPTS = 2;               // ステップ再試行回数 (超えたらスキップ)
const FETCH_TIMEOUT_MS = 15000;

// 色×サイズのSKU在庫 (詳細ページ用)。品番ごとに1リクエストなので
// 進捗を KV に保存しながら複数 tick に分けて実行する (BudgetExceeded で中断→再開)。
// data.json (Tシャツ) / bottoms.json (パンツ・レギンス) で共用。
function skuStep(name, dataKey, tmpKey) {
  return {
    name, est: 15,
    run: async (f, env) => {
      const raw = await env.COORDE_KV.get(dataKey);
      if (!raw) throw new Error(`${dataKey} がまだ無いため ${name} をスキップ`);
      const data = JSON.parse(raw);
      const hinbans = [...new Set((data.designs || []).flatMap((d) => (d.products || []).map((p) => p.hinban)))];
      let prog = null;
      try { prog = JSON.parse(await env.COORDE_KV.get(tmpKey) || 'null'); } catch { /* 壊れていたら最初から */ }
      if (!prog || prog.runDate !== data.generatedAt) prog = { runDate: data.generatedAt, i: 0, map: {} };
      try {
        while (prog.i < hinbans.length) {
          const h = hinbans[prog.i];
          try {
            const m = await fetchSkuMatrix(f, h);
            if (m) prog.map[h] = m;
          } catch (e) {
            if (e && e.budget) throw e; // 予算切れは上へ (進捗は catch 側で保存)
            // 個別失敗はスキップ (この品番だけ帯単位表示にフォールバック)
          }
          prog.i++;
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (e) {
        if (e && e.budget) { await env.COORDE_KV.put(tmpKey, JSON.stringify(prog)); }
        throw e;
      }
      const applied = applySkuMatrices(data, prog.map);
      await env.COORDE_KV.put(dataKey, JSON.stringify(data));
      await env.COORDE_KV.delete(tmpKey);
      return `sku matrix ${applied}/${hinbans.length}品番`;
    },
  };
}

// 各ステップ: est = 見積もり fetch 数 (ページ上限cap込み)。
const STEPS = [
  {
    name: 'tshirt', est: 13,
    run: async (f, env) => {
      const r = await scrapeCategory(f, PATHS.tshirt, { delayMs: 150, maxPages: 12 });
      const data = buildTshirtData(r.products, { indexUpdate: r.indexUpdate });
      await env.COORDE_KV.put('data.json', JSON.stringify(data));
      return `designs=${data.totalDesigns}`;
    },
  },
  skuStep('skumatrix', 'data.json', 'tmp:sku'),
  {
    // お揃いパンツ・レギンス (価格上限なし・2カテゴリ統合)
    name: 'bottoms', est: 9,
    run: async (f, env) => {
      const pants = await scrapeCategory(f, PATHS.pants, { delayMs: 150, maxPages: 8 });
      const leggings = await scrapeCategory(f, PATHS.leggings, { delayMs: 150, maxPages: 4 });
      const data = buildBottomsData(pants, leggings);
      await env.COORDE_KV.put('bottoms.json', JSON.stringify(data));
      return `designs=${data.totalDesigns}`;
    },
  },
  skuStep('sku-bottoms', 'bottoms.json', 'tmp:skub'),
  {
    name: 'cheap', est: 13,
    run: async (f, env) => {
      const pants = await scrapeCategory(f, PATHS.pants, { maxPrice: 1000, delayMs: 150, maxPages: 8 });
      const leggings = await scrapeCategory(f, PATHS.leggings, { maxPrice: 1000, delayMs: 150, maxPages: 4 });
      const data = buildCheapData(pants, leggings);
      await env.COORDE_KV.put('cheap.json', JSON.stringify(data));
      return `items=${data.totalItems} (pants=${data.pantsCount} spats=${data.spatsCount})`;
    },
  },
  {
    name: 'uniqlo', est: 38,
    run: async (f, env) => {
      const data = await buildUniqloData(f, { maxProbes: 35, delayMs: 50 });
      await env.COORDE_KV.put('uniqlo.json', JSON.stringify(data));
      return `pick=${data.sample.name} ¥${data.sample.price}`;
    },
  },
  {
    name: 'corners', est: 12,
    run: async (f, env) => {
      const data = await buildCornersData(f);
      await env.COORDE_KV.put('corners.json', JSON.stringify(data));
      return data.corners.map((c) => `${c.brand}(${c.items.length})`).join(',');
    },
  },
  {
    name: 'feed', est: 0,
    run: async (f, env) => {
      const [dataRaw, cheapRaw] = await Promise.all([
        env.COORDE_KV.get('data.json'), env.COORDE_KV.get('cheap.json'),
      ]);
      const xml = buildFeedXml(
        dataRaw ? JSON.parse(dataRaw) : null,
        cheapRaw ? JSON.parse(cheapRaw) : null,
        SITE_URL,
      );
      await env.COORDE_KV.put('feed.xml', xml);
      return 'feed.xml updated';
    },
  },
];

function jstDateOf(ts) {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 次の 23:00 UTC (ミリ秒 epoch)
function nextRunTime(now) {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RUN_HOUR_UTC, 0, 0);
  return at > now ? at : at + 24 * 3600 * 1000;
}

function newState(runDate) {
  return { runDate, stepIndex: 0, attempts: 0, results: {}, startedAt: new Date().toISOString() };
}

class BudgetExceeded extends Error {
  constructor() { super('fetch budget exceeded (continue next tick)'); this.budget = true; }
}

// fetch カウント + ハードストップ + タイムアウト (subrequest 予算管理)。
// 予算は外部 fetch のみ。KV 操作 (~8回/tick) 分の余裕を budget 側で確保する。
function countedFetch(counter, budget) {
  return async (url, opts) => {
    if (counter.used >= budget) throw new BudgetExceeded();
    counter.used++;
    return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  };
}

// ---------------- Durable Object ----------------

export class CoordeScheduler {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async status() {
    const state = (await this.ctx.storage.get('state')) || null;
    const alarmAt = await this.ctx.storage.getAlarm();
    return {
      state,
      nextAlarm: alarmAt ? new Date(alarmAt).toISOString() : null,
      done: state ? state.stepIndex >= STEPS.length : null,
    };
  }

  async publishStatus(state) {
    await this.env.COORDE_KV.put('status.json', JSON.stringify({
      runDate: state.runDate,
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      done: state.stepIndex >= STEPS.length,
      currentStep: state.stepIndex < STEPS.length ? STEPS[state.stepIndex].name : null,
      results: state.results,
    }));
  }

  // 1 tick: fetch 予算内で実行できるだけステップを進める (DO は単一スレッドなので排他不要)
  async runTick() {
    let state = (await this.ctx.storage.get('state')) || null;
    const today = jstDateOf(Date.now());
    if (!state || state.runDate !== today) state = newState(today);
    if (state.stepIndex >= STEPS.length) return state; // 本日分は完了済み

    const budget = Number(this.env.MAX_FETCH_PER_TICK) || 40;
    const counter = { used: 0 };
    const f = countedFetch(counter, budget);

    while (state.stepIndex < STEPS.length) {
      const step = STEPS[state.stepIndex];
      if (counter.used > 0 && counter.used + step.est > budget) break; // 次 tick へ
      const before = counter.used;
      try {
        const summary = await step.run(f, this.env);
        state.results[step.name] = { ok: true, summary, at: new Date().toISOString(), fetches: counter.used - before };
        state.stepIndex++;
        state.attempts = 0;
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          // 予算切れは失敗扱いにしない (attempts を増やさず次 tick で同ステップ再実行)
          state.results[step.name] = { ok: false, error: e.message, at: new Date().toISOString(), retryNextTick: true };
          break;
        }
        state.attempts++;
        const failed = state.attempts >= MAX_ATTEMPTS;
        state.results[step.name] = { ok: false, error: String(e && e.message || e), at: new Date().toISOString(), skipped: failed };
        if (failed) { state.stepIndex++; state.attempts = 0; } // 前回データ温存のままスキップ
        break; // エラー後はこの tick を終了 (安全側)
      }
    }

    await this.ctx.storage.put('state', state);
    await this.publishStatus(state).catch(() => {});
    return state;
  }

  async ensureScheduled() {
    const alarmAt = await this.ctx.storage.getAlarm();
    if (alarmAt == null) {
      const next = nextRunTime(Date.now());
      await this.ctx.storage.setAlarm(next);
      return { armed: true, nextAlarm: new Date(next).toISOString() };
    }
    return { armed: false, nextAlarm: new Date(alarmAt).toISOString() };
  }

  async alarm() {
    try {
      const state = await this.runTick();
      const next = state.stepIndex >= STEPS.length
        ? nextRunTime(Date.now())               // 完了 → 翌朝
        : Date.now() + CONTINUE_DELAY_MS;       // 未完 → 90秒後に継続
      await this.ctx.storage.setAlarm(next);
    } catch (e) {
      // 想定外エラーでも Alarm チェーンは絶やさない
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
      throw e;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const json = (obj, code = 200) => new Response(JSON.stringify(obj, null, 2), {
      status: code, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    switch (url.pathname) {
      case '/init': return json(await this.ensureScheduled());
      case '/status': return json(await this.status());
      case '/tick': {
        const state = await this.runTick();
        await this.ensureScheduled();
        return json({ done: state.stepIndex >= STEPS.length, state });
      }
      case '/reset': {
        await this.ctx.storage.put('state', newState(jstDateOf(Date.now())));
        return json({ reset: true });
      }
      default: return json({ error: 'not found' }, 404);
    }
  }
}

// ---------------- Worker (エントリポイント) ----------------

export default {
  // 手動操作:
  //   GET  /status           — 実行状況 (公開)
  //   POST /init?token=xxx   — Alarm 起動 (デプロイ後に1回。ADMIN_TOKEN 必須)
  //   POST /tick?token=xxx   — 1 tick 即時実行
  //   POST /reset?token=xxx  — 当日状態リセット (再実行用)
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('main'));

    if (url.pathname === '/status') {
      return stub.fetch('https://do/status');
    }

    const token = url.searchParams.get('token') || '';
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405, headers: { 'content-type': 'application/json' },
      });
    }
    if (['/init', '/tick', '/reset'].includes(url.pathname)) {
      return stub.fetch('https://do' + url.pathname, { method: 'POST' });
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  },
};
