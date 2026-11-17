import { app } from './app';

// The Durable Object class must be exported from the entry point so `wrangler` can find it.
export { QuotaStore } from './ai/quota-store';

export default app;
