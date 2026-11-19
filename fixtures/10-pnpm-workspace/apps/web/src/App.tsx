import { PriceTag } from '@/components/PriceTag';
import './styles.css';

const loadSettings = () => import('./pages/Settings');

export default function App() {
  const apiUrl = import.meta.env.VITE_API_URL;
  void loadSettings;
  return (
    <div data-api={apiUrl}>
      <PriceTag cents={100} />
    </div>
  );
}
