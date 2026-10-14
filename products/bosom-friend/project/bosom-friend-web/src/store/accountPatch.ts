/**
 * 账号改动的两个落点：账号 store 的三个切片，以及按 `(平台, uid)` 寻址的 AI 事实库。
 *
 * 两者都会**静默**失败——写到了别处不会报错，用户只看到"点了没反应"或"卡片上没有定位"，
 * 所以落点判定全部收在这里做纯函数，由单测逐处断言（DEF-147、DEF-148）。
 */

/**
 * 把一个账号的改动同时落到 store 里**所有**装着它的地方。
 *
 * 为什么必须是纯函数、单独一个模块：同一个账号在账号 store 里有三处引用——
 * `accountList`、`accountMap`、以及 `accountGroupList[].children`，而**页面渲染的是最后那处**
 * （见 `accountCore.tsx` 的 `allAccounts`：有分组就用分组里的 children）。
 * 只替换 `accountList` 里那一个对象，分组里的旧对象还在，卡片就会停在旧值上——
 * 服务端明明写成功了，用户看到的却是"点了没反应"。
 *
 * @param state - 账号 store 里与账号有关的三个切片（外加当前选中项）。
 * @param accountId - 要改的账号 id。
 * @param patch - 要覆盖的字段。
 * @returns 可以直接交给 `set()` 的新切片；账号不在列表里时返回 undefined（调用方据此不动任何状态）。
 */
export function patchAccountHomes<A extends { id: string }, G extends { children?: A[] }>(
  state: {
    accountList: A[]
    accountMap: Map<string, A>
    accountGroupList?: G[]
    accountActive?: A
  },
  accountId: string,
  patch: Partial<A>,
): {
  accountList: A[]
  accountMap: Map<string, A>
  accountGroupList: G[]
  accountActive?: A
} | undefined {
  const target = state.accountList.find(account => account.id === accountId)
  if (target === undefined)
    return undefined
  const next = { ...target, ...patch }
  const swap = (list: A[]): A[] => list.map(item => (item.id === accountId ? next : item))
  const accountMap = new Map(state.accountMap)
  accountMap.set(accountId, next)
  return {
    accountList: swap(state.accountList),
    accountMap,
    // 不含这个账号的分组原样返回**同一个对象**：凭空新建对象会让 React 认为整组都变了。
    accountGroupList: (state.accountGroupList ?? []).map(group =>
      group.children?.some(item => item.id === accountId) === true
        ? { ...group, children: swap(group.children) }
        : group),
    ...(state.accountActive?.id === accountId ? { accountActive: next } : {}),
  }
}

/**
 * 账号级 AI 事实（定位 / 风险）的地址：平台 + uid。
 *
 * 服务端账号行与桌面端本机账号（住在本机 SQLite）没有共同的行 id，`(平台, uid)` 是两边唯一共有的
 * 标识。**这个拼法只有这一处**：散在两处时，改了一处另一处不会报错，事实明明写进去了，
 * 卡片上却什么都没有（DEF-147）。
 *
 * @param platform - 平台标识，如 `xhs`。
 * @param uid - 该平台内的账号 uid。
 * @returns 事实库与页面共用的地址。
 */
export function accountFactKey(platform: unknown, uid: unknown): string {
  return String(platform ?? '') + '|' + String(uid ?? '')
}

/**
 * 账号动作的寻址：本机账号用 `(平台, uid)`（服务端没有它的行），服务端账号用行 id。
 *
 * 本机账号的写入地址必须与读回地址是同一个（`accountFactKey`），否则会写进一个没人按它查的键。
 *
 * @param account - 账号行（本机行带 `accountSource: 'desktop-local'`）。
 * @returns 交给 `ai/object-action` 的 `id`。
 */
export function accountActionTarget(account: { id: string, type?: unknown, uid?: unknown, accountSource?: unknown }): string {
  return account.accountSource === 'desktop-local' ? accountFactKey(account.type, account.uid) : account.id
}

/**
 * 把 `v2/channels/account-facts` 的返回编成按地址索引的事实表。
 *
 * 缺失的字段**不进表**：`undefined` 进表会把账号行上的旧值覆盖成空，页面上的定位会凭空消失。
 *
 * @param list - 路由返回的事实列表。
 * @returns 地址 → 事实（只含真的有过值的字段）。
 */
export function accountFactsIndex(
  list: Array<{ platform: string, uid: string, positioning?: string, risk?: string }>,
): Map<string, { positioning?: string, risk?: string }> {
  const index = new Map<string, { positioning?: string, risk?: string }>()
  for (const item of list) {
    index.set(accountFactKey(item.platform, item.uid), {
      ...(item.positioning === undefined ? {} : { positioning: item.positioning }),
      ...(item.risk === undefined ? {} : { risk: item.risk }),
    })
  }
  return index
}
