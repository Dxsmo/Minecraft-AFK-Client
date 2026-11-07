/** SQLite permits only one writer. A CPU-sized Prisma pool otherwise lets
 * status updates, log batches and earnings compete for the same file lock. */
export function sqliteConnectionUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const separator = url.indexOf("?");
  const file = separator < 0 ? url : url.slice(0, separator);
  const parameters = new URLSearchParams(separator < 0 ? "" : url.slice(separator + 1));
  for (const [key, value] of Object.entries({ connection_limit: "1", socket_timeout: "30", pool_timeout: "30" })) {
    if (!parameters.has(key)) parameters.set(key, value);
  }
  return `${file}?${parameters}`;
}
