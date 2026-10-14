import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { appVersion } from '@nightstudy/core';
import { readBoundedJson } from './providers/google-web.js';

const releaseApi = 'https://api.github.com/repos/wudi000888-svg/nightstudy/releases?per_page=50';
type Version = { numbers: bigint[]; prerelease: string[] };
export function parseVersion(value: string): Version | null {
  if (value.length > 128) return null;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))
    return null;
  return { numbers: match.slice(1, 4).map(BigInt), prerelease };
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left),
    b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid semantic version');
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index]! > b.numbers[index]! ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index],
      y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x),
      numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export interface UpdateView {
  status: 'unchecked' | 'up-to-date' | 'available' | 'ahead' | 'no-release' | 'failed';
  checkedAt: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  message: string;
  channel: 'prerelease' | 'stable';
  cached?: boolean;
  stale?: boolean;
  lastSuccessfulAt?: string | null;
}
const channel = parseVersion(appVersion)?.prerelease.length ? 'prerelease' : 'stable';
const empty = (): UpdateView => ({
  status: 'unchecked',
  checkedAt: null,
  latestVersion: null,
  releaseUrl: null,
  message: '尚未检测更新',
  channel,
});
export function releaseUpdateView(
  raw: unknown,
  currentVersion = appVersion,
  checkedAt = new Date().toISOString(),
): UpdateView {
  if (!Array.isArray(raw)) throw new Error('Invalid release response');
  const releaseChannel = parseVersion(currentVersion)?.prerelease.length ? 'prerelease' : 'stable';
  const releases = raw
    .flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const r = item as Record<string, unknown>;
      if (r.draft !== false || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string')
        return [];
      const version = parseVersion(r.tag_name);
      if (!version || !r.tag_name.startsWith('v')) return [];
      if (releaseChannel === 'stable' && (r.prerelease !== false || version.prerelease.length))
        return [];
      const expected = `https://github.com/wudi000888-svg/nightstudy/releases/tag/${r.tag_name}`;
      if (r.html_url !== expected) return [];
      return [{ version: r.tag_name.slice(1), url: r.html_url }];
    })
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = releases[0];
  if (!latest)
    return {
      ...empty(),
      checkedAt,
      status: 'no-release',
      channel: releaseChannel,
      message: '该渠道暂无已发布版本',
    };
  const comparison = compareVersions(currentVersion, latest.version);
  const status = comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'up-to-date';
  return {
    status,
    checkedAt,
    latestVersion: latest.version,
    releaseUrl: latest.url,
    channel: releaseChannel,
    message:
      status === 'available'
        ? '发现新版本，可查看发布说明'
        : status === 'ahead'
          ? '当前版本领先于该渠道发布版本'
          : '当前版本与该渠道最新发布一致',
  };
}

export async function getUpdateState(prisma: PrismaClient): Promise<UpdateView> {
  const state = await prisma.systemUpdateCheck.findUnique({ where: { id: 'singleton' } });
  const payload = state?.payloadJson as Record<string, unknown> | null;
  if (!payload || payload.forVersion !== appVersion || !payload.view) return empty();
  return {
    ...(payload.view as unknown as UpdateView),
    lastSuccessfulAt: state?.checkedAt?.toISOString() ?? null,
  };
}
let sourceCache: { at: number; raw: unknown } | undefined;
let fetching: Promise<unknown> | undefined;
async function fetchReleases(fetchFn: typeof fetch) {
  // Share the fixed-repository response across realms in this process; no user URL is fetched.
  if (fetchFn === fetch && sourceCache && Date.now() - sourceCache.at < 60000)
    return sourceCache.raw;
  if (fetchFn === fetch && fetching) return fetching;
  const request = (async () => {
    const response = await fetchFn(releaseApi, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `NightStudy/${appVersion}`,
      },
    });
    if (!response.ok)
      throw new Error(
        response.status === 403 || response.status === 429
          ? 'release_source_limited'
          : 'release_source_unavailable',
      );
    const raw = await readBoundedJson(response, 512 * 1024);
    if (!Array.isArray(raw) || raw.length > 50) throw new Error('release_response_invalid');
    if (fetchFn === fetch) sourceCache = { at: Date.now(), raw };
    return raw;
  })();
  if (fetchFn === fetch) fetching = request;
  try {
    return await request;
  } finally {
    if (fetchFn === fetch) fetching = undefined;
  }
}
export async function checkForUpdates(
  prisma: PrismaClient,
  options: { fetchFn?: typeof fetch } = {},
): Promise<UpdateView> {
  // Initialize atomically across replicas without overwriting cached results or active claims.
  await prisma.systemUpdateCheck.createMany({
    data: [{ id: 'singleton' }],
    skipDuplicates: true,
  });
  const lockId = randomUUID(),
    now = new Date();
  const claimed = await prisma.$queryRaw<
    Array<{ id: string }>
  >`UPDATE "SystemUpdateCheck" SET "lockId"=${lockId},"lockedUntil"=NOW()+INTERVAL '15 seconds',"lastAttemptedAt"=NOW(),"updatedAt"=NOW() WHERE "id"='singleton' AND ("lockedUntil" IS NULL OR "lockedUntil"<NOW()) AND ("lastAttemptedAt" IS NULL OR "lastAttemptedAt"<NOW()-INTERVAL '60 seconds') RETURNING "id"`;
  if (!claimed.length) return { ...(await getUpdateState(prisma)), cached: true };
  let view: UpdateView;
  try {
    view = releaseUpdateView(
      await fetchReleases(options.fetchFn ?? fetch),
      appVersion,
      now.toISOString(),
    );
  } catch {
    const previous = await getUpdateState(prisma);
    view = {
      ...previous,
      status: 'failed',
      checkedAt: now.toISOString(),
      stale: Boolean(previous.latestVersion),
      message: '更新源暂不可用，请稍后重试',
    };
  }
  await prisma.systemUpdateCheck.updateMany({
    where: { id: 'singleton', lockId },
    data: {
      status: view.status,
      payloadJson: { forVersion: appVersion, view } as unknown as Prisma.InputJsonValue,
      ...(view.status !== 'failed' ? { checkedAt: now } : {}),
      lockedUntil: null,
      lockId: null,
    },
  });
  return view;
}
