import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadData } from './data.ts';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
try {
  root.render(<App data={loadData()} />);
} catch (e) {
  root.render(<main style={{ padding: 40, fontFamily: 'Georgia, serif' }}><h1>Report data missing</h1><p>{e instanceof Error ? e.message : String(e)}</p></main>);
}
