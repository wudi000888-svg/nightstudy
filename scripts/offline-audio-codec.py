"""Developer-only MP3 encoding of already validated locally synthesized WAVs."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

QUALITY_POLICY = {'version': 1, 'decodedSampleRate': 22050, 'channels': 1,
                  'durationSecondsMin': .05, 'durationSecondsMax': 30,
                  'peakAmplitudeMin': 10, 'rmsAmplitudeMin': 1,
                  'clippedSampleFractionMax': .01,
                  'timeStretchApplied': False, 'silenceTrimApplied': False}


def build_tool_identity():
    executable = os.environ.get('NIGHTSTUDY_BUILD_FFMPEG')
    if not executable or not Path(executable).is_file():
        raise ValueError('offline_ffmpeg_path_required')
    filename = Path(executable)
    with filename.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    version = subprocess.run([executable, '-version'], check=True, timeout=10,
                             capture_output=True, text=True).stdout.splitlines()[0]
    return {'name': 'FFmpeg with libmp3lame', 'executableSha256': digest,
            'executableSizeBytes': filename.stat().st_size, 'version': version,
            'runtimeDependency': False}


def pcm_metrics(decoded):
    import numpy as np
    samples = np.frombuffer(decoded, dtype='<i2')
    if samples.size < 100:
        raise ValueError('decoded_audio_empty')
    magnitude=np.abs(samples.astype(np.int32))
    peak=int(np.max(magnitude));duration=samples.size/22050
    rms=float(np.sqrt(np.mean(samples.astype(np.float32)**2)))
    if not .05<=duration<=30 or peak<10 or not np.isfinite(rms) or rms<1:
        raise ValueError('decoded_audio_silent_or_duration_invalid')
    clipping=float(np.count_nonzero(magnitude>=32760)/samples.size)
    if clipping>.01:raise ValueError('decoded_audio_excessive_clipping')
    audible=np.flatnonzero(magnitude>max(20,peak*.003))
    if not audible.size:raise ValueError('decoded_audio_silent')
    return {'policyVersion':QUALITY_POLICY['version'],'sampleRate':22050,'channels':1,'decodedDurationSeconds':round(duration,6),'peakAmplitude':peak,'rmsDbfs':round(20*float(np.log10(rms/32768)),3),'clippedSampleFraction':round(clipping,8),'leadingSilenceSeconds':round(int(audible[0])/22050,6),'trailingSilenceSeconds':round((samples.size-int(audible[-1])-1)/22050,6),'timeStretchApplied':False,'silenceTrimApplied':False}


def inspect_media(entry, root):
    executable=os.environ.get('NIGHTSTUDY_BUILD_FFMPEG')
    if not executable or not Path(executable).is_file():raise ValueError('offline_ffmpeg_path_required')
    raw=subprocess.run([executable,'-nostdin','-v','error','-i',str(root/entry['fileKey']),'-t','31','-f','s16le','-ac','1','-ar','22050','-'],check=True,timeout=60,capture_output=True).stdout
    return pcm_metrics(raw)


def output_attribution(entry, converted):
    attribution = entry['attribution']
    if converted and entry['kind'] == 'recorded':
        attribution = attribution.replace('original unmodified recording.',
                                          'original human recording; converted to MP3 without speech synthesis.')
        if 'converted to MP3' not in attribution:
            attribution += '; converted to MP3 without speech synthesis.'
    return attribution


def encode_mp3(entry, output, source_root=None):
    if entry.get("mimeType") == "audio/mpeg":
        return entry
    executable = os.environ.get("NIGHTSTUDY_BUILD_FFMPEG")
    if not executable or not Path(executable).is_file():
        raise ValueError("offline_ffmpeg_path_required")
    source = (source_root or output) / entry["fileKey"]
    original_entry = entry
    if not entry.get('durationSeconds'):
        decoded_source = subprocess.run([executable, '-nostdin', '-v', 'error', '-i', str(source), '-t', '31', '-f', 's16le', '-ac', '1', '-ar', '22050', '-'], check=True, timeout=60, capture_output=True).stdout
        import numpy as np
        source_samples = np.frombuffer(decoded_source,dtype='<i2')
        duration=source_samples.size/22050
        if not .05<=duration<=30 or np.max(np.abs(source_samples.astype(np.int32)))<10:
            raise ValueError('source_recording_silent_or_duration_invalid')
        entry={**entry,'durationSeconds':round(duration,6)}
    with tempfile.NamedTemporaryFile(dir=output, suffix=".mp3", delete=False) as temporary:
        target = Path(temporary.name)
    try:
        subprocess.run([executable, "-nostdin", "-v", "error", "-y", "-i", str(source), "-ac", "1", "-ar", "22050", "-codec:a", "libmp3lame", "-b:a", "48k", "-threads", "1", str(target)], check=True, timeout=60, capture_output=True)
        raw = target.read_bytes()
        if len(raw) < 128 or len(raw) > 2 * 1024 * 1024 or not (raw[:3] == b"ID3" or (raw[0] == 255 and raw[1] & 224 == 224)):
            raise ValueError("encoded_mp3_invalid")
        # Decode the actual artifact to check that encoding didn't create empty
        # or corrupt speech; validated WAV duration is retained in provenance.
        decoded = subprocess.run([executable, "-nostdin", "-v", "error", "-i", str(target), '-t', '31', "-f", "s16le", "-ac", "1", "-ar", "22050", "-"], check=True, timeout=60, capture_output=True).stdout
        import numpy as np
        samples = np.frombuffer(decoded, dtype="<i2")
        if samples.size < 100 or np.max(np.abs(samples.astype(np.int32))) < 10:
            raise ValueError("encoded_mp3_silent")
        duration = samples.size / 22050
        if abs(duration - entry["durationSeconds"]) > .2:
            raise ValueError("encoded_mp3_duration_mismatch")
        sha = hashlib.sha256(raw).hexdigest()
        key = f"files/{sha}.mp3"
        (output / key).write_bytes(raw)
        provenance = {'originalFileSha256':original_entry['fileSha256'],'originalMimeType':original_entry['mimeType']}
        attribution=output_attribution(entry, True)
        return {**entry, **provenance, 'attribution':attribution, "fileKey": key, "fileSha256": sha, "mimeType": "audio/mpeg", "sizeBytes": len(raw), "encoding": "MP3 48kbps mono 22050Hz; decoded and duration checked", "decodedDurationSeconds": round(duration, 6), 'qualityMetrics':pcm_metrics(decoded)}
    finally:
        target.unlink(missing_ok=True)
