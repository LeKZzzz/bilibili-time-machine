import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 测试默认按发布语义运行（__TIME_FILTER_DEV__ 为 false）；需要验证日志时显式覆盖。
  define: {
    __TIME_FILTER_DEV__: 'false',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
});
