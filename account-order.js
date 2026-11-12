'use strict';

// 账号顺序重排。纯 Node，不依赖 electron，可直接跑测试。
//
// 核心约束：**绝不丢账号**。
//   - 不在 ids 里的账号（新增、并发、脏数据）按原顺序追加到末尾
//   - ids 里不存在的 id 直接忽略
//   - 重复 id 只保留第一次出现
//   - 纯函数：不改入参 list / ids
//
// 侧栏拖动排序只负责把「新顺序的 id 数组」传进来，
// 真正的合并与兜底放在这里，主进程只做保存。

function reorderAccounts(list, ids) {
  const src = Array.isArray(list) ? list : [];
  const order = Array.isArray(ids) ? ids : [];

  const byId = new Map();
  for (const a of src) {
    if (!a || a.id === null || a.id === undefined) continue;
    const key = String(a.id);
    if (!byId.has(key)) byId.set(key, a);   // 重复 id 取第一个
  }

  const out = [];
  const used = new Set();
  for (const raw of order) {
    const key = String(raw);
    if (used.has(key)) continue;
    const a = byId.get(key);
    if (!a) continue;
    used.add(key);
    out.push(a);
  }
  // 兜底：没被点名的一个都不能少
  for (const a of src) {
    if (!a || a.id === null || a.id === undefined) continue;
    const key = String(a.id);
    if (used.has(key)) continue;
    used.add(key);
    out.push(a);
  }
  return out;
}

module.exports = { reorderAccounts };
