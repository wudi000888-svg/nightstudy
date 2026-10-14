import fs from 'node:fs';
import { goals, goalLabels, normalizeLemma } from '../packages/core/src/index.js';
import { readConfig } from '../apps/api/src/config.js';
import { createDatabase } from '../apps/api/src/db.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Original, deliberately small sample. These are not licensed examination lists.
const words = [
  ['rain', 'n.', '雨', 'Water falling from clouds.', 'The rain stopped before our evening walk.'],
  ['window', 'n.', '窗户', 'An opening with glass in a wall.', 'I left my book beside the window.'],
  ['quiet', 'adj.', '安静的', 'Making little noise.', 'The room was quiet after dinner.'],
  ['learn', 'v.', '学习', 'To gain knowledge or a skill.', 'We learn a few new words every day.'],
  ['story', 'n.', '故事', 'An account of events.', 'She wrote a short story about a garden.'],
  ['river', 'n.', '河流', 'A natural stream of water.', 'A small bridge crosses the river.'],
  [
    'travel',
    'v.',
    '旅行',
    'To go from one place to another.',
    'I travel by train when I visit my family.',
  ],
  ['friend', 'n.', '朋友', 'A person you know and like.', 'My friend brought me a cup of tea.'],
  ['morning', 'n.', '早晨', 'The early part of the day.', 'We meet in the park every morning.'],
  [
    'garden',
    'n.',
    '花园',
    'A place where plants are grown.',
    'The garden looks different in winter.',
  ],
  [
    'balance',
    'n.',
    '平衡',
    'A steady distribution of weight or attention.',
    'A short break helps me keep a better balance.',
  ],
  [
    'improve',
    'v.',
    '改进；提高',
    'To become or make something better.',
    'Daily practice can improve your writing.',
  ],
  [
    'notice',
    'v.',
    '注意到',
    'To become aware of something.',
    'Did you notice the new sign at the station?',
  ],
  ['prepare', 'v.', '准备', 'To make ready for something.', 'We prepare a simple meal together.'],
  [
    'compare',
    'v.',
    '比较',
    'To examine similarities and differences.',
    'Compare the two sentences before you answer.',
  ],
  [
    'patient',
    'adj.',
    '有耐心的',
    'Able to wait calmly.',
    'The teacher was patient with every question.',
  ],
  [
    'support',
    'v.',
    '支持',
    'To help someone or something.',
    'My family supports my plan to study abroad.',
  ],
  [
    'reason',
    'n.',
    '原因；理由',
    'An explanation for something.',
    'There is a good reason to review this word.',
  ],
  ['choice', 'n.', '选择', 'The act of choosing.', 'You have a choice between two paths.'],
  ['habit', 'n.', '习惯', 'Something done regularly.', 'Reading before bed became a useful habit.'],
  [
    'evidence',
    'n.',
    '证据',
    'Information supporting a conclusion.',
    'We need more evidence before changing the plan.',
  ],
  [
    'adapt',
    'v.',
    '适应；调整',
    'To change to fit a new situation.',
    'Plants adapt to changes in their environment.',
  ],
  [
    'estimate',
    'v.',
    '估计',
    'To make an approximate calculation.',
    'Can you estimate how long the journey will take?',
  ],
  [
    'contrast',
    'n.',
    '差异；对比',
    'A clear difference between things.',
    'The contrast between the pictures is easy to see.',
  ],
  [
    'reliable',
    'adj.',
    '可靠的',
    'Able to be trusted.',
    'A reliable timetable helps us plan the day.',
  ],
  [
    'resource',
    'n.',
    '资源',
    'Something useful and available.',
    'The library is a valuable resource for learners.',
  ],
  ['observe', 'v.', '观察', 'To watch carefully.', 'Observe the leaves as the seasons change.'],
  [
    'context',
    'n.',
    '语境；背景',
    'The situation surrounding something.',
    'The context helps us understand this sentence.',
  ],
  [
    'strategy',
    'n.',
    '策略',
    'A plan for reaching a goal.',
    'Our strategy is to practice little and often.',
  ],
  [
    'maintain',
    'v.',
    '保持；维护',
    'To keep something in a particular condition.',
    'A short daily walk helps maintain my energy.',
  ],
  [
    'ambiguous',
    'adj.',
    '有歧义的',
    'Having more than one possible meaning.',
    'The ambiguous note led us to ask another question.',
  ],
  [
    'sustainable',
    'adj.',
    '可持续的',
    'Able to continue without exhausting resources.',
    'We are looking for a sustainable way to save water.',
  ],
  [
    'constraint',
    'n.',
    '限制条件',
    'A limit on what can be done.',
    'Time is the main constraint on this project.',
  ],
  [
    'inference',
    'n.',
    '推断',
    'A conclusion based on available information.',
    'Her inference was supported by several observations.',
  ],
  [
    'coherent',
    'adj.',
    '连贯的',
    'Clear and logically connected.',
    'He gave a coherent explanation of the problem.',
  ],
  [
    'allocate',
    'v.',
    '分配',
    'To assign something for a purpose.',
    'We allocate half an hour to review each evening.',
  ],
  [
    'resilient',
    'adj.',
    '有韧性的',
    'Able to recover after difficulty.',
    'The small tree remained resilient after the storm.',
  ],
  [
    'hypothesis',
    'n.',
    '假设',
    'An explanation that can be tested.',
    'The experiment was designed to test this hypothesis.',
  ],
  [
    'evaluate',
    'v.',
    '评估',
    'To judge value or quality.',
    'We evaluate our progress at the end of each week.',
  ],
  [
    'perspective',
    'n.',
    '视角；观点',
    'A way of considering something.',
    'The discussion gave me a new perspective on the topic.',
  ],
] as const;

