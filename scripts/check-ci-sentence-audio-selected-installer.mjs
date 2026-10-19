/** Only converted publication packs: original generated C evidence is never rewritten. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  checkInstallerReviews,
  checkInstallerFileSet,
} from './check-ci-sentence-audio-installer.mjs';
import { verifyPinnedSentenceEntries } from './check-audio-install.mjs';
import {
  parseSentenceAudioHoldPolicy,
  verifySentenceAudioPackHolds,
  sentenceAudioIdentity,
  normalizeSentenceAudioText,
} from './check-sentence-audio-policy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)),
  MIB = 1024 * 1024;
const PUBLIC = '0ae4679da6df6459cb2cfe21867942bb8eaa4ae9828def149f08816c42f4ef1b';
const FINAL = 'eaaf987f693cfad6a6a3cb5768b8ef855a1f0300d4c06257bf8683ecf86f69dd';
const VOICES = '3dafe3867fc2005ce1cf0be24485e771671121f4cca185521b17b8d381e7489f';
const BASE = '3b7f791260a3d7490f89304c58afab7bc062a092271f67c2aa4a9b4c4cd367c7';
const HOLDS = '138e3923cccc0a2b77f4dc0d2da38e9d24c5fd336e26a4b83bfa274c679129e3';
const HOLD_MANIFEST = 'f61bdf164dbeb594c8ee45d91e3996a97e2aee8537ef297ddafd0f3b6344e956';
const FRESH_CHECKER = '53112b8094452a3a4db53fb6920b1fc70fbffdbe141bd996af454d470b5652f1';
const C_CHECKER = '16fbaf7f522a0f26382a923df7670b623fa49df4f82a8b6b225f1e2af71913d8';
const QUALIFIER = '2cd9ac702dff5c3023909e80452098ef395cde3d0286085641d0aa37b0eb75d3';
const REPORT = '48425b09c5837edd2c9be3bf19fa438570adf830cd3c1302e9807db54356ef5c';
const HELPERS = {
  'check-ci-sentence-audio-installer.mjs': FRESH_CHECKER,
  'check-audio-install.mjs': '632099b70041c27201c88abf6a14bd77d8723fcfdb471b92b9af1f43da6f8fec',
  'check-sentence-audio-policy.mjs':
    'f095bce8ed7c5bb7687e1b85576de559f1713b1ec7435b022ea55e1832c53165',
  'audio-extract.py': 'ccfe7e54a54882d15429d10e1aa21d00713f5e53a703a35858628701c24098fa',
};
const need = (ok, reason) => {
  if (!ok) throw new Error(reason);
};
const same = (a, b, reason) => need(isDeepStrictEqual(a, b), reason);
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
const asciiCanonical = (v) =>
  canonical(v).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
const key = (e) => sentenceAudioIdentity(e.textHash, e.accent);
const order = (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const sorted = (rows) => [...rows].sort(order);
const fields = (value, names) =>
  value && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
const ENTRY_HASH_RECIPE = 'typed-json-ieee754be-v1';

/** Preserve every JSON value without Python 0.0 / JavaScript 0 spelling differences. */
export function publicationEntrySha256(value) {
  const unicode = (s) => {
    for (const c of s) {
      const n = c.codePointAt(0);
      need(n < 0xd800 || n > 0xdfff, 'selected_entry_valid_unicode');
    }
    return s;
  };
  const compare = (a, b) => {
    const aa = Array.from(a, (c) => c.codePointAt(0)),
      bb = Array.from(b, (c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(aa.length, bb.length); i++)
      if (aa[i] !== bb[i]) return aa[i] - bb[i];
    return aa.length - bb.length;
  };
  const typed = (v, depth = 0) => {
    need(depth <= 128, 'selected_entry_depth');
    if (v === null) return ['null'];
    if (typeof v === 'boolean') return ['boolean', v];
    if (typeof v === 'string') return ['string', unicode(v)];
    if (typeof v === 'number') {
      need(
        Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER,
        'selected_entry_finite_safe_number',
      );
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(v);
      return ['number', bytes.toString('hex')];
    }
    if (Array.isArray(v)) return ['array', v.map((child) => typed(child, depth + 1))];
    need(
      v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null),
      'selected_entry_json_only',
    );
    const keys = Object.keys(v).map(unicode).sort(compare);
    return ['object', keys.map((k) => [k, typed(v[k], depth + 1)])];
  };
  return sha(canonical(typed(value)));
}

