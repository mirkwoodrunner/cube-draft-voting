# Cube Draft Voting

Ranked-choice voting and pod assignment for Magic: The Gathering cube drafts.

## How it works

1. **Admin** opens `/`, enters a title and one or more Cube Cobra URLs with min/max players per cube. Name, author and card count are fetched from Cube Cobra and can be corrected before saving.
2. The admin gets two links: `/admin/:adminToken` (private) and `/vote/:sessionId` (share with players).
3. **Players** drag cubes into order (a random starting order per player), enter a name and submit. Revisiting the link in the same browser loads their ballot so they can change it until voting closes.
4. The admin dashboard shows live vote counts. **Close Voting** locks ballots, then **Assign pods** runs the Borda engine and shows pods, rosters, unassigned players and group happiness.

### Admin tools

- **Vote from the dashboard.** Tick "I am playing in this draft" to rank the cubes without opening the player link. Untick it to remove your vote.
- **Remove a voter.** Each name on the dashboard has a ✕ that deletes that vote. Before pods are assigned this clears any results. After, it only takes that player out of their pod.
- **Edit cubes.** Add, remove or change cubes at any time. Removed cubes drop out of every ballot and new cubes are added at the bottom of every ballot.
- **Reopen voting.** Goes back to open after closing or assigning.

- **Edit pods.** After assigning, use "Move to" on any player to put them in another pod, a cube that did not fire, or out of the pods. Pods outside their min/max are flagged, not blocked.
- **Add a late player.** After assigning, "Add a player who joined after voting" puts a new name straight into a pod. They have no ballot, so they're tagged "joined late" and left out of the happiness score. In a team draft they join the smaller team.
- **Remove a player.** "Move to..." then "Remove from draft" takes someone out without touching anyone else's seat. Their ballot is deleted so a re-run won't seat them. Their unplayed pairings are dropped. Results they already played stay in the match list.
- **Rename a player.** The ✎ next to a voter's name, or "Move to..." then "Rename..." in the pods. Works before or after assigning. It updates their ballot, their seat and every match they're in. Names must stay unique, ignoring capitals.
- **Deck photos.** Each seated player has a "+ Photo" button to add a photo of their deck for them. The ✕ next to the photo removes it.
- **Share results.** "Share results" copies the standings as text, ready to paste into Discord. On a phone it opens the share menu instead. The text ends with the player link, which shows the full results.
- **Match results.** Each pod has a match list. Add a match with two players, a round and the games won. Leave scores blank to add a pairing now and fill it in later. Standings use 3 points for a match win and 1 for a draw.
- **Ballots.** Every voter's full ranking is listed under Ballots.
- **Delete the draft.** At the bottom of the dashboard. Removes its ballots, pods and match results. Cubes in the library are kept. The owner page has a Delete button on each draft too.

Adding or removing a cube after pods were assigned clears the assignment, including pod edits, late players and match results. Re-running the assignment or reopening voting does the same. The dashboard warns before each of these.

### Draft night (player page)

Once pods are assigned, the player link (`/vote/:id`) turns into the results page. It shows every pod's standings, matches and deck photos, and refreshes every 30 seconds. The ballot folds away at the bottom.

A player who logged in with Discord, or who opens the link in the browser they voted from, also gets:

- **Report a match.** Pick the round and opponent, then the games each side won. A pairing the host set up is picked first. Once a result is in, only the host can change it.
- **Your deck.** Name the deck, add a photo, write a note on each match they played and a note on the night overall. The browser shrinks photos to 1600 pixels on the long side before sending, so phone photos upload fast.
- **Share my deck.** Builds a post like the ones people already write in Discord. For example:

  ```
  Bant Broodscale went 1-2 in Pauper Cube

  1-2 vs Pat on Boros Energy
  0-2 vs Nate
  2-1 vs Will on Izzet
  ```

  The opponent's deck shows when they named theirs. Match notes go under each match, and the overall note goes at the end. A 3-0 reads "3-0 undefeated with ... 🏆". On a phone it opens the share menu with the text and photo, so the player can pick Discord. On a computer it copies the text.
