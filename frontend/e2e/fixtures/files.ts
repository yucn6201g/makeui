/** Files a test attaches, made in memory. */

/** A 1×1 PNG: small, valid, and decodable by the browser. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function png(name: string) {
  return { name, mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') };
}

export function csv(name: string, rows: string[][]) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8') };
}
