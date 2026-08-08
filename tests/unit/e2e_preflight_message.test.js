import { describeConnectFailure } from '../e2e/helpers/ptt';

// live e2e preflight 的訊息組裝（tests/e2e/preflight.setup.js 用）。
// 這條測試守的是「訊息要能一眼分辨是誰的問題」——PTT 掛掉時整包 live e2e 會紅，
// 若訊息含糊，每個 session 都會重新花時間研究一次。
describe('describeConnectFailure', () => {
  const base = { screen: '(空白)', timeout: 30000 };

  test('app 沒 boot → 指向本專案／dev server，不誣賴 PTT', () => {
    const msg = describeConnectFailure({ ...base, hasApp: false });
    expect(msg).toContain('本專案');
    expect(msg).toContain('window.__app');
    expect(msg).not.toContain('PTT 端不可達');
    expect(msg).toContain('connectState=n/a');
  });

  test('connectState=2（已斷線）→ 明講 PTT 端不可達／維護中', () => {
    const msg = describeConnectFailure({ ...base, hasApp: true, connectState: 2 });
    expect(msg).toContain('PTT 端不可達或維護中');
    expect(msg).toContain('非本專案 code 問題');
    expect(msg).toContain('connectState=2');
  });

  test('connectState=0（一直在連）→ 指向 PTT 不可達／網路被擋', () => {
    const msg = describeConnectFailure({ ...base, hasApp: true, connectState: 0 });
    expect(msg).toContain('握手沒完成');
    expect(msg).toContain('非本專案 code 問題');
  });

  test('connectState=1 但畫面空白 → 連上了但 server 不吐畫面（維護模式）', () => {
    const msg = describeConnectFailure({ ...base, hasApp: true, connectState: 1 });
    expect(msg).toContain('連上了');
    expect(msg).toContain('維護模式');
  });

  test('一律附上排查順序、逃生門與當前畫面', () => {
    const msg = describeConnectFailure({
      hasApp: true,
      connectState: 2,
      screen: '一些畫面內容',
      timeout: 12345,
    });
    expect(msg).toContain('https://term.ptt.cc');
    expect(msg).toContain('E2E_SKIP_PREFLIGHT=1');
    expect(msg).toContain('一些畫面內容');
    expect(msg).toContain('12345ms');
  });
});
