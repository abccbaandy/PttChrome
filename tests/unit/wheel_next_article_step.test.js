// 桌機「讀到文末、停一下、再往下捲 ⇒ 開下一篇」的判準（src/js/pull_next_article.js#wheelPullStep、
// docs/next-article.md「桌機：停一下再往下捲」）。WheelEvent 沒有相位 ⇒ 用「相隔夠久才算新
// 手勢」切開，只有起手時就停在底部的手勢累積位移：捲到底那一串（連同觸控板慣性）永遠不算。
import {
  wheelPullStep,
  WHEEL_GESTURE_GAP_MS,
  WHEEL_IDLE_RESET_MS,
  WHEEL_THRESHOLD_PX,
} from "../../src/js/pull_next_article";

// 一串 wheel：events＝[{ dt, dy, atBottom, moved }]，回傳最後的狀態與是否 fire 過。
function run(events, start = null) {
  let st = start;
  let t = 10000;
  let fired = 0;
  for (const e of events) {
    t += e.dt == null ? 16 : e.dt;
    st = wheelPullStep(st, { t, dy: e.dy == null ? 100 : e.dy, atBottom: e.atBottom !== false, moved: !!e.moved });
    if (st.fire) fired++;
  }
  return { st, fired };
}

const NOTCHES = Math.ceil(WHEEL_THRESHOLD_PX / 100);

test("停在底部、新的手勢往下捲過門檻 ⇒ fire 一次", () => {
  const ev = Array.from({ length: NOTCHES }, (_, i) => ({ dt: i === 0 ? 1000 : 60 }));
  expect(run(ev).fired).toBe(1);
});

test("沒過門檻 ⇒ 不 fire，progress 照比例", () => {
  const { st, fired } = run([{ dt: 1000 }, { dt: 60 }]);
  expect(fired).toBe(0);
  expect(st.progress).toBeCloseTo(200 / WHEEL_THRESHOLD_PX);
});

test("一路捲到底的那一串（起手不在底部）＋慣性尾巴，再多也不算", () => {
  const ev = [{ dt: 1000, atBottom: false }, ...Array.from({ length: 5 }, () => ({ dt: 60, atBottom: false }))];
  // 到底後慣性繼續送（間隔遠小於 GAP）。
  for (let i = 0; i < 60; i++) ev.push({ dt: 16, dy: 40 });
  const { st, fired } = run(ev);
  expect(fired).toBe(0);
  expect(st.eligible).toBe(false);
  expect(st.acc).toBe(0);
});

test("捲到底後停一下（≥ GAP）再捲 ⇒ 才算", () => {
  const ev = [{ dt: 1000, atBottom: false }, { dt: 16, dy: 40 }, { dt: 16, dy: 40 }];
  for (let i = 0; i < NOTCHES; i++) ev.push({ dt: i === 0 ? WHEEL_GESTURE_GAP_MS : 60 });
  expect(run(ev).fired).toBe(1);
});

test("新手勢的第一下捲動位置已經變了（合成器先把人捲到底）⇒ 不算起手在底部", () => {
  const ev = [{ dt: 1000, moved: true }];
  for (let i = 0; i < NOTCHES + 2; i++) ev.push({ dt: 60 });
  expect(run(ev).fired).toBe(0);
});

test("往上捲 ⇒ 累積歸零", () => {
  const ev = [{ dt: 1000 }, { dt: 60 }, { dt: 60, dy: -50 }];
  for (let i = 0; i < NOTCHES - 1; i++) ev.push({ dt: 60 });
  const { fired, st } = run(ev);
  expect(fired).toBe(0);
  expect(st.acc).toBe(0);
});

test("慢慢一格一格捲（每格隔 GAP 以上、但在閒置歸零之內）⇒ 累積接得起來", () => {
  const ev = Array.from({ length: NOTCHES }, (_, i) => ({ dt: i === 0 ? 1000 : WHEEL_GESTURE_GAP_MS + 50 }));
  expect(WHEEL_GESTURE_GAP_MS + 50).toBeLessThan(WHEEL_IDLE_RESET_MS);
  expect(run(ev).fired).toBe(1);
});

test("停太久（≥ 閒置歸零）⇒ 之前的累積不算", () => {
  const ev = [{ dt: 1000 }, { dt: 60 }, { dt: 60 }];
  ev.push({ dt: WHEEL_IDLE_RESET_MS + 10 });
  const { st } = run(ev);
  expect(st.acc).toBe(100);
});

test("中途離開底部（內容長高了）⇒ 這個手勢作廢", () => {
  const ev = [{ dt: 1000 }, { dt: 60 }, { dt: 60, atBottom: false }];
  for (let i = 0; i < NOTCHES; i++) ev.push({ dt: 60 });
  expect(run(ev).fired).toBe(0);
});

test("純水平（dy 0）不改累積", () => {
  const a = run([{ dt: 1000 }, { dt: 60 }]).st;
  const b = wheelPullStep(a, { t: a.lastTs + 30, dy: 0, atBottom: true, moved: false });
  expect(b.acc).toBe(a.acc);
  expect(b.eligible).toBe(true);
});
