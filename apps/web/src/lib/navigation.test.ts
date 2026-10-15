import { describe, expect, it } from 'vitest';
import { isStudyPath, navigationGroup, navigationTitle } from './navigation';
describe('mobile navigation ownership', () => {
  it('assigns task, content tools and memory to their primary sections', () => {
    for (const path of ['/', '/learn', '/review']) expect(navigationGroup(path)).toBe('learning');
    for (const path of [
      '/content',
      '/books/mine',
      '/wordbook',
      '/known',
      '/notes',
      '/sentences',
      '/academy',
      '/assessment',
      '/translate',
    ])
      expect(navigationGroup(path)).toBe('content');
    for (const path of ['/me', '/memory', '/stats', '/auth/login'])
      expect(navigationGroup(path)).toBe('account');
    expect(navigationGroup('/admin/ai')).toBe('admin');
    expect(navigationGroup('/administrator')).toBe('content');
  });
  it('focuses only an actual study path and preserves a useful nested title', () => {
    expect(isStudyPath('/learn')).toBe(true);
    expect(isStudyPath('/review')).toBe(true);
    expect(isStudyPath('/learn/history')).toBe(false);
    expect(navigationTitle('/books/import')).toBe('导入词书');
  });
});
