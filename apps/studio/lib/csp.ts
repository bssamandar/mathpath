/**
 * The studio's Content-Security-Policy (security plan C-15). Like the web app,
 * plus the storage origin: video uploads go straight from the browser to
 * presigned URLs on S3-compatible storage, so connect-src must allow it.
 */
export function studioCsp(
  nonce: string,
  { dev, mediaOrigin }: { dev: boolean; mediaOrigin?: string },
) {
  const media = originOf(mediaOrigin);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React sets style attributes; inline styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${media ? ` ${media}` : ''}`,
    'frame-src https://challenges.cloudflare.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** `scheme://host[:port]` of a URL, or undefined when it is missing or not http(s). */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
