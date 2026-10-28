// 图片多选复制 —— 注入到豆包页面主世界
// 由 member-preload.js 用 webFrame.executeJavaScript 注入；通信走 window.postMessage。
// 设计要点见 DEVLOG 34：选择状态用 URL 记（虚拟滚动会重建 DOM）、
// 选择器锚在 CDN 域名上（class 是哈希名，豆包改版就变）。
(() => {
  if (window.__DB_PICK__) return;
  const S = {
    sel: new Set(),          // 选中的图片 URL
    boxes: new WeakMap(),    // img -> 复选框节点
    bar: null,
    busy: false
  };
  window.__DB_PICK__ = S;

  const MIN_PX = 60;                                                    // 小于这个尺寸当图标/头像，不管
  const CDN_RE = /^https:\/\/p\d+-flow-imagex-sign\.byteimg\.com\//;    // 豆包图片 CDN
  const TIP_ID = '__db_pick_tip';

  // ---------- 小工具 ----------
  const css = (el, o) => Object.assign(el.style, o);
  function send(payload) {
    try { window.postMessage(JSON.stringify(payload), '*'); } catch (e) {}
  }

  // ---------- 工具条（右下角浮动，只在有选中时出现）----------
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

    // 拦截按下类事件防止冒泡到豆包页面触发图片预览。
    // click 不能拦！拦了按钮自己的 handler 就收不到（这个坑踩过两次）
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'copy'].forEach((t) => {
      bar.addEventListener(t, (e) => e.stopPropagation(), true);
    });
    bar.querySelector('#__db_pick_copy').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      doCopy();
    });
    bar.querySelector('#__db_pick_download').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      doDownload();
    });
    bar.querySelector('#__db_pick_clear').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSel();
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
    let el = document.getElementById(TIP_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TIP_ID;
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

  // ---------- 复选框 ----------
  function decorate(img) {
    if (img.__dbPick) return;
    const w = img.offsetWidth, h = img.offsetHeight;
    if (w < MIN_PX || h < MIN_PX) return;
    const src = img.currentSrc || img.src || '';
    if (!CDN_RE.test(src)) return;

    const host = img.parentElement;
    if (!host) return;

    img.__dbPick = true;
    try {
      const pos = getComputedStyle(host).position;
      if (pos === 'static') host.style.position = 'relative';
    } catch (e) {}

    // 用 div 而不是 label：label 会把点击转发给 input，容易触发两次
    const box = document.createElement('div');
    box.className = '__db_pick_box';
    css(box, {
      position: 'absolute', top: '8px', left: '8px', zIndex: '2147482000',
      width: '22px', height: '22px', borderRadius: '7px', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(255,255,255,.92)', border: '1.5px solid rgba(0,0,0,.14)',
      boxShadow: '0 2px 8px rgba(0,0,0,.18)',
      transition: 'opacity .12s ease, background .12s ease, border-color .12s ease',
      opacity: '0.55'   // 常驻半透明；悬停到 1，选中也是 1
    });

    // 真正的 checkbox 只用来存状态，视觉完全自己画（对号必须够显眼）
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = S.sel.has(src);
    css(cb, { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    box.appendChild(cb);

    const tick = document.createElement('span');
    tick.textContent = '✓';
    css(tick, {
      color: '#fff', fontSize: '15px', fontWeight: '700', lineHeight: '1',
      opacity: '0', transition: 'opacity .1s ease', userSelect: 'none',
      pointerEvents: 'none', marginTop: '-1px'
    });
    box.appendChild(tick);

    // 统一改视觉的地方，避免各处手写颜色
    function paint(on) {
      cb.checked = on;
      box.style.background = on ? '#4F86F7' : 'rgba(255,255,255,.92)';
      box.style.borderColor = on ? '#4F86F7' : 'rgba(0,0,0,.14)';
      tick.style.opacity = on ? '1' : '0';
      box.style.opacity = on ? '1' : '0.55';
      try {
        host.style.outline = on ? '3px solid #4F86F7' : '';
        host.style.outlineOffset = on ? '-3px' : '';
      } catch (e) {}
    }
    paint(S.sel.has(src));
    box.__paint = paint;   // 清空选择时统一调用，避免各处手画颜色

    // 常驻半透明，鼠标移上去才完全实心；已选中的一直实心
    const show = () => { box.style.opacity = '1'; };
    const hide = () => { if (!S.sel.has(src)) box.style.opacity = '0.55'; };
    host.addEventListener('mouseenter', show);
    host.addEventListener('mouseleave', hide);

    // 只拦鼠标按下/抬起这类会触发豆包图片预览的事件；
    // click 必须放行，否则自己的 handler 收不到（踩过两次）
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'].forEach((t) => {
      box.addEventListener(t, (e) => { e.stopPropagation(); }, true);
    });
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const now = img.currentSrc || img.src || '';
      if (!now) return;
      const on = !S.sel.has(now);
      if (on) S.sel.add(now); else S.sel.delete(now);
      paint(on);
      refreshBar();
    });

    host.appendChild(box);
    S.boxes.set(img, box);
  }

  // ---------- 扫描（虚拟滚动会不断重建 DOM，所以要反复扫）----------
  let scanTimer = null;
  function scan() {
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) decorate(imgs[i]);
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 220);
  }

  // ---------- 选中/清空 ----------
  function clearSel() {
    S.sel.clear();
    document.querySelectorAll('.__db_pick_box').forEach((box) => {
      if (typeof box.__paint === 'function') {
        box.__paint(false);
        return;
      }
      // 兜底：万一 paint 没挂上（老节点）
      box.style.opacity = '0.55';
      const cb = box.querySelector('input');
      if (cb) cb.checked = false;
      const host = box.parentElement;
      if (host) { host.style.outline = ''; host.style.outlineOffset = ''; }
    });
    refreshBar();
  }

  function doCopy() {
    if (S.busy) return;
    if (!S.sel.size) return;
    S.busy = true;
    const urls = Array.from(S.sel);
    tip('正在准备 ' + urls.length + ' 张图片…');
    // 交给 preload -> 主进程下载并写剪贴板
    send({ __dbPick: 'copy', urls });
  }

  // 批量下载：不碰剪贴板，直接存到「下载目录\图片-<时间戳>\」
  function doDownload() {
    if (S.busy) return;
    if (!S.sel.size) return;
    S.busy = true;
    const urls = Array.from(S.sel);
    tip('正在下载 ' + urls.length + ' 张图片…');
    send({ __dbPick: 'download', urls });
  }

  // ---------- 拦截 Ctrl+C（capture 阶段抢在豆包前面）----------
  function onCopy(e) {
    if (!S.sel.size) return;                 // 没选图就放行，正常复制文字
    e.preventDefault();
    e.stopPropagation();
    if (e.clipboardData) { try { e.clipboardData.setData('text/plain', ''); } catch (err) {} }
    doCopy();
  }

  // ---------- 启动 ----------
  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    ensureBar();
    scan();
    S.observer = new MutationObserver(scheduleScan);
    S.observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('copy', onCopy, true);
    // 滚动后尺寸才确定的图片，补扫一次
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
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
