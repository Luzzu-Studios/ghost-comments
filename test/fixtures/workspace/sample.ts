export function formatAnswer(prefix: string, answer: string): string {
  const message = `${prefix}: ${answer}`;
  return message;
}

export function formatGreeting(name: string): string {
  const message = `Hello, ${name}!`;
  return message;
}

export function formatTitle(title: string): string {
  const message = `Title: ${title}`;
  return message;
}

export function formatReminder(task: string): string {
  const message = `Remember: ${task}`;
  return message;
}