// tools/ptt-src-screens/capture.mjs 測試用的假 driver：參數同真 driver
// （<home> <seed> <入口> <列數>），入口決定行為。每次輸出都拆成兩段、中間隔 40ms
// （比測試用的 quietMs 短），模擬 pfterm 分批 flush：capture 必須把兩段併成同一幀。
const [, , , , entry] = process.argv;
const twoChunks = (a, b) => {
  process.stdout.write(a);
  setTimeout(() => process.stdout.write(b), 40);
};

if (entry === 'echo') {
  // 開場畫一幀；之後每收到一次鍵就畫「[鍵]」一幀。不自己結束（同真 driver 停在讀鍵）。
  twoChunks('HELLO-', 'SCREEN');
  process.stdin.on('data', (d) => twoChunks('[', `${d.toString('latin1')}]`));
} else if (entry === 'die') {
  // 同 driver.c#die：已經吐了 initscr 的位元組才報錯結束。
  process.stdout.write('\x1b[H');
  process.stderr.write('driver: enter_board\n');
  setTimeout(() => process.exit(2), 20);
} else if (entry === 'mute') {
  // 開場有畫，之後不管送什麼都不再輸出（場景的鍵在 upstream 變成無效鍵）。
  process.stdout.write('ONCE');
  process.stdin.resume();
}
