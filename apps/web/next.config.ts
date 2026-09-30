import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // `next dev` only trusts `localhost` for HMR; Playwright and most docs here use 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1'],
  // The default bottom-left badge covers the phone bottom navigation.
  devIndicators: { position: 'top-right' },
};

export default config;
