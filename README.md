# Palaestra

<div align="center">
  <img src="static/palaestra-logo-w.png" alt="Palaestra logo" width="72" height="72">
</div>

Palaestra is a two-sided dated contest match book deployed on GenLayer StudioNet.

Two counterparties take opposing positions on an unambiguous calendar-dated proposition. Settlement is adjudicated on-chain via GenLayer validator consensus examining two independent allowlisted public web pages.

---

## Contract Deployment

- **Network**: GenLayer StudioNet
- **Chain ID**: `61999` (`0xf22f`)
- **RPC Endpoint**: `https://studio.genlayer.com/api`
- **Block Explorer**: `https://explorer-studio.genlayer.com`
- **Contract Address**: `0x05Ea4308905A80354515B991a35f1BE09186eB1C`

---

## Live Floor

Explorer: https://explorer-studio.genlayer.com/address/0x05Ea4308905A80354515B991a35f1BE09186eB1C

### Match 1, returned to both sides
- post `0x72f0cc1c83af5e5a1e1a1e81c8bf38f1b672e5ed0ba509b79d99afcb8ea491a2`
- match `0x233bbfb4afacb30df6a31ea3cd682debba67715c8565114472c269855f78803c`
- return both stakes `0x7e08a9ff449185b480e15e88e093a1f4b38760dab5fae6f327823ad3abd5bf04`
- id 1, expected `REFUNDED` / `TIMEOUT` / `REFUNDED_TO_BOTH`

### Match 2, cancelled before a joiner
- post `0x0220ecc31ae125afeb8df87e83dfe952b745048dfe8e7f3674c4321bcc9a7539`
- cancel `0xe2b053ef3986cad55ed375c64af00064285a14e40141ac263bf7945915359d35`
- id 2, expected `CANCELLED` / `REFUNDED_TO_CREATOR`

---

## Core Architecture & Methods

Palaestra operates through five state-modifying actions and four view methods.

### 1. `create_wager(question, event_date, resolve_after, side, source_url_a, source_url_b)` (payable)
- **Parameters**:
  - `question`: The dated question statement (minimum 12 characters).
  - `event_date`: The calendar date of the event (`YYYY-MM-DD`).
  - `resolve_after`: The date on or after which adjudication opens (`YYYY-MM-DD`, must be on or after `event_date`).
  - `side`: Creator position (`YES` or `NO`).
  - `source_url_a`: Primary `https://` web source from the allowlist.
  - `source_url_b`: Secondary `https://` web source from a different allowlisted host.
- **Payable Value**: Initial stake in wei ($> 0$).
- **State Transition**: Initializes contest in `OPEN` status, sets `refund_after` to `resolve_after + 1 UTC day`, and increments reserved stakes.
- **Returns**: The assigned contest ID string.

### 2. `join(wager_id)` (payable)
- **Parameters**:
  - `wager_id`: Contest ID of an existing `OPEN` contest.
- **Payable Value**: Exact matching stake in wei equal to creator stake.
- **State Transition**: Moves contest from `OPEN` to `MATCHED`, registers the joiner address, and adds matching stake to reserved stakes.

### 3. `cancel(wager_id)`
- **Parameters**:
  - `wager_id`: Contest ID of an `OPEN` contest.
- **Access**: Creator only.
- **State Transition**: Cancels an unmatched contest (`OPEN` $\to$ `CANCELLED`), deducts stake from reserved stakes, and refunds the staked GEN directly to the creator wallet.

### 4. `resolve(wager_id)`
- **Parameters**:
  - `wager_id`: Contest ID of a `MATCHED` contest.
- **Availability**: Callable on or after `resolve_after`.
- **Consensus**: GenLayer validators inspect both public URLs:
  - If both sources independently confirm `YES` or `NO`, the contest status transitions to `SETTLED` and the entire pot is disbursed to the winning address.
  - If the sources return `UNKNOWN` or `DISAGREE`, the contest remains `MATCHED`.
- **Returns**: Updated status string (`SETTLED` or `MATCHED`).

### 5. `timeout_refund(wager_id)`
- **Parameters**:
  - `wager_id`: Contest ID of a `MATCHED` contest.
- **Availability**: Callable on or after `refund_after` (one UTC day after `resolve_after`), provided the contest remains `MATCHED`.
- **State Transition**: Changes status to `REFUNDED`, sets funds disposition to `REFUNDED_TO_BOTH`, and returns both individual stakes to creator and joiner wallets.

### View Methods
- `get_wager(wager_id)`: Returns full JSON record of creator, joiner, question, event date, resolve date, refund date, creator side, both source URLs, stake (in wei), status, verdict, and funds disposition.
- `can_resolve(wager_id)`: Returns JSON object with timestamps and boolean flags (`allowed` and `timeout_refund_allowed`).
- `get_wager_count()`: Returns total count of contests created.
- `get_reserved_stakes()`: Returns total GEN stake amount currently reserved across active contests.

---

## Allowed Source Domains

To maintain integrity and independence, both sources must use `https://` and belong to two distinct permitted domains:

`bbc.com`, `espn.com`, `reuters.com`, `apnews.com`, `theguardian.com`, `nytimes.com`, `skysports.com`, `goal.com`, `flashscore.com`, `sofascore.com`, `cbssports.com`, `nfl.com`, `nba.com`, `mlb.com`, `nhl.com`, `fifa.com`, `uefa.com`, `premierleague.com`, `wikipedia.org` (including subdomains such as `www.` and `en.`).

---

## How to Use Palaestra

1. **Enter the Floor**:
   - On the match book overview, review active contract rules and click **Enter the floor**.

2. **Connect Wallet**:
   - In the floor top bar, connect your Web3 provider (OKX Wallet, MetaMask, or any EIP-6963 compatible wallet).
   - Ensure the network is set to GenLayer StudioNet (Chain ID `61999`).

3. **Open a Contest**:
   - Navigate to **Open**.
   - Input your question statement, event date, resolve date, select `YES` or `NO`, provide two allowlisted URLs from different hosts, and specify your stake in GEN.
   - Submit and sign the transaction.

4. **Match a Contest**:
   - Navigate to **Match**.
   - Enter the Contest ID to inspect the required stake and counter-position.
   - Post the equal stake to match and lock the contest.

5. **Resolve & Settle**:
   - On or after the `resolve_after` date, navigate to **Resolve** and trigger **Settle**.
   - If unanimous consensus is reached, the winner receives the pot.
   - If inconclusive, both parties may use **Return both stakes** after `refund_after` opens.

6. **Lookup & Inspect**:
   - Navigate to **Lookup** to query any on-chain contest record and view real-time settlement status.
