// 渲染进程: 侧栏账号列表 + 状态徽标 + 双击就地改名 + 偏好
const listEl = document.getElementById('accountList');
const btnAdd = document.getElementById('btnAdd');
const btnCheckAll = document.getElementById('btnCheckAll');
const mainTip = document.getElementById('mainTip');
const chkTray = document.getElementById('chkTray'); // v4.2 起已挪到设置弹窗(setCloseExit)
const toastWrap = document.getElementById('toastWrap');
const btnManage = document.getElementById('btnManage');
const mgrAll = document.getElementById('mgrAll');
const mgrDel = document.getElementById('mgrDel');
const sidebarEl = document.getElementById('sidebar');
const sidebarResizer = document.getElementById('sidebarResizer');
const sidebarTitle = document.querySelector('.sidebar-header h1');
const btnSearchText = document.getElementById('btnSearchText');
const SIDEBAR_MIN = 168;
const SIDEBAR_MAX = 360;
const SIDEBAR_WIDE = 215;          // 宽度低于这个值就换简称（标题和按钮同一个阈值）
const TITLE_FULL = '豆包多开管理器';
const TITLE_SHORT = '豆包多开';

let accounts = [];
let currentId = null;
let managing = false;                 // 侧栏管理态：多选删除 + 拖动排序
const selectedIds = new Set();

const BADGE_TEXT = {
  online: '在线',
  pending: '待登录',
  offline: '掉线',
  loadfail: '加载失败'
};

async function refresh() {
  accounts = await window.api.accountsList();
  if (!editing) render(); // 就地编辑期间冻结重建, 防止输入框被冲掉
}

function render() {
  if (editing) return;
  if (accounts.length === 0) {
    listEl.innerHTML = '<div class="empty-tip">还没有账号<br>点上方按钮新建一个豆包页面,<br>直接扫码登录即可</div>';
    return;
  }
  // 保持激活态在刷新后不丢
  const activeStillExists = accounts.some(a => a.id === currentId);
  if (!activeStillExists && accounts.length > 0 && currentId !== null) {
    currentId = null;
  }
  listEl.innerHTML = '';
  accounts.forEach((acc, idx) => {
    const item = document.createElement('div');
    item.className = 'account-item'
      + (acc.id === currentId ? ' active' : '')
      + (managing ? ' mgr' : '')
      + (managing && selectedIds.has(acc.id) ? ' selected' : '');
    item.dataset.badge = acc.badge || 'online';
    if (acc.busy) item.dataset.busy = '1';
    if (acc.done) item.dataset.done = '1';
    item.title = managing
      ? '拖动可调整顺序 · 点击勾选'
      : 'Ctrl+' + (idx + 1) + ' 可快速切换 · 双击名称改名' + (acc.done ? ' · 该账号对话已完成' : '');

    if (managing) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mgr-check';
      cb.checked = selectedIds.has(acc.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(acc.id); else selectedIds.delete(acc.id);
        item.classList.toggle('selected', cb.checked);
        syncMgrBar();
      });
      item.appendChild(cb);
    }

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = acc.color || '#4F86F7';

    const span = document.createElement('span');
    span.className = 'acc-name';
    span.textContent = (idx + 1) + '. ' + acc.label;
    span.title = '双击可就地编辑名称';
    span.ondblclick = (e) => {
      if (managing) return;                 // 管理态下双击留给勾选/拖动
      e.stopPropagation();
      e.preventDefault();
      startInlineEdit(span, acc);
    };
    span.addEventListener('mousedown', e => {
      // 双击时阻止浏览器默认文本选中, 避免视觉抖动
      if (e.detail > 1) e.preventDefault();
    });

    const badge = document.createElement('span');
    badge.className = 'badge ' + (acc.badge || 'online');
    badge.textContent = BADGE_TEXT[acc.badge] || acc.badge;
    badge.title = '点击检测该账号的登录状态';
    badge.style.cursor = 'pointer';
    badge.onclick = (e) => {
      e.stopPropagation();          // 不要顺带切号
      checkOne(acc, badge);
    };


    item.appendChild(avatar);
    item.appendChild(span);
    if (acc.plan) {
      const planTag = document.createElement('span');
      planTag.className = 'plan-tag';
      planTag.textContent = acc.plan.name || '套餐';
      planTag.title = '该账号有套餐：' + (acc.plan.name || '套餐') +
        (acc.plan.endTime ? '（到期 ' + new Date(acc.plan.endTime).toLocaleDateString('zh-CN') + '）' : '') +
        (acc.plan.sku ? '\n' + acc.plan.sku : '') +
        (acc.plan.checkedAt ? '\n上次检查：' + new Date(acc.plan.checkedAt).toLocaleString('zh-CN') : '');
      item.appendChild(planTag);
    }
    if (acc.done) {
      const doneTag = document.createElement('span');
      doneTag.className = 'done-tag';
      doneTag.textContent = '新回复';
      doneTag.title = '该账号的对话已完成，点进来查看';
      item.appendChild(doneTag);
    }
    item.appendChild(badge);
    // 右键菜单：刷新页面 / 刷新账号 / 删除（删除有二次确认）
    if (managing) {
      item.oncontextmenu = (e) => { e.preventDefault(); };   // 管理态不弹右键菜单
      item.onclick = () => {
        const cb = item.querySelector('.mgr-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      };
      bindDrag(item, acc);
    } else {
      item.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.api.accountsContextMenu(acc.id);
      };
      item.onclick = () => {
        if (editing) return;
        if (currentId === acc.id) return; // 重复点同一个账号不重绘(双击改名的前提)
        selectAccount(acc.id);
      };
    }
    listEl.appendChild(item);
  });
}

// ---- 侧栏宽度：拖动调整 + 文案自适应 ----
// 窄了就换简称，保证文字不被截成半句。
// 阈值 215：再窄「＋ 添加账号（在右侧页面直接扫码）」和「⟳ 检测账号」就挤了。
// 真正把文案写进去（不带过渡）。narrow 是唯一依据，managing 只影响主按钮。
function writeSidebarText(narrow, tight) {
  narrowNow = narrow;
  tightNow = tight;
  // 窄态给 body 打个标记：标题降一号字，保证「豆包多开」+ 版本号一行放得下
  if (narrow) document.body.dataset.sidebarNarrow = '1';
  else delete document.body.dataset.sidebarNarrow;
  if (tight) document.body.dataset.sidebarTight = '1';
  else delete document.body.dataset.sidebarTight;
  // 拖到最小宽度：标题拆成两行「豆包 / 多开」，不显示省略号；其他宽度保持原逻辑。
  if (sidebarTitle) {
    if (tight) {
      sidebarTitle.classList.add('is-two-line');
      sidebarTitle.innerHTML = '<span class="title-line">豆包</span><span class="title-line">多开</span>';
    } else {
      sidebarTitle.classList.remove('is-two-line');
      sidebarTitle.textContent = narrow ? TITLE_SHORT : TITLE_FULL;
    }
  }
  if (btnAdd) {
    btnAdd.textContent = managing
      ? (narrow ? '✓ 完成' : '✓ 完成（退出管理）')
      : (narrow ? '＋ 添加账号' : '＋ 添加账号（在右侧页面直接扫码）');
  }
  if (btnCheckAll) btnCheckAll.textContent = narrow ? '⟳ 检测' : '⟳ 检测账号';
  if (btnSearchText) btnSearchText.textContent = narrow ? '搜索消息' : '搜索所有账号消息';
}

// 跨阈值时别硬切：先淡下去 → 换文案 → 淡回来（CSS 的 .switching-text 负责淡）。
// 两次切换间隔太短（快速来回拖）就直接换，不然会闪个不停。
let narrowNow = null;
let tightNow = null;
let lastSwitchAt = 0;
let switchTimer = null;

function applySidebarText(w, opts) {
  const width = Number(w);
  const narrow = width < SIDEBAR_WIDE;
  const tight = width <= SIDEBAR_MIN;
  const instant = !!(opts && opts.instant);
  if (instant) {
    clearTimeout(switchTimer);
    document.body.classList.remove('switching-text');
    writeSidebarText(narrow, tight);
    return;
  }
  if (narrow === narrowNow && tight === tightNow) return;   // 状态没变：拖动时绝大多数帧走这里
  const now = Date.now();
  if (now - lastSwitchAt < 260) {              // 快速来回拖，直接换，不做动画
    writeSidebarText(narrow, tight);
    return;
  }
  lastSwitchAt = now;
  clearTimeout(switchTimer);
  document.body.classList.add('switching-text');
  switchTimer = setTimeout(() => {
    writeSidebarText(narrow, tight);
    requestAnimationFrame(() => document.body.classList.remove('switching-text'));
  }, 110);
}

function setSidebarWidth(w, notify, instant) {
  const width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(Number(w) || 0)));
  if (sidebarEl) sidebarEl.style.width = width + 'px';
  applySidebarText(width, { instant: instant });
  if (notify) {
    try { api.setSidebarWidth(width); } catch (e) {}
  }
  return width;
}

(function initSidebarResize() {
  if (!sidebarEl || !sidebarResizer) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  sidebarResizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebarEl.offsetWidth;
    document.body.classList.add('resizing');
    try { sidebarResizer.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  sidebarResizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setSidebarWidth(startW + (e.clientX - startX), true);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    try { sidebarResizer.releasePointerCapture(e.pointerId); } catch (err) {}
    // 松手才落盘（拖动过程只在内存里改，避免每帧写 prefs.json）
    try { api.setSidebarWidth(sidebarEl.offsetWidth, true); } catch (err) {}
  };
  sidebarResizer.addEventListener('pointerup', stop);
  sidebarResizer.addEventListener('pointercancel', stop);
})();

// 启动时套用上次拖的宽度
(async () => {
  try {
    const p = await api.prefsGet();
    if (p && p.sidebarWidth) setSidebarWidth(p.sidebarWidth, false, true);
  } catch (e) {}
})();

// ---- 侧栏管理态：多选删除 + 拖动排序 ----
let draggingId = null;

function clearDropMarks() {
  listEl.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

// 整项 draggable：浏览器规范里拖拽手势结束后不会派发 click，
// 所以「拖动排序」和「点击整行勾选」可以共存，不用额外加手柄。
function bindDrag(item, acc) {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    draggingId = acc.id;
    item.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(acc.id));
    } catch (err) {}
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    draggingId = null;
    clearDropMarks();
  });
  item.addEventListener('dragover', (e) => {
    if (!draggingId || draggingId === acc.id) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
    const r = item.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    clearDropMarks();
    item.classList.add(after ? 'drop-after' : 'drop-before');
  });
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const src = draggingId;
    const r = item.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    clearDropMarks();
    draggingId = null;
    if (!src || src === acc.id) return;
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(src);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(acc.id);
    if (to < 0) return;
    ids.splice(to + (after ? 1 : 0), 0, src);
    try {
      await window.api.accountsReorder(ids);
      await refresh();
    } catch (err) {
      toast('调整顺序失败：' + (err && err.message ? err.message : err));
    }
  });
}

function syncMgrBar() {
  // 删掉的账号自动从选中集合里剔除，避免「删除 3」里含已不存在的号
  for (const id of Array.from(selectedIds)) {
    if (!accounts.some((a) => a.id === id)) selectedIds.delete(id);
  }
  const total = accounts.length;
  const n = selectedIds.size;
  if (mgrDel) {
    mgrDel.textContent = n > 0 ? '删除 ' + n : '删除';
    mgrDel.disabled = n === 0;
  }
  if (mgrAll) {
    mgrAll.textContent = (total > 0 && n === total) ? '取消全选' : '全选';
    mgrAll.disabled = total === 0;
  }
}

function setManaging(on) {
  managing = !!on;
  selectedIds.clear();
  // 关键：不隐藏整行，只把「添加账号」这个整宽主按钮换成「完成」
  // （原来是把添加按钮整行藏掉，管理态少了 40 多像素，页面会往上跳一格）
  if (btnAdd) btnAdd.classList.toggle('is-manage', managing);
  applySidebarText(sidebarEl ? sidebarEl.offsetWidth : 260, { instant: true });
  if (btnCheckAll) btnCheckAll.hidden = managing;
  if (btnManage) btnManage.hidden = managing;
  if (mgrAll) mgrAll.hidden = !managing;
  if (mgrDel) mgrDel.hidden = !managing;
  if (managing) mainTip.style.display = 'none';
  render();
  syncMgrBar();
}

