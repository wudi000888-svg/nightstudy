import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  assertLearningSensesInstallUnchanged,
  loadLearningSensesBundle,
  prepareLearningSensesInstall,
} from './learning-senses-lib.js';

// Explicit opt-in: this measures the real full-catalog path in one guarded
// worker. Small unit fixtures alone do not establish full-catalog admission.
const filename = process.env.NIGHTSTUDY_SENSES_FULL_TEST_MANIFEST;
it.skipIf(!filename)(
  'preflights the complete catalog and resolves first/last-leaf audio references without eager loading',
  async () => {
    // The verifier is native ESM and has independent runtime assertions.
    const verifierUrl = new URL('./check-learning-senses-install.mjs', import.meta.url).href;
    const { prepareLearningSensesVerification, readLearningSentenceTargetsForPack } = await import(
      verifierUrl
    );
    const bytes = fs.readFileSync(filename!);
    const manifest = JSON.parse(bytes.toString('utf8'));
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.wordCount).toBeGreaterThan(1000);
    expect(() => loadLearningSensesBundle(filename!)).toThrow('use_bounded_install');
    const install = prepareLearningSensesInstall(filename!);
    expect(install).toMatchObject({
      wordCount: manifest.wordCount,
      senseCount: manifest.senseCount,
      exampleCount: manifest.exampleCount,
      leafCount: manifest.shards.length,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect('rows' in install).toBe(false);
    assertLearningSensesInstallUnchanged(install);
    const verification = prepareLearningSensesVerification(filename!);
    expect(verification.leaves).toHaveLength(manifest.shards.length);
    for (const index of [0, verification.leaves.length - 1]) {
      const leaf = verification.readLeaf(index, { remaining: 64 * 1024 * 1024 });
      const word = leaf.rows[0]!;
      const sense = word.senses[0]!;
      const example = sense.examples[0]!;
      const request = {
        textHash: example.contentMetadata.textHash,
        references: [{ wordId: word.wordId, learningSenseId: sense.id, exampleId: example.id }],
      };
      const actual = readLearningSentenceTargetsForPack(verification, [request]);
      expect(actual).toHaveLength(1);
      expect(actual[0]!.references).toContainEqual(request.references[0]);
      expect(actual[0]!.text).toBe(
        example.exampleEn
          .normalize('NFKC')
          .replace(/[‘’]/g, "'")
          .replace(/[“”]/g, '"')
          .replace(/\s+/gu, ' ')
          .trim(),
      );
    }
    verification.unchanged();
    assertLearningSensesInstallUnchanged(install);
  },
  75000,
);
