/**
 * A full page load: the only way to drop scripts a page has already run (gtag.js, gtm.js, the
 * consented custom scripts). Its own module so tests can replace it, since jsdom cannot navigate.
 */
export function reloadPage(): void {
  window.location.reload();
}
