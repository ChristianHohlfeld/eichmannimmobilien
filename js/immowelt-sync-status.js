/**
 * Public Immowelt sync status — intentionally inactive.
 * Sync/API state is Admin-only (/admin/#immowelt). Public listing pages
 * must not show technical sync messages (API key, Freischaltung, etc.).
 * Kept as a no-op so older cached HTML that still loads this script stays silent.
 */
(() => {
  for (const node of document.querySelectorAll("[data-immowelt-sync-status], .immowelt-sync-status")) {
    node.remove();
  }
})();
