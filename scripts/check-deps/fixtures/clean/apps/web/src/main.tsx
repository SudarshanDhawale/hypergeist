// Fixture: web code using only allowed imports (public shared entry points, third-party, same app).
import { createRoot } from 'react-dom/client';
import {} from '@hypergeist/shared';
import {} from '@hypergeist/shared/format';
import {} from '@hypergeist/shared/engine';
import { App } from './App';

export const cleanWeb = [createRoot, App];
