// pkt-line framing for the git smart-HTTP protocols: 4-hex-length packets, the 0000 flush,
// 0001 delim and 0002 response-end control packets, and sideband (band 1 data, band 2
// progress) wrapping for pack and report streams.

export const PKT_LINE_MAX = 65520;

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export class PktError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktError';
  }
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new PktError('pkt-line payload exceeds the maximum');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode packets from the start of `buffer`. Stops at `stopAtFlush` (consuming the flush)
 * when set, or at the first malformed header. Returns the packets and the offset just past
 * the last consumed byte, so a caller can treat the rest as raw pack data.
 */
export function decodePackets(
  buffer: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PktError('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new PktError(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush === true) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new PktError(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new PktError('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

/** The text of every data packet, in order. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Wrap `data` in sideband packets of the given band, chunked under the pkt-line maximum. */
export function sideband(data: Buffer, band: 1 | 2): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}
