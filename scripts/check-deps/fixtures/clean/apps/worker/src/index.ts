// Fixture: worker code using only allowed imports (public shared entry points, third-party, same app).
import { Hono } from 'hono';
import {} from '@hypergeist/shared';
import {} from '@hypergeist/shared/engine';
import { routes } from './routes';

export const cleanWorker = [Hono, routes];
