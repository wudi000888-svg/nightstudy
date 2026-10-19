#!/usr/bin/env python3
"""Map explicit cloud staging pins; this is not a publication verifier.

Import prepare_converter_inputs() or global_batch_frame() from an orchestrator.
The CLI reads only its bounded specification and, for frame mode, the pinned
small converter receipt. It never opens archives, selects a directory's latest
file, downloads, decodes, imports a model, or changes an existing artifact.
All entity pins are relative to the explicit real evidence root (cloud REPO).
Generation manifest/source pins remain the original C-declared basenames.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import stat

CONVERTER_SHA='4d2cac9b8ff5bf6d07fed7b033ebb02834e4d8b5eaa30ed31319c101651e6715'
PIN_FIELDS={'fileName','bytes','sha256'}
BATCH_FIELDS={'sliceNumber','packId','request','check','generation','candidate'}
CANDIDATE_FIELDS={'descriptor','archive','manifest','sources','assembly','installerCheck'}
OUTPUT_FIELDS={'descriptor','archive','manifest','sources','choice','installerCheck'}


def need(ok,reason):
    if not ok:raise ValueError(reason)


def pin(value):
    need(isinstance(value,dict) and set(value)==PIN_FIELDS,'stage_exact_pin')
    name=value['fileName']
    need(isinstance(name,str) and re.fullmatch('[A-Za-z0-9._/-]+',name)
        and not name.startswith('/') and all(part not in ('','.','..') for part in name.split('/')),
        'stage_relative_pin_name')
    need(type(value['bytes']) is int and 0<value['bytes']<2*1024**3
        and isinstance(value['sha256'],str) and re.fullmatch('[a-f0-9]{64}',value['sha256']),
        'stage_pin_bounds')
    return dict(value)


def group(value,names):
    need(isinstance(value,dict) and set(value)==set(names),'stage_exact_pin_group')
    return {name:pin(value[name]) for name in names}


def batch_copy(value):
    need(isinstance(value,dict) and set(value)==BATCH_FIELDS,'stage_exact_original_batch')
    number=value['sliceNumber']
    need(type(number) is int and 1<=number<=101 and value['packId']==f'sentence-audio-v4-{100+number:04d}',
        'stage_fixed_slice_pack_binding')
    return dict(sliceNumber=number,packId=value['packId'],request=pin(value['request']),check=pin(value['check']),
        generation=group(value['generation'],('build','manifest','sources')),
        candidate=group(value['candidate'],('descriptor','archive','manifest','sources','assembly','installerCheck')))


def converter_candidate(batch):
    original=batch['candidate']
    return dict(descriptor=dict(original['descriptor']),archive=dict(original['archive']),
        manifest=dict(original['manifest']),sources=dict(original['sources']),
        freshInstallerCheck=dict(original['installerCheck']))


def prepare_converter_inputs(batch,qualification_pin,selection_pin):
    """Only rename the original fresh installer key; do not infer any pin."""
    checked=batch_copy(batch)
    return dict(kind='nightstudy-ci-audio-publication-inputs-v1',request=checked['request'],
        independentCheck=checked['check'],candidate=converter_candidate(checked),
        legacyQualification=pin(qualification_pin),legacySelection=pin(selection_pin))


def same_content(actual,declared):
    """Allow an explicit staging prefix, retaining the declared basename and bytes."""
    actual=pin(actual);declared=pin(declared)
    need(Path(actual['fileName']).name==Path(declared['fileName']).name
        and actual['bytes']==declared['bytes'] and actual['sha256']==declared['sha256'],
        'stage_output_must_match_actual_converter_pin')


def global_batch_frame(batch,conversion,conversion_pin,selected_outputs=None):
    """Return C's exact batch frame; independent global validation is still required."""
    checked=batch_copy(batch);conversion_pin=pin(conversion_pin)
    need(isinstance(conversion,dict) and conversion.get('kind')=='nightstudy-ci-sentence-publication-conversion-v1'
        and conversion.get('packId')==checked['packId'] and conversion.get('generationProofUnchanged') is True
        and conversion.get('publicationAuthorized') is False,'stage_actual_converter_receipt')
    candidate=checked['candidate']
    if conversion.get('mode')=='original-generation':
        need(conversion.get('state')=='UNCHANGED_ORIGINAL_GENERATION' and selected_outputs is None
            and conversion.get('selectedPublication')==converter_candidate(checked),'stage_original_candidate_remains_exact')
        publication=dict(mode='original-generation',selectionProof=None,
            descriptor=candidate['descriptor'],archive=candidate['archive'],manifest=candidate['manifest'],
            sources=candidate['sources'],assembly=candidate['assembly'],installerCheck=candidate['installerCheck'])
    else:
        need(conversion.get('mode')=='legacy-reuse-conversion'
            and conversion.get('state')=='CONVERTED_REQUIRES_SELECTED_INSTALLER_CHECK'
            and conversion.get('converterSourceSha256')==CONVERTER_SHA
            and conversion.get('originalCandidate')==converter_candidate(checked)
            and conversion.get('originalArchivesModified') is False and conversion.get('modelUsed') is False
            and conversion.get('mediaDecodedHere') is False,'stage_converted_original_evidence_preserved')
        selected=group(selected_outputs,('descriptor','archive','manifest','sources','choice','installerCheck'))
        declared=group(conversion['selectedPublication'],('descriptor','archive','manifest','sources'))
        for name in declared:same_content(selected[name],declared[name])
        same_content(selected['choice'],conversion['choiceProof'])
        publication=dict(mode='legacy-reuse-conversion',selectionProof=selected['choice'],descriptor=selected['descriptor'],
            archive=selected['archive'],manifest=selected['manifest'],sources=selected['sources'],
            assembly=conversion_pin,installerCheck=selected['installerCheck'],candidate=candidate)
    return dict(sliceNumber=checked['sliceNumber'],packId=checked['packId'],request=checked['request'],check=checked['check'],
        generation=checked['generation'],publication=publication)


