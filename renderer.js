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

refresh();
