'use strict';
// 聚合搜索的本地缓存（档2：顺手积累）。
//
// 一条铁律：实时搜索永远完整跑，缓存只「补充 + 积累」，绝不替代实时结果。
// 这样新消息一定来自实时搜索、一定会上屏；缓存只把「这次实时没返回、但以前搜到过」
// 的旧条目补回来（标 fromCache），不会出现「只有旧内容、新的不加载」。
//
// 按 (账号 + 关键词) 分桶：换个词搜不会把别的词的历史结果灌进来。
// 纯函数，不碰 fs / electron，方便单测；读写盘由 main.js 负责。

const CACHE_VERSION = 1;
// 自动扩容：单桶上限提到 1 万（基本不会触发），真正的刹车是下面的全局预算。
const MAX_ITEMS_PER_KEY = 10000;  // 单个 (账号,关键词) 安全上限
const MAX_BUCKETS = 300;          // 全局桶数上限，超了淘汰最久没更新的桶
const MAX_TOTAL_ITEMS = 20000;    // 全局条目预算，超了跨桶淘汰最久没刷新的条目

function emptyStore() {
  return { version: CACHE_VERSION, buckets: [] };
}

const str = (v) => String(v == null ? '' : v).trim();
const SIG_SEP = '\u0001';
const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
// 落盘时不存 sig（它等于「标题 + 第二行」，冗余），读盘时按同样规则现算。
// 实测 4984/4984 条与存储的 sig 完全一致。
function deriveSig(it) {
  const isMsg = str(it && it.kind).indexOf('消息') >= 0;
  const b = isMsg ? str(it && it.snippet) : str(it && it.time);
  return norm(it && it.title) + SIG_SEP + norm(b);
}

// 读盘后的兜底：坏文件 / 旧版本 / 形状不对一律当空仓，绝不抛。
function sanitizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  if (raw.version !== CACHE_VERSION || !Array.isArray(raw.buckets)) return emptyStore();
  const buckets = [];
  for (const b of raw.buckets) {
    if (!b || typeof b !== 'object') continue;
    const accountId = str(b.accountId);
    const keyword = str(b.keyword);
    if (!accountId || !keyword || !Array.isArray(b.items)) continue;
    const items = [];
    for (const it of b.items) {
      if (!it || typeof it !== 'object') continue;
      const sig = str(it.sig) || deriveSig(it);
      if (!sig || sig === SIG_SEP) continue;   // 没有标题/内容，没法去重 / 跳转，丢掉
      items.push({
        index: Number.isFinite(it.index) ? it.index : 0,
        kind: str(it.kind) || '其他',
        title: str(it.title),
        snippet: str(it.snippet),
        time: str(it.time),
        ts: Number.isFinite(it.ts) ? it.ts : null,
        via: it.via === 'msg' ? 'msg' : 'all',
        sig: sig,
        cachedAt: Number.isFinite(it.cachedAt) ? it.cachedAt : 0
      });
    }
    buckets.push({
      accountId: accountId,
      keyword: keyword,
      updatedAt: Number.isFinite(b.updatedAt) ? b.updatedAt : 0,
      complete: !!b.complete,
      coverFrom: Number.isFinite(b.coverFrom) ? b.coverFrom : null,
      items: items
    });
  }
  return { version: CACHE_VERSION, buckets: buckets };
}

// 写盘用：去掉每条 item 的 sig（读盘时现算），只保留必要字段，文件更小。
function serialize(store) {
  const s = store || emptyStore();
  return {
    version: CACHE_VERSION,
    buckets: (s.buckets || []).map((b) => ({
      accountId: b.accountId,
      keyword: b.keyword,
      updatedAt: b.updatedAt || 0,
      complete: !!b.complete,
      coverFrom: (b.coverFrom == null ? null : b.coverFrom),
      items: (b.items || []).map((it) => ({
        index: it.index, kind: it.kind, title: it.title, snippet: it.snippet,
        time: it.time, ts: it.ts, via: it.via, cachedAt: it.cachedAt
      }))
    }))
  };
}

function findBucket(store, accountId, keyword) {
  const id = str(accountId), kw = str(keyword);
  if (!id || !kw || !store || !Array.isArray(store.buckets)) return null;
  return store.buckets.find((b) => b.accountId === id && b.keyword === kw) || null;
}

