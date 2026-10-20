export interface DataResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  is_binary: boolean;   // ← novo
}

export class ApiResponse {
  status: number;
  headers: Record<string, string>;
  parsedBody: any;
  isBinary: boolean;

  constructor(raw: DataResponse) {
    this.status     = raw.status;
    this.headers    = raw.headers ?? {};
    this.isBinary   = raw.is_binary ?? false;

    if (this.isBinary) {
      // Guarda o base64 bruto — será decodificado no download
      this.parsedBody = raw.body;
    } else {
      try {
        this.parsedBody = JSON.parse(raw.body);
      } catch {
        this.parsedBody = raw.body;
      }
    }
  }
}

// // O tipo que vem do seu backend (Tauri/Rust)
// export type DataResponse = {
//   Body?: string; // O Tauri pode retornar com 'B' maiúsculo
//   status?: number;
//   headers?: Record<string, string>;
// };

// // A classe que trata e normaliza esses dados para o React
// export class ApiResponse {
//   public status: number;
//   public headers: Record<string, string>;
//   public rawBody: string;
//   public parsedBody: any;

//   constructor(data: DataResponse) {
//     this.status = data.status ?? 0;
//     this.headers = data.headers ?? {};
    
//     // Aceita tanto 'Body' quanto 'body' para evitar problemas de case do Rust
//     this.rawBody = data.Body ?? (data as any).body ?? "";
//     this.parsedBody = this._parseBody(this.rawBody);
//   }

//   private _parseBody(body: string): any {
//     if (typeof body !== 'string') return body;
//     try {
//       return JSON.parse(body);
//     } catch (e) {
//       // Retorna a string pura se não for um JSON válido (ex: HTML ou texto simples)
//       return body;
//     }
//   }

//   // Atalho útil para verificar sucesso na UI
//   get isOk(): boolean {
//     return this.status >= 200 && this.status < 300;
//   }
// }