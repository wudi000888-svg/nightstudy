import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, releaseUpdateView } from './updates.js';
const release = (version: string, prerelease = true) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease,
  html_url: `https://github.com/wudi000888-svg/nightstudy/releases/tag/v${version}`,
});
describe('fixed repository update contract', () => {
  it('compares numeric prerelease identifiers, stable precedence and ignores build metadata', () => {
    expect(compareVersions('0.3.0-alpha.10', '0.3.0-alpha.2')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('v1.0.0+new', '1.0.0+old')).toBe(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    for (const v of ['1.2', '01.2.3', '1.2.3-alpha.01', 'branch-main', 'v1.2.3;rm'])
      expect(parseVersion(v)).toBeNull();
  });
  it('does not describe an empty release channel as up to date', () => {
    expect(releaseUpdateView([], '0.3.0-alpha.1')).toMatchObject({
      status: 'no-release',
      latestVersion: null,
    });
    expect(releaseUpdateView([release('0.3.0-alpha.2')], '0.3.0', 'now')).toMatchObject({
      status: 'no-release',
      channel: 'stable',
    });
  });
  it('selects the greatest compatible valid version and refuses unrelated release URLs/drafts', () => {
    const items = [
      release('0.3.0-alpha.2'),
      release('0.3.0-alpha.10'),
      { ...release('9.0.0'), draft: true },
      { ...release('10.0.0'), html_url: 'https://attacker.example/release' },
    ];
    expect(releaseUpdateView(items, '0.3.0-alpha.1')).toMatchObject({
      status: 'available',
      latestVersion: '0.3.0-alpha.10',
    });
    expect(releaseUpdateView([release('0.3.0-alpha.1')], '0.3.0-alpha.1')).toMatchObject({
      status: 'up-to-date',
    });
    expect(releaseUpdateView([release('0.2.0', false)], '0.3.0-alpha.1')).toMatchObject({
      status: 'ahead',
    });
  });
});
