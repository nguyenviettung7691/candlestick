import type { SymbolCatalogItem } from '@/lib/types';

const SYMBOL_CATALOG_KEY = 'candlestick_symbol_catalog';

export function saveSymbolCatalog(catalog: SymbolCatalogItem[]): void {
  try {
    const serialized = JSON.stringify(catalog);
    localStorage.setItem(SYMBOL_CATALOG_KEY, serialized);
  } catch (error) {
    console.error('Failed to save symbol catalog to localStorage', error);
  }
}

export function getSymbolCatalog(): SymbolCatalogItem[] | null {
  try {
    const serialized = localStorage.getItem(SYMBOL_CATALOG_KEY);
    if (!serialized) {
      return null;
    }
    return JSON.parse(serialized) as SymbolCatalogItem[];
  } catch (error) {
    console.error('Failed to load symbol catalog from localStorage', error);
    return null;
  }
}
