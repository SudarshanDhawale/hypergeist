import '@fontsource/pixelify-sans/400.css';
import '@fontsource/vt323/400.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/window.css';
import './styles/controls.css';
import './styles/canvas.css';
import './styles/ghost.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import demoStackText from './stacks/thin-slice-todo.json?raw';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(<App stackText={demoStackText} />);