for (const site of readConfig().sites) {
  const prisma = createDatabase(site.databaseUrl);
  try {
    await prisma.$transaction(
      async (tx) => {
        const state = await tx.siteState.findUnique({ where: { id: 'singleton' } });
        if (state && state.siteId !== site.id)
          throw new Error('Database is already assigned to a different site');
        await tx.siteState.upsert({
          where: { id: 'singleton' },
          create: { siteId: site.id },
          update: {},
        });
        for (const [i, word] of words.entries()) {
          const id = `demo-word-${String(i + 1).padStart(3, '0')}`;
          await tx.word.upsert({
            where: { id },
            create: {
              id,
              lemma: word[0],
              normalizedLemma: normalizeLemma(word[0]),
              goalTags: [...goals],
              difficulty: Math.floor(i / 10) + 1,
              senses: {
                create: {
                  id: `${id}-sense-1`,
                  pos: word[1],
                  definitionZh: word[2],
                  definitionEn: word[3],
                  exampleEn: word[4],
                  ordinal: 0,
                },
              },
            },
            update: {},
          });
        }
        for (const goal of goals) {
          const id = `demo-book-${goal}`;
          if (process.env.CONTENT_PACK !== 'demo') {
            await tx.book.updateMany({
              where: { id, ownerId: null },
              data: { status: 'archived' },
            });
            await tx.userSettings.updateMany({
              where: { currentBookId: id },
              data: { currentBookId: null },
            });
            continue;
          }
          await tx.book.upsert({
            where: { id },
            create: {
              id,
              slug: id,
              title: `${goalLabels[goal]} · 演示词书`,
              description:
                '40 个原创示例词，用于体验学习流程。不是完整考试词库，水平报告仅针对示例词。',
              goal,
            },
            update: {},
          });
          await tx.bookItem.createMany({
            data: words.map((_, i) => ({
              bookId: id,
              wordId: `demo-word-${String(i + 1).padStart(3, '0')}`,
              focusSenseId: `demo-word-${String(i + 1).padStart(3, '0')}-sense-1`,
              ordinal: i,
            })),
            skipDuplicates: true,
          });
        }
      },
      { timeout: 30000 },
    );
    console.log(
      JSON.stringify({
        siteId: site.id,
        contentVersion: 'demo-2026-10-14',
        demoWords: words.length,
        books: process.env.CONTENT_PACK === 'demo' ? goals.length : 0,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