function inputs(root) {
  const seen = new Map(),
    ident = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
  const open = (name, cap, digest, size) => {
    const file = path.resolve(name);
    need(fs.realpathSync(file) === file, 'selected_real_input');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
      before = fs.fstatSync(fd, { bigint: true });
    try {
      need(
        before.isFile() &&
          before.size > 0n &&
          before.size <= BigInt(cap) &&
          (size === undefined || before.size === BigInt(size)),
        'selected_input_bounds',
      );
      return { file, fd, before, digest };
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  };
  const finish = (h, digest) => {
    need(
      ident(h.before) === ident(fs.fstatSync(h.fd, { bigint: true })) &&
        ident(h.before) === ident(fs.lstatSync(h.file, { bigint: true })) &&
        (h.digest === undefined || digest === h.digest),
      'selected_input_sha_or_identity',
    );
    seen.set(h.file, ident(h.before));
  };
  const read = (file, cap, digest, size) => {
    const h = open(file, cap, digest, size);
    try {
      const raw = Buffer.alloc(Number(h.before.size));
      let offset = 0;
      while (offset < raw.length) {
        const n = fs.readSync(h.fd, raw, offset, raw.length - offset, null);
        need(n > 0, 'selected_truncated');
        offset += n;
      }
      need(fs.readSync(h.fd, Buffer.alloc(1), 0, 1, null) === 0, 'selected_input_grew');
      finish(h, sha(raw));
      return raw;
    } finally {
      fs.closeSync(h.fd);
    }
  };
  const file = (pin) => {
    need(
      fields(pin, ['fileName', 'bytes', 'sha256']) &&
        /^[a-f0-9]{64}$/.test(pin.sha256) &&
        Number.isSafeInteger(pin.bytes) &&
        pin.bytes > 0 &&
        typeof pin.fileName === 'string' &&
        /^[A-Za-z0-9._/-]+$/.test(pin.fileName) &&
        !path.isAbsolute(pin.fileName) &&
        !pin.fileName.split('/').some((p) => !p || p === '.' || p === '..'),
      'selected_explicit_relative_pin',
    );
    return path.join(root, pin.fileName);
  };
  const json = (name, cap, digest, size) => JSON.parse(read(name, cap, digest, size));
  return {
    read,
    json,
    file,
    pin: (p, cap) => json(file(p), cap, p.sha256, p.bytes),
    async hash(name, cap, digest, size) {
      const h = open(name, cap, digest, size),
        sum = crypto.createHash('sha256');
      let bytes = 0n;
      try {
        for await (const b of fs.createReadStream(h.file, {
          fd: h.fd,
          autoClose: false,
          highWaterMark: 256 * 1024,
        })) {
          bytes += BigInt(b.length);
          need(bytes <= h.before.size, 'selected_hash_input_grew');
          sum.update(b);
        }
        need(bytes === h.before.size, 'selected_hash_truncated');
        finish(h, sum.digest('hex'));
      } finally {
        fs.closeSync(h.fd);
      }
    },
    unchanged() {
      for (const [f, prior] of seen)
        need(ident(fs.lstatSync(f, { bigint: true })) === prior, 'selected_final_input_changed');
    },
  };
}

/** C always retains its original complete media array and count. */
export function partitionPublication(choice, originalManifest, accepted, qualifiedEntries) {
  need(choice.entryHashRecipe === ENTRY_HASH_RECIPE, 'selected_explicit_whole_entry_hash_recipe');
  const original = new Map(originalManifest.entries.map((e) => [key(e), e]));
  const media = new Map(accepted.media.map((e) => [key(e), e]));
  need(
    original.size === originalManifest.entries.length &&
      media.size === accepted.media.length &&
      original.size === accepted.generatedPairs &&
      original.size === media.size,
    'selected_original_C_count_unchanged',
  );
  for (const [k, entry] of original) {
    const actual = media.get(k);
    need(
      actual &&
        actual.cacheKey === entry.cacheKey &&
        actual.fileSha256 === entry.fileSha256 &&
        actual.originalWavSha256 === entry.originalFileSha256,
      'selected_original_C_entire_media_identity',
    );
  }
  const qualified = new Map(qualifiedEntries.map((e) => [key(e), e]));
  need(qualified.size === qualifiedEntries.length, 'selected_duplicate_official_authority');
  const readRows = (rows, property, authority) => {
    need(
      Array.isArray(rows) && rows.length <= 2000 && isDeepStrictEqual(rows, sorted(rows)),
      'selected_sorted_explicit_partition',
    );
    const result = new Set();
    for (const row of rows) {
      const k = key(row),
        record = authority.get(k);
      need(
        fields(row, ['textHash', 'accent', property]) &&
          !result.has(k) &&
          record &&
          row[property] === publicationEntrySha256(record),
        'selected_partition_whole_record_sha',
      );
      result.add(k);
    }
    return result;
  };
  const fresh = readRows(choice.selectedFreshPairs, 'originalGeneratedEntrySha256', original);
  const removed = readRows(
    choice.generatedNotSelectedPairs,
    'originalGeneratedEntrySha256',
    original,
  );
  const official = new Map([...qualified].map(([k, q]) => [k, q.entry]));
  const reused = readRows(choice.reusedOfficialPairs, 'officialEntrySha256', official);
  need(
    fresh.size > 0 &&
      reused.size >= 1 &&
      reused.size <= 32 &&
      [...fresh].every((k) => !removed.has(k)) &&
      fresh.size + removed.size === original.size &&
      [...original.keys()].every((k) => fresh.has(k) || removed.has(k)) &&
      isDeepStrictEqual([...removed].sort(), [...reused].sort()) &&
      isDeepStrictEqual(
        [...reused].sort(),
        [...qualified.keys()].filter((k) => original.has(k)).sort(),
      ),
    'selected_fresh_official_partition_must_close_without_C_projection',
  );
  return { original, qualified, fresh, removed, reused };
}

const reuseReference = (q) => ({
  textHash: q.textHash,
  accent: q.accent,
  fileKey: q.entry.fileKey,
  fileSha256: q.entry.fileSha256,
  mimeType: q.entry.mimeType,
  sizeBytes: q.entry.sizeBytes,
  kind: q.entry.kind,
  cacheKey: q.entry.cacheKey,
  baseline: q.baseline,
});

/** Only publication routing may change; original generation provenance and full reviews stay exact. */
export function checkSelectedPublicationMetadata({
  choice,
  request,
  originalManifest,
  originalSource,
  manifest,
  source,
  descriptor,
  split,
  choicePin,
}) {
  const fresh = [...split.original.values()].filter((e) => split.fresh.has(key(e)));
  const reused = sorted([...split.reused].map((k) => split.qualified.get(k)));
  const freshHashes = new Set(fresh.map((e) => e.textHash)),
    reusedRefs = reused.map(reuseReference);
  same(manifest.entries, fresh, 'selected_fresh_entries_entire_original_records');
  need(
    manifest.sourceManifestSha256 === descriptor.sourceManifestSha256 &&
      manifest.version === choice.packId &&
      manifest.schemaVersion === 2 &&
      manifest.status === 'ready',
    'selected_converted_metadata_binding',
  );
  const unchangedManifest = (obj) =>
    Object.fromEntries(
      Object.entries(obj).filter(
        ([k]) => !['entries', 'statistics', 'sourceManifestSha256'].includes(k),
      ),
    );
  same(
    unchangedManifest(manifest),
    unchangedManifest(originalManifest),
    'selected_original_manifest_metadata_preserved',
  );
  const allowed = new Set([
    'sentences',
    'reusedSentences',
    'reusedMediaReferences',
    'baselinePacks',
    'coverage',
    'publicationSelection',
  ]);
  const immutable = (obj) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !allowed.has(k)));
  same(
    immutable(source),
    immutable(originalSource),
    'selected_original_source_and_complete_corrections_preserved',
  );
  same(
    source.publicationSelection,
    {
      kind: choice.kind,
      choiceProof: choicePin,
      legacySelectionSha256: choice.legacySelection.sha256,
      qualificationSha256: choice.legacyQualification.sha256,
    },
    'selected_actual_external_choice_pin',
  );
  same(source.requestedSentences, request.targets, 'selected_all_original_current_requests');
  same(
    source.sentences,
    request.targets.filter((t) => freshHashes.has(t.textHash)),
    'selected_only_selected_fresh_sentences',
  );
  same(source.reusedMediaReferences, reusedRefs, 'selected_exact_mature_original_reuse_references');
  const baseline = [...new Map(reused.map((q) => [q.baseline.id, q.baseline])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  same(
    [...source.baselinePacks].sort((a, b) => a.id.localeCompare(b.id)),
    baseline,
    'selected_exact_pinned_baselines',
  );
  const reusedRows = request.targets
    .filter((t) => reused.some((q) => q.textHash === t.textHash))
    .sort((a, b) => (a.textHash < b.textHash ? -1 : a.textHash > b.textHash ? 1 : 0))
    .map((t) => ({
      textHash: t.textHash,
      text: t.text,
      references: t.references,
      pairs: reusedRefs.filter((q) => q.textHash === t.textHash),
    }));
  same(source.reusedSentences, reusedRows, 'selected_complete_mature_reused_sentences');
  const stats = {
    lemmaCount: freshHashes.size,
    entryCount: fresh.length,
    recordedCount: 0,
    synthesizedCount: fresh.length,
    failedCount: 0,
  };
  need(
    Object.entries(stats).every(([k, v]) => descriptor[k] === v && manifest.statistics[k] === v),
    'selected_fresh_statistics_separate_from_C_generation',
  );
  return { fresh, reused };
}

function validateQualification(r, choice, voices, request, controls, policy) {
  const qualification = r.pin(choice.legacyQualification, 8 * MIB),
    selection = r.pin(choice.legacySelection, 8 * MIB);
  const qualifierSource = sha(
    r.read(
      path.join(ROOT, 'scripts/qualify-ci-legacy-sentence-reuse.py'),
      128 * 1024,
      QUALIFIER,
      17406,
    ),
  );
  need(
    qualification.kind === 'nightstudy-ci-official-legacy-reuse-qualification-v1' &&
      qualification.state === 'VERIFIED_OFFICIAL32_MP3_REUSE_ONLY' &&
      qualification.checkerSourceSha256 === qualifierSource &&
      qualification.publicRootSha256 === PUBLIC &&
      qualification.finalPolicySha256 === FINAL &&
      qualification.groups === 16 &&
      qualification.pairs === 32 &&
      qualification.completeMp3EofDecodes === 32 &&
      qualification.all32Passed === true &&
      qualification.authorizedForReuse === true &&
      qualification.pureBatchHelperSha256 === C_CHECKER &&
      qualification.pureDecoderHelperSha256 ===
        '8d4c07d943331228790aa6d0376b664677180705c0b590d42c6c73b32dcc9057' &&
      qualification.decoderInputProtocol === 'fd' &&
      qualification.seekablePinnedInput === true &&
      qualification.decoderThreads === 1 &&
      /^[a-f0-9]{64}$/.test(qualification.decoderBinarySha256) &&
      qualification.allCurrentReferencesBound === true &&
      qualification.currentIdentityMatchesEveryOldEntry === true &&
      qualification.activeHoldOverlapPairs === 0 &&
      qualification.newGenerationProofUnchanged === true &&
      qualification.originalWavsRevalidated === 0 &&
      qualification.originalWavsAvailableInPublishedArchive === false &&
      qualification.originalArchiveVerificationRequiredByWorkflow === true &&
      qualification.modelsUsed === false &&
      qualification.newMediaGenerated === false &&
      qualification.publicationAuthorized === false &&
      qualification.report.sha256 === REPORT &&
      qualification.report.bytes === 3387333,
    'selected_actual_full32_MP3_qualification_required',
  );
  need(
    selection.kind === 'nightstudy-ci-official-legacy-reuse-selection-v1' &&
      selection.state === 'APPROVED_EXACT32_OFFICIAL_REUSE_ONLY' &&
      selection.authorizedForReuse === true &&
      selection.newGenerationProofUnchanged === true &&
      selection.publicationAuthorized === false &&
      selection.publicRootSha256 === PUBLIC &&
      selection.finalPolicySha256 === FINAL &&
      selection.groups === 16 &&
      selection.pairs === 32 &&
      selection.qualification.fileName === 'qualification.json' &&
      selection.qualification.sha256 === choice.legacyQualification.sha256 &&
      selection.qualification.bytes === choice.legacyQualification.bytes,
    'selected_explicit_actual32_authority',
  );
  same(selection.entries, qualification.entries, 'selected_entire_qualified_entries');
  same(selection.report, qualification.report, 'selected_same_actual_overlap_report');
  same(selection.actualSelection, qualification.actualSelection, 'selected_same_current_selection');
  same(
    selection.actualSelection,
    request.batchApproval.selectionManifest,
    'selected_actual_fresh_plan_identity',
  );
  need(
    Array.isArray(selection.entries) && selection.entries.length === 32,
    'selected_exact32_records',
  );
  const hashes = new Map(),
    targets = new Map(request.targets.map((t) => [t.textHash, t]));
  for (const q of selection.entries) {
    need(
      ['US', 'UK'].includes(q.accent) &&
        sha(q.text) === q.textHash &&
        !controls.has(q.textHash) &&
        !policy.byIdentity.has(key(q)) &&
        q.fullMp3EofDecoded === true &&
        q.originalWavRevalidated === false &&
        q.originalWavAvailableInPublishedArchive === false,
      'selected_no_control_or_hold_override',
    );
    const voice = voices.voices[q.accent],
      e = q.entry,
      id = {
        text: q.text,
        accent: q.accent,
        engine: '1.8.0',
        generator: 'audio-v1',
        model: voice.model.sha256,
        config: voice.config.sha256,
      };
    const identity = {
      text: q.text,
      accent: q.accent,
      engineVersion: '1.8.0',
      voiceModelSha256: id.model,
      voiceConfigSha256: id.config,
      cacheKey: sha(asciiCanonical(id)),
      pronunciationCorrectionSha256: null,
      pronunciationCorrectionId: null,
    };
    same(q.expectedCurrentSynthesisIdentity, identity, 'selected_recomputed_current_old_identity');
    for (const [name, value] of Object.entries(identity))
      same(e[name] ?? null, value, 'selected_original_old_identity:' + name);
    need(
      e.textHash === q.textHash &&
        e.kind === 'synthesized' &&
        e.mimeType === 'audio/mpeg' &&
        e.fileKey === 'files/' + e.fileSha256 + '.mp3' &&
        Number.isSafeInteger(e.sizeBytes) &&
        e.sizeBytes > 0 &&
        e.sizeBytes <= 2 * MIB,
      'selected_old_exact_MP3_record',
    );
    const descriptorName = {
      'sentence-audio-v1': 'sentence-audio.manifest.json',
      'sentence-audio-v2': 'sentence-audio-v2.manifest.json',
    }[q.baseline.id];
    need(descriptorName, 'selected_only_two_official_baselines');
    const descriptor = r.json(
      path.join(ROOT, 'data', descriptorName),
      65536,
      q.officialDescriptor.sha256,
      q.officialDescriptor.bytes,
    );
    same(descriptor, q.officialDescriptor.descriptor, 'selected_actual_official_descriptor');
    same(
      q.baseline,
      {
        id: descriptor.id,
        manifestSha256: descriptor.manifestSha256,
        sourceManifestSha256: descriptor.sourceManifestSha256,
      },
      'selected_actual_old_manifest_source_pins',
    );
    need(
      Array.isArray(q.currentReferencesAndContexts) &&
        q.currentReferencesAndContexts.length >= 1 &&
        q.currentReferencesAndContexts.length <= 3,
      'selected_whole_current_reference_scope',
    );
    const refs = q.currentReferencesAndContexts.map((c) => {
      const body = c.publicContext,
        ref = c.reference;
      need(
        fields(c, ['reference', 'publicContext']) &&
          fields(body, ['word', 'sense', 'example']) &&
          fields(ref, [
            'wordId',
            'learningSenseId',
            'exampleId',
            'contentVersion',
            'bindingHash',
            'leafIndex',
            'leafManifestSha256',
            'payloadSha256',
            'publicContextSha256',
            'sourceBindingsSha256',
          ]) &&
          sha(canonical(body)) === ref.publicContextSha256 &&
          sha(canonical(c.publicContext.sense.sourceBindings)) ===
            c.reference.sourceBindingsSha256 &&
          body.word.wordId === body.sense.wordId &&
          body.word.wordId === body.example.wordId &&
          body.word.wordId === ref.wordId &&
          body.sense.id === ref.learningSenseId &&
          body.sense.id === body.example.learningSenseId &&
          body.example.id === ref.exampleId &&
          body.sense.contentVersion === ref.contentVersion &&
          body.sense.bindingHash === ref.bindingHash &&
          normalizeSentenceAudioText(body.example.exampleEn) === q.text,
        'selected_complete_current_public_context',
      );
      return c.reference;
    });
    if (targets.has(q.textHash))
      same(refs, targets.get(q.textHash).references, 'selected_all_current_reused_references');
    hashes.set(q.textHash, (hashes.get(q.textHash) ?? new Set()).add(q.accent));
  }
  need(
    hashes.size === 16 && [...hashes.values()].every((s) => s.size === 2),
    'selected_all16_dual_accent_qualified_groups',
  );
  return { qualification, selection };
}

export async function verifySelectedInstaller(args) {
  const root = path.resolve(args['evidence-root']);
  need(
    fs.realpathSync(root) === root && fs.statSync(root).isDirectory(),
    'selected_real_evidence_root',
  );
  const r = inputs(root),
    sourceSha = sha(r.read(fileURLToPath(import.meta.url), 128 * 1024));
  for (const [name, digest] of Object.entries(HELPERS))
    r.read(path.join(ROOT, 'scripts', name), 256 * 1024, digest);
  const choiceRaw = r.read(args.choice, 2 * MIB, args['choice-sha256']),
    choice = JSON.parse(choiceRaw);
  need(
    path.basename(args.choice) === 'publication-choice.json' &&
      fields(choice, [
        'kind',
        'state',
        'packId',
        'publicRootSha256',
        'finalPolicySha256',
        'request',
        'independentCheck',
        'candidate',
        'legacyQualification',
        'legacySelection',
        'selectedFreshPairs',
        'reusedOfficialPairs',
        'generatedNotSelectedPairs',
        'entryHashRecipe',
        'generationProofUnchanged',
        'publicationAuthorized',
      ]) &&
      choice.kind === 'nightstudy-ci-sentence-audio-publication-choice-v1' &&
      choice.state === 'EXPLICIT_CURRENT_PUBLICATION_PARTITION' &&
      /^sentence-audio-v4-\d{4}$/.test(choice.packId) &&
      Number(choice.packId.slice(-4)) >= 101 &&
      Number(choice.packId.slice(-4)) <= 201 &&
      choice.publicRootSha256 === PUBLIC &&
      choice.finalPolicySha256 === FINAL &&
      choice.entryHashRecipe === ENTRY_HASH_RECIPE &&
      choice.generationProofUnchanged === true &&
      choice.publicationAuthorized === false,
    'selected_exact_explicit_publication_choice',
  );
  const request = r.pin(choice.request, 8 * MIB),
    accepted = r.pin(choice.independentCheck, 16 * MIB),
    candidate = choice.candidate;
  need(
    fields(candidate, ['descriptor', 'archive', 'manifest', 'sources', 'freshInstallerCheck']),
    'selected_original_candidate_pins',
  );
  const originalDescriptor = r.pin(candidate.descriptor, MIB),
    originalManifest = r.pin(candidate.manifest, 16 * MIB),
    originalSource = r.pin(candidate.sources, 32 * MIB);
  const originalInstaller = r.pin(candidate.freshInstallerCheck, MIB);
  need(
    accepted.kind === 'nightstudy-ci-sentence-audio-batch-independent-check-v1' &&
      accepted.state === 'VERIFIED_SELECTED_BATCH_ONLY' &&
      accepted.checkerSourceSha256 === C_CHECKER &&
      accepted.requestSha256 === choice.request.sha256 &&
      accepted.publicRootSha256 === PUBLIC &&
      accepted.finalPolicySha256 === FINAL &&
      accepted.allCurrentReferencesBound === true &&
      accepted.selectionPairUnionVerified === true &&
      accepted.reviewedFrozenRawCallsVerified === true &&
      accepted.decoderInputProtocol === 'fd' &&
      accepted.seekablePinnedInput === true &&
      accepted.decoderThreads === 1 &&
      Number.isSafeInteger(accepted.generatedPairs) &&
      accepted.generatedPairs >= 1 &&
      accepted.generatedPairs <= 2000 &&
      accepted.generatedPairs === accepted.completeMp3EofDecodes &&
      accepted.generatedPairs === accepted.originalWavsFullyRead &&
      accepted.publicationAuthorized === false &&
      originalInstaller.kind === 'nightstudy-ci-sentence-audio-installer-check-v1' &&
      originalInstaller.state === 'VERIFIED_EXTRACTED_PACK_ONLY' &&
      originalInstaller.checkerSourceSha256 === FRESH_CHECKER &&
      originalInstaller.independentCheckSha256 === choice.independentCheck.sha256 &&
      originalInstaller.requestSha256 === choice.request.sha256 &&
      originalInstaller.comparedEntries === accepted.generatedPairs &&
      originalInstaller.archiveSha256 === candidate.archive.sha256 &&
      originalInstaller.archiveBytes === candidate.archive.bytes &&
      originalInstaller.maturePinnedEntryCheckPassed === true &&
      originalInstaller.matureHoldPackCheckPassed === true &&
      originalInstaller.exactMp3OnlyFileClosure === true &&
      originalInstaller.descriptorSha256 === candidate.descriptor.sha256 &&
      originalInstaller.manifestSha256 === candidate.manifest.sha256 &&
      originalInstaller.sourceManifestSha256 === candidate.sources.sha256 &&
      originalInstaller.publicationAuthorized === false,
    'selected_original_C_and_fresh_installer_proofs_unchanged',
  );
  need(
    originalDescriptor.id === choice.packId &&
      request.packId === choice.packId &&
      originalManifest.version === choice.packId &&
      originalDescriptor.source.sha256 === candidate.archive.sha256 &&
      originalDescriptor.source.sizeBytes === candidate.archive.bytes &&
      originalDescriptor.manifestSha256 === candidate.manifest.sha256 &&
      originalDescriptor.sourceManifestSha256 === candidate.sources.sha256 &&
      originalManifest.sourceManifestSha256 === candidate.sources.sha256,
    'selected_original_archive_and_metadata_identity',
  );
  await r.hash(
    r.file(candidate.archive),
    2 * 1024 ** 3 - 1,
    candidate.archive.sha256,
    candidate.archive.bytes,
  );
  const policyManifest = r.json(args['policy-manifest'], 65536, HOLD_MANIFEST, 375);
  need(
    policyManifest.holdCount === 79 &&
      policyManifest.sha256 === HOLDS &&
      policyManifest.learningSensesManifestSha256 === PUBLIC,
    'selected_explicit_global79_manifest',
  );
  const rawHolds = r.read(
    path.join(path.dirname(path.resolve(args['policy-manifest'])), policyManifest.fileName),
    4 * MIB,
    HOLDS,
    80987,
  );
  const policy = {
    ...parseSentenceAudioHoldPolicy(rawHolds),
    manifest: policyManifest,
    manifestSha256: HOLD_MANIFEST,
  };
  const voices = r.json(path.join(ROOT, 'data/audio-voices.manifest.json'), 65536, VOICES);
  const repoInputs = inputs(ROOT),
    base = repoInputs.pin(request.portableControls, 64 * MIB);
  need(
    request.portableControls.sha256 === BASE &&
      base.counts.groups === 3643 &&
      base.counts.corrections === 1757 &&
      base.counts.holds === 79,
    'selected_frozen_base_controls',
  );
  const controls = new Map(base.groups.map((g) => [g.textHash, g]));
  if (request.batchApproval.supplementalControls) {
    const s = repoInputs.pin(request.batchApproval.supplementalControls, 2 * MIB);
    need(
      s.kind === 'nightstudy-ci-audio-supplemental-controls-v1' &&
        s.baseControlsSha256 === BASE &&
        s.groups.length === 1 &&
        !controls.has(s.groups[0].textHash),
      'selected_separate_supplement',
    );
    controls.set(s.groups[0].textHash, s.groups[0]);
  }
  const { qualification, selection } = validateQualification(
    r,
    choice,
    voices,
    request,
    controls,
    policy,
  );
  const split = partitionPublication(choice, originalManifest, accepted, selection.entries);
  const extracted = path.resolve(args.extracted);
  need(fs.realpathSync(extracted) === extracted, 'selected_real_extracted_root');
  const descriptor = r.json(args.descriptor, MIB, args['descriptor-sha256']);
  need(
    descriptor.id === choice.packId &&
      descriptor.version === choice.packId &&
      descriptor.status === 'ready' &&
      path.basename(args.descriptor) === choice.packId + '.manifest.json' &&
      Number.isSafeInteger(descriptor.source.sizeBytes) &&
      descriptor.source.sizeBytes > 0 &&
      descriptor.source.sizeBytes < 2 * 1024 ** 3 &&
      fields(descriptor.source, ['url', 'sha256', 'sizeBytes']) &&
      /^[a-f0-9]{64}$/.test(descriptor.source.sha256) &&
      new RegExp(
        '^https://github\\.com/wudi000888-svg/nightstudy/releases/download/[A-Za-z0-9._-]+/nightstudy-' +
          choice.packId +
          '\\.tar\\.gz$',
      ).test(descriptor.source.url),
    'selected_converted_descriptor',
  );
  await r.hash(
    args.archive,
    2 * 1024 ** 3 - 1,
    descriptor.source.sha256,
    descriptor.source.sizeBytes,
  );
  const manifest = r.json(
      path.join(extracted, 'manifest.json'),
      16 * MIB,
      descriptor.manifestSha256,
    ),
    source = r.json(
      path.join(extracted, 'sources.manifest.json'),
      32 * MIB,
      descriptor.sourceManifestSha256,
    );
  const { fresh, reused } = checkSelectedPublicationMetadata({
    choice,
    request,
    originalManifest,
    originalSource,
    manifest,
    source,
    descriptor,
    split,
    choicePin: {
      fileName: 'publication-choice.json',
      bytes: choiceRaw.length,
      sha256: args['choice-sha256'],
    },
  });
  const compared = verifyPinnedSentenceEntries(
    fresh,
    manifest.entries.map((e) => ({ ...e, status: 'ready' })),
    policy,
  );
  need(
    compared.held === 0 && compared.eligible === fresh.length,
    'selected_mature_fresh_entry_check',
  );
  same(
    r.read(path.join(extracted, 'pronunciation-holds.json'), 4 * MIB, HOLDS, 80987),
    rawHolds,
    'selected_unchanged_global79_raw',
  );
  const reviewRaw = source.pronunciationReviews
    ? r.read(
        path.join(extracted, 'pronunciation-reviews.json'),
        4 * MIB,
        source.pronunciationReviews.sha256,
        source.pronunciationReviews.bytes,
      )
    : null;
  const reviewCount = checkInstallerReviews(
    source,
    manifest,
    reviewRaw ? JSON.parse(reviewRaw) : null,
    controls,
  );
  const mp3s = checkInstallerFileSet(extracted, manifest, reviewRaw !== null);
  for (const e of fresh)
    await r.hash(path.join(extracted, e.fileKey), 2 * MIB, e.fileSha256, e.sizeBytes);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-selected-policy-'));
  let coverage;
  try {
    fs.writeFileSync(path.join(temp, choice.packId + '.pronunciation-holds.json'), rawHolds, {
      flag: 'wx',
    });
    if (reviewRaw)
      fs.writeFileSync(path.join(temp, choice.packId + '.pronunciation-reviews.json'), reviewRaw, {
        flag: 'wx',
      });
    coverage = verifySentenceAudioPackHolds(
      policy,
      source,
      manifest,
      temp,
      choice.packId,
      request.targets,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  need(
    coverage.generatedClipCount === fresh.length &&
      coverage.reusedClipCount === reused.length &&
      Object.entries(coverage).every(([k, v]) => descriptor[k] === v),
    'selected_complete_fresh_reused_held_coverage',
  );
  same(
    descriptor,
    {
      ...originalDescriptor,
      source: descriptor.source,
      manifestSha256: descriptor.manifestSha256,
      sourceManifestSha256: descriptor.sourceManifestSha256,
      lemmaCount: new Set(fresh.map((e) => e.textHash)).size,
      entryCount: fresh.length,
      recordedCount: 0,
      synthesizedCount: fresh.length,
      failedCount: 0,
      ...coverage,
    },
    'selected_only_explicit_descriptor_publication_changes',
  );
  same(
    manifest.statistics,
    {
      ...originalManifest.statistics,
      lemmaCount: descriptor.lemmaCount,
      entryCount: fresh.length,
      recordedCount: 0,
      synthesizedCount: fresh.length,
      failedCount: 0,
      ...coverage,
    },
    'selected_only_explicit_statistics_changes',
  );
  r.unchanged();
  repoInputs.unchanged();
  return {
    kind: 'nightstudy-ci-sentence-audio-selected-installer-check-v1',
    state: 'VERIFIED_SELECTED_EXTRACTED_PACK_ONLY',
    publicationMode: 'legacy-reuse-conversion',
    checkerSourceSha256: sourceSha,
    packId: choice.packId,
    request: choice.request,
    originalIndependentCheck: choice.independentCheck,
    originalFreshInstallerCheck: candidate.freshInstallerCheck,
    publicationChoice: {
      fileName: 'publication-choice.json',
      bytes: choiceRaw.length,
      sha256: args['choice-sha256'],
    },
    legacyQualification: choice.legacyQualification,
    legacySelection: choice.legacySelection,
    descriptorSha256: args['descriptor-sha256'],
    archiveSha256: descriptor.source.sha256,
    archiveBytes: descriptor.source.sizeBytes,
    manifestSha256: descriptor.manifestSha256,
    sourceManifestSha256: descriptor.sourceManifestSha256,
    helperSourceSha256: HELPERS,
    entryHashRecipe: ENTRY_HASH_RECIPE,
    originalGeneratedPairs: accepted.generatedPairs,
    selectedFreshPairs: fresh.length,
    reusedOfficialPairs: reused.length,
    generatedNotSelectedPairs: split.removed.size,
    globalHoldCount: policy.entries.length,
    globalHoldsSha256: HOLDS,
    pronunciationReviewCount: reviewCount,
    uniqueMp3Files: mp3s.size,
    coverage,
    generationProofUnchanged: true,
    matureSelectedFreshEntryCheckPassed: true,
    matureHoldPackCheckPassed: true,
    exactMp3OnlyFileClosure: true,
    originalReuseQualificationAll32Passed: qualification.all32Passed,
    reusedMediaRehashedHere: false,
    oldWavsRevalidated: false,
    databaseUsed: false,
    modelsUsed: false,
    audioDecodedHere: false,
    allLibraryDatabaseAcceptancePassed: false,
    publicationAuthorized: false,
  };
}

async function main() {
  const names = [
    'evidence-root',
    'choice',
    'choice-sha256',
    'descriptor',
    'descriptor-sha256',
    'archive',
    'extracted',
    'policy-manifest',
    'receipt',
  ];
  const { values } = parseArgs({
    options: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
    strict: true,
  });
  need(
    process.platform === 'linux' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      names.every((n) => values[n]) &&
      /^[a-f0-9]{64}$/.test(values['choice-sha256']) &&
      /^[a-f0-9]{64}$/.test(values['descriptor-sha256']),
    'selected_cloud_explicit_inputs',
  );
  const receipt = path.resolve(values.receipt);
  need(
    !fs.existsSync(receipt) && fs.realpathSync(path.dirname(receipt)) === path.dirname(receipt),
    'selected_fresh_receipt',
  );
  const result = await verifySelectedInstaller(values);
  fs.writeFileSync(receipt, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      state: result.state,
      packId: result.packId,
      selectedFreshPairs: result.selectedFreshPairs,
      reusedOfficialPairs: result.reusedOfficialPairs,
      publicationAuthorized: false,
    }),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(JSON.stringify({ state: 'SELECTED_INSTALLER_CHECK_FAILED', code: e.message }));
    process.exitCode = 1;
  });
