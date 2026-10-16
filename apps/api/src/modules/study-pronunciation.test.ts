import { describe, expect, it } from 'vitest';
import { sessionDto } from './study.js';

describe('issued session current pronunciation policy', () => {
  const fixture = () =>
    ({
      id: 'session-policy-test',
      phase: 'learn',
      status: 'active',
      items: [
        {
          id: 'item-policy-test',
          wordId: 'word-record',
          contentSnapshot: {
            id: 'word-record',
            lemma: 'record',
            phonetic: '/stale/',
            phoneticUs: '/stale/',
            phoneticUk: '/stale/',
            pronunciationCompatible: true,
            audio: [{ id: 'old-audio' }],
            senses: [{ id: 'old-source', definitionZh: '原题释义' }],
          },
          questionJson: { answer: 'record' },
          revealed: false,
        },
      ],
    }) as unknown as Parameters<typeof sessionDto>[0];

  it('masks withdrawn pronunciation before reveal, without disclosing or mutating the issued meaning', () => {
    const session = fixture(),
      before = structuredClone(session);
    const view = sessionDto(session, [], null, new Map(), new Map([['word-record', false]]));
    expect(view.items[0]!.word).toMatchObject({
      lemma: 'record',
      pronunciationCompatible: false,
      phonetic: '',
      phoneticUs: '',
      phoneticUk: '',
    });
    expect(view.items[0]!.word).not.toHaveProperty('senses');
    expect(session).toEqual(before);
  });
  it('preserves the explicit blocked flag in newly issued hidden snapshots', () => {
    const session = fixture();
    (session.items[0]!.contentSnapshot as Record<string, unknown>).pronunciationCompatible = false;
    expect(sessionDto(session).items[0]!.word).toMatchObject({
      pronunciationCompatible: false,
      phoneticUs: '',
      phoneticUk: '',
    });
  });
});
