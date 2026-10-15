export type NavigationGroup = 'learning' | 'content' | 'academy' | 'account' | 'admin';
export type AppModule = Exclude<NavigationGroup, 'admin'>;
export const moduleRoots: Record<AppModule, string> = {
  academy: '/academy',
  content: '/content',
  learning: '/learning',
  account: '/me',
};
export const isStudyPath = (path: string) => path === '/learn' || path === '/review';
const modulePaths = new Set([
  '/learning',
  '/content',
  '/academy',
  '/me',
  '/books',
  '/books/mine',
  '/books/import',
  '/lookup',
  '/dictionary',
  '/wordbook',
  '/translate',
  '/known',
  '/assessment',
  '/memory',
  '/stats',
  '/library',
  '/sentences',
  '/notes',
  '/auth',
  '/auth/login',
  '/setup',
]);
export function navigationGroup(path: string): NavigationGroup {
  if (path === '/admin' || path.startsWith('/admin/')) return 'admin';
  if (path === '/academy') return 'academy';
  if (
    ['/', '/learning', '/books', '/assessment', '/memory', '/stats', '/library'].includes(path) ||
    isStudyPath(path)
  )
    return 'learning';
  if (['/me', '/auth', '/setup'].includes(path) || path.startsWith('/auth/')) return 'account';
  return 'content';
}
export function screenModule(path: string): AppModule | null {
  if (!modulePaths.has(path)) return null;
  const group = navigationGroup(path);
  return group === 'admin' ? null : group;
}
export function screenIdentity(path: string) {
  return path === '/' ? 'home' : isStudyPath(path) ? 'study' : path;
}
export function navigationTitle(path: string) {
  const names: Record<string, string> = {
    '/': '学习',
    '/learn': '今日学习',
    '/review': '复习',
    '/content': '我的内容',
    '/learning': '我的学习',
    '/books': '选择词书',
    '/books/import': '导入词书',
    '/books/mine': '我的词书',
    '/lookup': '查词',
    '/wordbook': '生词本',
    '/known': '熟词本',
    '/library': '学习记录',
    '/sentences': '我的句库',
    '/notes': '我的笔记',
    '/academy': '学堂',
    '/assessment': '测测水平',
    '/translate': '网页翻译',
    '/memory': '个人记忆',
    '/stats': '学习统计',
    '/me': '我的',
    '/auth': '连接学习账户',
    '/auth/login': '连接学习账户',
    '/setup': '初始化',
    '/dictionary': '词典说明',
  };
  return path.startsWith('/admin') ? '管理自习室' : (names[path] ?? '夜读英语');
}
