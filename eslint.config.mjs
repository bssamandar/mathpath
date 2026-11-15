// Root ESLint flat config shared by every workspace.
// Security-relevant rules are commented with the control ID from
// docs/security/security-plan.md so it is clear why they exist.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // C-11: never build SQL from strings; Kysely's sql.raw bypasses parameterisation.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='sql'][property.name='raw']",
          message: 'sql.raw is banned (security plan C-11). Use parameterised Kysely queries.',
        },
      ],
      // C-13: React already escapes output; raw HTML injection needs a security review.
      'no-restricted-properties': [
        'error',
        { property: 'dangerouslySetInnerHTML', message: 'Banned (security plan C-13).' },
      ],
    },
  },
  {
    // C-16: the question engine knows the answers and must never be bundled
    // into a browser app. Only the API, the worker and tests may import it.
    files: ['apps/web/**', 'apps/studio/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mathpath/question-engine', '@mathpath/question-engine/*'],
              message: 'question-engine is server-only (security plan C-16).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
