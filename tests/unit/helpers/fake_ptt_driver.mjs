// tools/ptt-src-screens/capture.mjs 測試用的假 driver：參數同真 driver
// （<home> <seed> <入口> <列數>），入口決定行為。同真 driver，要等 stdin 時在 stdout 寫
// WAIT_MARK（＝這一幀畫完）。每次輸出都拆成兩段、中間隔一段時間，模擬 pfterm 分批 flush：
// capture 必須把兩段併成同一幀。
import { WAIT_MARK } from '../../../tools/ptt-src-screens/capture.mjs';

const [, , , , entry] = process.argv;
const twoChunks = (a, b, gapMs = 40) => {
  process.stdout.write(a);
  setTimeout(() => process.stdout.write(b + WAIT_MARK), gapMs);
};

if (entry === 'echo') {
  // 開場畫一幀；之後每收到一次鍵就畫「[鍵]」一幀。不自己結束（同真 driver 停在讀鍵）。
  twoChunks('HELLO-', 'SCREEN');
  process.stdin.on('data', (d) => twoChunks('[', `${d.toString('latin1')}]`));
} else if (entry === 'slow') {
  // 機器忙時的樣子：同一幀的兩段 flush 隔很久（driver 被排程延後），仍是同一幀。
  twoChunks('HELLO-', 'SCREEN', 600);
  process.stdin.resume();
} else if (entry === 'die' || entry === 'die-slow') {
  // 同 driver.c#die：已經吐了 initscr 的位元組才報錯結束（die-slow：機器忙，過很久才真的結束）。
  process.stdout.write('\x1b[H');
  process.stderr.write('driver: enter_board\n');
  setTimeout(() => process.exit(2), entry === 'die' ? 20 : 600);
} else if (entry === 'hang') {
  // 畫了一半就卡住，永遠不回到等鍵。
  process.stdout.write('HALF');
  process.stdin.resume();
} else if (entry === 'mute') {
  // 開場有畫，之後不管送什麼都不再輸出就回去等鍵（場景的鍵在 upstream 變成無效鍵）。
  process.stdout.write('ONCE' + WAIT_MARK);
  process.stdin.on('data', () => process.stdout.write(WAIT_MARK));
}
