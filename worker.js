import { completeCheck } from './check.js';

export async function handler(event) {
  if (!Array.isArray(event.Records)) throw new Error('Expected SQS records.');
  const batchItemFailures = [];
  for (const record of event.Records) {
    if (typeof record.messageId !== 'string') throw new Error('SQS record is missing its message ID.');
    try {
      await completeCheck(JSON.parse(record.body));
    } catch (error) {
      console.error('Could not process queued check:', error.name, Number.isInteger(error.status) ? error.status : '');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
