// Binary frame envelope used on every WebSocket: [u16 headerLen BE][JSON header][JPEG bytes]
// Header: { seq, ts (sender clock ms), w?, h?, src?, motion? (0..1 frame-to-frame change measured by the sender) }

export interface FrameHeader {
  seq: number;
  ts: number;
  w?: number;
  h?: number;
  src?: string;
  motion?: number;
  [k: string]: unknown;
}

export interface Frame {
  header: FrameHeader;
  jpeg: Buffer;
  recv_ts: number; // server clock (Date.now()) when the frame arrived
}

export function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(2 + h.length + jpeg.length);
  out.writeUInt16BE(h.length, 0);
  h.copy(out, 2);
  jpeg.copy(out, 2 + h.length);
  return out;
}

export function decodeFrame(buf: Buffer, recv_ts = Date.now()): Frame | null {
  if (buf.length < 4) return null;
  // Raw JPEG without envelope (starts with SOI marker) is accepted too.
  if (buf[0] === 0xff && buf[1] === 0xd8) return { header: { seq: 0, ts: recv_ts }, jpeg: buf, recv_ts };
  const n = buf.readUInt16BE(0);
  if (2 + n > buf.length) return null;
  try {
    const header = JSON.parse(buf.subarray(2, 2 + n).toString('utf8')) as FrameHeader;
    const jpeg = buf.subarray(2 + n);
    if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) return null;
    return { header, jpeg, recv_ts };
  } catch {
    return null;
  }
}
