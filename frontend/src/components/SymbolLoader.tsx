import { getSymbolCatalog, saveSymbolCatalog } from '@/lib/local-db';
import type { SymbolCatalogItem } from '@/lib/types';

interface SymbolLoaderProps {
  loading: boolean;
}

const SymbolLoader: React.FC<SymbolLoaderProps> = ({ loading }) => {
  if (loading) {
    return <div className="symbol-loader-overlay">Loading symbols...</div>;
  }
  return null;
};

export default SymbolLoader;