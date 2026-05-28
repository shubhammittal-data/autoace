/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins: ['*'] },
    serverComponentsExternalPackages: ['playwright-core', 'playwright', 'chromium-bidi'],
  },
};

export default nextConfig;
