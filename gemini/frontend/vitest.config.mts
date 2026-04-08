import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
    
    // Vitest 4 Pool Configuration
    pool: 'forks',
    
    // Crucial for resolving ESM/CJS conflicts with Tailwind 4 deps on Windows
    server: {
      deps: {
        inline: [
          '@csstools/css-calc',
          '@asamuzakjp/css-color',
          'tailwindcss',
          '@tailwindcss/vite'
        ]
      }
    },
    
    // Optimizer settings for Vitest 4
    deps: {
      optimizer: {
        web: {
          enabled: true,
          include: ['react', 'react-dom']
        }
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
