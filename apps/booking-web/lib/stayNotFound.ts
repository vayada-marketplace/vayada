// The two lines of the "not online" card (messages/*.json `error`), here for the middleware, which
// shouldn't carry every message file; a test keeps them the same.
export const STAY_NOT_FOUND_WORDS: Record<string, { notOnline: string; checkBackLater: string }> = {
  de: {
    notOnline: "Diese Buchungsseite ist gerade nicht online",
    checkBackLater: "Bitte schauen Sie später noch einmal vorbei.",
  },
  en: {
    notOnline: "This booking page isn't online right now",
    checkBackLater: "Please check back later.",
  },
  es: {
    notOnline: "Esta página de reservas no está en línea en este momento",
    checkBackLater: "Por favor, vuelve más tarde.",
  },
  fr: {
    notOnline: "Cette page de réservation n'est pas en ligne pour le moment",
    checkBackLater: "Veuillez revenir plus tard.",
  },
  id: {
    notOnline: "Halaman pemesanan ini sedang tidak online",
    checkBackLater: "Silakan kembali lagi nanti.",
  },
};

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * VAY-2462: what a page load of a stay's pages answers on an address that doesn't show that stay
 * (not an agency's, or a stay its live page doesn't show): 404, with the "not online" words the
 * page itself would show, in the address's language, and not for search engines.
 */
export function stayNotFoundPage(locale: string): Response {
  const words = STAY_NOT_FOUND_WORDS[locale] ?? STAY_NOT_FOUND_WORDS.en!;
  const lang = STAY_NOT_FOUND_WORDS[locale] ? locale : "en";
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(words.notOnline)}</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9fafb;font-family:system-ui,-apple-system,sans-serif;color:#111827">
<main style="max-width:28rem;margin:1rem;padding:2rem;background:#fff;border:1px solid #e5e7eb;border-radius:1rem;text-align:center">
<h1 style="margin:0 0 .5rem;font-size:1.125rem">${escape(words.notOnline)}</h1>
<p style="margin:0;font-size:.875rem;color:#4b5563">${escape(words.checkBackLater)}</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
