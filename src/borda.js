'use strict';

/**
 * Borda-count pod assignment.
 *
 * Each player ranks every cube. A cube ranked r-th (1-based) out of K cubes is
 * worth K - r + 1 Borda points to that player.
 *
 * The engine picks which cubes "fire" and who plays in each, in this priority:
 *   1. Every pod that fires has between minPlayers and maxPlayers players.
 *   2. As many players as possible get a seat.
 *   3. Total Borda points across seated players is as high as possible.
 *
 * For a fixed set of firing cubes this is a min-cost flow problem with lower
 * bounds, which is solved exactly. The engine tries every set of cubes that
 * could possibly be filled, so a cube that can't reach its minimum is dissolved
 * and its would-be players are re-routed to their next-best pod instead of
 * being stranded. Players are left unassigned only when no valid pod has room.
 */

// ---------- min-cost flow (successive shortest paths, SPFA) ----------

class MinCostFlow {
  constructor(n) {
    this.n = n;
    this.adj = Array.from({ length: n }, () => []);
    this.to = [];
    this.cap = [];
    this.cost = [];
  }

  addEdge(u, v, cap, cost) {
    const id = this.to.length;
    this.to.push(v, u);
    this.cap.push(cap, 0);
    this.cost.push(cost, -cost);
    this.adj[u].push(id);
    this.adj[v].push(id + 1);
    return id;
  }

  /** Pushes flow from s to t while each extra unit lowers total cost. */
  run(s, t) {
    const n = this.n;
    for (;;) {
      const dist = new Array(n).fill(Infinity);
      const inQueue = new Array(n).fill(false);
      const prevEdge = new Array(n).fill(-1);
      dist[s] = 0;
      const queue = [s];
      inQueue[s] = true;
      for (let head = 0; head < queue.length; head++) {
        const u = queue[head];
        inQueue[u] = false;
        for (const e of this.adj[u]) {
          if (this.cap[e] <= 0) continue;
          const v = this.to[e];
          const nd = dist[u] + this.cost[e];
          if (nd < dist[v]) {
            dist[v] = nd;
            prevEdge[v] = e;
            if (!inQueue[v]) {
              inQueue[v] = true;
              queue.push(v);
            }
          }
        }
      }
      if (dist[t] === Infinity || dist[t] >= 0) return;
      for (let v = t; v !== s; v = this.to[prevEdge[v] ^ 1]) {
        this.cap[prevEdge[v]] -= 1;
        this.cap[prevEdge[v] ^ 1] += 1;
      }
    }
  }
}

/**
 * Best assignment when exactly the cubes in `subset` (indices) fire.
 * Returns null if some cube in the subset can't reach its minimum.
 */
function solveSubset(subset, cubes, points, numPlayers, bigSeat, bigMin) {
  const K = subset.length;
  const SOURCE = 0;
  const playerNode = (p) => 1 + p;
  const cubeNode = (j) => 1 + numPlayers + j;
  const SINK = 1 + numPlayers + K;
  const g = new MinCostFlow(SINK + 1);

  const playerEdges = []; // [player][j] -> edge id
  for (let p = 0; p < numPlayers; p++) {
    g.addEdge(SOURCE, playerNode(p), 1, 0);
    playerEdges.push(
      subset.map((c, j) => g.addEdge(playerNode(p), cubeNode(j), 1, -(bigSeat + points[p][c])))
    );
  }
  const minEdges = [];
  subset.forEach((c, j) => {
    const { minPlayers, maxPlayers } = cubes[c];
    // The first `minPlayers` seats carry a huge bonus so they fill before anything else.
    minEdges.push(g.addEdge(cubeNode(j), SINK, minPlayers, -bigMin));
    if (maxPlayers > minPlayers) g.addEdge(cubeNode(j), SINK, maxPlayers - minPlayers, 0);
  });

  g.run(SOURCE, SINK);

  for (let j = 0; j < K; j++) {
    if (g.cap[minEdges[j]] !== 0) return null; // minimum not reached
  }

  const seatOf = new Array(numPlayers).fill(-1);
  let seated = 0;
  let total = 0;
  for (let p = 0; p < numPlayers; p++) {
    for (let j = 0; j < K; j++) {
      if (g.cap[playerEdges[p][j]] === 0) {
        seatOf[p] = subset[j];
        seated += 1;
        total += points[p][subset[j]];
      }
    }
  }
  return { seated, total, seatOf };
}

