# Kink Librarian

A Discord app that looks up a server member's ratings from JSON files posted in a designated forum. It can run locally with Express or on AWS Lambda using a Function URL and an SQS worker.

## Requirements

- Node.js 20 or later for local use and command registration. The Lambda image uses Node.js 22.
- A [Discord application](https://discord.com/developers/applications) installed in the server with the `bot` and `applications.commands` scopes.
- A server forum channel for list uploads. The bot needs **View Channel** and **Read Message History** permission there.
- **Message Content Intent** enabled on the application's Bot page. Verified applications may also require Discord's approval for this privileged intent.
- A public HTTPS endpoint for Discord interactions.

## Discord setup

1. Install dependencies with `npm install`.
2. Copy `.env.sample` to `.env` and set `APP_ID` to the application ID and `DISCORD_TOKEN` to the bot token. Keep the token secret.
3. Configure the bot permissions and intent above. The configured forum must belong to the server where the list commands are used.
4. Run `npm run register` to register the commands. This replaces the application's global command list with the commands in `commands.js`.
5. Deploy either the Lambda setup or the local server below, then set the application's **Interactions Endpoint URL** as described for that deployment.

Do not commit `.env` or share your bot token. Command registration is a separate operation; starting or deploying the app does not register commands.

## AWS Lambda deployment

The Function URL handler verifies Discord's signature and immediately answers `/test` and PING requests. It places `/check`, `/exhibit`, and `/compare` requests on SQS and returns a deferred response (private except for `/exhibit`). A separate worker reads the forum and edits that response. Both functions use the same container image.

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
   | Worker | `worker.handler` (override the image command in Lambda configuration) | `DISCORD_TOKEN`: bot token; `LIST_CHANNEL_ID`: forum channel ID |

   Restrict access to function configuration and logs; Lambda encrypts environment variables at rest, but the bot token remains a secret. Do not copy `.env` into the image. The HTTP execution role needs `sqs:SendMessage` on the queue. The worker execution role needs `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the queue. Both roles need CloudWatch Logs permissions. If using a customer-managed KMS key for SQS, also grant the necessary KMS permissions and key-policy access.

4. Add the SQS queue as an event source for the worker. Use **batch size 1** and enable **ReportBatchItemFailures** (partial batch responses), so failed messages can be retried without retrying successful ones. Set the worker timeout to at least 75 seconds: a lookup can take 60 seconds and the response edit has a separate 10-second limit. Set the queue visibility timeout to at least six times the worker timeout, for example 450 seconds for a 75-second worker timeout. Configure the dead-letter queue's maximum receive count with the token lifetime in mind.

5. Create a Lambda Function URL for the HTTP function with auth type **NONE** and the necessary public-invocation resource policy. Discord does not use AWS IAM credentials; the handler authenticates each request using `PUBLIC_KEY`. Set the HTTP function timeout to a few seconds and allocate enough memory and concurrency to respond within Discord's three-second deadline, including cold starts and queueing. Ensure both functions can reach their required AWS and Discord endpoints if you attach them to a VPC.

6. In the Discord Developer Portal, set **Interactions Endpoint URL** to the Function URL itself, without adding `/interactions`. Discord validates the endpoint with a signed PING. Test `/test`, `/check`, `/exhibit`, and `/compare` in the server and inspect CloudWatch logs and queue/dead-letter metrics if there are errors.

SQS is at-least-once, so a job may run more than once. The worker retries a short-lived 404 if it races the deferred acknowledgement; unsuccessful response edits are reported for SQS retry. Queue delays, repeated failures, cold starts, or expired interaction tokens can still prevent a response. Protect and monitor the public Function URL and AWS resources against unwanted traffic and cost.

## Local Express deployment

Set `PUBLIC_KEY`, `DISCORD_TOKEN`, and `LIST_CHANNEL_ID` in `.env`, in addition to the registration variables above. Run `npm start`; the app listens on port 3000 by default, or the value of `PORT`. Expose the server over HTTPS, for example with `ngrok http 3000`, and use the public address followed by `/interactions` as Discord's Interactions Endpoint URL. Local Express handles the deferred lookup in the same process and does not use SQS.

## Uploading a list

Each member creates a post in the configured forum and attaches their `.json` file to the initial message or a reply in their own post. One upload message must contain only one JSON attachment. Both the post owner and the upload message author must be the member whose list is being queried; `listName` does not identify the owner. Uploads in someone else's post do not count.

The app identifies each character by the JSON file's `listName`, ignoring case and surrounding whitespace. Upload each character's file in your own forum post; to update a character, upload another file with the same `listName`. The newest upload for that character is authoritative across your active and archived posts, even if its list content is malformed. Renaming a character creates a separate list unless the old uploads are removed. Files larger than 2 MiB are not accepted.

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

Use `/check` and select a server member for `user` and enter an item name for `item`, for example `/check @Anne Lego`. If the member has multiple characters, provide the `character` option; otherwise the app lists their available character names. Character and item names match exactly, ignoring case and surrounding whitespace. If the item occurs in multiple categories, the response shows each matching category and rating. An unnamed legacy list can only be checked without the `character` option.

Replies are ephemeral: only the requester sees them. Any server member who can use the command can query a list, even if they cannot view the upload channel. Ephemeral replies do not prevent the requester from sharing the information.

The response distinguishes a missing JSON attachment, a malformed JSON list, and an item missing from a valid list. It also reports other problems, such as missing configuration or permissions, multiple JSON attachments in one upload, an inaccessible file, or results too large to display. To identify every character, the app must read every JSON upload; an unreadable or syntactically malformed upload prevents selection because its character cannot be identified. Remove or replace such uploads. Lookups that cannot complete within 60 seconds fail rather than reporting a missing attachment.

## Exhibiting your rating

Use `/exhibit` with an item name to show your own rating publicly in the channel. The command has no user option and can only query the invoking member's list. Provide `character` when you have multiple characters; if omitted, the command lists the available character names. Results, character-selection prompts, and lookup errors are public, so use `/check` instead if you want a private lookup.

## Comparing ratings

Use `/compare` with `other_user` and `item` to compare your list with another member's list. Provide `your_character` and/or `other_character` when the corresponding member has multiple characters. You can also select yourself as `other_user` to compare two of your own characters. The private response shows each rating and a verdict. `Crave` and `Love` are positive, `Willing` and `Ask Me` are neutral, and `Never` and `Hard Limit` are limits. A rating is not consent; discuss preferences and boundaries.

Split ratings are compared in both directions: your `self` against their `partner` and vice versa. The same applies to `actor`/`subject` and `center`/`circle`. Each direction gets its own verdict, so a limit in one direction does not prevent a match in the other. Mixed single and split ratings, unknown ratings, or different or unrecognized role labels cannot be compared. If an item occurs more than once, matching categories are compared; unmatched categories and multiple occurrences in one category are reported. If an item is missing from one list, the other list's matches are still shown. The same list selection, upload, permissions, and timeout rules as `/check` apply.

The `/test` command sends a private hello-world response.

## Tests

Run the lookup and Lambda interaction tests with:

```sh
node --test check.test.js exhibit.test.js compare.test.js lambda.test.js
```

The tests mock Discord and SQS and do not register commands or access the network.

## Future improvements

- Consider notifying a list owner when someone checks their list and the JSON is malformed or the requested item is missing.
- Include a "help" command for the bot to explain itself.
