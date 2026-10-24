// 渲染进程: 侧栏账号列表 + 状态徽标 + 双击就地改名 + 偏好
const listEl = document.getElementById('accountList');
const btnAdd = document.getElementById('btnAdd');
const btnCheckAll = document.getElementById('btnCheckAll');
const mainTip = document.getElementById('mainTip');
const chkTray = document.getElementById('chkTray');
const toastWrap = document.getElementById('toastWrap');

let accounts = [];
let currentId = null;

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
    item.className = 'account-item' + (acc.id === currentId ? ' active' : '');
    item.dataset.badge = acc.badge || 'online';
    if (acc.busy) item.dataset.busy = '1';
    if (acc.done) item.dataset.done = '1';
    item.title = 'Ctrl+' + (idx + 1) + ' 可快速切换 · 双击名称改名' + (acc.done ? ' · 该账号对话已完成' : '');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = acc.color || '#4F86F7';

    const span = document.createElement('span');
    span.className = 'acc-name';
    span.textContent = (idx + 1) + '. ' + acc.label;
    span.title = '双击可就地编辑名称';
    span.ondblclick = (e) => {
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

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除此账号(含其全部本地数据)';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('删除账号「' + acc.label + '」?\n该账号的登录态与页面数据会一并清理。')) return;
      await window.api.accountsDelete(acc.id);
      if (currentId === acc.id) currentId = null;
      refresh();
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
    item.appendChild(del);
    item.onclick = () => {
      if (editing) return;
      if (currentId === acc.id) return; // 重复点同一个账号不重绘(双击改名的前提)
      selectAccount(acc.id);
    };
    listEl.appendChild(item);
  });
}

async function selectAccount(id) {
  currentId = id;
  await window.api.accountsSelect(id);
  mainTip.style.display = 'none';
  render();
}

btnAdd.onclick = async () => {
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
(async () => {
  const prefs = await window.api.prefsGet();
  chkTray.checked = prefs.closeToTray !== false;
})();
chkTray.onchange = async () => {
  await window.api.prefsSet({ closeToTray: chkTray.checked });
};
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
let currentUpdateUrl = '';
// idle | checking | none | ready | downloading | downloaded | applying
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
      if (/^#{1,3}\s+\S/.test(lines[i])) { end = i; break; }
    }
    lines = lines.slice(start + 1, end);
  }

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
function setAccountViewVisible(visible) {
  try {
    if (window.api && window.api.uiModal) window.api.uiModal(!visible);
  } catch (e) {}
}
function closeUpdateModal() {
  if (updPhase === 'downloading' || updPhase === 'applying') return; // 这两个阶段不许关
  updMask.hidden = true;
  setAccountViewVisible(true);
}
function openUpdateModal() {
  updMask.hidden = false;
  setAccountViewVisible(false);
  // 焦点原来可能停在账号页面里(键盘事件到不了这里), 抢回来
  try { updMask.focus({ preventScroll: true }); } catch (e) {}
  runCheck();
}

async function runCheck() {
  updPhase = 'checking';
  updCur.textContent = appVersion ? 'v' + appVersion : '—';
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

  updNew.textContent = 'v' + r.latest;
  if (!r.hasNew) {
    updPhase = 'none';
    updMsg('已经是最新版本。');
    updAction.disabled = false;
    updAction.textContent = '重新检查';
    btnUpdate.classList.remove('has-new');
    return;
  }

  btnUpdate.classList.add('has-new');
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
  try {
    const r = await window.api.updateDownload();
    updPhase = 'downloaded';
    updProgress(100);
    updMsg('下载完成（' + r.sizeText + '），点右侧按钮重启并更新。');
    updAction.textContent = '重启并更新';
    updAction.disabled = false;
  } catch (e) {
    updPhase = 'ready';
    updBarWrap.hidden = true;
    updMsg('下载失败：' + ((e && e.message) ? e.message : String(e)), true);
    updAction.textContent = '重试下载';
    updAction.disabled = false;
  }
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
updClose.onclick = closeUpdateModal;
updMask.onclick = (e) => { if (e.target === updMask) closeUpdateModal(); };
// Esc 关闭 / Enter 走主按钮(立即更新·重启并更新)
// 挂在 window 上而不是弹窗上: 打开弹窗时焦点常常还在账号页面那边,
// 挂 mask 的话按键根本到不了这里。
window.addEventListener('keydown', (e) => {
  if (updMask.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeUpdateModal(); return; }
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
    toast('更新源已保存，正在重新检查…');
    runCheck();
  } catch (e) {
    updMsg('保存更新源失败：' + ((e && e.message) ? e.message : String(e)), true);
  }
};

window.api.onUpdateProgress((d) => {
  if (!d || d.phase !== 'download') return;
  updProgress(d.percent);
  updMsg('正在下载 ' + d.percent + '%　' + d.gotText + ' / ' + (d.totalText || '未知大小'));
});

window.api.onMenuCheckUpdate(() => openUpdateModal());

// 版本号与更新源
(async () => {
  try {
    const info = await window.api.appInfo();
    appVersion = (info && info.version) || '';
    currentUpdateUrl = (info && info.updateUrl) || '';
    if (appVersion) {
      btnUpdate.textContent = 'v' + appVersion;
      btnUpdate.title = '当前版本 v' + appVersion + '，点击检查更新';
    }
  } catch (e) {}
})();

refresh();