if (btnManage) btnManage.onclick = () => setManaging(!managing);
if (mgrAll) mgrAll.onclick = () => {
  if (accounts.length === 0) return;
  if (selectedIds.size === accounts.length) selectedIds.clear();
  else accounts.forEach((a) => selectedIds.add(a.id));
  render();
  syncMgrBar();
};
if (mgrDel) mgrDel.onclick = () => {
  const ids = Array.from(selectedIds);
  if (!ids.length) return;
  const one = ids.length === 1 ? accounts.find((a) => a.id === ids[0]) : null;
  openDeleteConfirm(ids, one ? one.label : '');
};

async function selectAccount(id) {
  currentId = id;
  await window.api.accountsSelect(id);
  mainTip.style.display = 'none';
  render();
}

btnAdd.onclick = async () => {
  if (managing) { setManaging(false); return; }   // 管理态下这个按钮是「完成」
  btnAdd.disabled = true;
  try {
    const acc = await window.api.accountsAdd();
    if (acc) { currentId = acc.id; mainTip.style.display = 'none'; }
  } finally {
    btnAdd.disabled = false;
    await refresh();
  }
};

// ---- 双击就地编辑改名(无弹窗) ----
let editing = false;

// 弹窗层级：五个 mask 的 CSS z-index 都是 200，同值时靠 DOM 顺序决定谁在上。
// logMask 写在 HTML 最后，所以先开更新日志、再开更新弹窗时，日志会盖住更新。
// 打开时给当前这个抬一个递增的值，后开的永远在上。
let __maskZ = 200;
function raiseMask(el) {
  if (!el) return;
  try { el.style.zIndex = String(++__maskZ); } catch (e) {}
}
function startInlineEdit(spanEl, acc) {
  if (editing) return;
  editing = true;
  const original = acc.label;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = original;
  input.maxLength = 20;
  spanEl.textContent = '';
  spanEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editing = false;
    const val = input.value.trim();
    if (save && val && val !== original) {
      window.api.accountsRename(acc.id, val).then(() => refresh());
    } else {
      refresh(); // 还原显示
    }
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---- 检测账号状态(v3.0.2) ----
// 单个: 点徽标; 全部: 侧栏「检测账号状态」按钮
async function checkOne(acc, badgeEl) {
  if (badgeEl) { badgeEl.textContent = '检测中'; badgeEl.className = 'badge'; }
  try {
    const r = await window.api.accountsCheckOne(acc.id);
    await refresh();
    if (!r || r.missing) {
      toast('该账号已不存在，请刷新列表。');
    } else if (r.skipped === 'loadfail') {
      toast('「' + r.label + '」页面加载失败，状态未改动。可切到该账号按 Ctrl+R 重试。');
    } else if (r.online) {
      toast('「' + r.label + '」在线（登录凭证 ' + r.strong + ' 条）');
    } else {
      toast('「' + acc.label + '」未检测到登录凭证，请切到该页面扫码登录。');
    }
  } catch (e) {
    await refresh();
    toast('检测失败：' + (e && e.message ? e.message : e));
  }
}

btnCheckAll.onclick = async () => {
  const label = btnCheckAll.textContent;
  btnCheckAll.disabled = true;
  btnCheckAll.textContent = '检测中…';
  try {
    const r = await window.api.accountsCheckAll();
    await refresh();
    if (!r || !r.total) {
      toast('还没有账号可检测。');
    } else if (r.notOnline === 0) {
      toast('检测完成：' + r.total + ' 个账号全部在线。');
    } else {
      toast('检测完成：共 ' + r.total + ' 个，在线 ' + r.online + ' 个，待登录/掉线 ' + r.notOnline + ' 个。');
    }
  } catch (e) {
    toast('检测失败：' + (e && e.message ? e.message : e));
  } finally {
    btnCheckAll.disabled = false;
    btnCheckAll.textContent = label;
  }
};

// ---- 推送事件 ----
window.api.onAccountReady(() => refresh());
window.api.onAccountLogout(() => refresh());
window.api.onAccountDone((d) => {
  refreshSoon();
  toast('「' + (d.label || d.id) + '」对话已完成，点左侧切过去查看。');
});
// 生成中状态一变就刷新侧栏, 转圈立刻出现/消失
window.api.onAccountBusy(() => refreshSoon());
window.api.onLoginTimeout((d) => {
  toast('「' + (d.label || d.id) + '」5 分钟内未检测到登录，可继续扫码或删除重加。');
});
window.api.onBadgeUpdate(() => {
  refreshSoon(); // 徽标由主进程合并进列表, 局部节流刷新
});
window.api.onActiveChanged((d) => {
  currentId = d.id;
  mainTip.style.display = 'none';
  render();
});
window.api.onDownloadDone((d) => {
  toast('📥 下载完成: ' + d.file, d.dir);
});

// ---- 菜单事件 ----
window.api.onMenuAdd(() => btnAdd.onclick());

// ---- 偏好 ----
// v4.2: "关闭按钮最小化到托盘"从侧栏挪进设置窗口(与"关闭即退出"是同一项, 一处控制)
document.getElementById('lnkDl').onclick = (e) => {
  e.preventDefault();
  window.api.openDownloads();
};

// v3.0.9: 作者爱心与悬停预览卡已按用户要求移除

// ---- 工具 ----
function toast(text, openDir) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text + ' ';
  if (openDir) {
    const b = document.createElement('b');
    b.textContent = '[打开目录]';
    b.onclick = () => window.api.openDownloads();
    t.appendChild(b);
  }
  toastWrap.appendChild(t);
  setTimeout(() => { t.remove(); }, 6000);
}

let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 300);
}

// ---- 检查更新(v3.0.15) ----
const btnUpdate = document.getElementById('btnUpdate');
const updMask = document.getElementById('updMask');
const updClose = document.getElementById('updClose');
const updCur = document.getElementById('updCur');
const updNew = document.getElementById('updNew');
const updNotes = document.getElementById('updNotes');
const updBarWrap = document.getElementById('updBarWrap');
const updBar = document.getElementById('updBar');
const updMsgEl = document.getElementById('updMsg');
const updAction = document.getElementById('updAction');
const updSource = document.getElementById('updSource');
const updSrcBox = document.getElementById('updSrcBox');
const updSrcInput = document.getElementById('updSrcInput');
const updSrcSave = document.getElementById('updSrcSave');

let appVersion = '';
let appVersionLabel = '';
let currentUpdateUrl = '';// idle | checking | none | ready | downloading | downloaded | applying
let updPhase = 'idle';

