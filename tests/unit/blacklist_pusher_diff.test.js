import { comparePusherSequences, inspectFloorGaps } from '../e2e/helpers/ptt';

// live e2e「黑名單：好讀模式移除推文且不留空行」的判定邏輯。
//
// 這條測試守的是：判定**不准跨兩次讀取比列數**。熱門板（C_Chat）的文章在前後兩次
// 累積之間推文會一直長，新增列數可以蓋過黑名單移除的列數 ⇒ 舊寫法的
// `c2 < c1` / `before.length - after.length >= targetCount` 會偽紅（實例：黑名單確實
// 生效、目標作者完全消失，卻量到 c2=412 > c1=289）。改成「內容前綴＋樓號缺口」後，
// 第二次多出多少新推文都不影響判定。

const seq = (...ids) => ids;

describe('comparePusherSequences', () => {
  test('文章期間長出新推文（本次偽紅來源）：target 消失即算通過，不看數量', () => {
    const before = seq('alice', 'bob', 'alice', 'carol', 'alice');
    // 黑名單移掉 alice，但期間又湧入 100 筆新推文 ⇒ after 反而更長
    const after = [
      'bob',
      'carol',
      ...Array.from({ length: 100 }, (_, i) => `newbie${i}`),
    ];

    const r = comparePusherSequences(before, after, 'alice');
    expect(r.targetInBefore).toBe(3);
    expect(r.targetInAfter).toBe(0);
    expect(r.prefixMatches).toBe(true);
    expect(r.firstMismatch).toBe(null);
    expect(r.appended).toHaveLength(100);
    // 舊心智模型的兩個計數斷言在此情境都會誤判 —— 明確記錄下來，別再改回去
    expect(after.length < before.length).toBe(false);
    expect(before.length - after.length >= r.targetInBefore).toBe(false);
  });

  test('沒有新推文湧入時同樣成立（after 剛好等於期望前綴）', () => {
    const before = seq('alice', 'bob', 'alice');
    const r = comparePusherSequences(before, seq('bob'), 'alice');
    expect(r.prefixMatches).toBe(true);
    expect(r.appended).toEqual([]);
  });

  test('回歸：target 的推文還在 → targetInAfter > 0', () => {
    const before = seq('alice', 'bob', 'alice');
    const r = comparePusherSequences(before, seq('alice', 'bob', 'alice'), 'alice');
    expect(r.targetInAfter).toBe(2);
  });

  test('回歸：誤刪非目標作者 → prefixMatches=false 並指出第一個落差位置', () => {
    const before = seq('alice', 'bob', 'carol', 'alice', 'dave');
    // bob 被一起刪掉了
    const r = comparePusherSequences(before, seq('carol', 'dave'), 'alice');
    expect(r.expectedPrefix).toEqual(['bob', 'carol', 'dave']);
    expect(r.prefixMatches).toBe(false);
    expect(r.firstMismatch).toEqual({ index: 0, expected: 'bob', actual: 'carol' });
  });

  test('回歸：其他人的推文順序被打亂 → prefixMatches=false', () => {
    const before = seq('alice', 'bob', 'carol');
    const r = comparePusherSequences(before, seq('carol', 'bob'), 'alice');
    expect(r.prefixMatches).toBe(false);
    expect(r.firstMismatch.index).toBe(0);
  });

  test('回歸：after 比期望前綴短（有人被吃掉）→ prefixMatches=false，不是靜默通過', () => {
    const before = seq('alice', 'bob', 'carol');
    const r = comparePusherSequences(before, seq('bob'), 'alice');
    expect(r.prefixMatches).toBe(false);
    expect(r.firstMismatch).toEqual({ index: 1, expected: 'carol', actual: undefined });
  });

  test('target 不在 before（挑錯人）→ targetInBefore=0，測試端據此擋掉', () => {
    const r = comparePusherSequences(seq('bob', 'carol'), seq('bob', 'carol'), 'alice');
    expect(r.targetInBefore).toBe(0);
  });
});

describe('inspectFloorGaps', () => {
  // entries 依畫面順序；floor=null 代表非推文列（內文／空白列）
  const row = (floor) => ({ floor, blank: false });
  const blank = () => ({ floor: null, blank: true });
  const body = () => ({ floor: null, blank: false });

  test('黑名單移除留下樓號缺口，且缺口內沒有空列 → 通過', () => {
    // 樓 2、3 被移除（整列不 render）
    const r = inspectFloorGaps([body(), row(1), row(4), row(5)]);
    expect(r.strictlyIncreasing).toBe(true);
    expect(r.gaps).toEqual([{ from: 1, to: 4, blankRowsBetween: 0 }]);
    expect(r.blankInGaps).toEqual([]);
  });

  test('回歸：移除處留下空行 → blankInGaps 抓得到', () => {
    const r = inspectFloorGaps([row(1), blank(), blank(), row(4), row(5)]);
    expect(r.gaps).toHaveLength(1);
    expect(r.blankInGaps).toEqual([{ from: 1, to: 4, blankRowsBetween: 2 }]);
  });

  test('回歸：黑名單完全沒生效（樓號連續）→ gaps 為空，測試端據此判定沒移除', () => {
    const r = inspectFloorGaps([row(1), row(2), row(3)]);
    expect(r.gaps).toEqual([]);
    expect(r.strictlyIncreasing).toBe(true);
  });

  test('回歸：樓號重複／倒退 → strictlyIncreasing=false', () => {
    expect(inspectFloorGaps([row(1), row(2), row(2)]).strictlyIncreasing).toBe(false);
    expect(inspectFloorGaps([row(3), row(1)]).strictlyIncreasing).toBe(false);
  });

  test('文章本文的空白列不算進缺口（相鄰樓號連續處的空列被忽略）', () => {
    const r = inspectFloorGaps([blank(), body(), row(1), blank(), row(2), row(4)]);
    expect(r.blankInGaps).toEqual([]);
    expect(r.gaps).toEqual([{ from: 2, to: 4, blankRowsBetween: 0 }]);
  });

  test('沒有任何樓號（未開樓號徽章／沒推文）→ 全空，不當成遞增失敗', () => {
    const r = inspectFloorGaps([body(), blank()]);
    expect(r.gaps).toEqual([]);
    expect(r.strictlyIncreasing).toBe(true);
  });
});
