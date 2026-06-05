export interface PdfOperation {
  op: string;
  args: any[];
  rawOutput: Uint8Array;
}

function isWhitespace(cc: number) {
  return cc === 0x00 || cc === 0x09 || cc === 0x0A || cc === 0x0C || cc === 0x0D || cc === 0x20;
}

function isDelimiter(cc: number) {
  // ( ) < > [ ] { } /
  return cc === 0x28 || cc === 0x29 || cc === 0x3C || cc === 0x3E || cc === 0x5B || cc === 0x5D || cc === 0x7B || cc === 0x7D || cc === 0x2F; 
}

function isRegular(cc: number) {
  // Delimiters except '%' which starts a comment
  return !isWhitespace(cc) && !isDelimiter(cc) && cc !== 0x25;
}

const DECODER = new TextDecoder('latin1');

export class PDFStreamParser {
  pos = 0;
  constructor(public bytes: Uint8Array) {}

  skipWhitespace() {
    while (this.pos < this.bytes.length && isWhitespace(this.bytes[this.pos]!)) {
      this.pos++;
    }
  }

  nextOperation(): PdfOperation | null {
    const startPos = this.pos;
    this.skipWhitespace();
    if (this.pos >= this.bytes.length) {
       if (this.pos > startPos) return { op: 'EOF', args: [], rawOutput: this.bytes.slice(startPos, this.pos) };
       return null;
    }

    const args: any[] = [];

    while (this.pos < this.bytes.length) {
      this.skipWhitespace();
      if (this.pos >= this.bytes.length) break;

      const charCode = this.bytes[this.pos]!;
      const tokenStart = this.pos;

      // 0. Comments
      if (charCode === 0x25) { // '%'
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0A && this.bytes[this.pos] !== 0x0D) {
          this.pos++;
        }
        return { op: 'COMMENT', args: [], rawOutput: this.bytes.slice(tokenStart, this.pos) };
      }

      // 1. Arrays [ ... ]
      if (charCode === 0x5B) { // '['
        this.pos++;
        let open = 1;
        while (this.pos < this.bytes.length && open > 0) {
            const cc = this.bytes[this.pos]!;
            if (cc === 0x28) { // '(' Literal String
               let sOpen = 1;
               this.pos++;
               while(this.pos < this.bytes.length && sOpen > 0) {
                  if (this.bytes[this.pos] === 0x5C) {
                     this.pos += 2;
                     continue;
                  }
                  if (this.bytes[this.pos] === 0x28) sOpen++;
                  if (this.bytes[this.pos] === 0x29) sOpen--;
                  this.pos++;
               }
               continue;
            }
            if (cc === 0x5B) open++;
            if (cc === 0x5D) open--;
            this.pos++;
        }
        const arrRaw = this.bytes.slice(tokenStart, this.pos);
        args.push({ type: 'array', rawBytes: arrRaw });
        continue;
      }
      
      // 2. Dictionaries << ... >>
      if (charCode === 0x3C && this.bytes[this.pos+1] === 0x3C) { // '<<'
        this.pos += 2;
        let open = 1;
        while(this.pos < this.bytes.length - 1 && open > 0) {
           const cc = this.bytes[this.pos]!;
           if (cc === 0x28) { // '('
              let sOpen = 1; this.pos++;
              while(this.pos < this.bytes.length && sOpen > 0) {
                 if (this.bytes[this.pos] === 0x5C) { this.pos += 2; continue; }
                 if (this.bytes[this.pos] === 0x28) sOpen++;
                 if (this.bytes[this.pos] === 0x29) sOpen--;
                 this.pos++;
              }
           } else if (cc === 0x3C) { // '<'
              if (this.bytes[this.pos+1] === 0x3C) { // '<<'
                 open++; this.pos += 2;
              } else { // Hex String '<'
                 this.pos++;
                 while(this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3E) this.pos++;
                 if (this.pos < this.bytes.length) this.pos++;
              }
           } else if (cc === 0x3E && this.bytes[this.pos+1] === 0x3E) { // '>>'
              open--; this.pos += 2;
           } else {
              this.pos++;
           }
        }
        const dictRaw = this.bytes.slice(tokenStart, this.pos);
        args.push({ type: 'dict', rawBytes: dictRaw });
        continue;
      }

      // 3. Hex Strings < ... >
      if (charCode === 0x3C) { // '<'
        this.pos++;
        while(this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3E) {
          this.pos++;
        }
        if (this.pos < this.bytes.length) { this.pos++; }
        const hexRaw = this.bytes.slice(tokenStart, this.pos);
        args.push({ type: 'hexstring', rawBytes: hexRaw });
        continue;
      }

      // 4. Literal Strings ( ... )
      if (charCode === 0x28) { // '('
        let open = 1;
        this.pos++;
        while(this.pos < this.bytes.length && open > 0) {
          if (this.bytes[this.pos] === 0x5C) {
             this.pos += 2;
             continue;
          }
          if (this.bytes[this.pos] === 0x28) open++;
          if (this.bytes[this.pos] === 0x29) open--;
          this.pos++;
        }
        const strRaw = this.bytes.slice(tokenStart, this.pos);
        args.push({ type: 'string', rawBytes: strRaw });
        continue;
      }

      // 5. Names /Name
      if (charCode === 0x2F) { // '/'
        this.pos++;
        while(this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) this.pos++;
        const nameBytes = this.bytes.slice(tokenStart, this.pos);
        args.push({ type: 'name', value: DECODER.decode(nameBytes) });
        continue;
      }

      // 6. Numbers or Operators
      while(this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) {
        this.pos++;
      }
      
      if (this.pos === tokenStart && this.pos < this.bytes.length) {
        this.pos++;
      }

      const tokenBytes = this.bytes.slice(tokenStart, this.pos);
      const tokenRaw = DECODER.decode(tokenBytes);
      
      if (tokenRaw && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(tokenRaw)) {
        args.push(parseFloat(tokenRaw));
        continue;
      }

      const op = tokenRaw;
      
      if (op === 'BI') {
         while(this.pos < this.bytes.length - 2) {
           if (this.bytes[this.pos] === 0x45 && this.bytes[this.pos+1] === 0x49 && isWhitespace(this.bytes[this.pos+2]!)) {
              if (isWhitespace(this.bytes[this.pos-1]!)) {
                 this.pos += 2; 
                 break;
              }
           }
           this.pos++;
         }
         return { op: 'INLINE_IMAGE', args: [], rawOutput: this.bytes.slice(startPos, this.pos) };
      }

      return {
         op,
         args,
         rawOutput: this.bytes.slice(startPos, this.pos)
      };
    }
    
    return {
       op: 'EOF',
       args,
       rawOutput: this.bytes.slice(startPos, this.pos)
    };
  }
}
