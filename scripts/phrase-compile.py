#!/usr/bin/env python3
"""Compile attributed phrase books with source-bound original glosses; no MT/runtime model."""
import argparse
import gzip
import hashlib
import io
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

PACK_ID = 'phrase-books-v1'
VERSION = '2026-10-14-v1'
BOOK_COUNTS = {'cet4-phrases': 236, 'cet6-phrases': 201}
BOOK_MAP = {'basic': 'cet4-phrases', 'advanced': 'cet6-phrases'}
STOPWORDS = set('a an the and or but if as at by for from in into of on onto out over per than that this these those to up upon with without about across after along around away back down through under until all any each every few more most much no not one other same some such both either neither i me my mine we us our ours you your yours he him his she her hers it its they them their theirs who whom whose which what where when why how be been being is are was were am can could may might must shall should will would do does did have has had'.split())


DISPLAY_POS_GROUPS = {
    'det. phr.': 'a little|a lot of|a number of',
    'pron. phr.': 'each other|one another',
    'modal phr.': 'had better|have to|used to|be supposed to',
    'adj. phr.': 'be able to|be afraid of|be familiar with|be fond of|be good at|be interested in|be proud of|be responsible for|be used to|be aware of|be bound to|be concerned with|be entitled to|be opposed to|be willing to|free from|out of order|out of work|out of date|out of the question|under control|up to date|at stake',
    'conj. phr.': 'as far as|as long as|as soon as|as well as|even if|even though|so that|in order to|so as to|on condition that',
    'prep. phr.': 'according to|ahead of|apart from|because of|thanks to|in case of|instead of|next to|in front of|in charge of|in spite of|such as|as for|as regards|at the expense of|at the mercy of|at the risk of|by means of|by virtue of|due to|except for|for lack of|for the sake of|in accordance with|in addition to|in connection with|in contrast to|in favour of|in light of|in line with|in proportion to|in regard to|in relation to|in response to|in the course of|in the event of|in view of|on account of|on behalf of|prior to|regardless of|with regard to|with respect to',
    'adv. phr.': 'above all|after all|all in all|all of a sudden|all the time|and so on|as a matter of fact|as a result|as usual|as well|at first|at last|at least|at once|at present|at the same time|at times|by accident|by chance|by hand|by mistake|by the way|every now and then|far away|first of all|for example|for instance|from now on|from time to time|in a hurry|in advance|in all|in case|in common|in fact|in general|in return|in the end|in time|let alone|little by little|more or less|no longer|not at all|not only|now and then|of course|on average|on foot|on purpose|on the other hand|on time|once again|once more|over and over|right away|so far|to begin with|to make matters worse|at any rate|at best|at hand|at large|at length|at the most|by all means|by no means|for good|in addition|in any case|in brief|in contrast|in detail|in due course|in effect|in no way|in particular|in principle|in question|in the long run|on the contrary|on the whole|to some extent|to sum up|under way',
}
DISPLAY_POS = {lemma: pos for pos, lemmas in DISPLAY_POS_GROUPS.items() for lemma in lemmas.split('|')}


def display_pos(lemma):
    return DISPLAY_POS.get(lemma, 'phr. v.')


def pos_metadata(lemma):
    return {'authoredDisplayPos': display_pos(lemma), 'authoredDisplayPosSource': {
        'kind': 'original-authoring', 'review': 'pending', 'author': 'NightStudy contributors',
        'authoringMethod': 'Codex-assisted phrase classification'}}


