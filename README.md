# Kink Librarian

A Discord app that looks up a server member's ratings from JSON files posted in a designated forum, caches successful item lookups in DynamoDB, and stores registered PNG message links by character. It can run locally with Express or on AWS Lambda using a Function URL and an SQS worker.

## Requirements

- Node.js 20 or later for local use and command registration. The Lambda image uses Node.js 22.
- A [Discord application](https://discord.com/developers/applications) installed in the server with the `bot` and `applications.commands` scopes.
- A server forum channel for list uploads. The bot needs **View Channel** and **Read Message History** permission there.
- **Message Content Intent** enabled on the application's Bot page. Verified applications may also require Discord's approval for this privileged intent.
- A public HTTPS endpoint for Discord interactions.
- A DynamoDB table and AWS credentials with access to it, as described below.

## Discord setup

1. Install dependencies with `npm install`.
2. Copy `.env.sample` to `.env` and set `APP_ID` to the application ID and `DISCORD_TOKEN` to the bot token. Keep the token secret.
3. Configure the bot permissions and intent above. The configured forum must belong to the server where the list commands are used.
4. Run `npm run register` to register the commands. This replaces the application's global command list with the commands in `commands.js`.
5. Deploy either the Lambda setup or the local server below, then set the application's **Interactions Endpoint URL** as described for that deployment.

Do not commit `.env` or share your bot token. Command registration is a separate operation; starting or deploying the app does not register commands.

## AWS Lambda deployment

The Function URL handler verifies Discord's signature and immediately answers `/test` and PING requests. It places `/check`, `/exhibit`, `/compare`, `/register`, and `/link` requests on SQS and returns a deferred response (private except for `/exhibit` and `/link` when made visible). A separate worker reads the forum, verifies registrations, retrieves links, and edits that response. Both functions use the same container image.

1. Build the image and push it to a private Amazon ECR repository in the same AWS Region as the Lambda functions. For x86-64:

   ```sh
   docker build --platform linux/amd64 --provenance=false -f dockerfile -t kink-librarian .
   ```

   Authenticate Docker to ECR, tag the image with the repository URI, and push it. Choose the Lambda architecture matching the image. When you change the image, push it again and update **both** functions to the new image digest; pushing a tag alone does not update deployed functions. When first enabling `/compare` or `/exhibit`, update the worker before the HTTP function so the worker can dispatch the new jobs.

2. Create a **standard** SQS queue in that Region. Enable server-side encryption, restrict access to the two function roles, and configure a dead-letter queue and alarms for failed messages. Jobs include interaction tokens and command data: never expose queue messages or log their bodies. Set a short retention period appropriate for Discord's approximately 15-minute interaction-token lifetime, for example 15 minutes; tokens in a dead-letter queue will eventually expire and cannot be replayed indefinitely.

3. Create two Lambda functions using the ECR image:

   | Function | Image command | Environment variables |
   | --- | --- | --- |
   | HTTP | `index.handler` (image default) | `PUBLIC_KEY`: Discord application public key; `SQS_QUEUE_URL`: standard queue URL |
   | Worker | `worker.handler` (override the image command in Lambda configuration) | `DISCORD_TOKEN`: bot token; `LIST_CHANNEL_ID`: forum channel ID; `DYNAMODB_TABLE_NAME`: cache table name; `AWS_REGION`: table Region (automatically set by Lambda) |

   Restrict access to function configuration and logs; Lambda encrypts environment variables at rest, but the bot token remains a secret. Do not copy `.env` into the image. The HTTP execution role needs `sqs:SendMessage` on the queue. The worker execution role needs `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the queue, plus the DynamoDB permissions below. Both roles need CloudWatch Logs permissions. If using a customer-managed KMS key for SQS, also grant the necessary KMS permissions and key-policy access.

4. Add the SQS queue as an event source for the worker. Use **batch size 1** and enable **ReportBatchItemFailures** (partial batch responses), so failed messages can be retried without retrying successful ones. Set the worker timeout to at least 75 seconds: a lookup can take 60 seconds and the response edit has a separate 10-second limit. Set the queue visibility timeout to at least six times the worker timeout, for example 450 seconds for a 75-second worker timeout. Configure the dead-letter queue's maximum receive count with the token lifetime in mind.

5. Create a Lambda Function URL for the HTTP function with auth type **NONE** and the necessary public-invocation resource policy. Discord does not use AWS IAM credentials; the handler authenticates each request using `PUBLIC_KEY`. Set the HTTP function timeout to a few seconds and allocate enough memory and concurrency to respond within Discord's three-second deadline, including cold starts and queueing. Ensure both functions can reach their required AWS and Discord endpoints if you attach them to a VPC.

6. In the Discord Developer Portal, set **Interactions Endpoint URL** to the Function URL itself, without adding `/interactions`. Discord validates the endpoint with a signed PING. Test `/test`, `/check`, `/exhibit`, and `/compare` in the server and inspect CloudWatch logs and queue/dead-letter metrics if there are errors.

SQS is at-least-once, so a job may run more than once. The worker retries a short-lived 404 if it races the deferred acknowledgement; unsuccessful response edits are reported for SQS retry. Queue delays, repeated failures, cold starts, or expired interaction tokens can still prevent a response. Protect and monitor the public Function URL and AWS resources against unwanted traffic and cost.

## Local Express deployment

Set `PUBLIC_KEY`, `DISCORD_TOKEN`, `LIST_CHANNEL_ID`, `DYNAMODB_TABLE_NAME`, and `AWS_REGION` in `.env`, in addition to the registration variables above. Configure AWS credentials using the AWS SDK's standard credential chain, such as a local AWS profile; do not put credentials in the repository. Run `npm start`; the app listens on port 3000 by default, or the value of `PORT`. Expose the server over HTTPS, for example with `ngrok http 3000`, and use the public address followed by `/interactions` as Discord's Interactions Endpoint URL. Local Express handles deferred commands in the same process and does not use SQS.

## DynamoDB cache

Create a DynamoDB table in the chosen Region with a string partition key named `pk` and a string sort key named `sk`. On-demand capacity is suitable for an experiment; monitor usage and costs. Set `DYNAMODB_TABLE_NAME` and `AWS_REGION` for the process performing lookups. This configuration is required even if a particular lookup is not cached; missing configuration produces an error. The HTTP Lambda function does not need table access.

Grant the worker role or local AWS principal `dynamodb:GetItem`, `dynamodb:Query`, and `dynamodb:PutItem` on this table. The app writes a character marker and item record together using `TransactWriteItems`; its two transaction actions are puts. If a customer-managed KMS key is used, configure the necessary KMS permissions and key policy. Use encryption at rest, restrict access to the table and backups, and choose backup and retention settings deliberately: cached ratings and character names may be sensitive.

`/check`, `/exhibit`, and `/compare` share the cache. Keys isolate each server, forum, user, character, and item; names are matched case-insensitively after trimming. A successful Discord lookup stores all matching categories and ratings. Missing items and lookup errors are not cached. If DynamoDB operations fail, the bot logs a sanitized error and uses Discord, or returns the Discord result if only the write failed. A record too large for DynamoDB is not cached.

## Registering PNG links

Use `/register` with a Discord message link and a character name to save a link to your own PNG attachment. The message must be in the current server and in a channel the bot can read; the bot verifies the channel, message author, and PNG attachment metadata through Discord's API. The bot parses the message link and never fetches an arbitrary URL. Registering the same character again replaces the previous link.

Use `/link` with a server member and character name to retrieve that member's registered link. Character names are matched case-insensitively after trimming. The response is private by default and supports the existing visibility option. The link lookup reads only DynamoDB; it does not recheck the message, so a deleted message may leave a stale link. Link records are stored in the same table with separate keys and the existing `GetItem`/`PutItem` permissions.

Cached values **do not expire**. An updated or deleted upload does not change a cached result, and a cache hit does not recheck the bot's forum permissions or whether the upload still exists. Anyone who can use the commands can still retrieve cached ratings under the existing command visibility rules. Clear the cache when a member updates or removes a list, changes characters, or when access should be revoked. DynamoDB backups, exports, and point-in-time recovery can retain old data after records are deleted; manage those separately.

When `character` is omitted, the bot uses the sole character currently known in the cache. If multiple characters are cached, it asks for a character; if none are cached, it searches Discord using the existing selection rules. The cache may contain only one of several characters actually present in Discord, so an omitted character can select that one without discovering the others. A requested character or item absent from the cache triggers a Discord search; a successful match adds that character and item. A sole unnamed legacy list remains supported.

To clear one member's cache, first stop local lookup processes and disable the Lambda worker's SQS event source mapping, then wait for in-flight lookups to finish. In the DynamoDB console, query the table's `pk` for `<guild ID>#<forum channel ID>#<user ID>` and delete **all** results across all pages: both `C#` character markers and `I#` item records. Delete both kinds together so character selection and cached items remain consistent. Resume the worker and local processes afterward. Clearing all members requires deleting all such records, including every page; do not delete the table itself unless you recreate it before restarting the bot. Manual deletion requires separate administrator permissions such as `dynamodb:DeleteItem`.

## Uploading a list

Each member creates a post in the configured forum and attaches their `.json` file to the initial message or a reply in their own post. One upload message must contain only one JSON attachment. Both the post owner and the upload message author must be the member whose list is being queried; `listName` does not identify the owner. Uploads in someone else's post do not count.

The app identifies each character by the JSON file's `listName`, ignoring case and surrounding whitespace. Upload each character's file in your own forum post; to update a character, upload another file with the same `listName` and clear the member's cache. When a lookup searches Discord, the newest upload for that character is authoritative across your active and archived posts, even if its list content is malformed. Renaming a character creates a separate list unless the old uploads are removed. Files larger than 2 MiB are not accepted.

Example version 3 file:

```json
{
  "formatVersion": 3,
  "listName": "Anne",
  "exportedAt": "2026-11-12T22:22:33.460Z",
  "categories": [
    {
      "category": "Types of Play",
      "items": [{ "name": "Lego", "rating": "Love" }]
    }
  ]
}
```

Each category needs a non-empty `category` and an `items` array; every item needs a non-empty `name` and `rating`. A rating can be a string or an object containing two non-empty labeled ratings, such as `{"actor": "Love", "subject": "Ask Me"}`. The response includes both labels and values for split ratings. `exportedAt` is optional. A legacy unnamed list is supported if the member has no named lists; if both exist, add `listName` to the unnamed uploads or remove them.

## Checking a rating

Use `/check` and select a server member for `user` and enter an item name for `item`, for example `/check @Anne Lego`. If the member has multiple cached characters, provide the `character` option; otherwise the app lists their cached character names. With an empty cache, Discord list selection applies. Character and item names match exactly, ignoring case and surrounding whitespace. If the item occurs in multiple categories, the response shows each matching rating. An unnamed legacy list can only be checked without the `character` option.

Replies are ephemeral: only the requester sees them. Any server member who can use the command can query a list, even if they cannot view the upload channel. Ephemeral replies do not prevent the requester from sharing the information.

On a cache miss, the response distinguishes a missing JSON attachment, a malformed JSON list, and an item missing from a valid list. It also reports other problems, such as missing configuration or permissions, multiple JSON attachments in one upload, an inaccessible file, or results too large to display. To identify every character on a Discord search, the app must read every JSON upload; an unreadable or syntactically malformed upload prevents selection because its character cannot be identified. Remove or replace such uploads. Lookups that cannot complete within 60 seconds fail rather than reporting a missing attachment.

## Exhibiting your rating

Use `/exhibit` with an item name to show your own rating publicly in the channel. The command has no user option and can only query the invoking member's list. Character selection follows the cache rules above. Results, character-selection prompts, and lookup errors are public, so use `/check` instead if you want a private lookup.

## Comparing ratings

Use `/compare` with `other_user` and `item` to compare your list with another member's list. Provide `your_character` and/or `other_character` when the corresponding member has multiple characters. You can also select yourself as `other_user` to compare two of your own characters. The private response shows each rating and a verdict. `Crave` and `Love` are positive, `Willing` and `Ask Me` are neutral, and `Never` and `Hard Limit` are limits. A rating is not consent; discuss preferences and boundaries.

Split ratings are compared in both directions: your `self` against their `partner` and vice versa. The same applies to `actor`/`subject` and `center`/`circle`. Each direction gets its own verdict, so a limit in one direction does not prevent a match in the other. Mixed single and split ratings, unknown ratings, or different or unrecognized role labels cannot be compared. If an item occurs more than once, matching categories are compared; unmatched categories and multiple occurrences in one category are reported. If an item is missing from one list, the other list's matches are still shown. The same list selection, upload, permissions, and timeout rules as `/check` apply.

The `/test` command sends a private hello-world response.

## Tests

Run the lookup and Lambda interaction tests with:

```sh
node --test check.test.js exhibit.test.js compare.test.js lambda.test.js item-cache.test.js
```

The tests mock Discord, SQS, and DynamoDB and do not register commands or access the network.

## Future improvements

- Consider notifying a list owner when someone checks their list and the JSON is malformed or the requested item is missing.
- Include a "help" command for the bot to explain itself.
