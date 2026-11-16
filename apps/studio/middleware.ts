import { type NextRequest, NextResponse } from 'next/server';
import { studioCsp } from './lib/csp';

/**
 * Content-Security-Policy with a fresh nonce per request. Next.js reads the
 * nonce from the request's CSP header and adds it to its own scripts.
 * MEDIA_ORIGIN is the storage host browsers upload to (S3_PUBLIC_ENDPOINT).
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = studioCsp(nonce, {
    dev: process.env.NODE_ENV !== 'production',
    mediaOrigin: process.env.MEDIA_ORIGIN,
  });

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // API calls are proxied and get their headers from the API; static files need no nonce.
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
