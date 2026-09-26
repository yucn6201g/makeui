import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installPressFeedback } from './utils/motion/pressFeedback';
import './index.css';

installPressFeedback();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