// 更新说明来自 Release 正文, 是 Markdown。这里做轻量清洗:
// 优先只取「本次更新」小节(避免把下载指引、浏览器误报提示一起塞进弹窗),
// 再去掉 ## > ** ` 之类的记号, 让它在纯文本弹窗里读得下去。
function formatNotes(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return '';
  let lines = text.split('\n');

  const headRe = /^#{1,3}\s*(本次更新|更新内容|更新说明|更新日志|what'?s changed|changes)\s*$/i;
  const start = lines.findIndex((l) => headRe.test(l.trim()));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      // 章节结束只认 # 和 ##。
      // 原来写 #{1,3}，遇到 ### 新增 这种子标题就提前截断，
      // 结果 [## 本次更新] 和 [### 新增] 之间只剩空行 → 整个说明显示成空白。
      if (/^#{1,2}\s+\S/.test(lines[i])) { end = i; break; }
    }
    lines = lines.slice(start + 1, end);
  }

  // ### 子标题转成【】形式，不然屏幕上直接显示三个井号
  lines = lines.map((l) => {
    const m = String(l).trim().match(/^###\s+(.+)$/);
    return m ? '【' + m[1] + '】' : l;
  });

  // 整段丢掉 GitHub 的 > [!IMPORTANT] 提示块和普通引用
  const kept = [];
  let inCallout = false;
  for (const l of lines) {
    const t = l.trim();
    if (/^>\s*\[!(IMPORTANT|NOTE|TIP|WARNING|CAUTION)\]/i.test(t)) { inCallout = true; continue; }
    if (inCallout) { if (/^>/.test(t)) continue; inCallout = false; }
    if (/^>/.test(t)) continue;
    kept.push(l);
  }

  return kept
    .map((l) =>
      l
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*+]\s+/, '· ')
        .replace(/^\s*---+\s*$/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function updMsg(text, isErr) {
  updMsgEl.textContent = text || '';
  updMsgEl.className = 'upd-msg' + (isErr ? ' err' : '');
}
function updProgress(pct) {
  updBarWrap.hidden = false;
  updBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
// 账号视图是原生 WebContentsView, 会盖住 DOM 弹窗(登录后点检查更新"没反应"的元凶),
// 所以弹窗开/关都要通知主进程: 弹窗期间隐藏视图, 关掉后恢复
function setAccountViewVisible(visible, id) {
  try {
    if (window.api && window.api.uiModal) window.api.uiModal(!visible, id);
  } catch (e) {}
}
// 版本徽标兼作后台下载进度条: 更新弹窗关掉后, 进度只能显示在这里
function setBadge(text, tip, isNew) {
  btnUpdate.textContent = text;
  if (tip) btnUpdate.title = tip;
  btnUpdate.classList.toggle('has-new', !!isNew);
}
function badgeVersion(tip, isNew) {
  const label = appVersionLabel || (appVersion ? 'v' + appVersion : 'v—');
  setBadge(label, tip || ('当前版本 ' + label + '，点击检查更新'), !!isNew);
}
function closeUpdateModal() {
  if (updPhase === 'applying') return; // 已经在重启更新, 不许关
  // downloading 阶段允许关: 下载跑在主进程, 关掉弹窗照样下, 进度转到版本徽标上
  updMask.hidden = true;
  setAccountViewVisible(true, 'upd');
}
function openUpdateModal() {
  updMask.hidden = false;
  raiseMask(updMask);
  setAccountViewVisible(false, 'upd');
  // 焦点原来可能停在账号页面里(键盘事件到不了这里), 抢回来
  try { updMask.focus({ preventScroll: true }); } catch (e) {}
  // 下载/安装进行中不要重新检查: 主进程会把正在写入的更新包当旧包作废
  if (updPhase === 'downloading' || updPhase === 'applying') return;
  runCheck();
}

// ---- 设置弹窗(v4.2) ----
const setMask = document.getElementById('setMask');
const setClose = document.getElementById('setClose');
const setDlPath = document.getElementById('setDlPath');
const setBrowse = document.getElementById('setBrowse');
const setReset = document.getElementById('setReset');
const setSave = document.getElementById('setSave');
const setCloseExit = document.getElementById('setCloseExit');
const setDownloadRename = document.getElementById('setDownloadRename');
const setRenameBox = document.getElementById('setRenameBox');
const setRenameFormat = document.getElementById('setRenameFormat');
const setRenameCustom = document.getElementById('setRenameCustom');
const setRenamePreview = document.getElementById('setRenamePreview');
const setWarn = document.getElementById('setWarn');

// 下载命名格式: 下拉的选项来自主进程 download-name.js（IPC download:formats），
// 这里只做展示层预览, 不重复维护一份模板。
let renameFormats = [];
let renameDefaultFormat = 'account_date_name';
let renameDefaultCustom = '{账号}-{点日期}-{文件名}';

function renderRenamePreview() {
  const key = setRenameFormat.value;
  let tpl = '';
  if (key === 'custom') tpl = setRenameCustom.value;
  else {
    const hit = renameFormats.find(o => o.key === key);
    tpl = hit ? hit.tpl : '';
  }
  const demo = {
    '{账号}': '示例账号', '{日期}': '2026-11-10', '{点日期}': '2026.11.10',
    '{时间}': '10.11.13', '{文件名}': '奶白色钢制衣柜视频制作方案.mp4'
  };
  let s = String(tpl || '').trim();
  for (const k of Object.keys(demo)) s = s.split(k).join(demo[k]);
  setRenamePreview.textContent = '预览：' + (s || '（模板为空，保存时会退回默认格式）');
  setRenameCustom.hidden = key !== 'custom';
}

function syncRenameUi() {
  const on = setDownloadRename.checked;
  setRenameBox.classList.toggle('is-off', !on);
  setRenameFormat.disabled = !on;
  setRenameCustom.disabled = !on;
  renderRenamePreview();
}

setDownloadRename.onchange = syncRenameUi;
setRenameFormat.onchange = renderRenamePreview;
setRenameCustom.oninput = renderRenamePreview;

// warnMsg 传了就在弹窗顶部显示红字(v4.2: 默认下载位置不可用时用)
async function openSettingsModal(warnMsg) {
  try {
    const [dir, prefs, fmts] = await Promise.all([
      window.api.getDownloadDir(),
      window.api.prefsGet(),
      window.api.downloadFormats ? window.api.downloadFormats().catch(() => null) : null
    ]);
    setDlPath.value = dir.dir || '';
    setDlPath.title = '当前：' + (dir.dir || '（不可用，请手动选择）');
    setDlPath.dataset.default = dir.defaultDir || '';
    // closeToTray === false 才表示"关闭即退出"
    setCloseExit.checked = prefs.closeToTray === false;
    setDownloadRename.checked = prefs.downloadRename === true;
    if (fmts && Array.isArray(fmts.options)) {
      renameFormats = fmts.options;
      renameDefaultFormat = fmts.defaultFormat || renameDefaultFormat;
      renameDefaultCustom = fmts.defaultCustom || renameDefaultCustom;
      setRenameFormat.innerHTML = '';
      for (const o of fmts.options) {
        const op = document.createElement('option');
        op.value = o.key;
        op.textContent = o.label;
        setRenameFormat.appendChild(op);
      }
    }
    setRenameFormat.value = renameFormats.some(o => o.key === prefs.downloadRenameFormat)
      ? prefs.downloadRenameFormat : renameDefaultFormat;
    setRenameCustom.value = String(prefs.downloadRenameCustom || renameDefaultCustom);
    syncRenameUi();
  } catch (e) {}
  setWarn.hidden = !warnMsg;
  setWarn.textContent = warnMsg || '';
  setMask.hidden = false;
  raiseMask(setMask);
  setAccountViewVisible(false, 'set');
  try { setMask.focus({ preventScroll: true }); } catch (e) {}
}

function closeSettingsModal() {
  setMask.hidden = true;
  setAccountViewVisible(true, 'set');
}

setClose.onclick = () => closeSettingsModal();

setBrowse.onclick = async () => {
  try {
    const r = await window.api.chooseDownloadDir();
    if (r && r.ok && r.path) {
      setDlPath.value = r.path;
      setDlPath.title = '当前：' + r.path;
    }
  } catch (e) {
    toast('选择文件夹失败：' + (e && e.message ? e.message : e));
  }
};

setReset.onclick = () => {
  setDlPath.value = setDlPath.dataset.default || '';
  setDlPath.title = '当前：' + setDlPath.value;
  setDownloadRename.checked = false;   // 下载改名默认关闭
  setRenameFormat.value = renameDefaultFormat;
  setRenameCustom.value = renameDefaultCustom;
  syncRenameUi();
};

setSave.onclick = async () => {
  const val = String(setDlPath.value || '').trim();
  const def = setDlPath.dataset.default || '';
  // 选的正好是默认目录时存空值, 这样以后系统下载文件夹变了也能跟着走
  const toSave = (val === def) ? '' : val;
  try {
    await window.api.prefsSet({
      downloadDir: toSave,
      closeToTray: !setCloseExit.checked,   // 勾了"直接退出" => closeToTray=false
      downloadRename: setDownloadRename.checked,
      downloadRenameFormat: setRenameFormat.value,
      downloadRenameCustom: String(setRenameCustom.value || '').trim()
    });
    closeSettingsModal();
    toast(toSave ? ('设置已保存：' + toSave) : '已恢复默认设置（系统「下载」文件夹、下载改名关闭、默认格式）');
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
};

if (window.api.onMenuSettings) window.api.onMenuSettings(() => openSettingsModal());
// 主进程找不到可用下载目录时会推这个, 直接把设置弹出来并红字提示
if (window.api.onDownloadNoDir) {
  window.api.onDownloadNoDir(() => {
    openSettingsModal('默认下载位置不可用：系统「下载」文件夹和桌面都写不进去（可能被安全策略限制）。请手动选择一个可写入的文件夹，然后再重新下载。');
  });
}

async function runCheck() {
  // 下载/安装进行中不要重新检查: 主进程会把正在写入的更新包当旧包作废
  if (updPhase === 'downloading' || updPhase === 'applying') return;
  updPhase = 'checking';
  updCur.textContent = appVersionLabel || '—';
  updNew.textContent = '检测中…';
  updNotes.hidden = true;
  updNotes.textContent = '';
  updBarWrap.hidden = true;
  updBar.style.width = '0';
  updAction.disabled = true;
  updAction.textContent = '检测中…';
  updMsg('正在连接更新源…');

  let r = null;
  try {
    r = await window.api.updateCheck();
  } catch (e) {
    r = { ok: false, error: (e && e.message) ? e.message : String(e) };
  }

  if (!r || !r.ok) {
    updPhase = 'idle';
    updNew.textContent = '检测失败';
    updMsg((r && r.error ? r.error : '检查更新失败') + '　可在「更新源」里换个地址。', true);
    updAction.disabled = false;
    updAction.textContent = '重试';
    return;
  }

  // 主进程正在下载时只回 { downloading: true }，不带 latest/hasNew。
  // 不先挡掉会走到下面 !r.hasNew 分支，误报"已经是最新版本"，还会把徽标
  // 从「下载中 NN%」重置回版本号。触发场景：renderer 重载后 updPhase 归位成 idle。
  if (r.downloading) {
    updPhase = 'downloading';
    updNew.textContent = '下载中';
    updMsg('更新包正在后台下载，进度显示在左侧版本号上。');
    updAction.disabled = true;
    updAction.textContent = '下载中…';
    return;
  }

  updNew.textContent = 'v' + r.latest;
  if (!r.hasNew) {
    updPhase = 'none';
    updMsg('已经是最新版本。');
    updAction.disabled = false;
    updAction.textContent = '重新检查';
    badgeVersion();
    return;
  }

  badgeVersion(null, true);
  updNotes.hidden = !r.notes;
  updNotes.textContent = formatNotes(r.notes);
  updAction.disabled = false;
  const isCore = r.kind === 'core';
  const packText = isCore ? '核心包' : '完整包';
  if (r.cached) {
    updPhase = 'downloaded';
    updMsg('更新包已下载完成（' + packText + ' ' + r.sizeText + '），点右侧按钮重启并更新。');
    updAction.textContent = '重启并更新';
  } else {
    updPhase = 'ready';
    updMsg(isCore
      ? '发现新版本，只需下载核心包 ' + r.sizeText + '（只替换程序文件，不动运行时和账号数据）。'
      : '发现新版本，安装包 ' + r.sizeText + '，点右侧按钮开始下载。');
    updAction.textContent = isCore ? '立即更新（' + r.sizeText + '）' : '立即更新';
  }
}

async function startDownload() {
  updPhase = 'downloading';
  updAction.disabled = true;
  updAction.textContent = '下载中…';
  updMsg('正在下载更新包…');
  updProgress(0);
  updBadgeProgress(0);
  try {
    const r = await window.api.updateDownload();
    updPhase = 'downloaded';
    updProgress(100);
    updMsg('下载完成（' + r.sizeText + '），点右侧按钮重启并更新。');
    updAction.textContent = '重启并更新';
    updAction.disabled = false;
    setBadge('可更新', '更新包已下载完成，点击重启并更新', true);
    // 弹窗已经关掉(后台下载)才需要提醒, 开着的话界面上就写着
    if (updMask.hidden) toast('更新包下载完成，点左侧版本号即可重启并更新');
  } catch (e) {
    updPhase = 'ready';
    updBarWrap.hidden = true;
    const msg = (e && e.message) ? e.message : String(e);
    updMsg('下载失败：' + msg, true);
    updAction.textContent = '重试下载';
    updAction.disabled = false;
    badgeVersion('更新包下载失败：' + msg + '（点击重试）', true);
    if (updMask.hidden) toast('更新包下载失败：' + msg);
  }
}

// 后台下载时把进度写到版本徽标上(弹窗开着就无所谓, 弹窗里有进度条)
function updBadgeProgress(pct) {
  if (!updMask.hidden) return;
  setBadge('下载中 ' + pct + '%', '正在后台下载更新包 ' + pct + '%，点击查看详情', true);
}

async function applyNow() {
  updPhase = 'applying';
  updAction.disabled = true;
  updAction.textContent = '正在重启…';
  updClose.disabled = true;
  updMsg('软件即将关闭并自动完成更新，几秒后会重新打开，请不要手动启动。');
  try {
    const r = await window.api.updateApply();
    // 主进程确认更新脚本真的起来了才会退出; 没起来会返回失败, 这里必须提示,
    // 否则用户看到的就是"什么都没发生"(v3.0.16 之前的老问题)
    if (r && r.ok === false) {
      updPhase = 'downloaded';
      updClose.disabled = false;
      updMsg(r.error || '更新程序未能启动，软件已取消退出。', true);
      updAction.textContent = '重试更新';
      updAction.disabled = false;
      return;
    }
  } catch (e) {
    updPhase = 'downloaded';
    updClose.disabled = false;
    updMsg('更新启动失败：' + ((e && e.message) ? e.message : String(e)), true);
    updAction.textContent = '重试更新';
    updAction.disabled = false;
  }
}

updAction.onclick = () => {
  if (updPhase === 'ready') return startDownload();
  if (updPhase === 'downloaded') return applyNow();
  if (updPhase === 'idle' || updPhase === 'none') return runCheck();
};
btnUpdate.onclick = openUpdateModal;

// 原生菜单栏默认隐藏；侧栏的紧凑按钮打开同一套菜单，动作和快捷键不变。
const btnAppMenu = document.getElementById('btnAppMenu');
if (btnAppMenu) {
  btnAppMenu.onclick = async () => {
    const r = btnAppMenu.getBoundingClientRect();
    try {
      if (api.appMenuPopup) await api.appMenuPopup(r.left, r.bottom);
    } catch (e) {}
  };
}
updClose.onclick = closeUpdateModal;
// 两个弹窗都只认右上角的 ×: 点弹窗外面、按 Esc 都不再关窗。
// 原来点外面一下就关, 更新弹窗里正在下载的进度说没就没, 误触代价太大。
// Enter 仍然走更新弹窗的主按钮(立即更新·重启并更新)。

// ============ 删除账号二次确认（HTML 弹窗，原生 dialog 改不了样式）============
// 单个 / 批量共用同一套确认框：传 id 数组进来就行
let openDeleteConfirm = () => {};
(function initDeleteConfirm() {
  const mask = document.getElementById('delMask');
  if (!mask) return;
  const titleEl = document.getElementById('delTitle');
  const okBtn = document.getElementById('delOk');
  const cancelBtn = document.getElementById('delCancel');
  const closeBtn = document.getElementById('delClose');
  let pendingIds = [];

  function close() {
    mask.hidden = true;
    pendingIds = [];
    try { api.uiModal(false, 'del'); } catch (e) {}
  }

  function open(ids, label) {
    pendingIds = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!pendingIds.length) return;
    titleEl.textContent = pendingIds.length > 1
      ? '删除选中的 ' + pendingIds.length + ' 个账号？'
      : '删除账号「' + (label || pendingIds[0]) + '」？';
    mask.hidden = false;
    raiseMask(mask);
    mask.focus();
    try { api.uiModal(true, 'del'); } catch (e) {}
  }
  openDeleteConfirm = open;

  okBtn.addEventListener('click', async () => {
    const ids = pendingIds.slice();
    if (!ids.length) return close();
    okBtn.disabled = true;
    try {
      if (ids.length === 1) await api.accountsDelete(ids[0]);
      else if (api.accountsDeleteMany) await api.accountsDeleteMany(ids);
      else for (const one of ids) await api.accountsDelete(one);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
    okBtn.disabled = false;
    if (ids.indexOf(currentId) >= 0) currentId = null;
    close();
    // 删完自动退出管理态：避免勾选还留在界面上、手一滑又删一批（用户 2026-11-10 要求）
    try { if (managing) setManaging(false); } catch (e) {}
    try { await refresh(); } catch (e) {}
  });

  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  if (api.onConfirmDelete) api.onConfirmDelete((d) => {
    if (d && d.id) open([d.id], d.label);
  });
})();


// ============ 聚合搜索（一次搜所有账号的消息）============
// 主进程并发把所有账号的豆包页面各搜一遍，这里只负责展示 + 跳转。
(function initAggSearch() {
  const mask = document.getElementById('searchMask');
  if (!mask) return;
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  const reloadBtn = document.getElementById('searchReload');
  const metaEl = document.getElementById('searchMeta');
  const resEl = document.getElementById('searchResults');
  const closeBtn = document.getElementById('searchClose');
  const entry = document.getElementById('btnSearch');
  const filtersEl = document.getElementById('searchFilters');
  const cacheToggle = document.getElementById('searchCacheToggle');
  const cacheHint = document.getElementById('searchCacheHint');
  const cacheClearBtn = document.getElementById('searchCacheClear');
  const recentEl = document.getElementById('searchRecent');
  const cacheStatusEl = document.getElementById('searchCacheStatus');
  const cacheBarEl = document.getElementById('searchCacheBar');
  const cacheStatusTextEl = document.getElementById('searchCacheStatusText');

  let timer = null;
  let seq = 0;
  let lastKw = '';              // 用户输入的原词（最近搜索/重跑用）
  let lastSearchKw = '';        // 实际发到豆包的词（可能是去标点后的从句）
  let lastPayload = null;      // 最近一次搜索结果，筛选时直接复用不重搜
  let lastMs = 0;
  let filterAcct = 'all';      // 账号筛选：all / accountId
  let filterKind = 'all';      // 类型筛选：all / 消息 / 对话
  let filterTime = '3m';       // 时间筛选：3m(默认) / 1m / all / custom
  let customFrom = '', customTo = '';
  let searchFromTs = null;     // 本轮搜索用的窗口起点（用于判断切换后要不要重搜）
  let streamActive = false;    // 是否处在「边搜边显示」的过程中
  let streamDone = new Set();  // 已完成（收齐全量）的账号
  let streamT0 = 0;
  let cacheEnabled = false;    // 档2 本地缓存开关（默认关，状态从主进程读）
  let cacheSeed = new Map();   // 本次搜索预读的缓存条目（accountId → items，都带 fromCache）
  let cachePreview = false;    // 当前画面是不是“缓存快速预览”，实时搜索仍会继续
  let recentSearches = [];     // 最近搜索的词（去重、最近在前，最多 12 个）
  let lastStats = { total: 0, cacheN: 0, capped: 0, failed: 0 };   // 最近一次 render 的缓存统计
  let lastCacheTotal = 0;        // 缓存总条数（所有关键词，去重后）
  let lastKeywordCacheN = null;  // 当前关键词缓存了多少条（去重后）
  let streamRenderTimer = null;  // 流式渲染合并定时器（250ms 最多重绘一次）
  let streamMetaText = '';       // 流式期间的 meta 文案，节流重绘后补回去
  let lastCacheWritten = null;   // 本次搜索写进缓存的条数（含刷新）
  let lastCacheAdded = null;     // 其中本地原来没有、新增的条数

  // 时间窗口由主进程算好（sandboxed preload 不能 require 本地模块），
  // 这里缓存结果，render() 保持同步读取；切换条件时先 sync 再用。
  let windowCache = { from: null, to: null, label: '全部' };
  const currentWindow = () => windowCache;
  async function syncWindow() {
    try { windowCache = await api.searchTimeWindow(filterTime, customFrom, customTo); }
    catch (e) { windowCache = { from: null, to: null, label: '全部' }; }
    return windowCache;
  }
  syncWindow();

  // 档2 本地缓存：开关默认关。开启后主进程把搜过的存本地、下次补充旧消息，
  // 实时搜索照跑不误（新消息永远来自实时）。这里只管开关状态 + 提示 + 清空。
  // 缓存提示：优先显示「当前这个词缓存了多少条」，避免把「本次缓存补了几条」误当成缓存大小
  function refreshCacheHint() {
    if (!cacheHint) return;
    if (!cacheEnabled) {
      cacheHint.textContent = '默认关闭，开启后才会存到本地';
      if (cacheClearBtn) cacheClearBtn.hidden = true;
      if (cacheStatusEl) cacheStatusEl.hidden = true;
      return;
    }
    const kw = String(lastSearchKw || lastKw || '').trim();
    if (kw && lastKeywordCacheN != null) {
      cacheHint.textContent = '「' + kw + '」缓存 ' + lastKeywordCacheN + ' 条 · 所有搜索 ' + lastCacheTotal + ' 条';
    } else {
      cacheHint.textContent = '所有搜索已存 ' + lastCacheTotal + ' 条 · 重搜同一个词会先显示缓存（标「缓存」），新消息仍实时搜';
    }
    if (cacheClearBtn) cacheClearBtn.hidden = !(lastCacheTotal > 0);
  }
  function updateCacheHint(stats) {
    if (stats && typeof stats.items === 'number') lastCacheTotal = stats.items;
    refreshCacheHint();
  }

  // ---------- 最近搜索（搜索框下面一排，点词重搜、点 × 删除）----------
  function saveRecent() {
    try { if (api.prefsSet) api.prefsSet({ recentSearches: recentSearches }); } catch (e) {}
  }
  function renderRecent() {
    if (!recentEl) return;
    if (!recentSearches.length) { recentEl.hidden = true; recentEl.innerHTML = ''; return; }
    recentEl.hidden = false;
    let h = '<span class="rec-label">最近</span>';
    for (const kw of recentSearches) {
      h += '<span class="rec-chip" data-kw="' + esc(kw) + '">' +
        '<span class="rec-txt">' + esc(kw) + '</span>' +
        '<span class="rec-x" title="从最近搜索里删掉">×</span></span>';
    }
    recentEl.innerHTML = h;
    for (const chip of recentEl.querySelectorAll('.rec-chip')) {
      chip.onclick = (e) => {
        if (e.target && e.target.classList.contains('rec-x')) return;   // × 自己处理
        if (input.value === chip.dataset.kw && lastKw === chip.dataset.kw) return;
        input.value = chip.dataset.kw;
        input.dispatchEvent(new Event('input'));
      };
      const x = chip.querySelector('.rec-x');
      if (x) x.onclick = (e) => {
        e.stopPropagation();
        const k = chip.dataset.kw;
        recentSearches = recentSearches.filter((v) => v !== k);
        saveRecent();
        renderRecent();
      };
    }
  }
  function pushRecent(kw) {
    const k = String(kw == null ? '' : kw).trim();
    if (!k) return;
    recentSearches = [k].concat(recentSearches.filter((x) => x !== k)).slice(0, 12);
    saveRecent();
    renderRecent();
  }
  if (api.prefsGet) {
    api.prefsGet().then((p) => {
      recentSearches = (p && Array.isArray(p.recentSearches)) ? p.recentSearches.slice(0, 12) : [];
      renderRecent();
    }).catch(() => {});
  }

  // ---------- 缓存完成度：搜索中按账号进度填充，结束后报告是否「没缓存完」----------
  function updateCacheStatus(opt) {
    if (!cacheStatusEl) return;
    if (!cacheEnabled) { cacheStatusEl.hidden = true; return; }
    const o = opt || {};
    if (!o.searching && !o.hasPayload) { cacheStatusEl.hidden = true; return; }
    cacheStatusEl.hidden = false;
    let pct, cls, txt;
    if (o.searching) {
      const done = o.done || 0, all = o.accounts || 0;
      pct = all ? Math.min(95, Math.round((done / all) * 100)) : 8;
      cls = '';
      txt = '缓存中… 本次已到 ' + (o.total || 0) + ' 条 · ' + done + '/' + all + ' 个账号完成';
    } else {
      pct = 100;
      if (o.capped) { cls = 'warn'; txt = '可能没缓存完：' + o.capped + ' 个账号到单次加载上限（60 秒）'; }
      else if (o.failed) { cls = 'warn'; txt = '可能没缓存完：' + o.failed + ' 个账号没读出来'; }
      else { cls = 'ok'; txt = '已缓存完整'; }
      txt += ' · 本次 ' + (o.total || 0) + ' 条 · 缓存补 ' + (o.cacheN || 0) + ' 条';
      if (o.written != null) txt += ' · 写入缓存 ' + o.written + ' 条（新增 ' + (o.added || 0) + '）';
    }
    cacheStatusEl.classList.toggle('warn', cls === 'warn');
    cacheStatusEl.classList.toggle('ok', cls === 'ok');
    if (cacheBarEl) cacheBarEl.style.width = pct + '%';
    if (cacheStatusTextEl) {
      cacheStatusTextEl.textContent = txt;
      if (!cacheStatusTextEl.title) {
        cacheStatusTextEl.title = '写入缓存 = 本次实时结果写进缓存的条数（含刷新，不受时间筛选影响）；新增 = 其中本地原来没有的条数，重搜时通常为 0';
      }
    }
  }
  function applyCacheStatus(searching, done, accounts) {
    updateCacheStatus({
      searching: searching, done: done, accounts: accounts,
      total: lastStats.total, cacheN: lastStats.cacheN,
      capped: lastStats.capped, failed: lastStats.failed, hasPayload: true,
      written: lastCacheWritten, added: lastCacheAdded
    });
  }
  if (cacheToggle && api.searchCacheGet) {
    api.searchCacheGet().then((d) => {
      cacheEnabled = !!(d && d.enabled);
      cacheToggle.checked = cacheEnabled;
      updateCacheHint(d && d.stats);
    }).catch(() => {});
    cacheToggle.onchange = async () => {
      cacheEnabled = cacheToggle.checked;
      try {
        const d = await api.searchCacheSet(cacheEnabled);
        updateCacheHint(d && d.stats);
      } catch (e) {}
      if (lastKw) run(lastKw);   // 立刻按新开关重搜一遍，开/关的效果当场可见
    };
  }
  if (cacheClearBtn && api.searchCacheClear) {
    cacheClearBtn.onclick = async () => {
      try {
        const d = await api.searchCacheClear();
        updateCacheHint(d && d.stats);
        toast('已清空搜索缓存');
      } catch (e) {}
      // 不要重搜：缓存开着的话重搜会把刚清掉的数据又存回去。
      // 直接把当前列表里「缓存补回来」的行摘掉重绘，实时结果原样保留。
      if (lastPayload) {
        for (const g of (lastPayload.results || [])) {
          g.items = (g.items || []).filter((it) => !it.fromCache);
        }
        render(lastPayload, lastSearchKw || lastKw, lastMs);
      }
    };
  }

  // 流式期间，还没搜完的账号结果先淡显，让用户一眼看出哪些还在涨
  const acctPending = (id) => streamActive && !streamDone.has(id);

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // 只高亮第一处，避免长片段里满屏黄
  function hl(text, kw) {
    const t = String(text == null ? '' : text);
    if (!kw) return esc(t);
    const i = t.toLowerCase().indexOf(kw.toLowerCase());
    if (i < 0) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + kw.length)) + '</mark>' + esc(t.slice(i + kw.length));
  }

  function open() {
    mask.hidden = false;
    raiseMask(mask);
    try { api.uiModal(true, 'search'); } catch (e) {}
    setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 30);
  }
  function close() {
    mask.hidden = true;
    try { api.uiModal(false, 'search'); } catch (e) {}
  }

  // 账号 / 类型筛选条：10 个账号时先把范围收窄，不然要翻半天
  function renderFilters(payload) {
    if (!filtersEl) return;
    // 预建的账号分组（0 条）也要留着，这样搜索一开始所有账号就都在画面上
    const groups = payload.results || [];
    if (!groups.length) { filtersEl.hidden = true; filtersEl.innerHTML = ''; return; }
    filtersEl.hidden = false;

    let total = 0, msgN = 0, talkN = 0;
    const uniqByGroup = new Map();
    for (const g of groups) {
      const seen = new Set();
      let n = 0;
      for (const it of (g.items || [])) {
        const key = it.sig || ('#' + it.index + '|' + it.title);
        if (seen.has(key)) continue;   // 和列表一样按签名去重，避免筛选项数字比列表大
        seen.add(key);
        n++;
        total++;
        if (String(it.kind || '').indexOf('消息') >= 0) msgN++; else talkN++;
      }
      uniqByGroup.set(g.accountId, n);
    }
    const chip = (label, n, on, attrs) =>
      '<button type="button" class="sf-chip' + (on ? ' on' : '') + '" ' + attrs + '>' +
      esc(label) + (n === null ? '' : ' <span class="n">' + n + '</span>') + '</button>';

    let h = '<div class="sf-row"><span class="sf-label">账号</span>';
    h += chip('全部', total, filterAcct === 'all', 'data-a="all"');
    for (const g of groups) {
      h += chip(g.label, uniqByGroup.get(g.accountId) || 0, filterAcct === g.accountId, 'data-a="' + esc(g.accountId) + '"');
    }
    h += '</div><div class="sf-row"><span class="sf-label">类型</span>';
    h += chip('全部', total, filterKind === 'all', 'data-k="all"');
    h += chip('消息', msgN, filterKind === '消息', 'data-k="消息"');
    h += chip('对话', talkN, filterKind === '对话', 'data-k="对话"');
    h += '</div><div class="sf-row"><span class="sf-label">时间</span>';
    h += chip('全部', null, filterTime === 'all', 'data-t="all"');
    h += chip('近1个月', null, filterTime === '1m', 'data-t="1m"');
    h += chip('近3个月', null, filterTime === '3m', 'data-t="3m"');
    h += chip('自选', null, filterTime === 'custom', 'data-t="custom"');
    if (filterTime === 'custom') {
      h += '<input type="month" class="sf-month" id="sfFrom" value="' + esc(customFrom) + '">' +
           '<span class="sf-label">到</span>' +
           '<input type="month" class="sf-month" id="sfTo" value="' + esc(customTo) + '">';
    } else {
      h += '<span class="sf-hint">当前：' + esc(currentWindow().label) + '</span>';
    }
    h += '</div>';
    filtersEl.innerHTML = h;

    for (const b of filtersEl.querySelectorAll('.sf-chip')) {
      b.onclick = async () => {
        if (b.dataset.t !== undefined) {
          filterTime = b.dataset.t;
          if (filterTime === 'custom' && !customFrom) {
            const d = new Date();
            const ym = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
            customTo = ym(d);
            d.setMonth(d.getMonth() - 6);
            customFrom = ym(d);
          }
          const nw = await syncWindow();
          renderFilters(lastPayload);
          // 窗口变宽时，已加载的数据可能不够（深挖是按旧窗口提前收工的），重搜一遍；
          // 变窄则纯前端过滤即可，即点即生效。
          const wider = (nw.from == null && searchFromTs != null) ||
                        (nw.from != null && searchFromTs != null && nw.from < searchFromTs);
          if (wider) run(lastKw);
          else render(lastPayload, lastSearchKw || lastKw, lastMs);
          return;
        }
        if (b.dataset.a !== undefined) filterAcct = b.dataset.a;
        if (b.dataset.k !== undefined) filterKind = b.dataset.k;
        renderFilters(lastPayload);
        render(lastPayload, lastSearchKw || lastKw, lastMs);
      };
    }
    for (const el of filtersEl.querySelectorAll('.sf-month')) {
      el.onchange = () => {
        if (el.id === 'sfFrom') customFrom = el.value;
        else customTo = el.value;
        renderFilters(lastPayload);
        run(lastKw);          // 自定义区间一律重搜，可能变宽
      };
    }
  }

  // 流式结果会不断重排：新结果插到上面时，整个列表会往下跳，用户想点的东西就跑了。
  // 重绘前记住「当前看的那条」，重绘后把它放回原来的屏幕位置。
  let skipAnchor = false;
  function itemDomKey(el) {
    return (el.dataset.a || '') + '\u0001' + (el.dataset.i || '') + '\u0001' + (el.dataset.sig || '');
  }
  function captureScrollAnchor() {
    if (!resEl) return null;
    const boxTop = resEl.getBoundingClientRect().top;
    let best = null, bestD = Infinity;
    for (const el of resEl.querySelectorAll('.sr-item')) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= boxTop + 1) continue;
      const d = Math.abs(r.top - boxTop);
      if (d < bestD) { bestD = d; best = el; }
    }
    if (!best) return null;
    return { key: itemDomKey(best), offset: best.getBoundingClientRect().top - boxTop };
  }
  function restoreScrollAnchor(anchor) {
    if (!anchor) return;
    const boxTop = resEl.getBoundingClientRect().top;
    for (const el of resEl.querySelectorAll('.sr-item')) {
      if (itemDomKey(el) !== anchor.key) continue;
      const delta = (el.getBoundingClientRect().top - boxTop) - anchor.offset;
      if (Math.abs(delta) > 1) resEl.scrollTop += delta;
      return;
    }
  }

  function render(payload, kw, ms) {
    const anchor = skipAnchor ? null : captureScrollAnchor();
    skipAnchor = false;
    const k = kw.toLowerCase();
    const win = currentWindow();
    const filtered = (filterAcct !== 'all' || filterKind !== 'all' || filterTime !== 'all');
    let unknownTime = 0;
    let cacheN = 0;
    const groups = (payload.results || [])
      .filter((g) => filterAcct === 'all' || g.accountId === filterAcct)
      .map((g) => {
        const filteredItems = (g.items || []).filter((it) => {
          // 豆包返回的本来就是命中项，而且是语义匹配：标题/片段里不一定字面含关键词。
          // 以前在这里又按 kw 过滤一次，会把一半结果悄悄丢掉。k 只留给 hl() 做高亮。
          if (filterKind !== 'all' && String(it.kind || '').indexOf(filterKind) < 0) return false;
          if (win.from != null || win.to != null) {
            if (it.ts == null) return true;   // 时间未知一律保留，去重后再计数
            if (win.from != null && it.ts < win.from) return false;
            if (win.to != null && it.ts > win.to) return false;
          }
          return true;
        });
        // 同一段内容会出现多条（同签名），列表只展示一条；计数也按去重后算，和缓存口径一致
        const seen = new Set();
        const items = [];
        for (const it of filteredItems) {
          const key = it.sig || ('#' + it.index + '|' + it.title);
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(it);
          if (it.ts == null) unknownTime++;
          if (it.fromCache) cacheN++;
        }
        return { g: g, items: items };
      })
      // 还在搜的账号即使 0 条也留着占位，别让它「过一会才冒出来」
      .filter((x) => x.items.length || acctPending(x.g.accountId));

    const total = groups.reduce((n, x) => n + x.items.length, 0);
    const failed = (payload.results || []).filter((g) => !g.ok).length;
    const capped = (payload.results || []).filter((g) => g.deep && g.deep.capped).length;
    lastStats = { total: total, cacheN: cacheN, capped: capped, failed: failed };
    // 当前关键词的缓存条数 = 结果里（实时 + 缓存补差）去重后的签名数
    let uniq = new Set();
    for (const g of (payload.results || [])) for (const it of (g.items || [])) if (it.sig) uniq.add(it.sig);
    lastKeywordCacheN = uniq.size;
    if (cacheEnabled) refreshCacheHint();
    const moreHint = capped ? ' · ' + capped + ' 个账号可能还有更多（到加载上限）' : '';
    const timeHint = filterTime === 'all' ? '' : ' · ' + win.label;
    const unknownHint = unknownTime ? ' · ' + unknownTime + ' 条时间未知未过滤' : '';
    const cacheMetaHint = cacheN ? ' · 其中 ' + cacheN + ' 条来自缓存' : '';
    if (!total && !(streamActive && groups.some((x) => acctPending(x.g.accountId)))) {
      if (streamActive && streamDone.size < (payload.total || 0)) {
        resEl.innerHTML = '<div class="search-empty">搜索中…</div>';
      } else {
        resEl.innerHTML = '<div class="search-empty">' +
          (filtered ? '当前筛选下没有结果 —— 点上面的「全部」看看' : '没搜到「' + esc(kw) + '」') +
          (!filtered && failed ? '<br>' + failed + ' 个账号没读出来（点右边「重新加载」再试一次）' : '') +
          '</div>';
      }
      metaEl.textContent = '共 0 条 · ' + ms + ' ms' + timeHint + moreHint;
      return;
    }

    metaEl.textContent = '共 ' + total + ' 条' + (filtered ? '（已筛选）' : '') +
      ' · 来自 ' + groups.length + '/' + (payload.total || groups.length) +
      ' 个账号 · ' + ms + ' ms' + timeHint + unknownHint + cacheMetaHint +
      (failed ? ' · ' + failed + ' 个没读出来' : '') + moreHint;

    let html = '';
    for (const x of groups) {
      const g = x.g;
      html += '<div class="sr-group"><span class="sr-dot" style="background:' + esc(g.color || '#4F86F7') +
        '"></span><span>' + esc(g.label) + '</span><span class="sr-count">' + x.items.length + ' 条</span></div>';
      if (!x.items.length) {
        html += '<div class="sr-pending">正在搜索这个账号…</div>';
        continue;
      }
      for (const it of x.items) {
        const isMsg = String(it.kind || '').indexOf('消息') >= 0;
        html += '<div class="sr-item' + (acctPending(g.accountId) ? ' sr-loading' : '') +
          (it.fromCache ? ' sr-from-cache' : '') +
          '" data-a="' + esc(g.accountId) + '" data-i="' + it.index +
          '" data-v="' + esc(it.via || 'all') + '" data-sig="' + esc(it.sig || '') +
          '" data-time="' + esc(it.time || '') +
          '" title="' + (it.fromCache ? '本地缓存补回的旧消息，点击尝试跳转' : '点击跳到这条消息') + '">' +
          '<span class="sr-kind' + (isMsg ? ' msg' : '') + '">' + esc(it.kind) + '</span>' +
          (it.fromCache ? '<span class="sr-cache" title="这次实时没加载出来，用本地缓存补的">缓存</span>' : '') +
          '<span class="sr-acct" title="来自 ' + esc(g.label) + '"><i style="background:' +
            esc(g.color || '#4F86F7') + '"></i>' + esc(g.label) + '</span>' +
          '<div class="sr-body">' +
          '<div class="sr-title">' + hl(it.title, kw) + '</div>' +
          (it.snippet ? '<div class="sr-snippet">' + hl(it.snippet, kw) + '</div>' : '') +
          '</div>' +
          (it.time ? '<span class="sr-time">' + esc(it.time) + '</span>' : '') +
          '</div>';
      }
    }
    resEl.innerHTML = html;
    for (const el of resEl.querySelectorAll('.sr-item')) {
      el.onclick = () => jump(el.dataset.a, Number(el.dataset.i), el.dataset.v, el.dataset.sig, el.dataset.time);
    }
    restoreScrollAnchor(anchor);
  }

  // 流式渲染节流：大结果时不再每页全量重绘，250ms 合并一次；最终结果由 run() 立即冲刷
  function scheduleStreamRender() {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = null;
      if (!streamActive || !lastPayload) return;
      renderFilters(lastPayload);
      render(lastPayload, lastSearchKw || lastKw, Date.now() - streamT0);
      if (streamMetaText) metaEl.textContent = streamMetaText;
    }, 250);
  }
  function flushStreamRender() {
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
  }

  async function run(rawKw) {
    const raw = String(rawKw == null ? '' : rawKw).trim();
    if (!raw) return;
    const mine = ++seq;
    lastKw = raw;                 // 原词：最近搜索、缓存开关/时间筛选重跑都按它
    let plan = [raw];
    try {
      const p = api.searchPlan ? await api.searchPlan(raw) : null;
      if (Array.isArray(p) && p.length) plan = p;
    } catch (e) {}
    if (mine !== seq) return;
    lastSearchKw = plan[0];
    skipAnchor = true;          // 换词了，回到列表顶部，不要沿用上一轮的位置
    try { resEl.scrollTop = 0; } catch (e) {}
    pushRecent(raw);
    lastKeywordCacheN = null;
    refreshCacheHint();
    flushStreamRender();
    streamMetaText = '';
    lastCacheWritten = null;
    lastCacheAdded = null;
    await syncWindow();
    if (mine !== seq) return;
    const win = currentWindow();
    searchFromTs = win.from;
    streamActive = true;
    streamT0 = Date.now();
    cachePreview = false;
    metaEl.textContent = '正在搜索…';
    resEl.innerHTML = '<div class="search-empty">搜索中…</div>';
    let finalR = null, usedQ = plan[0];
    for (let i = 0; i < plan.length; i++) {
      if (mine !== seq) return;
      usedQ = plan[i];
      lastSearchKw = usedQ;
      lastPayload = null;
      cacheSeed = new Map();
      streamDone = new Set();
      streamMetaText = '';
      if (i > 0) {
        metaEl.textContent = '没搜到，换用「' + usedQ + '」再试…';
        resEl.innerHTML = '<div class="search-empty">换用「' + esc(usedQ) + '」再试…</div>';
      }
      // 缓存完整时先把缓存结果立刻铺上去；下面仍然会跑完整搜索，
      // 实时结果后来居上，失败时也还有缓存兜底。这里只是把“等搜索完成”
      // 变成“先看到结果、后台刷新”。
      let fast = null;
      try {
        if (api.searchCacheFast) fast = await api.searchCacheFast(usedQ, { fromTs: win.from });
      } catch (e) {}
      if (mine !== seq) return;
      if (fast && fast.ok && fast.cacheFast && Array.isArray(fast.results)) {
        lastPayload = { ok: true, keyword: usedQ, total: fast.total, results: fast.results };
        cacheSeed = new Map(fast.results.map((g) => [g.accountId, g.items || []]));
        streamActive = true;
        streamDone = new Set();
        cachePreview = true;
        let cachedN = 0;
        for (const g of fast.results) cachedN += (g.items || []).length;
        renderFilters(lastPayload);
        render(lastPayload, usedQ, 0);
        // render() 会先写汇总行；缓存预览的提示放在它后面，避免被覆盖。
        metaEl.textContent = '已显示缓存 ' + cachedN + ' 条 · 后台刷新中…';
      }
      let r = null;
      try {
        r = await api.searchAll(usedQ, { fromTs: win.from });
      } catch (e) {
        r = { ok: false, why: (e && e.message) || String(e) };
      }
      if (mine !== seq) return;               // 输入已变，丢弃旧结果
      finalR = r;
      const n = (r && r.ok && Array.isArray(r.results))
        ? r.results.reduce((s, g) => s + ((g.items || []).length), 0) : 0;
      if (n > 0 || i === plan.length - 1) break;
    }
    streamActive = false;
    streamDone = new Set();
    cachePreview = false;
    if (finalR && finalR.ok) { filterAcct = 'all'; filterKind = 'all'; }   // 新搜索重置筛选
    if (!finalR || !finalR.ok) {
      resEl.innerHTML = '<div class="search-empty">搜索失败：' + esc((finalR && finalR.why) || '未知错误') + '</div>';
      metaEl.textContent = '';
      return;
    }
    lastPayload = finalR;
    lastMs = Date.now() - streamT0;
    lastCacheWritten = (finalR.cache && typeof finalR.cache.written === 'number') ? finalR.cache.written : null;
    lastCacheAdded = (finalR.cache && typeof finalR.cache.added === 'number') ? finalR.cache.added : null;
    // 搜完刷新提示里的「已存 N 条」——缓存是这次搜完才写盘的，不刷新会一直显示旧数字
    if (cacheEnabled && api.searchCacheGet) {
      api.searchCacheGet().then((d) => updateCacheHint(d && d.stats)).catch(() => {});
    }
    flushStreamRender();
    renderFilters(finalR);
    render(finalR, usedQ, lastMs);
    applyCacheStatus(false);
    if (usedQ !== raw) {
      const note = '已按「' + usedQ + '」搜索';
      metaEl.textContent = metaEl.textContent ? metaEl.textContent + ' · ' + note : note;
    }
  }

  // 跳转失败的 why 说人话，别直接甩 item-gone 这种词
  const JUMP_WHY = {
    'item-gone': '那条结果已经不在了，重新加载再试',
    'no-expand': '「查看全部」没展开，重新加载再试',
    'no-item': '没搜到结果，重新加载再试',
    'no-entry': '豆包页面没准备好，等一下再试',
    'no-input': '豆包搜索框没出来，等一下再试',
    'no-view': '这个账号的页面还没就绪',
    'switch-failed': '切不到这个账号',
    'no-account': '账号已经不存在了'
  };

  async function jump(accountId, index, via, sig, time) {
    if (!accountId || !(lastSearchKw || lastKw)) return;
    const kw = lastSearchKw || lastKw;
    // 先关面板：切号在主进程做，面板留着会挡住切过去的页面
    close();
    toast('正在跳转…');
    let r = null;
    try {
      // sig 是按内容找人的依据（下标会漂，内容不会），主进程优先用它；
      // time 用于同标题多条消息时缩小范围
      r = await api.searchJump({
        accountId: accountId, keyword: kw, index: index, via: via || 'all',
        sig: sig || '', time: time || ''
      });
    } catch (e) {
      r = { ok: false, why: (e && e.message) || String(e) };
    }
    // 连续点结果时，旧跳转会被新请求取代；旧请求别弹「跳转失败」干扰用户。
    if (r && r.ok === false && r.why === 'superseded') return;
    if (r && r.ok) {
      const j = r.jump || {};
      // landed=false 表示点了但既没换页面、豆包也没自己收面板 —— 别假装成功
      if (j.landed === false) toast('点了但页面没反应，再点一次试试');
      else if (sig && j.by === 'index') toast('位置对不上，只能按顺序跳，可能不是这条');
      else toast('已跳转到该会话');
    } else {
      const why = (r && r.why) || '未知错误';
      toast('跳转失败：' + (JUMP_WHY[why] || why));
    }
  }

  input.addEventListener('input', () => {
    const kw = input.value.trim();
    clearBtn.hidden = !kw;
    if (reloadBtn) reloadBtn.hidden = !kw;
    clearTimeout(timer);
    if (!kw) {
      metaEl.textContent = '';
      resEl.innerHTML = '<div class="search-empty">输入关键词，自动搜索所有账号<br>点结果可直接跳到那条消息</div>';
      return;
    }
    timer = setTimeout(() => run(kw), 320);   // 打字防抖
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  clearBtn.onclick = () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  };

  // 重新加载：拿同一个关键词再搜一遍。
  // 豆包的结果是分批回来的，偶尔只回来一部分、或者某几个账号没读出来，
  // 给个手动补一刀的入口，比让用户删字重打省事。
  let reloading = false;
  async function reload() {
    // 优先用输入框里现在的词：防抖还没跑完时 lastKw 还是上一轮的
    const kw = input.value.trim() || lastKw;
    if (!kw || reloading) return;
    reloading = true;
    if (reloadBtn) { reloadBtn.classList.add('loading'); reloadBtn.disabled = true; }
    try {
      await run(kw);
    } finally {
      reloading = false;
      if (reloadBtn) { reloadBtn.classList.remove('loading'); reloadBtn.disabled = false; }
    }
  }
  if (reloadBtn) reloadBtn.onclick = reload;
  closeBtn.onclick = close;
  if (entry) entry.onclick = open;

  // 搜索一开始就把所有账号的分组预建出来，谁先搜完谁先涨，
  // 不会出现「只显示一个账号、另一个过一会才冒出来」。
  if (api.onSearchStart) api.onSearchStart((d) => {
    if (!d || !streamActive || d.keyword !== lastSearchKw) return;
    const accs = d.accounts || [];
    if (!lastPayload) lastPayload = { ok: true, total: d.total || accs.length, results: [] };
    for (const a of accs) {
      if (!lastPayload.results.some((x) => x.accountId === a.accountId)) {
        lastPayload.results.push({
          accountId: a.accountId, label: a.label, color: a.color,
          ok: true, why: '', items: [], deep: null
        });
      }
    }
    renderFilters(lastPayload);
    render(lastPayload, lastSearchKw || lastKw, 0);
    metaEl.textContent = cachePreview ? '缓存已显示 · 后台刷新中…' : '正在搜索 ' + accs.length + ' 个账号…';
  });

  // 缓存先行：主进程在实时搜索前先把「这个词」的缓存推下来，先上屏（标「缓存」），
  // 实时结果随后边搜边覆盖/补充。重复搜同一个词时一打开就有内容，不用干等实时。
  if (api.onSearchCached) api.onSearchCached((d) => {
    if (!d || !streamActive || d.keyword !== lastSearchKw) return;
    const accs = d.accounts || [];
    if (!lastPayload) lastPayload = { ok: true, total: accs.length, results: [] };
    let n = 0;
    for (const a of accs) {
      cacheSeed.set(a.accountId, a.items || []);
      let g = (lastPayload.results || []).find((x) => x.accountId === a.accountId);
      if (!g) {
        g = { accountId: a.accountId, label: a.label, color: a.color, ok: true, why: '', items: [], deep: null };
        lastPayload.results.push(g);
      }
      // 已经有的（实时先到了）不动，只补没见过的缓存条目，避免把实时结果盖掉
      const prior = g.items || [];
      const priorSigs = new Set(prior.map((x) => x.sig));
      const add = (a.items || []).filter((x) => x.sig && !priorSigs.has(x.sig));
      g.items = prior.concat(add);
      n += add.length;
    }
    if (!n) return;
    flushStreamRender();
    renderFilters(lastPayload);
    render(lastPayload, lastSearchKw || lastKw, 0);
    metaEl.textContent = '先显示缓存 ' + n + ' 条 · 正在实时搜索…';
    applyCacheStatus(true, 0, accs.length);
  });

  if (api.onSearchProgress) api.onSearchProgress((d) => {
    if (!d || !d.total) return;
    if (d.done >= d.total) return;             // 完成时由 render 显示汇总
    metaEl.textContent = '正在搜索 ' + d.done + '/' + d.total + ' 个账号…';
  });

  // 边搜边显示：主进程每完成一个阶段就推一批，这里合并进 lastPayload 立刻重绘。
  // 不预判「加载完了没」——数字还在涨就说明还在搜；全部账号 done 后由 run() 收尾。
  if (api.onSearchPartial) api.onSearchPartial((d) => {
    if (!d || !streamActive || d.keyword !== lastSearchKw) return;   // 旧搜索的回灌不要
    if (!lastPayload) lastPayload = { ok: true, total: d.total || 0, results: [] };
    let g = (lastPayload.results || []).find((x) => x.accountId === d.accountId);
    if (!g) {
      g = { accountId: d.accountId, label: d.label, color: d.color, ok: true, why: '', items: [], deep: null };
      lastPayload.results.push(g);
      // 顺序无所谓：run() 结束时主进程会推回按账号顺序排好的完整结果
    }
    // 实时结果永远优先；这次实时还没返回的，用预读缓存补上（标「缓存」），
    // 免得刚上屏的缓存条目在第一批实时结果到达时整块消失。
    const live = d.items || [];
    const seed = cacheSeed.get(d.accountId) || [];
    const liveSigs = new Set(live.map((x) => x.sig));
    g.items = live.concat(seed.filter((x) => x.sig && !liveSigs.has(x.sig)));
    g.ok = d.ok;
    g.why = d.why || '';
    g.deep = { exhausted: !!d.exhausted, capped: !!d.capped };
    if (d.done) streamDone.add(d.accountId);
    else streamDone.delete(d.accountId);

    // 流式重绘节流到 250ms 一次；meta 每批都更新，保持「还在涨」的实时感
    scheduleStreamRender();
    if (streamDone.size < (d.total || 0)) {
      const n = lastPayload.results.reduce((s, x) => s + (x.items || []).length, 0);
      metaEl.textContent = '搜索中… 已到 ' + n + ' 条' +
        (d.stage >= 3 ? ' · 继续翻页' : '') +
        ' · ' + streamDone.size + '/' + (d.total || 0) + ' 个账号完成';
    }
    streamMetaText = metaEl.textContent;
    applyCacheStatus(true, streamDone.size, d.total);
  });

  // 高亮是跳转之后异步补的，结果回来再补一句实话：
  // 「已定位到关键词」或者「首屏没找到」—— 后者比笼统的「已跳转」有用
  if (api.onSearchHighlight) api.onSearchHighlight((d) => {
    if (!d || lastSearchKw !== d.keyword) return;    // 已经换词了，别乱弹
    if (d.ok) toast(d.exact ? '已定位到那条消息' : '已定位到关键词');
    else toast('已打开会话，但首屏没找到「' + d.keyword + '」，往上翻翻');
  });

  window.addEventListener('keydown', (e) => {
    if (!mask.hidden) return;
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      open();
    }
  });
})();


