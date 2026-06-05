export interface PdfOperation {
  op: string;
  args: any[];
  rawOutput: Uint8Array;
}

const DECODER = new TextDecoder('latin1');

// Byte categories lookup table
const BYTE_TYPES = new Uint8Array(256);
const TYPE_WHITESPACE = 1;
const TYPE_DELIMITER = 2;
const TYPE_REGULAR = 4;

(function() {
  const whitespace = [0x00, 0x09, 0x0A, 0x0C, 0x0D, 0x20];
  for (const b of whitespace) BYTE_TYPES[b] = TYPE_WHITESPACE;

  const delimiters = [0x28, 0x29, 0x3C, 0x3E, 0x5B, 0x5D, 0x7B, 0x7D, 0x2F];
  for (const b of delimiters) BYTE_TYPES[b] = TYPE_DELIMITER;

  for (let i = 0; i < 256; i++) {
    if (BYTE_TYPES[i] === 0 && i !== 0x25) BYTE_TYPES[i] = TYPE_REGULAR;
  }
})();

function isWhitespace(cc: number) {
  return BYTE_TYPES[cc] === TYPE_WHITESPACE;
}

function isDelimiter(cc: number) {
  return BYTE_TYPES[cc] === TYPE_DELIMITER;
}

function isRegular(cc: number) {
  return BYTE_TYPES[cc] === TYPE_REGULAR;
}

export class PDFStreamParser {
  pos = 0;
  constructor(public bytes: Uint8Array) {}

  skipWhitespace() {
    const bytes = this.bytes;
    while (this.pos < bytes.length && BYTE_TYPES[bytes[this.pos]] === TYPE_WHITESPACE) {
      this.pos++;
    }
  }

  nextOperation(): PdfOperation | null {
    const bytes = this.bytes;
    const startPos = this.pos;
    this.skipWhitespace();
    
    if (this.pos >= bytes.length) {
       if (this.pos > startPos) return { op: 'EOF', args: [], rawOutput: bytes.slice(startPos, this.pos) };
       return null;
    }

    const args: any[] = [];

    while (this.pos < bytes.length) {
      this.skipWhitespace();
      if (this.pos >= bytes.length) break;

      const charCode = bytes[this.pos];
      const tokenStart = this.pos;

      // 0. Comments
      if (charCode === 0x25) { // '%'
        while (this.pos < bytes.length && bytes[this.pos] !== 0x0A && bytes[this.pos] !== 0x0D) {
          this.pos++;
        }
        return { op: 'COMMENT', args: [], rawOutput: bytes.slice(tokenStart, this.pos) };
      }

      // 1. Arrays [ ... ]
      if (charCode === 0x5B) { // '['
        this.pos++;
        let open = 1;
        while (this.pos < bytes.length && open > 0) {
            const cc = bytes[this.pos];
            if (cc === 0x28) { // '(' Literal String
               let sOpen = 1;
               this.pos++;
               while(this.pos < bytes.length && sOpen > 0) {
                  if (bytes[this.pos] === 0x5C) {
                     this.pos += 2;
                     continue;
                  }
                  if (bytes[this.pos] === 0x28) sOpen++;
                  else if (bytes[this.pos] === 0x29) sOpen--;
                  this.pos++;
               }
               continue;
            }
            if (cc === 0x5B) open++;
            else if (cc === 0x5D) open--;
            this.pos++;
        }
        args.push({ type: 'array', rawBytes: bytes.slice(tokenStart, this.pos) });
        continue;
      }
      
      // 2. Dictionaries << ... >>
      if (charCode === 0x3C && bytes[this.pos+1] === 0x3C) { // '<<'
        this.pos += 2;
        let open = 1;
        while(this.pos < bytes.length - 1 && open > 0) {
           const cc = bytes[this.pos];
           if (cc === 0x28) { // '('
              let sOpen = 1; this.pos++;
              while(this.pos < bytes.length && sOpen > 0) {
                 if (bytes[this.pos] === 0x5C) { this.pos += 2; continue; }
                 if (bytes[this.pos] === 0x28) sOpen++;
                 else if (bytes[this.pos] === 0x29) sOpen--;
                 this.pos++;
              }
           } else if (cc === 0x3C) { // '<'
              if (bytes[this.pos+1] === 0x3C) { // '<<'
                 open++; this.pos += 2;
              } else { // Hex String '<'
                 this.pos++;
                 while(this.pos < bytes.length && bytes[this.pos] !== 0x3E) this.pos++;
                 if (this.pos < bytes.length) this.pos++;
              }
           } else if (cc === 0x3E && bytes[this.pos+1] === 0x3E) { // '>>'
              open--; this.pos += 2;
           } else {
              this.pos++;
           }
        }
        args.push({ type: 'dict', rawBytes: bytes.slice(tokenStart, this.pos) });
        continue;
      }

      // 3. Hex Strings < ... >
      if (charCode === 0x3C) { // '<'
        this.pos++;
        while(this.pos < bytes.length && bytes[this.pos] !== 0x3E) {
          this.pos++;
        }
        if (this.pos < bytes.length) { this.pos++; }
        args.push({ type: 'hexstring', rawBytes: bytes.slice(tokenStart, this.pos) });
        continue;
      }

      // 4. Literal Strings ( ... )
      if (charCode === 0x28) { // '('
        let open = 1;
        this.pos++;
        while(this.pos < bytes.length && open > 0) {
          if (bytes[this.pos] === 0x5C) {
             this.pos += 2;
             continue;
          }
          if (bytes[this.pos] === 0x28) open++;
          else if (bytes[this.pos] === 0x29) open--;
          this.pos++;
        }
        args.push({ type: 'string', rawBytes: bytes.slice(tokenStart, this.pos) });
        continue;
      }

      // 5. Names /Name
      if (charCode === 0x2F) { // '/'
        this.pos++;
        while(this.pos < bytes.length && BYTE_TYPES[bytes[this.pos]] === TYPE_REGULAR) this.pos++;
        const nameBytes = bytes.subarray(tokenStart, this.pos);
        args.push({ type: 'name', value: DECODER.decode(nameBytes) });
        continue;
      }

      // 6. Numbers or Operators
      while(this.pos < bytes.length && BYTE_TYPES[bytes[this.pos]] === TYPE_REGULAR) {
        this.pos++;
      }
      
      if (this.pos === tokenStart && this.pos < bytes.length) {
        this.pos++;
      }

      const tokenBytes = bytes.subarray(tokenStart, this.pos);
      const tokenRaw = DECODER.decode(tokenBytes);
      
      // Fast check for number
      const first = tokenBytes[0];
      if ((first >= 0x30 && first <= 0x39) || first === 0x2D || first === 0x2B || first === 0x2E) {
        if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(tokenRaw)) {
          args.push(parseFloat(tokenRaw));
          continue;
        }
      }

      if (tokenRaw === 'BI') {
         while(this.pos < bytes.length - 2) {
           if (bytes[this.pos] === 0x45 && bytes[this.pos+1] === 0x49 && BYTE_TYPES[bytes[this.pos+2]] === TYPE_WHITESPACE) {
              if (BYTE_TYPES[bytes[this.pos-1]] === TYPE_WHITESPACE) {
                 this.pos += 2; 
                 break;
              }
           }
           this.pos++;
         }
         return { op: 'INLINE_IMAGE', args: [], rawOutput: bytes.slice(startPos, this.pos) };
      }

      return {
         op: tokenRaw,
         args,
         rawOutput: bytes.slice(startPos, this.pos)
      };
    }
    
    return {
       op: 'EOF',
       args,
       rawOutput: bytes.slice(startPos, this.pos)
    };
  }
}

