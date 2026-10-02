'use client';
import { useEffect } from 'react';

/** Opens the print dialog once the bill has rendered (POS "Print bill" opens the bill with ?print=1). */
export default function AutoPrint() {
  useEffect(() => { const t = setTimeout(() => window.print(), 300); return () => clearTimeout(t); }, []);
  return null;
}
