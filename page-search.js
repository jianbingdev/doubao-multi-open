'use strict';

// 聚合搜索：注入到豆包页面里执行的脚本 + 结果整理。
// 独立成文件，不依赖 electron，方便纯 Node 测试。
//
// 2026-11-10 CDP 实测结论：
//   - 搜索入口 [data-testid=global-search-icon-entry]，面板输入 [data-testid=search-input]
//   - 结果分组 [data-testid=search-result-section]，第一行是「对话 / 消息 / 云盘」
//   - 单条 [data-testid=search-result-item]，innerText 逐行：
//       1 会话标题 / 2 消息类=「发送者: …片段…」或日期 / 3 时间（消息类才有）
//   - 每个分组底部有 [data-testid=search-view-all]「查看全部」：
//       点了之后**变成单类全量视图**（实测 5 → 50 条，分组容器消失）
//   - 后台（不可见）视图也能搜，输入到出结果 30~50ms
//   - 不可见视图 clientHeight=0，**滚不动**，所以「查看全部」拿到的 50 条就是能拿的上限
//
// 因此每个结果带一个 via 字段：
//   via='all' → 在「全部」视图里点第 index 条
//   via='msg' → 先点「消息」分组的查看全部，再点第 index 条
//
// 2026-11-10 21:10 修「跳转的信息不对」：
//   日志里同一关键词两次搜索条数差很大（「柜」17 / 10 条，「。」11 / 100 条），
//   说明结果列表是**分批渲染**的，而以前只固定等 200ms 就读下标。
//   于是「搜索那次」记下的第 N 条和「跳转那次」搜出来的第 N 条常常不是同一条，
//   点下去就跳到别的消息上 —— 这不是点错了，是**下标本来就漂了**。
//   现在改成：
//     ① 读之前先等列表「长稳」（连续两次 110ms 条数不变）；
//     ② 每条结果带 sig = 标题 + 第二行文本，跳转时**按内容找**，下标只做兜底；
//     ③ 「查看全部」展开失败就明确报 no-expand，绝不拿漂移的下标硬点。
const SIG_SEP = '\u0001';

// 等结果列表「长稳」。这段源码会原样注入两个页面脚本，所以只能引用闭包里
// 已经存在的 sleep / all / ITEM，别引外部变量。
//
// 2026-11-11 修「第一次搜不全、要再点一次」：
//   真机曲线显示，点「查看全部」后豆包先给 5 条，隔 180~400ms 才跳到 50 条。
//   旧判据「110ms 轮询、连续 2 次条数不变」≈220ms 静默就返回，
//   刚好卡在跳变前 → 只读走 5 条；下一次搜索有缓存、直接给 50 条 → 就「搜全」了。
//   现在要求：至少观察 minMs（默认 900ms）**且** 连续 4 轮（480ms）条数不变；
//   条数一变就把静默计数清零，能兜住更晚的第二批。
async function waitStableItems(maxMs, minMs) {
  const t0 = Date.now();
  const floor = minMs || 900;
  let last = -1, quiet = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(120);
    const n = all(ITEM).length;
    if (n > 0 && n === last) quiet++;
    else quiet = 0;
    last = n;
    // 展开视图的首批固定是 5 条，几乎一定会再跳到 50 条。看到 5 条时把观察期拉长，
    // 免得第二批来得晚一点（实测 180~430ms，留到 1.5s）就漏掉。
    const floorNow = (n > 0 && n <= 5) ? Math.max(floor, 1500) : floor;
    if (n > 0 && (Date.now() - t0) >= floorNow && quiet >= 4) return n;
    if (n === 0 && (Date.now() - t0) >= 1200) return 0;   // 确实没结果，别空等
  }
  return all(ITEM).length;
}
const WAIT_STABLE_SRC = waitStableItems.toString();

// 组装两阶段结果：纯函数，主进程和测试共用，避免脚本内外两套逻辑。
// 对话类永远来自首屏（via=all）；消息类在展开成功后换成全量（via=msg）。
// toString() 会原样注入搜索脚本，所以别引外部变量。
function mergeSearchStages(baseItems, msgItems, expanded) {
  const base = Array.isArray(baseItems) ? baseItems : [];
  const talk = base.filter((x) => String(x.kind || '').indexOf('对话') >= 0)
    .map((x) => Object.assign({}, x, { via: 'all' }));
  let msg = base.filter((x) => String(x.kind || '').indexOf('消息') >= 0)
    .map((x) => Object.assign({}, x, { via: 'all' }));
  const full = Array.isArray(msgItems) ? msgItems : [];
  if (expanded && full.length) msg = full.map((x) => Object.assign({}, x, { via: 'msg' }));
  return { items: talk.concat(msg), expanded: !!expanded && full.length > 0 };
}
const MERGE_STAGES_SRC = mergeSearchStages.toString();

// 逐页加载更多。这段源码会注入搜索脚本和跳转脚本，只引用闭包里已有的变量。
// 2026-11-11 实测：后台 0×0 视图里「查看全部」只给第一页 50 条，
// 但只要 scrollTop = scrollHeight 再派发一个 scroll 事件，就会加载下一页 50 条；
// 不需要撑高容器、不需要改任何样式。循环到条数不再增长就是到底了。
function loadMorePage(sleep, all, ITEM) {
  return async () => {
    const findScroller = () => {
      const first = all(ITEM)[0];
      let sc = first ? first.parentElement : null;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 10)) sc = sc.parentElement;
      return sc;
    };
    const sc = findScroller();
    const before = all(ITEM).length;
    if (!sc) return { grown: false, done: true, count: before, why: 'no-scroller' };
    sc.scrollTop = sc.scrollHeight;
    try { sc.dispatchEvent(new Event('scroll', { bubbles: true })); }
    catch (e) { return { grown: false, done: true, count: before, why: 'no-dispatch' }; }
    for (let i = 0; i < 14; i++) {
      await sleep(90);
      if (all(ITEM).length > before) break;
    }
    await sleep(140);                       // 让新条目的文本渲染完
    const n = all(ITEM).length;
    return { grown: n > before, done: n <= before, count: n };
  };
}
const LOAD_MORE_SRC = loadMorePage.toString();

const SEL_INPUT = '[data-testid=search-input]';
const SEL_ITEM = '[data-testid=search-result-item]';
const SEL_SECTION = '[data-testid=search-result-section]';
const SEL_ENTRY = '[data-testid=global-search-icon-entry]';
const SEL_CLOSE = '[data-testid=search-dialog-close]';
const SEL_VIEW_ALL = '[data-testid=search-view-all]';

