// jspdf@4.x e jspdf-autotable@5.x não publicam declarações de tipo no
// registry usado neste ambiente (a pasta "types/" referenciada no próprio
// package.json deles não vem no tarball). Declaração ambiente mínima só pra
// destravar o build — a API real é bem mais rica, mas usamos poucos métodos
// (ver src/components/LoadTest/loadTestPdfReport.ts).
declare module 'jspdf' {
  export default class jsPDF {
    constructor(options?: { unit?: string; format?: string | number[]; orientation?: string })
    internal: {
      pageSize: { getWidth(): number; getHeight(): number }
    }
    lastAutoTable?: { finalY: number }
    setFont(name: string, style?: string): this
    setFontSize(size: number): this
    setTextColor(r: number, g?: number, b?: number): this
    setDrawColor(r: number, g?: number, b?: number): this
    text(text: string, x: number, y: number, options?: Record<string, unknown>): this
    line(x1: number, y1: number, x2: number, y2: number): this
    addPage(): this
    setPage(pageNumber: number): this
    getNumberOfPages(): number
    output(type: 'arraybuffer'): ArrayBuffer
    output(type: string): unknown
  }
}

declare module 'jspdf-autotable' {
  const autoTable: (doc: unknown, options: Record<string, unknown>) => void
  export default autoTable
}
