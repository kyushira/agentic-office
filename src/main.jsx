import Deck from './Deck.jsx';
import './tokens.css';
import './style.css';
import { installPwaHead } from './pwa-head.js';

if (typeof document !== 'undefined') installPwaHead(document);

window.__HERMES_PLUGINS__.register('agent-office', Deck);
