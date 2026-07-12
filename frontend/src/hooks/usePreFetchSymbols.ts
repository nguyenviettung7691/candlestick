"use client";

import { useEffect } from 'react';
import { getSymbolCatalog, saveSymbolCatalog } from '@/lib/local-db';

export function usePreFetchSymbols(): void {
  useEffect(() => {
    const fetchSymbolsInBackground = async () => {
      const cached = getSymbolCatalog();
      if (cached) {
        return;
      }

      try {
        const response = await fetch('/api/symbols', { cache: 'no-store' });
        const result = await response.json();
        if (result.ok && Array.isArray(result.items)) {
          saveSymbolCatalog(result.items);
        }
      } catch (error) {
        console.error('Background symbol fetch failed:', error);
      }
    };

    fetchSymbolsInBackground();
  }, []);
}