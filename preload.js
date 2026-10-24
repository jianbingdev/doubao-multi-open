// 预加载脚本: 暴露类型安全的 IPC 桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsAdd: () => ipcRenderer.invoke('accounts:add'),
  accountsRename: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
  accountsDelete: (id) => ipcRenderer.invoke('accounts:delete', id),
  accountsSelect: (id) => ipcRenderer.invoke('accounts:select', id),
  accountsDetectName: (id) => ipcRenderer.invoke('accounts:detectName', id),
  accountsCheckAll: () => ipcRenderer.invoke('accounts:checkAll'),
  accountsCheckOne: (id) => ipcRenderer.invoke('accounts:checkOne', id),
  prefsGet: () => ipcRenderer.invoke('prefs:get'),
  prefsSet: (patch) => ipcRenderer.invoke('prefs:set', patch),
  openDownloads: () => ipcRenderer.invoke('downloads:openFolder'),

  // 自动更新(v3.0.15)
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  updateSetSource: (url) => ipcRenderer.invoke('update:setSource', url),

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
  onMenuCheckUpdate: (cb) => ipcRenderer.on('menu:checkUpdate', () => cb())
});
