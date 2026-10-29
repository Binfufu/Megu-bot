/**
 * **"人"那条连接的固定样本**(1.91.0 / D147 的判据用)。**纯数据,不碰库**。
 *
 * ⚠️ 为什么要有它:`src\elements.js` 的图**不认识库** —— 运行时的人由调用方喂进来。
 *    单测要判"人真的进得来、关系真的连得上",就必须有一份**形状固定**的人:
 *    一个面板账号(玩家)+ 两个 QQ 熟人(一个"眼熟"、一个"朋友")。
 *
 * ⚠️ openid 里的 `OPENID_*` 是**假 id**(真 id 是 32 位十六进制)—— 单测里不许写真人的。
 */
export const PEOPLE_FIXTURE = Object.freeze({
  accounts: [
    { id: 1, account: 'alice', nickname: '防火门' },
    // ⚠️ 停用的账号也要能进图(它是"这个人还在,只是进不来"),只是不能收礼
    { id: 2, account: 'bob', nickname: '小明', disabled: true },
    // 形状不对的行(**没有 id**)要被跳过 —— 不许猜一个 id 出来
    { account: 'no-id', nickname: '没 id 的人' },
  ],
  affinities: [
    { openid: 'OPENID_A', name: '眼熟的人', score: 5 },
    { openid: 'OPENID_B', name: '老朋友', score: 90 },
  ],
});

/** 归一化后的那份人(`peopleFromAccounts` + `peopleFromAffinities` 的结果)。 */
export function buildPeopleFixture() {
  return [
    { id: 'player:1', label: '防火门', kind: 'acquaintance', source: 'account', account: 'alice', nickname: '防火门', acceptsGifts: true },
    { id: 'player:2', label: '小明', kind: 'acquaintance', source: 'account', account: 'bob', nickname: '小明', disabled: true, acceptsGifts: false },
    { id: 'person:OPENID_A', label: '眼熟的人', kind: 'acquaintance', source: 'affinity', openid: 'OPENID_A', acceptsGifts: true, affinity: { score: 5, tierLabel: '眼熟' } },
    { id: 'person:OPENID_B', label: '老朋友', kind: 'acquaintance', source: 'affinity', openid: 'OPENID_B', acceptsGifts: true, affinity: { score: 90, tierLabel: '朋友' } },
  ];
}
