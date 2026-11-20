'use strict';

// 剪贴板临时图片的存放与清理策略。
//
// 为什么每批用独立目录：图片写进 _clip 后会以 CF_HDROP 方式进剪贴板，
// 用户粘到豆包 / 微信 / WPS 里时，对方程序可能一直握着这些文件。
// 再复制时如果覆盖同名文件，Windows 直接 EPERM（真机实测：新文件能建，
// 旧批次 01.png 删不掉、改不了名、也打不开可写）。
// 所以每批写到 _clip\<批次>\，永不碰上一批；旧批次由 prune() 按策略清。
//
// 清理口径：
//   · 最新一批永远保留（剪贴板多半还指着它）
//   · 其余按「最多留 keep 批 / 总量超 maxBytes / 超 maxAge」从最老的删
//   · 删不掉的（还被其它程序占着）直接跳过，不报错，下次再试

const fs = require('fs');
const path = require('path');

const BATCH_RE = /^\d{8}-\d{6}-\d{3}-[a-z0-9]{4,8}$/;

const KEEP_BATCHES = 4;
const MAX_BYTES = 150 * 1024 * 1024;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function newBatchName(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  const stamp = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '-' +
    pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) + '-' +
    pad(d.getMilliseconds(), 3);
  let rand = Math.random().toString(36).slice(2, 6);
  while (rand.length < 4) rand += '0';
  return stamp + '-' + rand;
}

function isBatchName(name) {
  return BATCH_RE.test(String(name == null ? '' : name));
}

// 返回要删的批次名（新 → 旧排序）。
// 最新一批无条件保留；其余从第二新开始，命中任一上限就删。
function planCleanup(entries, opts) {
  const o = opts || {};
  const keep = Number.isFinite(o.keep) ? Math.max(1, Math.floor(o.keep)) : KEEP_BATCHES;
  const maxBytes = Number.isFinite(o.maxBytes) ? Math.max(0, o.maxBytes) : MAX_BYTES;
  const maxAgeMs = Number.isFinite(o.maxAgeMs) ? Math.max(0, o.maxAgeMs) : MAX_AGE_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.name === 'string')
    .map((e) => ({
      name: e.name,
      mtimeMs: Math.max(0, Number(e.mtimeMs) || 0),
      bytes: Math.max(0, Number(e.bytes) || 0)
    }))
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : -1));

  const del = [];
  let total = list.reduce((n, e) => n + e.bytes, 0);
  for (let i = 1; i < list.length; i++) {
    const e = list[i];
    const tooOld = now - e.mtimeMs > maxAgeMs;
    const tooMany = i >= keep;
    const tooBig = total > maxBytes;
    if (tooOld || tooMany || tooBig) {
      del.push(e.name);
      total -= e.bytes;
    }
  }
  return del;
}

function dirBytes(dir) {
  let bytes = 0;
  let mtimeMs = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { bytes, mtimeMs }; }
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) {
        bytes += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
    } catch (e) {}
  }
  return { bytes, mtimeMs };
}

function scanBatches(rootDir) {
  let items = [];
  try { items = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const it of items) {
    if (!it.isDirectory() || !isBatchName(it.name)) continue;
    const full = path.join(rootDir, it.name);
    // 目录 mtime 在写入文件时会更新，正好代表这一批的时间；
    // 不要用文件 mtime 取最大：测试里会用 utimes 造旧批次，文件时间可能比目录新。
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (e) {}
    const { bytes, mtimeMs: fileMtime } = dirBytes(full);
    out.push({ name: it.name, mtimeMs: mtimeMs || fileMtime || Date.now(), bytes });
  }
  return out;
}

// 扫描 + 删除。返回 { deleted, failed, bytes, legacy }，不抛错。
function prune(rootDir, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const entries = scanBatches(rootDir);
  const del = planCleanup(entries, Object.assign({}, o, { now }));
  const byName = new Map(entries.map((e) => [e.name, e]));

  let deleted = 0;
  let failed = 0;
  let bytes = 0;
  for (const name of del) {
    try {
      fs.rmSync(path.join(rootDir, name), { recursive: true, force: true });
      deleted++;
      bytes += (byName.get(name) || {}).bytes || 0;
    } catch (e) {
      failed++;
    }
  }

  // 旧版直接写在 _clip\ 根下的 01.png…：只清一天前的，删不掉就跳过
  let legacy = 0;
  try {
    for (const it of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!it.isFile()) continue;
      const full = path.join(rootDir, it.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs <= LEGACY_MAX_AGE_MS) continue;
        fs.rmSync(full, { force: true });
        legacy++;
      } catch (e) {}
    }
  } catch (e) {}

  return { deleted, failed, bytes, legacy };
}

module.exports = {
  BATCH_RE, KEEP_BATCHES, MAX_BYTES, MAX_AGE_MS, LEGACY_MAX_AGE_MS,
  newBatchName, isBatchName, planCleanup, scanBatches, prune
};
