import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';

export class FleetTransportError extends Error {
  constructor(
    public code: string,
    public statusCode = 502,
  ) {
    super(code);
  }
}
export interface FleetTransportRequest {
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  credential?: string;
  body?: unknown;
  targetIdentity?: { instanceId: string; siteId: string };
}
export interface FleetTransportResponse {
  status: number;
  data: unknown;
}
export type FleetTransport = (request: FleetTransportRequest) => Promise<FleetTransportResponse>;

/** Conservative global-unicast policy: no local, metadata, mapped or transition addresses. */
export function publicFleetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6 && !address.includes('.') && !address.includes('%')) {
    const first = Number.parseInt(address.split(':')[0] ?? '', 16);
    const second = Number.parseInt(address.split(':')[1] || '0', 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3ffe &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
export function canonicalFleetUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FleetTransportError('fleet_url_invalid', 400);
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname)
  )
    throw new FleetTransportError('fleet_url_invalid', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !host ||
    host.endsWith('.') ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) ||
    (isIP(host) && !publicFleetAddress(host))
  )
    throw new FleetTransportError('fleet_url_private', 400);
  return url.origin + url.pathname.replace(/\/$/, '');
}
export async function resolveFleetAddress(hostname: string, resolve = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !publicFleetAddress(record.address)))
    throw new FleetTransportError('fleet_url_private', 400);
  return records.find((record) => record.family === 4) ?? records[0]!;
}
let inFlight = 0;
// getaddrinfo cannot be cancelled: hold this separate slot until lookup actually settles,
// even when the caller's deadline expires, so stuck DNS cannot grow the libuv queue.
export function createFleetDnsResolver(resolve = lookup, maximum = 8, timeoutMs = 3000) {
  let active = 0;
  return async (hostname: string) => {
    if (active >= maximum) throw new FleetTransportError('fleet_transport_busy', 429);
    active++;
    const pending = resolveFleetAddress(hostname, resolve).finally(() => {
      active--;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FleetTransportError('fleet_timeout', 504)), timeoutMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
}
const resolveBounded = createFleetDnsResolver();
export const fleetTransport: FleetTransport = async (input) => {
  const base = canonicalFleetUrl(input.baseUrl);
  // Only module-owned endpoint paths may be sent; caller-controlled IDs are encoded by the module.
  if (
    !/^\/api\/v2\/fleet\/(?:pair|remote\/(?:status|users|announcements|actions|unpair))(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(
      input.path,
    )
  )
    throw new FleetTransportError('fleet_path_invalid', 400);
  if (inFlight >= 8) throw new FleetTransportError('fleet_transport_busy', 429);
  inFlight++;
  try {
    const url = new URL(base + input.path);
    const selected = await resolveBounded(url.hostname);
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    if (body && body.byteLength > 16 * 1024)
      throw new FleetTransportError('fleet_request_large', 400);
    return await new Promise<FleetTransportResponse>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: input.method,
          agent: false,
          headers: {
            Accept: 'application/json',
            ...(body
              ? { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) }
              : {}),
            ...(input.credential ? { Authorization: `Bearer ${input.credential}` } : {}),
            ...(input.targetIdentity
              ? {
                  'X-Nightstudy-Fleet-Instance': input.targetIdentity.instanceId,
                  'X-Nightstudy-Fleet-Site': input.targetIdentity.siteId,
                }
              : {}),
          },
          lookup: (_host, options, callback) => {
            if (typeof options === 'object' && options.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          },
        },
        (response) => {
          if (Number(response.headers['content-length']) > 256 * 1024) {
            response.destroy();
            request.destroy();
            reject(new FleetTransportError('fleet_response_large'));
            return;
          }
          if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
            response.destroy();
            request.destroy();
            reject(new FleetTransportError('fleet_redirect_rejected'));
            return;
          }
          let length = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 256 * 1024) {
              response.destroy();
              request.destroy();
              reject(new FleetTransportError('fleet_response_large'));
            } else chunks.push(chunk);
          });
          response.on('error', () => reject(new FleetTransportError('fleet_unreachable')));
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 502,
                data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              });
            } catch {
              reject(new FleetTransportError('fleet_response_invalid'));
            }
          });
        },
      );
      const timer = setTimeout(() => {
        reject(new FleetTransportError('fleet_timeout', 504));
        request.destroy();
      }, 8000);
      timer.unref();
      request.once('close', () => clearTimeout(timer));
      request.once('error', () => reject(new FleetTransportError('fleet_unreachable')));
      request.end(body);
    });
  } catch (error) {
    if (error instanceof FleetTransportError) throw error;
    throw new FleetTransportError('fleet_unreachable');
  } finally {
    inFlight--;
  }
};
