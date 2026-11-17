import { type NextRequest, NextResponse } from 'next/server';

/**
 * Content-Security-Policy with a fresh nonce per request (security plan C-15).
 *
 * Next.js reads the nonce from the request's CSP header and adds it to its
 * own scripts. 'strict-dynamic' lets those scripts load the Turnstile widget
 * without listing every Cloudflare script URL. 'unsafe-eval' is added only in
 * development, where React's tooling needs it.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  // Video segments and subtitles come straight from storage (presigned URLs).
  const media = mediaOrigin(process.env.MEDIA_ORIGIN);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React sets style attributes; inline styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${media}`,
    // hls.js feeds the <video> through MediaSource (blob:) and may use a worker.
    `media-src 'self' blob:${media}`,
    "worker-src 'self' blob:",
    'frame-src https://challenges.cloudflare.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

/** ` scheme://host[:port]` of an http(s) URL, or '' when unset or invalid. */
function mediaOrigin(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? ` ${parsed.origin}` : '';
  } catch {
    return '';
  }
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
