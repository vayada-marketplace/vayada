/** A room page can hold unsaved prices: leaving through the document lets its beforeunload warning run, so
 * links from the header (and its notifications bell, VAY-2591) leave it with a full page load. */
export const holdsPrices = () => /^\/rooms\/[^/]+$/.test(window.location.pathname);
