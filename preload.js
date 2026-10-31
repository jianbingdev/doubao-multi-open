// 预加载脚本: 暴露类型安全的 IPC 桥
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsAdd: () => ipcRenderer.invoke('accounts:add'),
  accountsRename: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
  accountsDelete: (id) => ipcRenderer.invoke('accounts:delete', id),
  accountsContextMenu: (id) => ipcRenderer.invoke('accounts:contextMenu', id),
  accountsSelect: (id) => ipcRenderer.invoke('accounts:select', id),
  accountsDetectName: (id) => ipcRenderer.invoke('accounts:detectName', id),
  accountsCheckAll: () => ipcRenderer.invoke('accounts:checkAll'),
  accountsCheckOne: (id) => ipcRenderer.invoke('accounts:checkOne', id),
  // 批量发送（把同一段话发到多个账号；主进程逐个切前台再注入）
  accountsBroadcast: (ids, text, gap, images) => ipcRenderer.invoke('accounts:broadcast', { ids, text, gap, images }),
  broadcastPickImages: () => ipcRenderer.invoke('broadcast:pickImages'),
  broadcastThumbnails: (paths) => ipcRenderer.invoke('broadcast:thumbnails', paths),
  accountsBroadcastAbort: () => ipcRenderer.invoke('accounts:broadcastAbort'),
  accountsDetect: (ids, gap) => ipcRenderer.invoke('accounts:detect', { ids, gap }),
  appReclaim: () => ipcRenderer.invoke('app:reclaim'),
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.invoke('prefs:set', patch),
  openDownloads: () => ipcRenderer.invoke('downloads:openFolder'),
  // 下载路径设置(v4.2)
  chooseDownloadDir: () => ipcRenderer.invoke('downloads:choose'),
  getDownloadDir: () => ipcRenderer.invoke('downloads:getDir'),

  // 自动更新(v3.0.15)
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  updateSetSource: (url) => ipcRenderer.invoke('update:setSource', url),
  // 弹窗开关: 让主进程临时隐藏账号视图, 否则原生 WebContentsView 会盖住界面弹窗
  uiModal: (open) => ipcRenderer.invoke('ui:modal', open),

  // 主进程推送
  onAccountReady: (cb) => ipcRenderer.on('account:ready', (e, d) => cb(d)),
  onAccountLogout: (cb) => ipcRenderer.on('account:logout', (e, d) => cb(d)),
  onLoginTimeout: (cb) => ipcRenderer.on('account:login-timeout', (e, d) => cb(d)),
  onBadgeUpdate: (cb) => ipcRenderer.on('badge:update', (e, d) => cb(d)),
  onActiveChanged: (cb) => ipcRenderer.on('active:changed', (e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (e, d) => cb(d)),
  onAccountDone: (cb) => ipcRenderer.on('account:done', (e, d) => cb(d)),
  onAccountBusy: (cb) => ipcRenderer.on('account:busy', (e, d) => cb(d)),
  onMenuAdd: (cb) => ipcRenderer.on('menu:addAccount', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, d) => cb(d)),
  onMenuCheckUpdate: (cb) => ipcRenderer.on('menu:checkUpdate', () => cb()),
  onMenuSettings: (cb) => ipcRenderer.on('menu:settings', () => cb()),
  onDownloadNoDir: (cb) => ipcRenderer.on('download:noDir', () => cb()),
  onBroadcastProgress: (cb) => ipcRenderer.on('broadcast:progress', (e, d) => cb(d)),
  onMenuBroadcast: (cb) => ipcRenderer.on('menu:broadcast', () => cb()),
  onAccountsChanged: (cb) => ipcRenderer.on('accounts:changed', () => cb()),
  onConfirmDelete: (cb) => ipcRenderer.on('accounts:confirmDelete', (e, d) => cb(d)),
  onToast: (cb) => ipcRenderer.on('toast', (e, msg) => cb(msg)),
  onMenuChangelog: (cb) => ipcRenderer.on('menu:changelog', () => cb())
});

// ---------- 拖文件进来（只有这里能拿到真实路径）----------
// File.path 在 Electron 32+ 已移除；webUtils.getPathForFile 又必须在同一个
// JS 上下文里调用（File 经 contextBridge 克隆后就查不到路径了）。
// preload 和页面共享 DOM，所以监听放在这里，拿到路径再 postMessage 给页面。
function bcDropZone(e) {
  const mask = document.getElementById('bcMask');
  if (!mask || mask.hidden) return null;
  if (!mask.contains(e.target)) return null;
  return mask;
}

document.addEventListener('dragover', (e) => {
  if (!bcDropZone(e)) return;
  // 只有从外面拖文件进来才接管；页面内部的拖动排序（拖缩略图换顺序）
  // dataTransfer 里没有 Files，必须放行，否则拖不动
  const types = (e.dataTransfer && e.dataTransfer.types) || [];
  if (!Array.from(types).includes('Files')) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
}, true);

document.addEventListener('drop', (e) => {
  if (!bcDropZone(e)) return;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  // 同上：内部拖动排序没有文件，直接放行给页面的 drop 处理
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  const paths = [];
  for (const f of files) {
    try {
      const p = webUtils.getPathForFile(f);
      if (p) paths.push(p);
    } catch (err) {}
  }
  if (paths.length) {
    window.postMessage(JSON.stringify({ __bcDropFiles: paths }), '*');
  }
}, true);
