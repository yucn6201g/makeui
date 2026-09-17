/**
 * A minimal ZIP writer.
 *
 * Written rather than pulled in: the whole need is "put these text files in an
 * archive the OS can open", and the stored (uncompressed) ZIP format is a short,
 * stable spec. A library would add a dependency and a chunk to the bundle for
 * something the generated projects — a few dozen small text files — do not need
 * compression for.
 *
 * Stored entries only, no data descriptors, no ZIP64. That is within spec and is
 * read by Explorer, Finder, and every unzip implementation.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * DOS date/time, which is what the ZIP header carries.
 *
 * Two-second resolution and a 1980 epoch are the format's, not ours. Dates before
 * 1980 cannot be represented, so they are clamped rather than written as garbage.
 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  path: string;
  content: string;
}

export function createZip(entries: ZipEntry[], now: Date = new Date()): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    // Bit 11 marks the name as UTF-8, which every path here may be.
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);            // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // offset of local header
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  // Copied into one contiguous buffer: TypeScript's BlobPart cannot accept a
  // Uint8Array whose backing store might be a SharedArrayBuffer, and a single
  // allocation is cheaper than the many the spread would make anyway.
  const total = locals.reduce((n, b) => n + b.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return new Blob([out], { type: 'application/zip' });
}

/** Derive a filesystem-safe archive name from the project title. */
export function zipFileName(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    /*
     * Leading and trailing dots go too, and they are the reason this line
     * exists rather than the reason it is tidy: a title starting with one
     * produces a hidden file on macOS and Linux, and a title of nothing but
     * dots produced `....zip`, which Windows will not create at all. Found by
     * the round-trip test, not by a user.
     */
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return `${slug || 'makeui-project'}.zip`;
}
