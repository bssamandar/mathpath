'use client';

import { useMemo } from 'react';
import { qrPath } from '../lib/mfa';

/** A QR code as inline SVG: crisp at any size and allowed by the CSP. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.d} fill="#000000" />
    </svg>
  );
}
