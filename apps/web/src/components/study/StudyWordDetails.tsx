import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, MessageCircle } from 'lucide-react';
import type { Sense, Word } from '../../lib/types';
import { dictionaryText } from '../../lib/dictionary';
import { InteractiveEnglish } from '../InteractiveEnglish';
import { SentenceSaveButton } from '../SentenceSaveButton';
import { SentenceAudioButton } from '../SentenceAudio';
import { BilingualDefinition } from '../BilingualDefinition';
import { stopApplicationAudio } from '../../lib/audio-manager';
import { senseDisplayLemma, wordSpellingVariants } from '../../lib/word-spelling';

export interface StudyExample {
  id: string;
  sourceId: string;
  english: string;
  chinese: string;
  contextLabel: string;
}

// Only reviewed examples belonging to this meaning can enter its context.
export function studyExamples(_word: Word, sense: Sense | undefined): StudyExample[] {
  const candidates: StudyExample[] = (sense?.examples ?? [])
    .filter((example) => example.learningSenseId === sense?.id)
    .map((example) => ({
      id: example.id,
      sourceId: example.id,
      english: dictionaryText(example.exampleEn),
      chinese: dictionaryText(example.exampleZh),
      contextLabel: dictionaryText(example.contextLabel),
    }));
  const seen = new Set<string>();
  return candidates.filter((example) => {
    if (!example.english || !example.chinese) return false;
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
  if (!example) return <p className="study-content-empty study-example-empty">本义项暂无例句。</p>;
  function selectExample(next: number) {
    stopApplicationAudio();
    setIndex(next);
  }
  return (
    <details className="study-context-card" open>
      <summary>
        <span className="study-section-label">
          <MessageCircle size={16} /> 双语例句
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
            {example.contextLabel || '本义项语境'}
            {examples.length > 1 ? ` · ${activeIndex + 1} / ${examples.length}` : ''}
          </span>
          {examples.length > 1 && (
            <div className="study-context-arrows">
              <button
                type="button"
                aria-label="上一条例句"
                aria-controls={bodyId}
                disabled={activeIndex <= 0}
                onClick={() => selectExample(Math.max(0, activeIndex - 1))}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                aria-label="下一条例句"
                aria-controls={bodyId}
                disabled={activeIndex >= examples.length - 1}
                onClick={() => selectExample(Math.min(examples.length - 1, activeIndex + 1))}
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
              sourceType="word-example"
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
  selectedSenseId,
  onSenseChange,
  showDirectory = false,
}: {
  word: Word;
  senses: Sense[];
  englishSenses: Sense[];
  interactive: boolean;
  selectedSenseId?: string;
  onSenseChange?: (id: string) => void;
  showDirectory?: boolean;
}) {
  const [selection, setSelection] = useState({
    wordId: word.id,
    focusId: selectedSenseId,
    senseId: selectedSenseId,
  });
  const [extension, setExtension] = useState('collocations');
  const meaningId = useId();
  const extensionId = useId();
  const currentSenseId = onSenseChange
    ? selectedSenseId
    : selection.wordId === word.id && selection.focusId === selectedSenseId
      ? selection.senseId
      : selectedSenseId;
  const selectedIndex = currentSenseId
    ? senses.findIndex((entry) => entry.id === currentSenseId)
    : -1;
  const activeIndex = Math.max(0, Math.min(selectedIndex, senses.length - 1));
  const sense = senses[activeIndex];
  const showSpelling = wordSpellingVariants(word).length > 1;
  useEffect(() => () => stopApplicationAudio(), [word.id, sense?.id]);
  const examples = studyExamples(word, sense);
  const collocations = (word.collocations ?? []).filter((entry) => dictionaryText(entry.lemma));
  const extensions = [
    ...(collocations.length ? [{ id: 'collocations', label: '词组搭配' }] : []),
    ...(englishSenses.length ? [{ id: 'english', label: '英文解释' }] : []),
  ];
  const activeExtension = extensions.find((entry) => entry.id === extension) ?? extensions[0];
  function select(next: number) {
    stopApplicationAudio();
    setSelection({ wordId: word.id, focusId: selectedSenseId, senseId: senses[next]?.id });
    if (senses[next]) onSenseChange?.(senses[next].id);
  }
  return (
    <div className="study-word-details">
      {showDirectory && senses.length > 1 && (
        <div className="lookup-sense-directory" role="group" aria-label="选择词义">
          {senses.map((entry, order) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={entry.id === sense?.id}
              onClick={() => select(order)}
            >
              <span>
                {showSpelling && senseDisplayLemma(word, entry)
                  ? `${senseDisplayLemma(word, entry)} · `
                  : ''}
                {entry.pos || '词义'}
              </span>
              <span className="lookup-sense-label">
                {dictionaryText(entry.definitionZh) || dictionaryText(entry.definitionEn)}
              </span>
            </button>
          ))}
        </div>
      )}
      {sense ? (
        <section className="study-meaning-browser" aria-label="词义">
          <div className="study-meaning-topline">
            <span className="sense-pos">
              {showSpelling && senseDisplayLemma(word, sense)
                ? `${senseDisplayLemma(word, sense)} · `
                : ''}
              {sense.pos || '词义'}
            </span>
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
      {sense && (
        <ExampleContext
          key={`${word.id}:${sense?.id ?? ''}`}
          wordId={word.id}
          examples={examples}
          interactive={interactive}
        />
      )}
      {activeExtension && (
        <section className="study-extensions" aria-label="相关内容">
          <div className="study-extension-tabs" role="tablist" aria-label="相关内容分类">
            {extensions.map((entry, order) => (
              <button
                type="button"
                role="tab"
                id={`${extensionId}-${entry.id}-tab`}
                aria-controls={`${extensionId}-${entry.id}-panel`}
                aria-selected={entry.id === activeExtension.id}
                tabIndex={entry.id === activeExtension.id ? 0 : -1}
                key={entry.id}
                onClick={() => setExtension(entry.id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (order + 1) % extensions.length
                      : event.key === 'ArrowLeft'
                        ? (order + extensions.length - 1) % extensions.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? extensions.length - 1
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  const target = extensions[next]!;
                  setExtension(target.id);
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>(`[id="${extensionId}-${target.id}-tab"]`)
                    ?.focus();
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {extensions.map((entry) => (
            <div
              className="study-extension-panel"
              role="tabpanel"
              aria-label={entry.label}
              aria-labelledby={`${extensionId}-${entry.id}-tab`}
              id={`${extensionId}-${entry.id}-panel`}
              hidden={entry.id !== activeExtension.id}
              tabIndex={0}
              key={entry.id}
            >
              {entry.id === 'english' ? (
                <div className="study-independent-english" aria-label="这个词的独立英文解释">
                  {englishSenses.map((entry) => (
                    <div key={entry.id}>
                      {entry.pos && <span className="sense-pos">{entry.pos}</span>}
                      <BilingualDefinition english={entry.definitionEn} interactive={interactive} />
                    </div>
                  ))}
                </div>
              ) : (
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
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
