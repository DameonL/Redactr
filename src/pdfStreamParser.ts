export interface PdfOperation {
  op: string;
  args: any[];
  rawOutput: string;
}

function isWhitespace(cc: number) {
  return cc === 0x00 || cc === 0x09 || cc === 0x0A || cc === 0x0C || cc === 0x0D || cc === 0x20;
}

function isDelimiter(cc: number) {
  // ( ) < > [ ] { } / %
  return cc === 0x28 || cc === 0x29 || cc === 0x3C || cc === 0x3E || cc === 0x5B || cc === 0x5D || cc === 0x7B || cc === 0x7D || cc === 0x2F || cc === 0x25; 
}

function isRegular(cc: number) {
  return !isWhitespace(cc) && !isDelimiter(cc);
}

export class PDFStreamParser {
  pos = 0;
  constructor(public str: string) {}

  skipWhitespace() {
    while (this.pos < this.str.length && isWhitespace(this.str.charCodeAt(this.pos))) {
      this.pos++;
    }
  }

  nextOperation(): PdfOperation | null {
    this.skipWhitespace();
    if (this.pos >= this.str.length) return null;

    const startPos = this.pos;
    const args: any[] = [];
    const rawArgs: string[] = [];

    while (this.pos < this.str.length) {
      this.skipWhitespace();
      if (this.pos >= this.str.length) break;

      const char = this.str[this.pos];
      const tokenStart = this.pos;

      // 1. Arrays [ ... ]
      if (char === '[') {
        this.pos++;
        let arrRaw = '[';
        let open = 1;
        while (this.pos < this.str.length && open > 0) {
            if (this.str[this.pos] === '(') {
               let sOpen = 1;
               arrRaw += this.str[this.pos++];
               while(this.pos < this.str.length && sOpen > 0) {
                  if (this.str[this.pos] === '\\') {
                     arrRaw += this.str[this.pos++] + (this.str[this.pos] || '');
                     this.pos++;
                     continue;
                  }
                  if (this.str[this.pos] === '(') sOpen++;
                  if (this.str[this.pos] === ')') sOpen--;
                  arrRaw += this.str[this.pos++];
               }
               continue;
            }
            if (this.str[this.pos] === '[') open++;
            if (this.str[this.pos] === ']') open--;
            arrRaw += this.str[this.pos];
            this.pos++;
        }
        args.push({ type: 'array', raw: arrRaw });
        rawArgs.push(arrRaw);
        continue;
      }
      
      // 2. Dictionaries << ... >>
      if (char === '<' && this.str[this.pos+1] === '<') { 
        this.pos += 2;
        let dictRaw = '<<';
        while(this.pos < this.str.length - 1 && !(this.str[this.pos] === '>' && this.str[this.pos+1] === '>')) {
           dictRaw += this.str[this.pos];
           this.pos++;
        }
        dictRaw += '>>';
        this.pos += 2;
        args.push({ type: 'dict', raw: dictRaw });
        rawArgs.push(dictRaw);
        continue;
      }

      // 3. Hex Strings < ... >
      if (char === '<') { 
        this.pos++;
        let hexRaw = '<';
        while(this.pos < this.str.length && this.str[this.pos] !== '>') {
          hexRaw += this.str[this.pos];
          this.pos++;
        }
        if (this.pos < this.str.length) { hexRaw += '>'; this.pos++; }
        args.push({ type: 'hexstring', raw: hexRaw });
        rawArgs.push(hexRaw);
        continue;
      }

      // 4. Literal Strings ( ... )
      if (char === '(') { 
        let strRaw = '(';
        let open = 1;
        this.pos++;
        while(this.pos < this.str.length && open > 0) {
          if (this.str[this.pos] === '\\') {
             strRaw += '\\' + (this.str[this.pos+1] || '');
             this.pos += 2;
             continue;
          }
          if (this.str[this.pos] === '(') open++;
          if (this.str[this.pos] === ')') open--;
          strRaw += this.str[this.pos];
          this.pos++;
        }
        args.push({ type: 'string', raw: strRaw });
        rawArgs.push(strRaw);
        continue;
      }

      // 5. Names /Name
      if (char === '/') { 
        this.pos++;
        while(this.pos < this.str.length && isRegular(this.str.charCodeAt(this.pos))) this.pos++;
        const nameRaw = this.str.substring(tokenStart, this.pos);
        args.push({ type: 'name', value: nameRaw });
        rawArgs.push(nameRaw);
        continue;
      }

      // 6. Numbers or Operators
      while(this.pos < this.str.length && isRegular(this.str.charCodeAt(this.pos))) {
        this.pos++;
      }
      const tokenRaw = this.str.substring(tokenStart, this.pos);
      
      if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(tokenRaw)) {
        args.push(parseFloat(tokenRaw));
        rawArgs.push(tokenRaw);
        continue;
      }

      // Operator!
      const op = tokenRaw;
      
      // Inline Image Trap Door
      if (op === 'BI') {
         while(this.pos < this.str.length - 2) {
           if (this.str[this.pos] === 'E' && this.str[this.pos+1] === 'I' && isWhitespace(this.str.charCodeAt(this.pos+2))) {
              if (isWhitespace(this.str.charCodeAt(this.pos-1))) {
                 this.pos += 2; 
                 break;
              }
           }
           this.pos++;
         }
         return { op: 'INLINE_IMAGE', args: [], rawOutput: this.str.substring(startPos, this.pos) };
      }

      return {
         op,
         args,
         rawOutput: this.str.substring(startPos, this.pos)
      };
    }
    
    return {
       op: 'EOF',
       args,
       rawOutput: this.str.substring(startPos, this.pos)
    };
  }
}