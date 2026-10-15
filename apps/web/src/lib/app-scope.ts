export const clientSchemaVersion = 'h5-v1';

/** A mount path and installation identity are part of every private browser key. */
export function applicationScope(
  origin: string,
  site: { basePath: string; instanceId: string; siteId: string },
  userId: string | null,
) {
  return JSON.stringify([
    clientSchemaVersion,
    origin,
    site.basePath,
    site.instanceId,
    site.siteId,
    userId ?? 'guest',
  ]);
}
