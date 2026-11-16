import type { NextConfig } from 'next';

/**
 * Security headers (security plan C-15). The Content-Security-Policy is set in
 * middleware.ts, because it carries a per-request nonce.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/**
 * The browser calls /api on the web origin, so the session cookies stay
 * first-party (`__Host-` cookies cannot be shared across hosts) and no CORS is
 * needed. In production the edge proxy routes /api straight to the API, so
 * web and mobile requests reach it through the same number of proxies and the
 * client IP is read the same way (TRUST_PROXY_HOPS). Locally, Next.js forwards
 * /api itself; set API_ORIGIN to do the same elsewhere.
 */
const apiOrigin =
  process.env.API_ORIGIN ??
  (process.env.NODE_ENV === 'production' ? null : 'http://localhost:4000');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    return apiOrigin ? [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] : [];
  },
};

export default nextConfig;
