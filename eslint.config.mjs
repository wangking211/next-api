import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 工程治理：全仓统一 lint（flat config / ESLint 9）。
 * - 只管正确性与一致性问题；代码风格交给 Prettier（`pnpm format`），两边规则不冲突
 * - 不做 type-aware 检查（tsc typecheck 已覆盖类型维度，保持 lint 快速）
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'apps/web/.next/**',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // React 应用：hooks 规则抓真实的 Hook 使用错误（exhaustive-deps 先告警不阻断）
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', 'tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    rules: {
      // 上游载荷/express 扩展等场景大量使用 any，类型安全由 tsc 与 Review 把关
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
);
