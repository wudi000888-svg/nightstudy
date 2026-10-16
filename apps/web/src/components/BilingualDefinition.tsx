import { ChevronDown } from 'lucide-react';
import { dictionaryText } from '../lib/dictionary';
import { InteractiveEnglish } from './InteractiveEnglish';

export function definitionPreview(text: string, language: 'en' | 'zh-CN') {
  const normalized = dictionaryText(text).replace(/\s+/g, ' ');
  const characters = Array.from(normalized);
  const limit = language === 'en' ? 180 : 72;
  if (characters.length <= limit) return normalized;
  let preview = characters.slice(0, limit).join('');
  if (language === 'en') {
    const boundary = preview.lastIndexOf(' ');
    if (boundary > limit / 2) preview = preview.slice(0, boundary);
  }
  return preview.trimEnd() + '…';
}

function DefinitionText({
  text,
  language,
  interactive,
}: {
  text: string;
  language: 'en' | 'zh-CN';
  interactive: boolean;
}) {
  const english = language === 'en';
  const className = english ? 'meaning-en' : 'meaning-zh';
  const content = (value: string) =>
    english ? <InteractiveEnglish text={value} enabled={interactive} /> : value;
  const long = Array.from(text).length > (english ? 260 : 90) || text.split('\n').length > 4;
  if (!long)
    return (
      <p className={className} lang={language}>
        {content(text)}
      </p>
    );
  return (
    <details className="definition-disclosure">
      <summary>
        <span className={`${className} definition-preview`} lang={language}>
          {content(definitionPreview(text, language))}
        </span>
        <span className="definition-toggle">
          <span className="definition-show">展开完整{english ? '英文' : '中文'}释义</span>
          <span className="definition-hide">收起{english ? '英文' : '中文'}释义</span>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </summary>
      <p className={className} lang={language}>
        {content(text)}
      </p>
    </details>
  );
}

/** Both languages must come from this same sense; never pair unrelated POS rows. */
export function BilingualDefinition({
  chinese,
  english,
  interactive,
}: {
  chinese?: string;
  english?: string;
  interactive: boolean;
}) {
  const zh = dictionaryText(chinese),
    en = dictionaryText(english);
  if (!zh && !en) return null;
  return (
    <div
      className="bilingual-definition"
      aria-label={zh && en ? '中英释义对照' : zh ? '中文释义' : '英文释义'}
    >
      {zh && (
        <div className="bilingual-cell" lang="zh-CN">
          <DefinitionText text={zh} language="zh-CN" interactive={false} />
        </div>
      )}
      {en && (
        <div className="bilingual-cell" lang="en">
          <DefinitionText text={en} language="en" interactive={interactive} />
        </div>
      )}
    </div>
  );
}
