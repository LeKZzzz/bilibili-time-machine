import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const supportedMatches = [
  'https://www.bilibili.com/*',
  'https://search.bilibili.com/*',
  'https://space.bilibili.com/*',
  'https://t.bilibili.com/*',
];

const userScriptBanner = `// ==UserScript==
// @name         B 站时光机
// @namespace    https://github.com/bilibili-time-filter
// @homepageURL  https://github.com/LeKZzzz/bilibili-time-machine
// @version      0.1.1
// @description  只显示早于本地截止时间的当前 B 站内容
// @license      MIT
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==`;

type BuildTarget = 'userscript' | 'extension';
type BuildFlavor = 'release' | 'dev';

interface BuildVariant {
  target: BuildTarget;
  flavor: BuildFlavor;
  /** 该模式是否是 MV3 content script（primary）入口。 */
  content?: boolean;
  outDir: string;
}

/** 模式名约定：`<target>[-content|-main][-dev]`，用于区分发布与开发产物。 */
function resolveVariant(mode: string): BuildVariant | null {
  const flavor: BuildFlavor = mode.endsWith('-dev') ? 'dev' : 'release';
  const base = flavor === 'dev' ? mode.slice(0, -'-dev'.length) : mode;
  if (base === 'userscript') {
    return { target: 'userscript', flavor, outDir: flavor === 'dev' ? 'dist/dev/userscript' : 'dist/userscript' };
  }
  if (base === 'extension-content') {
    return { target: 'extension', flavor, content: true, outDir: flavor === 'dev' ? 'dist/dev/extension' : 'dist/extension' };
  }
  if (base === 'extension-main') {
    return { target: 'extension', flavor, content: false, outDir: flavor === 'dev' ? 'dist/dev/extension' : 'dist/extension' };
  }
  return null;
}

function copyManifest(outDir: string): Plugin {
  return {
    name: 'copy-mv3-manifest',
    closeBundle() {
      const outputDir = resolve(outDir);
      mkdirSync(outputDir, { recursive: true });
      copyFileSync(resolve('extension/manifest.json'), resolve(outputDir, 'manifest.json'));
    },
  };
}

function prependUserScriptMetadata(outDir: string): Plugin {
  return {
    name: 'prepend-userscript-metadata',
    closeBundle() {
      const outputFile = resolve(outDir, 'bilibili-time-machine.user.js');
      const code = readFileSync(outputFile, 'utf8');
      if (!code.includes('==UserScript==')) writeFileSync(outputFile, `${userScriptBanner}\n${code}`, 'utf8');
    },
  };
}

export default defineConfig(({ mode }) => {
  const variant = resolveVariant(mode);

  if (variant?.target === 'userscript') {
    return {
      // 发布构建折叠为 false 并剔除诊断代码；开发构建为 true 自动启用脱敏日志。
      define: {
        __TIME_FILTER_DEV__: JSON.stringify(variant.flavor === 'dev'),
        __SUPPORTED_BILIBILI_MATCHES__: JSON.stringify(supportedMatches),
      },
      build: {
        outDir: variant.outDir,
        emptyOutDir: true,
        sourcemap: false,
        cssCodeSplit: false,
        minify: false,
        rollupOptions: {
          input: resolve('userscript/entry.ts'),
          output: {
            entryFileNames: 'bilibili-time-machine.user.js',
            inlineDynamicImports: true,
          },
        },
      },
      plugins: [prependUserScriptMetadata(variant.outDir)],
    };
  }

  if (variant?.target === 'extension') {
    const isContent = variant.content === true;
    return {
      define: {
        __TIME_FILTER_DEV__: JSON.stringify(variant.flavor === 'dev'),
      },
      build: {
        outDir: variant.outDir,
        // 两个入口分别打包，避免 Rollup 把共享模块拆成 classic 脚本无法加载的 import chunk。
        emptyOutDir: isContent,
        sourcemap: false,
        cssCodeSplit: false,
        minify: variant.flavor === 'release',
        rollupOptions: {
          input: resolve(isContent ? 'src/runtime/mv3-content.ts' : 'src/runtime/mv3-main-world.ts'),
          output: {
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: isContent ? 'mv3-content.js' : 'mv3-main-world.js',
          },
        },
      },
      plugins: [copyManifest(variant.outDir)],
    };
  }

  if (mode === 'extension') {
    throw new Error('请使用 npm run build:extension（或 build:extension:dev），通过两个独立构建生成 MV3 classic 脚本。');
  }

  return {
    define: {
      __TIME_FILTER_DEV__: JSON.stringify(false),
      __SUPPORTED_BILIBILI_MATCHES__: JSON.stringify(supportedMatches),
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: resolve('userscript/entry.ts'),
      },
    },
  };
});