// 把这次实时搜到的条目并进缓存：同 sig 的刷新成最新内容，新的追加。
// 只积累、不删除旧条目（旧条目正是下次要补充的来源）。返回 store 本身。
function addItems(store, accountId, keyword, items, now) {
  const id = str(accountId), kw = str(keyword);
  if (!store || !Array.isArray(store.buckets) || !id || !kw) return store;
  const t = Number.isFinite(now) ? now : Date.now();
  const list = Array.isArray(items) ? items : [];

  let bucket = findBucket(store, id, kw);
  if (!bucket) {
    bucket = { accountId: id, keyword: kw, updatedAt: t, complete: false, coverFrom: null, items: [] };
    store.buckets.push(bucket);
  }
  const bySig = new Map();
  for (const it of bucket.items) bySig.set(it.sig, it);

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const sig = str(raw.sig);
    if (!sig) continue;
    const fresh = {
      index: Number.isFinite(raw.index) ? raw.index : 0,
      kind: str(raw.kind) || '其他',
      title: str(raw.title),
      snippet: str(raw.snippet),
      time: str(raw.time),
      ts: Number.isFinite(raw.ts) ? raw.ts : null,
      via: raw.via === 'msg' ? 'msg' : 'all',
      sig: sig,
      cachedAt: t
    };
    const old = bySig.get(sig);
    if (old) Object.assign(old, fresh);    // 见过这条：用最新内容覆盖，刷新时间
    else { bucket.items.push(fresh); bySig.set(sig, fresh); }
  }

  // 单桶超量：淘汰最久没刷新的（cachedAt 小的先走）。上限 1 万，基本不会触发。
  if (bucket.items.length > MAX_ITEMS_PER_KEY) {
    bucket.items.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
    bucket.items = bucket.items.slice(0, MAX_ITEMS_PER_KEY);
    bucket.complete = false;   // 被裁过就不再保证「整段历史都在」，不能用来续搜
  }
  bucket.updatedAt = t;

  // 全局条目预算：自动扩容的同时防止盘无限大。所有桶加起来超了，
  // 就从最久没刷新的条目开始跨桶淘汰，保证新搜到的优先留下。
  let total = 0;
  for (const b of store.buckets) total += b.items.length;
  if (total > MAX_TOTAL_ITEMS) {
    const all = [];
    for (const b of store.buckets) for (const it of b.items) all.push({ b: b, it: it });
    all.sort((a, b) => (a.it.cachedAt || 0) - (b.it.cachedAt || 0));
    let need = total - MAX_TOTAL_ITEMS;
    for (const x of all) {
      if (need <= 0) break;
      const i = x.b.items.indexOf(x.it);
      if (i >= 0) { x.b.items.splice(i, 1); x.b.complete = false; need--; }
    }
    store.buckets = store.buckets.filter((b) => b.items.length > 0);
  }

  // 全局超量：淘汰最久没更新的桶
  if (store.buckets.length > MAX_BUCKETS) {
    store.buckets.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    store.buckets = store.buckets.slice(0, MAX_BUCKETS);
  }
  return store;
}

// 这次实时没返回、但缓存里有的条目 —— 补充显示用，标 fromCache。
// 实时返回过的（同 sig）一律不补，避免重复；实时结果永远优先。
// 一条结果是否「字面」包含关键词（标题或消息片段）。
// 缓存只补历史消息，语义命中不往桶里塞：同一个消息在不同词下会被当成别的词的历史。
function isLiteralItem(it, keyword) {
  const kw = str(keyword).toLowerCase();
  if (!kw) return true;
  const text = (str(it && it.title) + ' ' + str(it && it.snippet)).toLowerCase();
  return text.indexOf(kw) >= 0;
}

function cacheOnlyItems(store, accountId, keyword, liveItems, opts) {
  const bucket = findBucket(store, accountId, keyword);
  if (!bucket) return [];
  const liveSigs = new Set();
  for (const it of (Array.isArray(liveItems) ? liveItems : [])) {
    const s = str(it && it.sig);
    if (s) liveSigs.add(s);
  }
  const literalOnly = !!(opts && opts.literal);
  const out = bucket.items
    .filter((it) => it.sig && !liveSigs.has(it.sig))
    .filter((it) => !literalOnly || isLiteralItem(it, keyword))
    .map((it) => Object.assign({}, it, { fromCache: true }));
  // 按时间倒序补在实时结果后面；时间未知的排最后
  out.sort((a, b) => {
    if (a.ts == null && b.ts == null) return 0;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return b.ts - a.ts;
  });
  return out;
}

// 清掉桶里「不含本桶关键词」的旧条目。老版本曾因面板没刷新把别的词的结果写进来；
// 这类条目对当前词就是噪声，读盘时顺手清掉（缓存可重建，不心疼）。
function dropNonLiteral(store) {
  let dropped = 0;
  const buckets = (store && Array.isArray(store.buckets)) ? store.buckets : [];
  for (const b of buckets) {
    if (!b || !Array.isArray(b.items)) continue;
    const before = b.items.length;
    b.items = b.items.filter((it) => isLiteralItem(it, b.keyword));
    dropped += before - b.items.length;
  }
  return dropped;
}

// 账号删了之后，它的缓存桶不该再留在盘上。下次搜索顺手清掉无效账号。
function pruneAccounts(store, validIds) {
  if (!store || !Array.isArray(store.buckets)) return store;
  const keep = new Set((Array.isArray(validIds) ? validIds : []).map(str));
  store.buckets = store.buckets.filter((b) => keep.has(b.accountId));
  return store;
}

function stats(store) {
  const buckets = (store && Array.isArray(store.buckets)) ? store.buckets : [];
  let items = 0;
  for (const b of buckets) items += (b.items || []).length;
  return { buckets: buckets.length, items: items };
}

module.exports = {
  CACHE_VERSION, MAX_ITEMS_PER_KEY, MAX_BUCKETS, MAX_TOTAL_ITEMS,
  emptyStore, sanitizeStore, serialize, findBucket, addItems, cacheOnlyItems,
  isLiteralItem, dropNonLiteral, pruneAccounts, stats
};