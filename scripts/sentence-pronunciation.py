"""Exact reviewed offline pronunciation corrections; never change displayed text.

No word-to-sound guessing, downloads or runtime synthesis. Corrections name the
exact text, accent and meaning/example reference and retain the original Piper
phonemes. A worker checks those phonemes against the actual pinned voice first.
"""
from __future__ import annotations
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import unicodedata
import wave

MAX_BYTES = 4 * 1024 * 1024
MULTI_SENTENCE_RENDER_POLICY = 'piper-raw-per-sentence-wav-v1'

def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))

def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value,str) else value).hexdigest()

def normalize(value):
    return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',value).translate(str.maketrans({'‘':"'",'’':"'",'“':'"','”':'"'}))).strip()

def require(ok,reason):
    if not ok:raise ValueError(reason)

def validate_review(row):
    require(isinstance(row,dict) and set(row)=={'id','text','textHash','accent','learningSenseId','exampleId','originalPhonemes','replacements','review'},'pronunciation_review_fields')
    require(isinstance(row['text'],str) and 15<=len(row['text'])<=4000 and normalize(row['text'])==row['text'] and sha(row['text'])==row['textHash'],'pronunciation_review_text')
    require(row['accent'] in ('US','UK') and row['id']=='sentence-pronunciation-'+sha(row['textHash']+'\0'+row['accent']),'pronunciation_review_identity')
    require(isinstance(row['exampleId'],str) and re.fullmatch(r'sense-example-[a-f0-9]{64}',row['exampleId']) and isinstance(row['learningSenseId'],str) and re.fullmatch('learning-sense-[a-f0-9]{64}',row['learningSenseId']),'pronunciation_review_reference')
    review=row['review'];require(isinstance(review,dict) and set(review)=={'reviewer','decision','expertCertified','reason'} and review['reviewer']=='Codex' and review['decision']=='publish' and review['expertCertified'] is False and isinstance(review['reason'],str) and 15<=len(review['reason'])<=4000,'pronunciation_review_decision')
    old=row['originalPhonemes'];require(isinstance(old,list) and 1<=len(old)<=10 and all(isinstance(x,str) and 1<=len(x)<=8000 and '[' not in x and ']' not in x for x in old),'pronunciation_review_original')
    replacements=row['replacements'];require(isinstance(replacements,list) and 1<=len(replacements)<=10,'pronunciation_review_replacements')
    occupied=set();new=old[:]
    for item in sorted(replacements,key=lambda r:(r.get('sentence',-1),r.get('start',-1)),reverse=True):
        require(isinstance(item,dict) and set(item)=={'sentence','start','from','to'},'pronunciation_review_replacement_fields')
        sent,start=item['sentence'],item['start'];before,after=item['from'],item['to']
        require(type(sent) is int and type(start) is int and 0<=sent<len(old) and start>=0 and isinstance(before,str) and 0<len(before)<=200 and start+len(before)<=len(old[sent]) and isinstance(after,str) and after and before!=after and '[' not in after and ']' not in after and len(after)<=200 and not re.search(r'[\x00-\x1f]',after),'pronunciation_review_replacement')
        span={(sent,i) for i in range(start,start+len(before))};require(not occupied.intersection(span),'pronunciation_review_overlap');occupied.update(span)
        require(old[sent][start:start+len(before)]==before,'pronunciation_review_original_span')
        new[sent]=new[sent][:start]+after+new[sent][start+len(before):]
    return {'record':row,'sha256':sha(canonical(row)),'correctedPhonemes':new}

