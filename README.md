# Swap Shop: a barter vs money classroom game

Students get random emoji items and trade them to build matching sets.
- **Round 1 (Barter):** item-for-item trades only.
- **Round 2 (Money):** everyone also gets $20 and can buy and sell items with cash. Each $1 left over counts as 1 point.

At the end the host screen compares trades and average score gain between the two rounds.

Scoring: pair = 5 · 3 of a kind = 15 · 4 = 30 · 5 = 50 · 6 = 75 …

**Items:** apple, fish, corn, honey, egg, wool, wood, chicken, diamond, gold, cow, milk.
Before each round the host can switch items on/off and set how many of each exist (or leave it on Auto = 8 per student).

**Demo:** click "Try a demo with bots" on the home page. Five bots join, and "Open student view" lets you trade with them yourself.
You can also add bots to a real game from the lobby.

## Run locally
    npm install
    npm start        # http://localhost:3000

Open it, click **Host a new game**, and project the code. Students go to the same URL and enter the code.
They can also use `https://YOUR-URL/?code=ABCD`.

## Deploy (free) on Render
1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > pick the repo.
3. Build command `npm install`, start command `npm start`, instance type Free.
4. Share the `https://….onrender.com` URL with the class.

Free instances go to sleep when idle, so open the site about a minute before class to wake it.
Games are kept in memory. Restarting the server wipes them.

## Tweak
Other settings are at the top of `server.js`: `CATALOG`, `PER_PLAYER`, `START_CASH`, `setPoints`. Round length is 5 min (set the `ROUND_SECONDS` env var to change it).