// ============ 更新日志（只记新增 / 优化 / 修复）============
const CHANGELOG = [
  {
    v: '4.2.7',
    items: [
      ['new', '聚合搜索本地缓存（默认关闭，搜索页可开）：重搜同一个词先显示缓存，只把新消息实时补进来，历史消息不重复加载'],
      ['new', '搜索页加「最近搜索」（点词重搜、× 删除）、缓存完成度进度条，以及「本次写入缓存 N 条（新增 M）」提示'],
      ['new', '深挖/缓存自动扩容：大词（如「视频」「1」）不再卡在固定页数，缓存也不再卡单账号 500 条'],
      ['imp', '流式搜索结果渲染改为 250ms 合并 + 按内容去重，条数与缓存口径一致；筛选项计数同步去重'],
      ['imp', '搜索缓存文件瘦身约 50%（不存冗余签名、不复制备份），账号保活改为并发探测'],
      ['fix', '换词搜索偶尔读到上一个词的结果（stage1 读取、stage2 单类视图复用两处）'],
      ['fix', '搜索有时把有结果误报成 0 条（空结果强制重开再搜 + 主进程补搜）'],
      ['fix', '缓存条数显示口径（当前词缓存数 / 本次写入 / 新增）'],
      ['fix', '发版打包清单漏 search-cache.js，更新后会起不来（打包脚本 + 回归测试）'],
      ['new', '顶部菜单「帮助」后面新增「反馈」：邮箱 jianbingdev@163.com / GitHub Issues']
    ]
  },
  {
    v: '4.2.6',
    items: [
      ['fix', '4.2.5 的自动更新有问题（更新完成后不会自动重启、会弹「Windows 找不到文件」），本版为覆盖修复包；已装 4.2.5 的用户更新时若仍弹出提示，手动双击主程序即可，之后恢复正常'],
      ['new', '帮助菜单可打开当前账号的控制台（Ctrl+Shift+F12），方便排查豆包页面'],
      ['new', '设置里可开启「下载改名」，提供 5 种命名格式 + 自定义模板和实时预览（默认关闭，不写入任何清单文件）'],
      ['imp', '账号和设置的配置文件改成原子写入：写临时文件→备份旧版→原子替换，读取失败时优先从备份恢复，坏文件另存 .corrupt 留证'],
      ['imp', '弹窗改成集合管理，同时开着多个弹窗时关掉其中一个不会再让账号视图跳出来'],
      ['imp', '批量发送的账号间隔等待可中断，点停止立即响应（原来要等完当前间隔）'],
      ['fix', '开发版/正式版的版本标签改由 app.isPackaged 运行时判断，不再手写版本字符串（4.2.4 就是漏改这行把「开发版v4.2.4」发出去的）'],
      ['fix', 'README 里写的默认下载目录与代码不一致（实际是系统「下载」文件夹）'],
      ['fix', 'package.json 补上 engines.node >=22.12.0，与依赖实际要求一致']
    ]
  },
  {
    v: '4.2.5',
    items: [
      ['new', '帮助菜单可打开当前账号的控制台（Ctrl+Shift+F12），方便排查豆包页面'],
      ['new', '设置里可开启「下载改名」，提供 5 种命名格式 + 自定义模板和实时预览（默认关闭，不写入任何清单文件）'],
      ['imp', '账号和设置的配置文件改成原子写入：写临时文件→备份旧版→原子替换，读取失败时优先从备份恢复，坏文件另存 .corrupt 留证'],
      ['imp', '弹窗改成集合管理，同时开着多个弹窗时关掉其中一个不会再让账号视图跳出来'],
      ['imp', '批量发送的账号间隔等待可中断，点停止立即响应（原来要等完当前间隔）'],
      ['fix', '开发版/正式版的版本标签改由 app.isPackaged 运行时判断，不再手写版本字符串（4.2.4 就是漏改这行把「开发版v4.2.4」发出去的）'],
      ['fix', 'README 里写的默认下载目录与代码不一致（实际是系统「下载」文件夹）'],
      ['fix', 'package.json 补上 engines.node >=22.12.0，与依赖实际要求一致']
    ]
  },
  {
    v: '4.2.4',
    items: [
      ['new', '批量发送：同一段话（可带图）一次发给多个账号，可设间隔、可中途停止'],
      ['new', '生成视频页：画面比例、时长滑轨（4-30 秒）、清晰度，发送时自动拼成「生成视频：xxx / 9:16，15s，720p」'],
      ['new', '图片可以直接拖进窗口；缩略图可拖动调整发送顺序，最多 10 张（豆包上限）'],
      ['new', '检测账号：新建对话并发一句「你好豆包」，用来发现账号是否要输验证码'],
      ['new', '账号右键菜单：刷新页面 / 刷新账号 / 删除账号（删除有二次确认）'],
      ['new', '帮助 → 更新日志，能看 4.0 以来每版改了什么'],
      ['imp', '生成状态轮询按需降频（空闲 700ms → 4 秒），并去掉每 800ms 一次的图片位置兜底扫描'],
      ['imp', '新增内存回收：超过 3GB 自动清缓存，也可以从帮助菜单手动清'],
      ['imp', '批量发送弹窗加宽到 520，一屏放得下不用滚'],
      ['fix', '切换账号后右侧空白（视图挂载漏了 setVisible）'],
      ['fix', '拖动缩略图排序失效（拖文件监听把事件吃掉了）']
    ]
  },
  {
    v: '4.2.3',
    items: [
      ['new', '自己粘贴进豆包的图也能被勾选复制'],
      ['fix', '发一次消息后复选框集体消失、必须重启软件才恢复']
    ]
  },
  {
    v: '4.2.2',
    items: [
      ['new', '图片多选复制：鼠标移到图片上出现复选框，勾选多张后 Ctrl+C 一次复制所有原图'],
      ['new', '批量下载：勾选后一次下到「图片-时间戳」文件夹'],
      ['imp', '复选框常驻半透明显示，懒加载的图加载完会自动补上，小图（30px 以上）也能选'],
      ['fix', '豆包页面的图片变成灰色方块']
    ]
  },
  {
    v: '4.2.1',
    items: [
      ['new', '更新包后台下载：下载中可以关掉弹窗继续用，进度显示在左侧版本徽标上'],
      ['imp', '下载完成的提示从右下角挪到左侧栏（原来被账号页面盖住看不到）'],
      ['imp', '更新弹窗、设置弹窗只能点右上角 × 关闭，避免误关'],
      ['fix', '下载中再点「检查更新」会误报「已经是最新版本」'],
      ['fix', '下载失败时没释放文件句柄，重试会失败']
    ]
  },
  {
    v: '4.2',
    items: [
      ['new', '下载位置可设置（自定义路径 / 系统下载文件夹 / 桌面三级回退）'],
      ['new', '「关闭即退出」选项，勾上后点 × 直接退出而不是最小化到托盘'],
      ['imp', '删掉侧栏和关于页里的技术文案'],
      ['fix', 'Esc 关不掉设置弹窗'],
      ['fix', '自定义下载路径无效时下载直接失败']
    ]
  },
  {
    v: '4.1.2',
    items: [
      ['imp', '更新源只填网址就行，自动补 /latest.json']
    ]
  },
  {
    v: '4.1.1',
    items: [
      ['new', '「关于」里加了开源地址按钮']
    ]
  },
  {
    v: '4.1',
    items: [
      ['new', '增量更新：只下载几百 KB 的核心包，不再每次拉 143 MB'],
      ['fix', '弹窗被账号页面盖住']
    ]
  },
  {
    v: '4.0',
    items: [
      ['new', '自动更新：侧栏版本徽标、检查更新、下载进度、重启替换']
    ]
  }
];

