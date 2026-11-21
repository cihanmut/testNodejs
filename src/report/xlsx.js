// Minimal XLSX (Office Open XML) writer: sheets of strings/numbers, bold header cells, status fill colours,
// wrapped text, column widths, a frozen header row and an auto-filter. Zip container built with node:zlib
// (no npm packages). Opens in Excel, LibreOffice and Google Sheets.
import zlib from 'node:zlib';
import { crc32 } from '../util/binary.js';

const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '') // characters XML 1.0 forbids
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colLetter(n) { // 1 -> A
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A worksheet: rows of cells; a cell is a value or {v, bold, fill, wrap}. */
export class Sheet {
  constructor(title) {
    this.title = title.slice(0, 31);
    this.rows = [];
    this.widths = {}; // column letter -> width
    this.freeze = null; // e.g. "A2"
    this.autoFilter = false;
  }

  append(row) {
    this.rows.push(row);
    return this.rows.length;
  }

  get dimensions() {
    const cols = Math.max(1, ...this.rows.map((r) => r.length));
    return `A1:${colLetter(cols)}${Math.max(1, this.rows.length)}`;
  }
}

export class Workbook {
  constructor() {
    this.sheets = [];
    this.fills = []; // ARGB colours, index into styles
  }

  addSheet(title) {
    const s = new Sheet(title);
    this.sheets.push(s);
    return s;
  }

  // style index: 0 normal, 1 bold, 2 wrap+top, then 3.. = fills
  styleOf(cell) {
    if (cell === null || typeof cell !== 'object') return 0;
    if (cell.fill) {
      let i = this.fills.indexOf(cell.fill);
      if (i < 0) {
        this.fills.push(cell.fill);
        i = this.fills.length - 1;
      }
      return 3 + i;
    }
    if (cell.bold) return 1;
    if (cell.wrap) return 2;
    return 0;
  }

  sheetXml(sheet) {
    const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
    if (sheet.freeze) {
      const row = Number(sheet.freeze.replace(/\D/g, '')) - 1;
      out.push(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="${row}" topLeftCell="${sheet.freeze}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`);
    }
    const widths = Object.entries(sheet.widths);
    if (widths.length) {
      out.push('<cols>');
      for (const [letter, w] of widths) {
        let idx = 0;
        for (const ch of letter) idx = idx * 26 + (ch.charCodeAt(0) - 64);
        out.push(`<col min="${idx}" max="${idx}" width="${w}" customWidth="1"/>`);
      }
      out.push('</cols>');
    }
    out.push('<sheetData>');
    sheet.rows.forEach((row, ri) => {
      const r = ri + 1;
      out.push(`<row r="${r}">`);
      row.forEach((cell, ci) => {
        const ref = colLetter(ci + 1) + r;
        const v = cell !== null && typeof cell === 'object' ? cell.v : cell;
        const s = this.styleOf(cell);
        const sAttr = s ? ` s="${s}"` : '';
        if (v === null || v === undefined || v === '') {
          if (s) out.push(`<c r="${ref}"${sAttr}/>`);
        } else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint') {
          out.push(`<c r="${ref}"${sAttr}><v>${v}</v></c>`);
        } else {
          const text = typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
          out.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`);
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    if (sheet.autoFilter) out.push(`<autoFilter ref="${sheet.dimensions}"/>`);
    out.push('</worksheet>');
    return out.join('');
  }

  stylesXml() {
    const fills = this.fills.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
    const fillXfs = this.fills.map((_, i) => `<xf numFmtId="0" fontId="0" fillId="${2 + i}" borderId="0" xfId="0" applyFill="1"/>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + `<fills count="${2 + this.fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills>`
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${3 + this.fills.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
      + `${fillXfs}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  toBuffer() {
    const sheetXmls = this.sheets.map((s) => this.sheetXml(s)); // first: collects the fills used
    const files = [];
    const add = (name, text) => files.push([name, Buffer.from(text, 'utf8')]);
    add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + this.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>');
    add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + this.sheets.map((s, i) => `<sheet name="${xmlEsc(s.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets>'
      + (this.sheets.some((s) => s.autoFilter) ? '<definedNames>' + this.sheets.map((s, i) => (s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(s.title)}'!$${s.dimensions.replace(':', ':$').replace(/([A-Z]+)(\d+)/g, '$1$$$2')}</definedName>` : '')).join('') + '</definedNames>' : '')
      + '</workbook>');
    add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + this.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${this.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    add('xl/styles.xml', this.stylesXml());
    sheetXmls.forEach((x, i) => add(`xl/worksheets/sheet${i + 1}.xml`, x));
    return zip(files);
  }
}

/** Store files in a zip archive (deflate). */
export function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cenBuf, end]);
}