def sha(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def normal(value):
    return ' '.join(unicodedata.normalize('NFKC', value).lower().strip().split())


def exact_phrase(phrase, text):
    boundary = lambda c: unicodedata.category(c)[0] in 'LM' or c.isdigit() or c == '_'
    for match in re.finditer(re.escape(phrase), text, re.I):
        start, end = match.span()
        if (start == 0 or not boundary(text[start - 1])) and (end == len(text) or not boundary(text[end])):
            return True
    return False


def text(value, label):
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > 4000:
        raise ValueError('invalid_' + label)
    return value


def author_metadata(language, source=None, reason=None):
    value = {'kind': 'original-authoring', 'review': 'pending', 'license': 'MIT',
             'author': 'NightStudy contributors', 'authoringMethod': 'Codex-assisted bilingual writing',
             'language': language}
    if source:
        value.update(sourceLanguage='zh', sourceSenseId=source['id'],
                     sourceTextSha256=sha(source['definitionZh']),
                     sourceReference='ECDICT pinned Chinese sense')
    if reason:
        value.update(correctionReason=reason, sourceRelation='correction-reference-not-literal-translation')
    return value


def original_example(example_en, example_zh):
    base = {'kind': 'generated', 'review': 'pending', 'license': 'MIT',
            'author': 'NightStudy contributors', 'authoringMethod': 'Codex-assisted original writing',
            'scope': 'word-level-usage-not-sense-aligned'}
    return {'exampleEn': example_en, 'exampleZh': example_zh,
            'contentMetadata': {'exampleEn': {**base, 'language': 'en'},
                                'exampleZh': {**base, 'language': 'zh'}}}


def corpus_example(lemma, evidence):
    if evidence.get('phrase') != lemma or not evidence.get('exactPhrasePresent'):
        raise ValueError('corpus_phrase_identity_mismatch')
    en, zh = evidence['englishSentence'], evidence['mandarinSentence']
    if en.get('lang') != 'eng' or zh.get('lang') != 'cmn' or zh.get('is_direct') is not True:
        raise ValueError('corpus_not_direct_english_chinese')
    if any(s.get('license') != 'CC BY 2.0 FR' or s.get('is_unapproved') is not False or not s.get('owner') for s in (en, zh)):
        raise ValueError('corpus_license_or_owner_not_verified')
    consistency = evidence.get('snapshotConsistency', {})
    for s in (en, zh):
        record = consistency.get(str(s['id']), {})
        snap = record.get('snapshotRecord', {})
        if record.get('allMatch') is not True or (snap.get('text'), snap.get('lang'), snap.get('owner')) != (s['text'], s['lang'], s['owner']):
            raise ValueError('corpus_snapshot_mismatch')
    result = {'exampleEn': text(en['text'], 'corpus_en'), 'exampleZh': text(zh['text'], 'corpus_zh'), 'contentMetadata': {}}
    for field, sentence in [('exampleEn', en), ('exampleZh', zh)]:
        url = f"https://tatoeba.org/en/sentences/show/{sentence['id']}"
        result['contentMetadata'][field] = {
            'kind': 'corpus', 'review': 'pending', 'license': 'CC-BY-2.0-FR',
            'sourceName': 'Tatoeba', 'sourceUrl': url, 'sourceSentenceId': sentence['id'],
            'author': sentence['owner'], 'authorRole': 'Current Tatoeba sentence owner; original author history not independently verified',
            'sourceOwner': sentence['owner'], 'sourceSnapshotDate': '2026-10-10',
            'linkVerifiedAt': evidence['verifiedAtUtc'], 'directLinkedSentenceId': zh['id'] if field == 'exampleEn' else en['id'],
            'language': 'en' if field == 'exampleEn' else 'zh', 'scope': 'word-level-usage-not-sense-aligned',
            'sourceTextSha256': sha(sentence['text']), 'adaptation': False}
    return result


def compile_rows(authored, lexical, selection, evidence=None, expected_counts=None):
    evidence = evidence or {}
    expected_counts = expected_counts if expected_counts is not None else BOOK_COUNTS
    lex = {x['normalizedLemma']: x for x in lexical}
    if len(lex) != len(lexical):
        raise ValueError('duplicate_lexical_word')
    sel = {x['normalizedLemma']: x for x in selection}
    if len(sel) != len(selection) or len(authored) != len(selection):
        raise ValueError('selection_or_authored_count_mismatch')
    authored_map = {x['normalizedLemma']: x for x in authored}
    if len(authored_map) != len(authored) or set(authored_map) != set(sel):
        raise ValueError('duplicate_or_unmatched_authored_word')
    result, review = [], []
    books = Counter()
    for lemma, selected in sel.items():
        if lemma != normal(lemma) or not re.fullmatch(r"[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){1,5}", lemma):
            raise ValueError('invalid_phrase_lemma')
        source = lex.get(lemma)
        if not source or source['wordId'] != selected['wordId']:
            raise ValueError('word_identity_mismatch')
        primary = next((s for s in source['senses'] if s.get('definitionZh')), None)
        if not primary or primary['id'] != selected['senseId'] or primary['definitionZh'] != selected['sourceText'] or sha(primary['definitionZh']) != selected['sourceTextSha256']:
            raise ValueError('primary_source_identity_mismatch')
        row = authored_map[lemma]
        book = BOOK_MAP.get(selected['book'], selected['book'])
        books[book] += 1
        senses = {s['id']: s for s in source['senses']}
        warnings = []
        for warning in row.get('warnings', []):
            sense = senses.get(warning.get('senseId', primary['id']))
            if not sense or not sense.get('definitionZh'):
                raise ValueError('warning_wrong_word_or_sense')
            warnings.append({'senseId': sense['id'], 'field': 'definitionZh', 'sourceTextSha256': sha(sense['definitionZh']),
                             'code': text(warning['code'], 'warning_code'), 'message': text(warning['message'], 'warning_message'),
                             'excludeFromLearning': warning.get('excludeFromLearning', True)})
        excluded = {w['senseId'] for w in warnings if w['excludeFromLearning']}
        patches = []
        candidates = [{'id': primary['id'], 'definitionEn': row.get('definitionEn', '')}] + row.get('additionalSenses', [])
        seen_senses = set()
        for candidate in candidates:
            sense_id = candidate['id']
            if sense_id in seen_senses or sense_id not in senses:
                raise ValueError('duplicate_or_cross_word_sense_patch')
            seen_senses.add(sense_id)
            old = senses[sense_id]
            if sense_id in excluded:
                if candidate.get('definitionEn'):
                    raise ValueError('excluded_source_must_not_be_translated')
                continue
            if old.get('definitionEn') != '' or not old.get('definitionZh'):
                raise ValueError('translation_original_target_not_empty')
            patches.append({'id': sense_id, 'sourceText': old['definitionZh'], 'sourceTextSha256': sha(old['definitionZh']),
                            'definitionEn': text(candidate.get('definitionEn'), 'definition_en'),
                            'contentMetadata': {'definitionEn': author_metadata('en', old), **(pos_metadata(lemma) if not old.get('pos') else {})}})
        chinese = {s['id'] for s in source['senses'] if s.get('definitionZh')}
        if chinese != ({p['id'] for p in patches} | excluded):
            raise ValueError('unaccounted_chinese_source_sense')
        compiled = {'normalizedLemma': lemma, 'book': book, 'sourceWordId': source['wordId'],
                    'sourceFocusSenseId': primary['id'], 'sourceFocusTextSha256': sha(primary['definitionZh']),
                    'focusSenseId': primary['id'], 'senses': patches, 'qualityWarnings': warnings}
        focus = row.get('curatedFocus')
        if primary['id'] in excluded and not focus:
            raise ValueError('excluded_primary_requires_curated_focus')
        if focus:
            if primary['id'] not in excluded:
                raise ValueError('curated_focus_requires_source_quality_warning')
            en, zh, reason = text(focus['definitionEn'], 'focus_en'), text(focus['definitionZh'], 'focus_zh'), text(focus['reason'], 'focus_reason')
            focus_id = 'phrase-focus-' + sha(lemma + '\0' + zh + '\0' + en)
            compiled['focusSenseId'] = focus_id
            compiled['curatedFocus'] = {'id': focus_id, 'pos': primary.get('pos') or display_pos(lemma), 'definitionZh': zh, 'definitionEn': en, 'ordinal': -1,
                                       'contentMetadata': {'definitionZh': author_metadata('zh', primary, reason), 'definitionEn': author_metadata('en', primary, reason)}}
        example = corpus_example(lemma, evidence[lemma]) if lemma in evidence else original_example(text(row.get('exampleEn'), 'example_en'), text(row.get('exampleZh'), 'example_zh'))
        if not exact_phrase(lemma, example['exampleEn']):
            raise ValueError('example_missing_exact_phrase:' + lemma)
        if not 3 <= len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", example['exampleEn'])) <= 35:
            raise ValueError('example_word_count_out_of_bounds')
        compiled['examples'] = [example]
        compiled['collocationTokens'] = list(dict.fromkeys(t for t in lemma.split(' ') if t not in STOPWORDS))[:4]
        result.append(compiled)
        review.append({'normalizedLemma': lemma, 'book': book, 'review': 'pending', 'sourceSenseIds': sorted(chinese),
                       'translatedSourceSenseCount': len(patches), 'qualityExcludedSourceSenseIds': sorted(excluded),
                       'curatedFocus': bool(focus), 'exampleKind': example['contentMetadata']['exampleEn']['kind'],
                       'tasks': ['Check paired gloss meaning and terminology', 'Check the contextual bilingual example', 'Review source-quality warnings and authored focus where present']})
    if dict(books) != expected_counts:
        raise ValueError('phrase_book_count_mismatch')
    return result, review


def deterministic_gzip(data):
    stream = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0, compresslevel=9) as output:
        output.write(data)
    return stream.getvalue()


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['input', 'lexical', 'selection', 'source-manifest', 'output', 'manifest', 'review-queue']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--tatoeba-evidence', help='JSON array of verified two-endpoint phrase evidence')
    args = parser.parse_args()
    lexical = read_jsonl(args.lexical)
    authored = read_jsonl(args.input)
    selection = json.loads(Path(args.selection).read_text(encoding='utf-8'))
    evidence = {x['phrase']: x for x in json.loads(Path(args.tatoeba_evidence).read_text(encoding='utf-8'))} if args.tatoeba_evidence else {}
    rows, queue = compile_rows(authored, lexical, selection, evidence)
    decoded = ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n' for row in rows).encode('utf-8')
    compressed = deterministic_gzip(decoded)
    source_manifest = json.loads(Path(args.source_manifest).read_text(encoding='utf-8'))
    stats = {'wordCount': len(rows), 'sourceChineseSenseCount': sum(len(r['senses']) + len({w['senseId'] for w in r['qualityWarnings'] if w['excludeFromLearning']}) for r in rows),
             'translatedSourceSenseCount': sum(len(r['senses']) for r in rows), 'qualityExcludedSourceSenseCount': sum(len({w['senseId'] for w in r['qualityWarnings'] if w['excludeFromLearning']}) for r in rows),
             'curatedFocusSenseCount': sum('curatedFocus' in r for r in rows), 'bilingualLearningFocusCount': len(rows), 'bilingualExampleWordCount': len(rows),
             'tatoebaDirectExampleCount': sum(r['examples'][0]['contentMetadata']['exampleEn']['kind'] == 'corpus' for r in rows),
             'assistedOriginalExampleCount': sum(r['examples'][0]['contentMetadata']['exampleEn']['kind'] == 'generated' for r in rows),
             'pendingReviewWordCount': len(queue)}
    manifest = {'formatVersion': 1, 'id': PACK_ID, 'version': VERSION, 'fileName': Path(args.output).name,
                'bytes': len(compressed), 'sha256': sha(compressed), 'jsonlSha256': sha(decoded),
                'sourceUrl': 'https://raw.githubusercontent.com/wudi000888-svg/nightstudy/main/data/' + Path(args.output).name,
                'license': 'MIT AND CC-BY-2.0-FR', 'wordCount': len(rows), 'kind': 'phrase-books',
                'tagCounts': {'phrase-books': len(rows), **BOOK_COUNTS},
                'bookCounts': BOOK_COUNTS, 'scope': 'Independently compiled basic and advanced common phrases; not an official complete CET4/CET6 syllabus.',
                'sourceManifestSha256': sha(Path(args.source_manifest).read_bytes()), 'lexicalSourceSha256': sha(Path(args.lexical).read_bytes()),
                'authoredSourceSha256': sha(Path(args.input).read_bytes()), 'selectionSha256': sha(Path(args.selection).read_bytes()),
                'statistics': stats, 'sources': source_manifest, 'review': 'pending; no claim of expert certification'}
    for file, value in [(args.output, compressed), (args.manifest, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()),
                        (args.review_queue, (json.dumps({'id': PACK_ID, 'status': 'pending', 'items': queue}, ensure_ascii=False, indent=2) + '\n').encode())]:
        path = Path(file); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(value)
    print(json.dumps({'action': 'phrase.compile', 'manifest': args.manifest, **stats, 'sha256': manifest['sha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
