// 平滑捲動動畫核心（src/js/smooth_scroll.js）。
import {
  smoothStep,
  createSmoothScroller,
  SMOOTH_FACTOR,
  SMOOTH_MIN_STEP,
} from "../../src/js/smooth_scroll";

describe("smoothStep", () => {
  test("逐幀遞減（ease-out）", () => {
    expect(smoothStep(100)).toBeCloseTo(100 * SMOOTH_FACTOR, 6);
    expect(smoothStep(50)).toBeCloseTo(50 * SMOOTH_FACTOR, 6);
  });

  test("尾巴有最小步長，不會無限接近", () => {
    expect(smoothStep(2)).toBe(SMOOTH_MIN_STEP);
    expect(smoothStep(0.4)).toBeCloseTo(0.4, 6); // 不得超過剩餘距離
  });

  test("負向對稱", () => {
    expect(smoothStep(-100)).toBeCloseTo(-100 * SMOOTH_FACTOR, 6);
    expect(smoothStep(-2)).toBe(-SMOOTH_MIN_STEP);
  });

  test("0／非有限值 → 0", () => {
    expect(smoothStep(0)).toBe(0);
    expect(smoothStep(NaN)).toBe(0);
  });
});

describe("createSmoothScroller", () => {
  const harness = (onStep) => {
    const frames = [];
    const sc = createSmoothScroller({
      raf: (fn) => {
        frames.push(fn);
        return frames.length;
      },
      cancel: () => {},
      onStep,
    });
    return {
      sc,
      // 跑到停為止（上限保護，避免測試無窮迴圈）
      run: (max = 200) => {
        let n = 0;
        while (frames.length && n < max) {
          frames.shift()();
          n++;
        }
        return n;
      },
    };
  };

  test("一次 add 會分成多幀吃完，總和等於距離", () => {
    const steps = [];
    const { sc, run } = harness((s) => steps.push(s));
    sc.add(100);
    const frames = run();
    expect(frames).toBeGreaterThan(5); // 不是一幀瞬移
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(sc.pending()).toBe(0);
    // 每一步都比前一步小（ease-out），最後一步例外（收尾）
    expect(steps[0]).toBeGreaterThan(steps[1]);
  });

  test("動畫途中再 add：距離累加，不重來", () => {
    const steps = [];
    const { sc, run } = harness((s) => steps.push(s));
    sc.add(100);
    run(2);
    sc.add(100);
    run();
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(200, 6);
  });

  test("反向 add 會抵銷剩餘距離（反手立刻跟手）", () => {
    const steps = [];
    const { sc, run } = harness((s) => steps.push(s));
    sc.add(100);
    run(1);
    sc.add(-100);
    run();
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
  });

  test("onStep 回 false（撞到邊／模式切走）立刻停止", () => {
    const steps = [];
    const { sc, run } = harness((s) => {
      steps.push(s);
      return false;
    });
    sc.add(500);
    run();
    expect(steps.length).toBe(1);
    expect(sc.pending()).toBe(0);
  });

  test("stop() 丟掉剩餘距離", () => {
    const steps = [];
    const { sc, run } = harness((s) => steps.push(s));
    sc.add(500);
    run(1);
    sc.stop();
    run();
    expect(steps.length).toBe(1);
    expect(sc.pending()).toBe(0);
  });
});