// ---------- public API ----------

/**
 * @param {Array<{id:string|number,name:string,minPlayers:number,maxPlayers:number,author?:string,url?:string}>} cubes
 * @param {Array<{name:string,preferences:Array<string|number>}>} players
 */
function assignPods(cubes, players) {
  const K = cubes.length;
  const sortedPlayers = [...players].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const N = sortedPlayers.length;
  const cubeIndex = new Map(cubes.map((c, i) => [String(c.id), i]));

  // rank[p][c] = 1-based rank player p gave cube c (K if unranked)
  const rank = sortedPlayers.map((pl) => {
    const row = new Array(K).fill(K);
    pl.preferences.forEach((id, i) => {
      const c = cubeIndex.get(String(id));
      if (c !== undefined && i + 1 < row[c]) row[c] = i + 1;
    });
    return row;
  });
  const points = sortedPlayers.map((pl, p) => {
    const ranked = new Set(pl.preferences.map(String));
    return cubes.map((c, ci) => (ranked.has(String(c.id)) ? K - rank[p][ci] + 1 : 0));
  });

  const bigSeat = N * K + 1;
  const bigMin = N * (bigSeat + K) + 1;

  let best = null;
  let bestSubset = [];
  if (K > 0 && N > 0) {
    const limit = 1 << K;
    for (let mask = 1; mask < limit; mask++) {
      const subset = [];
      let sumMin = 0;
      for (let c = 0; c < K; c++) {
        if (mask & (1 << c)) {
          subset.push(c);
          sumMin += cubes[c].minPlayers;
        }
      }
      if (sumMin > N) continue; // can't possibly fire all of these
      const res = solveSubset(subset, cubes, points, N, bigSeat, bigMin);
      if (!res) continue;
      if (!best || res.seated > best.seated || (res.seated === best.seated && res.total > best.total)) {
        best = res;
        bestSubset = subset;
      }
    }
  }

  const satisfactionOf = (r) => (K > 1 ? (K - r) / (K - 1) : 1);
  const podPlayers = new Map(bestSubset.map((c) => [c, []]));
  const unassigned = [];
  const rankCounts = {};

  sortedPlayers.forEach((pl, p) => {
    const c = best ? best.seatOf[p] : -1;
    if (c >= 0) {
      const r = rank[p][c];
      podPlayers.get(c).push({ name: pl.name, rank: r, satisfaction: satisfactionOf(r) });
      rankCounts[r] = (rankCounts[r] || 0) + 1;
    } else {
      unassigned.push({
        name: pl.name,
        reason: bestSubset.length === 0
          ? 'Not enough players to fill any pod to its minimum size'
          : 'The pods that can fire are full, and too few players remain to start another'
      });
    }
  });

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pods = bestSubset.map((c) => {
    const members = podPlayers.get(c).sort(
      (a, b) => a.rank - b.rank || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    return {
      cubeId: String(cubes[c].id),
      name: cubes[c].name,
      author: cubes[c].author || null,
      url: cubes[c].url || null,
      minPlayers: cubes[c].minPlayers,
      maxPlayers: cubes[c].maxPlayers,
      players: members,
      satisfaction: mean(members.map((m) => m.satisfaction))
    };
  });

  const fired = new Set(bestSubset);
  const notFired = cubes
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !fired.has(i))
    .map(({ c, i }) => ({
      cubeId: String(c.id),
      name: c.name,
      author: c.author || null,
      url: c.url || null,
      minPlayers: c.minPlayers,
      maxPlayers: c.maxPlayers,
      firstChoiceVotes: rank.filter((row) => row[i] === 1).length,
      reason: N < c.minPlayers
        ? `Only ${N} player${N === 1 ? '' : 's'} voted, below this cube's minimum of ${c.minPlayers}`
        : `Dissolved. It could not reach its minimum of ${c.minPlayers} without seating fewer players or lowering overall satisfaction`
    }));

  const seatedSatisfactions = pods.flatMap((p) => p.players.map((m) => m.satisfaction));
  return {
    pods,
    notFired,
    unassigned,
    stats: {
      players: N,
      seated: seatedSatisfactions.length,
      unassigned: unassigned.length,
      groupSatisfaction: mean(seatedSatisfactions),
      rankCounts
    }
  };
}

module.exports = { assignPods };