(function initChangelog() {
  const mask = document.getElementById('logMask');
  if (!mask) return;
  const body = document.getElementById('logBody');
  const closeBtn = document.getElementById('logClose');
  const TAG = { new: ['新增', 'new'], imp: ['优化', 'imp'], fix: ['修复', 'fix'] };

  function render() {
    body.innerHTML = CHANGELOG.map((sec) => {
      const rows = sec.items.map(([kind, text]) => {
        const [label, cls] = TAG[kind] || ['', ''];
        return '<div class="log-item"><span class="log-tag ' + cls + '">' + label + '</span><span>' + text + '</span></div>';
      }).join('');
      return '<div class="log-sec"><p class="log-ver-title">v' + sec.v + '</p>' + rows + '</div>';
    }).join('');
  }

  function open() {
    render();
    mask.hidden = false;
    raiseMask(mask);
    // 内容刚插进 DOM，浏览器还没算完布局，这时设 scrollTop 会被忽略，
    // 放到下一帧再滚到顶部才生效
    requestAnimationFrame(() => { body.scrollTop = 0; });
    mask.focus();
    try { api.uiModal(true, 'log'); } catch (e) {}
  }

  function close() {
    mask.hidden = true;
    try { api.uiModal(false, 'log'); } catch (e) {}
  }

  closeBtn.addEventListener('click', close);
  if (api.onMenuChangelog) api.onMenuChangelog(open);
  window.__openChangelog = open;
})();

