import type { Location } from 'react-router-dom';
import { moduleRoots, screenIdentity, screenModule, type AppModule } from './navigation';
import { lookupConditions, lookupParams } from './lookup-state';

export const locationHref = (value: Pick<Location, 'pathname' | 'search' | 'hash'>) =>
  `${value.pathname}${value.search}${value.hash}`;

export function committedHistoryIndex(
  previous: { location: Location; index: number },
  location: Location,
  native: { index: number; href: string },
  basePath = '',
) {
  const changed =
    location.key !== previous.location.key ||
    locationHref(location) !== locationHref(previous.location);
  const aligned = native.href === basePath + locationHref(location);
  // During a cancelled pop the address bar has moved, but Router intentionally
  // has not. Unrelated renders must not label the retained screen with that index.
  return Number.isFinite(native.index) && (changed || aligned) ? native.index : previous.index;
}

function rootLocation(module: AppModule): Location {
  return {
    pathname: moduleRoots[module],
    search: '',
    hash: '',
    state: null,
    key: `root:${module}`,
  };
}

interface HistoryEntry {
  location: Location;
  module: AppModule | null;
}
export type NavigationAction = 'POP' | 'PUSH' | 'REPLACE';

function lookupEntry(value: Location) {
  return (
    ['/lookup', '/wordbook'].includes(value.pathname) &&
    new URLSearchParams(value.search).has('entry')
  );
}
function opensLookupDetail(
  previous: Location | undefined,
  current: Location,
  action: NavigationAction,
) {
  if (
    action !== 'PUSH' ||
    !previous ||
    current.pathname !== previous.pathname ||
    !lookupEntry(current) ||
    lookupEntry(previous)
  )
    return false;
  const proof = current.state as { lookupListKey?: string } | null;
  if (proof?.lookupListKey !== previous.key) return false;
  const kind = current.pathname === '/wordbook' ? 'wordbook' : 'lookup';
  const conditions = (value: Location) =>
    String(lookupParams(lookupConditions(new URLSearchParams(value.search), kind), kind));
  return conditions(previous) === conditions(current);
}

const retainedRoutes = new Set([
  '/',
  '/learning',
  '/content',
  '/academy',
  '/me',
  '/books',
  '/books/mine',
  '/books/import',
  '/lookup',
  '/dictionary',
  '/wordbook',
  '/known',
  '/assessment',
  '/memory',
  '/stats',
  '/library',
  '/sentences',
  '/notes',
]);
const pinnedScreens = new Set([
  'home',
  '/learning',
  '/content',
  '/academy',
  '/me',
  '/notes',
  '/books/import',
  '/wordbook',
]);

export class AppScreenCache {
  readonly locations = new Map<string, Location>();
  constructor(
    home: Location,
    readonly limit = 12,
  ) {
    this.locations.set('home', home);
  }
  retains(path: string) {
    return retainedRoutes.has(path);
  }
  visit(location: Location) {
    if (!this.retains(location.pathname)) return;
    const id = screenIdentity(location.pathname);
    this.locations.delete(id);
    this.locations.set(id, location);
    while (this.locations.size > this.limit) {
      const oldest = [...this.locations.keys()].find(
        (key) => key !== id && !pinnedScreens.has(key),
      );
      if (!oldest) break;
      this.locations.delete(oldest);
    }
  }
}

// Lives only inside an account/realm-keyed application. No private navigation state
// is written into shared localStorage or inherited by the next account.
export class AppNavigationState {
  readonly modules = new Map<AppModule, Location[]>();
  readonly history = new Map<number, HistoryEntry>();
  private visited = '';

  visit(location: Location, action: NavigationAction, index: number, restore = false) {
    const signature = `${location.key}:${locationHref(location)}:${index}`;
    if (signature === this.visited) return;
    this.visited = signature;
    if (action === 'PUSH') {
      for (const key of this.history.keys()) if (key > index) this.history.delete(key);
    }
    const module = screenModule(location.pathname);
    this.history.set(index, { location, module });
    if (!module) return;
    const previous = this.modules.get(module) ?? [];
    const existing = previous.findIndex((item) => item.key === location.key);
    let stack: Location[];
    if (restore && previous.length) {
      stack = [...previous.slice(0, -1), location];
    } else if (action === 'POP' && existing >= 0) {
      stack = [...previous.slice(0, existing), location];
    } else if (location.pathname === moduleRoots[module]) {
      stack = [location];
    } else if (opensLookupDetail(previous.at(-1), location, action)) {
      stack = [...previous, location];
    } else if (previous.at(-1)?.pathname === location.pathname) {
      stack = [...previous.slice(0, -1), location];
    } else {
      const entryBefore = this.history.get(index - 1);
      const continuesModule = action === 'PUSH' && entryBefore?.module === module;
      stack =
        !previous.length && lookupEntry(location)
          ? [location]
          : continuesModule && previous.length
            ? [...previous, location]
            : [rootLocation(module), location];
    }
    // Routes are a finite set; repeated visits never make an unbounded page stack.
    if (stack.length > 12) stack = [stack[0]!, ...stack.slice(-11)];
    this.modules.set(module, stack);
  }

  destination(module: AppModule) {
    return locationHref(this.destinationLocation(module));
  }

  destinationLocation(module: AppModule) {
    return this.modules.get(module)?.at(-1) ?? rootLocation(module);
  }

  previous(module: AppModule) {
    return this.modules.get(module)?.at(-2);
  }

  takePrevious(module: AppModule) {
    const stack = this.modules.get(module);
    if (!stack || stack.length < 2) return null;
    stack.pop();
    return stack.at(-1)!;
  }

  canPopTo(previous: Location, index: number) {
    return this.history.get(index - 1)?.location.key === previous.key;
  }

  homeDistance(index: number) {
    const homes = [...this.history.entries()]
      .filter(([key, value]) => key < index && value.location.pathname === '/')
      .map(([key]) => key);
    return homes.length ? index - Math.max(...homes) : null;
  }
}
