// src/js/platform.js —— 只給文案用的平台判斷。
//
// 守的是「Mac 使用者看到的提示是 ⌘ 而不是 Ctrl」，以及**偵測失敗時要退回
// Ctrl+Enter 而不是爆炸**：這個值會直接進 render，throw 等於整個長推文輸入框開不起來。
import { isMacPlatform, modEnterShortcutLabel } from '../../src/js/platform';

const nav = (over) => ({ userAgent: '', ...over });

describe('平台判斷（只影響提示文案）', () => {
  test('Chromium：userAgentData.platform 說 macOS 就是 Mac', () => {
    expect(isMacPlatform(nav({ userAgentData: { platform: 'macOS' } }))).toBe(
      true
    );
    expect(
      modEnterShortcutLabel(nav({ userAgentData: { platform: 'macOS' } }))
    ).toBe('⌘Enter');
  });

  test('Chromium on Windows：提示是 Ctrl+Enter', () => {
    const n = nav({
      userAgentData: { platform: 'Windows' },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(isMacPlatform(n)).toBe(false);
    expect(modEnterShortcutLabel(n)).toBe('Ctrl+Enter');
  });

  test('userAgentData 說 macOS 時，UA 字串長怎樣都不影響（Chromium 的 UA 沒有 Macintosh 也算）', () => {
    const n = nav({ userAgentData: { platform: 'macOS' }, userAgent: 'x' });
    expect(modEnterShortcutLabel(n)).toBe('⌘Enter');
  });

  test('Firefox／Safari 沒有 userAgentData ⇒ 退回 UA 字串', () => {
    const firefoxMac = nav({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
    });
    expect(modEnterShortcutLabel(firefoxMac)).toBe('⌘Enter');

    const firefoxLinux = nav({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101',
    });
    expect(modEnterShortcutLabel(firefoxLinux)).toBe('Ctrl+Enter');
  });

  test('userAgentData 存在但 platform 是空字串 ⇒ 不當作答案，改看 UA', () => {
    const n = nav({
      userAgentData: { platform: '' },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(isMacPlatform(n)).toBe(true);
  });

  test('拿不到 navigator 也不能 throw（這個值會直接進 render）', () => {
    expect(() => modEnterShortcutLabel(null)).not.toThrow();
    expect(modEnterShortcutLabel(null)).toBe('Ctrl+Enter');
    expect(modEnterShortcutLabel(nav())).toBe('Ctrl+Enter');
  });
});
