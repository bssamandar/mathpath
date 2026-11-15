// Enforces Conventional Commits (feat:, fix:, docs:, refactor:, test:, chore:, ci:...).
// See CONTRIBUTING.md for the scopes we use.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow the long trailer lines (Co-Authored-By, URLs) in commit bodies.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
