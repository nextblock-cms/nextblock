import { z } from 'zod';

// Jitless: the production CSP forbids eval, which Zod's JIT compiler uses.
z.config({ jitless: true });

export { z };
