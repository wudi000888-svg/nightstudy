import { afterAll, expect, it, vi } from 'vitest';
import { AssessmentAnswerSender } from './assessment-answers';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
afterAll(() => vi.unstubAllGlobals());

it('replays the same command after the server accepts an answer but the response is lost', async () => {
  const accepted = new Map<string, { assessment: { currentItemId: string } }>();
  const sent: { commandId: string; itemId: string; answer: string }[] = [];
  let lost = false;
  let recordedAnswers = 0;
  const sender = new AssessmentAnswerSender<{ currentItemId: string }>(
    async (_path, body) => {
      sent.push(body);
      if (!accepted.has(body.commandId)) {
        recordedAnswers++;
        accepted.set(body.commandId, { assessment: { currentItemId: 'next-question' } });
      }
      if (!lost) {
        lost = true;
        throw new Error('lost acknowledgement');
      }
      return accepted.get(body.commandId)!;
    },
    () => 'fixed-command',
  );
  await expect(sender.send('test', 'spelling-rain', 'rain')).rejects.toThrow(
    'lost acknowledgement',
  );
  expect(await sender.send('test', 'spelling-rain', 'rain')).toEqual({
    assessment: { currentItemId: 'next-question' },
  });
  expect(sent[0]).toEqual(sent[1]);
  expect(recordedAnswers).toBe(1);
});

it('does not reuse a receipt identity after a changed answer, question, test or explicit reload', async () => {
  let serial = 0;
  const transport = vi.fn().mockRejectedValue(new Error('offline'));
  const sender = new AssessmentAnswerSender(transport, () => `command-${++serial}`);
  const ignored = async (...args: Parameters<typeof sender.send>) => {
    await sender.send(...args).catch(() => {});
  };
  await ignored('test', 'q1', 'rain');
  await ignored('test', 'q1', 'rain');
  await ignored('test', 'q1', 'window');
  await ignored('test', 'q2', 'window');
  await ignored('other-test', 'q2', 'window');
  sender.reset();
  await ignored('other-test', 'q2', 'window');
  expect(transport.mock.calls.map(([, body]) => body.commandId)).toEqual([
    'command-1',
    'command-1',
    'command-2',
    'command-3',
    'command-4',
    'command-5',
  ]);
});

it('sends only the answer command and never a client score or mastery claim', async () => {
  const transport = vi.fn().mockResolvedValue({ assessment: { currentItemId: null } });
  const sender = new AssessmentAnswerSender(transport, () => 'receipt');
  await sender.send('test', 'q1', '');
  expect(transport).toHaveBeenCalledExactlyOnceWith('assessments/test/answers', {
    commandId: 'receipt',
    itemId: 'q1',
    answer: '',
  });
});
