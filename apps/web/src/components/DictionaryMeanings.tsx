import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { dictionaryText } from '../lib/dictionary';
import type { Sense } from '../lib/types';
import { BilingualDefinition } from './BilingualDefinition';

/** Source rows remain independent of the prepared learning meanings and examples. */
export function DictionaryMeanings({
  senses,
  interactive,
}: {
  senses: Sense[];
  interactive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const definitions = senses.filter((sense) =>
    [sense.definitionZh, sense.definitionEn].some((text) => !!dictionaryText(text)),
  );
  if (!definitions.length) return null;
  return (
    <details
      className="dictionary-meanings"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span>更多词典释义</span>
        <span className="dictionary-meanings-count">{definitions.length}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </summary>
      {open && (
        <div className="dictionary-meanings-body">
          <p className="dictionary-meanings-note">以下释义暂无配套例句。</p>
          {definitions.map((sense) => (
            <section className="dictionary-meaning" key={sense.id}>
              {dictionaryText(sense.pos) && (
                <span className="sense-pos">{dictionaryText(sense.pos)}</span>
              )}
              <BilingualDefinition
                chinese={sense.definitionZh}
                english={sense.definitionEn}
                interactive={interactive}
              />
            </section>
          ))}
        </div>
      )}
    </details>
  );
}
