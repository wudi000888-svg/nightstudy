/** The offline pack uses this exact normalization; retain case for names/acronyms. */
export function normalizeSentence(text: string) {
  return text
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function sentenceAudioHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizeSentence(text)),
  );
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}
