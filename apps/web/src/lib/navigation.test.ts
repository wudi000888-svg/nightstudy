import { describe, expect, it } from 'vitest';
import { isStudyPath, navigationGroup, navigationTitle } from './navigation';
describe('mobile navigation ownership', () => {
  it('assigns independent H5 modules without turning the home into a permanent tab', () => {
    for (const path of [
      '/',
      '/learn',
      '/review',
      '/learning',
      '/assessment',
      '/memory',
      '/stats',
      '/books',
      '/library',
    ])
      expect(navigationGroup(path)).toBe('learning');
    for (const path of [
      '/content',
      '/books/mine',
      '/wordbook',
      '/known',
      '/notes',
      '/sentences',
      '/translate',
    ])
      expect(navigationGroup(path)).toBe('content');
    expect(navigationGroup('/academy')).toBe('academy');
    for (const path of ['/me', '/auth/login']) expect(navigationGroup(path)).toBe('account');
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
