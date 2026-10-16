import { describe, expect, it } from 'vitest';
import { parsePhoneticsTsv, phoneticsPacks, normalizePhoneticLemma } from './phonetics-lib.js';
import { pronunciationDto } from '../apps/api/src/modules/pronunciation.js';
import { catalogWordDto } from '../apps/api/src/modules/content.js';
import type { WordWithSenses } from '../apps/api/src/modules/shared.js';
import type { ContentPack } from '@prisma/client';

describe('licensed IPA pack invariants', () => {
  it('keeps independent data licenses and immutable source hashes', () => {
    expect(phoneticsPacks.us.license).toBe('MIT AND BSD-2-Clause');
    expect(phoneticsPacks.uk.license).toBe('GPL-3.0-only');
    expect(phoneticsPacks.uk.licenses.some((license) => license.filename.includes('GPL-3.0'))).toBe(
      true,
    );
    for (const pack of Object.values(phoneticsPacks)) {
      expect(pack.sourceUrl).toContain(pack.version);
      expect(pack.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('matches canonical spelling and retains all actual IPA variants', () => {
    const parsed = parsePhoneticsTsv('ＲＡＩＮ\t/ˈɹeɪn/\nread\t/ˈɹɛd/, /ˈɹid/\nRAIN\t/ɹeɪn/\n');
    expect(parsed.sourceEntryCount).toBe(3);
    expect(parsed.entries).toEqual([
      { normalizedLemma: 'rain', ipa: '/ˈɹeɪn/, /ɹeɪn/' },
      { normalizedLemma: 'read', ipa: '/ˈɹɛd/, /ˈɹid/' },
    ]);
    expect(normalizePhoneticLemma(' Don’t ')).toBe("don't");
    expect(() => parsePhoneticsTsv('rain\trein')).toThrow();
    expect(() => parsePhoneticsTsv('rain\t/ɹeɪn/\textra')).toThrow();
  });
  it('labels modern accent IPA separately from legacy source notation and never fabricates audio', () => {
    const dto = pronunciationDto({
      id: 'rain',
      lemma: 'rain',
      phonetic: 'rein',
      sourceRef: 'pack:ecdict',
      phoneticUs: '/ˈɹeɪn/',
      phoneticUk: '/ɹˈeɪn/',
      phoneticSource: `${phoneticsPacks.us.id};${phoneticsPacks.uk.id}`,
    });
    expect(dto.phonetics.map((item) => [item.region, item.notation])).toEqual([
      ['US', 'ipa'],
      ['UK', 'ipa'],
      ['unspecified', 'source-transcription'],
    ]);
    expect(dto.audio).toEqual([]);
    expect(
      pronunciationDto({ id: 'uncovered', lemma: 'uncovered', phonetic: '', sourceRef: '' })
        .phonetics,
    ).toEqual([]);
  });
  it('distinguishes retained original examples from imported definitions and flags word edits', () => {
    const word = {
      id: 'demo-word-001',
      lemma: 'rain',
      phonetic: 'rein',
      phoneticUs: '',
      phoneticUk: '',
      phoneticSource: '',
      difficulty: 1,
      status: 'published',
      goalTags: ['daily'],
      contentVersion: 'demo-2026-10-14',
      sourceRef: 'NightStudy original demo',
      senses: [
        {
          id: 'content-ecdict-zh-rain',
          pos: 'n.',
          definitionZh: '雨\n降雨',
          definitionEn: '',
          exampleEn: '',
          exampleZh: '',
        },
        {
          id: 'demo-word-001-sense-1',
          pos: 'n.',
          definitionZh: '雨',
          definitionEn: 'rain',
          exampleEn: 'I hear rain.',
          exampleZh: '我听到了雨声。',
        },
      ],
    } as unknown as WordWithSenses;
    const pack = {
      id: 'ecdict-fixed',
      version: 'fixed',
      license: 'MIT',
      sourceUrl: 'https://example.com/source',
      sha256: 'a'.repeat(64),
      entryCount: 2,
      phoneticCount: 1,
      definitionZhCount: 2,
      definitionEnCount: 2,
      tagCounts: {},
      installedAt: new Date(0),
      updatedAt: new Date(0),
      status: 'ready',
    } as ContentPack;
    const dto = catalogWordDto(word, [pack]);
    expect(dto.senses[0]?.definitionZh).toBe('雨\n降雨');
    expect(dto.senses[0]?.source).toMatchObject({
      kind: 'dictionary',
      packId: 'ecdict-fixed',
      license: 'MIT',
      wordHasSiteEdits: false,
    });
    expect(dto.senses[0]?.exampleSource).toBeNull();
    expect(dto.senses[1]?.exampleSource).toBeNull();
    expect(catalogWordDto(word, [pack], false, true).senses[1]?.exampleSource).toMatchObject({
      kind: 'original-demo',
      reference: 'NightStudy original demo',
    });
    word.contentVersion = 'edit-123';
    expect(catalogWordDto(word, [pack]).senses[0]?.source).toMatchObject({
      wordHasSiteEdits: true,
      siteEditVersion: 'edit-123',
    });
  });
});
