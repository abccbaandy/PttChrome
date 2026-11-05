// PTT（ptt.cc:22，bbs-sshd）的 host key 指紋表。relay 只搬 bytes，SSH 在本頁解開 ⇒
// 這張表是「relay（含我們自己的 Worker）中間人攔截」的唯一防線：收到的 host key 不在表裡
// 就中止連線（close reason 'hostkey'），不重連。
//
// 來源：ssh-keyscan 量測 PTT 的 6 個 IP，同一組（docs/ssh.md「量測結果」）。
// PTT 換 key 時跟著更新這裡（並在 docs/ssh.md 記一筆）。格式同 `ssh-keygen -lf`：
// SHA256:<base64(sha256(host key blob)) 去掉 '='>。key 是 blob 裡的 key 型別
//（rsa-sha2-256／512 的 blob 型別是 ssh-rsa）。
export const PTT_HOST_KEYS = Object.freeze({
  'ssh-ed25519': ['SHA256:oTf7wY7klc9gi0FHhYQNHQu7aJfYGz/bFLSpdOxhbxg'],
  'ecdsa-sha2-nistp256': ['SHA256:3rvcAywUJszX7jPzC3JkbtxqnHiApB4tuwQ3swSYmSo'],
  'ssh-rsa': ['SHA256:9/gkjxWjuteMj//K0sRo1gj7h5qTp0HPIH3n7+e3Jqc'],
});

// SSH 層的帳號：PTT 的 bbs-sshd 用 `none` 認證、帳號固定 bbs，真正的登入在通道裡的
// logind 畫面（與 WebSocket 一樣）。
export const PTT_SSH_USER = 'bbs';
