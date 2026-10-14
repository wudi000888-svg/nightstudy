import { api, ApiError } from './api';
import type { Sense, Word } from './types';

export interface AdminWordTarget {
  wordId: string;
  senseId?: string;
  sourceField?: 'definitionZh' | 'definitionEn';
  sourceHash?: string;
}
export type CandidateSourceStatus = 'unbound' | 'matched' | 'changed' | 'unverifiable';

export function adminWordEditorUrl(target: AdminWordTarget) {
  const query = new URLSearchParams({ wordId: target.wordId });
  if (target.senseId) query.set('senseId', target.senseId);
  if (target.sourceField) query.set('sourceField', target.sourceField);
  if (target.sourceHash) query.set('sourceHash', target.sourceHash);
  return `/admin/words?${query}`;
}

export function adminWordTarget(search: string): AdminWordTarget | null {
  const query = new URLSearchParams(search);
  const wordId = query.get('wordId');
  if (!wordId) return null;
  const sourceField = query.get('sourceField');
  return {
    wordId,
    senseId: query.get('senseId') ?? undefined,
    sourceField:
      sourceField === 'definitionZh' || sourceField === 'definitionEn' ? sourceField : undefined,
    sourceHash: query.get('sourceHash') ?? (sourceField ? 'invalid' : undefined),
  };
}

export async function loadAdminWord(target: AdminWordTarget, signal?: AbortSignal) {
  const { word } = await api<{ word: Word }>(`admin/words/${encodeURIComponent(target.wordId)}`, {
    signal,
  });
  if (
    word.id !== target.wordId ||
    !word.contentVersion ||
    !Array.isArray(word.senses) ||
    !['published', 'draft', 'archived'].includes(word.status ?? '')
  )
    throw new ApiError(502, '未能读取完整原始词条，请重新载入。');
  const sense = target.senseId
    ? (word.senses.find((value) => value.id === target.senseId) ?? null)
    : (word.senses.find((value) => value.definitionZh?.trim()) ?? word.senses[0] ?? null);
  let sourceStatus: CandidateSourceStatus = 'unbound';
  if (target.sourceHash || target.sourceField) {
    sourceStatus = 'unverifiable';
    if (sense && target.sourceField && /^[a-f0-9]{64}$/.test(target.sourceHash ?? '')) {
      try {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(sense[target.sourceField] ?? ''),
        );
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        sourceStatus = hash === target.sourceHash ? 'matched' : 'changed';
      } catch {
        sourceStatus = 'unverifiable';
      }
    }
  }
  return { word, sense: sense ? { ...sense } : null, sourceStatus };
}

export function adminWordPatch(word: Word, sense: Sense) {
  if (!word.contentVersion || !word.senses?.some((value) => value.id === sense.id))
    throw new ApiError(409, '请先读取完整词条并选择属于该词的原始义项。');
  if (!sense.definitionZh?.trim() && !sense.definitionEn?.trim())
    throw new ApiError(400, '中文或英文释义至少保留一项。');
  return {
    status: word.status,
    expectedContentVersion: word.contentVersion,
    senseId: sense.id,
    definitionZh: sense.definitionZh ?? '',
    definitionEn: sense.definitionEn ?? '',
    exampleEn: sense.exampleEn ?? '',
    exampleZh: sense.exampleZh ?? '',
  };
}
