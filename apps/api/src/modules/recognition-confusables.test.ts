import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  loadRecognitionConfusables,
  recognitionWordsConfusable,
} from './recognition-confusables.js';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
describe('pinned public lexical exclusions', () => {
  it('blocks synonyms, direct subsumption and explicit conservative pairs without classifying every word', () => {
    expect(recognitionWordsConfusable('pliable', 'pliant')).toBe(true);
    expect(recognitionWordsConfusable('dog', 'canine')).toBe(true);
    expect(recognitionWordsConfusable('POISON', 'pollutant')).toBe(true);
    expect(recognitionWordsConfusable('pollutant', 'poison')).toBe(true);
    expect(recognitionWordsConfusable('dog', 'cat')).toBe(false);
    expect(recognitionWordsConfusable('customunknownlemma', 'cat')).toBe(false);
  });
  it('rejects a changed notice, unsafe file and a validly hashed asymmetric graph', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstudy-recognition-graph-'));
    try {
      for (const file of [
        'recognition-confusables-v1.manifest.json',
        'recognition-confusables-v1.json.gz',
        'recognition-wordnet.LICENSE.txt',
      ])
        fs.copyFileSync(path.join('data', file), path.join(directory, file));
      const manifestPath = path.join(directory, 'recognition-confusables-v1.manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const notice = path.join(directory, manifest.licenseNoticeFileName);
      fs.appendFileSync(notice, 'changed');
      expect(() => loadRecognitionConfusables(directory)).toThrow('recognition_index_checksum');
      fs.copyFileSync(path.join('data', manifest.licenseNoticeFileName), notice);
      const packedPath = path.join(directory, manifest.fileName);
      const original = fs.readFileSync(packedPath);
      fs.renameSync(packedPath, packedPath + '.original');
      fs.symlinkSync(packedPath + '.original', packedPath);
      expect(() => loadRecognitionConfusables(directory)).toThrow('recognition_index_file_invalid');
      fs.unlinkSync(packedPath);
      const data = JSON.parse(gunzipSync(original).toString('utf8'));
      data.words.pliable = data.words.pliable.filter((word: string) => word !== 'pliant');
      const decoded = Buffer.from(JSON.stringify(data)),
        packed = gzipSync(decoded);
      fs.writeFileSync(packedPath, packed);
      Object.assign(manifest, {
        bytes: packed.length,
        sha256: sha(packed),
        jsonSha256: sha(decoded),
        directedExclusionCount: manifest.directedExclusionCount - 1,
      });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => loadRecognitionConfusables(directory)).toThrow(
        'recognition_index_not_symmetric',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
