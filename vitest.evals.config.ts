import { defineConfig } from 'vitest/config'

// Separate from vitest.config.ts on purpose: eval code uses fs/process, which do not
// exist in the Workers pool the agent's own tests run in.
export default defineConfig({
  test: {
    include: ['evals/**/*.test.ts'],
    environment: 'node',
  },
})
