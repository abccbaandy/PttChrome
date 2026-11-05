// 測試用 SSH server 的 host key（tests/unit/node_helpers/ssh_test_server.js）。
// ssh2 的 utils.generateKeyPairSync('ed25519') 約 0.4% 機率產出它自己解析不了的私鑰（本機 3000 次壞 12 次），
// 整檔共用一把 ⇒ 撞到就是 ssh_client.test.js 整檔紅（dev CI 曾因此紅，issue #328）。
// helper 必須驗過再用，壞的就重產。
import ssh2 from "ssh2";
import { generateUsableKey } from "./node_helpers/ssh_test_server";

const { utils } = ssh2;

test("a malformed generated key is regenerated, never handed to the server", () => {
  const good = utils.generateKeyPairSync("ed25519");
  const bad = { ...good, private: good.private.replace(/[A-Za-z0-9+/]{20}(?=\n-----END)/, "A".repeat(20)) };
  expect(utils.parseKey(bad.private)).toBeInstanceOf(Error);
  const gen = vi.fn().mockReturnValueOnce(bad).mockReturnValueOnce(good);
  const kp = generateUsableKey("ed25519", undefined, gen);
  expect(kp).toBe(good);
  expect(gen).toHaveBeenCalledTimes(2);
});

test("gives up loudly instead of looping forever", () => {
  const bad = { private: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", public: "" };
  expect(() => generateUsableKey("ed25519", undefined, () => bad)).toThrow(/usable/);
});