// 搜索脚本分两阶段，供主进程「搜到一批就推一批」：
//   stage=1 打开面板 + 填词 + 读「全部」视图首屏（约 11 条）
//   stage=2 点「消息」查看全部 + 读全量（约 50 条）
//   stage=0 一次跑完（兼容旧的一次性调用，测试/兜底用）
// 返回结构见各处 return；stage1 给 base，stage2 给 msg，主进程用
// mergeSearchStages() 组装，避免两处逻辑走样。
const PAGE_SEARCH_SCRIPT = `
(async (kw, stage) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const one = (s, root) => (root || document).querySelector(s);
  const all = (s, root) => Array.from((root || document).querySelectorAll(s));
  const INPUT = ${JSON.stringify(SEL_INPUT)};
  const ITEM = ${JSON.stringify(SEL_ITEM)};
  const SECTION = ${JSON.stringify(SEL_SECTION)};
  const ENTRY = ${JSON.stringify(SEL_ENTRY)};
  const CLOSE = ${JSON.stringify(SEL_CLOSE)};
  const VIEW_ALL = ${JSON.stringify(SEL_VIEW_ALL)};

  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  // 内容签名：标题 + 第二行。给跳转用，下标会漂，文本不会。
  const sigOf = (el) => {
    const lines = (el.innerText || '').split('\\n').map(norm).filter(Boolean);
    return (lines[0] || '') + '\\u0001' + (lines[1] || '');
  };
  // 等列表「长稳」：豆包是分批渲染的（先 5 条再 50 条），
  // 不等稳就读下标，后面的条目会把前面的下标顶掉。
  const waitStable = ${WAIT_STABLE_SRC};

  // 读列表前必须确认输入框里还是本轮关键词：并发搜索/面板恢复旧词时，
  // 列表可能属于别的词（实测「母婴柜」桶混进过「泼水」的结果）。
  const inputVal = () => {
    const el = one(INPUT);
    return el ? String(el.value || '').trim() : '';
  };
  // 豆包会把搜索框里的尾部标点/引号清掉（实测 ? ？ 。 ‘ ’ “ ” 都发生过），
  // 这时输入框和关键词只差标点，不能判成「搜了别的词」。去标点后比较，
  // 既放过同一个词，又能拦住并发搜索/面板恢复的另一个词。
  const qKey = (s) => String(s == null ? '' : s).replace(/[\\s\\p{P}\\p{S}]+/gu, '').toLowerCase();
  const wrongInput = () => {
    const a = qKey(inputVal()), b = qKey(kw);
    return !a || !b || a !== b;
  };
  const wrong = (stage) => ({ ok: false, why: 'wrong-input', stage: stage, inputVal: inputVal() });

  const readItems = (forceKind) => all(ITEM).map((el, idx) => {
    const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const sec = el.closest(SECTION);
    const kind = forceKind || (sec ? ((sec.innerText || '').split('\\n')[0] || '').trim() : '');
    return { i: idx, kind: kind, a: lines[0] || '', b: lines[1] || '', c: lines[2] || '', sig: sigOf(el) };
  });

  // 阶段一只要「看到就推」：首屏是全部视图，实测 115ms 就齐了，
  // 等稳反而白等一秒。真正的分批（5→50）发生在阶段二，那里才用 waitStable。
  const waitFirst = async (maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(90);
      if (all(ITEM).length > 0) {
        await sleep(260);              // 给分组容器一点渲染时间
        return all(ITEM).length;
      }
    }
    return 0;
  };

  // 结果列表指纹：条数 + 首尾两条签名。换词后用它判断「列表到底刷没刷新」。
  const fpOf = () => {
    const els = all(ITEM);
    if (!els.length) return '';
    return els.length + '|' + sigOf(els[0]) + '|' + sigOf(els[els.length - 1]);
  };

  // 阶段一：填词、读首屏
  const doStage1 = async () => {
    const prevKw = window.__dbSearchKw || '';
    // 上次停在「单类全量」视图（没有分组）时先关掉重开，回到「全部」视图；
    // 其他情况**保持面板打开**——在同一个输入框里换词才可靠触发豆包重新搜索，
    // 每次关掉重开反而会出现「词换了但根本没搜」。
    if (one(INPUT) && !one(SECTION)) {
      const c = one(CLOSE);
      if (c) c.click();
      for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40);
    }
    if (!one(INPUT)) {
      const entry = one(ENTRY);
      if (!entry) return { ok: false, why: 'no-entry', stage: 1 };
      entry.click();
      for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40);
    }
    const input = one(INPUT);
    if (!input) return { ok: false, why: 'no-input', stage: 1 };
    input.focus();
    // 填词前记下当前列表指纹：换词后必须看到它变了，才说明豆包真的搜了新词
    const beforeFp = fpOf();
    const typeKw = () => {
      const el = one(INPUT);
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, kw);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    typeKw();
    // 换词时**必须看到列表真的变了**才算数（同一个词重搜允许不变）。
    // 没变就重填 + 补回车再等；始终不变就报 stale —— 宁可这次不读，也绝不把上一轮结果当本轮缓存下来。
    const mustChange = (prevKw !== '' && prevKw !== kw) && !!beforeFp;
    const waitRefresh = async (maxMs) => {
      const t0 = Date.now();
      let emptySince = 0;
      while (Date.now() - t0 < maxMs) {
        await sleep(80);
        const n = all(ITEM).length;
        if (n === 0) {
          // 旧列表被清空、且持续没结果 → 当作「真的没结果」（这个账号没搜到），不能算串词
          if (!emptySince) emptySince = Date.now();
          if (Date.now() - emptySince >= 1000) return 'empty';
          continue;
        }
        emptySince = 0;
        if (fpOf() !== beforeFp) { await sleep(180); return 'changed'; }
      }
      return 'unchanged';
    };
    let state = mustChange ? 'unchanged' : 'changed';
    for (let attempt = 0; attempt < 3 && state === 'unchanged'; attempt++) {
      state = await waitRefresh(1400);
      if (state === 'unchanged') {
        typeKw();
        const el = one(INPUT);
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        } catch (e) {}
      }
    }
    // 换词后列表一直不变：有时是面板还压着上一个词/上一批结果。
    // 先关掉重开再搜一次，别让一个账号因为面板没刷新整组消失。
    if (mustChange && state === 'unchanged') {
      const c1 = one(CLOSE);
      if (c1) c1.click();
      for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40);
      if (!one(INPUT)) {
        const e1 = one(ENTRY);
        if (e1) e1.click();
        for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40);
      }
      typeKw();
      const el1 = one(INPUT);
      if (el1) {
        try {
          el1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          el1.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        } catch (e) {}
      }
      await sleep(180);
      state = await waitRefresh(1800);
    }
    if (mustChange && state === 'unchanged') return { ok: false, why: 'stale', stage: 1 };
    // 换词后列表一直空：可能是面板没触发 / 渲染慢。强制关掉重开再搜一次，给足时间；
    // 还空就再补一次回车。别把「其实有结果」误报成 0 条
    // （实测「上翻门」首发 0、复测 475；「柜子/提示词」首发 0、复测几百条）。
    if (state === 'empty') {
      const c0 = one(CLOSE);
      if (c0) { c0.click(); for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40); }
      if (!one(INPUT)) {
        const e0 = one(ENTRY);
        if (e0) { e0.click(); for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40); }
      }
      typeKw();
      const el2 = one(INPUT);
      try {
        el2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el2.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (e) {}
      await sleep(180);
      await waitFirst(3000);
      if (all(ITEM).length === 0) {
        typeKw();
        const el3 = one(INPUT);
        try {
          el3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          el3.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        } catch (e) {}
        await sleep(180);
        await waitFirst(2000);
      }
    }
    const stable = await waitFirst(1400);
    // 连续快速换词时，面板偶尔没把新词填进去（还停在上一个词）。
    // 关掉重开再填一次，别把这次搜索直接判死。
    if (wrongInput()) {
      const c1 = one(CLOSE);
      if (c1) c1.click();
      for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40);
      if (!one(INPUT)) {
        const e1 = one(ENTRY);
        if (e1) e1.click();
        for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40);
      }
      typeKw();
      await waitFirst(1400);
    }
    if (wrongInput()) return wrong(1);
    const base = readItems(null);
    // 兜底：换了词却和上一轮读到的结果一模一样 → 也判定没刷新
    const baseFp = base.map((x) => x.sig).join('\u0002');
    if (base.length && prevKw !== '' && prevKw !== kw && baseFp === (window.__dbSearchBaseFp || null)) {
      return { ok: false, why: 'stale', stage: 1 };
    }
    if (base.length) window.__dbSearchBaseFp = baseFp;
    window.__dbSearchKw = kw;
    return { ok: true, stage: 1, stable: stable, count: all(ITEM).length, base: base };
  };

  // 阶段二：展开「消息」全量视图。可单独重跑（补搜），所以要先判断当前停在哪
  const doStage2 = async () => {
    if (!one(INPUT)) return { ok: false, why: 'no-input', stage: 2 };
    if (wrongInput()) return wrong(2);
    // 关键：单类全量视图（没有分组）很可能是上一轮「查看全部」留下的。
    // 直接读会把上一个词的结果当成本轮（实测搜「喂养台」读到 55 条「鞋柜」消息）。
    // 所以先关掉重开、重新搜一次当前词，回到分组视图再走「查看全部」。
    if (one(INPUT) && !one(SECTION) && all(ITEM).length > 0) {
      const c0 = one(CLOSE);
      if (c0) c0.click();
      for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40);
      if (!one(INPUT)) {
        const e0 = one(ENTRY);
        if (e0) e0.click();
        for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40);
      }
      const inp = one(INPUT);
      if (inp) {
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, kw);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFirst(1800);
      }
      if (wrongInput()) return wrong(2);
      // 重新搜完还没有分组：不硬读残留列表，交给上层（stage1 base 兜底 / 补搜）
      if (!one(SECTION)) {
        return { ok: true, stage: 2, expanded: false, settled: 0,
                 count: all(ITEM).length, msg: [], why: 'no-group-after-refresh' };
      }
    }
    // 「消息」分组 / 查看全部按钮可能晚到，多找几轮，别因为没找到就漏掉整个账号的全量
    let va = null;
    for (let attempt = 0; attempt < 8 && !va; attempt++) {
      const msgSec = all(SECTION).find((s) => ((s.innerText || '').split('\\n')[0] || '').indexOf('消息') >= 0);
      va = msgSec ? msgSec.querySelector(VIEW_ALL) : null;
      if (!va) await sleep(150);
    }
    if (!va) {
      return { ok: true, stage: 2, expanded: false, settled: 0,
               count: all(ITEM).length, msg: [], why: 'no-view-all' };
    }
    if (wrongInput()) return wrong(2);
    va.click();
    await waitStable(3000, 900);
    if (wrongInput()) return wrong(2);
    // 展开成功的标志：分组容器消失（单类全量视图没有分组）
    if (!one(SECTION)) {
      // 二次复核：首批可能只给 5 条，再等一拍取条数更多的那次
      let finalItems = readItems('消息');
      for (let k = 0; k < 3 && finalItems.length <= 5; k++) {
        await sleep(450);
        const more = readItems('消息');
        if (more.length > finalItems.length) finalItems = more;
      }
      return { ok: true, stage: 2, expanded: true, settled: finalItems.length,
               count: all(ITEM).length, msg: finalItems };
    }
    return { ok: true, stage: 2, expanded: false, settled: 0,
             count: all(ITEM).length, msg: [], why: 'not-switched' };
  };

  const loadMore = ${LOAD_MORE_SRC}(sleep, all, ITEM);

  // 阶段三：加载下一页。主进程可以反复调用，每调用一次就推一批，天然流式。
  const doStage3 = async () => {
    if (wrongInput()) return wrong(3);
    const r = await loadMore();
    if (wrongInput()) return wrong(3);
    return { ok: true, stage: 3, grown: r.grown, done: r.done,
             count: r.count, items: readItems('消息'), why: r.why || '' };
  };

  if (stage === 1) return await doStage1();
  if (stage === 2) return await doStage2();
  if (stage === 3) return await doStage3();
  const a = await doStage1();
  if (!a.ok) return a;
  const b = await doStage2();
  const merged = ${MERGE_STAGES_SRC}(a.base, b.msg, b.expanded);
  return { ok: true, count: all(ITEM).length, stable: a.stable,
           expanded: merged.expanded, settled: b.settled || 0,
           baseCount: a.base.length, items: merged.items };
})(KEYWORD_PLACEHOLDER, STAGE_PLACEHOLDER)
`;

