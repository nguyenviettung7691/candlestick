import React, { useEffect, useState } from 'react';
import SymbolLoader from './SymbolLoader';
import { getSymbolCatalog, saveSymbolCatalog } from '@/lib/local-db';
import type { SymbolCatalogItem } from '@/lib/types';

interface DashboardFormModalProps {
  open: boolean;
}

const DashboardFormModal: React.FC<DashboardFormModalProps> = ({ open }) => {
  const [symbols, setSymbols] = useState<SymbolCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const fetchSymbols = async () => {
      const cached = getSymbolCatalog();
      if (cached) {
        setSymbols(cached);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const response = await fetch('/api/symbols', { cache: 'no-store' });
        const result = await response.json();
        if (result.ok && Array.isArray(result.items)) {
          saveSymbolCatalog(result.items);
          setSymbols(result.items);
        }
      } catch (error) {
        console.error('Symbol fetch failed:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchSymbols();
  }, [open]);

  if (!open) return null;

  return (
    <div className="dashboard-modal fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="modal-content bg-white rounded-lg p-6 w-full max-w-lg">
        <h2 className="modal-title text-xl font-bold mb-4">Create Dashboard</h2>
        <SymbolLoader loading={loading} />
        <div className="symbol-selector space-y-2 max-h-60 overflow-y-auto">
          {symbols.map(s => (
            <div key={s.symbol} className="p-2 border rounded">
              {s.symbol} - {s.companyName}
            </div>
          ))}
        </div>
        <div className="modal-footer mt-4">
          <button className="btn-primary">Save Dashboard</button>
        </div>
      </div>
    </div>
  );
};
export default DashboardFormModal;