/**
 * Tiny dependency-free dataset fixtures for the v7 preview tests.
 *
 * `buildXlsx` writes a minimal but real OOXML workbook (stored ZIP entries, shared
 * strings, two sheets by default, a date-style column when requested) so the Host
 * xlsx reader can be verified without Excel/openpyxl being installed.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let value = -1
  for (const byte of buffer) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return (value ^ -1) >>> 0
}

function dateSerial(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000 + 25569
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Build a stored-entry ZIP from [{name, data}] (data may be string or Buffer). */
export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const compressed = deflateRawSync(data)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

/**
 * Build an .xlsx workbook.
 * sheets: [{name, rows: Array<Array<string|number|{date:'YYYY-MM-DD'}>>}]
 */
export function buildXlsx(sheets) {
  const shared = []
  const sharedIndex = new Map()
  const stringsXml = []
  const sheetXmls = []
  for (const sheet of sheets) {
    const rowsXml = []
    sheet.rows.forEach((row, rowIndex) => {
      const cellsXml = []
      row.forEach((cell, columnIndex) => {
        const reference = String.fromCharCode(65 + columnIndex) + String(rowIndex + 1)
        if (cell && typeof cell === 'object' && typeof cell.date === 'string') {
          cellsXml.push(`<c r="${reference}" s="1"><v>${dateSerial(cell.date)}</v></c>`)
        } else if (typeof cell === 'number') {
          cellsXml.push(`<c r="${reference}"><v>${cell}</v></c>`)
        } else {
          const text = String(cell ?? '')
          if (!sharedIndex.has(text)) {
            sharedIndex.set(text, shared.length)
            shared.push(text)
          }
          cellsXml.push(`<c r="${reference}" t="s"><v>${sharedIndex.get(text)}</v></c>`)
        }
      })
      rowsXml.push(`<row r="${rowIndex + 1}">${cellsXml.join('')}</row>`)
    })
    sheetXmls.push(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rowsXml.join('')}</sheetData></worksheet>`,
    )
  }
  const sharedStringsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((text) => `<si><t>${xmlEscape(text)}</t></si>`).join('') +
    '</sst>'
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (sheet, index) =>
          `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>'
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>'
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>' +
    '</styleSheet>'
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map(
        (sheet, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>'
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: relsXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml },
    ...sheetXmls.map((xml, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: xml })),
  ]
  return buildZip(entries)
}

export const DEFAULT_SHEETS = [
  {
    name: '成绩',
    rows: [
      ['姓名', '班级', '数学', '英语', '入学日期'],
      ['张三', 'A班', 92, 88, { date: '2026-09-01' }],
      ['李四', 'B班', 78.5, 91, { date: '2026-09-01' }],
      ['王五', 'A班', 85, 76.5, { date: '2026-09-02' }],
    ],
  },
  {
    name: '教师',
    rows: [
      ['name', 'subject', 'years'],
      ['Wang', 'Math', 8],
      ['Li', 'English', 5],
    ],
  },
]