- **Post to Discord.** Shown when `DISCORD_WEBHOOK_URL` is set. Posts the same text and photo straight to that channel, under the player's name and Discord avatar. Mentions are turned off, so a post can't ping anyone. A player can post once a minute. Reports over 2000 characters go out as several messages.

Players who joined late have no ballot, so they need Discord login or the host to add their photo and results.

Unsaved notes survive reporting a match or adding a photo. Share and Post save first.

The "Share results" button works the same as on the dashboard. Its text includes each player's deck name. The dashboard refreshes every 15 seconds on draft night so reported matches and photos show up, except while you're typing a score.

### Team draft

Tick **Team draft** when creating a session, or switch the format on the dashboard. Each pod is split at random into two teams of equal size (one larger if the pod is odd). Each team drafts at its own table, and matches are only allowed between the two teams.

- **Generate pairings** builds rounds where every player meets a different opponent from the other team each round. With uneven teams the extra player sits out one round.
- The team button on a player moves them to the other team.
- The pod shows a team score: match wins, with a drawn match worth half to each side.

Switching the format after pods are assigned re-splits or removes the teams and clears that draft's matches.

### Cube library

Every cube has a "Save to my cube library" box. It is ticked by default for new cubes and for cubes picked from the library. A cube already in a draft but not in the library starts unticked in the cube editor. Saving happens when the draft is created or its cubes are saved. Saved cubes show up in an "Add a saved cube" picker on the create page and the cube editor. Saving a cube that is already in the library updates its saved details only when the owner is logged in. For anyone else it keeps the saved details as they are.

The owner can also add a cube straight to the library from the owner page without making a draft, edit a saved cube's name, author, card count and player range, and remove saved cubes there. The Cube Cobra link can't be edited, since it identifies the cube. Add the new link as a new cube instead. Removing asks for confirmation first. Editing or removing a cube in the library does not change drafts that already use it. Only the owner can add, edit or remove cubes this way.

Anyone can see the library at `/library`, without the edit and remove buttons.

### Menu

Every page has a menu button at the top right. It links to New draft, Cube library, Players, the logged-in player's own page, and the owner page in smaller text at the bottom.

### Owner page

Log in at `/owner`. It lists every draft ever made, newest first, with votes, pods and match result counts, and opens any draft's admin dashboard even if its admin link was lost. It also manages the cube library.

There are two ways to log in. Turn on either or both.

- **Discord.** Set `OWNER_DISCORD_IDS` to your Discord user ID (several can be comma separated). Discord login must be on too. Anyone logged in with Discord under that ID is the owner everywhere on the site. To find your ID, turn on Developer Mode in Discord (Settings, Advanced), then right-click your name and pick Copy User ID. It's a long number, not your username.
- **Password.** Set `ADMIN_PASSWORD`. The login lasts 30 days in that browser. Changing the password logs everyone out. Worth keeping as a backup in case Discord login breaks. Unset it to turn password login off.

Log out on the owner page ends both kinds of login in that browser.

### Discord login and player records

Players can log in with Discord from the vote page. Logging in is optional. Anyone can still vote with just a name.

- A logged-in player's ballot is tied to their account, so they can change it from any device. If they voted before logging in, logging in on the same browser links that ballot.
- Their name is filled in from Discord. They can change it for that draft.
- `/players` lists everyone who has logged in with their lifetime record. `/players/:id` shows one player's drafts, cubes, match and game record, and team draft results. These pages are public.
- Records only count drafts with pods assigned where the player voted or was added while linked. Drafts from before Discord login, and anyone who didn't log in, stay as plain names.
- Renaming or removing a player keeps the link, so matches they already played still count.
- On the dashboard, linked players show their Discord avatar. "Add a player who joined after voting" can link the new player to someone who has logged in before.
- A player can delete their profile from their own page. Their name stays in past drafts as a plain name, and can be claimed again.

