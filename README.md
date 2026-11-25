# pump-fun-sharpe-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mazireal/pump-fun-sharpe-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mazireal/pump-fun-sharpe-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532): it trades new pump.fun bonding curves on a 6-hour forward replay, starting with 10 SOL of paper money, and places by hourly Sharpe ratio — steady controlled gains beat one lucky moonshot.

## Strategy

An adaptation of "Rally Rider", the single-trade Donchian breakout bot that scored +30.74 USDC on the BTC race dev window: one clean breakout rule, ridden with a hard stop, a trailing stop and a time limit. Here the one trade is spread across many coins, because the score is Sharpe, not max PnL.

- **Entry — fresh launches only.** A curve at most 30 slots old whose creator has not sold, with at least two distinct non-creator buyers already in, real SOL between 0.5 and 30 building, the creator's own buy at most 2.5 SOL, and the price no more than 20% above its create price (no buying the top). One entry per mint, ever. Flat 0.10 SOL stakes, at most 5 open positions.
- **Exits — read on every batch while holding.** Take profit +20%, hard stop −8% under cost, trailing stop −10% from the peak once up 8%, a 600-slot time limit, an instant exit when the creator sells, and an exit on strong outflow (net < −1 SOL over 20 slots). Every exit sells the whole position.
- **Safety.** Worst case every open position stops out at once: ~0.05 SOL, half a percent of equity. A guardrail probe (0.01 SOL round trip of a liquid curve) fires only if the bot's own coins lag the pace of 25 coins over the window.

## Backtest (kit dev window, 24h, `grade-local --driver process`)

| Bot | Net PnL | Sharpe (hourly) | Max drawdown | Round trips | Coins |
| --- | --- | --- | --- | --- | --- |
| **This bot** | **−0.20 SOL** | −0.80 | **2.1%** | 267 | 219 |
| Launch entries, no run-up filter | −0.57 SOL | −0.29 | 7.8% | 315 | 281 |
| Launch + mature breakout legs | −0.81 SOL | −0.51 | 8.4% | 264 | 241 |
| Mature breakout leg alone | −0.94 SOL | −0.68 | 9.7% | 252 | 188 |
| Kit pilot: momentum | −9.44 SOL | −0.58 | 95.4% | 75 | 45 |
| Kit pilot: reversion | −3.99 SOL | −0.48 | 49.0% | 425 | 199 |
| Kit pilot: sniper | −0.50 SOL | −0.84 | 5.4% | 354 | 354 |

Every active strategy lost money on the dev window; this one lost the least, with the smallest drawdown. The mature-breakout leg was tried and dropped because it lost money on its own. The final window is a fresh 6 hours, so the dev numbers are a robustness check, not a forecast.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (the grader runs `node /bot/main.ts`): `hello` once, then one `batch` per slot, one `reply` per batch echoing its `seq`. It is deterministic — pure arithmetic over the batches seen, no clock, no randomness, no network, no files.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bot.ts` — byte-for-byte copy of the kit's SDK shim.
- `.makefun/owner.json` — claim file for the entry wallet.

---

Entered on [make.fun](https://make.fun/?ref=jkyvprfe&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards
