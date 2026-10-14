#!/usr/bin/env python3
"""Offline lexical translation. No API keys, network inference, or database access.

Input is a lexical-only export plus attributed English/Chinese usage candidates.
Models must be downloaded and converted separately to local CTranslate2 paths.
JSONL checkpoints are resumable and all generated fields remain pending review.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

def translation_metadata(text, direction, model):
    return {
        'kind': 'machine-translation', 'review': 'pending',
        'model': 'Helsinki-NLP/opus-mt-'+direction,
        'modelRevision': model['revision'], 'modelLicense': model['license'],
        'modelAuthor': model['author'],
        'sourceLanguage': direction.split('-')[0], 'sourceTextSha256': digest(text),
        'sourceUrl': 'https://huggingface.co/Helsinki-NLP/opus-mt-'+direction+'/tree/'+model['revision'],
    }

def valid_translation(value, target):
    if not value or len(value) > 4000 or '\ufffd' in value:
        return False
    if target == 'zh' and not re.search(r'[\u3400-\u9fff]', value):
        return False
    if target == 'en' and (not re.search(r'[A-Za-z]', value) or re.search(r'[\u3400-\u9fff]', value)):
        return False
    # A repeated decoder loop is a failure, never silently published as a definition.
    if re.search(r'(.{4,60})\1\1', value):
        return False
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--candidates', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--models', required=True, help='local model manifest with pinned revisions and CT2/tokenizer paths')
    parser.add_argument('--batch-size', type=int, default=32)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 128:
        parser.error('batch-size must be 1..128')
    import ctranslate2
    from transformers import AutoTokenizer
    models = json.loads(Path(args.models).read_text())
    words = [json.loads(line) for line in Path(args.input).read_text().splitlines() if line.strip()]
    candidates = {row['normalizedLemma']: row.get('examples', []) for row in map(json.loads, Path(args.candidates).read_text().splitlines())}
    # Checkpoint key includes direction/source/model revision so stale translations never reuse.
    cache_path = Path(args.output+'.translations.jsonl')
    cache = {}
    if cache_path.exists():
        for line in cache_path.read_text().splitlines():
            entry = json.loads(line)
            cache[entry['key']] = entry['value']
    failures = []
    for direction in ['zh-en', 'en-zh']:
        model = models[direction]
        source_language, target_language = direction.split('-')
        work = {}
        for word in words:
            for sense in word['senses']:
                for family in ['definition', 'example']:
                    source_field = family+source_language.title()
                    target_field = family+target_language.title()
                    text = sense.get(source_field, '').strip()
                    if text and not sense.get(target_field, '').strip():
                        key = digest(direction+'\0'+model['revision']+'\0'+text)
                        if key not in cache:
                            work[key] = text
            if direction == 'en-zh':
                for example in candidates.get(word['normalizedLemma'], []):
                    if example.get('exampleEn') and not example.get('exampleZh'):
                        text = example['exampleEn']
                        key = digest(direction+'\0'+model['revision']+'\0'+text)
                        if key not in cache:
                            work[key] = text
        if work:
            tokenizer = AutoTokenizer.from_pretrained(model['tokenizer'], local_files_only=True)
            translator = ctranslate2.Translator(model['ct2'], device='cpu', compute_type='int8', intra_threads=4, inter_threads=1)
            pending = list(work.items())
            with cache_path.open('a') as checkpoint:
                for start in range(0, len(pending), args.batch_size):
                    batch = pending[start:start+args.batch_size]
                    prefix = model.get('sourcePrefix', '')
                    tokens = [tokenizer.convert_ids_to_tokens(tokenizer.encode(prefix+text)) for _,text in batch]
                    accepted = []
                    for item,sequence in zip(batch,tokens):
                        if len(sequence)>512:
                            key,text=item
                            cache[key]=''
                            checkpoint.write(json.dumps({'key':key,'value':''})+'\n')
                            failures.append({'source':text,'direction':direction,'reason':'source_exceeds_model_context'})
                        else:
                            accepted.append((item,sequence))
                    results = translator.translate_batch([sequence for _,sequence in accepted], beam_size=2, max_decoding_length=256, repetition_penalty=1.1) if accepted else []
                    for ((key,text),_), result in zip(accepted, results):
                        translated = tokenizer.decode(tokenizer.convert_tokens_to_ids(result.hypotheses[0]), skip_special_tokens=True).strip()
                        cache[key] = translated if len(result.hypotheses[0])<256 and valid_translation(translated,target_language) else ''
                        checkpoint.write(json.dumps({'key':key,'value':cache[key]},ensure_ascii=False)+'\n')
                        if not cache[key]:
                            failures.append({'source':text,'direction':direction,'reason':'translation_quality_check_failed'})
                    checkpoint.flush()
                    print(json.dumps({'action':'bilingual.translate','direction':direction,'done':min(start+args.batch_size,len(pending)),'total':len(pending)}),flush=True)
            del translator, tokenizer
    output = []
    for word in words:
        senses = []
        for sense in word['senses']:
            patch = {'id':sense['id'],'contentMetadata':{}}
            for family in ['definition','example']:
                for direction in ['zh-en','en-zh']:
                    source_language,target_language = direction.split('-')
                    source_field,target_field = family+source_language.title(),family+target_language.title()
                    text = sense.get(source_field,'').strip()
                    if text and not sense.get(target_field,'').strip():
                        translated = cache.get(digest(direction+'\0'+models[direction]['revision']+'\0'+text),'')
                        if translated:
                            patch[target_field] = translated
                            patch['contentMetadata'][target_field] = translation_metadata(text,direction,models[direction])
            if patch['contentMetadata']:
                senses.append(patch)
        examples = []
        for original in candidates.get(word['normalizedLemma'],[]):
            example = dict(original)
            metadata = dict(example.get('contentMetadata',{}))
            if not example.get('exampleZh') and example.get('exampleEn'):
                text = example['exampleEn']
                translated = cache.get(digest('en-zh\0'+models['en-zh']['revision']+'\0'+text),'')
                if translated:
                    example['exampleZh'] = translated
                    source = dict(metadata.get('exampleEn',{}))
                    translated_source = translation_metadata(text,'en-zh',models['en-zh'])
                    translated_source['modelUrl'] = translated_source['sourceUrl']
                    for field in ['sourceUrl','license','licenseUrl','author','sourceSentenceId','sourceName','snapshot']:
                        if source.get(field):
                            translated_source[field] = source[field]
                    translated_source['adaptation'] = 'Machine translation into Simplified Chinese; original English sentence retained.'
                    translated_source['senseAlignment'] = 'word-level-unverified'
                    metadata['exampleZh'] = translated_source
            example['contentMetadata'] = metadata
            if example.get('exampleEn') and example.get('exampleZh'):
                examples.append(example)
        output.append({'normalizedLemma':word['normalizedLemma'],'senses':senses,'examples':examples})
    Path(args.output).write_text(''.join(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n' for row in output))
    Path(args.output+'.failures.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'action':'bilingual.complete','words':len(output),'translatedSenses':sum(len(x['senses']) for x in output),'exampleWords':sum(bool(x['examples']) for x in output),'failedTranslations':len(failures)}))

if __name__ == '__main__':
    main()
