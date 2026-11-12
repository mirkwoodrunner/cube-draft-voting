# Cube Draft Voting

Ranked-choice voting and pod assignment for Magic: The Gathering cube drafts.

## How it works

1. **Admin** opens `/`, enters a title and one or more Cube Cobra URLs with min/max players per cube. Name, author and card count are fetched from Cube Cobra and can be corrected before saving.
2. The admin gets two links: `/admin/:adminToken` (private) and `/vote/:sessionId` (share with players).
3. **Players** drag cubes into order (a random starting order per player), enter a name and submit. Revisiting the link in the same browser loads their ballot so they can change it until voting closes.
4. The admin dashboard shows live vote counts. **Close Voting** locks ballots, then **Assign pods** runs the Borda engine and shows pods, rosters, unassigned players and group happiness.

### Admin tools

- **Vote from the dashboard.** Tick "I am playing in this draft" to rank the cubes without opening the player link. Untick it to remove your vote.
- **Remove a voter.** Each name on the dashboard has a ✕ that deletes that vote.
- **Edit cubes.** Add, remove or change cubes at any time. Removed cubes drop out of every ballot and new cubes are added at the bottom of every ballot.
- **Reopen voting.** Goes back to open after closing or assigning.

Changing the cubes or removing a vote after pods were assigned clears the assignment.

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
| `CUBECOBRA_BASE_URL` | Override for tests. Defaults to `https://cubecobra.com` |

## Layout

- `server.js` app wiring and page routes
- `src/db.js` pool and migrations
- `src/routes.js` API
- `src/cubecobra.js` Cube Cobra scraper
- `src/borda.js` assignment engine
- `public/` Tailwind pages and scripts