// 在一串签名里找目标，返回下标；找不到返回 -1。
// 同签名可能有多条（同一会话里两句一模一样的话），取离原下标最近的那条。
// 这段源码会被原样注入到页面脚本里，所以：纯 ES5、不用模板字符串、不引用外部变量。
function pickBySig(sigs, sig, idx) {
  if (!sig) return -1;
  var best = -1;
  var bestD = Infinity;
  for (var i = 0; i < sigs.length; i++) {
    if (sigs[i] !== sig) continue;
    var d = Math.abs(i - idx);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
const PICK_SRC = pickBySig.toString();

// 跳到目标条目：优先按内容签名找，找不到才退回下标。
// via='msg' 时先点开消息全量再点；展开不了就报 no-expand，绝不硬点。
const PAGE_JUMP_SCRIPT = `
(async (kw, idx, via, sig, opts) => {
  const O = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const one = (s, root) => (root || document).querySelector(s);
  const all = (s, root) => Array.from((root || document).querySelectorAll(s));
  // 同一账号只允许一次跳转在跑。主进程给每次跳转发一个令牌；
  // 新跳转进来会立刻把页面上的令牌改掉，旧脚本在翻页/填词/点击前看到不一致
  // 就直接退出，避免旧的翻页和新的重新搜索抢同一个搜索面板。
  const TOKEN = String(O.token || '');
  const alive = () => !TOKEN || (typeof window !== 'undefined' &&
    String(window.__dbJumpToken || '') === TOKEN);
  const EXPAND_MSG = !!O.expandMsg;      // 候选搜索也要点「消息」的查看全部
  const INPUT = ${JSON.stringify(SEL_INPUT)};
  const ITEM = ${JSON.stringify(SEL_ITEM)};
  const SECTION = ${JSON.stringify(SEL_SECTION)};
  const ENTRY = ${JSON.stringify(SEL_ENTRY)};
  const CLOSE = ${JSON.stringify(SEL_CLOSE)};
  const VIEW_ALL = ${JSON.stringify(SEL_VIEW_ALL)};

  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const flat = (s) => norm(s).replace(/[\\s\\p{P}\\p{S}]+/gu, '');
  const sigOf = (el) => {
    const lines = (el.innerText || '').split('\\n').map(norm).filter(Boolean);
    return (lines[0] || '') + '\\u0001' + (lines[1] || '');
  };
  const waitStable = ${WAIT_STABLE_SRC};
  const loose = !!O.loose;
  const ONLY_MSG = !!O.onlyMsg;
  const MAX_PAGES = Number.isFinite(Number(O.maxPages)) ? Math.max(0, Math.floor(Number(O.maxPages))) : 80;
  const DEEP_MS = Number.isFinite(Number(O.deepMs)) ? Math.max(0, Math.floor(Number(O.deepMs))) : 30000;
  const WAIT_MS = Number.isFinite(Number(O.waitMs)) ? Math.max(0, Math.floor(Number(O.waitMs))) : 8000;
  const WANT_TIME = String(O.time || '').trim();
  // 候选词不值得等太久：一轮 3 秒没刷新就换词；原词仍按两轮 4 秒慢慢等
  const STALE_ROUNDS = loose ? 1 : 2;
  const STALE_MS = loose ? 3000 : 4000;

  // 每次跳转都关掉重开：页面可能恢复上一次的搜索结果，把旧列表当成本轮
  // （深结果会误判 item-gone，或者点到上一轮同一位置的别的消息）。
  // 关面板偶尔会慢/关不掉：连关三轮，还关不掉就明确报 panel-stuck，
  // 别拿着旧面板继续填词，最后误报 stale。
  const closePanel = async () => {
    for (let round = 0; round < 3 && one(INPUT); round++) {
      const c = one(CLOSE);
      if (c) c.click();
      else {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        } catch (e) {}
      }
      for (let i = 0; i < 25 && one(INPUT); i++) await sleep(60);
    }
    return !one(INPUT);
  };
  if (!(await closePanel())) return { ok: false, why: 'panel-stuck', total: all(ITEM).length };
  if (!alive()) return { ok: false, why: 'superseded' };
  const entry = one(ENTRY);
  if (!entry) return { ok: false, why: 'no-entry' };
  entry.click();
  for (let i = 0; i < 50 && !one(INPUT); i++) await sleep(40);
  const input = one(INPUT);
  if (!input) return { ok: false, why: 'no-input' };
  input.focus();
  await sleep(150);                          // 等面板动画/输入框状态稳定
  const fpOf = () => {
    const els = all(ITEM);
    if (!els.length) return '';
    return els.length + '|' + sigOf(els[0]) + '|' + sigOf(els[els.length - 1]);
  };
  const beforeFp = fpOf();
  const prevVal = String(input.value || '').trim();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  // 先清空再填：面板恢复上一轮的词时，直接 set 同一个值 React 可能不认，
  // 导致搜索根本没触发（真机 yang'tai/书柜 就卡在这里）。
  try {
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
  } catch (e) {}
  setter.call(input, kw);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // 如果打开的面板还留着上一次的查询，换词后必须等列表真的变了再读；
  // 等不到就补一次回车再等，始终不变则明确失败，别把旧列表当本轮结果。
  if (beforeFp && prevVal && prevVal !== kw) {
    let sawEmpty = false, changed = false;
    for (let round = 0; round < STALE_ROUNDS && !changed; round++) {
      const t0 = Date.now();
      while (Date.now() - t0 < STALE_MS) {
        await sleep(80);
        const n = all(ITEM).length;
        if (n === 0) { sawEmpty = true; continue; }
        if (sawEmpty || fpOf() !== beforeFp) { changed = true; break; }
      }
      if (!changed) {
        try {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        } catch (e) {}
      }
    }
    if (!changed) {
      return { ok: false, why: 'stale', total: all(ITEM).length,
        prevVal: prevVal, inputVal: String(input.value || ''), beforeFp: beforeFp.slice(0, 60) };
    }
  }
  // 换词搜索可能比「恢复上次结果」慢不少：先等结果真的出来，再交给 waitStable 判稳。
  // 候选词只等很短（默认 3 秒），还空就补一次回车；仍空就快失败，好让主进程换下一个词。
  {
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS && all(ITEM).length === 0) await sleep(100);
  }
  if (loose && !all(ITEM).length) {
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (e) {}
    const t1 = Date.now();
    while (Date.now() - t1 < 2000 && all(ITEM).length === 0) await sleep(100);
  }
  if (all(ITEM).length) await waitStable(loose ? 2000 : 4000, 900);
  if (!alive()) return { ok: false, why: 'superseded' };

  let expanded = false;
  if (via === 'msg' || EXPAND_MSG) {
    const msgSec = all(SECTION).find((s) => ((s.innerText || '').split('\\n')[0] || '').indexOf('消息') >= 0);
    const va = msgSec ? msgSec.querySelector(VIEW_ALL) : null;
    // 原词目标是消息时必须展开；候选词能展开就展开——候选常常只给 5 条，
    // 目标在「查看全部」的后面，不展开就会误判没找到并换下一个词。
    if (va) {
      va.click();
      await waitStable(3000, 900);
      expanded = true;
    } else if (via === 'msg') {
      return { ok: false, why: 'no-expand', total: all(ITEM).length };
    }
  }

  let items = all(ITEM);
  if (!items.length) return { ok: false, why: 'no-item', total: 0 };

  // 按内容签名找人。下标会漂（同一关键词两次搜出来的条数都不一样），文本不会。
  const pickBySig = ${PICK_SRC};
  const loadMore = ${LOAD_MORE_SRC}(sleep, all, ITEM);
  let at = pickBySig(items.map(sigOf), sig, idx);
  let by = at >= 0 ? 'sig' : 'index';
  let deepPages = 0, deepStall = 0;

  // 换了搜索词，豆包给的摘要窗口也会变（同一句话，截取位置不同），
  // 原签名就对不上了。候选词本来就把结果缩到一两条，这时用
  // 「标题一致 + 正文含这个候选词」找；有多条同标题时，再用条目时间消歧。
  // 仍不唯一就宁可不点（按错比找不到更糟），交给主进程换下一个候选。
  const hasSections = all(SECTION).length > 0;
  const inMsgSection = (el) => {
    let p = el.parentElement;
    while (p) {
      const tid = p.getAttribute ? p.getAttribute('data-testid') : '';
      if (tid === 'search-result-section') {
        return ((p.innerText || '').split('\\n')[0] || '').indexOf('消息') >= 0;
      }
      p = p.parentElement;
    }
    return false;
  };
  const loosePick = (els) => {
    if (!loose || !sig) return null;
    const wantTitle = String(sig).split('\\u0001')[0].trim();
    const wantText = flat(kw);
    if (!wantTitle || !wantText) return null;
    const cands = [], timed = [];
    els.forEach((el, i) => {
      // 目标是消息时只认「消息」分组：标题搜索常把会话顶上来，
      // 点进去只会打开会话、不在那条消息上，高亮必然找不到。
      if (ONLY_MSG && hasSections && !inMsgSection(el)) return;
      const rawText = el.innerText || '';
      const first = (rawText.split('\\n')[0] || '').trim();
      if (first.indexOf(wantTitle) < 0) return;
      if (flat(rawText).indexOf(wantText) < 0) return;
      cands.push(i);
      if (WANT_TIME && norm(rawText).indexOf(WANT_TIME) >= 0) timed.push(i);
    });
    if (cands.length === 1) return { at: cands[0], by: 'sig-loose' };
    if (cands.length > 1 && timed.length === 1) return { at: timed[0], by: 'sig-time' };
    return null;
  };
  if (at < 0) {
    const lp = loosePick(items);
    if (lp) { at = lp.at; by = lp.by; }
  }

  // 搜索结果可能远不止第一页 50 条：这一页找不到就继续翻页找。
  // 候选词浅试几页就收手，原词才深翻（默认 80 页 / 30 秒，连续 3 页不涨判到底）。
  if (at < 0 && sig) {
    const tDeep = Date.now();
    for (let page = 0; page < MAX_PAGES && Date.now() - tDeep < DEEP_MS && at < 0; page++) {
      if (!alive()) return { ok: false, why: 'superseded', total: items.length, deepPages: deepPages };
      const r = await loadMore();
      deepPages++;
      if (!alive()) return { ok: false, why: 'superseded', total: all(ITEM).length, deepPages: deepPages };
      items = all(ITEM);
      at = pickBySig(items.map(sigOf), sig, idx);
      if (at >= 0) { by = 'sig'; break; }
      const lp = loosePick(items);
      if (lp) { at = lp.at; by = lp.by; }
      if (r.grown) deepStall = 0; else deepStall++;
      if (deepStall >= 3) break;
    }
  }
  if (at < 0) {
    if (!items[idx]) return { ok: false, why: 'item-gone', total: items.length, deepPages: deepPages };
    at = idx;
  }

  // ⚠️ 千万不要在点击前 scrollIntoView。
  // 豆包的结果列表是虚拟化的：一滚动就重新渲染，手里的 el 会变成
  // isConnected=false 的游离节点；对游离节点 click() 事件不会冒泡到 React，
  // 等于没点。实测 idx=29/36/38 全部「点了没反应」，idx=3/21（本来就在视口里）正常。
  // 程序化 click() 不需要元素可见，所以直接点即可。
  if (!alive()) return { ok: false, why: 'superseded', total: items.length, deepPages: deepPages };
  const liveItems = all(ITEM);
  const liveAt = pickBySig(liveItems.map(sigOf), sig, idx);
  let finalAt = liveAt >= 0 ? liveAt : at;
  if (liveAt < 0 && (by === 'sig-loose' || by === 'sig-time')) {
    const lp = loosePick(liveItems);       // 点击前按同一规则重新取活节点，防下标漂
    if (lp) finalAt = lp.at;
  }
  const el = liveItems[finalAt] || items[at];
  const firstTitle = liveItems[0] ? ((liveItems[0].innerText || '').split('\\n')[0] || '').trim() : '';
  const urlBefore = location.href;
  const clickedConnected = !!(el && el.isConnected);
  if (el) el.click();

  // 判断「这一下有没有被受理」：URL 变了，或者豆包自己把搜索面板收了。
  // 同一个会话里的消息跳转 URL 不变，所以不能只看 location.href。
  await sleep(800);
  let navigated = location.href !== urlBefore;
  let landed = navigated || !one(INPUT);
  let retried = false;
  if (!landed) {
    // 没受理就补一刀：重新按签名拿最新节点，用带 view 的 MouseEvent 再点一次
    const freshList = all(ITEM);
    const freshIdx = pickBySig(freshList.map(sigOf), sig, finalAt);
    const fresh = freshList[freshIdx >= 0 ? freshIdx : finalAt] || null;
    if (fresh) {
      try {
        fresh.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) { try { fresh.click(); } catch (e2) {} }
      retried = true;
      await sleep(700);
      navigated = location.href !== urlBefore;
      landed = navigated || !one(INPUT);
    }
  }

  // 兜底：豆包自己的搜索面板时不时不会自动收起（用户实测「有时候跳转后还开着」）。
  // 放在 landed 判定之后，免得我们自己关面板把「点击被受理」这个信号盖掉。
  let panelClosed = !one(INPUT);
  if (!panelClosed) {
    const c = one(CLOSE);
    if (c) c.click();
    await sleep(220);
    panelClosed = !one(INPUT);
  }
  if (!panelClosed) {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch (e) {}
    await sleep(220);
    panelClosed = !one(INPUT);
  }
  return { ok: true, total: items.length, navigated: navigated, panelClosed: panelClosed,
           landed: landed, retried: retried, clickedConnected: clickedConnected,
           by: by, at: finalAt, expanded: expanded, deepPages: deepPages,
           q: kw, inputVal: String(input.value || ''), firstTitle: firstTitle };
})(KEYWORD_PLACEHOLDER, INDEX_PLACEHOLDER, VIA_PLACEHOLDER, SIG_PLACEHOLDER, OPTS_PLACEHOLDER)
`;

// 跳过去之后，滚到包含关键词的那条消息并描边 5 秒。
//
// 2026-11-10 用户反馈「看到蓝色文字了，但页面还是翻过头，翻到别的地方」：
//   豆包会话区在消息加载完 / 虚拟列表重排之后会自己滚动（常常回到底部），
//   以前只 scrollIntoView 一次就被带走了。现在：
//     ① 等高稳定再定位；② 高亮窗口内持续把目标拉回中间；
//     ③ 用户一旦自己滚（wheel/touch/mousedown/keydown）立刻让开，不抢滚动条；
//     ④ 用结果条目的片段文本优先锁定「点的那条」，而不是会话里第一条含关键词的。
const PAGE_HIGHLIGHT_SCRIPT = `
(async (kw, frag) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = String(kw || '').trim();
  if (!KEY) return { ok: false, why: 'no-key' };
  const SEL = '[data-message-id], [data-testid=message_text_content], [class*=flow-markdown-body i], [class*=message-content i]';
  const DURATION = 5000;
  const INPUT = '[data-testid=search-input]';
  const CLOSE = '[data-testid=search-dialog-close]';

  // 豆包会把「这次搜索用的候选词」选中/高亮（比如跳转为了定位用了长句），
  // 用户看到的就不是自己搜的词。先清掉它的选区，再用 CSS Custom Highlight
  // 把用户原关键词（KEY）标黄，整条消息的蓝色描边仍然保留。
  const clearSelection = () => {
    try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (e) {}
  };
  const HAS_HL = !!(window.CSS && window.CSS.highlights &&
    typeof document.createTreeWalker === 'function' &&
    typeof Range !== 'undefined' && typeof Highlight !== 'undefined');
  const HL_NAME = 'db-keyword';
  let hlStyle = null, kwRoot = null;
  const kwRanges = (root) => {
    const out = [];
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue || '';
        if (!t || t.indexOf(KEY) < 0) continue;
        let i = 0;
        while ((i = t.indexOf(KEY, i)) >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + KEY.length);
          out.push(r);
          i += KEY.length;
        }
      }
    } catch (e) {}
    return out;
  };
  const clearKeyword = () => {
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete(HL_NAME); } catch (e) {}
    try { if (hlStyle && hlStyle.parentNode) hlStyle.parentNode.removeChild(hlStyle); } catch (e) {}
    hlStyle = null;
    kwRoot = null;
  };
  // 豆包自己给「本次搜索候选词」画的高亮（高亮名实测是 flow-locate-target-highlight）。
  // 用户要看到的是自己搜的词，不是跳转内部用的候选，所以在高亮窗口内把它删掉。
  const clearForeignHighlights = () => {
    try {
      if (window.CSS && CSS.highlights) {
        for (const k of Array.from(CSS.highlights.keys())) {
          if (k !== HL_NAME) CSS.highlights.delete(k);
        }
      }
    } catch (e) {}
  };
  const ensureKeyword = (root) => {
    if (!HAS_HL || !root || root === kwRoot) return;
    const ranges = kwRanges(root);
    clearKeyword();
    kwRoot = root;
    if (!ranges.length) return;
    try {
      hlStyle = document.createElement('style');
      hlStyle.textContent = '::highlight(db-keyword){background-color:#ffe066;color:inherit;}';
      (document.head || document.documentElement).appendChild(hlStyle);
      CSS.highlights.set(HL_NAME, new Highlight(...ranges));
    } catch (e) {}
  };
  clearSelection();
  clearForeignHighlights();
  // 面板还开着时把它收掉：候选词被选中看起来就像高亮了别的词
  try {
    if (one(INPUT)) {
      const c = one(CLOSE);
      if (c) c.click();
      for (let i = 0; i < 20 && one(INPUT); i++) await sleep(40);
    }
  } catch (e) {}

  // 页面上的文本和搜索摘要不完全一样：豆包会把「/」两边加空格、把列表序号
  // 渲染成列表标记（innerText 里没有「1. 」）。匹配前统一去掉空白/标点/符号。
  const flat = (s) => String(s == null ? '' : s).replace(/[\\s\\p{P}\\p{S}]+/gu, '');
  const FRAGS = (Array.isArray(frag) ? frag : (frag ? [frag] : [])).map(flat).filter(Boolean);
  const WANT_FRAG = FRAGS.length > 0;
  const findBest = () => {
    let best = null, bestScore = -1, bestExact = false;
    for (const n of document.querySelectorAll(SEL)) {
      const t = n.innerText || '';
      // 长提示词/长文案消息 2000 字根本不够（实测有 2493 字的节点），
      // 放宽到 2 万字；同分时优先短节点，不会描到整个会话。
      if (t.length < 1 || t.length >= 20000) continue;
      const ft = flat(t);
      let matched = 0;
      for (const f of FRAGS) if (ft.indexOf(f) >= 0 && f.length > matched) matched = f.length;
      // 有片段时只认片段（任一句命中即可）：像「1」这种大词，页面上几十条
      // 消息都含 1，找不到点的那条就宁可说没找到，也不能随便描一条。
      if (WANT_FRAG && !matched) continue;
      const hasKey = t.indexOf(KEY) >= 0;
      if (!WANT_FRAG && !hasKey) continue;
      const s = matched * 10 + (hasKey ? 1 : 0) - Math.min(t.length, 20000) / 100000;
      if (s > bestScore) { bestScore = s; best = n; bestExact = matched > 0; }
    }
    return { node: best, exact: bestExact };
  };

  let hit = null, exact = false;
  for (let i = 0; i < 25; i++) {              // 最多等 5 秒：消息可能是懒加载出来的
    await sleep(200);
    const r = findBest();
    if (r.node) { hit = r.node; exact = r.exact; }
    if (r.exact) break;
  }
  if (!hit) return { ok: false, why: 'not-found' };

  // 描边范围：优先整条消息行（含头像/时间/气泡），别再只描一行文字。
  const widen = (el) => {
    try {
      const row = el.closest ? el.closest('[data-message-id]') : null;
      if (row) return row;
    } catch (e) {}
    let best = el, p = el.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      if (p.scrollHeight > p.clientHeight + 20) break;     // 到滚动容器就停
      const pw = p.getBoundingClientRect().width;
      const ew = el.getBoundingClientRect().width;
      const pl = (p.innerText || '').length;
      const elLen = (el.innerText || '').length;
      if (pw > 0 && pw >= ew * 0.99 && pl <= elLen + 300) best = p;
      p = p.parentElement;
    }
    return best;
  };
  const wide = widen(hit);

  // 等会话区高度稳定：消息懒加载会把页面往下顶，这时候定位必然被冲掉
  const scrollerOf = (el) => {
    let p = el.parentElement;
    while (p) { if (p.scrollHeight > p.clientHeight + 20) return p; p = p.parentElement; }
    return null;
  };
  const height = () => {
    const s = scrollerOf(wide);
    return s ? s.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0);
  };
  let lastH = -1, stable = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(120);
    const h = height();
    if (h === lastH) { stable++; if (stable >= 2) break; } else { stable = 0; }
    lastH = h;
  }

  // 样式：节点可能被虚拟列表换掉，所以样式跟着「当前节点」走
  let styled = null, prev = null;
  const restore = () => {
    clearKeyword();
    clearForeignHighlights();
    if (!styled) return;
    if (prev) {
      styled.style.outline = prev.outline;
      styled.style.outlineOffset = prev.offset;
      styled.style.borderRadius = prev.radius;
    }
    styled = null; prev = null;
  };
  const apply = (el) => {
    if (!el || styled === el) return;
    restore();
    styled = el;
    prev = { outline: el.style.outline, offset: el.style.outlineOffset, radius: el.style.borderRadius };
    el.style.outline = '2px solid #4F86F7';
    el.style.outlineOffset = '4px';
    el.style.borderRadius = '8px';
  };
  const center = (el) => {
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
    catch (e) { try { el.scrollIntoView({ block: 'center' }); } catch (e2) {} }
  };

  apply(wide);
  center(wide);
  ensureKeyword(wide);

  // 用户一旦自己动滚动条就别抢：只撤掉「拉回」的循环，高亮仍然留满 5 秒
  let userTookOver = false;
  const stop = () => { userTookOver = true; };
  document.addEventListener('wheel', stop, { passive: true, once: true });
  document.addEventListener('touchstart', stop, { passive: true, once: true });
  document.addEventListener('mousedown', stop, { once: true });
  document.addEventListener('keydown', stop, { once: true });

  const until = Date.now() + DURATION;
  const timer = setInterval(() => {
    const left = until - Date.now();
    if (left <= 0 || userTookOver) {
      clearInterval(timer);
      if (left <= 0) restore();
      else setTimeout(restore, left);          // 用户接管后也让描边留满 5 秒
      return;
    }
    // 豆包点击搜索结果后会留一段选区/自己的高亮（内容都是候选查询，不是用户搜的词）。
    // 它们可能在我们开始高亮之后才设置，所以窗口内反复清；用户自己一动就让开。
    clearSelection();
    clearForeignHighlights();
    // 虚拟列表可能把节点换掉：节点不在文档里就重新找一次，并把样式挪过去
    if (!hit || !hit.isConnected) {
      const r = findBest();
      if (!r.node) return;
      hit = r.node;
    }
    const el = widen(hit);
    if (!el) return;
    apply(el);
    ensureKeyword(el);
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 0);
    const mid = r.top + r.height / 2;
    if (r.bottom < 0 || r.top > vh || Math.abs(mid - vh / 2) > vh * 0.3) center(el);
  }, 350);

  return { ok: true, exact: exact };
})(KEYWORD_PLACEHOLDER, FRAG_PLACEHOLDER)
`;

// 用函数式替换：字符串替换里 `$&`、`$1` 会被当成替换模式，
// 用户搜「$&」这种词时脚本会被改坏。
function fillSearchScript(keyword, stage) {
  const st = (stage === 1 || stage === 2 || stage === 3) ? stage : 0;
  return PAGE_SEARCH_SCRIPT
    .replace('KEYWORD_PLACEHOLDER', () => JSON.stringify(String(keyword == null ? '' : keyword)))
    .replace('STAGE_PLACEHOLDER', () => String(st));
}
function fillStage1Script(keyword) { return fillSearchScript(keyword, 1); }
function fillStage2Script(keyword) { return fillSearchScript(keyword, 2); }
function fillStage3Script(keyword) { return fillSearchScript(keyword, 3); }
function fillJumpScript(keyword, index, via, sig, opts) {
  const v = (via === 'msg') ? 'msg' : 'all';
  const o = opts || {};
  const num = (x, d) => (Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : d);
  const payload = {
    loose: !!o.loose,
    onlyMsg: !!o.onlyMsg,
    expandMsg: !!o.expandMsg,
    maxPages: num(o.maxPages, 80),
    deepMs: num(o.deepMs, 30000),
    waitMs: num(o.waitMs, 8000),
    time: String(o.time == null ? '' : o.time),
    token: String(o.token == null ? '' : o.token)
  };
  return PAGE_JUMP_SCRIPT
    .replace('KEYWORD_PLACEHOLDER', () => JSON.stringify(String(keyword == null ? '' : keyword)))
    .replace('INDEX_PLACEHOLDER', () => String(Number.isFinite(Number(index)) ? Math.floor(Number(index)) : 0))
    .replace('VIA_PLACEHOLDER', () => JSON.stringify(v))
    .replace('SIG_PLACEHOLDER', () => JSON.stringify(String(sig == null ? '' : sig)))
    .replace('OPTS_PLACEHOLDER', () => JSON.stringify(payload));
}
function fillHighlightScript(keyword, fragment) {
  const frags = Array.isArray(fragment) ? fragment : (fragment == null || fragment === '' ? [] : [fragment]);
  return PAGE_HIGHLIGHT_SCRIPT
    .replace('KEYWORD_PLACEHOLDER', () => JSON.stringify(String(keyword == null ? '' : keyword)))
    .replace('FRAG_PLACEHOLDER', () => JSON.stringify(frags.map((x) => String(x))));
}

// 从结果签名里抠出「这条消息的长片段」，用来把高亮锁到点的那条，
// 而不是会话里第一条恰好也含关键词的消息。
// 签名第二段形如「豆包: …，严格还原白色宽体矮柜从推入…」：
// 去掉发送者前缀、按省略号切开，取最长的一段（太短容易撞词）。
function highlightFragments(sig) {
  const b = String(sig == null ? '' : sig).split(SIG_SEP)[1] || '';
  // 去掉「豆包: 」「账号3: 」这类发送者前缀；带空格的日期时间不会被误伤
  const clean = b.replace(/^[\u4e00-\u9fa5A-Za-z0-9_]{1,10}[:：]\s*/, '');
  const parts = clean.split(/…|\.\.\./)
    // 豆包把列表序号（1. 2. 3.）渲染成列表标记，正文 innerText 里没有「1. 」；
    // 按序号把片段拆开，各自去掉序号。
    .flatMap((s) => s.split(/\s+\d{1,2}[.、)]\s+/))
    // 摘要可能跨两句，而页面上是分段的；按句号拆开，任一句对上就能锁到这条消息。
    .flatMap((s) => s.split(/[。！？!?；;\n]+/))
    .map((s) => s.trim()
      .replace(/^\d{1,2}[.、)]\s*/, '')
      .replace(/^[，,。.；;：:\s]+/, '')
      .replace(/[，,。.；;：:\s]+$/, ''))
    .filter((s) => s.length >= 8 && s.length <= 120)
    .filter((s) => !/^\d{1,4}[-/.年月]\d{1,2}/.test(s))   // 日期不是消息片段
    .filter((s) => !/^\d{1,2}:\d{2}$/.test(s));
  parts.sort((a, c) => c.length - a.length);
  const seen = new Set(), out = [];
  for (const p of parts) {
    const key = compactText(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

function highlightFragment(sig) {
  const list = highlightFragments(sig);
  return list[0] || '';
}

// 内容签名：标题 + 第二行，空白归一。和注入脚本里的 sigOf 保持同一套规则。
function buildSig(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return norm(a) + SIG_SEP + norm(b);
}

// 从一段文本里取「关键词周围的那一小段」：前后各 6 字，哪边不够就补另一边。
// 纯函数；jumpCandidates 用这套规则。
function contextPhrase(hay, keyword, width) {
  let text = String(hay == null ? '' : hay);
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!text || !kw) return '';
  const low = kw.toLowerCase();
  // 先清掉「豆包: 」「账号2: 」和开头的省略号：它们不是正文，
  // 留着会白占关键词前面的字数，把该多拿的后文挤掉。
  const pre = /^[^:：\s]{1,8}[:：](?=\s|…)/.exec(text);
  if (pre && pre[0].toLowerCase().indexOf(low) < 0) text = text.slice(pre[0].length);
  text = text.replace(/^[.…·\s]+/, '').replace(/[.…·\s]+$/, '');
  const idx = text.toLowerCase().indexOf(low);
  if (idx < 0) return '';
  // 默认前后各 6 个字；哪一边不够就把另一边补长。
  // 加长版传 width=20，用来把很深的旧消息拉回第一页（截到 40 字以内）。
  const W = Number.isFinite(Number(width)) ? Math.max(1, Math.floor(Number(width))) : 6;
  const len = text.length;
  let before = Math.min(W, idx);
  let after = Math.min(W, len - (idx + kw.length));
  if (before < W) after = Math.min(len - (idx + kw.length), after + (W - before));
  else if (after < W) before = Math.min(idx, before + (W - after));
  let seg = text.slice(idx - before, idx + kw.length + after);
  if (seg.length > 40) seg = seg.slice(0, 40);
  seg = seg.replace(/^[.…·:：\s]+/, '').replace(/[.…·:：\s]+$/, '').trim();
  return seg;
}

// 比较时的紧凑形式：去掉空白、标点和符号。豆包索引一般不区分「/」「，」，
// 这样「更像新能源/智能制造」和「更像新能源智能制造」能认成同一句。
function compactText(s) {
  return String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 拿去搜索的「干净版本」：只删豆包容易搜不出来的符号（斜杠、竖线、星号等），
// 保留「. 」「，」「：」和原有空格 —— 全删光会把「1. 更像」拼成「1更像」，反而搜不到。
function searchablePhrase(s) {
  return String(s == null ? '' : s)
    .replace(/[\/\\|<>*#@$%^&+=~`※★☆•●○◆■□▲△▼▽‘’“”"']+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 加长上下文会跨到下一个列表项（「…智能看板 2. 更像高标准…」），
// 页面正文里没有「2.」这个序号，留着会让宽松匹配对不上，先删掉中间序号。
function stripListMarkers(s) {
  return String(s == null ? '' : s).replace(/\s+\d{1,2}[.、)]\s+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 从一段文本里取若干「无标点从句」，含关键词的优先，再由长到短。
// 实测豆包对带符号的整句反而搜不准：同一个目标，
// 「铰链式上翻门母婴柜，柜门以顶部」搜不到，「铰链式上翻门母婴柜」能搜到；
// 去掉逗号拼起来/换成空格也搜不到。按标点切句、取长句最稳。
function clauseList(hay, keyword, limit) {
  let text = String(hay == null ? '' : hay);
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!text) return [];
  // 去掉「豆包: 」「账号2: 」前缀和开头省略号（和 contextPhrase 一致）
  const pre = /^[^:：\s]{1,8}[:：](?=\s|…)/.exec(text);
  if (pre && pre[0].toLowerCase().indexOf(kw.toLowerCase()) < 0) text = text.slice(pre[0].length);
  text = text.replace(/^[.…·\s]+/, '').replace(/[.…·\s]+$/, '');
  const parts = text
    .split(/[，,。；;！？!?、：\n‘’“”"']+/)    // 不切 ASCII 冒号/句点，避免把 9:16、1. 这种切开
    .map((s, i) => {
      let t = s.trim();
      // 去掉列表序号，但如果序号本身就是关键词（搜「1」），要留着
      const m = /^(\d{1,2})[.、)]\s*/.exec(t);
      if (m && m[1] !== kw) t = t.slice(m[0].length);
      t = t
        .replace(/^[：:，,。.；;！？!?、“”‘’"'\s]+/, '')
        .replace(/[：:，,。.；;！？!?、“”‘’"'\s]+$/, '');
      return { s: t, i: i };
    })
    // 关键词所在从句可能很短（「快递员穿工装」只有 6 个字），
    // 不能再用固定的 8 字门槛把它扔掉，否则会去选很远的长句。
    .filter((x) => x.s.length >= Math.max(4, kw.length + 2))
    .filter((x) => {
      const dense = compactText(x.s);
      return !!dense && /[A-Za-z\u4e00-\u9fa5]/.test(dense);
    });
  const lower = kw.toLowerCase();
  const withKw = parts.filter((x) => x.s.toLowerCase().indexOf(lower) >= 0);
  const rest = parts.filter((x) => x.s.toLowerCase().indexOf(lower) < 0);
  // 含关键词的从句永远优先；同样含关键词时长的优先。
  withKw.sort((a, b) => b.s.length - a.s.length || a.i - b.i);
  // 不够 limit 时只补「紧挨着含关键词从句」的前后一段，绝不拿整段里最长的远句。
  const near = rest
    .filter((x) => withKw.some((w) => Math.abs(x.i - w.i) === 1))
    .sort((a, b) => b.s.length - a.s.length);
  const restFallback = withKw.length ? near : rest.sort((a, b) => b.s.length - a.s.length);
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 1;
  const out = [], seen = new Set();
  for (const x of withKw.concat(restFallback)) {
    const q = stripListMarkers(x.s).slice(0, 40);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

function bestClause(hay, keyword) {
  return clauseList(hay, keyword, 1)[0] || '';
}

// 手动搜索的查询计划：带标点的词先按标点切成从句，长的先试；
// 最后保底原词。最多 3 个（2 个从句 + 原词），避免一次搜索拖太久。
// 注意不切 ASCII 单引号，避免把 yang'tai 这种词拆坏。
function planSearchQueries(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return [];
  const parts = kw.split(/[，,。；;！？!?、：\n‘’“”"]+/)
    .map((s) => s.trim()
      .replace(/^[：:，,。.；;！？!?、“”‘’"\s]+/, '')
      .replace(/[：:，,。.；;！？!?、“”‘’"\s]+$/, ''))
    .filter((s) => s.length >= 2);
  const out = [], seen = new Set([kw]);
  const add = (q) => {
    const s = String(q == null ? '' : q).trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  parts.sort((a, b) => b.length - a.length);
  for (const p of parts) { add(p); if (out.length >= 2) break; }
  out.push(kw);
  return out;
}

// 跳转候选词：同一条结果准备 2~3 个由窄到宽的查询，主进程依次自动试。
//   ① 关键词前后的原文（带符号，最精确）
//   ② 同一段去掉标点符号（豆包对「/」这类字符有时搜不出）
//   ③ 对话标题（正文里没有原词、语义命中时也能用）
// 纯数字、纯时间码（9:16、10s）缩不了范围，直接不要。纯函数，可单测。
function jumpCandidates(keyword, sig) {
  const kw = String(keyword == null ? '' : keyword).trim();
  const raw = String(sig == null ? '' : sig);
  if (!kw) return [];
  const fields = raw.split(SIG_SEP).map((x) => String(x || ''));
  const low = kw.toLowerCase();
  const out = [];
  const seen = new Set();
  const add = (q, kind) => {
    const s = String(q == null ? '' : q).trim();
    if (!s || s.length < 2 || s.length > 40) return;
    if (s.toLowerCase() === low) return;
    if (seen.has(s.toLowerCase())) return;
    const dense = compactText(s);
    const cjk = /[\u4e00-\u9fa5]/.test(dense);
    const letters = (dense.match(/[A-Za-z]/g) || []).length;
    if (!dense || (!cjk && letters < 2)) return;      // 纯数字/纯时间码不要
    if (/^\d+$/.test(kw) && dense.length < kw.length + 2) return;  // 1 不取「10」
    seen.add(s.toLowerCase());
    out.push({ q: s, kind: kind });
  };
  // 优先用第二行（消息片段/正文）取上下文：它比标题更像「这句话」；片段没关键词再用标题。
  let ctx = '', ctxField = '';
  for (let fi = fields.length - 1; fi >= 0; fi--) {
    const f = fields[fi];
    if (f && f.toLowerCase().indexOf(low) >= 0) {
      const c = contextPhrase(f, kw);
      if (c && c.length > kw.length) { ctx = c; ctxField = f; break; }
    }
  }
  if (ctxField) {
    // 带标点的上下文：先搜两段不带标点的长句，都不行再搜带标点的原上下文。
    // 这样豆包的搜索历史里先出现的是干净短语，不会被逗号/引号污染。
    const clauses = clauseList(ctxField, kw, 2).map((c) => searchablePhrase(c)).filter(Boolean);
    const hasPunct = /[，,。；;！？!?、：\n‘’“”"]/.test(ctx);
    if (hasPunct && clauses.length) {
      for (const c of clauses) add(c, '句内');
      add(ctx, '上下文');
    } else {
      if (ctx) add(ctx, '上下文');
      const wide = searchablePhrase(stripListMarkers(contextPhrase(ctxField, kw, 20)));
      const shortClean = searchablePhrase(ctx);
      if (clauses[0] && clauses[0].toLowerCase() !== ctx.toLowerCase()) add(clauses[0], '句内');
      else if (wide && wide.length > ctx.length + 2 && wide.toLowerCase() !== ctx.toLowerCase()) add(wide, '加长');
      else if (shortClean && shortClean !== ctx) add(shortClean, '纯文字');
    }
  } else if (ctx) {
    add(ctx, '上下文');
  }
  const title = String(fields[0] || '').trim();
  if (title && title.length >= 4 && title.length <= 40) add(title, '标题');
  return out;
}

// 跳转的尝试顺序：候选词逐个浅试（只看前 2~3 页），最后回原词深翻兜底。
// 候选失败就换下一个词，比一上来翻几十页快得多。纯函数，可由单测锁顺序。
function buildJumpAttempts(keyword, sig, index, via, opts) {
  const o = opts || {};
  const kw = String(keyword == null ? '' : keyword).trim();
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);
  const cand = {
    maxPages: num(o.candPages, 2),
    tailPages: num(o.tailPages, 1),
    deepMs: num(o.candDeepMs, 4500),
    waitMs: num(o.candWaitMs, 3000)
  };
  const attempts = [];
  const onlyMsg = via === 'msg';        // 目标是消息时，别把「会话」当目标点进去
  let ci = 0;
  for (const c of jumpCandidates(kw, sig)) {
    // 前两个候选是干净长句，最可能命中：各往下翻 2 页再换词。
    // 后面的上下文/标题只是兜底，翻 1 页就够；把时间留给原词深翻。
    const pages = ci < 2 ? cand.maxPages : Math.min(cand.maxPages, cand.tailPages);
    attempts.push({ q: c.q, idx: -1, via: 'all', tag: c.kind, loose: true, onlyMsg: onlyMsg,
      expandMsg: onlyMsg, maxPages: pages, deepMs: cand.deepMs, waitMs: cand.waitMs });
    ci++;
  }
  // 原词里带引号/撇号时（如 yang'tai），豆包可能搜不出消息；去掉引号再试一次。
  // 这条要能翻到深层（目标可能在第 100 条以后），所以用原词的视图、多翻几页。
  const simplified = String(kw).replace(/['’"“”`]/g, '');
  if (simplified && simplified !== kw && /[A-Za-z\u4e00-\u9fa5]/.test(simplified)) {
    attempts.push({
      q: simplified, idx: -1, via: onlyMsg ? 'msg' : 'all', tag: '简化词', loose: true,
      onlyMsg: onlyMsg, maxPages: Math.max(cand.maxPages, 6),
      deepMs: Math.max(cand.deepMs, 12000), waitMs: cand.waitMs
    });
  }
  attempts.push({
    q: kw, idx: index, via: via === 'msg' ? 'msg' : 'all', tag: '原词', loose: false,
    maxPages: num(o.origPages, 80), deepMs: num(o.origDeepMs, 30000), waitMs: num(o.origWaitMs, 8000)
  });
  return attempts;
}

// 把页面返回的 items 整理成统一结构。纯函数，可单测。
//   via: 'all' 在「全部」视图点，'msg' 要先点开消息全量再点
//   sig: 跳转时按内容找人的依据，比下标可靠
// 把豆包显示的时间字符串解析成时间戳（本地时区）。
// 实测格式：昨天 15:48 / 11月9日 15:49 / 3月23日 18:20 / 2025年12月3日 / 15:48
// 豆包规则：今年内显示「月日 时分」，往年才带年份；所以「月日」默认当年，
// 若解析出来晚于今天（跨年时会出现），推定去年。解析不了返回 null，
// 调用方对 null 一律保留（宁可多显示，也别把不确定时间的消息藏起来）。
function parseMessageTime(text, now) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const ref = (now instanceof Date) ? now : (Number.isFinite(now) ? new Date(now) : new Date());
  const Y = ref.getFullYear(), M = ref.getMonth(), D = ref.getDate();
  let h = 0, mi = 0;
  const tm = /(\d{1,2}):(\d{2})/.exec(s);
  if (tm) { h = Number(tm[1]); mi = Number(tm[2]); }
  const at = (y, m, d) => new Date(y, m, d, h, mi).getTime();

  if (/^刚刚/.test(s)) return ref.getTime();
  if (/^今天/.test(s)) return at(Y, M, D);
  if (/^昨天/.test(s)) return at(Y, M, D - 1);
  if (/^前天/.test(s)) return at(Y, M, D - 2);
  let m = /^(\d+)\s*分钟前/.exec(s);
  if (m) return ref.getTime() - Number(m[1]) * 60000;
  m = /^(\d+)\s*小时前/.exec(s);
  if (m) return ref.getTime() - Number(m[1]) * 3600000;
  m = /^(\d+)\s*天前/.exec(s);
  if (m) return ref.getTime() - Number(m[1]) * 86400000;
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (m) return at(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s);
  if (m) {
    let y = Y;
    let ts = at(y, Number(m[1]) - 1, Number(m[2]));
    if (ts > ref.getTime() + 86400000) {       // 月日晚于今天 → 是去年的
      y = Y - 1;
      ts = at(y, Number(m[1]) - 1, Number(m[2]));
    }
    return ts;
  }
  if (/^\d{1,2}:\d{2}$/.test(s)) return at(Y, M, D);
  return null;
}

// 时间窗口：n 个月前到现在；自定义按「YYYY-MM」自然月，含整个结束月。
function timeWindow(mode, fromYm, toYm, now) {
  const ref = (now instanceof Date) ? now : (Number.isFinite(now) ? new Date(now) : new Date());
  const to = ref.getTime();
  if (mode === 'all') return { from: null, to: null, label: '全部' };
  if (mode === 'custom') {
    const p = (v) => { const m = /^(\d{4})-(\d{1,2})$/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2]) - 1] : null; };
    const a = p(fromYm), b = p(toYm);
    if (!a || !b) return { from: null, to: null, label: '自选' };
    return {
      from: new Date(a[0], a[1], 1, 0, 0, 0).getTime(),
      to: new Date(b[0], b[1] + 1, 1, 0, 0, 0).getTime() - 1,
      label: fromYm + ' ~ ' + toYm
    };
  }
  const n = (mode === '1m') ? 1 : 3;
  const d = new Date(ref.getTime());
  d.setMonth(d.getMonth() - n);
  return { from: d.getTime(), to: to, label: n === 1 ? '近1个月' : '近3个月' };
}

function normalizeItems(raw, now) {
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  const ref = (now instanceof Date) ? now : (Number.isFinite(now) ? new Date(now) : new Date());
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it) continue;
    const title = String(it.a == null ? '' : it.a).trim();
    if (!title) continue;
    const kind = String(it.kind == null ? '' : it.kind).trim() || '其他';
    const b = String(it.b == null ? '' : it.b).trim();
    const c = String(it.c == null ? '' : it.c).trim();
    const isMsg = kind.indexOf('消息') >= 0;
    const time = isMsg ? c : (b || c);
    out.push({
      index: Number.isFinite(it.i) ? it.i : i,
      kind: kind,
      title: title,
      snippet: isMsg ? b : '',
      time: time,
      ts: parseMessageTime(time, ref),
      via: (it.via === 'msg') ? 'msg' : 'all',
      sig: String(it.sig || '').trim() || buildSig(title, b)
    });
  }
  return out;
}

module.exports = {
  SEL_INPUT, SEL_ITEM, SEL_SECTION, SEL_ENTRY, SEL_CLOSE, SEL_VIEW_ALL, SIG_SEP,
  PAGE_SEARCH_SCRIPT, PAGE_JUMP_SCRIPT, PAGE_HIGHLIGHT_SCRIPT,
  fillSearchScript, fillStage1Script, fillStage2Script, fillStage3Script,
  fillJumpScript, fillHighlightScript,
  WAIT_STABLE_SRC, LOAD_MORE_SRC, mergeSearchStages, buildSig, bestClause, planSearchQueries, jumpCandidates, buildJumpAttempts, highlightFragments, highlightFragment,
  parseMessageTime, timeWindow, pickBySig, normalizeItems
};