#### Claiming drafts played without logging in

`/players` also lists names that played without logging in, under "Not claimed yet". Names are grouped across drafts ignoring capitals and extra spaces, so "Chris" and "chris" share one page at `/players/name/:name`.

- A logged-in player can open that page and claim it. Each draft has a tick box so they can leave out drafts that were someone else with the same name.
- Claiming links those seats, matches and ballots to their account. They then count toward that player's record, alongside everything already tied to it, and the name drops off the unclaimed list.
- A draft where the player is already linked under another name is skipped.
- Only drafts with pods assigned can be claimed.
- Anyone logged in can claim any unclaimed name. There is no approval step.
- The owner can undo a wrong claim or link. Logged in as the owner, a player's page shows Unlink on each draft. Unlinking takes that draft off their record and clears the link on their seat, matches and ballot there. The name goes back to the unclaimed list. Their Discord login no longer finds that ballot if voting reopens.

Setup in the [Discord developer portal](https://discord.com/developers/applications). Create an application. Under OAuth2, add the redirect `https://cube-draft-voting.onrender.com/auth/discord/callback`. Copy the client ID and secret into the variables below. Only the `identify` scope is used.

#### If login fails with "Discord's firewall is blocking this server"

Discord sometimes blocks Render's shared IP addresses. The fix is to send the two login calls through a free Cloudflare Worker.

1. In Cloudflare, go to Workers & Pages, create a Worker, and replace its code with `discord-proxy/worker.js`. Deploy it. If you set it up before deck reports existed, paste in the new code again. The old version only allows the login calls, so webhook posts get "Not found".
2. In the Worker's Settings, under Variables and Secrets, add a secret named `PROXY_KEY` set to a long random string.
3. In Render, set `DISCORD_API_BASE` to the Worker's URL (like `https://discord-proxy.yourname.workers.dev`) and `DISCORD_PROXY_KEY` to the same random string.

Deck report posts use the same Worker when these are set.

#### Posting deck reports to a channel

In Discord, open the channel's settings, then Integrations, then Webhooks, and create a webhook. Copy its URL into `DISCORD_WEBHOOK_URL`. Anyone who can see the webhook URL can post to that channel, so keep it secret like a password. Without it, players can still use Share my deck.

### Draft night API

A draft's `:id` is its public id, the one in its `/vote/` link. Match results are stored in the `draft_matches` table. Deck photos are stored in the `draft_decks` table.

A player is found by their Discord login, or else by their ballot's edit token in an `X-Voter-Token` header. They must be seated in a pod.

- `POST /api/drafts/:id/matches` logs a match from the reporter's side. Body: `{ round, opponent, wins, losses, draws }`. A pairing the host already set up is filled in. A match that already has a result returns 409.
- `PATCH /api/drafts/:id/matches/:matchId` corrects a score. Body: any of `{ player1Wins, player2Wins, draws }`. Sets `editedByOwner`.
- `DELETE /api/drafts/:id/matches/:matchId` removes a match.
- `GET /api/drafts/:id/standings` ranks each pod by match points (3 for a win, 1 for a draw), then game win percentage. Players level on both share a rank. `trophies` lists every 3-0 record with no draws. Each pod also lists its `matches`, and each player has a `deckName` and a `photoUrl`, or null. `me` is the caller's seat, `{ name, cubeId, deck }`, or null. `discordPost` says whether Post to Discord is turned on.
- `PUT /api/drafts/:id/decks/mine/photo` sets the caller's deck photo. The body is the image itself (JPEG, PNG or WebP, up to 8 MB). The type is checked from the file's bytes. `DELETE` on the same path removes it.
- `PUT /api/drafts/:id/decks/mine` saves the caller's deck. Body: `{ deckName, notes, matchNotes: { matchId: text } }`. Up to 80, 1500 and 600 characters. Notes on matches that aren't the caller's are dropped.
- `GET /api/drafts/:id/decks/mine/report` returns `{ text, photoUrl }`, the deck report as it would be posted.
- `POST /api/drafts/:id/decks/mine/post` posts the report to `DISCORD_WEBHOOK_URL`. 403 when that isn't set, 429 within a minute of the last post.
- `GET /api/drafts/:id/decks/:deckId/photo` serves a photo. Its URL changes when the photo does, so it is cached.
- `PUT /api/admin/:adminToken/decks/photo?name=...` and `DELETE` on the same path let the host set or remove anyone's photo.

Renaming a player moves their photo with them. Removing them from the draft deletes it.

PATCH and DELETE need the site owner login or the draft's admin token in an `X-Admin-Token` header. On the admin dashboard, correcting a match that already had a result also sets `editedByOwner`. Filling in an empty pairing does not.

Game win percentage is game points (3 per game won, 1 per drawn game) over 3 per game played. It has no 33% floor.

## Assignment engine (`src/borda.js`)

A cube ranked r-th of K is worth K - r + 1 points. The engine chooses which cubes fire and who plays in each, in this priority:

1. Every pod that fires has between its min and max players.
2. As many players as possible are seated.
3. Total Borda points is as high as possible.

A cube that can't reach its minimum is dissolved and its voters move to their next-best pod. Players are unassigned only when every pod that can fire is full or too few players remain to start another. Per-player satisfaction is `(K - rank) / (K - 1)`. Group happiness is the mean over seated players.

## Running

```
npm install
DATABASE_URL=postgres://... npm start
npm test
```

`npm test` skips the database tests unless `TEST_DATABASE_URL` points at a throwaway Postgres database. They start the real server and write to that database.

Tables are created or upgraded automatically on startup. Existing sessions from the first version are kept but have no admin or voting link.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `PORT` | Defaults to 3000 |
| `OWNER_DISCORD_IDS` | Discord user IDs that are the owner, comma separated. Needs Discord login on |
| `ADMIN_PASSWORD` | Optional owner password login at `/owner`. Off when unset |
| `DISCORD_CLIENT_ID` | Turns on Discord login, with the secret. Off when unset |
| `DISCORD_CLIENT_SECRET` | From the Discord developer portal |
| `DISCORD_API_BASE` | Optional. URL of the Discord proxy Worker. Defaults to `https://discord.com` |
| `DISCORD_PROXY_KEY` | Optional. Shared key sent to the proxy Worker |
| `DISCORD_WEBHOOK_URL` | Optional. Channel webhook that deck reports are posted to. Doesn't need Discord login on |
| `DISCORD_REDIRECT_URI` | Optional. Defaults to `/auth/discord/callback` on the host the request came in on |
| `CUBECOBRA_BASE_URL` | Override for tests. Defaults to `https://cubecobra.com` |
| `TRUST_PROXY` | Number of proxies in front of the app, used to find each visitor's IP for rate limits. Defaults to 1 |
| `PG_POOL_MAX` | Most database connections at once. Defaults to 10 |

## Layout

- `server.js` app wiring and page routes
- `src/db.js` pool and migrations
- `src/routes.js` API
- `src/cubecobra.js` Cube Cobra scraper
- `src/borda.js` assignment engine
- `src/discord.js` Discord login
- `discord-proxy/worker.js` optional Cloudflare Worker for Discord's login calls
- `src/records.js` player records across drafts, and unclaimed names
- `src/pods.js` pod edits, teams, matches and standings
- `src/matches.js` reads and writes the `draft_matches` table
- `src/decks.js` decks in the `draft_decks` table, and the deck report text
- `src/webhook.js` posts deck reports to Discord
- `src/owner.js` owner login
- `public/` Tailwind pages and scripts
