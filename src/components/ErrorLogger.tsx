'use client';

import { useEffect } from 'react';
import { installErrorCapture } from '@/lib/errorLog';

// Liga a captura global de erros (window error, unhandledrejection,
// console.error) uma vez no mount do app — ver src/lib/errorLog.ts.
export function ErrorLogger() {
  useEffect(() => {
    installErrorCapture();
  }, []);

  return null;
}
