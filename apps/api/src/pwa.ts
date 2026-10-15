import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { appVersion } from '@nightstudy/core';
import type { AppConfig, SiteConfig } from './config.js';
import { HttpError } from './context.js';

interface PwaRegistry {
  resolve(request: FastifyRequest): SiteConfig;
  runtime(site: SiteConfig): {
    prisma: {
      siteState: {
        findUnique(input: {
          where: { id: 'singleton' };
        }): Promise<{ siteId: string; instanceId: string } | null>;
      };
    };
  };
}
interface PublicAsset {
  pathname: string;
  sha256: string;
  bytes: number;
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const maxFiles = 256,
  maxBytes = 32 * 1024 * 1024,
  maxFileBytes = 8 * 1024 * 1024;
const hashedAsset = /^[a-zA-Z0-9_./-]+-[a-zA-Z0-9_-]{6,}\.(?:js|css|woff2?|ttf|otf)$/;

/** Only known, content-hashed build resources can become public cache entries. */
function publicAssets(webRoot: string) {
  const result: PublicAsset[] = [];
  let total = 0;
  const add = (filename: string, pathname: string) => {
    const stat = fs.lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > maxFileBytes ||
      result.length >= maxFiles ||
      total + stat.size > maxBytes
    )
      return;
    const bytes = fs.readFileSync(filename);
    result.push({ pathname, sha256: sha256(bytes), bytes: bytes.length });
    total += bytes.length;
  };
  const walk = (directory: string, relative = '', depth = 0) => {
    if (!fs.existsSync(directory) || depth > 4) return;
    for (const file of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.length >= maxFiles || total >= maxBytes) break;
      const entry = path.join(directory, file.name),
        name = relative + file.name;
      if (file.isDirectory() && !['api', 'admin', 'setup'].includes(file.name))
        walk(entry, `${name}/`, depth + 1);
      else if (file.isFile() && hashedAsset.test(name)) add(entry, `/assets/${name}`);
    }
  };
  walk(path.join(webRoot, 'assets'));
  for (const size of [192, 512]) {
    const file = path.join(webRoot, 'app-icons', `icon-${size}.png`);
    if (fs.existsSync(file)) add(file, `/app-icons/icon-${size}.png`);
  }
  return result;
}

