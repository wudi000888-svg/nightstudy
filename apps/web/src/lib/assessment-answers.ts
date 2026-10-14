import { newId, post } from './api';

interface PendingAnswer {
  assessmentId: string;
  itemId: string;
  answer: string;
  commandId: string;
}

// Keep the same command when an accepted answer loses its response. The server
// can replay its receipt without recording a second answer or changing evidence.
export class AssessmentAnswerSender<T> {
  private pending: PendingAnswer | null = null;
  constructor(
    private readonly transport = (path: string, body: Omit<PendingAnswer, 'assessmentId'>) =>
      post<{ assessment: T }>(path, body),
    private readonly makeId: () => string = newId,
  ) {}
  reset() {
    this.pending = null;
  }
  async send(assessmentId: string, itemId: string, answer: string) {
    const previous = this.pending;
    const command =
      previous?.assessmentId === assessmentId &&
      previous.itemId === itemId &&
      previous.answer === answer
        ? previous
        : { assessmentId, itemId, answer, commandId: this.makeId() };
    this.pending = command;
    const result = await this.transport(`assessments/${assessmentId}/answers`, {
      commandId: command.commandId,
      itemId,
      answer,
    });
    if (this.pending === command) this.pending = null;
    return result;
  }
}
