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
- **Match results.** Each pod has a match list. Add a match with two players, a round and the games won. Leave scores blank to add a pairing now and fill it in later. Standings use 3 points for a match win and 1 for a draw.
- **Ballots.** Every voter's full ranking is listed under Ballots.
- **Delete the draft.** At the bottom of the dashboard. Removes its ballots, pods and match results. Cubes in the library are kept. The owner page has a Delete button on each draft too.

Adding or removing a cube after pods were assigned clears the assignment, including pod edits, late players and match results. Re-running the assignment or reopening voting does the same. The dashboard warns before each of these.

### Team draft

Tick **Team draft** when creating a session, or switch the format on the dashboard. Each pod is split at random into two teams of equal size (one larger if the pod is odd). Each team drafts at its own table, and matches are only allowed between the two teams.

- **Generate pairings** builds rounds where every player meets a different opponent from the other team each round. With uneven teams the extra player sits out one round.
- The team button on a player moves them to the other team.
- The pod shows a team score: match wins, with a drawn match worth half to each side.

Switching the format after pods are assigned re-splits or removes the teams and clears that draft's matches.

### Cube library

Every cube has a "Save to my cube library" box, ticked by default. Saved cubes show up in an "Add a saved cube" picker on the create page and the cube editor. Saving the same cube again updates its saved details. Only the owner can remove cubes from the library.

### Owner page

Set `ADMIN_PASSWORD` and log in at `/owner`. It lists every draft ever made, newest first, with votes, pods and match result counts, and opens any draft's admin dashboard even if its admin link was lost. It also manages the cube library. The login lasts 30 days in that browser. Changing the password logs everyone out.

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

Tables are created or upgraded automatically on startup. Existing sessions from the first version are kept but have no admin or voting link.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `PORT` | Defaults to 3000 |
| `ADMIN_PASSWORD` | Turns on the owner page at `/owner`. Off when unset |
| `CUBECOBRA_BASE_URL` | Override for tests. Defaults to `https://cubecobra.com` |

## Layout

- `server.js` app wiring and page routes
- `src/db.js` pool and migrations
- `src/routes.js` API
- `src/cubecobra.js` Cube Cobra scraper
- `src/borda.js` assignment engine
- `src/pods.js` pod edits, teams, matches and standings
- `src/owner.js` owner login
- `public/` Tailwind pages and scripts
