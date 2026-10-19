// ExcelJS ships no types for its internal reader; the import tests probe its `load` to see whether a file reached it.
declare module "exceljs/lib/xlsx/xlsx.js" {
  export default class Xlsx {
    load(...args: unknown[]): Promise<unknown>;
  }
}