// 手动回收入口（调试用，也可以在控制台调 window.__reclaim()）
window.__reclaim = async () => {
  try {
    const r = await api.appReclaim();
    toast('已清理 ' + ((r && r.sessions) || 0) + ' 个账号的缓存');
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
};

// 主进程推来的 toast（刷新页面/刷新账号完成等）
if (api.onToast) {
  api.onToast((msg) => { try { toast(String(msg || '')); } catch (e) {} });
}

// 主进程侧删了账号（右键菜单删除）后，主动刷一次侧栏
if (api.onAccountsChanged) {
  api.onAccountsChanged(() => { try { refresh(); } catch (e) {} });
}

window.addEventListener('keydown', (e) => {
  if (updMask.hidden || !setMask.hidden) return;
  if (e.key === 'Enter' && !updAction.disabled) { e.preventDefault(); updAction.click(); }
});

updSource.onclick = () => {
  updSrcBox.hidden = !updSrcBox.hidden;
  if (!updSrcBox.hidden) {
    updSrcInput.value = currentUpdateUrl;
    updSrcInput.focus();
  }
};
updSrcSave.onclick = async () => {
  try {
    const r = await window.api.updateSetSource(updSrcInput.value);
    currentUpdateUrl = (r && r.updateUrl) || '';
    updSrcBox.hidden = true;
    const eff = (r && r.effectiveUrl) || '';
    toast(eff ? ('更新源已保存 → ' + eff) : '更新源已保存，正在重新检查…');
    runCheck();
  } catch (e) {
    updMsg('保存更新源失败：' + ((e && e.message) ? e.message : String(e)), true);
  }
};

window.api.onUpdateProgress((d) => {
  if (!d || d.phase !== 'download') return;
  updProgress(d.percent);
  updMsg('正在下载 ' + d.percent + '%　' + d.gotText + ' / ' + (d.totalText || '未知大小'));
  updBadgeProgress(d.percent);
});

window.api.onMenuCheckUpdate(() => openUpdateModal());

// 版本号与更新源
(async () => {
  try {
    const info = await window.api.appInfo();
    appVersion = (info && info.version) || '';
    appVersionLabel = (info && info.versionLabel) || (appVersion ? 'v' + appVersion : '');
    currentUpdateUrl = (info && info.updateUrl) || '';
    if (appVersionLabel) badgeVersion();
  } catch (e) {}
})();

refresh();

// ============ 批量发送（同一段话发到多个账号）============
// 说明：豆包输入框是 ProseMirror，靠焦点判断是否处理 paste。
// 后台视图注入会被吞掉，所以主进程是一个接一个切到前台再注入的，
// 界面上会看到账号轮流切换，这是正常的。
(function initBroadcast() {
  const mask = document.getElementById('bcMask');
  if (!mask) return;
  const listEl = document.getElementById('bcList');
  const countEl = document.getElementById('bcCount');
  const allBtn = document.getElementById('bcAll');
  const noneBtn = document.getElementById('bcNone');
  const textEl = document.getElementById('bcText');
  const gapEl = document.getElementById('bcGap');
  const startBtn = document.getElementById('bcStart');
  const stopBtn = document.getElementById('bcStop');
  const closeBtn = document.getElementById('bcClose');
  const warnEl = document.getElementById('bcWarn');
  const progEl = document.getElementById('bcProg');
  let running = false;
  const MAX_IMGS = 10;   // 豆包一次最多支持 10 张图
  let pickedImages = [];
  let pickedThumbs = [];
  let dragFrom = null;

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // 列表是两列卡片：勾选时同步高亮 + 顶部「已选 N / 共 M」
  function syncItemState() {
    if (!listEl) return;
    const boxes = listEl.querySelectorAll('input[type="checkbox"]');
    let checked = 0;
    for (const b of boxes) {
      const lab = b.closest('.bc-item');
      if (lab) lab.classList.toggle('on', b.checked);
      if (b.checked) checked++;
    }
    if (countEl) countEl.textContent = '已选 ' + checked + ' / 共 ' + boxes.length;
    if (allBtn) allBtn.disabled = boxes.length === 0;
    if (noneBtn) noneBtn.disabled = boxes.length === 0;
  }
  // 委托绑定：列表内容每次 open 都会重渲染，绑容器就不用重复绑
  listEl.addEventListener('change', syncItemState);
  if (allBtn) allBtn.onclick = () => {
    listEl.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = true; });
    syncItemState();
  };
  if (noneBtn) noneBtn.onclick = () => {
    listEl.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = false; });
    syncItemState();
  };

  async function open() {
    if (running) return;
    warnEl.hidden = true;
    progEl.hidden = true;
    progEl.innerHTML = '';
    pickedImages = [];
    pickedThumbs = [];
    renderImgs();
    switchTab('send');
    startBtn.disabled = false;
    startBtn.textContent = '开始发送';
    stopBtn.hidden = true;
    stopBtn.disabled = false;
    try {
      const accounts = await api.accountsList();
      const usable = (accounts || []).filter((a) => !a.pending);
      listEl.innerHTML = usable.length
        ? usable.map((a) => '<label class="bc-item" title="' + esc(a.label) + '">'
            + '<input type="checkbox" value="' + esc(a.id) + '">'
            + '<span>' + esc(a.label) + '</span></label>').join('')
        : '<div class="bc-empty">没有已登录的账号</div>';
    } catch (e) {
      listEl.innerHTML = '<div class="bc-empty err">读取账号失败</div>';
    }
    syncItemState();
    mask.hidden = false;
    raiseMask(mask);
    mask.focus();
    try { api.uiModal(true, 'bc'); } catch (e) {}
  }

  function close() {
    if (running) return;   // 跑的时候不让关，避免误操作
    mask.hidden = true;
    try { api.uiModal(false, 'bc'); } catch (e) {}
  }

  const pickBtn = document.getElementById('bcPickImgs');
  const imgsEl = document.getElementById('bcImgs');

  const baseName = (p) => String(p).split(/[\\/]/).pop();

  function renderImgs() {
    if (!imgsEl) return;
    if (!pickedImages.length) {
      imgsEl.innerHTML = '<span class="bc-imgs-empty">未选图片</span>';
      return;
    }
    imgsEl.innerHTML = pickedImages
      .map((p, i) => {
        const t = pickedThumbs[i] || '';
        const inner = t
          ? '<img src="' + t + '" alt="">'
          : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:.35">?</div>';
        return '<div class="bc-img" draggable="true" data-idx="' + i + '" title="' + esc(baseName(p)) + '">'
          + inner
          + '<span class="bc-img-no">图' + (i + 1) + '</span>'
          + '<span class="bc-img-del" data-del="' + i + '" title="移除">×</span>'
          + '</div>';
      })
      .join('');
  }

  // 拖动排序：只在 drop 时才重排数组，拖拽过程中不动 DOM
  // （中途重建 DOM 会把正在拖的元素销毁，drag 直接中断）
  if (imgsEl) {
    imgsEl.addEventListener('dragstart', (e) => {
      const el = e.target.closest('.bc-img');
      if (!el || running) { e.preventDefault(); return; }
      dragFrom = Number(el.dataset.idx);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) {}
    });
    imgsEl.addEventListener('dragend', (e) => {
      const el = e.target.closest('.bc-img');
      if (el) el.classList.remove('dragging');
      dragFrom = null;
    });
    imgsEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
    });
    imgsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const el = e.target.closest('.bc-img');
      if (!el || dragFrom === null) return;
      const to = Number(el.dataset.idx);
      if (Number.isNaN(to) || to === dragFrom) { dragFrom = null; return; }
      const movedP = pickedImages.splice(dragFrom, 1)[0];
      pickedImages.splice(to, 0, movedP);
      const movedT = pickedThumbs.splice(dragFrom, 1)[0];
      pickedThumbs.splice(to, 0, movedT === undefined ? '' : movedT);
      dragFrom = null;
      renderImgs();
    });
    imgsEl.addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (!d || running) return;
      const i = Number(d.dataset.del);
      pickedImages.splice(i, 1);
      pickedThumbs.splice(i, 1);
      renderImgs();
    });
  }

  if (pickBtn) {
    pickBtn.addEventListener('click', async () => {
      if (running) return;
      try {
        const r = await api.broadcastPickImages();
        if (r && r.ok && r.paths) {
          let paths = r.paths.slice();
          let thumbs = (r.thumbs || []).slice();
          if (paths.length > MAX_IMGS) {
            paths = paths.slice(0, MAX_IMGS);
            thumbs = thumbs.slice(0, MAX_IMGS);
            warnEl.textContent = '豆包一次只能上传 10 张图片，多余的已忽略';
            warnEl.hidden = false;
          } else {
            warnEl.hidden = true;
          }
          pickedImages = paths;
          pickedThumbs = thumbs;
          renderImgs();
        }
      } catch (e) {
        warnEl.textContent = '选图失败: ' + e.message;
        warnEl.hidden = false;
      }
    });
  }

  // ---------- 页签 + 视频参数 ----------
  const RATIOS = ['自动', '3:4', '4:3', '9:16', '16:9', '1:1', '21:9'];
  const RESOS = ['720p', '1080p'];
  let curTab = 'send';
  let curRatio = '9:16';
  let curReso = '720p';

  const sendOpts = document.getElementById('bcSendOpts');
  const videoOpts = document.getElementById('bcVideoOpts');
  const ratiosEl = document.getElementById('bcRatios');
  const resosEl = document.getElementById('bcResos');
  const durEl = document.getElementById('bcDur');
  const durValEl = document.getElementById('bcDurVal');
  const previewEl = document.getElementById('bcPreview');
  const textLabelEl = document.getElementById('bcTextLabel');
  const quickVideoBtn = document.getElementById('bcQuickVideo');

  function renderRatios() {
    if (!ratiosEl) return;
    ratiosEl.innerHTML = RATIOS.map(
      (r) => '<div class="bc-ratio' + (r === curRatio ? ' on' : '') + '" data-r="' + r + '">' + r + '</div>',
    ).join('');
  }

  function renderResos() {
    if (!resosEl) return;
    resosEl.innerHTML = RESOS.map(
      (r) => '<div class="bc-reso' + (r === curReso ? ' on' : '') + '" data-r="' + r + '">' + r + '</div>',
    ).join('');
  }

  // 结尾那串：比例，秒数，清晰度（都用当前选择的值）
  function videoSuffix() {
    const d = durEl ? Number(durEl.value) || 15 : 15;
    return curRatio + '，' + d + 's，' + curReso;
  }

  function updatePreview() {
    if (!previewEl) return;
    const pvBody = document.getElementById('bcPvBody');
    const pvTail = document.getElementById('bcPvTail');
    const raw = (textEl.value || '').trim();
    if (pvBody) pvBody.textContent = raw || '（这里是你输入的提示词）';
    if (pvTail) pvTail.textContent = videoSuffix();
  }

  function switchTab(t) {
    curTab = t;
    document.querySelectorAll('.bc-tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    if (sendOpts) sendOpts.hidden = t !== 'send';
    if (videoOpts) videoOpts.hidden = t !== 'video';
    if (quickVideoBtn) quickVideoBtn.hidden = t !== 'video';   // 这个按钮只在视频页
    if (textLabelEl) textLabelEl.textContent = t === 'video' ? '视频提示词' : '发送内容';
    if (t === 'video') updatePreview();
  }

  document.querySelectorAll('.bc-tab').forEach((b) => {
    b.addEventListener('click', () => { if (!running) switchTab(b.dataset.tab); });
  });
  if (ratiosEl) {
    ratiosEl.addEventListener('click', (e) => {
      const d = e.target.closest('[data-r]');
      if (!d) return;
      curRatio = d.dataset.r;
      renderRatios();
      updatePreview();
    });
  }
  if (resosEl) {
    resosEl.addEventListener('click', (e) => {
      const d = e.target.closest('[data-r]');
      if (!d) return;
      curReso = d.dataset.r;
      renderResos();
      updatePreview();
    });
  }
  if (durEl) {
    durEl.addEventListener('input', () => {
      if (durValEl) durValEl.textContent = durEl.value + 's';
      updatePreview();
    });
  }
  if (textEl) {
    textEl.addEventListener('input', () => { if (curTab === 'video') updatePreview(); });
  }
  // 拖进来的图片（preload 拿到真实路径后 postMessage 过来）
  async function addDroppedFiles(paths) {
    const imgs = (paths || []).filter((p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
    if (!imgs.length) {
      warnEl.textContent = '拖进来的不是图片文件';
      warnEl.hidden = false;
      return;
    }
    warnEl.hidden = true;
    let r = null;
    try {
      r = await api.broadcastThumbnails(imgs);
    } catch (e) {
      r = null;
    }
    const list = (r && r.ok && r.paths) ? r.paths : imgs;
    const thumbs = (r && r.thumbs) || [];
    let skipped = 0;
    for (let i = 0; i < list.length; i++) {
      if (pickedImages.indexOf(list[i]) !== -1) continue;   // 已经在列表里的不重复加
      if (pickedImages.length >= MAX_IMGS) { skipped++; continue; }
      pickedImages.push(list[i]);
      pickedThumbs.push(thumbs[i] || '');
    }
    if (skipped > 0) {
      warnEl.textContent = '豆包一次只能上传 10 张图片，多余的 ' + skipped + ' 张已忽略';
      warnEl.hidden = false;
    }
    renderImgs();
  }

  window.addEventListener('message', (ev) => {
    let d = ev && ev.data;
    if (!d) return;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { return; }
    if (d && d.__bcDropFiles) addDroppedFiles(d.__bcDropFiles);
  });

  renderRatios();
  renderResos();

  // 检测账号：新建对话 + 发「你好豆包」，用来暴露"是否要输验证码"
  const detectBtn = document.getElementById('bcDetect');
  if (detectBtn) {
    detectBtn.addEventListener('click', async () => {
      if (running) return;
      const ids = [...listEl.querySelectorAll('input:checked')].map((i) => i.value);
      if (!ids.length) { warnEl.textContent = '请至少选一个账号'; warnEl.hidden = false; return; }
      warnEl.hidden = true;
      const gapSec = Math.max(2, Math.min(60, Number(gapEl.value) || 4));
      running = true;
      startBtn.disabled = true;
      detectBtn.disabled = true;
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      progEl.hidden = false;
      progEl.innerHTML = '';
      let r = null;
      try {
        r = await api.accountsDetect(ids, gapSec * 1000);
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      running = false;
      startBtn.disabled = false;
      detectBtn.disabled = false;
      stopBtn.hidden = true;
      if (!r || !r.ok) {
        warnEl.textContent = (r && r.error) || '检测失败';
        warnEl.hidden = false;
      }
    });
  }

  startBtn.addEventListener('click', async () => {
    if (running) return;
    const ids = [...listEl.querySelectorAll('input:checked')].map((i) => i.value);
    const rawText = textEl.value.trim();
    // 视频页：开头固定「生成视频：」，结尾按当前选择拼「比例，秒数，清晰度」
    const text = curTab === 'video'
      ? ('生成视频：' + rawText + '\n' + videoSuffix())
      : rawText;
    if (!ids.length) { warnEl.textContent = '请至少选一个账号'; warnEl.hidden = false; return; }
    if (!rawText && !pickedImages.length) { warnEl.textContent = '内容和图片都是空的'; warnEl.hidden = false; return; }
    warnEl.hidden = true;

    const gapSec = Math.max(3, Math.min(60, Number(gapEl.value) || 6));
    gapEl.value = gapSec;

    running = true;
    startBtn.disabled = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    progEl.hidden = false;
    progEl.innerHTML = '';

    let r = null;
    try {
      r = await api.accountsBroadcast(ids, text, gapSec * 1000, pickedImages.slice());
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    running = false;
    startBtn.disabled = false;
    stopBtn.hidden = true;
    if (!r || !r.ok) {
      warnEl.textContent = (r && r.error) || '发送失败';
      warnEl.hidden = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try { await api.accountsBroadcastAbort(); } catch (e) {}
  });
  // 「确定生成视频」是回复豆包的确认，发纯文本，不拼比例/时长，也不带图
  if (quickVideoBtn) {
    quickVideoBtn.addEventListener('click', async () => {
      if (running) return;
      const ids = [...listEl.querySelectorAll('input:checked')].map((i) => i.value);
      if (!ids.length) { warnEl.textContent = '请至少选一个账号'; warnEl.hidden = false; return; }
      warnEl.hidden = true;
      const gapSec = Math.max(3, Math.min(60, Number(gapEl.value) || 6));
      running = true;
      startBtn.disabled = true;
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      progEl.hidden = false;
      progEl.innerHTML = '';
      let r = null;
      try {
        r = await api.accountsBroadcast(ids, '确定生成视频', gapSec * 1000, []);
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      running = false;
      startBtn.disabled = false;
      stopBtn.hidden = true;
      if (!r || !r.ok) {
        warnEl.textContent = (r && r.error) || '发送失败';
        warnEl.hidden = false;
      }
    });
  }
  closeBtn.addEventListener('click', close);
  // 故意不绑遮罩点击：和设置弹窗保持一致，避免手滑点空白处把正在填的内容弄丢

  if (api.onBroadcastProgress) {
    api.onBroadcastProgress((d) => {
      if (!d) return;
      const line = document.createElement('div');
      if (d.phase === 'switching') {
        line.className = 'cur';
        line.textContent = '[' + (d.index + 1) + '/' + d.total + '] ' + d.label + ' — 正在切换…';
      } else {
        line.className = d.ok ? 'ok' : 'fail';
        line.textContent = '[' + (d.index + 1) + '/' + d.total + '] ' + d.label + ' — ' + (d.ok ? '已发送' : '失败：' + d.err);
      }
      progEl.appendChild(line);
      progEl.scrollTop = progEl.scrollHeight;
    });
  }

  // 调试入口：不经过系统选图框也能塞图进来（排查排序/样式用）
  window.__bcDebug = {
    setImages(paths, thumbs) {
      pickedImages = (paths || []).slice();
      pickedThumbs = (thumbs || []).slice();
      renderImgs();
      return pickedImages.length;
    },
    state() {
      return { n: pickedImages.length, paths: pickedImages.slice() };
    }
  };

  if (api.onMenuBroadcast) api.onMenuBroadcast(open);
  window.__openBroadcast = open;   // 调试用
})();

