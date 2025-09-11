// eslint.config.js
import globals from 'globals';
import js from '@eslint/js';

export default [
  // Use recommended rules
  js.configs.recommended,

  {
    // Define global variables (e.g., Node.js globals like __dirname, process)
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,  // Enables Node.js globals: process, __dirname, etc.
        // Add custom globals if needed, e.g.:
        // ...globals.browser  // if you use browser APIs
      },
    },

    // Rules (override or add more as needed)
    rules: {
      // Example: enforce semi-colons
      semi: ['error', 'always'],
      // Prevent console.log in production (optional)
      'no-console': 'warn',
      // Enforce consistent quotes
      quotes: ['error', 'single'],
    },
  },
];
