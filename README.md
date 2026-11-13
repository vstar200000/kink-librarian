# Kink Librarian

A Discord app that looks up a server member's ratings from a JSON file they posted in a designated server channel.

## Requirements

- Node.js 18 or later.
- A [Discord application](https://discord.com/developers/applications) installed in the server with the `bot` and `applications.commands` scopes.
- A server forum channel for list uploads. The bot needs **View Channel** and **Read Message History** permission there.
- **Message Content Intent** enabled on the application's Bot page. Verified applications may also require Discord's approval for this privileged intent.
- A public HTTPS endpoint that forwards interaction requests to the app.

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.sample` to `.env` and set:
   - `APP_ID`: the Discord application ID.
   - `DISCORD_TOKEN`: the bot token. Keep it secret.
   - `PUBLIC_KEY`: the application's public key.
   - `LIST_CHANNEL_ID`: the ID of the forum channel where members upload their lists.
3. Configure the bot permissions and intent above. The configured forum must belong to the server where `/check` is used.
4. Run `npm run register` to register the commands. This replaces the application's global command list with the commands in `commands.js`.
5. Run `npm start`. The app listens on port 3000 by default; set `PORT` to change it.
6. Expose the app over HTTPS, for example with `ngrok http 3000`, and set the application's Interactions Endpoint URL to the public address followed by `/interactions`.

Do not commit `.env` or share your bot token.

## Uploading a list

Each member creates a post in the configured forum and attaches their `.json` file to the initial message or a reply in their own post. One upload message must contain only one JSON attachment. Both the post owner and the upload message author must be the member being checked; `listName` does not identify the owner. Uploads in someone else's post do not count.

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
      "items": [
        { "name": "Lego", "rating": "Love" }
      ]
    }
  ]
}
```

Each category needs a non-empty `category` and an `items` array; every item needs a non-empty `name` and `rating`. A rating can be a string or an object containing two non-empty labeled ratings, such as `{"actor": "Love", "subject": "Ask Me"}`. The response includes both labels and values for split ratings. `exportedAt` is optional. A legacy unnamed list is supported if the member has no named lists; if both exist, add `listName` to the unnamed uploads or remove them.

## Checking a rating

Use `/check` and select a server member for `user` and enter an item name for `item`, for example `/check @Anne Lego`. If the member has multiple characters, provide the `character` option; otherwise the app lists their available character names. Character and item names match exactly, ignoring case and surrounding whitespace. If the item occurs in multiple categories, the response shows each matching category and rating. An unnamed legacy list can only be checked without the `character` option.

Replies are ephemeral: only the requester sees them. Any server member who can use the command can query a list, even if they cannot view the upload channel. Ephemeral replies do not prevent the requester from sharing the information.

The response distinguishes a missing JSON attachment, a malformed JSON list, and an item missing from a valid list. It also reports other problems, such as missing configuration or permissions, multiple JSON attachments in one upload, an inaccessible file, or results too large to display. To identify every character, the app must read every JSON upload; an unreadable or syntactically malformed upload prevents selection because its character cannot be identified. Remove or replace such uploads. Lookups that cannot complete within 60 seconds fail rather than reporting a missing attachment.

The `/test` command sends a private hello-world response.

## Tests

Run the check interaction tests with:

```sh
node --test check.test.js
```

The tests mock Discord and do not register commands or access the network.

## Future improvements

- Consider notifying a list owner when someone checks their list and the JSON is malformed or the requested item is missing.
