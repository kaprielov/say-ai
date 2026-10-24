import { Resolver } from 'node:dns/promises';

const resolver = new Resolver({ timeout: 2000, tries: 1 });

export async function webhookDelivery(publicUrl: string, resolve = (host: string) => resolver.resolve4(host)) {
  const host = new URL(publicUrl).hostname;
  // Bound delivery concurrency at Telegram as well as at our HTTP admission layer.
  const options: { max_connections: number; ip_address?: string } = { max_connections: 2 };
  if (host.endsWith('.trycloudflare.com')) {
    // New quick-tunnel names can remain negatively cached at Telegram after local DNS resolves.
    // Resolve again on registration; never persist a Cloudflare edge address in configuration.
    try { options.ip_address = (await resolve(host))[0]; } catch { /* Use Telegram DNS when local resolution is unavailable. */ }
  }
  return options;
}
