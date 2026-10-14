import { readConfig } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db.js';
import { verifiedAudioBytes } from '../apps/api/dist/audio.js';
import fs from 'node:fs';
if (fs.existsSync('.env')) process.loadEnvFile('.env');
for (const site of readConfig().sites) {
  const db = createDatabase(site.databaseUrl);
  try {
    const pack = await db.contentPack.findUnique({ where: { id: 'audio-v1' } });
    if (pack?.status !== 'ready' || pack.entryCount !== 17596)
      throw new Error('audio pack not ready');
    const books = await db.book.findMany({
      where: { ownerId: null, status: 'published' },
      select: { id: true },
    });
    const words = await db.word.findMany({
      where: { bookItems: { some: { bookId: { in: books.map((b) => b.id) } } } },
      include: { audio: { where: { status: 'ready' } } },
    });
    if (
      books.length !== 5 ||
      words.length !== 8798 ||
      words.some(
        (w) =>
          !w.phoneticUs ||
          !w.phoneticUk ||
          w.audio.length !== 2 ||
          !w.audio.some((a) => a.accent === 'US') ||
          !w.audio.some((a) => a.accent === 'UK'),
      )
    )
      throw new Error('built-in book coverage incomplete');
    const media = await db.wordAudio.findMany({
      where: {
        word: { normalizedLemma: { in: ['rain', 'abandon', 'water', 'tomato'] } },
        status: 'ready',
      },
    });
    for (const entry of media) await verifiedAudioBytes(entry);
    if (!media.some((a) => a.kind === 'recorded') || !media.some((a) => a.kind === 'synthesized'))
      throw new Error('sample coverage incomplete');
    console.log(
      JSON.stringify({
        verified: true,
        siteId: site.id,
        books: books.length,
        words: words.length,
        audio: words.reduce((n, w) => n + w.audio.length, 0),
        sampleFiles: media.length,
      }),
    );
  } finally {
    await db.$disconnect();
  }
}