def load_reviews(file,expected_sha,rows,voices_manifest):
    require(bool(file)==bool(expected_sha),'pronunciation_reviews_pin_required')
    if file is None:return {},None
    file=Path(file);require(not file.is_symlink() and file.is_file() and 0<file.stat().st_size<=MAX_BYTES,'pronunciation_reviews_file')
    raw=file.read_bytes();require(sha(raw)==expected_sha,'pronunciation_reviews_checksum')
    value=json.loads(raw);require(isinstance(value,dict) and set(value)=={'formatVersion','id','engineVersion','voicesManifestSha256','entries'} and value['formatVersion']==1 and value['id']=='sentence-pronunciation-v1' and value['engineVersion']=='1.8.0' and value['voicesManifestSha256']==sha(Path(voices_manifest).read_bytes()) and isinstance(value['entries'],list) and 1<=len(value['entries'])<=10000,'pronunciation_reviews_manifest')
    requested={row['textHash']:row for row in rows};result={};identities=set()
    for entry in value['entries']:
        checked=validate_review(entry);key=(entry['textHash'],entry['accent']);require(key not in identities,'pronunciation_reviews_duplicate');identities.add(key)
        row=requested.get(entry['textHash'])
        if row is None:continue
        require(entry['text']==row['text'] and any(ref['learningSenseId']==entry['learningSenseId'] and ref['exampleId']==entry['exampleId'] for ref in row['references']),'pronunciation_reviews_meaning_mismatch')
        result[key]=checked
    return result,{'fileName':file.name,'bytes':len(raw),'sha256':sha(raw),'appliedClipCount':len(result),'engineVersion':value['engineVersion'],'expertCertified':False}

def attach_reviews(rows,reviews):
    output=copy.deepcopy(rows)
    for row in output:
        selected={accent:reviews[(row['textHash'],accent)] for accent in ('US','UK') if (row['textHash'],accent) in reviews}
        if selected:row['pronunciationCorrections']=selected
    return output

def corrected_cache_identity(identity,correction):
    if not correction:return identity
    require(correction==validate_review(correction['record']),'pronunciation_correction_drift')
    value={'baseSynthesisIdentity':identity,'pronunciationCorrectionSha256':correction['sha256']}
    if len(correction['correctedPhonemes'])>1:
        value['renderPolicy']=MULTI_SENTENCE_RENDER_POLICY
    return sha(canonical(value))

def corrected_voice(voice,text,correction):
    """Only the explicit, checked phoneme spans can change; upstream config stays fixed."""
    if not correction:return voice
    require(correction==validate_review(correction['record']),'pronunciation_correction_drift')
    row=correction['record'];require(text==row['text'],'pronunciation_voice_text_mismatch')
    actual=[''.join(sentence) for sentence in voice.phonemize(text)]
    require(actual==row['originalPhonemes'],'pronunciation_actual_phonemes_changed')
    inventory=voice.config.phoneme_id_map
    for sentence in correction['correctedPhonemes']:
        require(all(token in inventory for token in sentence),'pronunciation_unsupported_phoneme')
    class CorrectedVoice:
        def synthesize_wav(self,displayed_text,wav_file):
            require(displayed_text==text,'pronunciation_voice_text_mismatch')
            sentences=correction['correctedPhonemes']
            if len(sentences)==1:
                # Keep the published single-sentence call, bytes and identity.
                return voice.synthesize_wav('[['+sentences[0]+']]',wav_file)
            # Piper's public raw-block parser merges adjacent [[...]] blocks
            # into one sentence. Render each sentence through its public WAV
            # API, then concatenate PCM only after every format is verified.
            chunks=[];expected=None
            for sentence in sentences:
                buffer=io.BytesIO()
                with wave.open(buffer,'wb') as sentence_wav:
                    voice.synthesize_wav('[['+sentence+']]',sentence_wav)
                buffer.seek(0)
                with wave.open(buffer,'rb') as sentence_wav:
                    actual_format=(sentence_wav.getnchannels(),sentence_wav.getsampwidth(),sentence_wav.getframerate(),sentence_wav.getcomptype())
                    require(actual_format[0]>0 and actual_format[1]>0 and actual_format[2]>0 and actual_format[3]=='NONE','pronunciation_invalid_wav_format')
                    if expected is None:expected=actual_format
                    require(actual_format==expected,'pronunciation_sentence_wav_format_mismatch')
                    frames=sentence_wav.getnframes()
                    pcm=sentence_wav.readframes(frames)
                    require(frames>0 and len(pcm)==frames*actual_format[0]*actual_format[1],'pronunciation_invalid_wav_frames')
                    chunks.append(pcm)
            wav_file.setnchannels(expected[0]);wav_file.setsampwidth(expected[1]);wav_file.setframerate(expected[2])
            for pcm in chunks:wav_file.writeframes(pcm)
            return None
    return CorrectedVoice()
