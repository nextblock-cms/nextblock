// The `/partners` layout (the copy overrides provider while the package is active, a pass-through
// otherwise). Never `fetchCache`: it would switch off every `unstable_cache` read beneath this segment.
export const dynamic = 'force-dynamic';

export { default } from '../partners/layout';
