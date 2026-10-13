export function dictionaryText(value: string | null | undefined) {
  return (value ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\[rn]/g, '\n')
    .trim();
}
