import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'MathPath Studio',
};

/** Root layout. The language attribute follows the user's locale once i18n lands (step 6.3). */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz-Latn">
      <body>{children}</body>
    </html>
  );
}
