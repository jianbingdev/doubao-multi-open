'use strict';

// 自动内存回收的挑选策略（纯函数）。
//
// 背景：以前每 5 分钟、只要总内存 >3GB，就把**所有**账号的 session 缓存清一遍。
// 结果是缓存永远冷的：切到任何一个账号（尤其很久没用的）都要重新下载资源，点起来卡。
// 现在只挑「长时间没用、且最近没清过」的少量账号，活跃/刚用过的页面保持热缓存。

const DEFAULT_IDLE_MS = 60 * 60 * 1000;      // 至少空闲 1 小时才算“长时间没用”
const DEFAULT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 同一个账号 2 小时内最多清一次

// entries: [{ id, active, lastActiveAt, lastClearedAt }]
// 返回要清缓存的 id，最久未用的排前面，最多 max 个。
function planReclaim(entries, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const idleMs = Number.isFinite(o.idleMs) ? Math.max(0, o.idleMs) : DEFAULT_IDLE_MS;
  const cooldownMs = Number.isFinite(o.cooldownMs) ? Math.max(0, o.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const max = Number.isFinite(o.max) ? Math.max(0, Math.floor(o.max)) : 1;

  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id && !e.active)
    .filter((e) => now - (Number(e.lastActiveAt) || 0) >= idleMs)
    .filter((e) => now - (Number(e.lastClearedAt) || 0) >= cooldownMs)
    .sort((a, b) => (Number(a.lastActiveAt) || 0) - (Number(b.lastActiveAt) || 0))
    .slice(0, max)
    .map((e) => e.id);
}

module.exports = { planReclaim, DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS };
