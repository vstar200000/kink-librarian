import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
	InteractionResponseFlags,
	InteractionResponseType,
	InteractionType,
	MessageComponentTypes,
	verifyKey,
} from 'discord-interactions';
import { getRandomEmoji } from './utils.js';

const sqs = new SQSClient({ maxAttempts: 1 });

const COMMAND_LIST = ['test', 'check', 'compare', 'exhibit'];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.requestContext?.http?.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  if (!process.env.PUBLIC_KEY) throw new Error('PUBLIC_KEY is required.');
  if (typeof event.body !== 'string') return jsonResponse(400, { error: 'Missing request body' });

  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  const rawBody = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (!signature || !timestamp || !await verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY)) {
    return jsonResponse(401, { error: 'Invalid request signature' });
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return jsonResponse(400, { error: 'Invalid JSON' });
  }
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
    return jsonResponse(400, { error: 'Invalid interaction' });
  }
  if (interaction.type === InteractionType.PING) {
    return jsonResponse(200, { type: InteractionResponseType.PONG });
  }
  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return jsonResponse(400, { error: 'Unsupported interaction type' });
  }
  if (interaction.data?.name === 'test') {
    return jsonResponse(200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2 | InteractionResponseFlags.EPHEMERAL,
        components: [{ type: MessageComponentTypes.TEXT_DISPLAY, content: `hello world ${getRandomEmoji()}` }],
      },
    });
  }
  if (!COMMAND_LIST.includes(interaction.data?.name)) {
    return jsonResponse(400, { error: 'Unsupported command' });
  }
	const visible = interaction.data?.options?.find(option => option.name === 'visible')?.value || interaction.data.name === 'exhibit';

  try {
    if (!process.env.SQS_QUEUE_URL) throw new Error('SQS_QUEUE_URL is required.');
    const job = {
      application_id: interaction.application_id,
      token: interaction.token,
      guild_id: interaction.guild_id,
      member: { user: { id: interaction.member?.user?.id } },
      data: { name: interaction.data.name, options: interaction.data.options, resolved: interaction.data.resolved },
    };
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(job),
    }), { abortSignal: AbortSignal.timeout(1200) });
  } catch (error) {
    console.error('Could not queue lookup:', error.name);
    const data = { content: 'Could not queue the lookup. Please try again.' };
    if (!visible) data.flags = InteractionResponseFlags.EPHEMERAL;
    return jsonResponse(200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data,
    });
  }

  const data = {};
  if (!visible) data.flags = InteractionResponseFlags.EPHEMERAL;
  return jsonResponse(200, {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  });
}
