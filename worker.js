import { completeCheck } from './check.js';
import { completeCompare } from './compare.js';
import { completeExhibit } from './exhibit.js';
import { completeLink, completeRegister } from './links.js';

export async function handler(event) {
  if (!Array.isArray(event.Records)) throw new Error('Expected SQS records.');
  const batchItemFailures = [];
  for (const record of event.Records) {
    if (typeof record.messageId !== 'string') throw new Error('SQS record is missing its message ID.');
    try {
      const interaction = JSON.parse(record.body);
      if (interaction.data?.name === 'compare') {
        await completeCompare(interaction);
      } else if (interaction.data?.name === 'exhibit') {
        await completeExhibit(interaction);
      } else if (interaction.data?.name === 'register') {
        await completeRegister(interaction);
      } else if (interaction.data?.name === 'link') {
        await completeLink(interaction);
      } else if (interaction.data?.name === 'check' || interaction.data?.name === undefined) {
        await completeCheck(interaction);
      } else {
        throw new Error('Unsupported queued command.');
      }
    } catch (error) {
      console.error('Could not process queued lookup:', error.name, Number.isInteger(error.status) ? error.status : '');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
