import { useId, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, MessageCircle } from 'lucide-react';
import type { Sense, Word } from '../../lib/types';
import { dictionaryText } from '../../lib/dictionary';
import { InteractiveEnglish } from '../InteractiveEnglish';
import { SentenceSaveButton } from '../SentenceSaveButton';
import { SentenceAudioButton } from '../SentenceAudio';
import { BilingualDefinition } from '../BilingualDefinition';

export interface StudyExample {
  id: string;
  sourceId: string;
  english: string;
  chinese: string;
  origin: 'sense' | 'word';
}

// A word-level example demonstrates usage of the word, not a verified match to
// the currently selected sense. Preserve that distinction in the visible label.
export function studyExamples(word: Word, sense: Sense | undefined): StudyExample[] {
  const candidates: StudyExample[] = [
    ...(sense && (dictionaryText(sense.exampleEn) || dictionaryText(sense.exampleZh))
      ? [
          {
            id: `sense:${sense.id}`,
            sourceId: sense.id,
            english: dictionaryText(sense.exampleEn),
            chinese: dictionaryText(sense.exampleZh),
            origin: 'sense' as const,
          },
        ]
      : []),
    ...(word.examples ?? []).map((example) => ({
      id: `word:${example.id}`,
      sourceId: example.id,
      english: dictionaryText(example.exampleEn),
      chinese: dictionaryText(example.exampleZh),
      origin: 'word' as const,
    })),
  ];
  const seen = new Set<string>();
  return candidates.filter((example) => {
    if (!example.english && !example.chinese) return false;
    const key = JSON.stringify([example.english, example.chinese]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ExampleContext({
  wordId,
  examples,
  interactive,
}: {
  wordId: string;
  examples: StudyExample[];
  interactive: boolean;
}) {
  const [index, setIndex] = useState(0);
  const activeIndex = Math.max(0, Math.min(index, examples.length - 1));
  const example = examples[activeIndex];
  const bodyId = useId();
  if (!example) return null;
  return (
    <details className="study-context-card" open>
      <summary>
        <span className="study-section-label">
          <MessageCircle size={16} /> 语境 <span>{examples.length} 条例句</span>
          <ChevronDown size={15} className="study-context-chevron" aria-hidden="true" />
        </span>
        <span className="study-context-preview" lang={example.english ? 'en' : 'zh-CN'}>
          {example.english || example.chinese}
        </span>
        <span className="study-context-open">
          展开例句 <ChevronDown size={15} />
        </span>
      </summary>
      <div className="study-context-body" id={bodyId}>
        <div className="study-context-toolbar">
          <span>
            {example.origin === 'sense' ? '本义项例句' : '单词用法'} · {activeIndex + 1} /{' '}
            {examples.length}
          </span>
          {examples.length > 1 && (
            <div className="study-context-arrows">
              <button
                type="button"
                aria-label="上一条例句"
                aria-controls={bodyId}
                disabled={activeIndex <= 0}
                onClick={() => setIndex(Math.max(0, activeIndex - 1))}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                aria-label="下一条例句"
                aria-controls={bodyId}
                disabled={activeIndex >= examples.length - 1}
                onClick={() => setIndex(Math.min(examples.length - 1, activeIndex + 1))}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>
        <div className="study-context-sentence" key={example.id} aria-live="polite">
          {example.english && (
            <p className="example-en" lang="en">
              <InteractiveEnglish text={example.english} enabled={interactive} />
            </p>
          )}
          {example.chinese && (
            <p className="example-zh" lang="zh-CN">
              {example.chinese}
            </p>
          )}
          {example.english && <SentenceAudioButton text={example.english} />}
          {interactive && example.english && example.chinese && (
            <SentenceSaveButton
              key={example.id}
              wordId={wordId}
              sourceType={example.origin === 'sense' ? 'sense' : 'word-example'}
              sourceId={example.sourceId}
              compact
            />
          )}
        </div>
      </div>
    </details>
  );
}

export function StudyWordDetails({
  word,
  senses,
  englishSenses,
  interactive,
}: {
  word: Word;
  senses: Sense[];
  englishSenses: Sense[];
  interactive: boolean;
}) {
  const [index, setIndex] = useState(0);
  const meaningId = useId();
  const activeIndex = Math.max(0, Math.min(index, senses.length - 1));
  const sense = senses[activeIndex];
  const examples = studyExamples(word, sense);
  const collocations = (word.collocations ?? []).filter((entry) => dictionaryText(entry.lemma));
  function select(next: number) {
    setIndex(next);
  }
  return (
    <div className="study-word-details">
      {sense ? (
        <section className="study-meaning-browser" aria-label="词义">
          <div className="study-meaning-topline">
            <span className="sense-pos">{sense.pos || '词义'}</span>
            {senses.length > 1 && (
              <div className="study-meaning-controls">
                <span>
                  {activeIndex + 1} / {senses.length} 义
                </span>
                <button
                  type="button"
                  aria-label="上一义项"
                  aria-controls={meaningId}
                  disabled={activeIndex <= 0}
                  onClick={() => select(Math.max(0, activeIndex - 1))}
                >
                  <ChevronUp size={17} />
                </button>
                <button
                  type="button"
                  aria-label="下一义项"
                  aria-controls={meaningId}
                  disabled={activeIndex >= senses.length - 1}
                  onClick={() => select(Math.min(senses.length - 1, activeIndex + 1))}
                >
                  <ChevronDown size={17} />
                </button>
              </div>
            )}
          </div>
          <div className="study-meaning-scroll" id={meaningId}>
            <div className="study-meaning-copy" key={sense.id}>
              <BilingualDefinition
                chinese={sense.definitionZh}
                english={sense.definitionEn}
                interactive={interactive}
              />
            </div>
          </div>
        </section>
      ) : (
        <p className="study-content-empty">暂无释义。</p>
      )}
      {examples.length > 0 && (
        <ExampleContext
          key={`${word.id}:${sense?.id ?? ''}`}
          wordId={word.id}
          examples={examples}
          interactive={interactive}
        />
      )}
      {englishSenses.length > 0 && (
        <details className="study-independent-english" aria-label="这个词的独立英文解释">
          <summary>
            更多英文释义 <span>{englishSenses.length} 义</span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          {englishSenses.map((entry) => (
            <div key={entry.id}>
              {entry.pos && <span className="sense-pos">{entry.pos}</span>}
              <BilingualDefinition english={entry.definitionEn} interactive={interactive} />
            </div>
          ))}
        </details>
      )}
      {collocations.length > 0 && (
        <details className="study-collocations">
          <summary>
            <span>
              常用搭配 <small>{collocations.length}</small>
            </span>
            <ChevronDown size={16} />
          </summary>
          <div className="study-collocations-list">
            {collocations.map((entry) => (
              <article key={entry.id}>
                <p lang="en">
                  <InteractiveEnglish text={entry.lemma} enabled={interactive} />
                </p>
                {entry.pos && <span className="sense-pos">{entry.pos}</span>}
                {dictionaryText(entry.definitionZh) && (
                  <p lang="zh-CN">{dictionaryText(entry.definitionZh)}</p>
                )}
                {dictionaryText(entry.definitionEn) && (
                  <p className="meaning-en" lang="en">
                    <InteractiveEnglish
                      text={dictionaryText(entry.definitionEn)}
                      enabled={interactive}
                    />
                  </p>
                )}
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
