/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MediaPipe WASM runtime is served from a CDN at runtime; keep it out of
  // the bundler's dependency graph so builds stay fast and portable.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
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
