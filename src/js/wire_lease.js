// @ts-check
// 線路使用權（架構 review A2 步驟 b，docs/wire-send.md「線路使用權」）。
//
// 替使用者送多步序列的功能（搜尋、重新整理、跳到第一篇未讀、設為已讀、稍後再讀、首頁抓
// 我的最愛…）在序列跑完前要佔住線路：期間使用者的鍵一律吞掉＋提示（serialized_op_gate），
// 不然中間插進來的 byte 會被 PTT 的 typeahead 吃掉或打進 prompt。
//
// 以前每個功能各自在 core 上掛一個 `xxxInFlight` 旗標，serialized_op_gate 再逐一列舉、
// 提示字也寫在閘門裡 ⇒ 每加一個送鍵功能就要記得回去改閘門。現在改成**向線路取得使用權**：
// 功能帶著自己的提示字與逾時來拿，閘門只問「現在有沒有人拿著」，不用認識任何一個功能。
//
// 相容：`core[owner]` 仍鏡像成 true／false（owner 就是舊的旗標欄位名），給只讀它的人用
// （search_status、e2e 的 `__app.searchInFlight === false`）。**寫它只准經這裡**，
// 守護 tests/unit/wire_lease.test.js（靜態掃 src）。
//
// 多人同時拿著 ⇒ 提示給最早拿的那個（搬家前是固定優先序，搜尋最前）。多步序列的送出口
// （article_search.submitSerializedSteps）在別人拿著時不送，正常不會並存；保底照順序給。

/** 沒給提示字時的保底（不准無聲吞鍵）。 */
export const LEASE_FALLBACK_HINT = '指令處理中，請稍候…';

/**
 * @typedef {{ hint: string, timer: ReturnType<typeof setTimeout> | null }} WireLease
 * @typedef {Record<string, any> & { _wireLeases?: Map<string, WireLease> }} LeaseCore
 */

/**
 * @param {LeaseCore} core
 * @returns {Map<string, WireLease>}
 */
function leasesOf(core) {
  if (!core._wireLeases) core._wireLeases = new Map();
  return core._wireLeases;
}

/**
 * 取得（或續約）線路使用權。同一個 owner 再拿一次＝續約：換提示字、逾時重算，
 * 排隊順序不變。maxMs 到了自動放掉，防任何一條收尾漏掉造成永久吞鍵。
 * @param {LeaseCore} core
 * @param {string} owner 舊旗標欄位名（例 'unreadJumpInFlight'），也是鏡像欄位
 * @param {string} hint 被擋下時給使用者看的提示
 * @param {number} maxMs
 */
export function acquireWire(core, owner, hint, maxMs) {
  if (!core || !owner) return;
  const leases = leasesOf(core);
  const prev = leases.get(owner);
  if (prev && prev.timer) clearTimeout(prev.timer);
  /** @type {WireLease} */
  const lease = { hint: hint || LEASE_FALLBACK_HINT, timer: null };
  if (maxMs > 0) {
    lease.timer = setTimeout(function() {
      if (leases.get(owner) === lease) releaseWire(core, owner);
    }, maxMs);
  }
  leases.set(owner, lease);
  core[owner] = true;
}

/**
 * 放掉使用權（沒拿著也可以叫）。
 * @param {LeaseCore} core
 * @param {string} owner
 */
export function releaseWire(core, owner) {
  if (!core || !owner) return;
  const leases = core._wireLeases;
  const lease = leases && leases.get(owner);
  if (lease) {
    if (lease.timer) clearTimeout(lease.timer);
    leases.delete(owner);
  }
  core[owner] = false;
}

/**
 * 現在拿著線路的人的提示字；沒人拿著回 null。
 * @param {LeaseCore | null | undefined} core
 * @returns {string | null}
 */
export function wireLeaseHint(core) {
  const leases = core && core._wireLeases;
  if (!leases) return null;
  const first = leases.values().next();
  return first.done ? null : first.value.hint;
}