def read_json(file,cap,expected=None):
    file=Path(file).absolute();need(file.resolve(strict=True)==file,'stage_real_input_path')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    signature=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and 0<before.st_size<=cap,'stage_small_input_bounds')
        if expected:need(before.st_size==expected['bytes'],'stage_actual_receipt_size')
        chunks=[];remaining=before.st_size
        while remaining:
            part=os.read(fd,min(remaining,65536));need(part,'stage_input_truncated');chunks.append(part);remaining-=len(part)
        need(not os.read(fd,1),'stage_input_grew');raw=b''.join(chunks)
        if expected:need(hashlib.sha256(raw).hexdigest()==expected['sha256'],'stage_actual_receipt_sha')
        need(signature(before)==signature(os.fstat(fd))==signature(os.lstat(file)),'stage_input_identity_changed')
        result=json.loads(raw)
        return result,(file,signature(before))
    finally:os.close(fd)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--inputs',required=True,type=Path);p.add_argument('--evidence-root',required=True,type=Path)
    p.add_argument('--output',required=True,type=Path);args=p.parse_args()
    root=args.evidence_root.absolute();need(root.resolve(strict=True)==root and root.is_dir(),'stage_real_evidence_root')
    spec,source=read_json(args.inputs,1024*1024)
    need(isinstance(spec,dict) and spec.get('kind')=='nightstudy-ci-audio-publication-stage-input-v1','stage_spec_kind')
    identities=[source]
    if spec.get('phase')=='prepare':
        need(set(spec)=={'kind','phase','batch','legacyQualification','legacySelection'},'stage_exact_prepare_spec')
        result=prepare_converter_inputs(spec['batch'],spec['legacyQualification'],spec['legacySelection'])
    else:
        need(spec.get('phase')=='frame' and set(spec)=={'kind','phase','batch','conversionReceipt','selectedOutputs'},
            'stage_exact_frame_spec')
        receipt_pin=pin(spec['conversionReceipt'])
        receipt,identity=read_json(root/receipt_pin['fileName'],128*1024,receipt_pin);identities.append(identity)
        result=global_batch_frame(spec['batch'],receipt,receipt_pin,spec['selectedOutputs'])
    signature=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    for file,before in identities:need(signature(os.lstat(file))==before,'stage_final_input_identity_changed')
    output=args.output.absolute();need(not os.path.lexists(output) and output.parent.resolve(strict=True)==output.parent,'stage_fresh_output')
    raw=(json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode('utf-8')
    need(len(raw)<=128*1024,'stage_small_output_bounds')
    with output.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())


if __name__=='__main__':main()
