export const answer = 42;

export function formatAnswer(prefix: string): string {
  const message = `${prefix}: ${answer}`;
  return message;
}

export function printAnswer(prefix: string): void {
  console.log(formatAnswer(prefix));
}
