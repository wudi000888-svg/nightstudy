export type AcademyCategory = 'reading' | 'shadowing' | 'listening' | 'topic';
export interface AcademyLesson {
  id: string;
  title: string;
  description: string;
  category: AcademyCategory;
  level: 'starter' | 'elementary';
  durationMinutes: number;
  version: string;
  original: true;
  license: 'MIT';
  body: Array<{ id: string; en: string; zh: string }>;
  vocabulary: string[];
  listeningTargets: string[];
  speech: { kind: 'device'; requiresAvailableVoice: true } | null;
  completionPolicy: 'objective-listening' | 'completion-only';
}
const lesson = (
  id: string,
  title: string,
  category: AcademyCategory,
  description: string,
  lines: Array<[string, string]>,
  vocabulary: string[],
  listeningTargets: string[] = [],
): AcademyLesson => ({
  id,
  title,
  category,
  description,
  level: 'starter',
  durationMinutes: 3,
  version: 'nightstudy-original-academy-v1',
  original: true,
  license: 'MIT',
  body: lines.map(([en, zh], index) => ({ id: `${id}-${index + 1}`, en, zh })),
  vocabulary,
  listeningTargets,
  speech: category === 'shadowing' ? { kind: 'device', requiresAvailableVoice: true } : null,
  completionPolicy: category === 'listening' ? 'objective-listening' : 'completion-only',
});
/** Original introductory lessons, not copied courseware or a complete examination curriculum. */
export const academyLessons: readonly AcademyLesson[] = [
  lesson(
    'rain-at-the-station',
    '车站的一场雨',
    'reading',
    '读一段关于等车和互相帮助的短文。',
    [
      ['Rain began just as Mia reached the station.', '米娅刚到车站，雨就下起来了。'],
      [
        'She moved away from the open window and checked the time.',
        '她从开着的窗边挪开，看了看时间。',
      ],
      [
        'An older passenger offered her a dry seat beside his bag.',
        '一位年长的乘客请她坐在自己包旁边的干燥座位上。',
      ],
      [
        'When the train arrived, they helped each other carry their bags.',
        '火车到站时，他们互相帮忙提行李。',
      ],
    ],
    ['rain', 'station', 'window', 'passenger'],
  ),
  lesson(
    'a-shared-kitchen',
    '共用厨房',
    'reading',
    '观察短文中的动作顺序与请求。',
    [
      [
        'Leo filled a glass with water before he started cooking.',
        '利奥开始做饭前，先倒了一杯水。',
      ],
      [
        'His sister washed the vegetables while he heated the soup.',
        '他热汤的时候，妹妹洗了蔬菜。',
      ],
      [
        'They kept the kitchen quiet because their father was asleep.',
        '因为父亲睡着了，他们在厨房里保持安静。',
      ],
      [
        'After dinner, they cleaned the table and opened the window.',
        '晚饭后，他们收拾了桌子，打开窗户。',
      ],
    ],
    ['water', 'vegetable', 'quiet', 'window'],
  ),
  lesson(
    'clear-requests',
    '把请求说清楚',
    'shadowing',
    '可选设备语音示范；自己朗读后标记完成，不进行口语评分。',
    [
      ['Could you close the window, please?', '请你把窗户关上，好吗？'],
      ['May I have a glass of water?', '可以给我一杯水吗？'],
      ['Please keep your voice quiet in this room.', '在这个房间里，请放轻声音。'],
      ['Thank you for waiting while I find my ticket.', '谢谢你等我找车票。'],
    ],
    ['window', 'water', 'quiet', 'ticket'],
  ),
  lesson(
    'listen-around-home',
    '听音识词：家中场景',
    'listening',
    '播放真实可用的单词音源，选择听到的词；提交后显示答案。',
    [
      ['Listen before you look for a familiar spelling.', '先听声音，再寻找熟悉的拼写。'],
      ['You may replay a word before choosing an answer.', '作答前可以再次播放单词。'],
    ],
    ['rain', 'window', 'water', 'quiet'],
    ['rain', 'window', 'water', 'quiet'],
  ),
  lesson(
    'listen-on-a-rainy-day',
    '听音识词：雨天复习',
    'listening',
    '换一种顺序练习四个常见词，两种口音由你选择。',
    [
      ['Choose one accent and listen to each word carefully.', '选择一种口音，认真听每个单词。'],
      [
        'A wrong answer is a practice result, not a memory rating.',
        '答错只是这次练习的结果，不是记忆评分。',
      ],
    ],
    ['water', 'quiet', 'rain', 'window'],
    ['water', 'quiet', 'rain', 'window'],
  ),
  lesson(
    'space-your-practice',
    '专题：把练习分开',
    'topic',
    '用一个具体学习安排理解间隔练习；本课不修改你的学习计划。',
    [
      [
        'Read a short passage, then close it and recall the main idea.',
        '读一段短文，然后合上它，回想主要内容。',
      ],
      [
        'When a word is difficult, check it and try again later.',
        '遇到难词时，查清楚，再过一会儿尝试回忆。',
      ],
      ['A small amount of regular practice is easier to continue.', '少量而规律的练习更容易坚持。'],
      [
        'Keep your next session short enough to fit a busy day.',
        '下一次练习不要安排太长，让忙碌的一天也容得下它。',
      ],
    ],
    ['practice', 'recall', 'regular', 'session'],
  ),
];
