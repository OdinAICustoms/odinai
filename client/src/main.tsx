import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getLang, setLang } from './i18n';
import './styles.css';

setLang(getLang());
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
