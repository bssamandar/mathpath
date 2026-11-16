import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Render per request: Next.js can only add the CSP nonce (middleware.ts) to
 * pages it renders on demand; prerendered pages would have their scripts blocked.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'MathPath Studio',
  robots: { index: false, follow: false },
};

/** Root layout. Studio staff work in Uzbek for now; the content itself carries its own `lang`. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz-Latn">
      <body>{children}</body>
    </html>
  );
}
