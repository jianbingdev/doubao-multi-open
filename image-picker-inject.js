// 图片多选复制 —— 注入到豆包页面主世界
// 由 member-preload.js 用 webFrame.executeJavaScript 注入；通信走 window.postMessage。
//
// ⚠️ 关键设计（2026-10-28 踩坑后重写）：
// 复选框**绝对不能**插进豆包的图片容器里。豆包的图片是这样渲染的：
//   <SPAN><img src="data:image/svg+xml,..."></SPAN>   ← 先放 SVG 骨架占位
//   等真图加载完再把骨架换成 <img src="https://pN-flow-imagex-sign.byteimg.com/...">
// 一旦往那个 SPAN 里多塞一个 div（或改它的 position），豆包的替换逻辑就失败，
// 图片明明加载好了却不显示 —— 表现就是「闪一下变成灰块」。
//
// 所以现在所有复选框都放在一个独立浮层里（挂在 body 上，pointer-events:none），
// 位置靠 getBoundingClientRect 实时算。豆包的 DOM 一个字节都不动。
(() => {
  if (window.__DB_PICK__) return;
  const S = {
    sel: new Set(),        // 选中的图片 URL
    boxes: new Map(),      // img -> { box, hl, tick, on }（Map 才能遍历做位置同步）
    bar: null,
    layer: null,
    busy: false,
    observer: null
  };
  window.__DB_PICK__ = S;

  const MIN_PX = 30;                 // 豆包头像/图标 20px，30 能排掉
  const CDN_RE = /^https:\/\/p\d+-flow-imagex-sign\.byteimg\.com\//;
  // 除了豆包 CDN，用户自己粘贴进来的图是 blob: / data: URL，也必须能选。
  // 豆包发送后先用 blob 做本地预览，重新加载页面才换成 CDN 地址，
  // 所以两种都得认，否则「粘贴发出去的那张」永远没复选框。
  const isSelectable = (u) =>
    CDN_RE.test(u) || /^blob:/.test(u) || /^data:image\//.test(u);
  const GAP = 8;                     // 复选框离图片边缘的距离

  // ---------- 小工具 ----------
  const css = (el, o) => Object.assign(el.style, o);
  function send(payload) {
    try { window.postMessage(JSON.stringify(payload), '*'); } catch (e) {}
  }

  // ---------- 浮层（唯一往 body 插的东西）----------
  // ⚠️ 必须是 0×0：早先做成 width/height:100% 的全屏层，会让豆包的图片重新变成灰块
  // （实测：全屏浮层 + GPU 开 = 0/15 张；0×0 容器待验证）。子元素各自 position:fixed，
  // 用 getBoundingClientRect 的视口坐标直接定位，不依赖父容器尺寸。
  function ensureLayer() {
    if (S.layer && document.body.contains(S.layer)) return S.layer;
    let el = document.getElementById('__db_pick_layer');
    if (!el) {
      el = document.createElement('div');
      el.id = '__db_pick_layer';
      css(el, {
        // z-index 保持很高：要盖在图片之上（否则方块会被图盖住看不见）。
        // "别浮进输入框"是靠 syncPositions 里的边界判断解决的，不靠层级。
        position: 'fixed', left: '0', top: '0', width: '0', height: '0',
        zIndex: '2147482000', pointerEvents: 'none', overflow: 'visible'
      });
      document.body.appendChild(el);
    }
    S.layer = el;
    return el;
  }

  // ---------- 工具条 ----------
  function ensureBar() {
    if (S.bar && document.body.contains(S.bar)) return S.bar;
    const bar = document.createElement('div');
    bar.id = '__db_pick_bar';
    css(bar, {
      position: 'fixed', right: '18px', bottom: '96px', zIndex: '2147483000',
      display: 'none', flexDirection: 'column', alignItems: 'stretch', gap: '6px',
      padding: '9px 12px', borderRadius: '14px',
      background: 'rgba(28,28,32,.94)', color: '#fff',
      font: '13px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,.28)', backdropFilter: 'blur(8px)',
      userSelect: 'none'
    });
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px">
        <span id="__db_pick_cnt" style="white-space:nowrap;flex:1;margin-right:2px">已选 0 张</span>
        <button id="__db_pick_copy" type="button" title="复制到剪贴板" style="all:unset;cursor:pointer;padding:5px 12px;border-radius:999px;background:#4F86F7;color:#fff;font-weight:600;white-space:nowrap">复制</button>
        <button id="__db_pick_download" type="button" title="下载到下载目录" style="all:unset;cursor:pointer;padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-weight:600;white-space:nowrap">下载</button>
        <button id="__db_pick_clear" type="button" title="清空选择" style="all:unset;cursor:pointer;width:22px;height:22px;line-height:22px;text-align:center;border-radius:999px;background:rgba(255,255,255,.14);font-size:14px">×</button>
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,.5);text-align:center;white-space:nowrap">Ctrl+C 复制 · 下载存到下载目录</div>`;
    document.body.appendChild(bar);

    // 只拦按下类事件；click 必须放行，不然按钮自己的 handler 收不到（踩过两次）
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'copy'].forEach((t) => {
      bar.addEventListener(t, (e) => e.stopPropagation(), true);
    });
    bar.querySelector('#__db_pick_copy').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); doCopy();
    });
    bar.querySelector('#__db_pick_download').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); doDownload();
    });
    bar.querySelector('#__db_pick_clear').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); clearSel();
    });
    S.bar = bar;
    return bar;
  }

  function refreshBar() {
    const bar = ensureBar();
    const n = S.sel.size;
    bar.style.display = n ? 'flex' : 'none';
    const cnt = bar.querySelector('#__db_pick_cnt');
    if (cnt) cnt.textContent = '已选 ' + n + ' 张';
  }

  // ---------- 提示气泡 ----------
  let tipTimer = null;
  function tip(msg, isErr) {
    let el = document.getElementById('__db_pick_tip');
    if (!el) {
      el = document.createElement('div');
      el.id = '__db_pick_tip';
      css(el, {
        position: 'fixed', left: '50%', bottom: '150px', transform: 'translateX(-50%)',
        zIndex: '2147483001', padding: '9px 16px', borderRadius: '10px',
        font: '13px/1.4 -apple-system,"Microsoft YaHei",sans-serif',
        color: '#fff', pointerEvents: 'none', opacity: '0',
        transition: 'opacity .18s ease', maxWidth: '70vw', textAlign: 'center'
      });
      document.body.appendChild(el);
    }
    el.style.background = isErr ? 'rgba(200,60,60,.95)' : 'rgba(28,28,32,.94)';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { el.style.opacity = '0'; }, isErr ? 3600 : 1800);
  }

  // ---------- 位置同步（滚动 / 缩放 / 懒加载都会变）----------
  // 找这张图所在的滚动容器（消息列表）。复选框只允许显示在它的可见区域内，
  // 否则图片滚到顶栏/输入框后面时，框会"浮"到那些区域上（用户反馈过两个方向都有）。
  function findScroller(el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      try {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll') return p;
      } catch (e) {}
      p = p.parentElement;
    }
    return null;
  }

  // 判断某个元素是不是落在豆包输入框区域里。
  // 用 elementFromPoint 反查最准：直接问浏览器"这个点最上层是谁"，
  // 比拿坐标和输入框的 top 比较可靠 —— 输入框有内层(surface)和外框(圆角)两层，
  // 两者 top 差几十像素，用哪个都会漏掉一半情况。
  function isInputZone(el) {
    try {
      if (!el || !el.closest) return false;
      if (el.closest('.guidance-input-surface')) return true;
      if (el.closest('.guidance-input-content')) return true;
      if (el.closest('.guidance-input-editor-viewport')) return true;
      if (el.closest('[class*="rounded-dbx"]')) return true;   // 输入框外框
      return false;
    } catch (e) { return false; }
  }

  function syncPositions() {
    const vw = window.innerWidth, vh = window.innerHeight;

    // 上下两条边界：
    //   顶部 = 消息滚动容器的可见顶部（顶栏下沿那条线）
    //   底部 = 豆包输入框外框的顶部
    // 超出边界的部分用 clip-path 裁掉，线以内的部分照常显示 ——
    // 不能整块 display:none（用户要求：超过线的部分消失，没超过的还展示出来）。
    let inputTop = Infinity;
    const ed = document.querySelector('[contenteditable="true"]');
    if (ed) {
      try {
        const frame = ed.closest('[class*="rounded-dbx"]') || ed.closest('.guidance-input-surface') || ed;
        const t = frame.getBoundingClientRect().top;
        if (t > 120) inputTop = t;
      } catch (e) {}
    }

    for (const [img, rec] of S.boxes) {
      if (!img.isConnected) {
        try { rec.box.remove(); } catch (e) {}
        try { rec.hl.remove(); } catch (e) {}
        S.boxes.delete(img);
        continue;
      }
      const r = img.getBoundingClientRect();
      const sc = rec.scroller || (rec.scroller = findScroller(img));
      let topLimit = 0;
      if (sc) {
        try { topLimit = sc.getBoundingClientRect().top; } catch (e) {}
      }

      // 完全不可见才隐藏；有一点点露出来就显示（露出部分会被裁）
      const anyVisible = r.width >= MIN_PX && r.height >= MIN_PX &&
                         r.bottom > topLimit && r.right > 0 && r.left < vw &&
                         (inputTop === Infinity || r.top < inputTop);
      if (!anyVisible) {
        rec.box.style.display = 'none';
        rec.hl.style.display = 'none';
        continue;
      }

      // 裁掉超出上下边界的部分
      const topCut = Math.max(0, topLimit - r.top);
      const botCut = inputTop === Infinity ? 0 : Math.max(0, r.bottom - inputTop);

      // ---- 复选框（22×22，在图片左上角）----
      const boxTop = r.top + GAP;
      const bTopCut = Math.max(0, topLimit - boxTop);
      const bBotCut = inputTop === Infinity ? 0 : Math.max(0, (boxTop + 22) - inputTop);
      rec.box.style.display = 'flex';
      rec.box.style.opacity = rec.on ? 1 : 0.55;
      rec.box.style.left = Math.round(r.left + GAP) + 'px';
      rec.box.style.top = Math.round(boxTop) + 'px';
      rec.box.style.clipPath = 'inset(' + bTopCut + 'px 0px ' + bBotCut + 'px 0px)';

      // ---- 选中时的蓝色描边框（整个图片的矩形）----
      if (rec.on) {
        rec.hl.style.display = 'block';
        rec.hl.style.left = Math.round(r.left) + 'px';
        rec.hl.style.top = Math.round(r.top) + 'px';
        rec.hl.style.width = Math.round(r.width) + 'px';
        rec.hl.style.height = Math.round(r.height) + 'px';
        rec.hl.style.clipPath = 'inset(' + topCut + 'px 0px ' + botCut + 'px 0px)';
      } else {
        rec.hl.style.display = 'none';
      }
    }
  }

  let syncRaf = 0;
  function scheduleSync() {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => { syncRaf = 0; syncPositions(); });
  }

  // ---------- 复选框（全部活在浮层里）----------
  function paint(rec, on) {
    rec.on = on;
    rec.box.style.background = on ? '#4F86F7' : 'rgba(255,255,255,.92)';
    rec.box.style.borderColor = on ? '#4F86F7' : 'rgba(0,0,0,.14)';
    rec.box.style.opacity = on ? '1' : '0.55';
    rec.tick.style.opacity = on ? '1' : '0';
    if (on) {
      rec.hl.style.display = 'block';
      rec.hl.style.border = '3px solid #4F86F7';
    } else {
      rec.hl.style.display = 'none';
    }
  }

  function decorate(img) {
    // 不再用 img.__dbPick 做标记：豆包会复用同一个 <img> 元素（src 从 CDN 换成 blob），
    // 标记留在元素上会让「后来换了地址的图」再也装饰不了 —— 表现就是发一次消息后
    // 复选框集体消失，只有彻底重启才恢复。
    // 改用 S.boxes 判断；发现 box 已经不在 DOM 里（豆包重建了节点）就重建一个。
    const old = S.boxes.get(img);
    if (old) {
      if (old.box.isConnected) return;
      try { old.box.remove(); } catch (e) {}
      try { old.hl.remove(); } catch (e) {}
      S.boxes.delete(img);
    }
    const src = img.currentSrc || img.src || '';
    if (!isSelectable(src)) return;

    // 没加载完就先挂监听，等真图出来再装饰（否则这批图会永远被跳过）
    if (!img.complete || img.naturalWidth === 0) {
      if (!img.__dbPickWait) {
        img.__dbPickWait = true;
        const retry = () => {
          img.__dbPickWait = false;
          setTimeout(() => { decorate(img); syncPositions(); }, 60);
        };
        img.addEventListener('load', retry, { once: true });
        img.addEventListener('error', retry, { once: true });
      }
      return;
    }

    // 尺寸用 rect：豆包有容器带 transform:scale()，offsetWidth 是布局尺寸
    const r = img.getBoundingClientRect();
    if (r.width < MIN_PX || r.height < MIN_PX) return;

    const layer = ensureLayer();


    // 选中时套在图片外面的高亮框（fixed：视口坐标直接用）
    const hl = document.createElement('div');
    hl.className = '__db_pick_hl';
    css(hl, {
      position: 'fixed', display: 'none', pointerEvents: 'none',
      borderRadius: '6px', boxSizing: 'border-box'
    });

    // 复选框本体
    const box = document.createElement('div');
    box.className = '__db_pick_box';
    css(box, {
      position: 'fixed', width: '22px', height: '22px', borderRadius: '7px',
      cursor: 'pointer', pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(255,255,255,.92)', border: '1.5px solid rgba(0,0,0,.14)',
      boxShadow: '0 2px 8px rgba(0,0,0,.18)',
      transition: 'opacity .12s ease, background .12s ease, border-color .12s ease',
      opacity: '0.55'
    });
    const tick = document.createElement('span');
    tick.textContent = '✓';
    css(tick, {
      color: '#fff', fontSize: '15px', fontWeight: '700', lineHeight: '1',
      opacity: '0', transition: 'opacity .1s ease', userSelect: 'none',
      pointerEvents: 'none', marginTop: '-1px'
    });
    box.appendChild(tick);

    const rec = { box: box, hl: hl, tick: tick, on: false };
    layer.appendChild(hl);
    layer.appendChild(box);
    S.boxes.set(img, rec);

    box.addEventListener('mouseenter', () => { box.style.opacity = '1'; });
    box.addEventListener('mouseleave', () => { if (!rec.on) box.style.opacity = '0.55'; });
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach((t) => {
      box.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); }, true);
    });
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const now = img.currentSrc || img.src || '';
      if (!now) return;
      const on = !S.sel.has(now);
      if (on) S.sel.add(now); else S.sel.delete(now);
      paint(rec, on);
      refreshBar();
      syncPositions();
    });

    if (S.sel.has(src)) paint(rec, true);
    syncPositions();
  }

  // ---------- 扫描 ----------
  let scanTimer = null;
  function scan() {
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) decorate(imgs[i]);
    syncPositions();
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 220);
  }

  // ---------- 选中 / 清空 ----------
  function clearSel() {
    S.sel.clear();
    for (const [, rec] of S.boxes) paint(rec, false);
    refreshBar();
  }

  // blob: / data: 的图主进程下不到（blob 只在渲染进程里有效），
  // 先在页面里转成 dataURL 再传过去
  async function toTransferable(url) {
    if (!/^blob:/.test(url)) return url;
    try {
      const r = await fetch(url);
      const b = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('读取失败'));
        fr.readAsDataURL(b);
      });
    } catch (e) {
      return url;
    }
  }

  async function doCopy() {
    if (S.busy || !S.sel.size) return;
    S.busy = true;
    const urls = await Promise.all(Array.from(S.sel).map(toTransferable));
    tip('正在准备 ' + urls.length + ' 张图片…');
    send({ __dbPick: 'copy', urls });
  }

  async function doDownload() {
    if (S.busy || !S.sel.size) return;
    S.busy = true;
    const urls = await Promise.all(Array.from(S.sel).map(toTransferable));
    tip('正在下载 ' + urls.length + ' 张图片…');
    send({ __dbPick: 'download', urls });
  }

  // ---------- 拦截 Ctrl+C ----------
  function onCopy(e) {
    if (!S.sel.size) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.clipboardData) { try { e.clipboardData.setData('text/plain', ''); } catch (err) {} }
    doCopy();
  }

  // ---------- 启动 ----------
  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    ensureLayer();
    ensureBar();
    scan();
    S.observer = new MutationObserver(scheduleScan);
    S.observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('copy', onCopy, true);
    window.addEventListener('scroll', scheduleSync, { passive: true, capture: true });
    window.addEventListener('resize', scheduleSync, { passive: true });
    // 图片加载完、布局微调时位置会变，低频兜底同步一次
    setInterval(scheduleSync, 800);
  }

  // 主进程回传结果
  window.addEventListener('message', (e) => {
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { return; } }
    if (!d || !d.__dbPickResult) return;
    S.busy = false;
    const isDownload = d.action === 'download';
    if (d.ok) {
      if (isDownload) {
        tip('已下载 ' + d.count + ' 张图片到下载目录' + (d.failed ? '（失败 ' + d.failed + ' 张）' : ''));
      } else {
        tip('已复制 ' + d.count + ' 张图片，去目标处 Ctrl+V' + (d.failed ? '（失败 ' + d.failed + ' 张）' : ''));
      }
      clearSel();
    } else {
      tip((isDownload ? '下载' : '复制') + '失败：' + (d.error || '未知错误'), true);
    }
  });

  boot();
})();
