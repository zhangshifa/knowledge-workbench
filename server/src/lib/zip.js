import zlib from 'node:zlib';

/**
 * 极简 ZIP 读取器（零依赖）。
 * 支持 DEFLATE(8) 与 STORE(0)，覆盖 .docx / .xlsx 这类 OOXML 容器。
 * 不支持加密、不支持 ZIP64（Office 文件通常不需要）。
 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEOCD(buf);
  if (!eocd) throw new Error('不是合法的 ZIP 文件（未找到 EOCD）');

  const cdOffset = eocd.cdOffset;
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < eocd.entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, lho, flags, _extraLen: extraLen, _commentLen: commentLen });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    names() {
      return entries.map((e) => e.name);
    },
    has(name) {
      return entries.some((e) => e.name === name);
    },
    readBuffer(name) {
      const e = entries.find((x) => x.name === name);
      if (!e) return null;
      const lh = e.lho;
      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + nameLen + extraLen;
      const comp = buf.slice(dataStart, dataStart + e.compSize);
      if (e.method === 0) return comp;
      if (e.method === 8) {
        if (e.flags & 0x08) {
          try {
            return zlib.inflateRawSync(comp);
          } catch {
            /* 回退到带头 inflate */
          }
        }
        return zlib.inflateRawSync(comp);
      }
      throw new Error(`不支持的压缩方式: ${e.method}`);
    },
    readText(name) {
      const b = this.readBuffer(name);
      return b ? b.toString('utf8') : null;
    }
  };
}

function findEOCD(buf) {
  // EOCD 最小 22 字节；comment 可能更长，从尾部向前扫描
  const min = 22;
  if (buf.length < min) return null;
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - min - maxComment);
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return {
        entries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16)
      };
    }
  }
  return null;
}
