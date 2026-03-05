export const LATIN1 = new TextDecoder('latin1');

export const encode = (s: string) => {
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
};

export const resolveName = (obj: any): string => {
  if (!obj) return "";
  if (typeof obj.asString === 'function') return obj.asString().replace(/^\//, '');
  return String(obj).replace(/^\//, '');
};

export function parsePdfString(bytes: Uint8Array, isMultiByte: boolean = false) {
  const chars: Array<{ start: number; len: number; value: number }> = [];
  if (bytes[0] === 0x3C) { // '<'
    const s = LATIN1.decode(bytes);
    const hex = s.slice(1, -1).replace(/\s/g, '');
    let pos = 1;
    const step = isMultiByte ? 4 : 2;
    for (let i = 0; i < hex.length; i += step) {
      const start = pos;
      let valStr = "";
      for (let j = 0; j < step && i + j < hex.length; j++) {
        while (pos < s.length && !/[0-9a-fA-F]/.test(s[pos]!)) pos++;
        if (pos < s.length) { valStr += s[pos]; pos++; }
      }
      chars.push({ start, len: pos - start, value: parseInt(valStr.padEnd(step, '0'), 16) });
    }
  } else {
    for (let i = 1; i < bytes.length - 1; i++) {
      let len = 1;
      let val = bytes[i]!;
      if (val === 0x5C) { // '\'
        const next = bytes[i + 1] || 0;
        if (next >= 0x30 && next <= 0x37) { // 0-7
          const sub = bytes.slice(i + 1, i + 4);
          const sSub = LATIN1.decode(sub);
          const m = sSub.match(/[0-7]+/);
          const oct = m ? m[0] : "";
          len = 1 + oct.length;
          val = parseInt(oct, 8);
        } else {
          len = 2;
          if (next === 0x6E) val = 10; // n
          else if (next === 0x72) val = 13; // r
          else if (next === 0x74) val = 9; // t
          else if (next === 0x62) val = 8; // b
          else if (next === 0x66) val = 12; // f
          else val = next;
        }
      }
      
      if (isMultiByte) {
         // This part is for non-hex multi-byte strings.
         // Usually multi-byte strings in PDF are either Hex or use a specific CMap.
         // If they are not hex, they are just a sequence of bytes.
         // We'll take the next byte too.
         const nextByte = bytes[i + len] || 0;
         val = (val << 8) | nextByte;
         len += 1; 
      }

      chars.push({ start: i, len, value: val });
      i += (len - 1);
    }
  }
  return chars;
}

export const concatUint8Arrays = (arrays: Uint8Array[]) => {
  const total = arrays.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of arrays) { result.set(c, off); off += c.length; }
  return result;
};
