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
    textBoxes: new Map(),  // 文字元素 -> { box, on }（选了图片后才按关联关系出现）
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
        <button id="__db_pick_copytext" type="button" title="只把关联文字复制到剪贴板" style="all:unset;display:none;cursor:pointer;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-size:11px;white-space:nowrap">只复制文字</button>
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
    bar.querySelector('#__db_pick_copytext').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); doCopyText();
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
    // 文字复选框不再放在工具条里，而是浮到关联文字块的左上角（见 refreshTextBoxes）。
    // 只有选了图片、且找得到关联文字时，「只复制文字」才出现。
    const textBtn = bar.querySelector('#__db_pick_copytext');
    if (textBtn) textBtn.style.display = (n && assocTextRoots().length) ? '' : 'none';
    if (!n) clearTextBoxes();
    else refreshTextBoxes();
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

  // 整页级开关：打开图片预览 / 弹窗，或聊天输入框被卸载时，把整层复选框和工具条收起来。
  // 我们的浮层 z-index 是顶格，不主动收会盖在豆包自己的预览页上（用户截图反馈）。
  function setPickerVisible(show) {
    try { if (S.layer) S.layer.style.display = show ? '' : 'none'; } catch (e) {}
    try { if (S.bar) S.bar.style.display = (show && S.sel.size) ? 'flex' : 'none'; } catch (e) {}
  }

  function overlayCoversScreen() {
    try {
      const vw = window.innerWidth, vh = window.innerHeight;
      const all = document.querySelectorAll('[class*="image-preview" i], [role="dialog"], [aria-modal="true"]');
      for (const el of all) {
        if (S.layer && S.layer.contains(el)) continue;
        if (S.bar && S.bar.contains(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.7 && r.height >= vh * 0.7) return true;
      }
    } catch (e) {}
    return false;
  }

  function syncPositions() {
    const vw = window.innerWidth, vh = window.innerHeight;

    // 上下两条边界：
    //   顶部 = 消息滚动容器的可见顶部（顶栏下沿那条线）
    //   底部 = 豆包输入框外框的顶部
    // 超出边界的部分用 clip-path 裁掉，线以内的部分照常显示 ——
    // 不能整块 display:none（用户要求：超过线的部分消失，没超过的还展示出来）。
    let inputTop = Infinity;
    const ed = getEditor();   // 用缓存的，不再每次全文档查
    let editorVisible = false;
    if (ed) {
      try {
        const frame = ed.closest('[class*="rounded-dbx"]') || ed.closest('.guidance-input-surface') || ed;
        const er = frame.getBoundingClientRect();
        editorVisible = er.width > 0 && er.height > 0 && er.bottom > 0 && er.top < vh;
        const t = er.top;
        if (t > 120) inputTop = t;
      } catch (e) {}
    }
    // 预览页/弹窗：聊天输入框可能还在也可能被盖住，两条都算
    if (!editorVisible || overlayCoversScreen()) {
      setPickerVisible(false);
      return;
    }
    setPickerVisible(true);

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

      // 被预览页/弹窗盖住时不能再浮在上面：取图片可见区域中心做命中测试，
      // 最上层元素必须还在这条消息块里（豆包自己的点击包裹层也算）。
      try {
        const vy0 = Math.max(r.top, topLimit);
        const vy1 = inputTop === Infinity ? Math.min(r.bottom, vh) : Math.min(r.bottom, inputTop, vh);
        const cx = Math.round(r.left + Math.min(30, r.width / 2));
        const cy = Math.round(vy0 + Math.max(1, vy1 - vy0) / 2);
        const hit = document.elementFromPoint(cx, cy);
        const ours = hit && ((S.layer && S.layer.contains(hit)) || (S.bar && S.bar.contains(hit)));
        const scope = img.closest('[data-testid="message-block-container"]') ||
          img.closest('[data-message-id]') || img.parentElement;
        if (!hit || (!ours && (!scope || !scope.contains(hit)))) {
          rec.box.style.display = 'none';
          rec.hl.style.display = 'none';
          continue;
        }
      } catch (e) {}

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

    // ---- 文字复选框：放到消息气泡左侧；气泡已经被裁掉/滚出去就隐藏 ----
    for (const [root, rec] of S.textBoxes) {
      if (!root.isConnected) {
        try { rec.box.remove(); } catch (e) {}
        S.textBoxes.delete(root);
        continue;
      }
      const rr = root.getBoundingClientRect();
      // 消息行常常是整行宽（justify-end），直接贴行首会跑到屏幕最左边。
      // 真正要贴的是里面那个文字气泡：找"文字量接近整条消息、但明显更窄"的后代。
      if (!rec.anchor || !rec.anchor.isConnected) rec.anchor = bubbleOf(root);
      const ar = rec.anchor.getBoundingClientRect();
      const sc = rec.scroller || (rec.scroller = findScroller(root));
      let topLimit = 0;
      if (sc) {
        try { topLimit = sc.getBoundingClientRect().top; } catch (e) {}
      }
      const boxTop = Math.max(ar.top + GAP, topLimit + 2);
      let visible = ar.width > 0 && ar.bottom > topLimit && ar.left < vw &&
        (inputTop === Infinity || boxTop + 22 <= inputTop);
      try {
        if (visible) {
          const hx = Math.round(ar.left + Math.min(24, Math.max(1, ar.width / 2)));
          const hy = Math.round(Math.min(Math.max(ar.top + 10, topLimit + 2),
            (inputTop === Infinity ? vh : inputTop) - 2));
          const hit = document.elementFromPoint(hx, hy);
          const ours = hit && ((S.layer && S.layer.contains(hit)) || (S.bar && S.bar.contains(hit)));
          const scope = root.closest('[data-testid="message-block-container"]') || root.parentElement || root;
          if (!hit || (!ours && !scope.contains(hit))) visible = false;
        }
      } catch (e) {}
      rec.box.style.display = visible ? 'flex' : 'none';
      if (visible) {
        // 统一放文字左边（用户要求不压文字）；左边实在没空间才贴内侧。
        // 不再区分用户/助手：助手消息贴气泡内侧会正好压住图片左上角的勾选框。
        let boxLeft = ar.left - GAP - 22;
        if (boxLeft < 4) boxLeft = ar.left + GAP;
        rec.box.style.left = Math.round(boxLeft) + 'px';
        rec.box.style.top = Math.round(boxTop) + 'px';
      }
    }
  }

  // 输入框在页面生命周期内基本不变，没必要每次 syncPositions 都全文档查一遍。
  // 只在元素断开连接（豆包重建了输入区）时才重查。
  let cachedEditor = null;
  function getEditor() {
    if (cachedEditor && cachedEditor.isConnected) return cachedEditor;
    cachedEditor = document.querySelector('[contenteditable="true"]');
    return cachedEditor;
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
    if (S.sel.size) refreshTextBoxes();
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

  // ---------- 消息文字（勾选「连同消息文字」时一起复制）----------
  // 只复制「选中的图片所在消息」的正文，不搬整页文字；没有标准消息容器时
  // 向上找第一个带文字、不超宽的祖先，找不到就返回空（不瞎猜）。
  const NOISE_LINE = /^(复制|下载|分享|编辑|删除|重新生成|赞|点赞|踩|点踩|保存|展开|收起|查看大图|查看原图|图片|上传|发送|停止|更多|已复制.*)$/;

  function textBlockOf(root) {
    if (!root) return '';
    let block = null;
    try {
      const sel = '[data-testid="message_text_content"], [class*="flow-markdown-body" i]';
      block = (root.matches && root.matches(sel)) ? root : root.querySelector(sel);
    } catch (e) {}
    const raw = String((block || root).innerText || '');
    const lines = raw.split('\n').map((s) => s.trim()).filter((s) => s && !NOISE_LINE.test(s));
    return lines.join('\n').trim();
  }

  function messageRoot(img) {
    try {
      const direct = img.closest('[data-message-id]');
      if (direct) return direct;
      const block = img.closest('[data-testid="message_text_content"], [class*="flow-markdown-body" i], [class*="message-content" i]');
      if (block) return block;
    } catch (e) {}
    let el = img.parentElement;
    for (let d = 0; d < 10 && el && el !== document.body; d++) {
      try {
        if (isInputZone(el)) break;
        const txt = String(el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        if (txt.length >= 2 && txt.length <= 6000 && r.width <= window.innerWidth * 0.95) return el;
      } catch (e) {}
      el = el.parentElement;
    }
    return null;
  }

  // 图片单独成一条消息、文字在下一条用户消息里时（实测豆包常见布局：
  // 图片消息正文长度为 0，提示词是紧随其后的另一条 send_message），
  // 找相邻的用户消息。只往两侧看各 3 条，碰到助手消息就停，隔太远也不拿。
  function isUserBlock(el) {
    try { return !!el.querySelector('[data-testid="send_message"]'); } catch (e) { return false; }
  }

  function blockText(block) {
    if (!block) return '';
    let root = null;
    try { root = block.querySelector('[data-testid="message_content"]'); } catch (e) {}
    return textBlockOf(root || block);
  }

  // 消息行往往是 w-full（justify-end），文字气泡只是其中一段。
  // 浮框要贴气泡，不能贴整行：找"文字量接近整条消息、宽度明显更窄"的后代，
  // 取层级最浅的那个（气泡外层），找不到就退回原元素。
  function bubbleOf(root) {
    try {
      const rr = root.getBoundingClientRect();
      const total = String(root.innerText || '').trim().length;
      if (!total) return root;
      let best = null;
      const all = root.querySelectorAll('div');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width < 160 || r.width > rr.width - 80) continue;
        const len = String(el.innerText || '').trim().length;
        if (len < total * 0.85) continue;
        let depth = 0;
        let p = el;
        while (p && p !== root) { depth++; p = p.parentElement; }
        if (!best || depth < best.depth) best = { el: el, depth: depth };
      }
      return best ? best.el : root;
    } catch (e) { return root; }
  }

  function adjacentUserRoot(block) {
    if (!block) return null;
    let blocks = [];
    try { blocks = Array.from(document.querySelectorAll('[data-testid="message-block-container"]')); } catch (e) {}
    if (!blocks.length) {
      try { blocks = Array.from(document.querySelectorAll('[data-message-id]')); } catch (e) {}
    }
    const idx = blocks.indexOf(block) >= 0 ? blocks.indexOf(block) : blocks.findIndex((b) => b.contains(block));
    if (idx < 0) return null;
    const base = block.getBoundingClientRect();
    for (const off of [1, -1, 2, -2, 3, -3]) {
      const b = blocks[idx + off];
      if (!b) continue;
      const txt = blockText(b);
      if (!txt) continue;                 // 纯图片 / 还没渲染的空消息，继续看下一条
      if (!isUserBlock(b)) return null;   // 碰到助手消息：属于另一轮，不再越过
      try {
        const r = b.getBoundingClientRect();
        const gap = r.top > base.bottom ? r.top - base.bottom : (base.top > r.bottom ? base.top - r.bottom : 0);
        if (gap > 600) return null;
      } catch (e) {}
      let root = null;
      try { root = b.querySelector('[data-testid="message_content"]'); } catch (e) {}
      return textElementOf(root || b, null) || root || b;
    }
    return null;
  }

  // 消息里可能既有图又有字。浮框要贴"字"本身，不能贴整条消息/图片卡片：
  // 优先取离这张图最近的文字块（图片下方的说明/提示词最合适），没有就退第一条文字块。
  function textElementOf(root, img) {
    if (!root) return null;
    const sel = '[data-testid="message_text_content"], [class*="flow-markdown-body" i]';
    try {
      if (root.matches && root.matches(sel)) return root;
      const all = Array.from(root.querySelectorAll(sel));
      if (!all.length) return root;
      if (!img) return all[0];
      const ir = img.getBoundingClientRect();
      let best = null;
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const d = r.top >= ir.bottom ? r.top - ir.bottom : (ir.top >= r.bottom ? ir.top - r.bottom : 0);
        const score = d + (r.top < ir.top ? 2000 : 0);   // 同距离时优先图片下方
        if (!best || score < best.score) best = { el: el, score: score };
      }
      return best ? best.el : all[0];
    } catch (e) { return root; }
  }

  // 某张图片关联的文字元素：同一消息有字就用；没有就借相邻用户消息。
  function assocTextRoot(img) {
    const root = messageRoot(img);
    if (root) {
      const te = textElementOf(root, img);
      if (te && textBlockOf(te)) return te;
    }
    let block = null;
    try { block = img.closest('[data-testid="message-block-container"]'); } catch (e) {}
    if (!block) { try { block = img.closest('[data-message-id]'); } catch (e) {} }
    return adjacentUserRoot(block);
  }

  function assocTextRoots() {
    const roots = [];
    for (const [img] of S.boxes) {
      if (!img.isConnected) continue;
      const url = img.currentSrc || img.src || '';
      if (!S.sel.has(url)) continue;
      const root = assocTextRoot(img);
      if (root && roots.indexOf(root) < 0 && textBlockOf(root)) roots.push(root);
    }
    return roots;
  }

  // ---------- 文字复选框（浮在关联文字块左上角，选了图片才出现）----------
  function paintTextBox(rec, on) {
    rec.on = on;
    rec.box.style.background = on ? '#4F86F7' : 'rgba(255,255,255,.92)';
    rec.box.style.borderColor = on ? '#4F86F7' : 'rgba(0,0,0,.35)';
    rec.box.style.borderStyle = on ? 'solid' : 'dashed';
    rec.box.style.color = on ? '#fff' : '#333';
    rec.box.textContent = on ? '✓' : '文';
    rec.box.style.opacity = on ? '1' : '0.75';
  }

  function clearTextBoxes() {
    for (const [, rec] of S.textBoxes) {
      try { rec.box.remove(); } catch (e) {}
    }
    S.textBoxes.clear();
  }

  function refreshTextBoxes() {
    if (!S.sel.size) { clearTextBoxes(); return; }
    const roots = assocTextRoots();
    // 不再关联的文字块，连复选框一起撤掉
    for (const [root, rec] of Array.from(S.textBoxes)) {
      if (roots.indexOf(root) < 0) {
        try { rec.box.remove(); } catch (e) {}
        S.textBoxes.delete(root);
      }
    }
    const layer = ensureLayer();
    for (const root of roots) {
      if (S.textBoxes.has(root)) continue;
      const box = document.createElement('div');
      box.className = '__db_pick_textbox';
      css(box, {
        position: 'fixed', width: '22px', height: '22px', borderRadius: '7px',
        cursor: 'pointer', pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,.92)', border: '1.5px dashed rgba(0,0,0,.35)',
        boxShadow: '0 2px 8px rgba(0,0,0,.18)',
        transition: 'opacity .12s ease, background .12s ease, border-color .12s ease',
        opacity: '0.75',
        font: '700 12px/1 -apple-system,"Microsoft YaHei",sans-serif', color: '#333'
      });
      box.textContent = '文';
      box.title = '勾上后复制图片时会带上这段文字';
      layer.appendChild(box);
      const rec = { box: box, on: false, anchor: null };
      box.addEventListener('mouseenter', () => { box.style.opacity = '1'; });
      box.addEventListener('mouseleave', () => { if (!rec.on) box.style.opacity = '0.75'; });
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach((t) => {
        box.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); }, true);
      });
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const on = !rec.on;
        paintTextBox(rec, on);
        const t = textBlockOf(root);
        tip(on ? '复制图片时会带上这段文字（约 ' + t.length + ' 字）' : '这段文字不随图片复制了', false);
        syncPositions();
      });
      S.textBoxes.set(root, rec);
      paintTextBox(rec, false);
    }
    syncPositions();
  }

  function textOfRoots(roots) {
    const out = [];
    const sorted = roots.slice().sort((a, b) => ((a.compareDocumentPosition(b) & 4) ? -1 : 1));
    for (const root of sorted) {
      const t = textBlockOf(root);
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out.join('\n\n').slice(0, 20000);
  }

  // 复制图片时：只带用户勾过的文字块
  function collectCheckedText() {
    const roots = [];
    for (const [root, rec] of S.textBoxes) {
      if (rec.on && root.isConnected) roots.push(root);
    }
    return textOfRoots(roots);
  }

  // 「只复制文字」按钮：带全部关联文字，不要求勾选
  function collectAssocText() {
    return textOfRoots(assocTextRoots());
  }

  async function doCopy() {
    if (S.busy || !S.sel.size) return;
    S.busy = true;
    const urls = await Promise.all(Array.from(S.sel).map(toTransferable));
    const text = collectCheckedText();
    tip('正在准备 ' + urls.length + ' 张图片' + (text ? ' + 文字' : '') + '…');
    send({ __dbPick: 'copy', urls, text });
  }

  // 只复制文字：不动图片，也不清空选择（方便随后再单独复制图片）
  function doCopyText() {
    if (S.busy) return;
    const text = collectAssocText();
    if (!text) { tip('这几条消息里没找到可复制的文字', true); return; }
    S.busy = true;
    tip('正在复制文字…');
    send({ __dbPick: 'copyText', text });
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
    // 兜底轮询已去掉（2026-10-31）：滚动/缩放/DOM 变化都有各自的监听，走 rAF 是实时的。
    // 原来 800ms 那份纯粹是"怕漏"，但 6 个视图 × 每秒 7.5 次，
    // 每次都要全文档 querySelector + 遍历所有图片做强制布局，越用越卡。
    // 用户实测去掉后滚动正常。
  }

  // 主进程回传结果
  window.addEventListener('message', (e) => {
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { return; } }
    if (!d || !d.__dbPickResult) return;
    S.busy = false;
    const isDownload = d.action === 'download';
    if (d.action === 'copyText') {
      if (d.ok) tip('已复制文字' + (d.chars ? '（' + d.chars + ' 字）' : '') + '，去目标处 Ctrl+V');
      else tip('复制文字失败：' + (d.error || '未知错误'), true);
      return;
    }
    if (d.ok) {
      if (isDownload) {
        tip('已下载 ' + d.count + ' 张图片到下载目录' + (d.failed ? '（失败 ' + d.failed + ' 张）' : ''));
      } else {
        tip('已复制 ' + d.count + ' 张图片' + (d.text ? ' + 文字' : '') + '，去目标处 ' +
          (d.text ? 'Ctrl+V 贴图、Ctrl+Shift+V 贴文字' : 'Ctrl+V') +
          (d.failed ? '（失败 ' + d.failed + ' 张）' : ''));
      }
      clearSel();
    } else {
      tip((isDownload ? '下载' : '复制') + '失败：' + (d.error || '未知错误'), true);
    }
  });

  boot();
})();
