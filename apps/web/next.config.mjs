import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(appDir, '../..');
const appNodeModules = path.join(appDir, 'node_modules');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Vercel rootDirectory is apps/web; packages live one level above.
  outputFileTracingRoot: repoRoot,
  transpilePackages: [
    '@ai-pushup-coach/types',
    '@ai-pushup-coach/pose',
    '@ai-pushup-coach/biomechanics',
    '@ai-pushup-coach/rep-counter',
    '@ai-pushup-coach/form-engine',
    '@ai-pushup-coach/coach-engine',
  ],
  // The MediaPipe WASM runtime is served from a CDN at runtime; keep it out of
  // the bundler's dependency graph so builds stay fast and portable.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
    // Packages outside apps/web import @mediapipe from this app's node_modules.
    config.resolve.modules = [appNodeModules, ...(config.resolve.modules || ['node_modules'])];
    config.resolve.alias = {
      ...config.resolve.alias,
      '@mediapipe/tasks-vision': path.join(appNodeModules, '@mediapipe/tasks-vision'),
    };
    return config;
  },
  async headers() {
    return [
      {
        // Allow the app to use the camera on the same origin only.
        source: '/(.*)',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=()' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
