// e2e worker 數決策的守護（tests/e2e/workers_policy.js）。
//
// 重點是單向安全：只有「這一輪全是 offline* project」才准多 worker。live 多一個
// worker 就多一次真 PTT 登入（共用 session 是 worker-scoped），連跑會被 BOT 封鎖。
import { e2eWorkers, projectsFromArgv } from "../e2e/workers_policy.js";
import config from "../../playwright.config.js";

const node = ["node", "playwright", "test"];

describe("e2eWorkers", () => {
  test.each([
    ["沒指定 project（會跑到 live）", []],
    ["live", ["--project=live"]],
    ["record", ["--project=record"]],
    ["offline 混 live", ["--project=offline", "--project=live"]],
    ["逗號清單混 live", ["--project=offline,live"]],
    ["空白分隔寫法混 live", ["--project", "offline", "--project", "live"]],
    ["只有 --ui", ["--ui"]],
  ])("%s ⇒ 1", (_, args) => {
    expect(e2eWorkers([...node, ...args], {})).toBe(1);
    expect(e2eWorkers([...node, ...args], { CI: "true", E2E_WORKERS: "8" })).toBe(1);
  });

  test("全是 offline* ⇒ 本機 50%、CI 2", () => {
    const argv = [...node, "--project=offline", "--project=offline-firefox", "--project=offline-mobile"];
    expect(e2eWorkers(argv, {})).toBe("50%");
    expect(e2eWorkers(argv, { CI: "true" })).toBe(2);
  });

  test("逆境桶也算 offline", () => {
    expect(e2eWorkers([...node, "--project=offline-slow"], {})).toBe("50%");
  });

  test("E2E_WORKERS 覆寫並行值", () => {
    expect(e2eWorkers([...node, "--project=offline"], { E2E_WORKERS: "3" })).toBe("3");
  });

  test("projectsFromArgv 兩種寫法都認", () => {
    expect(projectsFromArgv(["--project=a,b", "--project", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("playwright.config.js", () => {
  test("workers 由 e2eWorkers 推導，不准寫死", () => {
    // vitest 的 argv 不含 --project=offline* ⇒ 必須解析成 1。
    expect(config.workers).toBe(1);
  });

  test("只有 offline* project 開 fullyParallel", () => {
    for (const p of config.projects) {
      expect([p.name, Boolean(p.fullyParallel)]).toEqual([p.name, p.name.startsWith("offline")]);
    }
  });
});
