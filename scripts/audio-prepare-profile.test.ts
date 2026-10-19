import { describe, expect, it } from 'vitest';
import { audioPreparationOptions } from './audio-prepare.js';

describe('explicit canonical word-audio preparation scope', () => {
  it('prepares only the fixed word pack without admitting a sentence collection', () => {
    const plan = audioPreparationOptions(['--words-only'], {
      CONTENT_PACK: 'ecdict',
      AUDIO_PACK: 'standard',
    });
    expect(plan).toEqual({
      profile: 'standard',
      wordsOnly: true,
      sourceFiles: ['word-audio-v2.manifest.json'],
      includeCollection: false,
    });
  });

  it('keeps the ordinary complete installation scope with all legacy packs and the collection', () => {
    expect(audioPreparationOptions([], { CONTENT_PACK: 'ecdict' })).toEqual({
      profile: 'standard',
      wordsOnly: false,
      sourceFiles: [
        'word-audio-v2.manifest.json',
        'sentence-audio.manifest.json',
        'sentence-audio-v2.manifest.json',
        'sentence-audio-v3.manifest.json',
      ],
      includeCollection: true,
    });
  });

  it('preserves an explicitly disabled or demo audio installation', () => {
    for (const environment of [{ AUDIO_PACK: 'none' }, { CONTENT_PACK: 'demo' }]) {
      expect(audioPreparationOptions([], environment)).toEqual({
        profile: 'none',
        wordsOnly: false,
        sourceFiles: [],
        includeCollection: false,
      });
      expect(() => audioPreparationOptions(['--words-only'], environment)).toThrow(
        'audio_words_only_requires_standard',
      );
    }
  });

  it('requires the explicit flag and never treats an unknown profile as standard', () => {
    expect(() => audioPreparationOptions(['--words-only'], { AUDIO_PACK: 'all' })).toThrow(
      'invalid_audio_profile',
    );
    expect(
      audioPreparationOptions(['--words-only'], {
        CONTENT_PACK: 'demo',
        AUDIO_PACK: 'standard',
      }).wordsOnly,
    ).toBe(true);
  });

  it('rejects custom manifests, policy bypasses, positional targets and boolean values', () => {
    for (const args of [
      ['--manifest', 'other.json'],
      ['--words-only', '--skip-policy'],
      ['--words-only', 'sentence-audio-v4-0101'],
      ['--words-only=false'],
    ]) {
      expect(() => audioPreparationOptions(args, { AUDIO_PACK: 'standard' })).toThrow();
    }
  });
});
