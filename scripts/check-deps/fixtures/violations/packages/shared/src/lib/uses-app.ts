// Fixture: shared code importing application code (rule: shared-imports-app).
// From packages/shared/src/lib, four `..` segments reach the fixture root, so this
// resolves to apps/web/src/App.
import { App } from '../../../../apps/web/src/App';

export const usesApp = App;
