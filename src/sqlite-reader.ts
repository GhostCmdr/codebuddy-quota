import * as fs from 'node:fs';

/**
 * 从 state.vscdb 里按键取值。刻意不引入 sqlite 依赖、直接按 SQLite 页面格式解析，
 * 因此全程没有任何 SQL 字符串，也就不存在拼接注入面。
 *
 * 文件损坏或被截断时页面偏移会越界（实测抛 ERR_OUT_OF_RANGE），所以把解析整体兜住：
 * 读不出来就当没读到，不让它把上层「逐个宿主扫登录态」的流程整个打断。
 */
export function readValueByKeyMatch(filePath: string, match: (key: string) => boolean): string | undefined {
  let buf: Buffer;
  try { buf = fs.readFileSync(filePath); } catch { return undefined; }
  try {
    return readValueFromBuffer(buf, match);
  } catch {
    return undefined;
  }
}

function readValueFromBuffer(buf: Buffer, match: (key: string) => boolean): string | undefined {
  if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    return undefined;
  }
  const pageSize = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
  const reserved = buf[20];
  const usable = pageSize - reserved;
  if (pageSize <= 0 || usable <= 0) return undefined;
  const page = (no: number) => buf.subarray((no - 1) * pageSize, no * pageSize);
  const headerOffset = (no: number) => (no === 1 ? 100 : 0);
  const varint = (b: Buffer, off: number): { value: number; length: number } => {
    let value = 0;
    for (let i = 0; i < 9; i++) {
      const byte = b[off + i];
      if (i === 8) return { value: value * 256 + byte, length: 9 };
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return { value, length: i + 1 };
    }
    return { value, length: 1 };
  };
  const payloadAt = (pg: Buffer, cellOff: number): Buffer => {
    const size = varint(pg, cellOff);
    const rowid = varint(pg, cellOff + size.length);
    const start = cellOff + size.length + rowid.length;
    const total = size.value;
    const maxLocal = usable - 35;
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let localSize = total;
    if (total > maxLocal) {
      localSize = minLocal + ((total - minLocal) % (usable - 4));
      if (localSize > maxLocal) localSize = minLocal;
    }
    const local = pg.subarray(start, start + localSize);
    if (total <= maxLocal) return Buffer.from(local);
    const chunks = [Buffer.from(local)];
    let remaining = total - localSize;
    let next = pg.readUInt32BE(start + localSize);
    while (next !== 0 && remaining > 0) {
      const p = page(next);
      const take = Math.min(usable - 4, remaining);
      chunks.push(Buffer.from(p.subarray(4, 4 + take)));
      remaining -= take;
      next = p.readUInt32BE(0);
    }
    return Buffer.concat(chunks);
  };
  const parseRecord = (payload: Buffer): any[] => {
    const head = varint(payload, 0);
    const serials: number[] = [];
    let off = head.length;
    while (off < head.value) {
      const v = varint(payload, off);
      serials.push(v.value);
      off += v.length;
    }
    const INT_SIZES = [0, 1, 2, 3, 4, 6, 8];
    const out: any[] = [];
    let vo = head.value;
    for (const t of serials) {
      if (t === 0) out.push(undefined);
      else if (t >= 1 && t <= 6) {
        const n = INT_SIZES[t];
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + payload[vo + i];
        out.push(v);
        vo += n;
      } else if (t === 7) {
        out.push(payload.readDoubleBE(vo));
        vo += 8;
      } else if (t === 8) out.push(0);
      else if (t === 9) out.push(1);
      else if (t >= 12) {
        const n = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
        out.push(payload.subarray(vo, vo + n).toString('utf8'));
        vo += n;
      } else out.push(undefined);
    }
    return out;
  };
  const walk = (pageNo: number, visit: (cols: any[]) => any): any => {
    const pg = page(pageNo);
    const h = headerOffset(pageNo);
    if (pg.length < h + 8) return undefined;
    const type = pg[h];
    const numCells = pg.readUInt16BE(h + 3);
    if (type === 13) {
      for (let i = 0; i < numCells; i++) {
        const cellOff = pg.readUInt16BE(h + 8 + i * 2);
        if (cellOff + 2 > pg.length) continue;
        const r = visit(parseRecord(payloadAt(pg, cellOff)));
        if (r !== undefined) return r;
      }
      return undefined;
    }
    if (type === 5) {
      for (let i = 0; i < numCells; i++) {
        const child = pg.readUInt32BE(pg.readUInt16BE(h + 12 + i * 2));
        const r = walk(child, visit);
        if (r !== undefined) return r;
      }
      return walk(pg.readUInt32BE(h + 8), visit);
    }
    return undefined;
  };
  const rootPage = walk(1, (cols) => (cols[1] === 'ItemTable' ? Number(cols[3]) : undefined));
  if (!rootPage) return undefined;
  return walk(rootPage, (cols) => {
    const key = cols[0];
    if (typeof key !== 'string' || !match(key)) return undefined;
    const value = cols[1];
    return typeof value === 'string' ? value : undefined;
  });
}