function offlineHtml(basePath: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>暂时离线</title><style>html{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.8 system-ui,sans-serif;background:#e5f0f2;color:#223d43}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.4rem;font-weight:600}a{display:inline-block;margin-top:1rem;padding:.65rem 1.5rem;border-radius:2rem;color:inherit;background:#fff;text-decoration:none}p{opacity:.75}</style></head><body><main><h1>暂时无法连接</h1><p>连接网络后，回来继续学习。</p><a href="${basePath}/">重新打开</a></main></body></html>`;
}

function workerSource(input: {
  basePath: string;
  siteId: string;
  instanceId: string;
  exclusions: string[];
  assets: PublicAsset[];
  offline: string;
}) {
  const namespace = sha256(JSON.stringify({ site: input.siteId, mount: input.basePath })).slice(
    0,
    24,
  );
  const build = sha256(
    JSON.stringify({
      version: appVersion,
      instance: input.instanceId,
      assets: input.assets,
      exclusions: input.exclusions,
      offline: input.offline,
    }),
  ).slice(0, 24);
  const manifest = [
    ...input.assets.map((asset) => ({ ...asset, pathname: input.basePath + asset.pathname })),
    {
      pathname: `${input.basePath}/offline.html`,
      sha256: sha256(input.offline),
      bytes: Buffer.byteLength(input.offline),
    },
  ];
  return `'use strict';
const MOUNT=${JSON.stringify(input.basePath)}, EXCLUDED=${JSON.stringify(input.exclusions)};
const VERSION=${JSON.stringify(appVersion)}, PREFIX=${JSON.stringify(`nightstudy-public-v1:${namespace}:`)}, CACHE=PREFIX+${JSON.stringify(`${appVersion}:${build}`)};
const OFFLINE=new URL(MOUNT+'/offline.html',self.location.origin).href;
const RESOURCES=new Map(${JSON.stringify(manifest)}.map(item=>[new URL(item.pathname,self.location.origin).href,item]));
const owns=pathname=>(!MOUNT||pathname===MOUNT||pathname.startsWith(MOUNT+'/'))&&!EXCLUDED.some(prefix=>pathname===prefix||pathname.startsWith(prefix+'/'));
const privatePath=pathname=>/(?:^|\\/)(?:api|admin|setup)(?:\\/|$)/.test(pathname.slice(MOUNT.length));
const publicHash=pathname=>pathname.startsWith(MOUNT+'/assets/')&&/^[a-zA-Z0-9_./-]+-[a-zA-Z0-9_-]{6,}\\.(?:js|css|woff2?|ttf|otf)$/.test(pathname.slice((MOUNT+'/assets/').length));
async function checked(url,response){
  const expected=RESOURCES.get(url);
  if(!expected||!response.ok||response.status!==200||response.redirected||!['basic','default'].includes(response.type))throw Error('public_resource_unavailable');
  const control=response.headers.get('cache-control')||'', vary=response.headers.get('vary')||'';
  if(/(?:private|no-store)/i.test(control)||/(?:^|,)\\s*(?:cookie|authorization|\\*)\\s*(?:,|$)/i.test(vary))throw Error('private_resource_rejected');
  const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),pathname=expected.pathname;
  if((pathname.endsWith('.js')&&!/^(?:application|text)\\/(?:javascript|ecmascript)$/.test(type))||(pathname.endsWith('.css')&&type!=='text/css')||(pathname.endsWith('.png')&&type!=='image/png')||(pathname.endsWith('.html')&&type!=='text/html')||(/\\.(?:woff2?|ttf|otf)$/.test(pathname)&&!(/^(?:font\\/|application\\/(?:font-|x-font-|vnd.ms-fontobject|octet-stream))/.test(type))))throw Error('public_resource_type_mismatch');
  const bytes=await response.clone().arrayBuffer();
  if(bytes.byteLength!==expected.bytes)throw Error('public_resource_size_mismatch');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  if(digest!==expected.sha256)throw Error('public_resource_digest_mismatch');
  return response;
}
async function download(url){return checked(url,await fetch(url,{credentials:'omit',redirect:'error',cache:'no-cache'}));}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const existed=(await caches.keys()).includes(CACHE);
  const cache=await caches.open(CACHE);
  try{for(const url of RESOURCES.keys())await cache.put(url,await download(url));}
  catch(error){if(!existed)await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('message',event=>{
  if(event.data&&event.data.type==='ACTIVATE')event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const previous=(await caches.keys()).filter(name=>name.startsWith(PREFIX)&&name!==CACHE);
  await Promise.all(previous.slice(0,-1).map(name=>caches.delete(name)));
  await self.clients.claim();
})()));
async function oldPublic(url){
  const names=(await caches.keys()).filter(name=>name.startsWith(PREFIX)).reverse();
  for(const name of names.slice(0,2)){const response=await (await caches.open(name)).match(url);if(response)return response;}
  return null;
}
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||!owns(url.pathname)||privatePath(url.pathname)||request.headers.has('authorization'))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(async()=>
      (await (await caches.open(CACHE)).match(OFFLINE))||new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>暂时离线</title><p>连接网络后，回来继续学习。</p></html>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}})));
    return;
  }
  if(url.search)return;
  if(RESOURCES.has(url.href))event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(url.href);
    if(cached)return cached;
    const response=await download(url.href);await cache.put(url.href,response.clone());return response;
  })());
  else if(publicHash(url.pathname))event.respondWith((async()=>await oldPublic(url.href)||fetch(request))());
});
`;
}

/** Register before the SPA fallback; every route is resolved to its own trusted Host/mount. */
export async function registerPwa(app: FastifyInstance, config: AppConfig, registry: PwaRegistry) {
  const assets = publicAssets(config.webRoot);
  for (const basePath of [...new Set(config.sites.map((site) => site.basePath))]) {
    const siteFor = (request: FastifyRequest) => {
      const site = registry.resolve(request);
      if (site.basePath !== basePath) throw new HttpError(404, 'unknown_site');
      return site;
    };
    app.get(`${basePath}/manifest.webmanifest`, async (request, reply) => {
      const site = siteFor(request),
        scope = `${basePath}/`;
      return reply
        .header('Cache-Control', 'no-store')
        .type('application/manifest+json; charset=utf-8')
        .send({
          id: scope,
          name: site.title,
          short_name: site.title.slice(0, 12),
          lang: 'zh-CN',
          start_url: scope,
          scope,
          display: 'standalone',
          background_color: '#e5f0f2',
          theme_color: '#193e43',
          icons: [192, 512].map((size) => ({
            src: `${basePath}/app-icons/icon-${size}.png`,
            sizes: `${size}x${size}`,
            type: 'image/png',
            purpose: 'any maskable',
          })),
        });
    });
    app.get(`${basePath}/offline.html`, async (request, reply) => {
      siteFor(request);
      return reply
        .header('Cache-Control', 'public, max-age=0, must-revalidate')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
        )
        .type('text/html; charset=utf-8')
        .send(offlineHtml(basePath));
    });
    for (const size of [192, 512])
      app.get(`${basePath}/app-icons/icon-${size}.png`, async (request, reply) => {
        siteFor(request);
        const asset = assets.find((item) => item.pathname === `/app-icons/icon-${size}.png`);
        if (!asset) throw new HttpError(404, 'not_found');
        return reply
          .header('Cache-Control', 'public, max-age=86400')
          .type('image/png')
          .send(fs.readFileSync(path.join(config.webRoot, 'app-icons', `icon-${size}.png`)));
      });
    app.get(`${basePath}/sw.js`, async (request, reply) => {
      const site = siteFor(request);
      const state = await registry
        .runtime(site)
        .prisma.siteState.findUnique({ where: { id: 'singleton' } });
      if (!state || state.siteId !== site.id) throw new HttpError(503, 'database_not_prepared');
      const host = new URL(`http://${request.headers.host}`).hostname.toLowerCase();
      const exclusions = config.sites
        .filter(
          (other) =>
            other.hosts.includes(host) &&
            other.basePath !== basePath &&
            other.basePath.startsWith(`${basePath}/`),
        )
        .map((other) => other.basePath)
        .sort();
      return reply
        .header('Cache-Control', 'no-store, max-age=0')
        .header('Service-Worker-Allowed', `${basePath}/`)
        .type('application/javascript; charset=utf-8')
        .send(
          workerSource({
            basePath,
            siteId: site.id,
            instanceId: state.instanceId,
            exclusions,
            assets,
            offline: offlineHtml(basePath),
          }),
        );
    });
  }
}
