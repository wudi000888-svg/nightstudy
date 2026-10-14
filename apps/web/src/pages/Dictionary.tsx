import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRemote } from '../AppContext';
import { ErrorNotice, Heading, Loading, Panel } from '../components/UI';
import type { Word } from '../lib/types';

type Pack = { id: string; license: string; sourceUrl: string };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function SourceRecord({ value }: { value: unknown }) {
  const source = object(value);
  if (!Object.keys(source).length) return null;
  const name = String(
    source.sourceName ??
      (source.kind === 'dictionary' ? 'ECDICT' : (source.author ?? 'NightStudy 编写')),
  );
  const owner = source.sourceOwner ?? source.owner ?? source.author;
  const href =
    typeof source.sourceUrl === 'string' && /^https:\/\//.test(source.sourceUrl)
      ? source.sourceUrl
      : null;
  return (
    <p className="muted">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {name}
        </a>
      ) : (
        name
      )}
      {owner && name !== owner ? ` · ${String(owner)}` : ''}
      {source.translationAuthor ? ` · 中文译者 ${String(source.translationAuthor)}` : ''}
      {source.license ? ` · ${String(source.license)}` : ''}
      {source.publisherAttribution ? ` · ${String(source.publisherAttribution)}` : ''}
      {source.review === 'pending' ? ' · 待校对' : ''}
      {source.kind === 'machine-translation'
        ? ' · 机器翻译'
        : source.kind === 'generated'
          ? ' · 生成例句'
          : ''}
    </p>
  );
}
export function DictionaryPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const data = useRemote<{ packs: Pack[]; word: Word | null }>(
    'dictionary-credits',
    `dictionary/credits?q=${encodeURIComponent(query)}`,
  );
  return (
    <div className="page narrow">
      <Heading
        eyebrow="DICTIONARY"
        title="词典说明"
        description="查看词典、例句和发音的出处。"
        action={
          <Link className="button" to="/lookup">
            返回查词
          </Link>
        }
      />
      <Panel>
        <h2>英汉词典与词组</h2>
        <p>
          基础词库使用 ECDICT；词组本由 NightStudy
          编选。英文解释与中文释义可能来自不同义项，分别列出时请结合词性和语境理解。
        </p>
        <p>
          例句选自 Tatoeba，或由 NightStudy
          辅助编写。新增解释和例句仍在持续校对。本站未采用柯林斯或牛津的授权内容。
        </p>
        <h2>英式与美式发音</h2>
        <p>部分词使用公开录音，其余使用开源语音合成。合成发音与推导音标尚未经过逐词专家审定。</p>
        {data.data?.packs.map((pack) => (
          <p className="muted" key={pack.id}>
            <a href={pack.sourceUrl} target="_blank" rel="noreferrer">
              {pack.id.startsWith('ecdict')
                ? 'ECDICT 词典'
                : pack.id.startsWith('phrase')
                  ? 'NightStudy 词组'
                  : pack.id.startsWith('bilingual')
                    ? '双语例句与解释'
                    : pack.id.startsWith('audio')
                      ? '英美发音'
                      : '音标资料'}
            </a>{' '}
            · {pack.license}
          </p>
        ))}
      </Panel>
      <Panel>
        <h2>查询具体词条</h2>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(input.trim());
          }}
        >
          <input
            aria-label="查询词条出处"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入单词或词组"
          />
          <button className="button primary">查询</button>
        </form>
        <ErrorNotice error={data.error} />
        {data.isPending && <Loading />}
        {query && data.data && !data.data.word && <p className="muted">没有找到这个词条。</p>}
        {data.data?.word && (
          <div>
            <h2>{data.data.word.lemma}</h2>
            {data.data.word.learningDefinitions?.map((sense) => (
              <div key={`usage-${sense.id}`}>
                <h3>用法整理</h3>
                <p>
                  {sense.pos} {sense.definitionZh}
                </p>
                <p>{sense.definitionEn}</p>
                <SourceRecord value={sense.contentMetadata?.definitionZh} />
              </div>
            ))}
            {data.data.word.senses?.map((sense) => (
              <div key={sense.id}>
                <p>
                  {sense.pos} {sense.definitionZh}
                </p>
                <p>{sense.definitionEn}</p>
                <SourceRecord value={sense.source} />
                {Object.entries(sense.contentMetadata ?? {})
                  .filter(([key]) =>
                    ['definitionZh', 'definitionEn', 'exampleZh', 'exampleEn'].includes(key),
                  )
                  .map(([key, source]) => (
                    <SourceRecord key={key} value={source} />
                  ))}
              </div>
            ))}
            {data.data.word.examples?.map((example) => (
              <div key={example.id}>
                <p>{example.exampleEn}</p>
                <p>{example.exampleZh}</p>
                <SourceRecord value={example.contentMetadata?.exampleEn} />
                <SourceRecord value={example.contentMetadata?.exampleZh} />
              </div>
            ))}
            {data.data.word.audio?.map((audio) => (
              <p className="muted" key={audio.id}>
                {audio.accent === 'US' ? '美式' : '英式'} ·{' '}
                {audio.kind === 'synthesized' ? '合成发音' : '公开录音'} ·{' '}
                <a href={audio.sourceUrl ?? undefined} target="_blank" rel="noreferrer">
                  {audio.sourceName}
                </a>{' '}
                · {audio.attribution} · {audio.license}
              </p>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
