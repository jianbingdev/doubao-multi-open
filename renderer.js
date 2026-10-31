// 渲染进程: 侧栏账号列表 + 状态徽标 + 双击就地改名 + 偏好
const listEl = document.getElementById('accountList');
const btnAdd = document.getElementById('btnAdd');
const btnCheckAll = document.getElementById('btnCheckAll');
const mainTip = document.getElementById('mainTip');
const chkTray = document.getElementById('chkTray'); // v4.2 起已挪到设置弹窗(setCloseExit)
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
  setAccountViewVisible(true);
}
function openUpdateModal() {
  updMask.hidden = false;
  setAccountViewVisible(false);
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
const setWarn = document.getElementById('setWarn');

// warnMsg 传了就在弹窗顶部显示红字(v4.2: 默认下载位置不可用时用)
async function openSettingsModal(warnMsg) {
  try {
    const [dir, prefs] = await Promise.all([window.api.getDownloadDir(), window.api.prefsGet()]);
    setDlPath.value = dir.dir || '';
    setDlPath.title = '当前：' + (dir.dir || '（不可用，请手动选择）');
    setDlPath.dataset.default = dir.defaultDir || '';
    // closeToTray === false 才表示"关闭即退出"
    setCloseExit.checked = prefs.closeToTray === false;
  } catch (e) {}
  setWarn.hidden = !warnMsg;
  setWarn.textContent = warnMsg || '';
  setMask.hidden = false;
  setAccountViewVisible(false);
  try { setMask.focus({ preventScroll: true }); } catch (e) {}
}

function closeSettingsModal() {
  setMask.hidden = true;
  setAccountViewVisible(true);
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
};

setSave.onclick = async () => {
  const val = String(setDlPath.value || '').trim();
  const def = setDlPath.dataset.default || '';
  // 选的正好是默认目录时存空值, 这样以后系统下载文件夹变了也能跟着走
  const toSave = (val === def) ? '' : val;
  try {
    await window.api.prefsSet({
      downloadDir: toSave,
      closeToTray: !setCloseExit.checked   // 勾了"直接退出" => closeToTray=false
    });
    closeSettingsModal();
    toast(toSave ? ('下载位置已保存：' + toSave) : '已恢复默认下载位置（系统「下载」文件夹）');
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
updClose.onclick = closeUpdateModal;
// 两个弹窗都只认右上角的 ×: 点弹窗外面、按 Esc 都不再关窗。
// 原来点外面一下就关, 更新弹窗里正在下载的进度说没就没, 误触代价太大。
// Enter 仍然走更新弹窗的主按钮(立即更新·重启并更新)。

// ============ 删除账号二次确认（HTML 弹窗，原生 dialog 改不了样式）============
(function initDeleteConfirm() {
  const mask = document.getElementById('delMask');
  if (!mask) return;
  const titleEl = document.getElementById('delTitle');
  const okBtn = document.getElementById('delOk');
  const cancelBtn = document.getElementById('delCancel');
  const closeBtn = document.getElementById('delClose');
  let pendingId = null;

  function close() {
    mask.hidden = true;
    pendingId = null;
    try { api.uiModal(false); } catch (e) {}
  }

  function open(id, label) {
    pendingId = id;
    titleEl.textContent = '删除账号「' + (label || id) + '」？';
    mask.hidden = false;
    mask.focus();
    try { api.uiModal(true); } catch (e) {}
  }

  okBtn.addEventListener('click', async () => {
    const id = pendingId;
    if (!id) return close();
    okBtn.disabled = true;
    try {
      await api.accountsDelete(id);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
    okBtn.disabled = false;
    if (currentId === id) currentId = null;
    close();
    try { refresh(); } catch (e) {}
  });

  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  if (api.onConfirmDelete) api.onConfirmDelete((d) => {
    if (d && d.id) open(d.id, d.label);
  });
})();


// ============ 更新日志（只记新增 / 优化 / 修复）============
const CHANGELOG = [
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
    // 内容刚插进 DOM，浏览器还没算完布局，这时设 scrollTop 会被忽略，
    // 放到下一帧再滚到顶部才生效
    requestAnimationFrame(() => { body.scrollTop = 0; });
    mask.focus();
    try { api.uiModal(true); } catch (e) {}
  }

  function close() {
    mask.hidden = true;
    try { api.uiModal(false); } catch (e) {}
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
        ? usable.map((a) => '<label class="bc-item"><input type="checkbox" value="' + esc(a.id) + '"><span>' + esc(a.label) + '</span></label>').join('')
        : '<div style="font-size:12px;opacity:.6;padding:4px">没有已登录的账号</div>';
    } catch (e) {
      listEl.innerHTML = '<div style="font-size:12px;color:#d33;padding:4px">读取账号失败</div>';
    }
    mask.hidden = false;
    mask.focus();
    try { api.uiModal(true); } catch (e) {}
  }

  function close() {
    if (running) return;   // 跑的时候不让关，避免误操作
    mask.hidden = true;
    try { api.uiModal(false); } catch (e) {}
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

