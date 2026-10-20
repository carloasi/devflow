'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { parseCurl, type ParsedCurlRequest } from '@/lib/curlParser';
import { SlidePanel } from './SlidePanel';

interface ImportCurlDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (request: ParsedCurlRequest) => void;
}

export function ImportCurlDialog({ open, onClose, onImport }: ImportCurlDialogProps) {
  const [rawCurl, setRawCurl] = useState('');
  const [preview, setPreview] = useState<ParsedCurlRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleParse(value: string) {
    setRawCurl(value);
    setError(null);

    if (!value.trim()) {
      setPreview(null);
      return;
    }

    try {
      const parsed = parseCurl(value);
      if (!parsed.url) {
        setError('Could not identify the URL in the command.');
        setPreview(null);
        return;
      }
      setPreview(parsed);
    } catch {
      setError('Invalid or unrecognized cURL command.');
      setPreview(null);
    }
  }

  function handleConfirm() {
    if (!preview) return;
    onImport(preview);
    setRawCurl('');
    setPreview(null);
    onClose();
  }

  function handleClose() {
    setRawCurl('');
    setPreview(null);
    setError(null);
    onClose();
  }

  return (
    <SlidePanel
      isOpen={open}
      onClose={handleClose}
      title="Import"
 
      footer={
        <div className="flex justify-end gap-2 px-4 py-3">
          <button
            onClick={handleClose}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[12px] text-pm-text-secondary transition-colors hover:bg-pm-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!preview}
            className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-[12px] text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Import
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2 rounded-md border border-dashed border-pm-border bg-pm-hover/40 px-3 py-2 text-[11px] text-pm-text-muted">
          <Download size={13} className="shrink-0" />
          Paste a cURL command below to import it as a new request.
        </div>

        <textarea
          value={rawCurl}
          onChange={(e) => handleParse(e.target.value)}
          placeholder={`curl -X POST https://api.example.com/v1/orders \\\n  -H "Authorization: Bearer TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"passenger":"John"}'`}
          rows={10}
          spellCheck={false}
          className="w-full resize-none rounded-md border border-pm-border bg-pm-hover p-3 font-mono text-[12px] text-pm-text outline-none transition-colors focus:border-blue-500"
        />

        {error && <p className="text-[12px] text-red-400">{error}</p>}

        {preview && (
          <div className="rounded-md border border-pm-border bg-pm-hover p-3 text-[12px]">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-blue-600/20 px-2 py-0.5 text-[10px] font-semibold text-blue-400">
                {preview.method}
              </span>
              <span className="truncate text-pm-text-secondary">{preview.baseUrl}</span>
            </div>

            {preview.queryParams.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-[10px] text-pm-text-muted">
                  Query params ({preview.queryParams.length})
                </p>
                {preview.queryParams.map((p, i) => (
                  <div key={i} className="text-[11px] text-pm-text-muted">
                    {p.key} = {p.value}
                  </div>
                ))}
              </div>
            )}

            {preview.headers.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-[10px] text-pm-text-muted">
                  Headers ({preview.headers.length})
                </p>
                {preview.headers.map((h, i) => (
                  <div key={i} className="truncate text-[11px] text-pm-text-muted">
                    {h.key}: {h.value}
                  </div>
                ))}
              </div>
            )}

            {preview.body && (
              <div>
                <p className="mb-1 text-[10px] text-pm-text-muted">Body ({preview.bodyType})</p>
                <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-pm-text-muted">
                  {preview.body}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </SlidePanel>
  );
}

// "use client";

// import { useState } from "react";
// import { parseCurl, type ParsedCurlRequest } from "@/lib/curlParser";

// interface ImportCurlDialogProps {
//   open: boolean;
//   onClose: () => void;
//   onImport: (request: ParsedCurlRequest) => void;
// }

// export function ImportCurlDialog({ open, onClose, onImport }: ImportCurlDialogProps) {
//   const [rawCurl, setRawCurl] = useState("");
//   const [preview, setPreview] = useState<ParsedCurlRequest | null>(null);
//   const [error, setError] = useState<string | null>(null);

//   if (!open) return null;

//   function handleParse(value: string) {
//     setRawCurl(value);
//     setError(null);

//     if (!value.trim()) {
//       setPreview(null);
//       return;
//     }

//     try {
//       const parsed = parseCurl(value);
//       if (!parsed.url) {
//         setError("Não consegui identificar a URL no comando.");
//         setPreview(null);
//         return;
//           >
//             ✕
//         />
//                   Query params ({preview.queryParams.length})
//                   Headers ({preview.headers.length})
//                   Body ({preview.bodyType})
//           >
//             Cancelar
//           </button>
//           <button
//             onClick={handleConfirm}
//             disabled={!preview}
//             className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500"
//           >
//             Importar
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// }