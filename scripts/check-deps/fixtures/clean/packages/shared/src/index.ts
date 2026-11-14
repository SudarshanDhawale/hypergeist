// Fixture: shared code using only allowed imports (same package and Node built-ins).
import { join } from 'node:path';
import { formatThing } from './format/index';

export const cleanShared = join('a', formatThing);
