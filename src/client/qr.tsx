/**
 * Local QR rendering for the pairing payload.
 *
 * The matrix is produced in the browser by the bundled `qrcode-generator`
 * package and drawn as one SVG path; no image request, canvas, or third-party
 * QR service is involved. Fixed black-on-white keeps the code scannable in
 * both themes (artwork colors are allowed to stand apart from theme tokens).
 */

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export interface QrCodeProps {
  /** Exact payload text to encode. */
  text: string;
  /** Rendered square edge in CSS pixels. */
  size?: number;
  /** Accessible description. */
  label: string;
}

/** Quiet zone around the symbol, in modules. */
const QUIET = 4;

/** Render one pairing payload as a local SVG QR code. */
export function QrCode({ text, size = 240, label }: QrCodeProps) {
  const matrix = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    return code;
  }, [text]);

  const count = matrix.getModuleCount();
  const total = count + QUIET * 2;
  const path = useMemo(() => {
    const parts: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (matrix.isDark(row, column)) parts.push(`M${column + QUIET} ${row + QUIET}h1v1h-1z`);
      }
    }
    return parts.join('');
  }, [matrix, count]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ display: 'block', background: '#ffffff', borderRadius: 8 }}
    >
      <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
