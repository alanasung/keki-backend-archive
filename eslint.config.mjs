import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.sst/**',
      '**/.open-next/**',
      '**/dist/**',
      '**/coverage/**',
      'build-logs/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Module boundary: packages/*-core are plain TypeScript libraries and
    // must not import from apps/** (see AGENTS.md Conventions → Module boundaries).
    files: ['packages/*-core/**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/*-core',
              from: './apps',
              message: 'packages/*-core must not import from apps/** (module boundary).',
            },
          ],
        },
      ],
    },
  },
);
